import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FollowsSource, type FollowingsFetcher, type SelfFetcher } from './follows.js';
import { fetchFollowings, type Following } from './followings.js';
import { BiliApiError } from './client.js';
import { Bus } from '../../core/bus.js';
import { Db } from '../../core/db.js';
import type { Signal } from '../../core/types.js';
import type { AppConfig } from '../../config/schema.js';
import type { SelfInfo } from './auth.js';

const LOGGED_IN: SelfInfo = { isLogin: true, mid: '999' };

function cfg(): AppConfig {
  return {
    pollIntervalSec: 45, pollJitterSec: 0,
    notifyOnFirstRun: false, notifyOnNewSubscription: true,
    healthAlertAfterFailures: 2,
    follows: { enabled: true, syncIntervalSec: 1800 },
    subscriptions: [],
    notify: { onebot: { enabled: false, targets: [] }, toast: { enabled: true } },
  } as AppConfig;
}

interface Harness {
  src: FollowsSource;
  db: Db;
  signals: Signal[];
  cleanup(): void;
}

/** 真 Bus + 收集信号，临时目录真实 Db，假 selfFetcher / listFetcher */
function harness(selfFetcher: SelfFetcher, listFetcher: FollowingsFetcher): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'ddclaw-'));
  const db = new Db(join(dir, 'test.db'));
  const bus = new Bus();
  const signals: Signal[] = [];
  bus.on('*', (s) => { signals.push(s); });
  const src = new FollowsSource({ cookie: 'fake-cookie', selfFetcher, listFetcher });
  src.bind({ bus, db, config: cfg() });
  return {
    src, db, signals,
    cleanup() { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const f = (uid: string, uname = `主播${uid}`, face?: string): Following => ({ uid, uname, face });

// ---- fetchFollowings 分页 ----

test('fetchFollowings 按 total 翻页到底并合并', async () => {
  const calls: number[] = [];
  const list = await fetchFollowings('c', '999', async (url) => {
    const pn = Number(new URL(url).searchParams.get('pn'));
    calls.push(pn);
    const mk = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({ mid: from + i, uname: `u${from + i}` }));
    if (pn === 1) return { total: 120, list: mk(1, 50) };
    if (pn === 2) return { total: 120, list: mk(51, 50) };
    return { total: 120, list: mk(101, 20) };
  });
  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(list.length, 120);
  assert.deepEqual(list[0], { uid: '1', uname: 'u1', face: undefined });
  assert.deepEqual(list[119], { uid: '120', uname: 'u120', face: undefined });
});

test('fetchFollowings 解析 face 字段', async () => {
  const list = await fetchFollowings('c', '999', async () => ({
    total: 2,
    list: [
      { mid: 1, uname: 'a', face: 'https://i0.hdslb.com/f1.jpg' },
      { mid: 2, uname: 'b' },
    ],
  }));
  assert.deepEqual(list[0], { uid: '1', uname: 'a', face: 'https://i0.hdslb.com/f1.jpg' });
  assert.equal(list[1]!.face, undefined, '缺 face 时为 undefined');
});

test('fetchFollowings 短页视为到底（total 不可靠时防死循环）', async () => {
  let pages = 0;
  const list = await fetchFollowings('c', '999', async () => {
    pages++;
    return { total: 99999, list: [{ mid: 1, uname: 'a' }] };
  });
  assert.equal(pages, 1);
  assert.equal(list.length, 1);
});

test('fetchFollowings 中间页 code != 0 直接抛（上层整轮放弃）', async () => {
  await assert.rejects(
    fetchFollowings('c', '999', async (url) => {
      const pn = Number(new URL(url).searchParams.get('pn'));
      if (pn === 2) throw new BiliApiError(-352, '风控');
      return { total: 100, list: Array.from({ length: 50 }, (_, i) => ({ mid: i + 1, uname: 'x' })) };
    }),
    BiliApiError,
  );
});

// ---- 同步主流程 ----

test('同步成功：关注不再自动入 streamers，已有手动条目不被覆盖', async (t) => {
  const h = harness(async () => LOGGED_IN, async () => [f('1'), f('2'), f('3')]);
  t.after(h.cleanup);
  // 用户手动管理过的条目：alias / notify / source 都必须保留
  h.db.upsertStreamer({ uid: '2', alias: '手动别名', notify: false, source: 'manual' });

  assert.equal(await h.src.syncOnce(), true);

  assert.equal(h.db.getStreamer('1'), undefined, '关注不再自动入监听（候选池只在 follows 表）');
  assert.equal(h.db.getStreamer('3'), undefined);

  const s2 = h.db.getStreamer('2');
  assert.equal(s2?.alias, '手动别名', '已有条目的 alias 不被覆盖');
  assert.equal(s2?.notify, false, '已有条目的 notify 不被覆盖');
  assert.equal(s2?.source, 'manual');

  assert.deepEqual(h.db.listFollows(true).map((x) => x.uid), ['1', '2', '3']);
  assert.equal(h.signals.length, 0, '正常同步不发任何信号');
});

test('face 透传与回填：follows 表带头像，已有空 face 的 streamer 回填，有值不覆盖', async (t) => {
  const FACE1 = 'https://i0.hdslb.com/f1.jpg';
  const FACE2_NEW = 'https://i0.hdslb.com/f2-new.jpg';
  const h = harness(async () => LOGGED_IN, async () => [
    f('1', '主播1', FACE1),
    f('2', '主播2', FACE2_NEW),
    f('3'), // 无头像
  ]);
  t.after(h.cleanup);
  // 2 已在监听名单且 face 为空；3 已有 face
  h.db.upsertStreamer({ uid: '2', uname: '旧名', notify: false, alias: '手动别名' });
  h.db.upsertStreamer({ uid: '3', uname: '主播3', face: 'https://i0.hdslb.com/f3.jpg' });

  assert.equal(await h.src.syncOnce(), true);

  assert.equal(h.db.getStreamer('1'), undefined, '不入监听');
  assert.equal(h.db.listFollows().find((x) => x.uid === '1')?.face, FACE1, 'follows 表带头像');

  const s2 = h.db.getStreamer('2')!;
  assert.equal(s2.face, FACE2_NEW, '已有条目 face 为空时回填');
  assert.equal(s2.notify, false, '回填不碰 notify');
  assert.equal(s2.alias, '手动别名', '回填不碰 alias');
  assert.equal(s2.uname, '旧名', '回填不碰 uname');

  assert.equal(h.db.getStreamer('3')?.face, 'https://i0.hdslb.com/f3.jpg', '已有 face 不被覆盖');
});

test('face 回填只进不退：后续轮拿到新头像也不覆盖已有值', async (t) => {
  let list = [f('1', '主播1', 'https://i0.hdslb.com/f1.jpg')];
  const h = harness(async () => LOGGED_IN, async () => list);
  t.after(h.cleanup);
  // 已在监听名单、face 为空 → 第一轮补；第二轮拿到新头像也不覆盖
  h.db.upsertStreamer({ uid: '1', uname: '主播1', watch: true, source: 'manual' });

  await h.src.syncOnce();
  assert.equal(h.db.getStreamer('1')?.face, 'https://i0.hdslb.com/f1.jpg', '空 face 第一轮回填');
  list = [f('1', '主播1', 'https://i0.hdslb.com/f1-v2.jpg')];
  await h.src.syncOnce();

  assert.equal(h.db.getStreamer('1')?.face, 'https://i0.hdslb.com/f1.jpg',
    'streamers.face 已有值时第二轮不覆盖（回填只在为空时发生）');
  assert.equal(h.db.listFollows().find((x) => x.uid === '1')?.face, 'https://i0.hdslb.com/f1-v2.jpg',
    'follows.face 允许被新值覆盖（COALESCE 只挡 NULL/空）');
});

test('取关标记：本轮消失的 uid 标 is_followed=0，新增的加入', async (t) => {
  let list = [f('1'), f('2')];
  const h = harness(async () => LOGGED_IN, async () => list);
  t.after(h.cleanup);
  // 用户手动加入监听的条目：取关也不被删除（监听名单由用户管理）
  h.db.upsertStreamer({ uid: '1', uname: '主播1', watch: true, source: 'manual' });

  await h.src.syncOnce();
  list = [f('2'), f('3')];
  await h.src.syncOnce();

  const follows = h.db.listFollows();
  assert.equal(follows.find((x) => x.uid === '1')?.isFollowed, false, '消失的标取关');
  assert.equal(follows.find((x) => x.uid === '2')?.isFollowed, true);
  assert.equal(follows.find((x) => x.uid === '3')?.isFollowed, true, '新增的在库');
  assert.equal(h.db.getStreamer('1')?.watch, true, '取关不删用户监听条目');
  assert.equal(h.db.getStreamer('3'), undefined, '新关注不自动入监听');
});

test('isLogin=false：发一次 health_alert 且不同步，连续失效不重复告警', async (t) => {
  let self: SelfInfo = { isLogin: false, mid: null };
  let listCalls = 0;
  const h = harness(async () => self, async () => { listCalls++; return [f('1')]; });
  t.after(h.cleanup);

  assert.equal(await h.src.syncOnce(), false);
  assert.equal(await h.src.syncOnce(), false);

  const alerts = h.signals.filter((s) => s.kind === 'health_alert');
  assert.equal(alerts.length, 1, '同一轮失效只告警一次');
  assert.equal(alerts[0]!.source, 'bili/follows');
  assert.match(String((alerts[0]!.payload as { message: string }).message), /cookie/);
  assert.equal(listCalls, 0, '未登录不得拉关注列表');
  assert.equal(h.db.listFollows().length, 0, '未登录不得写库');

  // 恢复后复位，并正常同步
  self = LOGGED_IN;
  assert.equal(await h.src.syncOnce(), true);
  assert.equal(listCalls, 1);

  // 再次失效会重新告警（复位生效）
  self = { isLogin: false, mid: null };
  await h.src.syncOnce();
  assert.equal(h.signals.filter((s) => s.kind === 'health_alert').length, 2);
});

test('单页失败整轮放弃：保留 follows 旧数据，不写不标取关', async (t) => {
  let fail = false;
  const h = harness(async () => LOGGED_IN, async () => {
    if (fail) throw new BiliApiError(-352, '风控');
    return [f('1'), f('2')];
  });
  t.after(h.cleanup);

  await h.src.syncOnce();
  assert.deepEqual(h.db.listFollows(true).map((x) => x.uid), ['1', '2']);

  fail = true;
  assert.equal(await h.src.syncOnce(), false);
  assert.deepEqual(h.db.listFollows(true).map((x) => x.uid), ['1', '2'], '旧数据原样保留');
  assert.equal(h.signals.length, 0, '拉取失败不发 health_alert（只有登录失效才发）');
});

test('心跳本身网络失败：跳过本轮，不误报 cookie 失效', async (t) => {
  const h = harness(async () => { throw new Error('网络超时'); }, async () => [f('1')]);
  t.after(h.cleanup);

  assert.equal(await h.src.syncOnce(), false);
  assert.equal(h.signals.filter((s) => s.kind === 'health_alert').length, 0);
  assert.equal(h.db.listFollows().length, 0);
});

// ---- onLoginState 上报 ----

test('onLoginState：每轮拿到 self 后上报一次，isLogin true/false 都报', async (t) => {
  let self: SelfInfo = { isLogin: false, mid: null };
  const seen: SelfInfo[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'ddclaw-'));
  const db = new Db(join(dir, 'test.db'));
  const bus = new Bus();
  const src = new FollowsSource({
    cookie: 'fake-cookie',
    selfFetcher: async () => self,
    listFetcher: async () => [f('1')],
    onLoginState: (s) => { seen.push(s); },
  });
  src.bind({ bus, db, config: cfg() });
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  await src.syncOnce(); // 未登录
  self = LOGGED_IN;
  await src.syncOnce(); // 已登录

  assert.deepEqual(seen, [{ isLogin: false, mid: null }, LOGGED_IN],
    '无论 isLogin 真假都上报，供面板区分 none/imported/expired');
});

test('onLoginState：心跳网络失败不上报（没有可信的 self）', async (t) => {
  const seen: SelfInfo[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'ddclaw-'));
  const db = new Db(join(dir, 'test.db'));
  const bus = new Bus();
  const src = new FollowsSource({
    cookie: 'fake-cookie',
    selfFetcher: async () => { throw new Error('网络超时'); },
    listFetcher: async () => [],
    onLoginState: (s) => { seen.push(s); },
  });
  src.bind({ bus, db, config: cfg() });
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  assert.equal(await src.syncOnce(), false);
  assert.equal(seen.length, 0);
});
