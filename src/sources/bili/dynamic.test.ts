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
    healthAlertToastAfterSec: 60,
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
    /** 图文页「监听动态」开关（只管 bili_accounts 部分）；缺省 = 开 */
    biliAccountsEnabled?: () => boolean;
  },
): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'ddclaw-'));
  const db = new Db(join(dir, 'test.db'));
  for (const uid of uids) db.upsertStreamer({ uid, watch: true });
  for (const a of opts?.biliAccounts ?? []) {
    db.upsertBiliAccount({ uid: a.uid, displayName: null, enabled: a.enabled ?? true });
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
    biliAccountsEnabled: opts?.biliAccountsEnabled,
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

test('解析 LIVE_RCMD：彻底舍弃——返回 null，不归档不发信号（2026-09-20 用户决策）', () => {
  assert.equal(parseDynamicItem(LIVE_RCMD, '7706705'), null);
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

test('解析 FORWARD：拼「//转发自 @原作者」摘要，图取原动态；type 归一成三平台共用的 retweet', () => {
  const p = parseDynamicItem(FORWARD, '1')!;
  assert.equal(p.text, '好好好\n//转发自 @原po主: 原动态正文');
  assert.deepEqual(p.pics, ['https://i0.hdslb.com/bfs/orig.jpg']);
  assert.equal(p.itemId, '1004', '去重 id 用转发自己的 id_str');
  assert.equal(p.type, 'retweet', 'FORWARD 在 source 归一（其余 DYNAMIC_TYPE_* 原样保留）');
  assert.equal(parseDynamicItem(WORD, '1')!.type, 'DYNAMIC_TYPE_WORD', '非转发保留原始枚举（主播卡细分标签用）');
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
  // feed_post 只对动态名单账号发：uid 1 同时挂进 bili_accounts（监听名单也在，Set 去重只拉一次）
  const h = harness(async () => round, ['1'], undefined, { biliAccounts: [{ uid: '1' }] });
  t.after(h.cleanup);

  // 第一轮：归档但静默
  await h.src.pollOnce();
  assert.equal(h.db.listRecentPosts(['1'], 10).get('1')!.length, 2, '首轮归档入库');
  assert.equal(h.signals.length, 0, '首轮不发任何信号');

  // 第二轮：新增 1 条转发 → 恰好 1 个 feed_post（type 已在 source 归一成三平台共用的 retweet）
  round = [FORWARD, WORD, DRAW];
  await h.src.pollOnce();
  const feeds = h.signals.filter((s) => s.kind === 'feed_post');
  assert.equal(feeds.length, 1);
  assert.equal(feeds[0]!.source, 'bili/dynamic');
  assert.equal(feeds[0]!.uid, '1');
  const pl = feeds[0]!.payload as { itemId: string; type: string; text: string; pubTs: number; url: string };
  assert.equal(pl.itemId, '1004');
  assert.equal(pl.type, 'retweet', 'FORWARD 在 source 归一');
  assert.equal(pl.text, '好好好\n//转发自 @原po主: 原动态正文');
  assert.equal(pl.url, 'https://t.bilibili.com/1004');

  // 第三轮：无新增 → 0 信号（去重只靠 UNIQUE，不靠时间戳）
  await h.src.pollOnce();
  assert.equal(h.signals.filter((s) => s.kind === 'feed_post').length, 1);
});

test('监听主播的动态只归档不推送：不在 bili_accounts 名单的 uid 不发 feed_post', async (t) => {
  let seq = 3000;
  // 每轮每个 uid 都有一条新动态（id 递增），如果发信号两边都会发
  const h = harness(async () => { seq++; return [{ ...WORD, id_str: String(seq) }]; }, ['1']);
  t.after(h.cleanup);

  await h.src.pollOnce();
  await h.src.pollOnce();
  assert.equal(h.db.listRecentPosts(['1'], 10).get('1')!.length, 2, '监听主播的动态照常归档');
  assert.equal(h.signals.filter((s) => s.kind === 'feed_post').length, 0, '不在名单 → 只归档不推送');
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
  t.mock.timers.enable({ apis: ['Date'] });
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

  // 时间口径：持续满 60s → 恰好 1 个 health_alert；继续失败不重复告警
  failWith = () => new BiliHttpError('响应不是合法 JSON（可能是风控页面）', 412);
  await h.src.pollOnce();
  assert.equal(h.signals.filter((s) => s.kind === 'health_alert').length, 0, '刚失败（持续 0 秒）未达阈值');
  t.mock.timers.setTime(Date.now() + 61_000);
  await h.src.pollOnce();
  const alerts = h.signals.filter((s) => s.kind === 'health_alert');
  assert.equal(alerts.length, 1, '持续满阈值告警一次');
  assert.equal(alerts[0]!.source, 'bili/dynamic');
  t.mock.timers.setTime(Date.now() + 61_000);
  await h.src.pollOnce();
  assert.equal(h.signals.filter((s) => s.kind === 'health_alert').length, 1, '同一轮故障不重复告警');

  // 恢复复位：成功后再次持续失败会重新告警
  failWith = null;
  await h.src.pollOnce();
  failWith = () => new BiliApiError(-352, '风控校验失败');
  await h.src.pollOnce();
  t.mock.timers.setTime(Date.now() + 61_000);
  await h.src.pollOnce();
  assert.equal(h.signals.filter((s) => s.kind === 'health_alert').length, 2, '恢复后故障重新告警');
});

test('链路全灭持续满 10 分钟再发 durationAlert 告警（QQ 路由依据）', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const h = harness(async () => { throw new BiliApiError(-352, '风控'); });
  t.after(h.cleanup);

  const isDur = (s: Signal) => (s.payload as { durationAlert?: boolean } | undefined)?.durationAlert === true;

  await h.src.pollOnce(); // 第 1 轮全灭，计起点
  t.mock.timers.setTime(Date.now() + 61_000);
  await h.src.pollOnce(); // 持续 1 分钟：满 toast 阈值（60s），未到 QQ 线
  assert.equal(h.signals.filter((s) => s.kind === 'health_alert').length, 1, 'toast 阈值告警');
  assert.equal(h.signals.filter(isDur).length, 0, '未到 10 分钟不发持续告警');

  t.mock.timers.setTime(Date.now() + 600_000);
  await h.src.pollOnce();
  const dur = h.signals.filter(isDur);
  assert.equal(dur.length, 1, '持续满 10 分钟应再报一次');
  assert.match((dur[0]!.payload as { message: string }).message, /已中断约 11 分钟/);
  await h.src.pollOnce();
  assert.equal(h.signals.filter(isDur).length, 1, '持续告警同轮故障不重复');
});

test('个别 uid 失败（链路正常）：不推送告警，名单账号持续满阈值落库 fetch_fail_*，恢复清库', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  let fail = true;
  const h = harness(async (_c, uid) => {
    if (uid === '2' && fail) throw new BiliApiError(-352, '风控校验失败');
    return [DRAW];
  }, ['1'], undefined, { biliAccounts: [{ uid: '2' }] });
  t.after(h.cleanup);

  await h.src.pollOnce(); // uid2 首次失败，持续 0 秒未达阈值
  assert.equal(h.signals.filter((s) => s.kind === 'health_alert').length, 0, '账号级故障不告警');
  assert.equal(h.db.getBiliAccountByUid('2')!.fetchError, null, '未达阈值不落库');
  t.mock.timers.setTime(Date.now() + 61_000);
  await h.src.pollOnce(); // 持续满 60s → 落库
  const acc = h.db.getBiliAccountByUid('2')!;
  assert.match(acc.fetchError ?? '', /风控校验失败/);
  assert.ok(acc.fetchFailSince !== null);

  fail = false;
  await h.src.pollOnce(); // 恢复 → 清库
  assert.equal(h.db.getBiliAccountByUid('2')!.fetchError, null);
  assert.equal(h.db.getBiliAccountByUid('2')!.fetchFailSince, null);
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

test('图文开关（biliAccountsEnabled）：关 = 名单账号不进轮询、kick 跳过；开 = 只对名单账号发信号', async (t) => {
  let seq = 3000;
  let gate = false;
  const called: string[] = [];
  // 每轮每个 uid 都有一条新动态（id 递增）：该发信号的只有名单账号
  const h = harness(
    async (_c, uid) => { called.push(uid); seq++; return [{ ...WORD, id_str: String(seq) }]; },
    ['1'],
    undefined,
    { biliAccounts: [{ uid: '2' }], biliAccountsEnabled: () => gate },
  );
  t.after(h.cleanup);

  // 关：名单账号不进轮询（只拉监听主播），kick 也跳过
  await h.src.pollOnce();
  assert.deepEqual(called, ['1'], '关着时名单账号不进轮询');
  await h.src.kickAccount('2');
  assert.deepEqual(called, ['1'], '关着时名单账号的即时首拉也跳过');
  assert.equal(h.db.listRecentPosts(['2'], 10).get('2'), undefined, '名单账号没被抓');

  // 开：下一轮名单账号进轮询（首轮静默归档），监听主播的新帖只归档
  gate = true;
  await h.src.pollOnce();
  assert.deepEqual([...called].sort(), ['1', '1', '2'], '名单账号随开关进入轮询');
  assert.equal(h.db.listRecentPosts(['2'], 10).get('2')!.length, 1, '名单账号首轮归档');
  assert.equal(h.signals.filter((s) => s.kind === 'feed_post').length, 0, '两边的首轮都静默');

  // 再一轮：两边都有新帖 → 只有名单账号（uid 2）发 feed_post
  await h.src.pollOnce();
  const feeds = h.signals.filter((s) => s.kind === 'feed_post');
  assert.equal(feeds.length, 1, '监听主播只归档，名单账号才推');
  assert.equal(feeds[0]!.uid, '2');
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

// ---- 轮次语义（core/backlog.ts）：缺口轮补推 / 恢复轮静默 ----

test('缺口轮补推（开关开）：只对名单账号、窗内按条数上限；监听主播不受影响', async (t) => {
  const nowSec = Math.floor(Date.now() / 1000);
  const dyn = (id: string, secAgo: number) => ({
    ...WORD, id_str: id,
    modules: { ...WORD.modules, module_author: { ...AUTHOR, pub_ts: nowSec - secAgo } },
  });
  const unknownTs = {
    ...WORD, id_str: '7005',
    modules: { ...WORD.modules, module_author: { ...AUTHOR, pub_ts: 'garbage' } },
  };
  // 7001 窗外（30h 前，窗 24h）；7002-7004 窗内；7005 时间未知
  const round = [dyn('7001', 3600 * 30), dyn('7002', 400), dyn('7003', 300), dyn('7004', 200), unknownTs];
  // uid 2 是监听主播但不在名单：即使开了补推开关也只归档
  const h = harness(
    async (_c, uid) => (uid === '2' ? [dyn('7100', 100)] : round),
    ['1', '2'], undefined, { biliAccounts: [{ uid: '1' }] },
  );
  t.after(h.cleanup);
  h.db.setSetting('backlog_push_enabled', '1');
  h.db.setSetting('backlog_max_age_hours', '24');
  h.db.setSetting('backlog_max_per_account', '2');

  await h.src.pollOnce();
  assert.equal(h.db.listRecentPosts(['1'], 10).get('1')!.length, 5, '名单账号全部归档');
  assert.equal(h.db.listRecentPosts(['2'], 10).get('2')!.length, 1, '监听主播也归档');
  assert.deepEqual(
    h.signals.filter((s) => s.kind === 'feed_post').map((f) => (f.payload as { itemId: string }).itemId),
    ['7003', '7004'],
    '只有名单账号补推，窗内最新 2 条正序；主播的与窗外/未知时间的只归档',
  );
});

test('恢复轮（停用→重新启用）：开了补推开关也静默，消费后清位；下一轮回正常轮', async (t) => {
  const nowSec = Math.floor(Date.now() / 1000);
  const dyn = (id: string, secAgo: number) => ({
    ...WORD, id_str: id,
    modules: { ...WORD.modules, module_author: { ...AUTHOR, pub_ts: nowSec - secAgo } },
  });
  let round = [dyn('7201', 100)];
  const h = harness(async () => round, ['1'], undefined, { biliAccounts: [{ uid: '1' }] });
  t.after(h.cleanup);

  await h.src.pollOnce();
  assert.equal(h.signals.filter((s) => s.kind === 'feed_post').length, 0, '缺口轮默认静默');

  h.db.setSetting('backlog_push_enabled', '1');
  const id = h.db.getBiliAccountByUid('1')!.id;
  h.db.upsertBiliAccount({ id, enabled: false });
  h.db.upsertBiliAccount({ id, enabled: true });
  assert.equal(h.db.getBiliAccountByUid('1')!.silentNext, true, '重新启用置位');

  round = [dyn('7202', 50), ...round]; // 停用期间的新动态
  await h.src.pollOnce();
  assert.equal(h.signals.filter((s) => s.kind === 'feed_post').length, 0, '恢复轮静默：主动关闭期间的动态不补推（开关开了也不推）');
  assert.equal(h.db.listRecentPosts(['1'], 10).get('1')!.length, 2, '归档照常完整');
  assert.equal(h.db.getBiliAccountByUid('1')!.silentNext, false, '恢复轮消费后清位');

  round = [dyn('7203', 5), ...round];
  await h.src.pollOnce();
  const feeds = h.signals.filter((s) => s.kind === 'feed_post');
  assert.equal(feeds.length, 1);
  assert.equal((feeds[0]!.payload as { itemId: string }).itemId, '7203', '清位后回正常轮');
});
