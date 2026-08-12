import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveStatusSource, type StatusFetcher } from './live-status-source.js';
import { Bus } from '../../core/bus.js';
import { Db } from '../../core/db.js';
import type { Signal } from '../../core/types.js';
import type { RoomStatus } from './types.js';
import type { AppConfig } from '../../config/schema.js';

function room(uid: string, over: Partial<RoomStatus> = {}): RoomStatus {
  return {
    uid, roomId: `room-${uid}`, uname: `主播${uid}`, title: '标题',
    isLive: true, rawLiveStatus: 1, liveTime: 1_785_310_737,
    areaName: '虚拟主播', parentAreaName: '虚拟主播', cover: 'c.jpg', keyframe: 'k.jpg',
    face: `https://i0.hdslb.com/face-${uid}.jpg`, online: 100,
    ...over,
  };
}

function config(_uids: string[], over: Partial<AppConfig> = {}): AppConfig {
  return {
    pollIntervalSec: 45, pollJitterSec: 0,
    notifyOnFirstRun: false, notifyOnNewSubscription: true,
    healthAlertAfterFailures: 2,
    subscriptions: [],
    notify: { onebot: { enabled: false, targets: [] }, toast: { enabled: true } },
    ...over,
  } as AppConfig;
}

interface Harness {
  src: LiveStatusSource;
  db: Db;
  signals: Signal[];
  cfg: AppConfig;
  cleanup(): void;
}

/** 真 Bus + 收集信号，临时目录真实 Db（streamers 表预插名单），假 fetcher */
function harness(uids: string[], fetcher: StatusFetcher, over: Partial<AppConfig> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'ddclaw-'));
  const db = new Db(join(dir, 'test.db'));
  for (const u of uids) db.upsertStreamer({ uid: u, alias: `别名${u}` });
  const bus = new Bus();
  const signals: Signal[] = [];
  bus.on('*', (s) => { signals.push(s); });
  const cfg = config(uids, over);
  const src = new LiveStatusSource({ fetcher });
  src.bind({ bus, db, config: cfg });
  return {
    src, db, signals, cfg,
    cleanup() { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

// ---- 拉取失败绝不能当成下播（最关键的正确性属性）----

test('拉取失败不产生 signal，且保留已知状态', async (t) => {
  const live = new Map([['1', room('1')]]);
  let fail = false;
  const h = harness(['1'], async () => {
    if (fail) throw new Error('模拟网络超时');
    return live;
  });
  t.after(h.cleanup);

  await h.src.pollOnce();
  assert.deepEqual(h.signals.map((s) => s.kind), ['live_start']);

  fail = true;
  await h.src.pollOnce();
  await h.src.pollOnce();

  assert.equal(
    h.signals.filter((s) => s.kind !== 'health_alert').length,
    1,
    '拉取失败期间不应产生任何新的 live 系信号（health_alert 除外）',
  );
  assert.equal(h.db.loadRoomStates().get('1')?.isLive, true, '失败不得把状态改成已下播');
});

test('拉取失败达到阈值 emit 一次 health_alert，恢复后计数复位', async (t) => {
  let fail = true;
  const h = harness(['1'], async () => {
    if (fail) throw new Error('boom');
    return new Map([['1', room('1')]]);
  });
  t.after(h.cleanup);

  await h.src.pollOnce();
  assert.equal(h.signals.length, 0, '第 1 次失败还没到阈值');
  await h.src.pollOnce();
  const alerts = h.signals.filter((s) => s.kind === 'health_alert');
  assert.equal(alerts.length, 1, '第 2 次达到阈值应告警');
  const p = alerts[0]!.payload as { failures: number; subscriptions: number; lastError: string };
  assert.equal(p.failures, 2);
  assert.equal(p.subscriptions, 1, 'payload 要带上受影响的订阅数');
  assert.match(p.lastError, /boom/);

  await h.src.pollOnce();
  assert.equal(h.signals.filter((s) => s.kind === 'health_alert').length, 1, '不应重复告警刷屏');

  fail = false;
  await h.src.pollOnce();
  assert.equal(h.src.failureCount, 0, '成功后计数应重置');
});

test('连续失败持续满 10 分钟再发一次 durationAlert 告警（QQ 路由依据），恢复复位', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  let fail = true;
  const h = harness(['1'], async () => {
    if (fail) throw new Error('boom');
    return new Map([['1', room('1')]]);
  });
  t.after(h.cleanup);

  const isDur = (s: Signal) => (s.payload as { durationAlert?: boolean } | undefined)?.durationAlert === true;

  await h.src.pollOnce(); // t0：第 1 次失败，计起点
  t.mock.timers.setTime(Date.now() + 61_000);
  await h.src.pollOnce(); // 达次数阈值（2 次），但只持续 1 分钟
  assert.equal(h.signals.filter((s) => s.kind === 'health_alert').length, 1, '次数阈值告警');
  assert.equal(h.signals.filter(isDur).length, 0, '未到 10 分钟不发持续告警');

  t.mock.timers.setTime(Date.now() + 600_000);
  await h.src.pollOnce(); // 已持续约 11 分钟
  const dur = h.signals.filter(isDur);
  assert.equal(dur.length, 1, '持续满 10 分钟应再报一次');
  assert.equal((dur[0]!.payload as { alertKind?: string }).alertKind, 'streak');
  await h.src.pollOnce();
  assert.equal(h.signals.filter(isDur).length, 1, '持续告警同轮故障不重复');

  // 恢复复位后，新一轮故障持续超阈值会重新告警
  fail = false;
  await h.src.pollOnce();
  fail = true;
  await h.src.pollOnce();
  t.mock.timers.setTime(Date.now() + 601_000);
  await h.src.pollOnce();
  assert.equal(h.signals.filter(isDur).length, 2, '恢复后故障重新告警');
});

// ---- 缺 key = 未开播 ----

test('返回缺 key = 未开播，不影响其他主播的状态', async (t) => {
  const h = harness(['1', '2', '3'], async () => new Map([
    ['1', room('1')],
    ['2', room('2', { isLive: false, rawLiveStatus: 0, liveTime: 0 })],
    // '3' 整个 key 缺失
  ]));
  t.after(h.cleanup);

  await h.src.pollOnce();
  assert.deepEqual(h.signals.map((s) => s.uid), ['1'], '只有在播的那个产 live_start');
  const states = h.db.loadRoomStates();
  assert.equal(states.get('2')?.isLive, false);
  assert.equal(states.has('3'), false, '缺失且无历史的 uid 不落状态');
});

test('状态写入是批量的（一轮一次事务）', async (t) => {
  const uids = ['1', '2', '3'];
  const all = new Map(uids.map((u) => [u, room(u)]));
  const h = harness(uids, async () => all);
  t.after(h.cleanup);

  const batches: number[] = [];
  const orig = h.db.saveRoomStates.bind(h.db);
  h.db.saveRoomStates = (e) => { batches.push(e.length); orig(e); };

  await h.src.pollOnce();
  assert.deepEqual(batches, [3], '3 个主播应合并为 1 次批量写');
});

// ---- 冷启动标记：first_run vs new_subscription ----

test('首轮观测（known 为空）整轮都标 first_run', async (t) => {
  const h = harness(['1', '2'], async () => new Map([['1', room('1')], ['2', room('2')]]));
  t.after(h.cleanup);

  await h.src.pollOnce();
  assert.equal(h.signals.length, 2);
  for (const s of h.signals) assert.equal(s.coldStart, 'first_run');
});

test('已运行后新出现的 uid 标 new_subscription，老 uid 不标', async (t) => {
  const statuses = new Map([
    ['1', room('1', { isLive: false, liveTime: 0 })],
    ['2', room('2')],
  ]);
  const h = harness(['1', '2'], async () => statuses);
  t.after(h.cleanup);
  // 模拟非首次运行：DB 里已有主播 1 的记录
  h.db.saveRoomState('1', {
    roomId: 'room-1', isLive: false, liveTime: 0, title: '标题',
    areaName: '', parentAreaName: '', keyframe: '', cover: '', online: 0, face: '',
  });
  h.src.restore();

  await h.src.pollOnce();
  assert.deepEqual(
    h.signals.map((s) => [s.uid, s.coldStart]),
    [['2', 'new_subscription']],
  );

  // 下一轮老订阅开播：不带 coldStart 标记
  statuses.set('1', room('1'));
  h.signals.length = 0;
  await h.src.pollOnce();
  assert.deepEqual(h.signals.map((s) => [s.uid, s.coldStart]), [['1', undefined]]);
});

test('重启恢复：停机期间开播的已订阅主播标 restart_recovery，后续轮不带标记', async (t) => {
  // 上次运行结束时主播 1 已下播（DB 里有离线记录），停机期间他开播了
  const h = harness(['1'], async () => new Map());
  t.after(h.cleanup);
  h.db.saveRoomState('1', {
    roomId: 'room-1', isLive: false, liveTime: 0, title: '标题',
    areaName: '', parentAreaName: '', keyframe: '', cover: '', online: 0, face: '',
  });
  h.src.restore();

  // 重启后首轮：标 restart_recovery（不是实时开播）
  const live = new Map([['1', room('1')]]);
  const bus2 = new Bus();
  const signals2: Signal[] = [];
  bus2.on('*', (s) => { signals2.push(s); });
  const src2 = new LiveStatusSource({ fetcher: async () => live });
  src2.bind({ bus: bus2, db: h.db, config: h.cfg });

  await src2.pollOnce();
  assert.deepEqual(
    signals2.map((s) => [s.uid, s.kind, s.coldStart]),
    [['1', 'live_start', 'restart_recovery']],
    '停机期间开播 = 启动时已在播，标 restart_recovery',
  );

  // 第二轮：在播持续，不再产任何信号
  signals2.length = 0;
  await src2.pollOnce();
  assert.equal(signals2.length, 0);
});

// ---- restore 恢复基线 ----

test('restore 恢复基线：重启后同一场不重复产 live_start', async (t) => {
  const all = new Map([['1', room('1')]]);
  const h = harness(['1'], async () => all);
  t.after(h.cleanup);
  await h.src.pollOnce();
  assert.equal(h.signals.length, 1);

  // 模拟重启：同一个 DB，新 source 实例
  const bus2 = new Bus();
  const signals2: Signal[] = [];
  bus2.on('*', (s) => { signals2.push(s); });
  const src2 = new LiveStatusSource({ fetcher: async () => all });
  src2.bind({ bus: bus2, db: h.db, config: h.cfg });

  await src2.pollOnce();
  assert.equal(signals2.length, 0, '基线恢复后同一场不重复产信号');
});

test('同一场跨多轮轮询只产一次 live_start', async (t) => {
  const all = new Map([['1', room('1')]]);
  const h = harness(['1'], async () => all);
  t.after(h.cleanup);

  await h.src.pollOnce();
  await h.src.pollOnce();
  await h.src.pollOnce();
  assert.equal(h.signals.filter((s) => s.kind === 'live_start').length, 1, '3 轮只产 1 次');
});

// ---- 实况字段持久化 + 头像回填 ----

test('room_state 落库展示字段：keyframe/分区/在线人数，下播后保留上一场实况', async (t) => {
  const statuses = new Map([['1', room('1')]]);
  const h = harness(['1'], async () => statuses);
  t.after(h.cleanup);

  await h.src.pollOnce();
  let s = h.db.loadRoomStates().get('1')!;
  assert.equal(s.keyframe, 'k.jpg');
  assert.equal(s.cover, 'c.jpg');
  assert.equal(s.areaName, '虚拟主播');
  assert.equal(s.parentAreaName, '虚拟主播');
  assert.equal(s.online, 100);

  // 下播：curr 缺 key，offline 写路径 { ...prev, isLive: false } 保留上一场实况
  statuses.clear();
  await h.src.pollOnce();
  s = h.db.loadRoomStates().get('1')!;
  assert.equal(s.isLive, false);
  assert.equal(s.keyframe, 'k.jpg', '下播后仍保留上一场关键帧');
  assert.equal(s.online, 100, '下播后仍保留上一场在线人数');
});

test('头像回填：streamers.face 为空时用本轮 face 补上，已有值不覆盖', async (t) => {
  const all = new Map([['1', room('1')], ['2', room('2')]]);
  const h = harness(['1', '2'], async () => all);
  t.after(h.cleanup);
  // 1 face 为空（harness 预插时未给）；2 已有 face
  h.db.upsertStreamer({ uid: '2', uname: '主播2', face: 'https://i0.hdslb.com/old.jpg' });

  await h.src.pollOnce();

  const s1 = h.db.getStreamer('1')!;
  assert.equal(s1.face, 'https://i0.hdslb.com/face-1.jpg', '空 face 被回填');
  assert.equal(s1.alias, '别名1', '回填不碰其他字段');
  assert.equal(h.db.getStreamer('2')?.face, 'https://i0.hdslb.com/old.jpg', '已有 face 不覆盖');
});

test('curr.face 为空串时不做回填', async (t) => {
  const all = new Map([['1', room('1', { face: '' })]]);
  const h = harness(['1'], async () => all);
  t.after(h.cleanup);

  await h.src.pollOnce();
  assert.equal(h.db.getStreamer('1')?.face, null, '空串 face 不写入');
});

test('直播间号回填：streamers.roomId 为空时用本轮 room_id 补上，已有值不覆盖', async (t) => {
  const all = new Map([['1', room('1')], ['2', room('2')]]);
  const h = harness(['1', '2'], async () => all);
  t.after(h.cleanup);
  // 1 roomId 为空（harness 预插时未给）；2 已有 roomId
  h.db.upsertStreamer({ uid: '2', roomId: '已有房间号' });

  await h.src.pollOnce();

  const s1 = h.db.getStreamer('1')!;
  assert.equal(s1.roomId, 'room-1', '空 roomId 被回填');
  assert.equal(s1.alias, '别名1', '回填不碰其他字段');
  assert.equal(h.db.getStreamer('2')?.roomId, '已有房间号', '已有 roomId 不覆盖');
});

test('在播条目触发 touchLiveSessions：last_seen 刷新 + 非空 keyframe 覆盖，未开播不打点', async (t) => {
  const all = new Map([
    ['1', room('1')],
    ['2', room('2', { isLive: false, rawLiveStatus: 0, liveTime: 0 })],
  ]);
  const h = harness(['1', '2'], async () => all);
  t.after(h.cleanup);
  // 预置场次（recordSession 是 pipeline 的职责，这里直接落库模拟已在归档的场次）
  h.db.recordSession({
    roomId: 'room-1', liveTime: 1_785_310_737, uid: '1', uname: '主播1',
    title: '标题', areaName: '虚拟主播', parentAreaName: '虚拟主播', keyframe: 'old.jpg',
  });

  await h.src.pollOnce();

  const entries = h.db.listTimeline(0, 2_000_000_000);
  const e = entries.find((x) => x.roomId === 'room-1')!;
  assert.equal(e.endTs, null, '在播轮询打点新鲜 → listTimeline 判在播（endTs=null）');
  assert.equal(e.keyframe, 'k.jpg', '非空 keyframe 覆盖开场快照');
  assert.equal(entries.some((x) => x.uid === '2'), false, '未开播条目不打点');
});
