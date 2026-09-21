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
  avatarCacheDir?: string;
  avatarSaver?: TwitterFeedSourceOpts['avatarSaver'];
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
    avatarCacheDir: opts.avatarCacheDir,
    avatarSaver: opts.avatarSaver,
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
  async (): Promise<NitterFetchResult> => ({ host, tweets, avatarCdn: null, bytes: 100, ms: 5 });

test('首轮静默归档不发信号；第二轮新帖逐条 emit feed_post；重复轮询零信号（去重）', async (t) => {
  let round = [tweet({ id: '100' }), tweet({ id: '101', isRetweet: true, retweetedBy: SCREEN, author: 'd4dj_pj' })];
  // 注意闭包里读的是「当前」的 round（不是创建 harness 时那一份快照）
  const h = harness({
    rssFetcher: async () => ({ host: 'nitter.a.example', tweets: round, avatarCdn: null, bytes: 100, ms: 5 }),
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

test('头像：抠到 URL 且账号无头像 → avatarSaver 落盘后回写文件名；已回写过不重复下载', async (t) => {
  const saves: string[] = [];
  const avatarCdn: string | null = 'https://pbs.twimg.com/profile_images/1/a.jpg';
  const h = harness({
    rssFetcher: async (): Promise<NitterFetchResult> => ({
      host: 'nitter.a.example', tweets: [tweet({ id: '600' })], avatarCdn, bytes: 1, ms: 1,
    }),
    avatarCacheDir: '/tmp/ddclaw-test-xavatars',
    avatarSaver: async (url, dir, proxy) => {
      saves.push(`${url}|${dir}|${proxy}`);
      return 'a'.repeat(32) + '.jpg';
    },
  });
  t.after(h.cleanup);

  await h.src.pollOnce();
  assert.equal(saves.length, 1, '无头像 + 抠到 URL → 落盘一次');
  assert.ok(saves[0]!.startsWith('https://pbs.twimg.com/profile_images/1/a.jpg|'), '传的是 CDN URL');
  assert.equal(h.account().avatar, 'a'.repeat(32) + '.jpg', '文件名回写 x_accounts.avatar');

  await h.src.pollOnce();
  assert.equal(saves.length, 1, '已有头像不再下载');
});

test('头像：抠不到 URL / saver 失败 → 不写库，下轮再试', async (t) => {
  let saverCalls = 0;
  let avatarCdn: string | null = null;
  const h = harness({
    rssFetcher: async (): Promise<NitterFetchResult> => ({
      host: 'nitter.a.example', tweets: [tweet({ id: '601' })], avatarCdn, bytes: 1, ms: 1,
    }),
    avatarCacheDir: '/tmp/ddclaw-test-xavatars',
    avatarSaver: async () => { saverCalls++; return null; },
  });
  t.after(h.cleanup);

  await h.src.pollOnce();
  assert.equal(saverCalls, 0, '没抠到 URL 不调 saver');
  assert.equal(h.account().avatar, null);

  avatarCdn = 'https://pbs.twimg.com/profile_images/1/b.jpg';
  await h.src.pollOnce();
  assert.equal(saverCalls, 1, '抠到了但下载失败');
  assert.equal(h.account().avatar, null, '失败不写库（下轮重试）');
});

test('头像：不注入 avatarCacheDir 则只抠 URL 不落盘', async (t) => {
  let saverCalls = 0;
  const h = harness({
    rssFetcher: async (): Promise<NitterFetchResult> => ({
      host: 'nitter.a.example', tweets: [tweet({ id: '603' })],
      avatarCdn: 'https://pbs.twimg.com/profile_images/1/c.jpg', bytes: 1, ms: 1,
    }),
    avatarSaver: async () => { saverCalls++; return 'x.jpg'; },
  });
  t.after(h.cleanup);
  await h.src.pollOnce();
  assert.equal(saverCalls, 0);
  assert.equal(h.account().avatar, null);
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
// ---- 轮次语义（core/backlog.ts）：缺口轮补推 / 恢复轮静默 ----

test('缺口轮：开关关=只归档（默认）；开关开=窗内按条数上限补推；正常轮不受上限', async (t) => {
  const nowSec = Math.floor(Date.now() / 1000);

  // 开关关（默认）：现状行为不变
  const roundA = [tweet({ id: '300', pubTs: nowSec - 60 })];
  const a = harness({ rssFetcher: async () => ({ host: 'nitter.a.example', tweets: roundA, avatarCdn: null, bytes: 100, ms: 5 }) });
  t.after(a.cleanup);
  await a.src.pollOnce();
  assert.equal(a.posts().length, 1, '归档照常');
  assert.equal(a.feeds().length, 0, '默认不补推');

  // 开关开：窗外 / 窗内 / 未知时间混合，上限 2 条
  const roundB = [
    tweet({ id: '400', pubTs: nowSec - 3600 * 30 }), // 窗外（30h 前，窗 24h）
    tweet({ id: '401', pubTs: nowSec - 400 }),
    tweet({ id: '402', pubTs: nowSec - 300 }),
    tweet({ id: '403', pubTs: nowSec - 200 }),
    tweet({ id: '404', pubTs: 0 }),                  // 时间未知 → 只归档
  ];
  const b = harness({ rssFetcher: async () => ({ host: 'nitter.a.example', tweets: roundB, avatarCdn: null, bytes: 100, ms: 5 }) });
  t.after(b.cleanup);
  b.db.setSetting('backlog_push_enabled', '1');
  b.db.setSetting('backlog_max_age_hours', '24');
  b.db.setSetting('backlog_max_per_account', '2');
  await b.src.pollOnce();
  assert.equal(b.posts().length, 5, '归档永远完整（补推不影响归档）');
  assert.deepEqual(
    b.feeds().map((f) => (f.payload as { itemId: string }).itemId),
    ['402', '403'],
    '窗内最新 2 条、时间正序；窗外与未知时间的只归档',
  );

  // 正常轮不受上限：3 条新帖全推
  roundB.unshift(tweet({ id: '405', pubTs: nowSec }), tweet({ id: '406', pubTs: nowSec }), tweet({ id: '407', pubTs: nowSec }));
  await b.src.pollOnce();
  assert.deepEqual(
    b.feeds().slice(2).map((f) => (f.payload as { itemId: string }).itemId),
    ['405', '406', '407'],
    '正常轮新帖全推（上限只管缺口轮）',
  );
});

test('恢复轮（停用→重新启用）：开了补推开关也静默，消费后清位；下一轮回正常轮', async (t) => {
  const nowSec = Math.floor(Date.now() / 1000);
  let round = [tweet({ id: '500', pubTs: nowSec - 60 })];
  const h = harness({ rssFetcher: async () => ({ host: 'nitter.a.example', tweets: round, avatarCdn: null, bytes: 100, ms: 5 }) });
  t.after(h.cleanup);

  await h.src.pollOnce();
  assert.equal(h.feeds().length, 0, '缺口轮默认静默');

  h.db.setSetting('backlog_push_enabled', '1');
  const id = h.account().id;
  h.db.upsertXAccount({ id, enabled: false });
  h.db.upsertXAccount({ id, enabled: true });
  assert.equal(h.account().silentNext, true, '重新启用置位');

  round = [tweet({ id: '501', pubTs: nowSec - 50 }), ...round]; // 停用期间的新帖
  await h.src.pollOnce();
  assert.equal(h.feeds().length, 0, '恢复轮静默：主动关闭期间的帖子不补推（开关开了也不推）');
  assert.equal(h.posts().length, 2, '归档照常完整');
  assert.equal(h.account().silentNext, false, '恢复轮消费后清位');

  round = [tweet({ id: '502', pubTs: nowSec - 5 }), ...round];
  await h.src.pollOnce();
  assert.equal(h.feeds().length, 1);
  assert.equal((h.feeds()[0]!.payload as { itemId: string }).itemId, '502', '清位后回正常轮');
});
