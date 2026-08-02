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

const f = (uid: string, uname = `主播${uid}`): Following => ({ uid, uname });

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
  assert.deepEqual(list[0], { uid: '1', uname: 'u1' });
  assert.deepEqual(list[119], { uid: '120', uname: 'u120' });
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

test('同步成功：新关注自动入 streamers，已有手动条目不被覆盖', async (t) => {
  const h = harness(async () => LOGGED_IN, async () => [f('1'), f('2'), f('3')]);
  t.after(h.cleanup);
  // 用户手动管理过的条目：alias / mode / source 都必须保留
  h.db.upsertStreamer({ uid: '2', alias: '手动别名', mode: 'silent', source: 'manual' });

  assert.equal(await h.src.syncOnce(), true);

  const s1 = h.db.getStreamer('1');
  assert.equal(s1?.mode, 'on');
  assert.equal(s1?.source, 'follows');
  assert.equal(s1?.uname, '主播1');

  const s2 = h.db.getStreamer('2');
  assert.equal(s2?.alias, '手动别名', '已有条目的 alias 不被覆盖');
  assert.equal(s2?.mode, 'silent', '已有条目的 mode 不被覆盖');
  assert.equal(s2?.source, 'manual');

  assert.deepEqual(h.db.listFollows(true).map((x) => x.uid), ['1', '2', '3']);
  assert.equal(h.signals.length, 0, '正常同步不发任何信号');
});

test('取关标记：本轮消失的 uid 标 is_followed=0，新增的加入', async (t) => {
  let list = [f('1'), f('2')];
  const h = harness(async () => LOGGED_IN, async () => list);
  t.after(h.cleanup);

  await h.src.syncOnce();
  list = [f('2'), f('3')];
  await h.src.syncOnce();

  const follows = h.db.listFollows();
  assert.equal(follows.find((x) => x.uid === '1')?.isFollowed, false, '消失的标取关');
  assert.equal(follows.find((x) => x.uid === '2')?.isFollowed, true);
  assert.equal(follows.find((x) => x.uid === '3')?.isFollowed, true, '新增的在库');
  // streamers 里已自动加入的不因取关被删除（监听名单由用户管理）
  assert.equal(h.db.getStreamer('1')?.mode, 'on');
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
