import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline } from './pipeline.js';
import { Bus } from './bus.js';
import { AnalysisQueue } from '../analysis/queue.js';
import { NoopAnalyzer } from '../analysis/noop.js';
import { OncePerSessionRule } from '../rules/once-per-session.js';
import type { PushMessage, Signal } from './types.js';
import type { PushChannel, PushRule } from './push.js';
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
  rules: PushRule[] = [];
  channels: PushChannel[] = [
    { id: 1, name: '系统通知', notifier: 'toast', targetType: null, targetId: null,
      enabled: true, createdAt: 0, updatedAt: 0 },
  ];
  settings = new Map<string, string>();
  recordSession(p: { roomId: string; liveTime: number }) {
    this.sessions.push(`${p.roomId}:${p.liveTime}`);
  }
  hasNotified(r: string, t: number) { return this.notified.has(`${r}:${t}`); }
  markNotified(r: string, t: number) { this.notified.add(`${r}:${t}`); }
  getStreamer(uid: string) { return this.streamers.get(uid); }
  listEnabledPushRules(uid: string) {
    return this.rules.filter((r) => r.enabled && r.uid === uid).sort((a, b) => a.id - b.id);
  }
  listPushChannels() { return this.channels; }
  getSetting(key: string) { return this.settings.get(key) ?? null; }
}

function rule(over: Partial<PushRule> = {}): PushRule {
  return {
    id: 1, uid: '1', keywords: [], areas: [], channels: [1],
    messageTemplate: null, enabled: true, createdAt: 0, updatedAt: 0,
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
  assert.equal(m.title, '阿梓 开播了');
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

test('restart_recovery 默认不推送（与 first_run 共用 notifyOnFirstRun），可配置为推送', async () => {
  let h = harness();
  h.bus.emit(sig({ coldStart: 'restart_recovery' }));
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 0, '默认不推停机期间开播');
  assert.equal(h.db.sessions.length, 1, '抑制只跳通知，场次仍入库');
  assert.equal(h.db.notified.size, 0);

  h = harness({ notifyOnFirstRun: true });
  h.bus.emit(sig({ coldStart: 'restart_recovery' }));
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1, 'notifyOnFirstRun=true 时也推送');
});

test('推送总开关（settings.push_enabled=0）：全局不推，追踪照常', async () => {
  const h = harness();
  h.db.settings.set('push_enabled', '0');
  h.bus.emit(sig());
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 0, '总开关关 = 不推');
  assert.equal(h.db.sessions.length, 1, 'recordSession 照做');
  assert.equal(h.db.notified.size, 0);
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

// ---- 推送规则（matcher × push_rules / push_channels）----

test('主播无规则且未设全局默认：兜底全部启用渠道 + 内置默认模板', async () => {
  const h = harness();
  h.db.channels.push(
    { id: 2, name: '粉丝群', notifier: 'onebot', targetType: 'group', targetId: '111',
      enabled: true, createdAt: 0, updatedAt: 0 },
    { id: 3, name: '停用的', notifier: 'onebot', targetType: 'group', targetId: '222',
      enabled: false, createdAt: 0, updatedAt: 0 },
  );
  h.bus.emit(sig());
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1);
  const m = h.disp.sent[0]!;
  assert.equal(m.title, '阿梓 开播了', '内置默认模板渲染');
  assert.deepEqual(m.channels, ['1', '2'], '未设全局默认 = 全部启用渠道（停用不算）');
});

test('无规则且没有任何启用渠道：不推', async () => {
  const h = harness();
  h.db.channels = [];
  h.bus.emit(sig());
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 0);
});

test('全局默认渠道（settings.default_channels）设置后按其推送', async () => {
  const h = harness();
  h.db.channels.push(
    { id: 2, name: '粉丝群', notifier: 'onebot', targetType: 'group', targetId: '111',
      enabled: true, createdAt: 0, updatedAt: 0 },
  );
  h.db.settings.set('default_channels', '[2]');
  h.bus.emit(sig());
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1);
  assert.deepEqual(h.disp.sent[0]!.channels, ['2'], '全局默认只推勾选的渠道');
});

test('全局默认显式空数组 = 默认不推', async () => {
  const h = harness();
  h.db.settings.set('default_channels', '[]');
  h.bus.emit(sig());
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 0);
  assert.equal(h.db.notified.size, 0, '未推成功不得 markNotified');
});

test('命中条件规则：渠道与推送词按规则', async () => {
  const h = harness();
  h.db.rules.push(rule({
    id: 7, keywords: ['歌'], channels: [2], messageTemplate: '{alias}唱歌速来',
  }));
  h.bus.emit(sig({ status: status({ title: '今晚歌回！' }) }));
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1);
  const m = h.disp.sent[0]!;
  assert.equal(m.title, '阿梓唱歌速来');
  assert.deepEqual(m.channels, ['2'], '渠道 = 命中规则的 channels');
  assert.equal(m.url, 'https://live.bilibili.com/r1', '跳转字段沿用默认形状');
});

test('规则未覆盖推送词时用全局默认模板（settings.default_template）', async () => {
  const h = harness();
  h.db.settings.set('default_template', '{alias} 开播：{title}');
  h.db.rules.push(rule({ keywords: ['歌'] }));
  h.bus.emit(sig({ status: status({ title: '今晚歌回！' }) }));
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent[0]!.title, '阿梓 开播：今晚歌回！');
});

test('条件规则不命中 → 全局默认（渠道与模板都按全局设置）', async () => {
  const h = harness();
  h.db.channels.push(
    { id: 2, name: 'QQ私聊', notifier: 'onebot', targetType: 'private', targetId: '111',
      enabled: true, createdAt: 0, updatedAt: 0 },
  );
  h.db.settings.set('default_channels', '[2]');
  h.db.settings.set('default_template', '{alias} 来了');
  h.db.rules.push(rule({ keywords: ['歌'], channels: [1] }));
  h.bus.emit(sig({ status: status({ title: '打游戏' }) }));
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1);
  const m = h.disp.sent[0]!;
  assert.deepEqual(m.channels, ['2'], '条件规则不命中落全局默认渠道');
  assert.equal(m.title, '阿梓 来了', '模板也走全局默认');
});

test('条件规则不命中且全局默认显式空：不推', async () => {
  const h = harness();
  h.db.settings.set('default_channels', '[]');
  h.db.rules.push(rule({ keywords: ['歌'] }));
  h.bus.emit(sig({ status: status({ title: '打游戏' }) }));
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 0);
});

test('命中规则但渠道并集为空 = 用户明确不推', async () => {
  const h = harness();
  h.db.rules.push(rule({ keywords: ['歌'], channels: [] }));
  h.bus.emit(sig({ status: status({ title: '今晚歌回！' }) }));
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 0);
  assert.equal(h.db.notified.size, 0, '未推成功不得 markNotified');
});

test('多条规则命中：渠道取并集去重（保持顺序），推送词取 sort 序首个非空', async () => {
  const h = harness();
  h.db.channels.push(
    { id: 2, name: '粉丝群', notifier: 'onebot', targetType: 'group', targetId: '111',
      enabled: true, createdAt: 0, updatedAt: 0 },
    { id: 3, name: '亲友群', notifier: 'onebot', targetType: 'group', targetId: '333',
      enabled: true, createdAt: 0, updatedAt: 0 },
  );
  h.db.rules.push(
    rule({ id: 1, keywords: ['歌'], channels: [2, 1] }),
    rule({ id: 2, keywords: ['歌'], channels: [1, 3], messageTemplate: '{alias}唱歌速来' }),
    rule({ id: 3, keywords: ['不命中'], channels: [3] }),
  );
  h.bus.emit(sig({ status: status({ title: '今晚歌回！' }) }));
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1);
  const m = h.disp.sent[0]!;
  assert.deepEqual(m.channels, ['2', '1', '3'], '命中规则 #1/#2 的渠道并集去重保序，未命中的 #3 不参与');
  assert.equal(m.title, '阿梓唱歌速来', '推送词 = sort 序首个非空 messageTemplate（#1 未设，取 #2 的）');
});

test('空条件规则与其他规则同等命中：渠道并入并集，不再单独兜底', async () => {
  const h = harness();
  h.db.channels.push(
    { id: 2, name: '粉丝群', notifier: 'onebot', targetType: 'group', targetId: '111',
      enabled: true, createdAt: 0, updatedAt: 0 },
  );
  h.db.rules.push(
    rule({ id: 1, keywords: [], areas: [], channels: [1] }), // 空条件规则，恒命中
    rule({ id: 2, keywords: ['歌'], channels: [2], messageTemplate: '{alias}唱歌速来' }),
  );
  h.bus.emit(sig({ status: status({ title: '今晚歌回！' }) }));
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1);
  assert.deepEqual(h.disp.sent[0]!.channels, ['1', '2'], '空条件规则与条件规则同时命中，渠道并集');

  // 条件规则不命中时，空条件规则照常命中（仍是规则路径，不走全局默认渠道/模板）
  // 新一场直播（liveTime 变了）才能绕过 OncePerSession 去重
  h.db.settings.set('default_channels', '[]');
  h.db.settings.set('default_template', '{alias} 默认模板');
  h.bus.emit(sig({ status: status({ title: '打游戏', liveTime: 1_785_320_000 }) }));
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 2);
  assert.deepEqual(h.disp.sent[1]!.channels, ['1'], '只剩空条件规则命中，不走全局默认渠道');
  assert.equal(h.disp.sent[1]!.title, '阿梓 默认模板', '规则路径模板：规则无覆盖时回全局默认模板');
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
