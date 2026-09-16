/**
 * X 时间线源行为单测（注入 fetcher，不走网络）。
 * 守的是几条纪律：首轮静默、只在插入成功时发信号、拉取失败绝不写库（保留旧数据）、
 * Nitter 挂了走回退、回退关着就不走、失败的持续记账与恢复复位。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TwitterFeedSource, type TwitterFeedSourceOpts } from './feed.js';
import type { NitterFetchResult, ParsedTweet } from './nitter.js';
import { Bus } from '../../core/bus.js';
import { Db } from '../../core/db.js';
import type { Signal } from '../../core/types.js';
import type { XFeedSnapshot } from '../../core/x-config.js';
import type { AppConfig } from '../../config/schema.js';

const SCREEN = 'watase_yuzuki';

function cfg(): AppConfig {
  return {
    pollIntervalSec: 45, pollJitterSec: 0,
    notifyOnFirstRun: false, notifyOnNewSubscription: true,
    healthAlertAfterFailures: 2,
    follows: { enabled: true, syncIntervalSec: 1800 },
    dynamic: { enabled: true, intervalSec: 300 },
    weibo: { enabled: true, intervalSec: 300 },
    subscriptions: [],
    notify: { onebot: { enabled: false, targets: [] }, toast: { enabled: true } },
  } as unknown as AppConfig;
}

function tweet(o: Partial<ParsedTweet> & { id: string }): ParsedTweet {
  return {
    author: SCREEN,
    isRetweet: false,
    retweetedBy: null,
    text: `tweet ${o.id}`,
    pics: [],
    pubTs: 1_700_000_000,
    url: `https://x.com/${SCREEN}/status/${o.id}`,
    ...o,
  };
}

interface HarnessOpts {
  rssFetcher?: TwitterFeedSourceOpts['rssFetcher'];
  webFetcher?: TwitterFeedSourceOpts['webFetcher'];
  fallbackHtml?: boolean;
  accounts?: Array<{ screenName: string; enabled?: boolean }>;
  instances?: string[];
}

function harness(opts: HarnessOpts = {}) {
  const db = new Db(':memory:');
  for (const a of opts.accounts ?? [{ screenName: SCREEN }]) {
    db.upsertXAccount({ screenName: a.screenName, displayName: null, biliUid: null, enabled: a.enabled ?? true });
  }
  const bus = new Bus();
  const signals: Signal[] = [];
  bus.on('*', (s) => { signals.push(s); });
  const statuses: XFeedSnapshot[] = [];
  const src = new TwitterFeedSource({
    proxyUrl: 'http://127.0.0.1:7890',
    instances: opts.instances ?? ['nitter.a.example'],
    fallbackHtml: opts.fallbackHtml ?? true,
    intervalSec: 300,
    rssFetcher: opts.rssFetcher,
    webFetcher: opts.webFetcher,
    onStatus: (s) => { statuses.push(s); },
  });
  src.bind({ bus, db, config: cfg() });
  return {
    src, db, signals, statuses,
    feeds: () => signals.filter((s) => s.kind === 'feed_post'),
    alerts: () => signals.filter((s) => s.kind === 'health_alert'),
    posts: () => db.listRecentPosts([SCREEN], 50).get(SCREEN) ?? [],
    account: () => db.getXAccountByScreenName(SCREEN)!,
    cleanup: () => db.close(),
  };
}

const okRss = (tweets: ParsedTweet[], host = 'nitter.a.example') =>
  async (): Promise<NitterFetchResult> => ({ host, tweets, bytes: 100, ms: 5 });

test('首轮静默归档不发信号；第二轮新帖逐条 emit feed_post；重复轮询零信号（去重）', async (t) => {
  let round = [tweet({ id: '100' }), tweet({ id: '101', isRetweet: true, retweetedBy: SCREEN, author: 'd4dj_pj' })];
  // 注意闭包里读的是「当前」的 round（不是创建 harness 时那一份快照）
  const h = harness({
    rssFetcher: async () => ({ host: 'nitter.a.example', tweets: round, bytes: 100, ms: 5 }),
  });
  t.after(h.cleanup);

  await h.src.pollOnce();
  assert.equal(h.posts().length, 2, '首轮入库');
  assert.equal(h.feeds().length, 0, '首轮不发信号');

  round = [tweet({ id: '102' }), ...round];
  await h.src.pollOnce();
  const feeds = h.feeds();
  assert.equal(feeds.length, 1, '只有新的那条发信号');
  assert.equal(feeds[0]!.source, 'twitter/feed');
  assert.equal(feeds[0]!.uid, SCREEN, 'uid = 被轮询的账号（面板按它分组）');
  const pl = feeds[0]!.payload as { platform: string; itemId: string; type: string; url: string };
  assert.equal(pl.platform, 'twitter');
  assert.equal(pl.itemId, '102');
  assert.equal(pl.type, 'tweet');

  await h.src.pollOnce();
  assert.equal(h.feeds().length, 1, '同一批再轮询不会重复发（UNIQUE 去重）');
});

test('归档落在 posts(platform=twitter)，转发存 type=retweet，raw 带路线与轮询账号', async (t) => {
  const h = harness({ rssFetcher: okRss([tweet({ id: '200', isRetweet: true, retweetedBy: SCREEN, author: 'd4dj_pj' })]) });
  t.after(h.cleanup);
  await h.src.pollOnce();
  const p = h.posts()[0]!;
  assert.equal(p.platform, 'twitter');
  assert.equal(p.uid, SCREEN);
  assert.equal(p.itemId, '200');
  assert.equal(p.type, 'retweet');
  assert.ok(p.raw!.includes('"via":"nitter"'), 'raw 记录生效路线，便于事后追溯');
  assert.ok(p.raw!.includes('d4dj_pj'), 'raw 保留原作者');
});

test('游标只往前推：lastTweetId / lastTweetAt / lastOkAt 回写', async (t) => {
  const h = harness({ rssFetcher: okRss([tweet({ id: '300', pubTs: 1_700_000_500 }), tweet({ id: '299', pubTs: 1_700_000_100 })]) });
  t.after(h.cleanup);
  assert.equal(h.account().lastTweetId, null, '初始无游标');
  await h.src.pollOnce();
  assert.equal(h.account().lastTweetId, '300', '取数值最大的 id，不看 pubTs 顺序');
  assert.equal(h.account().lastTweetAt, 1_700_000_500);
  assert.ok(h.account().lastOkAt !== null, '成功抓取记 lastOkAt（面板据此区分“抓过”与“从没成功”）');
});

test('Nitter 全挂 → 回退免登录路线；via 记为 web 且 host 为空', async (t) => {
  let webCalls = 0;
  const h = harness({
    rssFetcher: async () => { throw new Error('全部 1 个实例都失败：nitter.a.example HTTP 429'); },
    webFetcher: async (screen, sinceId) => {
      webCalls++;
      assert.equal(screen, SCREEN);
      assert.equal(sinceId, null, '首轮无游标 → 交给回退层决定取多少条');
      return { tweets: [tweet({ id: '400' })], bytes: 10, ms: 3 };
    },
  });
  t.after(h.cleanup);
  await h.src.pollOnce();
  assert.equal(webCalls, 1, '回退被调用');
  assert.equal(h.posts()[0]!.itemId, '400');
  assert.ok(h.posts()[0]!.raw!.includes('"via":"web"'));
  const last = h.statuses[h.statuses.length - 1]!;
  assert.equal(last.via, 'web');
  assert.equal(last.host, null);
  assert.equal(last.okAccounts, 1);
});

test('回退关着就不走 web；两条都失败 → 不写库、记 lastError、达阈值发健康告警', async (t) => {
  let webCalls = 0;
  let healthy = false;
  const h = harness({
    fallbackHtml: false,
    rssFetcher: async () => {
      if (!healthy) throw new Error('实例全挂');
      return { host: 'nitter.a.example', tweets: [tweet({ id: '501' })], bytes: 1, ms: 1 };
    },
    webFetcher: async () => { webCalls++; return { tweets: [tweet({ id: '500' })], bytes: 1, ms: 1 }; },
  });
  t.after(h.cleanup);

  await h.src.pollOnce();
  assert.equal(webCalls, 0, '回退关闭时不得调用 web 路线');
  assert.equal(h.posts().length, 0, '拉取失败绝不写库');
  assert.equal(h.alerts().length, 0, '第一次失败不到阈值（2）不告警');
  let last = h.statuses[h.statuses.length - 1]!;
  assert.equal(last.okAccounts, 0);
  assert.match(last.lastError ?? '', /实例全挂/);

  await h.src.pollOnce();
  assert.equal(h.alerts().length, 1, '连续 2 次失败 → 一次健康告警');
  const alert = h.alerts()[0]!.payload as { alertKind: string; message: string; failures: number };
  assert.equal(alert.alertKind, 'streak');
  assert.equal(alert.failures, 2);
  assert.match(alert.message, /测试全部/, '告警要指向面板的自查入口');

  // 恢复：正常归档并复位告警状态
  healthy = true;
  await h.src.pollOnce();
  assert.equal(h.posts()[0]!.itemId, '501', '恢复后正常归档');
  last = h.statuses[h.statuses.length - 1]!;
  assert.equal(last.okAccounts, 1);
  assert.equal(last.lastError, null, '恢复后清掉错误');
});

test('只轮询 enabled=1 的账号；名单为空时不发信号也不报错', async (t) => {
  let calls = 0;
  const h = harness({
    accounts: [{ screenName: 'on_account' }, { screenName: 'off_account', enabled: false }],
    rssFetcher: async (_hosts, screen) => {
      calls++;
      return { host: 'nitter.a.example', tweets: [tweet({ id: '600', author: screen })], bytes: 1, ms: 1 };
    },
  });
  t.after(h.cleanup);
  await h.src.pollOnce();
  assert.equal(calls, 1, '停用的账号不轮询');
  assert.equal(h.statuses[h.statuses.length - 1]!.accounts, 1);
});

test('名单为空：只记录「本轮 0 个账号」，不打网络', async (t) => {
  let calls = 0;
  const h = harness({ accounts: [], rssFetcher: async () => { calls++; throw new Error('不该被调用'); } });
  t.after(h.cleanup);
  await h.src.pollOnce();
  assert.equal(calls, 0);
  const last = h.statuses[h.statuses.length - 1]!;
  assert.equal(last.accounts, 0);
  assert.ok(last.lastRunAt !== null, '仍然记一轮运行时间');
});

test('bind/stop 通过 onStatus 上报 running，面板据此显示源在跑', (t) => {
  const h = harness({});
  t.after(h.cleanup);
  assert.equal(h.statuses[0]!.running, true, 'bind 后立即上报 running=true');
  h.src.stop();
  assert.equal(h.statuses[h.statuses.length - 1]!.running, false, 'stop 后 running=false');
});