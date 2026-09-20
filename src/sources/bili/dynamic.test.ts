import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DynamicSource, fetchDynamics, parseDynamicItem, type DynamicFetcher, type DynamicSelfFetcher,
} from './dynamic.js';
import { BiliApiError, BiliHttpError } from './client.js';
import { Bus } from '../../core/bus.js';
import { Db } from '../../core/db.js';
import type { Signal } from '../../core/types.js';
import type { AppConfig } from '../../config/schema.js';

function cfg(): AppConfig {
  return {
    pollIntervalSec: 45, pollJitterSec: 0,
    notifyOnFirstRun: false, notifyOnNewSubscription: true,
    healthAlertAfterFailures: 2,
    follows: { enabled: true, syncIntervalSec: 1800 },
    dynamic: { enabled: true, intervalSec: 300 },
    subscriptions: [],
    notify: { onebot: { enabled: false, targets: [] }, toast: { enabled: true } },
  } as AppConfig;
}

interface Harness {
  src: DynamicSource;
  db: Db;
  signals: Signal[];
  loginStates: Array<{ isLogin: boolean; mid: string | null }>;
  cleanup(): void;
}

/** 真 Bus + 收集信号，临时目录真实 Db（监听名单含 uid 1/2），假 fetcher / 假登录态心跳 */
function harness(
  fetcher: DynamicFetcher,
  uids: string[] = ['1'],
  selfFetcher?: DynamicSelfFetcher,
  opts?: {
    biliAccounts?: Array<{ uid: string; enabled?: boolean }>;
    avatarDir?: string;
    avatarSaver?: (url: string, dir: string) => Promise<string | null>;
  },
): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'ddclaw-'));
  const db = new Db(join(dir, 'test.db'));
  for (const uid of uids) db.upsertStreamer({ uid, watch: true });
  for (const a of opts?.biliAccounts ?? []) {
    db.upsertBiliAccount({ uid: a.uid, uname: null, displayName: null, enabled: a.enabled ?? true });
  }
  const bus = new Bus();
  const signals: Signal[] = [];
  bus.on('*', (s) => { signals.push(s); });
  const loginStates: Harness['loginStates'] = [];
  const src = new DynamicSource({
    cookie: 'fake-cookie',
    fetcher,
    selfFetcher: selfFetcher ?? (async () => ({ isLogin: true, mid: '99' })),
    onLoginState: (s) => { loginStates.push(s); },
    avatarDir: opts?.avatarDir,
    avatarSaver: opts?.avatarSaver,
  });
  src.bind({ bus, db, config: cfg() });
  return {
    src, db, signals, loginStates,
    cleanup() { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

// ---- 解析 fixture ----

const AUTHOR = { pub_ts: 1_754_000_000, name: '阿梓从小就很可爱' };

const LIVE_RCMD = {
  id_str: '1001',
  type: 'DYNAMIC_TYPE_LIVE_RCMD',
  modules: {
    module_author: AUTHOR,
    module_dynamic: {
      desc: null,
      major: {
        type: 'MAJOR_TYPE_LIVE_RCMD',
        live_rcmd: {
          content: JSON.stringify({
            live_play_info: {
              title: '唱会歌！', room_id: 80397, area_name: '虚拟主播',
              cover: 'https://i0.hdslb.com/bfs/live/cover.jpg',
            },
          }),
        },
      },
    },
  },
};

const WORD = {
  id_str: '1002',
  type: 'DYNAMIC_TYPE_WORD',
  modules: {
    module_author: AUTHOR,
    module_dynamic: { desc: { text: '今晚八点开播！' }, major: null },
  },
};

const DRAW = {
  id_str: '1003',
  type: 'DYNAMIC_TYPE_DRAW',
  modules: {
    module_author: AUTHOR,
    module_dynamic: {
      desc: { text: '新图来了' },
      major: {
        type: 'MAJOR_TYPE_DRAW',
        draw: { items: [{ src: 'https://i0.hdslb.com/bfs/p1.jpg' }, { src: 'https://i0.hdslb.com/bfs/p2.jpg' }] },
      },
    },
  },
};

const FORWARD = {
  id_str: '1004',
  type: 'DYNAMIC_TYPE_FORWARD',
  modules: {
    module_author: AUTHOR,
    module_dynamic: { desc: { text: '好好好' }, major: null },
  },
  orig: {
    id_str: '9999',
    type: 'DYNAMIC_TYPE_DRAW',
    modules: {
      module_author: { pub_ts: 1_753_000_000, name: '原po主' },
      module_dynamic: {
        desc: { text: '原动态正文' },
        major: {
          type: 'MAJOR_TYPE_OPUS',
          opus: { pics: [{ url: 'https://i0.hdslb.com/bfs/orig.jpg' }], summary: { text: '原动态正文' } },
        },
      },
    },
  },
};

test('解析 LIVE_RCMD：二次 JSON.parse 取 live_play_info.title / cover', () => {
  const p = parseDynamicItem(LIVE_RCMD, '7706705')!;
  assert.equal(p.platform, 'bili_dynamic');
  assert.equal(p.uid, '7706705');
  assert.equal(p.itemId, '1001');
  assert.equal(p.type, 'DYNAMIC_TYPE_LIVE_RCMD');
  assert.equal(p.text, '唱会歌！');
  assert.deepEqual(p.pics, ['https://i0.hdslb.com/bfs/live/cover.jpg']);
  assert.equal(p.pubTs, 1_754_000_000);
  assert.equal(p.url, 'https://t.bilibili.com/1001');
  assert.ok(p.raw!.includes('LIVE_RCMD'), 'raw 整 item 归档');
});

test('解析 WORD：desc.text', () => {
  const p = parseDynamicItem(WORD, '1')!;
  assert.equal(p.text, '今晚八点开播！');
  assert.deepEqual(p.pics, []);
});

test('解析 DRAW：desc.text + draw.items[].src', () => {
  const p = parseDynamicItem(DRAW, '1')!;
  assert.equal(p.text, '新图来了');
  assert.deepEqual(p.pics, ['https://i0.hdslb.com/bfs/p1.jpg', 'https://i0.hdslb.com/bfs/p2.jpg']);
});

test('解析 FORWARD：拼「//转发自 @原作者」摘要，图取原动态', () => {
  const p = parseDynamicItem(FORWARD, '1')!;
  assert.equal(p.text, '好好好\n//转发自 @原po主: 原动态正文');
  assert.deepEqual(p.pics, ['https://i0.hdslb.com/bfs/orig.jpg']);
  assert.equal(p.itemId, '1004', '去重 id 用转发自己的 id_str');
});

test('解析：缺 id_str 的 item 返回 null 跳过', () => {
  assert.equal(parseDynamicItem({ type: 'DYNAMIC_TYPE_WORD' }, '1'), null);
  assert.equal(parseDynamicItem(null, '1'), null);
});

// ---- fetchDynamics 请求形状（实测配方）----

test('fetchDynamics：URL 带 host_mid/features/dm 三参，头带 cookie 与 space Referer', async () => {
  let seenUrl = '';
  let seenOpts: { cookie?: string; referer?: string } = {};
  const items = await fetchDynamics('COOKIE_HDR', '7706705', async (url, opts) => {
    seenUrl = url;
    seenOpts = opts ?? {};
    return { items: [WORD] };
  });
  assert.equal(items.length, 1);
  assert.ok(seenUrl.startsWith('https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?'));
  assert.ok(seenUrl.includes('host_mid=7706705'));
  assert.ok(seenUrl.includes('platform=web'));
  assert.ok(seenUrl.includes('features=itemOpusStyle'));
  assert.ok(seenUrl.includes('dm_img_list='), 'dm_img_list 存在');
  assert.ok(seenUrl.includes('dm_img_str=bm8gd2ViZ2w'));
  assert.ok(seenUrl.includes('dm_cover_img_str=bm8gd2ViZ2w'));
  assert.ok(!seenUrl.includes('w_rid'), '不做 WBI 签名');
  assert.equal(seenOpts.cookie, 'COOKIE_HDR');
  assert.equal(seenOpts.referer, 'https://space.bilibili.com/7706705/');
});

// ---- 轮询行为 ----

test('首轮静默归档不发信号；第二轮新帖逐条 emit feed_post；重复轮询零信号（去重）', async (t) => {
  let round = [WORD, DRAW];
  const h = harness(async () => round);
  t.after(h.cleanup);

  // 第一轮：归档但静默
  await h.src.pollOnce();
  assert.equal(h.db.listRecentPosts(['1'], 10).get('1')!.length, 2, '首轮归档入库');
  assert.equal(h.signals.length, 0, '首轮不发任何信号');

  // 第二轮：新增 1 条 → 恰好 1 个 feed_post
  round = [LIVE_RCMD, WORD, DRAW];
  await h.src.pollOnce();
  const feeds = h.signals.filter((s) => s.kind === 'feed_post');
  assert.equal(feeds.length, 1);
  assert.equal(feeds[0]!.source, 'bili/dynamic');
  assert.equal(feeds[0]!.uid, '1');
  const pl = feeds[0]!.payload as { itemId: string; type: string; text: string; pubTs: number; url: string };
  assert.equal(pl.itemId, '1001');
  assert.equal(pl.type, 'DYNAMIC_TYPE_LIVE_RCMD');
  assert.equal(pl.text, '唱会歌！');
  assert.equal(pl.url, 'https://t.bilibili.com/1001');

  // 第三轮：无新增 → 0 信号（去重只靠 UNIQUE，不靠时间戳）
  await h.src.pollOnce();
  assert.equal(h.signals.filter((s) => s.kind === 'feed_post').length, 1);
});

test('多个监听 uid：各 uid 首轮各自静默', async (t) => {
  const h = harness(async (_c, uid) => (uid === '1' ? [WORD] : [DRAW]), ['1', '2']);
  t.after(h.cleanup);

  await h.src.pollOnce();
  assert.equal(h.signals.length, 0, '两个 uid 都是首轮');
  await h.src.pollOnce();
  assert.equal(h.signals.filter((s) => s.kind === 'feed_post').length, 0, '无新增');
});

test('412 HTML（非 JSON）/ -352 / 网络异常：本轮跳过、旧数据不动、失败计数与告警', async (t) => {
  let failWith: (() => Error) | null = null;
  const h = harness(async () => {
    if (failWith) throw failWith();
    return [WORD];
  });
  t.after(h.cleanup);

  await h.src.pollOnce(); // 首轮正常归档
  assert.equal(h.db.listRecentPosts(['1'], 10).get('1')!.length, 1);

  const cases: Array<[string, () => Error]> = [
    ['412 风控 HTML 页', () => new BiliHttpError('响应不是合法 JSON（可能是风控页面）', 412)],
    ['-352 风控', () => new BiliApiError(-352, '风控校验失败')],
    ['网络异常', () => new Error('网络错误: connect ETIMEDOUT')],
  ];
  for (const [name, make] of cases) {
    failWith = make;
    await h.src.pollOnce();
    assert.equal(h.db.listRecentPosts(['1'], 10).get('1')!.length, 1, `${name}：旧数据原样保留`);
    failWith = null;
    await h.src.pollOnce(); // 成功一轮复位计数，隔离下一个用例
  }

  // threshold=2：连挂 2 次 → 恰好 1 个 health_alert；第 3 次不重复告警
  failWith = () => new BiliHttpError('响应不是合法 JSON（可能是风控页面）', 412);
  await h.src.pollOnce();
  assert.equal(h.signals.filter((s) => s.kind === 'health_alert').length, 0, '第 1 次失败未达阈值');
  await h.src.pollOnce();
  const alerts = h.signals.filter((s) => s.kind === 'health_alert');
  assert.equal(alerts.length, 1, '到阈值告警一次');
  assert.equal(alerts[0]!.source, 'bili/dynamic');
  await h.src.pollOnce();
  assert.equal(h.signals.filter((s) => s.kind === 'health_alert').length, 1, '同一轮故障不重复告警');

  // 恢复复位：成功后再次连挂会重新告警
  failWith = null;
  await h.src.pollOnce();
  failWith = () => new BiliApiError(-352, '风控校验失败');
  await h.src.pollOnce();
  await h.src.pollOnce();
  assert.equal(h.signals.filter((s) => s.kind === 'health_alert').length, 2, '恢复后故障重新告警');
});

test('单 uid 连续失败持续满 10 分钟再发 durationAlert 告警（QQ 路由依据）', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const h = harness(async () => { throw new BiliApiError(-352, '风控'); });
  t.after(h.cleanup);

  const isDur = (s: Signal) => (s.payload as { durationAlert?: boolean } | undefined)?.durationAlert === true;

  await h.src.pollOnce(); // 第 1 次失败，计起点
  t.mock.timers.setTime(Date.now() + 61_000);
  await h.src.pollOnce(); // 达次数阈值（2），只持续 1 分钟
  assert.equal(h.signals.filter((s) => s.kind === 'health_alert').length, 1, '次数阈值告警');
  assert.equal(h.signals.filter(isDur).length, 0, '未到 10 分钟不发持续告警');

  t.mock.timers.setTime(Date.now() + 600_000);
  await h.src.pollOnce();
  const dur = h.signals.filter(isDur);
  assert.equal(dur.length, 1, '持续满 10 分钟应再报一次');
  assert.match((dur[0]!.payload as { message: string }).message, /已持续失败约 11 分钟/);
  await h.src.pollOnce();
  assert.equal(h.signals.filter(isDur).length, 1, '持续告警同轮故障不重复');
});

test('单 uid 失败不影响其他 uid 本轮归档', async (t) => {
  const h = harness(async (_c, uid) => {
    if (uid === '1') throw new BiliApiError(-352, '风控校验失败');
    return [DRAW];
  }, ['1', '2']);
  t.after(h.cleanup);

  await h.src.pollOnce();
  assert.equal(h.db.listRecentPosts(['1'], 10).get('1'), undefined, '失败的 uid 不写库');
  assert.equal(h.db.listRecentPosts(['2'], 10).get('2')!.length, 1, '其他 uid 正常归档');
});

// ---- 动态名单（bili_accounts）：union 轮询与账号回写 ----

/** 带 face 的作者字段（名单账号回写 fixture） */
const ACCOUNT_AUTHOR = { pub_ts: 1_754_000_000, name: '动态号主', face: 'https://i0.hdslb.com/bfs/face/abc.jpg' };
const ACCOUNT_WORD = {
  id_str: '2001',
  type: 'DYNAMIC_TYPE_WORD',
  modules: {
    module_author: ACCOUNT_AUTHOR,
    module_dynamic: { desc: { text: '名单账号的动态' }, major: null },
  },
};

test('轮询对象 = 监听主播 ∪ 动态名单启用账号（Set 去重，disabled 不拉）', async (t) => {
  const called: string[] = [];
  const h = harness(
    async (_c, uid) => { called.push(uid); return []; },
    ['1'],
    undefined,
    { biliAccounts: [{ uid: '1' }, { uid: '2' }, { uid: '3', enabled: false }] },
  );
  t.after(h.cleanup);

  await h.src.pollOnce();
  assert.deepEqual([...called].sort(), ['1', '2'], '重复 uid 只拉一次，disabled 账号不拉');
});

test('名单账号拉取成功回写 uname/lastOkAt；非名单 uid（仅监听主播）不回写', async (t) => {
  const h = harness(
    async (_c, uid) => (uid === '2' ? [ACCOUNT_WORD] : [WORD]),
    ['1'],
    undefined,
    { biliAccounts: [{ uid: '2' }] },
  );
  t.after(h.cleanup);

  await h.src.pollOnce();
  const acc = h.db.getBiliAccountByUid('2')!;
  assert.equal(acc.uname, '动态号主', '摸到非空名就回写（名会改、uid 不会）');
  assert.ok(acc.lastOkAt, '成功一轮推 lastOkAt');
  assert.equal(h.db.getBiliAccountByUid('1'), undefined, '监听主播不在动态名单，不产生账号行');
});

test('uname 拿不到非空值时不覆盖已有名字，lastOkAt 照常推', async (t) => {
  const h = harness(
    async () => [{ ...ACCOUNT_WORD, modules: { module_author: { pub_ts: 1 }, module_dynamic: { desc: { text: 'x' }, major: null } } }],
    [],
    undefined,
    { biliAccounts: [{ uid: '2' }] },
  );
  t.after(h.cleanup);
  h.db.touchBiliAccount(h.db.getBiliAccountByUid('2')!.id, { uname: '旧名字' });

  await h.src.pollOnce();
  const acc = h.db.getBiliAccountByUid('2')!;
  assert.equal(acc.uname, '旧名字', '空名不覆盖');
  assert.ok(acc.lastOkAt);
});

test('头像：注入 avatarDir 才抠 face 落盘并回写文件名；已有头像不重复下载', async (t) => {
  const calls: string[] = [];
  const h = harness(
    async () => [ACCOUNT_WORD],
    [],
    undefined,
    {
      biliAccounts: [{ uid: '2' }],
      avatarDir: join(tmpdir(), 'ddclaw-bili-avatars-unused'),
      avatarSaver: async (url) => { calls.push(url); return 'face.jpg'; },
    },
  );
  t.after(h.cleanup);

  await h.src.pollOnce();
  assert.deepEqual(calls, [ACCOUNT_AUTHOR.face], '抠 module_author.face 落盘');
  assert.equal(h.db.getBiliAccountByUid('2')!.avatar, 'face.jpg', '落盘成功回写文件名');

  await h.src.pollOnce();
  assert.equal(calls.length, 1, '已有本地头像不再下载');

  // 不注入 avatarDir：只归档回写身份，不落盘
  const h2 = harness(async () => [ACCOUNT_WORD], [], undefined, { biliAccounts: [{ uid: '2' }] });
  t.after(h2.cleanup);
  await h2.src.pollOnce();
  assert.equal(h2.db.getBiliAccountByUid('2')!.avatar, null);
});

test('头像下载失败（saver 返回 null）不回写 avatar，主流程照常归档与回写身份', async (t) => {
  const h = harness(
    async () => [ACCOUNT_WORD],
    [],
    undefined,
    {
      biliAccounts: [{ uid: '2' }],
      avatarDir: join(tmpdir(), 'ddclaw-bili-avatars-unused'),
      avatarSaver: async () => null,
    },
  );
  t.after(h.cleanup);

  await h.src.pollOnce();
  const acc = h.db.getBiliAccountByUid('2')!;
  assert.equal(acc.avatar, null, '失败按无头像处理');
  assert.equal(acc.uname, '动态号主', '身份回写不受头像失败影响');
  assert.equal(h.db.listRecentPosts(['2'], 10).get('2')!.length, 1, '归档照常');
});

// ---- 登录态心跳（折进轮询周期，同 FollowsSource 纪律）----

test('每轮心跳上报登录态（onLoginState），供面板展示', async (t) => {
  const h = harness(async () => [WORD]);
  t.after(h.cleanup);

  await h.src.pollOnce();
  await h.src.pollOnce();
  assert.deepEqual(h.loginStates, [
    { isLogin: true, mid: '99' },
    { isLogin: true, mid: '99' },
  ], '每轮上报一次（无论 isLogin 真假）');
});

test('登录失效：本来就没登录不告警；运行中意外失效才告警一次，恢复后复位并重新归档', async (t) => {
  let loggedIn = false;
  let fetched = 0;
  const h = harness(
    async () => { fetched++; return [WORD]; },
    ['1'],
    async () => ({ isLogin: loggedIn, mid: loggedIn ? '99' : null }),
  );
  t.after(h.cleanup);

  // 从未成功登录过：跳过抓取，不告警
  await h.src.pollOnce();
  assert.equal(fetched, 0, '未登录不抓动态');
  assert.equal(h.db.listRecentPosts(['1'], 10).get('1'), undefined);
  assert.equal(h.signals.filter((s) => s.kind === 'health_alert').length, 0, '本来就没登录不发告警');
  assert.deepEqual(h.loginStates.at(-1), { isLogin: false, mid: null }, '失效也上报登录态');

  // 成功登录一轮后失效：告警一次，同一轮失效不重复
  loggedIn = true;
  await h.src.pollOnce();
  assert.equal(fetched, 1);
  loggedIn = false;
  await h.src.pollOnce();
  await h.src.pollOnce();
  const alerts = h.signals.filter((s) => s.kind === 'health_alert');
  assert.equal(alerts.length, 1, '运行中失效告警一次');
  assert.equal(alerts[0]!.source, 'bili/dynamic');
  assert.match((alerts[0]!.payload as { message: string }).message, /cookie 运行中失效/);

  // 恢复：复位后继续抓取归档
  loggedIn = true;
  await h.src.pollOnce();
  assert.equal(fetched, 2, '恢复后继续抓取');
  assert.equal(h.db.listRecentPosts(['1'], 10).get('1')!.length, 1);

  // 复位后再次失效会重新告警
  loggedIn = false;
  await h.src.pollOnce();
  assert.equal(h.signals.filter((s) => s.kind === 'health_alert').length, 2);
});

test('心跳本身网络失败：不告警、不抓取，跳过本轮', async (t) => {
  let fetched = 0;
  const h = harness(
    async () => { fetched++; return [WORD]; },
    ['1'],
    async () => { throw new Error('网络错误: connect ETIMEDOUT'); },
  );
  t.after(h.cleanup);

  await h.src.pollOnce();
  assert.equal(fetched, 0);
  assert.equal(h.signals.length, 0, '网络失败 ≠ cookie 失效，不发 health_alert 也不上报');
});

test('kickAccount：面板添加账号后的即时首拉（不等周期；首轮静默政策同样生效）', async (t) => {
  const fetched: string[] = [];
  const h = harness(
    async (_cookie, uid) => { fetched.push(uid); return [WORD]; },
    ['1'],
    undefined,
    { biliAccounts: [{ uid: '7' }] },
  );
  t.after(h.cleanup);

  await h.src.kickAccount('7');
  assert.deepEqual(fetched, ['7'], '只拉被 kick 的账号');
  assert.equal(h.db.listRecentPosts(['7'], 10).get('7')!.length, 1, '即时归档');
  assert.equal(h.signals.filter((s) => s.kind === 'feed_post').length, 0, '首轮静默不发信号');

  // 名单账号的 uname/lastOkAt 回写同样走（与周期路径同一 pollUid）
  const acc = h.db.getBiliAccountByUid('7')!;
  assert.equal(acc.uname, '阿梓从小就很可爱');
  assert.ok(acc.lastOkAt && acc.lastOkAt > 0);
});
