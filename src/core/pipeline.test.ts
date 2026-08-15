import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline } from './pipeline.js';
import { Bus } from './bus.js';
import { AnalysisQueue } from '../analysis/queue.js';
import { OncePerSessionRule } from '../rules/once-per-session.js';
import type { AnalysisContext, Classification, Classifier } from '../analysis/types.js';
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

/** 桩分类器：返回固定判定结果，记录调用次数（验证 live_end 不做分类） */
class StubClassifier implements Classifier {
  readonly name = 'stub';
  calls: AnalysisContext[] = [];
  constructor(public result: Classification[] = []) {}
  async classify(ctx: AnalysisContext): Promise<Classification[]> {
    this.calls.push(ctx);
    return this.result;
  }
}

class FakeDb {
  sessions: string[] = [];
  ended: Array<{ roomId: string; ts: number }> = [];
  rotated: Array<{ roomId: string; liveTime: number; ts: number; title: string }> = [];
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
  endSession(roomId: string, ts: number) { this.ended.push({ roomId, ts }); }
  rotateSegment(roomId: string, liveTime: number, ts: number, seg: { title: string }) {
    this.rotated.push({ roomId, liveTime, ts, title: seg.title });
  }
  hasNotified(r: string, t: number) { return this.notified.has(`${r}:${t}`); }
  markNotified(r: string, t: number) { this.notified.add(`${r}:${t}`); }
  getStreamer(uid: string) { return this.streamers.get(uid); }
  listEnabledPushRules() {
    return this.rules.filter((r) => r.enabled).sort((a, b) => a.id - b.id);
  }
  listPushChannels() { return this.channels; }
  getSetting(key: string) { return this.settings.get(key) ?? null; }
}

function rule(over: Partial<PushRule> = {}): PushRule {
  return {
    id: 1, name: '规则 1', categoryId: null, uids: [], channels: [1],
    messageTemplate: null, enabled: true, createdAt: 0, updatedAt: 0,
    ...over,
  };
}

function classification(categoryId: number): Classification {
  return { categoryId, name: `分类 ${categoryId}`, source: 'rule', confidence: null, evidence: '' };
}

class FakeDispatcher {
  sent: PushMessage[] = [];
  alerts: string[] = [];
  alertQqTargets: Array<string | null> = [];
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
  async alertAll(title: string, body: string, qqTarget?: string) {
    this.alerts.push(`${title}|${body}`);
    this.alertQqTargets.push(qqTarget ?? null);
  }
}

function config(over: Partial<AppConfig> = {}): AppConfig {
  return {
    notifyOnFirstRun: false, notifyOnNewSubscription: true,
    subscriptions: [],
    ...over,
  } as AppConfig;
}

function harness(over: Partial<AppConfig> = {}, dispatchDelayMs = 0, classifications: Classification[] = []) {
  const bus = new Bus();
  const db = new FakeDb();
  // 冷启动推送开关的事实来源是 settings（面板推送渠道卡「推送设置」）；
  // 兼容旧测试写法：config override 里的两个开关翻译成 settings 键
  if (over.notifyOnFirstRun !== undefined) {
    db.settings.set('notify_on_first_run', over.notifyOnFirstRun ? '1' : '0');
  }
  if (over.notifyOnNewSubscription !== undefined) {
    db.settings.set('notify_on_new_subscription', over.notifyOnNewSubscription ? '1' : '0');
  }
  const disp = new FakeDispatcher(dispatchDelayMs);
  const classifier = new StubClassifier(classifications);
  const pipeline = new Pipeline({
    bus,
    db: db as never,
    config: config(over),
    queue: new AnalysisQueue(classifier),
    rule: new OncePerSessionRule(db),
    dispatcher: disp as never,
  });
  pipeline.attach();
  return { bus, db, disp, pipeline, classifier };
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
  h.db.rules.push(rule()); // 任开播×全部主播兜底规则（无命中 = 不推）
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
  h.db.rules.push(rule());
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
  h.db.rules.push(rule());
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
  h.db.rules.push(rule());
  h.bus.emit(sig({ coldStart: 'first_run' }));
  await h.pipeline.whenIdle();
  h.bus.emit(sig());
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1);
});

test('live_start 做分类判定，live_end / title_change 不调分类器（不烧 LLM）', async () => {
  const h = harness();
  h.db.rules.push(rule());
  h.bus.emit(sig());
  h.bus.emit(sig({ kind: 'live_end' }));
  h.bus.emit(sig({ kind: 'title_change', previousTitle: '旧标题' }));
  await h.pipeline.whenIdle();
  assert.equal(h.classifier.calls.length, 1, '只有 live_start 进分类队列');
  assert.equal(h.disp.sent.length, 1, 'M1 规则只推开播');
});

// ---- 归档分派（live_end / title_change 在抑制检查之前落库）----

test('live_end 归档：endSession 按房间 + 信号 ts 关闭场次（不推送）', async () => {
  const h = harness();
  h.bus.emit(sig({ kind: 'live_end', ts: 1_800_000_000 }));
  await h.pipeline.whenIdle();
  assert.deepEqual(h.db.ended, [{ roomId: 'r1', ts: 1_800_000_000 }]);
  assert.equal(h.disp.sent.length, 0);
});

test('title_change 归档：rotateSegment 换段（不推送、不重复分类）', async () => {
  const h = harness();
  h.bus.emit(sig({ kind: 'title_change', ts: 1_800_000_100, status: status({ title: '换内容唱歌' }) }));
  await h.pipeline.whenIdle();
  assert.deepEqual(h.db.rotated, [
    { roomId: 'r1', liveTime: 1_785_310_737, ts: 1_800_000_100, title: '换内容唱歌' },
  ]);
  assert.equal(h.disp.sent.length, 0);
});

test('被抑制信号照样归档：冷启动 live_start 录场次，notify=false 的 title_change 照换段', async () => {
  const h = harness(); // notifyOnFirstRun=false
  h.bus.emit(sig({ coldStart: 'first_run' }));
  await h.pipeline.whenIdle();
  assert.deepEqual(h.db.sessions, ['r1:1785310737'], '冷启动抑制只跳推送，归档照做');
  h.db.streamers.set('1', { alias: '阿梓', notify: false });
  h.bus.emit(sig({ kind: 'title_change', ts: 1_800_000_100, status: status({ title: '新标题' }) }));
  await h.pipeline.whenIdle();
  assert.equal(h.db.rotated.length, 1, 'notify=false 抑制推送但归档照做');
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

// ---- 推送规则 v2（分类引用 × 生效主播 × push_channels）----

test('无规则 = 不推送（全局默认推送已删除，兜底靠「任意开播 × 全部主播」规则）', async () => {
  const h = harness();
  h.bus.emit(sig());
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 0, '无命中规则 = 不推');
  assert.equal(h.db.notified.size, 0, '未推成功不得 markNotified');
});

test('「任意开播 × 全部主播」规则 = 旧全局默认的等价物：兜底推送 + 内置默认模板', async () => {
  const h = harness();
  h.db.channels.push(
    { id: 2, name: '粉丝群', notifier: 'onebot', targetType: 'group', targetId: '111',
      enabled: true, createdAt: 0, updatedAt: 0 },
    { id: 3, name: '停用的', notifier: 'onebot', targetType: 'group', targetId: '222',
      enabled: false, createdAt: 0, updatedAt: 0 },
  );
  h.db.rules.push(rule({ categoryId: null, uids: [], channels: [1, 2] }));
  h.bus.emit(sig());
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1);
  const m = h.disp.sent[0]!;
  assert.equal(m.title, '阿梓 开播了', '规则无覆盖推送词 → 内置默认模板');
  assert.deepEqual(m.channels, ['1', '2'], '渠道 = 规则勾选的渠道');
});

test('规则未覆盖推送词时用内置默认模板', async () => {
  const h = harness();
  h.db.rules.push(rule({ categoryId: null }));
  h.bus.emit(sig({ status: status({ title: '今晚歌回！' }) }));
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent[0]!.title, '阿梓 开播了');
});

test('分类规则不命中（无其他规则）= 不推', async () => {
  const h = harness();
  h.db.rules.push(rule({ categoryId: 9, channels: [1] })); // 分类 9 不在判定结果里
  h.bus.emit(sig({ status: status({ title: '打游戏' }) }));
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 0);
  assert.equal(h.db.notified.size, 0, '未推成功不得 markNotified');
});

test('生效主播集合限定：uid 不在名单内的规则不命中（无其他规则 = 不推）', async () => {
  const h = harness();
  h.db.rules.push(rule({ categoryId: null, uids: ['别人'], channels: [2] }));
  h.bus.emit(sig());
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 0, '唯一规则不命中 = 不推');
});

test('命中分类规则：渠道与推送词按规则（categoryId 来自分类判定）', async () => {
  const h = harness({}, 0, [classification(7)]);
  h.db.rules.push(rule({
    id: 7, categoryId: 7, channels: [2], messageTemplate: '{alias}唱歌速来',
  }));
  h.bus.emit(sig({ status: status({ title: '今晚歌回！' }) }));
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1);
  const m = h.disp.sent[0]!;
  assert.equal(m.title, '阿梓唱歌速来');
  assert.deepEqual(m.channels, ['2'], '渠道 = 命中规则的 channels');
  assert.equal(m.url, 'https://live.bilibili.com/r1', '跳转字段沿用默认形状');
});

test('命中规则但渠道并集为空 = 用户明确不推', async () => {
  const h = harness();
  h.db.rules.push(rule({ categoryId: null, channels: [] }));
  h.bus.emit(sig());
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 0);
  assert.equal(h.db.notified.size, 0, '未推成功不得 markNotified');
});

test('多条规则命中：渠道取并集去重（保持顺序），推送词取 sort 序首个非空', async () => {
  const h = harness({}, 0, [classification(7)]);
  h.db.channels.push(
    { id: 2, name: '粉丝群', notifier: 'onebot', targetType: 'group', targetId: '111',
      enabled: true, createdAt: 0, updatedAt: 0 },
    { id: 3, name: '亲友群', notifier: 'onebot', targetType: 'group', targetId: '333',
      enabled: true, createdAt: 0, updatedAt: 0 },
  );
  h.db.rules.push(
    rule({ id: 1, categoryId: null, channels: [2, 1] }), // 任意开播
    rule({ id: 2, categoryId: 7, channels: [1, 3], messageTemplate: '{alias}唱歌速来' }),
    rule({ id: 3, categoryId: 9, channels: [3] }), // 分类不命中
  );
  h.bus.emit(sig());
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1);
  const m = h.disp.sent[0]!;
  assert.deepEqual(m.channels, ['2', '1', '3'], '命中规则 #1/#2 的渠道并集去重保序，未命中的 #3 不参与');
  assert.equal(m.title, '阿梓唱歌速来', '推送词 = sort 序首个非空 messageTemplate（#1 未设，取 #2 的）');
});

test('「任意开播」规则与分类规则同时命中：渠道并集；分类不命中时任开播规则照常命中', async () => {
  const h = harness({}, 0, [classification(7)]);
  h.db.channels.push(
    { id: 2, name: '粉丝群', notifier: 'onebot', targetType: 'group', targetId: '111',
      enabled: true, createdAt: 0, updatedAt: 0 },
  );
  h.db.rules.push(
    rule({ id: 1, categoryId: null, channels: [1] }), // 任意开播，恒命中
    rule({ id: 2, categoryId: 7, channels: [2], messageTemplate: '{alias}唱歌速来' }),
  );
  h.bus.emit(sig());
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1);
  assert.deepEqual(h.disp.sent[0]!.channels, ['1', '2'], '任开播规则与分类规则同时命中，渠道并集');

  // 分类不命中时（无判定结果），任开播规则照常命中；推送词无覆盖回内置默认模板
  // 新一场直播（liveTime 变了）才能绕过 OncePerSession 去重
  const h2 = harness();
  h2.db.rules.push(rule({ id: 1, categoryId: null, channels: [1] }));
  h2.db.rules.push(rule({ id: 2, categoryId: 7, channels: [2], messageTemplate: '{alias}唱歌速来' }));
  h2.bus.emit(sig());
  await h2.pipeline.whenIdle();
  assert.equal(h2.disp.sent.length, 1);
  assert.deepEqual(h2.disp.sent[0]!.channels, ['1'], '只剩任开播规则命中');
  assert.equal(h2.disp.sent[0]!.title, '阿梓 开播了', '规则无覆盖推送词 → 内置默认模板');
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
  assert.equal(h.disp.alertQqTargets[0], null, '次数阈值告警不发 QQ');
});

test('health_alert 的 QQ 路由：login_drop 与 durationAlert 报告警 QQ，留空则不报', async () => {
  const h = harness();
  h.db.settings.set('napcat_alert_qq', '12345');
  const emit = (payload: Record<string, unknown>) => h.bus.emit({
    source: 'bili/follows', kind: 'health_alert', uid: '', roomId: '', ts: 0, payload,
  });

  emit({ alertKind: 'login_drop', message: 'cookie 失效' });
  await h.pipeline.whenIdle();
  assert.equal(h.disp.alertQqTargets.at(-1), '12345', '登录掉线立即报告警 QQ');

  emit({ alertKind: 'streak', durationAlert: true, message: '持续失败' });
  await h.pipeline.whenIdle();
  assert.equal(h.disp.alertQqTargets.at(-1), '12345', '持续失败二次告警报告警 QQ');

  emit({ message: '看门狗告警' });
  await h.pipeline.whenIdle();
  assert.equal(h.disp.alertQqTargets.at(-1), null, '无标记的告警只发本机');

  h.db.settings.delete('napcat_alert_qq');
  emit({ alertKind: 'login_drop', message: 'cookie 失效' });
  await h.pipeline.whenIdle();
  assert.equal(h.disp.alerts.length, 4, '本机 toast 照发');
  assert.equal(h.disp.alertQqTargets.at(-1), null, '告警 QQ 留空 = 不报');
});

// ---- 并发上限（旧 NOTIFY_CONCURRENCY 语义）----

test('信号处理并发但上限 4', async () => {
  const h = harness({}, 20);
  h.db.rules.push(rule()); // 任开播×全部主播兜底规则
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
  assert.ok(h.disp.concurrentPeak <= 4, `并发峰值应受限，实测峰值 ${h.disp.concurrentPeak}`);
});
