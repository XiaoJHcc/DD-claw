import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WeiboFeedSource, fetchLongText, fetchMymblog, parseMblog,
  type LongTextFetcher, type MblogFetcher, type WeiboSelfFetcher,
} from './feed.js';
import type { WeiboSelfInfo } from './auth.js';
import { Bus } from '../../core/bus.js';
import { Db } from '../../core/db.js';
import type { Signal } from '../../core/types.js';
import type { AppConfig } from '../../config/schema.js';

const W_UID = '2203177060';

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
  } as AppConfig;
}

// ---- 解析 fixture（字段路径按 2026-08-03 实测响应）----

const CREATED = 'Mon Aug 03 21:15:00 +0800 2026';
const CREATED_TS = Math.floor(Date.parse(CREATED) / 1000);

const MBLOG = {
  idstr: '5001', mblogid: 'Pa1bC', isLongText: false,
  text_raw: '今晚九点直播！', created_at: CREATED,
  pics: [{ large: { url: 'https://wx1.sinaimg.cn/large/a.jpg' } }],
};

const LONG = {
  idstr: '5002', mblogid: 'Pb2cD', isLongText: true,
  text_raw: '这是一条很长的微博的截断部分...', created_at: CREATED, pics: [],
};

const RETWEET = {
  idstr: '5003', mblogid: 'Pc3eF', isLongText: false,
  text_raw: '好耶', created_at: CREATED, pics: [],
  retweeted_status: {
    idstr: '4999', user: { screen_name: '原作者' },
    text_raw: '原微博正文', created_at: 'Sun Aug 02 10:00:00 +0800 2026',
    pics: [{ large: { url: 'https://wx1.sinaimg.cn/large/o.jpg' } }],
  },
};

test('parseMblog 原创带图：字段全对，posts.uid 用监听名单 uid', () => {
  const p = parseMblog(MBLOG, '7706705', W_UID)!;
  assert.equal(p.platform, 'weibo');
  assert.equal(p.uid, '7706705', '归档归属用（B站）uid，面板 enrich 按它分组');
  assert.equal(p.itemId, '5001');
  assert.equal(p.type, 'mblog');
  assert.equal(p.text, '今晚九点直播！');
  assert.deepEqual(p.pics, ['https://wx1.sinaimg.cn/large/a.jpg']);
  assert.equal(p.pubTs, CREATED_TS, 'created_at 是 "Mon Aug 03 ... +0800 2026" 格式');
  assert.ok(p.pubTs > 1_700_000_000, '解析出的是真实时间戳');
  assert.equal(p.url, 'https://weibo.com/2203177060/Pa1bC', 'url 用微博 uid + mblogid');
  assert.ok(p.raw!.includes('5001'), 'raw 整 item 归档');
});

test('parseMblog 转发：拼「//转发自 @原作者」，图取原微博', () => {
  const p = parseMblog(RETWEET, '1', W_UID)!;
  assert.equal(p.type, 'retweet');
  assert.equal(p.text, '好耶\n//转发自 @原作者: 原微博正文');
  assert.deepEqual(p.pics, ['https://wx1.sinaimg.cn/large/o.jpg']);
  assert.equal(p.itemId, '5003', '去重 id 用转发自己的 idstr');
});

test('parseMblog 长文：longText 优先，缺省用截断文本兜底', () => {
  const full = parseMblog(LONG, '1', W_UID, '这是完整全文')!;
  assert.equal(full.text, '这是完整全文');
  const fallback = parseMblog(LONG, '1', W_UID, null)!;
  assert.equal(fallback.text, '这是一条很长的微博的截断部分...');
});

test('parseMblog 防御：缺 idstr 返回 null；坏 created_at pubTs=0；被删原微博残桩不炸', () => {
  assert.equal(parseMblog({ mblogid: 'x' }, '1', W_UID), null);
  assert.equal(parseMblog(null, '1', W_UID), null);
  const bad = parseMblog({ idstr: '9', created_at: 'garbage' }, '1', W_UID)!;
  assert.equal(bad.pubTs, 0);
  const stub = parseMblog({
    idstr: '10', text_raw: '转了', retweeted_status: { deleted: '1' },
  }, '1', W_UID)!;
  assert.equal(stub.type, 'retweet');
  assert.equal(stub.text, '转了');
  assert.deepEqual(stub.pics, []);
});

// ---- fetchMymblog / fetchLongText 请求形状与失败纪律 ----

test('fetchMymblog：URL 带 uid/page/feature，头带 UA/cookie/Referer', async () => {
  let seenUrl = '';
  let seenH = new Headers();
  const items = await fetchMymblog('COOKIE_HDR', W_UID, async (url, init) => {
    seenUrl = url;
    seenH = new Headers(init?.headers);
    return new Response(JSON.stringify({ ok: 1, data: { list: [MBLOG] } }), { status: 200 });
  });
  assert.equal(items.length, 1);
  assert.ok(seenUrl.startsWith('https://weibo.com/ajax/statuses/mymblog?'));
  assert.ok(seenUrl.includes('uid=2203177060'));
  assert.ok(seenUrl.includes('page=1'));
  assert.ok(seenUrl.includes('feature=0'));
  assert.equal(seenH.get('cookie'), 'COOKIE_HDR');
  assert.equal(seenH.get('referer'), 'https://weibo.com/u/2203177060');
  assert.match(seenH.get('user-agent') ?? '', /Mozilla/);
});

test('fetchMymblog：HTTP 错 / 坏 JSON / ok!=1 / 缺 data.list 都抛中文错', async () => {
  await assert.rejects(
    fetchMymblog('C', '1', async () => new Response('x', { status: 500 })), /HTTP 500/);
  await assert.rejects(
    fetchMymblog('C', '1', async () => new Response('<html>登录页</html>', { status: 200 })),
    /不是合法 JSON/);
  await assert.rejects(
    fetchMymblog('C', '1', async () => new Response('{"ok":-100,"data":{}}', { status: 200 })),
    /ok=-100/);
  await assert.rejects(
    fetchMymblog('C', '1', async () => new Response('{"ok":1,"data":{}}', { status: 200 })),
    /缺少 data\.list/);
});

test('fetchLongText：成功取 longTextContent；HTTP 错/异常/空一律 null 兜底', async () => {
  const ok = await fetchLongText('C', 'Pb2cD', async () =>
    new Response('{"ok":1,"data":{"longTextContent":"完整全文"}}', { status: 200 }));
  assert.equal(ok, '完整全文');
  assert.equal(await fetchLongText('C', 'x', async () => new Response('x', { status: 404 })), null);
  assert.equal(await fetchLongText('C', 'x', async () => { throw new Error('boom'); }), null);
  assert.equal(await fetchLongText('C', 'x', async () =>
    new Response('{"ok":1,"data":{}}', { status: 200 })), null);
});

// ---- Source 轮询行为 ----

interface Harness {
  src: WeiboFeedSource;
  db: Db;
  signals: Signal[];
  loginStates: WeiboSelfInfo[];
  cleanup(): void;
}

/** 真 Bus + 收集信号，临时目录真实 Db；默认 uid 1 watch=1 且绑定微博 uid */
function harness(opts: {
  fetcher: MblogFetcher;
  selfFetcher?: WeiboSelfFetcher;
  longTextFetcher?: LongTextFetcher;
  streamers?: Array<{ uid: string; watch?: boolean; weiboUid?: string | null }>;
}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'ddclaw-'));
  const db = new Db(join(dir, 'test.db'));
  for (const s of opts.streamers ?? [{ uid: '1', watch: true, weiboUid: W_UID }]) {
    db.upsertStreamer({
      uid: s.uid,
      watch: s.watch ?? true,
      weiboUid: s.weiboUid === undefined ? W_UID : s.weiboUid, // 显式 null 保留（没绑微博）
    });
  }
  const bus = new Bus();
  const signals: Signal[] = [];
  bus.on('*', (s) => { signals.push(s); });
  const loginStates: WeiboSelfInfo[] = [];
  const src = new WeiboFeedSource({
    cookie: 'fake-cookie',
    fetcher: opts.fetcher,
    longTextFetcher: opts.longTextFetcher,
    selfFetcher: opts.selfFetcher ?? (async () => ({ loggedIn: true, uid: '999' })),
    onLoginState: (s) => { loginStates.push(s); },
  });
  src.bind({ bus, db, config: cfg() });
  return {
    src, db, signals, loginStates,
    cleanup() { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('首轮静默归档不发信号；第二轮新帖逐条 emit feed_post；重复轮询零信号（去重）', async (t) => {
  let round: unknown[] = [MBLOG, RETWEET];
  const h = harness({ fetcher: async () => round });
  t.after(h.cleanup);

  await h.src.pollOnce();
  assert.equal(h.db.listRecentPosts(['1'], 10).get('1')!.length, 2, '首轮归档入库');
  assert.equal(h.signals.filter((s) => s.kind === 'feed_post').length, 0, '首轮不发信号');
  assert.deepEqual(h.loginStates, [{ loggedIn: true, uid: '999' }], '每轮 onLoginState 上报');

  round = [LONG, MBLOG, RETWEET];
  await h.src.pollOnce();
  const feeds = h.signals.filter((s) => s.kind === 'feed_post');
  assert.equal(feeds.length, 1);
  assert.equal(feeds[0]!.source, 'weibo/feed');
  assert.equal(feeds[0]!.uid, '1');
  const pl = feeds[0]!.payload as { platform: string; itemId: string; type: string; url: string };
  assert.equal(pl.platform, 'weibo');
  assert.equal(pl.itemId, '5002');
  assert.equal(pl.type, 'mblog');
  assert.equal(pl.url, 'https://weibo.com/2203177060/Pb2cD');

  await h.src.pollOnce();
  assert.equal(h.signals.filter((s) => s.kind === 'feed_post').length, 1, '无新增零信号');
});

test('只抓 watch=1 且绑定 weiboUid 的主播', async (t) => {
  const fetched: string[] = [];
  const h = harness({
    fetcher: async (_c, weiboUid) => {
      fetched.push(weiboUid);
      // 不同 uid 给不同 idstr，避免撞 UNIQUE(platform,item_id) 去重
      return [{ ...MBLOG, idstr: '9' + weiboUid, mblogid: 'Z' + weiboUid }];
    },
    streamers: [
      { uid: '1', watch: true, weiboUid: W_UID },
      { uid: '2', watch: true, weiboUid: null },   // 没绑微博，不抓
      { uid: '3', watch: false, weiboUid: '111' }, // 不监听，不抓
    ],
  });
  t.after(h.cleanup);

  await h.src.pollOnce();
  assert.deepEqual(fetched, [W_UID]);
  assert.equal(h.db.listRecentPosts(['1'], 10).get('1')!.length, 1);
  assert.equal(h.db.listRecentPosts(['3'], 10).get('3'), undefined, 'watch=0 不写库');
});

test('isLongText 走 longTextFetcher 补全；补全失败用截断文本不算错误', async (t) => {
  const calls: string[] = [];
  const h = harness({
    fetcher: async () => [LONG],
    longTextFetcher: async (_c, mblogid) => { calls.push(mblogid); return '完整全文内容'; },
  });
  t.after(h.cleanup);

  await h.src.pollOnce();
  assert.deepEqual(calls, ['Pb2cD']);
  assert.equal(h.db.listRecentPosts(['1'], 10).get('1')![0]!.text, '完整全文内容');

  const h2 = harness({
    fetcher: async () => [LONG],
    longTextFetcher: async () => { throw new Error('boom'); },
  });
  t.after(h2.cleanup);
  await h2.src.pollOnce();
  assert.equal(h2.db.listRecentPosts(['1'], 10).get('1')![0]!.text, '这是一条很长的微博的截断部分...');
  assert.equal(h2.signals.filter((s) => s.kind === 'health_alert').length, 0, '补全失败不算失败');
});

test('登录失效：跳过整轮不抓不写库，告警一次；恢复复位后可再告警；onLoginState 如实上报', async (t) => {
  let loggedIn = true;
  let fetches = 0;
  const h = harness({
    fetcher: async () => { fetches++; return [MBLOG]; },
    selfFetcher: async () => ({ loggedIn, uid: loggedIn ? '999' : null }),
  });
  t.after(h.cleanup);

  await h.src.pollOnce();
  assert.equal(fetches, 1);

  loggedIn = false;
  await h.src.pollOnce();
  const alerts = h.signals.filter((s) => s.kind === 'health_alert');
  assert.equal(alerts.length, 1, '失效告警一次');
  assert.equal(alerts[0]!.source, 'weibo/feed');
  assert.match((alerts[0]!.payload as { message: string }).message, /微博登录态失效/);
  assert.equal(fetches, 1, '失效轮不抓取');
  assert.equal(h.db.listRecentPosts(['1'], 10).get('1')!.length, 1, '不写库，旧数据保留');

  await h.src.pollOnce();
  assert.equal(h.signals.filter((s) => s.kind === 'health_alert').length, 1, '同一轮失效不重复告警');
  assert.deepEqual(h.loginStates.at(-1), { loggedIn: false, uid: null });

  loggedIn = true;
  await h.src.pollOnce();
  assert.equal(fetches, 2, '恢复后继续抓取');
  loggedIn = false;
  await h.src.pollOnce();
  assert.equal(h.signals.filter((s) => s.kind === 'health_alert').length, 2, '恢复后失效重新告警');
});

test('心跳本身抛异常：跳过本轮不告警', async (t) => {
  let fetches = 0;
  const h = harness({
    fetcher: async () => { fetches++; return [MBLOG]; },
    selfFetcher: async () => { throw new Error('connect ETIMEDOUT'); },
  });
  t.after(h.cleanup);

  await h.src.pollOnce();
  assert.equal(fetches, 0, '不抓取');
  assert.equal(h.signals.filter((s) => s.kind === 'health_alert').length, 0, '网络失败 ≠ 失效，不告警');
});

test('单 uid 拉取失败：保留旧数据、阈值告警一次、恢复复位；不影响其他 uid', async (t) => {
  let fail = false;
  const h = harness({
    fetcher: async (_c, weiboUid) => {
      if (weiboUid === W_UID && fail) throw new Error('微博 mymblog HTTP 500');
      // 不同 uid 给不同 idstr，避免撞 UNIQUE(platform,item_id) 去重
      return [{ ...MBLOG, idstr: '9' + weiboUid, mblogid: 'Z' + weiboUid }];
    },
    streamers: [
      { uid: '1', watch: true, weiboUid: W_UID },
      { uid: '2', watch: true, weiboUid: '111' },
    ],
  });
  t.after(h.cleanup);

  await h.src.pollOnce();
  assert.equal(h.db.listRecentPosts(['1'], 10).get('1')!.length, 1);

  fail = true; // threshold=2：连挂 2 次告警一次
  await h.src.pollOnce();
  assert.equal(h.signals.filter((s) => s.kind === 'health_alert').length, 0, '第 1 次失败未达阈值');
  assert.equal(h.db.listRecentPosts(['1'], 10).get('1')!.length, 1, '旧数据原样保留');
  await h.src.pollOnce();
  assert.equal(h.signals.filter((s) => s.kind === 'health_alert').length, 1, '到阈值告警一次');
  await h.src.pollOnce();
  assert.equal(h.signals.filter((s) => s.kind === 'health_alert').length, 1, '同一轮故障不重复告警');
  assert.equal(h.db.listRecentPosts(['2'], 10).get('2')!.length >= 1, true, '其他 uid 正常归档');

  fail = false; // 恢复复位
  await h.src.pollOnce();
  fail = true;
  await h.src.pollOnce();
  await h.src.pollOnce();
  assert.equal(h.signals.filter((s) => s.kind === 'health_alert').length, 2, '恢复后故障重新告警');
});
