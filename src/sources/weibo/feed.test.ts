import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WeiboFeedSource, avatarUrlOf, fetchLongText, fetchMymblog, nicknameOf, parseMblog,
  type LongTextFetcher, type MblogFetcher, type WeiboSelfFetcher,
} from './feed.js';
import type { WeiboSelfInfo } from './auth.js';
import { Bus } from '../../core/bus.js';
import { Db } from '../../core/db.js';
import { emptyWeiboFeedSnapshot, type WeiboFeedSnapshot } from '../../core/weibo-accounts.js';
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

const USER = {
  screen_name: '渡瀬結月',
  profile_image_url: 'https://tvax1.sinaimg.cn/crop.0.0.180/small.jpg',
  avatar_large: 'https://tvax1.sinaimg.cn/crop.0.0.1080.1080.180/big.jpg',
};

const MBLOG = {
  idstr: '5001', mblogid: 'Pa1bC', isLongText: false,
  text_raw: '今晚九点直播！', created_at: CREATED, user: USER,
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

test('parseMblog 原创带图：字段全对，posts.uid 用微博账号自身 uid', () => {
  const p = parseMblog(MBLOG, W_UID)!;
  assert.equal(p.platform, 'weibo');
  assert.equal(p.uid, W_UID, '归属 uid = 被抓账号自身（同 X 存 screen name 的语义）');
  assert.equal(p.itemId, '5001');
  assert.equal(p.type, 'mblog');
  assert.equal(p.text, '今晚九点直播！');
  assert.deepEqual(p.pics, ['https://wx1.sinaimg.cn/large/a.jpg']);
  assert.equal(p.pubTs, CREATED_TS, 'created_at 是 "Mon Aug 03 ... +0800 2026" 格式');
  assert.ok(p.pubTs > 1_700_000_000, '解析出的是真实时间戳');
  assert.equal(p.url, `https://weibo.com/${W_UID}/Pa1bC`, 'url 用微博 uid + mblogid');
  assert.ok(p.raw!.includes('5001'), 'raw 整 item 归档');
});

test('parseMblog 转发：拼「//转发自 @原作者」，图取原微博', () => {
  const p = parseMblog(RETWEET, W_UID)!;
  assert.equal(p.type, 'retweet');
  assert.equal(p.text, '好耶\n//转发自 @原作者: 原微博正文');
  assert.deepEqual(p.pics, ['https://wx1.sinaimg.cn/large/o.jpg']);
  assert.equal(p.itemId, '5003', '去重 id 用转发自己的 idstr');
});

test('parseMblog 长文：longText 优先，缺省用截断文本兜底', () => {
  const full = parseMblog(LONG, W_UID, '这是完整全文')!;
  assert.equal(full.text, '这是完整全文');
  const fallback = parseMblog(LONG, W_UID, null)!;
  assert.equal(fallback.text, '这是一条很长的微博的截断部分...');
});

test('parseMblog 防御：缺 idstr 返回 null；坏 created_at pubTs=0；被删原微博残桩不炸', () => {
  assert.equal(parseMblog({ mblogid: 'x' }, W_UID), null);
  assert.equal(parseMblog(null, W_UID), null);
  const bad = parseMblog({ idstr: '9', created_at: 'garbage' }, W_UID)!;
  assert.equal(bad.pubTs, 0);
  const stub = parseMblog({
    idstr: '10', text_raw: '转了', retweeted_status: { deleted: '1' },
  }, W_UID)!;
  assert.equal(stub.type, 'retweet');
  assert.equal(stub.text, '转了');
  assert.deepEqual(stub.pics, []);
});

test('parseMblog pic_infos 形态：mymblog 实测（2026-09-20）图片在 pic_infos，顺序按 pic_ids', () => {
  const p = parseMblog({
    idstr: '5004', mblogid: 'Pd4eG', text_raw: '带图', created_at: CREATED,
    pic_ids: ['bbb', 'aaa'],
    pic_infos: {
      aaa: { large: { url: 'https://wx1.sinaimg.cn/orj960/aaa.jpg' } },
      bbb: { bmiddle: { url: 'https://wx2.sinaimg.cn/wap360/bbb.jpg' } },
    },
  }, W_UID)!;
  assert.deepEqual(p.pics, ['https://wx2.sinaimg.cn/wap360/bbb.jpg', 'https://wx1.sinaimg.cn/orj960/aaa.jpg'],
    '顺序按 pic_ids（pic_infos 键序不保证）；缺 large 回退 bmiddle');
  // pics 数组形态仍优先（两种响应形态共存）
  const both = parseMblog({
    idstr: '5005', text_raw: 'x', created_at: CREATED,
    pics: [{ large: { url: 'https://wx1.sinaimg.cn/large/a.jpg' } }],
    pic_infos: { zzz: { large: { url: 'https://wx1.sinaimg.cn/orj960/zzz.jpg' } } },
  }, W_UID)!;
  assert.deepEqual(both.pics, ['https://wx1.sinaimg.cn/large/a.jpg']);
});

test('avatarUrlOf / nicknameOf：优先大图字段、缺字段一律 null（防御式）', () => {
  assert.equal(avatarUrlOf(MBLOG), USER.avatar_large);
  assert.equal(avatarUrlOf({ user: { profile_image_url: 'https://x/a.jpg' } }), 'https://x/a.jpg');
  assert.equal(avatarUrlOf({}), null);
  assert.equal(avatarUrlOf(null), null);
  assert.equal(nicknameOf(MBLOG), '渡瀬結月');
  assert.equal(nicknameOf({ user: { screen_name: '  ' } }), null);
  assert.equal(nicknameOf({}), null);
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
  statuses: WeiboFeedSnapshot[];
  cleanup(): void;
}

/** 真 Bus + 收集信号，临时目录真实 Db；默认名单里一个启用账号 */
function harness(opts: {
  fetcher: MblogFetcher;
  selfFetcher?: WeiboSelfFetcher;
  longTextFetcher?: LongTextFetcher;
  accounts?: Array<{ uid: string; enabled?: boolean; nickname?: string | null; biliUid?: string | null }>;
  avatarCacheDir?: string;
  avatarSaver?: (url: string, dir: string) => Promise<string | null>;
}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'ddclaw-'));
  const db = new Db(join(dir, 'test.db'));
  for (const a of opts.accounts ?? [{ uid: W_UID }]) {
    db.upsertWeiboAccount({
      uid: a.uid,
      nickname: a.nickname === undefined ? null : a.nickname,
      biliUid: a.biliUid ?? null,
      enabled: a.enabled ?? true,
    });
  }
  const bus = new Bus();
  const signals: Signal[] = [];
  bus.on('*', (s) => { signals.push(s); });
  const loginStates: WeiboSelfInfo[] = [];
  const statuses: WeiboFeedSnapshot[] = [];
  const src = new WeiboFeedSource({
    cookie: 'fake-cookie',
    fetcher: opts.fetcher,
    longTextFetcher: opts.longTextFetcher,
    selfFetcher: opts.selfFetcher ?? (async () => ({ loggedIn: true, uid: '999' })),
    onLoginState: (s) => { loginStates.push(s); },
    onStatus: (s) => { statuses.push(s); },
    avatarCacheDir: opts.avatarCacheDir,
    avatarSaver: opts.avatarSaver,
  });
  src.bind({ bus, db, config: cfg() });
  return {
    src, db, signals, loginStates, statuses,
    cleanup() { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('首轮静默归档不发信号；第二轮新帖逐条 emit feed_post；重复轮询零信号（去重）', async (t) => {
  let round: unknown[] = [MBLOG, RETWEET];
  const h = harness({ fetcher: async () => round });
  t.after(h.cleanup);

  await h.src.pollOnce();
  assert.equal(h.db.listRecentPosts([W_UID], 10).get(W_UID)!.length, 2, '首轮归档入库');
  assert.equal(h.signals.filter((s) => s.kind === 'feed_post').length, 0, '首轮不发信号');
  assert.deepEqual(h.loginStates, [{ loggedIn: true, uid: '999' }], '每轮 onLoginState 上报');

  round = [LONG, MBLOG, RETWEET];
  await h.src.pollOnce();
  const feeds = h.signals.filter((s) => s.kind === 'feed_post');
  assert.equal(feeds.length, 1);
  assert.equal(feeds[0]!.source, 'weibo/feed');
  assert.equal(feeds[0]!.uid, W_UID, '信号 uid = 微博账号 uid（pipeline 按它查名单）');
  const pl = feeds[0]!.payload as { platform: string; itemId: string; type: string; url: string };
  assert.equal(pl.platform, 'weibo');
  assert.equal(pl.itemId, '5002');
  assert.equal(pl.type, 'mblog');
  assert.equal(pl.url, `https://weibo.com/${W_UID}/Pb2cD`);

  await h.src.pollOnce();
  assert.equal(h.signals.filter((s) => s.kind === 'feed_post').length, 1, '无新增零信号');
});

test('只抓 enabled=1 的微博账号（停用的不抓、不写库）', async (t) => {
  const fetched: string[] = [];
  const h = harness({
    fetcher: async (_c, weiboUid) => {
      fetched.push(weiboUid);
      // 不同 uid 给不同 idstr，避免撞 UNIQUE(platform,item_id) 去重
      return [{ ...MBLOG, idstr: '9' + weiboUid, mblogid: 'Z' + weiboUid }];
    },
    accounts: [
      { uid: W_UID, enabled: true },
      { uid: '111', enabled: false }, // 停用，不抓
    ],
  });
  t.after(h.cleanup);

  await h.src.pollOnce();
  assert.deepEqual(fetched, [W_UID]);
  assert.equal(h.db.listRecentPosts([W_UID], 10).get(W_UID)!.length, 1);
  assert.equal(h.db.listRecentPosts(['111'], 10).get('111'), undefined, '停用账号不写库');
});

test('名单为空：不打网络、状态记为 0 账号（面板要能区分「没配账号」与「抓取失败」）', async (t) => {
  let fetches = 0;
  const h = harness({ fetcher: async () => { fetches++; return [MBLOG]; }, accounts: [] });
  t.after(h.cleanup);

  await h.src.pollOnce();
  assert.equal(fetches, 0);
  assert.equal(h.statuses.at(-1)!.accounts, 0);
  assert.equal(h.statuses.at(-1)!.lastError, null);
  assert.ok(h.statuses.at(-1)!.lastRunAt, '仍然记了本轮时间');
});

test('状态快照：成功轮记账号数/成功数/lastOkAt；失败轮给可读原因（抓不到 ≠ 没新帖）', async (t) => {
  let fail = false;
  const h = harness({
    fetcher: async () => {
      if (fail) throw new Error('微博 mymblog HTTP 500');
      return [MBLOG];
    },
  });
  t.after(h.cleanup);

  await h.src.pollOnce();
  const ok = h.statuses.at(-1)!;
  assert.equal(ok.accounts, 1);
  assert.equal(ok.okAccounts, 1);
  assert.equal(ok.lastError, null);
  assert.ok(ok.lastOkAt, '成功轮写入 lastOkAt');

  fail = true;
  await h.src.pollOnce();
  const bad = h.statuses.at(-1)!;
  assert.equal(bad.okAccounts, 0);
  assert.match(bad.lastError ?? '', /HTTP 500/, '失败原因必须可读且带上账号');
  assert.equal(bad.lastOkAt, ok.lastOkAt, '失败不清掉上一次成功的证据');
});

test('游标只往前推 + 昵称回写 + lastOkAt；旧帖不倒退游标', async (t) => {
  let round: unknown[] = [{ ...MBLOG, idstr: '5001' }];
  const h = harness({ fetcher: async () => round });
  t.after(h.cleanup);

  await h.src.pollOnce();
  let acc = h.db.getWeiboAccountByUid(W_UID)!;
  assert.equal(acc.lastPostId, '5001');
  assert.equal(acc.nickname, '渡瀬結月', '抓到昵称就回写（昵称会改、uid 不会）');
  assert.ok(acc.lastOkAt);

  // 同一条 + 一条更老的：游标不该倒退
  round = [{ ...MBLOG, idstr: '4999', mblogid: 'Pold' }, { ...MBLOG, idstr: '5001' }];
  await h.src.pollOnce();
  acc = h.db.getWeiboAccountByUid(W_UID)!;
  assert.equal(acc.lastPostId, '5001', '游标只往前推');
});

test('头像：抓到 URL 才下载并回写文件名；已有头像不重复下载', async (t) => {
  const calls: string[] = [];
  const h = harness({
    fetcher: async () => [MBLOG],
    avatarCacheDir: join(tmpdir(), 'ddclaw-avatars-unused'),
    avatarSaver: async (url) => { calls.push(url); return 'abc.jpg'; },
  });
  t.after(h.cleanup);

  await h.src.pollOnce();
  assert.deepEqual(calls, [USER.avatar_large], '优先大图字段');
  assert.equal(h.db.getWeiboAccountByUid(W_UID)!.avatar, 'abc.jpg');

  await h.src.pollOnce();
  assert.equal(calls.length, 1, '已有本地头像不再下载');
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
  assert.equal(h.db.listRecentPosts([W_UID], 10).get(W_UID)![0]!.text, '完整全文内容');

  const h2 = harness({
    fetcher: async () => [LONG],
    longTextFetcher: async () => { throw new Error('boom'); },
  });
  t.after(h2.cleanup);
  await h2.src.pollOnce();
  assert.equal(h2.db.listRecentPosts([W_UID], 10).get(W_UID)![0]!.text, '这是一条很长的微博的截断部分...');
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
  assert.match((alerts[0]!.payload as { message: string }).message, /微博登录态运行中失效/);
  assert.equal(fetches, 1, '失效轮不抓取');
  assert.equal(h.db.listRecentPosts([W_UID], 10).get(W_UID)!.length, 1, '不写库，旧数据保留');
  assert.match(h.statuses.at(-1)!.lastError ?? '', /登录态失效/, '状态行给原因，不静默');

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

test('从未成功登录：跳过抓取，只上报登录态，不告警', async (t) => {
  let fetches = 0;
  const h = harness({
    fetcher: async () => { fetches++; return [MBLOG]; },
    selfFetcher: async () => ({ loggedIn: false, uid: null }),
  });
  t.after(h.cleanup);

  await h.src.pollOnce();
  await h.src.pollOnce();
  assert.equal(fetches, 0, '未登录不抓取');
  assert.equal(h.signals.filter((s) => s.kind === 'health_alert').length, 0, '本来就没登录不发告警');
  assert.deepEqual(h.loginStates.at(-1), { loggedIn: false, uid: null }, '未登录也上报登录态');
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

test('单账号拉取失败：保留旧数据、阈值告警一次、恢复复位；不影响其他账号', async (t) => {
  let fail = false;
  const h = harness({
    fetcher: async (_c, weiboUid) => {
      if (weiboUid === W_UID && fail) throw new Error('微博 mymblog HTTP 500');
      // 不同 uid 给不同 idstr，避免撞 UNIQUE(platform,item_id) 去重
      return [{ ...MBLOG, idstr: '9' + weiboUid, mblogid: 'Z' + weiboUid }];
    },
    accounts: [{ uid: W_UID }, { uid: '111' }],
  });
  t.after(h.cleanup);

  await h.src.pollOnce();
  assert.equal(h.db.listRecentPosts([W_UID], 10).get(W_UID)!.length, 1);

  fail = true; // threshold=2：连挂 2 次告警一次
  await h.src.pollOnce();
  assert.equal(h.signals.filter((s) => s.kind === 'health_alert').length, 0, '第 1 次失败未达阈值');
  assert.equal(h.db.listRecentPosts([W_UID], 10).get(W_UID)!.length, 1, '旧数据原样保留');
  await h.src.pollOnce();
  assert.equal(h.signals.filter((s) => s.kind === 'health_alert').length, 1, '到阈值告警一次');
  await h.src.pollOnce();
  assert.equal(h.signals.filter((s) => s.kind === 'health_alert').length, 1, '同一轮故障不重复告警');
  assert.equal(h.db.listRecentPosts(['111'], 10).get('111')!.length >= 1, true, '其他账号正常归档');

  fail = false; // 恢复复位
  await h.src.pollOnce();
  fail = true;
  await h.src.pollOnce();
  await h.src.pollOnce();
  assert.equal(h.signals.filter((s) => s.kind === 'health_alert').length, 2, '恢复后故障重新告警');
});

test('单账号连续失败持续满 10 分钟再发 durationAlert 告警（QQ 路由依据）', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const h = harness({
    fetcher: async () => { throw new Error('微博 mymblog HTTP 500'); },
  });
  t.after(h.cleanup);

  const isDur = (s: Signal) => (s.payload as { durationAlert?: boolean } | undefined)?.durationAlert === true;

  await h.src.pollOnce(); // 第 1 次失败，计起点
  t.mock.timers.setTime(Date.now() + 61_000);
  await h.src.pollOnce(); // 达次数阈值（2），只持续 1 分钟
  assert.equal(h.signals.filter((s) => s.kind === 'health_alert').length, 1, '次数阈值告警');
  assert.equal(h.signals.filter(isDur).length, 0, '未到 10 分钟不发持续告警');

  t.mock.timers.setTime(Date.now() + 600_000);
  await h.src.pollOnce();
  assert.equal(h.signals.filter(isDur).length, 1, '持续满 10 分钟应再报一次');
});

test('默认状态快照：未启动时 running=false 且各项为空（面板拿它画灰点）', () => {
  assert.deepEqual(emptyWeiboFeedSnapshot(), {
    running: false, lastRunAt: null, lastOkAt: null, accounts: 0, okAccounts: 0, lastError: null,
  });
});
