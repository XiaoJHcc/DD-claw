import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler, type StatusFetcher } from './scheduler.js';
import type { PrevState } from './state.js';
import type { RoomStatus } from '../sources/bili/types.js';
import type { AppConfig } from '../config/schema.js';
import { NoopAnalyzer } from '../analysis/noop.js';

function room(uid: string, over: Partial<RoomStatus> = {}): RoomStatus {
  return {
    uid, roomId: `room-${uid}`, uname: `主播${uid}`, title: '标题',
    isLive: true, rawLiveStatus: 1, liveTime: 1_785_310_737,
    areaName: '虚拟主播', parentAreaName: '虚拟主播', cover: '', keyframe: 'k.jpg',
    ...over,
  };
}

/** 记录所有调用的假 Db */
class FakeDb {
  states = new Map<string, PrevState>();
  notified = new Set<string>();
  sessions: string[] = [];
  saveBatches: number[] = [];

  loadRoomStates() { return new Map(this.states); }
  saveRoomStates(e: Array<{ uid: string; state: PrevState }>) {
    this.saveBatches.push(e.length);
    for (const x of e) this.states.set(x.uid, x.state);
  }
  saveRoomState(uid: string, s: PrevState) { this.states.set(uid, s); }
  recordSession(p: { roomId: string; liveTime: number }) { this.sessions.push(`${p.roomId}:${p.liveTime}`); }
  hasNotified(r: string, t: number) { return this.notified.has(`${r}:${t}`); }
  markNotified(r: string, t: number) { this.notified.add(`${r}:${t}`); }
  logNotify() { /* noop */ }
  close() { /* noop */ }
}

class FakeDispatcher {
  sent: string[] = [];
  alerts: string[] = [];
  concurrentPeak = 0;
  private inFlight = 0;
  constructor(private readonly delayMs = 0) {}

  get channels() { return ['fake']; }
  async broadcast(e: { uid: string; roomId: string; liveTime: number }) {
    this.inFlight++;
    this.concurrentPeak = Math.max(this.concurrentPeak, this.inFlight);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    this.inFlight--;
    this.sent.push(e.uid);
    return { anySuccess: true, total: 1, succeeded: 1 };
  }
  async alertAll(title: string, body: string) { this.alerts.push(`${title}|${body}`); }
}

function config(uids: string[], over: Partial<AppConfig> = {}): AppConfig {
  return {
    pollIntervalSec: 45, pollJitterSec: 0,
    notifyOnFirstRun: false, notifyOnNewSubscription: true,
    healthAlertAfterFailures: 2,
    subscriptions: uids.map((u) => ({ uid: u, alias: `别名${u}`, enabled: true })),
    notify: { onebot: { enabled: false, targets: [] }, toast: { enabled: true } },
    ...over,
  } as AppConfig;
}

interface Harness {
  sched: Scheduler;
  db: FakeDb;
  disp: FakeDispatcher;
}

function harness(uids: string[], fetcher: StatusFetcher, over: Partial<AppConfig> = {},
  dispatchDelayMs = 0): Harness {
  const db = new FakeDb();
  const disp = new FakeDispatcher(dispatchDelayMs);
  const sched = new Scheduler({
    config: config(uids, over),
    db: db as never,
    analyzer: new NoopAnalyzer(),
    rule: {
      name: 'test-once',
      async decide(e, sig) {
        if (sig.kind !== 'live_start') return { shouldNotify: false, reason: 'not start' };
        if (db.hasNotified(e.roomId, e.liveTime)) return { shouldNotify: false, reason: 'dup' };
        return { shouldNotify: true, reason: 'ok' };
      },
    },
    dispatcher: disp as never,
    fetcher,
  });
  return { sched, db, disp };
}

// ---- 拉取失败绝不能当成下播（M1 最关键的正确性属性）----

test('拉取失败不产生 live_end，且保留已知状态', async () => {
  const live = new Map([['1', room('1')]]);
  let fail = false;
  const { sched, db, disp } = harness(['1'], async () => {
    if (fail) throw new Error('模拟网络超时');
    return live;
  }, { notifyOnFirstRun: true });

  await sched.pollOnce();
  assert.deepEqual(disp.sent, ['1'], '首轮应推送');

  fail = true;
  await sched.pollOnce();
  await sched.pollOnce();

  assert.deepEqual(disp.sent, ['1'], '拉取失败期间不应有任何新推送');
  assert.equal(db.states.get('1')?.isLive, true, '失败不得把状态改成已下播');
});

test('拉取失败达到阈值触发一次告警，恢复后重置', async () => {
  let fail = true;
  const { sched, disp } = harness(['1'], async () => {
    if (fail) throw new Error('boom');
    return new Map([['1', room('1')]]);
  });

  await sched.pollOnce();
  assert.equal(disp.alerts.length, 0, '第 1 次失败还没到阈值');
  await sched.pollOnce();
  assert.equal(disp.alerts.length, 1, '第 2 次达到阈值应告警');
  await sched.pollOnce();
  assert.equal(disp.alerts.length, 1, '不应重复告警刷屏');

  assert.match(disp.alerts[0]!, /全部 1 个订阅/, '告警要说明影响范围');

  fail = false;
  await sched.pollOnce();
  assert.equal(sched.failureCount, 0, '成功后计数应重置');
});

// ---- 多主播 ----

test('多主播同时开播全部推送，且并发而非串行', async () => {
  const uids = ['1', '2', '3', '4', '5', '6'];
  const all = new Map(uids.map((u) => [u, room(u)]));
  const { sched, disp } = harness(uids, async () => all, { notifyOnFirstRun: true }, 30);

  const t0 = Date.now();
  await sched.pollOnce();
  const elapsed = Date.now() - t0;

  assert.equal(disp.sent.length, 6, '6 个主播都要推送');
  assert.deepEqual([...disp.sent].sort(), uids, '不能漏也不能串');
  assert.ok(disp.concurrentPeak > 1, `应并发处理，实测峰值 ${disp.concurrentPeak}`);
  assert.ok(elapsed < 6 * 30, `不应串行累积，实测 ${elapsed}ms`);
});

test('并发有上限，不会一次全部打出去', async () => {
  const uids = Array.from({ length: 12 }, (_, i) => String(i));
  const all = new Map(uids.map((u) => [u, room(u)]));
  const { sched, disp } = harness(uids, async () => all, { notifyOnFirstRun: true }, 20);
  await sched.pollOnce();
  assert.equal(disp.sent.length, 12);
  assert.ok(disp.concurrentPeak <= 4, `并发峰值应受限，实测 ${disp.concurrentPeak}`);
});

test('一个主播开播不影响其他主播的状态', async () => {
  const { sched, db, disp } = harness(['1', '2'], async () => new Map([
    ['1', room('1')],
    ['2', room('2', { isLive: false, rawLiveStatus: 0, liveTime: 0 })],
  ]), { notifyOnFirstRun: true });

  await sched.pollOnce();
  assert.deepEqual(disp.sent, ['1'], '只有在播的那个推送');
  assert.equal(db.states.get('2')?.isLive, false);
});

test('状态写入是批量的（一轮一次事务）', async () => {
  const uids = ['1', '2', '3'];
  const all = new Map(uids.map((u) => [u, room(u)]));
  const { sched, db } = harness(uids, async () => all);
  await sched.pollOnce();
  assert.deepEqual(db.saveBatches, [3], '3 个主播应合并为 1 次批量写');
});

// ---- 首次运行 vs 新增订阅 ----

test('首次运行默认不推已在播的', async () => {
  const { sched, disp } = harness(['1'], async () => new Map([['1', room('1')]]));
  await sched.pollOnce();
  assert.deepEqual(disp.sent, [], 'notifyOnFirstRun=false 时首轮不推');
});

test('新增订阅时正在直播的那场会被推送', async () => {
  // 模拟：DB 里已有主播 1 的记录（说明不是首次运行），现在新加主播 2
  const statuses = new Map([['1', room('1', { isLive: false, liveTime: 0 })], ['2', room('2')]]);
  const { sched, db, disp } = harness(['1', '2'], async () => statuses);
  db.states.set('1', { roomId: 'room-1', isLive: false, liveTime: 0, title: '标题' });
  sched.restore();

  await sched.pollOnce();
  assert.deepEqual(disp.sent, ['2'], '新增订阅且正在直播 → 应推送，否则这一场永远收不到');
});

test('新增订阅可关掉推送', async () => {
  const statuses = new Map([['1', room('1', { isLive: false, liveTime: 0 })], ['2', room('2')]]);
  const { sched, db, disp } = harness(['1', '2'], async () => statuses,
    { notifyOnNewSubscription: false });
  db.states.set('1', { roomId: 'room-1', isLive: false, liveTime: 0, title: '标题' });
  sched.restore();

  await sched.pollOnce();
  assert.deepEqual(disp.sent, []);
});

test('同一场不会重复推送（跨多轮轮询）', async () => {
  const all = new Map([['1', room('1')]]);
  const { sched, disp } = harness(['1'], async () => all, { notifyOnFirstRun: true });
  await sched.pollOnce();
  await sched.pollOnce();
  await sched.pollOnce();
  assert.deepEqual(disp.sent, ['1'], '3 轮只推 1 次');
});


