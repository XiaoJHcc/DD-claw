import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline } from './pipeline.js';
import { Bus } from './bus.js';
import { AnalysisQueue } from '../analysis/queue.js';
import { NoopAnalyzer } from '../analysis/noop.js';
import { OncePerSessionRule } from '../rules/once-per-session.js';
import type { PushMessage, Signal } from './types.js';
import type { PreferenceClause } from './streamers.js';
import type { RoomStatus } from '../sources/bili/types.js';
import type { AppConfig } from '../config/schema.js';

function status(over: Partial<RoomStatus> = {}): RoomStatus {
  return {
    uid: '1', roomId: 'r1', uname: '主播1', title: '标题',
    isLive: true, rawLiveStatus: 1, liveTime: 1_785_310_737,
    areaName: '虚拟主播', parentAreaName: '虚拟主播', cover: '', keyframe: 'k.jpg',
    ...over,
  };
}

function sig(over: Partial<Signal> = {}): Signal {
  return {
    source: 'bili/live-status', kind: 'live_start', uid: '1', roomId: 'r1',
    ts: 0, status: status(), ...over,
  };
}

class FakeDb {
  sessions: string[] = [];
  notified = new Set<string>();
  streamers = new Map<string, { alias: string | null; notify: boolean }>([
    ['1', { alias: '阿梓', notify: true }],
  ]);
  clauses: PreferenceClause[] = [];
  recordSession(p: { roomId: string; liveTime: number }) {
    this.sessions.push(`${p.roomId}:${p.liveTime}`);
  }
  hasNotified(r: string, t: number) { return this.notified.has(`${r}:${t}`); }
  markNotified(r: string, t: number) { this.notified.add(`${r}:${t}`); }
  getStreamer(uid: string) { return this.streamers.get(uid); }
  listEnabledClauses(uid?: string) {
    return this.clauses.filter((c) => c.enabled && (uid === undefined || c.uid === uid));
  }
}

function clause(over: Partial<PreferenceClause> = {}): PreferenceClause {
  return {
    id: 1, uid: '1', scenes: [], minConfidence: null, titleKeywords: [],
    priority: 'normal', messageTemplate: '', targets: null,
    enabled: true, createdAt: 0, updatedAt: 0,
    ...over,
  };
}

class FakeDispatcher {
  sent: PushMessage[] = [];
  alerts: string[] = [];
  concurrentPeak = 0;
  private inFlight = 0;
  constructor(private readonly delayMs = 0) {}
  async broadcast(msg: PushMessage) {
    this.inFlight++;
    this.concurrentPeak = Math.max(this.concurrentPeak, this.inFlight);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    this.inFlight--;
    this.sent.push(msg);
    return { anySuccess: true, total: 1, succeeded: 1 };
  }
  async alertAll(title: string, body: string) { this.alerts.push(`${title}|${body}`); }
}

function config(over: Partial<AppConfig> = {}): AppConfig {
  return {
    notifyOnFirstRun: false, notifyOnNewSubscription: true,
    subscriptions: [],
    ...over,
  } as AppConfig;
}

function harness(over: Partial<AppConfig> = {}, dispatchDelayMs = 0) {
  const bus = new Bus();
  const db = new FakeDb();
  const disp = new FakeDispatcher(dispatchDelayMs);
  const pipeline = new Pipeline({
    bus,
    db: db as never,
    config: config(over),
    queue: new AnalysisQueue(new NoopAnalyzer()),
    rule: new OncePerSessionRule(db),
    dispatcher: disp as never,
  });
  pipeline.attach();
  return { bus, db, disp, pipeline };
}

// ---- 冷启动抑制（政策判断在 pipeline）----

test('first_run 且 notifyOnFirstRun=false：不通知，但 recordSession 照做', async () => {
  const h = harness();
  h.bus.emit(sig({ coldStart: 'first_run' }));
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 0);
  assert.deepEqual(h.db.sessions, ['r1:1785310737'], '抑制只跳通知，场次仍入库');
  assert.equal(h.db.notified.size, 0);
});

test('first_run 可配置为推送，消息为 PushMessage 且 markNotified', async () => {
  const h = harness({ notifyOnFirstRun: true });
  h.bus.emit(sig({ coldStart: 'first_run' }));
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1);
  const m = h.disp.sent[0]!;
  assert.equal(m.title, '🔴 阿梓 开播了');
  assert.equal(m.priority, 'normal');
  assert.equal(m.image, 'k.jpg');
  assert.equal(m.url, 'https://live.bilibili.com/r1');
  assert.deepEqual(m.ref, { roomId: 'r1', liveTime: 1_785_310_737 });
  assert.ok(h.db.notified.has('r1:1785310737'), '推送成功应 markNotified');
});

test('new_subscription 默认推送，配置可关闭', async () => {
  let h = harness();
  h.bus.emit(sig({ coldStart: 'new_subscription' }));
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1, '默认 notifyOnNewSubscription=true');

  h = harness({ notifyOnNewSubscription: false });
  h.bus.emit(sig({ coldStart: 'new_subscription' }));
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 0);
  assert.equal(h.db.sessions.length, 1, '抑制时 recordSession 仍照做');
});

test('同一场不重复推（OncePerSession + markNotified）', async () => {
  const h = harness({ notifyOnFirstRun: true });
  h.bus.emit(sig({ coldStart: 'first_run' }));
  await h.pipeline.whenIdle();
  h.bus.emit(sig());
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1);
});

test('live_end / title_change 不推送（M1 规则）', async () => {
  const h = harness();
  h.bus.emit(sig({ kind: 'live_end' }));
  h.bus.emit(sig({ kind: 'title_change', previousTitle: '旧标题' }));
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 0);
});

// ---- notify=false（旧 silent 语义）：追踪照常，推送抑制 ----

test('notify=false：抑制推送但 recordSession 照做', async () => {
  const h = harness();
  h.db.streamers.set('1', { alias: '阿梓', notify: false });
  h.bus.emit(sig());
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 0);
  assert.deepEqual(h.db.sessions, ['r1:1785310737'], 'notify=false 只跳推送，场次仍入库');
  assert.equal(h.db.notified.size, 0);
});

// ---- 偏好子句（matcher × L0 verdict）----

test('命中偏好子句：文案/优先级/目标按子句（L0 提供 verdict）', async () => {
  const h = harness();
  h.db.clauses.push(clause({
    id: 7, scenes: ['singing'], minConfidence: 0.5,
    priority: 'high', messageTemplate: '{alias}唱歌速来',
    targets: [{ type: 'group', id: '12345' }],
  }));
  h.bus.emit(sig({ status: status({ title: '今晚歌回！' }) }));
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1);
  const m = h.disp.sent[0]!;
  assert.equal(m.title, '阿梓唱歌速来');
  assert.equal(m.priority, 'high');
  assert.deepEqual(m.targets, [{ type: 'group', id: '12345' }]);
  assert.equal(m.url, 'https://live.bilibili.com/r1', '跳转字段沿用默认形状');
});

test('子句未命中（scene 不符）：走 M1 默认文案', async () => {
  const h = harness();
  h.db.clauses.push(clause({ scenes: ['gaming'], messageTemplate: '{alias}打游戏了' }));
  h.bus.emit(sig({ status: status({ title: '今晚歌回！' }) }));
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1);
  assert.equal(h.disp.sent[0]!.title, '🔴 阿梓 开播了');
  assert.equal(h.disp.sent[0]!.priority, 'normal');
});

test('标题无关键词（L0 也判不出）时 scenes 子句不命中，仍走默认', async () => {
  const h = harness();
  h.db.clauses.push(clause({ scenes: ['singing'], messageTemplate: '{alias}唱歌速来' }));
  h.bus.emit(sig({ status: status({ title: '孩子们下午好' }) }));
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1);
  assert.equal(h.disp.sent[0]!.title, '🔴 阿梓 开播了');
});

// ---- 健康告警 ----

test('health_alert 转 alertAll，文案带失败次数/订阅数/最后错误', async () => {
  const h = harness();
  h.bus.emit({
    source: 'bili/live-status', kind: 'health_alert', uid: '', roomId: '', ts: 0,
    payload: { failures: 5, subscriptions: 3, lastError: 'Error: boom' },
  });
  await h.pipeline.whenIdle();
  assert.equal(h.disp.alerts.length, 1);
  assert.match(h.disp.alerts[0]!, /连续 5 次拉取B站接口失败/);
  assert.match(h.disp.alerts[0]!, /全部 3 个订阅/);
  assert.match(h.disp.alerts[0]!, /最后错误: Error: boom/);
});

// ---- 并发上限（旧 NOTIFY_CONCURRENCY 语义）----

test('信号处理并发但上限 4', async () => {
  const h = harness({}, 20);
  for (let i = 0; i < 12; i++) {
    h.bus.emit(sig({
      uid: `u${i}`, roomId: `r${i}`,
      status: status({ uid: `u${i}`, roomId: `r${i}` }),
      coldStart: 'new_subscription',
    }));
  }
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 12);
  assert.ok(h.disp.concurrentPeak > 1, `应并发处理，实测峰值 ${h.disp.concurrentPeak}`);
  assert.ok(h.disp.concurrentPeak <= 4, `并发峰值应受限，实测 ${h.disp.concurrentPeak}`);
});
