import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline } from './pipeline.js';
import { Bus } from './bus.js';
import { AnalysisQueue } from '../analysis/queue.js';
import { OncePerSessionRule } from '../rules/once-per-session.js';
import { Db } from './db.js';
import { RulesClassifier } from '../analysis/classifier.js';
import { NotifyDispatcher } from '../notify/dispatcher.js';
import type { AnalysisContext, Classification, Classifier } from '../analysis/types.js';
import type { PushMessage, Signal } from './types.js';
import type { NewVerdict, PushChannel, PushRule } from './push.js';
import type { XAccount } from './x-accounts.js';
import type { WeiboAccount } from './weibo-accounts.js';
import type { BiliAccount } from './bili-accounts.js';
import type { PostCandidate } from '../analysis/matcher.js';
import type { PostTranslation } from '../analysis/post-analyzer.js';
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

/** 慢分类器：判定挂起直到手动放行（验证「推送等不等判定」的时序，A.4 规则级化） */
class SlowClassifier implements Classifier {
  readonly name = 'slow';
  calls: AnalysisContext[] = [];
  resolve!: (v: Classification[]) => void;
  constructor(private readonly result: Classification[] = []) {}
  classify(ctx: AnalysisContext): Promise<Classification[]> {
    this.calls.push(ctx);
    return new Promise((r) => { this.resolve = () => r(this.result); });
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
  listPushRules() { return this.rules; }
  audits = new Map<string, Record<string, unknown>>();
  recordContentAudit(kind: string, id: string, section: string, value: unknown) {
    const key = `${kind}:${id}`;
    this.audits.set(key, { ...this.audits.get(key), [section]: value });
  }
  getContentAudit(kind: string, id: string) { return this.audits.get(`${kind}:${id}`) ?? null; }
  getSetting(key: string) { return this.settings.get(key) ?? null; }

  // ---- X / 图文帖（pipeline 的 feed_post 分支：账号解析按平台分名单；规则统一在 push_rules）----
  xAccounts = new Map<string, XAccount>();
  weiboAccounts = new Map<string, WeiboAccount>();
  biliAccounts = new Map<string, BiliAccount>();
  getXAccountByScreenName(screenName: string) {
    return this.xAccounts.get(screenName);
  }
  getWeiboAccountByUid(uid: string) {
    return this.weiboAccounts.get(uid);
  }
  getBiliAccountByUid(uid: string) {
    return this.biliAccounts.get(uid);
  }

  // ---- verdicts：判定归档（现在由分类器落；pipeline 不再直写，保留桩面以防回归）----
  verdicts: NewVerdict[] = [];
  insertVerdict(v: NewVerdict) { this.verdicts.push(v); }
}

function rule(over: Partial<PushRule> = {}): PushRule {
  return {
    id: 1, name: '规则 1', subjectKind: 'live', categoryId: null, scope: [], channels: [1],
    messageTemplate: null, llmTranslate: false, enabled: true, createdBy: null,
    createdAt: 0, updatedAt: 0,
    ...over,
  };
}

/** 图文规则（subject_kind='post'；scope = 账号引用，空 = 全部账号） */
function postRule(over: Partial<PushRule> = {}): PushRule {
  return rule({ id: 10, name: '图文规则 1', subjectKind: 'post', ...over });
}

function classification(categoryId: number): Classification {
  return { categoryId, name: `分类 ${categoryId}`, source: 'rule', confidence: null, evidence: '' };
}

// ---- X / 图文帖 fixture ----

function xAccount(over: Partial<XAccount> = {}): XAccount {
  return {
    id: 1, screenName: 'watase_yuzuki', displayName: null, biliUid: null, enabled: true,
    silentNext: false,
    lastTweetId: null, lastTweetAt: null, lastOkAt: null, avatar: null, createdAt: 0, updatedAt: 0,
    ...over,
  } as XAccount;
}

function weiboAccount(over: Partial<WeiboAccount> = {}): WeiboAccount {
  return {
    id: 1, uid: '2203177060', nickname: '渡瀬結月', biliUid: null, enabled: true,
    silentNext: false,
    lastPostId: null, lastPostAt: null, lastOkAt: null, avatar: null, createdAt: 0, updatedAt: 0,
    ...over,
  } as WeiboAccount;
}

function biliAccount(over: Partial<BiliAccount> = {}): BiliAccount {
  return {
    id: 1, uid: '80397', uname: '阿梓从小就很可爱', displayName: null, enabled: true,
    silentNext: false, lastOkAt: null, avatar: null, createdAt: 0, updatedAt: 0,
    ...over,
  } as BiliAccount;
}

/** feed_post 信号（X 源产出）：无 status，载荷是推文快照 */
function feedSig(over: {
  payload?: Record<string, unknown>; uid?: string;
} = {}): Signal {
  return {
    source: 'twitter/feed', kind: 'feed_post', uid: over.uid ?? 'watase_yuzuki', roomId: '', ts: 0,
    payload: {
      platform: 'twitter', itemId: '9001', type: 'tweet', text: '今晚有直播',
      pics: [], pubTs: 1_789_549_200, url: 'https://x.com/watase_yuzuki/status/9001',
      ...(over.payload ?? {}),
    },
  };
}

/** 微博源的 feed_post：同一 kind，平台不同（uid = 微博 uid，归属不走 B站 uid） */
function weiboSig(over: {
  payload?: Record<string, unknown>; uid?: string;
} = {}): Signal {
  return {
    source: 'weibo/feed', kind: 'feed_post', uid: over.uid ?? '2203177060', roomId: '', ts: 0,
    payload: {
      platform: 'weibo', itemId: '5001', type: 'mblog', text: '今晚九点直播！',
      pics: [], pubTs: 1_789_549_200, url: 'https://weibo.com/2203177060/Pa1bC',
      ...(over.payload ?? {}),
    },
  };
}

/** B站动态源的 feed_post：同一 kind，uid 就是 B站 uid，type 已在 source 归一
 *  （DYNAMIC_TYPE_FORWARD → 'retweet'，其余保留 DYNAMIC_TYPE_*，见 sources/bili/dynamic.ts） */
function biliDynSig(over: {
  payload?: Record<string, unknown>; uid?: string;
} = {}): Signal {
  return {
    source: 'bili/dynamic', kind: 'feed_post', uid: over.uid ?? '80397', roomId: '', ts: 0,
    payload: {
      platform: 'bili_dynamic', itemId: 'd1', type: 'DYNAMIC_TYPE_WORD', text: '今晚八点直播！',
      pics: [], pubTs: 1_789_549_200, url: 'https://t.bilibili.com/d1',
      ...(over.payload ?? {}),
    },
  };
}

/** 装好 X 名单与图文规则的 harness（feed_post 分支专用；规则统一在 push_rules） */
function feedHarness(
  rules: PushRule[],
  accounts: XAccount[] = [xAccount()],
  analyzer?: FakeTranslator,
  weiboAccounts: WeiboAccount[] = [],
  classifications: Classification[] = [],
) {
  const h = harness({}, 0, classifications, analyzer);
  for (const a of accounts) h.db.xAccounts.set(a.screenName, a);
  for (const a of weiboAccounts) h.db.weiboAccounts.set(a.uid, a);
  h.db.rules = rules;
  return h;
}

/** 微博侧的 harness（默认名单里放一个微博账号） */
function weiboHarness(
  rules: PushRule[],
  accounts: WeiboAccount[] = [weiboAccount()],
  analyzer?: FakeTranslator,
  classifications: Classification[] = [],
) {
  return feedHarness(rules, [], analyzer, accounts, classifications);
}

/** B站动态侧的 harness（默认名单里放一个动态账号） */
function biliDynHarness(rules: PushRule[], accounts: BiliAccount[] = [biliAccount()]) {
  const h = feedHarness(rules, []);
  for (const a of accounts) h.db.biliAccounts.set(a.uid, a);
  return h;
}

/** 假翻译器：记录调用，按注入的策略给译文（判定已挪进分类判决链，这里只剩附加动作） */
class FakeTranslator {
  calls: Array<{ text: string | null }> = [];
  constructor(private readonly decide: (post: PostCandidate) => PostTranslation) {}
  async translate(post: PostCandidate): Promise<PostTranslation> {
    this.calls.push({ text: post.text });
    return this.decide(post);
  }
}

const translator = (translation: string | null) =>
  new FakeTranslator(() => ({ source: translation ? 'llm' : 'fallback', translation }));

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

function harness(
  over: Partial<AppConfig> = {},
  dispatchDelayMs = 0,
  classifications: Classification[] = [],
  postAnalyzer?: unknown,
) {
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
    ...(postAnalyzer ? { postAnalyzer: postAnalyzer as never } : {}),
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
  assert.equal(m.title, '主播1 开播了');
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

test('被抑制信号照样归档：冷启动 live_start 录场次，后续 title_change 照换段', async () => {
  const h = harness(); // notifyOnFirstRun=false
  h.bus.emit(sig({ coldStart: 'first_run' }));
  await h.pipeline.whenIdle();
  assert.deepEqual(h.db.sessions, ['r1:1785310737'], '冷启动抑制只跳推送，归档照做');
  h.bus.emit(sig({ kind: 'title_change', ts: 1_800_000_100, status: status({ title: '新标题' }) }));
  await h.pipeline.whenIdle();
  assert.equal(h.db.rotated.length, 1, 'title_change 归档换段');
  assert.equal(h.disp.sent.length, 0, '无命中规则不推送');
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
  h.db.rules.push(rule({ categoryId: null, scope: [], channels: [1, 2] }));
  h.bus.emit(sig());
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1);
  const m = h.disp.sent[0]!;
  assert.equal(m.title, '主播1 开播了', '规则无覆盖推送词 → 内置默认模板');
  assert.deepEqual(m.channels, ['1', '2'], '渠道 = 规则勾选的渠道');
});

test('规则未覆盖推送词时用内置默认模板', async () => {
  const h = harness();
  h.db.rules.push(rule({ categoryId: null }));
  h.bus.emit(sig({ status: status({ title: '今晚歌回！' }) }));
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent[0]!.title, '主播1 开播了');
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
  h.db.rules.push(rule({ categoryId: null, scope: ['别人'], channels: [2] }));
  h.bus.emit(sig());
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 0, '唯一规则不命中 = 不推');
});

test('命中分类规则：渠道与推送词按规则（categoryId 来自分类判定）', async () => {
  const h = harness({}, 0, [classification(7)]);
  h.db.rules.push(rule({
    id: 7, categoryId: 7, channels: [2], messageTemplate: '{liver}唱歌速来',
  }));
  h.bus.emit(sig({ status: status({ title: '今晚歌回！' }) }));
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1);
  const m = h.disp.sent[0]!;
  assert.equal(m.title, '主播1唱歌速来');
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
    rule({ id: 2, categoryId: 7, channels: [1, 3], messageTemplate: '{liver}唱歌速来' }),
    rule({ id: 3, categoryId: 9, channels: [3] }), // 分类不命中
  );
  h.bus.emit(sig());
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1);
  const m = h.disp.sent[0]!;
  assert.deepEqual(m.channels, ['2', '1', '3'], '命中规则 #1/#2 的渠道并集去重保序，未命中的 #3 不参与');
  assert.equal(m.title, '主播1唱歌速来', '推送词 = sort 序首个非空 messageTemplate（#1 未设，取 #2 的）');
});

test('「任意开播」规则与分类规则同时命中：渠道并集；分类不命中时任开播规则照常命中', async () => {
  const h = harness({}, 0, [classification(7)]);
  h.db.channels.push(
    { id: 2, name: '粉丝群', notifier: 'onebot', targetType: 'group', targetId: '111',
      enabled: true, createdAt: 0, updatedAt: 0 },
  );
  h.db.rules.push(
    rule({ id: 1, categoryId: null, channels: [1] }), // 任意开播，恒命中
    rule({ id: 2, categoryId: 7, channels: [2], messageTemplate: '{liver}唱歌速来' }),
  );
  h.bus.emit(sig());
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1);
  assert.deepEqual(h.disp.sent[0]!.channels, ['1', '2'], '任开播规则与分类规则同时命中，渠道并集');

  // 分类不命中时（无判定结果），任开播规则照常命中；推送词无覆盖回内置默认模板
  // 新一场直播（liveTime 变了）才能绕过 OncePerSession 去重
  const h2 = harness();
  h2.db.rules.push(rule({ id: 1, categoryId: null, channels: [1] }));
  h2.db.rules.push(rule({ id: 2, categoryId: 7, channels: [2], messageTemplate: '{liver}唱歌速来' }));
  h2.bus.emit(sig());
  await h2.pipeline.whenIdle();
  assert.equal(h2.disp.sent.length, 1);
  assert.deepEqual(h2.disp.sent[0]!.channels, ['1'], '只剩任开播规则命中');
  assert.equal(h2.disp.sent[0]!.title, '主播1 开播了', '规则无覆盖推送词 → 内置默认模板');
});

// ---- 推送等不等判定（A.4 规则级化，白名单行为变化）----
// 仅当存在「引用了分类的启用规则且 scope 覆盖本内容」时推送才等判定；
// 纯「任意内容」规则的推送不再排在 LLM 后面。判定本身照跑（verdicts/时间线面不变），不产生双推。

function slowHarness(rules: PushRule[], result: Classification[] = []) {
  const bus = new Bus();
  const db = new FakeDb();
  db.rules = rules;
  const disp = new FakeDispatcher();
  const cls = new SlowClassifier(result);
  const pipeline = new Pipeline({
    bus, db: db as never, config: config({}),
    queue: new AnalysisQueue(cls),
    rule: new OncePerSessionRule(db),
    dispatcher: disp as never,
  });
  pipeline.attach();
  return { bus, db, disp, cls, pipeline };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

test('纯「任意内容」规则：推送不排在 LLM 后面（判定照跑，只是不挡推送）', async () => {
  const h = slowHarness([rule({ categoryId: null, channels: [1] })]);
  h.bus.emit(sig());
  await tick();
  assert.equal(h.disp.sent.length, 1, '推送已发出，没等分类判定');
  assert.equal(h.cls.calls.length, 1, '判定照跑（verdicts/时间线的回看面不变）');
  h.cls.resolve([]);
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1, '判定回来也不产生双推');
});

test('30 场同时开播：分析挂起不挡任意内容推送、归档、下播与健康告警', async () => {
  const bus = new Bus();
  const db = new FakeDb();
  db.rules = [rule()];
  const disp = new FakeDispatcher();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const classifier: Classifier = { name: 'gate', classify: async () => { await gate; return []; } };
  const pipeline = new Pipeline({ bus, db: db as never, config: config(), queue: new AnalysisQueue(classifier),
    rule: new OncePerSessionRule(db), dispatcher: disp as never });
  pipeline.attach();
  try {
    for (let index = 1; index <= 30; index++) {
      bus.emit(sig({ uid: String(index), roomId: `r${index}`, status: status({ uid: String(index), roomId: `r${index}` }) }));
    }
    bus.emit(sig({ kind: 'live_end' }));
    bus.emit({ source: 'test', kind: 'health_alert', uid: '', roomId: '', ts: 1 });
    await tick();
    assert.equal(disp.sent.length, 30);
    assert.equal(db.sessions.length, 30);
    assert.equal(db.ended.length, 1);
    assert.equal(disp.alerts.length, 1);
    let idle = false;
    void pipeline.whenIdle().then(() => { idle = true; });
    await tick();
    assert.equal(idle, false, 'whenIdle 仍追踪在飞分析');
  } finally {
    release();
    await pipeline.whenIdle();
  }
});

test('分析异常不改写已经成功的推送结果', async () => {
  const bus = new Bus();
  const db = new FakeDb();
  db.rules = [rule()];
  const disp = new FakeDispatcher();
  const classifier: Classifier = { name: 'failure', classify: async () => { throw new Error('boom'); } };
  const pipeline = new Pipeline({ bus, db: db as never, config: config(), queue: new AnalysisQueue(classifier),
    rule: new OncePerSessionRule(db), dispatcher: disp as never });
  pipeline.attach();
  bus.emit(sig());
  await pipeline.whenIdle();
  const audit = db.getContentAudit('live', 'r1:1785310737')!;
  assert.equal((audit.push as { status: string }).status, 'sent');
  assert.equal((audit.analysis as { status: string }).status, 'failed');
});

test('同时收到同场开播信号不会绕过每场一次去重', async () => {
  const h = harness({}, 20);
  h.db.rules = [rule()];
  h.bus.emit(sig());
  h.bus.emit(sig());
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1);
});

test('图文审计区分分类判否与任意内容规则的实际推送', async () => {
  const h = feedHarness([postRule({ categoryId: 7 }), postRule({ id: 11 })]);
  h.bus.emit(feedSig());
  await h.pipeline.whenIdle();
  const audit = h.db.getContentAudit('post', 'twitter:9001')!.push as import('./content-audit.js').PushAudit;
  assert.equal(audit.status, 'sent');
  assert.equal(audit.rules[0]!.matched, false);
  assert.equal(audit.rules[1]!.matched, true);
});

test('真实图文链路归档模型失败、确定性负判、规则命中和部分发送失败', async (t) => {
  const db = new Db(':memory:');
  t.after(() => db.close());
  db.upsertXAccount({ screenName: 'watase_yuzuki' });
  const categoryId = db.upsertCategory({ name: '自拍', appliesTo: 'post', llmPrompt: '是自拍', keywords: ['自拍'] });
  const toastId = db.upsertPushChannel({ name: '本机', notifier: 'toast', enabled: true });
  const groupId = db.upsertPushChannel({ name: '测试群', notifier: 'onebot', targetType: 'group', targetId: '123', enabled: true });
  db.upsertPushRule({ name: '自拍规则', subjectKind: 'post', categoryId, channels: [groupId] });
  const anyId = db.upsertPushRule({ name: '任意帖', subjectKind: 'post', channels: [toastId, groupId] });
  const classifier = new RulesClassifier(db, () => ({ completeJson: async () => { throw new Error('模型网络超时'); } }) as never, () => true);
  const capabilities = { image: true, clickThrough: true };
  const dispatcher = new NotifyDispatcher([
    { name: 'toast', capabilities, send: async () => [{ ok: true }] },
    { name: 'onebot', capabilities, send: async () => [{ ok: false, target: 'group:123', error: 'NapCat ECONNREFUSED' }] },
  ], db);
  const bus = new Bus();
  const pipeline = new Pipeline({ bus, db, config: config(), queue: new AnalysisQueue(classifier),
    rule: new OncePerSessionRule(db), dispatcher });
  pipeline.attach();
  bus.emit(feedSig());
  await pipeline.whenIdle();
  db.upsertPushRule({ id: anyId, name: '修改后的规则' });
  const audit = db.getContentAudit('post', 'twitter:9001')!;
  assert.equal(audit.analysis!.results[0]!.pass, false);
  assert.match(audit.analysis!.fallbackReason!, /模型网络超时/);
  assert.equal(audit.push!.status, 'partial');
  assert.equal(audit.push!.rules[0]!.matched, false);
  assert.equal(audit.push!.rules[1]!.matched, true);
  assert.equal(audit.push!.rules[1]!.configuration!.name, '任意帖');
  assert.equal(audit.push!.deliveries![1]!.error, 'NapCat ECONNREFUSED');
});

test('覆盖本主播的分类规则：推送等判定结果再发（单次推送）', async () => {
  const h = slowHarness([rule({ categoryId: 7, channels: [1] })], [classification(7)]);
  h.bus.emit(sig());
  await tick();
  assert.equal(h.disp.sent.length, 0, '分类规则覆盖 → 推送等判定');
  h.cls.resolve([classification(7)]);
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1, '判定命中后推送');
});

test('图文侧同一条判据：任意内容规则不等判定；分类规则等判定', async () => {
  const anyRule = slowHarness([postRule({ id: 10, channels: [1] })]);
  anyRule.db.xAccounts.set('watase_yuzuki', xAccount());
  anyRule.bus.emit(feedSig());
  await tick();
  assert.equal(anyRule.disp.sent.length, 1, '任意内容规则不等判定');
  anyRule.cls.resolve([]);
  await anyRule.pipeline.whenIdle();

  const catRule = slowHarness([postRule({ id: 10, channels: [1], categoryId: 7 })], [classification(7)]);
  catRule.db.xAccounts.set('watase_yuzuki', xAccount());
  catRule.bus.emit(feedSig());
  await tick();
  assert.equal(catRule.disp.sent.length, 0, '分类规则等判定');
  catRule.cls.resolve([classification(7)]);
  await catRule.pipeline.whenIdle();
  assert.equal(catRule.disp.sent.length, 1);
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

// ---- feed_post 分支（X/推特图文帖）：与开播路径完全平行 ----

test('feed_post 命中图文规则 → 推送到规则渠道（筛选条件已上移进分类，规则本身不再内嵌 filters）', async () => {
  const h = feedHarness([postRule({ channels: [1] })]);
  h.bus.emit(feedSig());
  await h.pipeline.whenIdle();

  assert.equal(h.disp.sent.length, 1);
  const m = h.disp.sent[0]!;
  assert.equal(m.title, '@watase_yuzuki 发布新推文', '默认推送词');
  assert.equal(m.body, '今晚有直播');
  assert.equal(m.url, 'https://x.com/watase_yuzuki/status/9001');
  assert.match(m.attribution ?? '', /^\d{2}\/\d{2} \d{2}:\d{2}$/, '副行只留发布时间');
  assert.deepEqual(m.channels, ['1'], '按规则渠道路由');
  assert.equal(m.image, undefined, '未配图片缓存目录时不带图');
  assert.equal(h.db.notified.size, 0, '帖子没有场次概念，不该 markNotified');
});

test('分类规则只在判定命中时生效：判否 = 引用它的规则不命中（「只推原创」等筛选已上移进分类）', async () => {
  // 分类规则 + 判定命中 → 推
  const catRule = postRule({ categoryId: 7, channels: [1] });
  const hit = feedHarness([catRule], [xAccount()], undefined, [], [classification(7)]);
  hit.bus.emit(feedSig());
  await hit.pipeline.whenIdle();
  assert.equal(hit.disp.sent.length, 1, '判定命中分类 → 引用它的规则生效');

  // 同一条规则 + 判定未命中 → 不推
  const miss = feedHarness([catRule], [xAccount()], undefined, [], []);
  miss.bus.emit(feedSig());
  await miss.pipeline.whenIdle();
  assert.equal(miss.disp.sent.length, 0, '判定未命中 → 分类规则不生效');
});

test('规则按账号生效（scope）：空 = 全部账号；非空 = 只对列出的账号引用生效', async () => {
  const scoped = postRule({ id: 2, scope: ['twitter:d4dj_pj'] });
  const h = feedHarness(
    [scoped],
    [xAccount({ id: 1, screenName: 'watase_yuzuki' }), xAccount({ id: 2, screenName: 'd4dj_pj' })],
  );
  h.bus.emit(feedSig({ uid: 'watase_yuzuki' }));
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 0, 'scope 不含该账号 = 不生效');

  h.bus.emit(feedSig({ uid: 'd4dj_pj' }));
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1, 'scope 含该账号 = 生效');

  // 空 scope = 全部账号（D1：空即全部生效）
  const all = feedHarness([postRule({ scope: [] })]);
  all.bus.emit(feedSig());
  await all.pipeline.whenIdle();
  assert.equal(all.disp.sent.length, 1, '空 scope = 全部账号生效');
});

test('无命中规则 / 规则未勾渠道 / 账号不在名单 / 平台不匹配 → 都不推且不炸', async () => {
  // 无规则
  const h1 = feedHarness([]);
  h1.bus.emit(feedSig());
  await h1.pipeline.whenIdle();
  assert.equal(h1.disp.sent.length, 0);

  // 规则存在但没勾渠道
  const h2 = feedHarness([postRule({ channels: [] })]);
  h2.bus.emit(feedSig());
  await h2.pipeline.whenIdle();
  assert.equal(h2.disp.sent.length, 0);

  // 账号不在名单（源与名单不同步时不该炸，也不该推）
  const h3 = feedHarness([postRule()], []);
  h3.bus.emit(feedSig());
  await h3.pipeline.whenIdle();
  assert.equal(h3.disp.sent.length, 0);

  // 微博源的 feed_post：账号不在微博名单里 → 不推（规则平台无关后，挡住它的是名单而不是规则平台）
  const h4 = feedHarness([postRule()]);
  h4.bus.emit(weiboSig());
  await h4.pipeline.whenIdle();
  assert.equal(h4.disp.sent.length, 0, '账号不在微博名单 = 不推');

  // 未知平台：忽略
  const h5 = feedHarness([postRule()]);
  h5.bus.emit(feedSig({ payload: { platform: 'douyin' } }));
  await h5.pipeline.whenIdle();
  assert.equal(h5.disp.sent.length, 0);
});

// ---- feed_post 分支（微博）：与 X 同一条路径，账号/文案按平台分支 ----

test('微博 feed_post 命中微博规则 → 推送；标题用昵称、副行只留时间', async () => {
  const h = weiboHarness([postRule({ channels: [1] })]);
  h.bus.emit(weiboSig());
  await h.pipeline.whenIdle();

  assert.equal(h.disp.sent.length, 1);
  const m = h.disp.sent[0]!;
  assert.equal(m.title, '渡瀬結月 发布新微博', '默认推送词按平台走');
  assert.equal(m.body, '今晚九点直播！');
  assert.match(m.attribution ?? '', /^\d{2}\/\d{2} \d{2}:\d{2}$/, '作者已进标题，副行只留时间');
  assert.deepEqual(m.channels, ['1']);
  assert.equal(h.db.notified.size, 0, '帖子没有场次概念，不该 markNotified');
});

test('规则平台无关：同一条规则被 X 与微博账号同时选用，两平台帖都推', async () => {
  const rules = [postRule({ id: 1, channels: [1] })];
  const h = feedHarness(rules, [xAccount({ ruleIds: [1] })], undefined, [weiboAccount({ ruleIds: [1] })]);
  h.bus.emit(feedSig());
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1, 'X 帖命中');
  assert.equal(h.disp.sent[0]!.title, '@watase_yuzuki 发布新推文');

  h.bus.emit(weiboSig());
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 2, '微博帖命中同一条规则');
  assert.equal(h.disp.sent[1]!.title, '渡瀬結月 发布新微博', '文案措辞按帖子平台走');
});

test('微博规则按账号生效（scope）：账号引用决定生效范围', async () => {
  const rules = [postRule({ id: 2, channels: [1], scope: ['weibo:111'] })];
  const h = weiboHarness(rules, [
    weiboAccount({ id: 1, uid: '2203177060' }),
    weiboAccount({ id: 2, uid: '111' }),
  ]);
  h.bus.emit(weiboSig());
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 0, 'scope 不含账号 1');

  h.bus.emit(weiboSig({ uid: '111' }));
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1, 'scope 含账号 2');
});

test('微博帖的推送词模板：{author} 渲染成昵称（不是 uid）', async () => {
  const h = weiboHarness([postRule({ messageTemplate: '{author}｜{text}' })]);
  h.bus.emit(weiboSig());
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent[0]!.title, '渡瀬結月｜今晚九点直播！');

  // 昵称还没抓到（新账号）→ 回退 uid，至少不是空标题
  const h2 = weiboHarness([postRule({ messageTemplate: '{author}' })],
    [weiboAccount({ nickname: null })]);
  h2.bus.emit(weiboSig());
  await h2.pipeline.whenIdle();
  assert.equal(h2.disp.sent[0]!.title, '2203177060');
});

test('微博帖走同一条分类判定：判否拦下（判定平台无关；翻译运行时只对 X 帖生效）', async () => {
  const h = weiboHarness(
    [postRule({ categoryId: 7, channels: [1] })],
    [weiboAccount()],
    undefined,
    [], // 分类判定判否
  );
  h.bus.emit(weiboSig());
  await h.pipeline.whenIdle();
  assert.equal(h.classifier.calls.length, 1, '确实做过一次分类判定');
  assert.equal(h.disp.sent.length, 0, '判否 → 引用分类的规则不命中，不推');
});

test('推送总开关关闭 → feed_post 也不推（与开播同一条总闸）', async () => {
  const h = feedHarness([postRule()]);
  h.db.settings.set('push_enabled', '0');
  h.bus.emit(feedSig());
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 0);
});

test('推送词模板：{author} {text} {url} 渲染；纯图帖正文给占位', async () => {
  const h = feedHarness([postRule({ messageTemplate: '{author}｜{text}｜{url}' })]);
  h.bus.emit(feedSig());
  await h.pipeline.whenIdle();
  assert.equal(
    h.disp.sent[0]!.title,
    '@watase_yuzuki｜今晚有直播｜https://x.com/watase_yuzuki/status/9001',
  );

  const h2 = feedHarness([postRule()]);
  h2.bus.emit(feedSig({ payload: { text: null, pics: ['https://pbs.twimg.com/media/a.jpg'] } }));
  await h2.pipeline.whenIdle();
  assert.equal(h2.disp.sent[0]!.body, '（仅图片，无正文）', '空正文别让 QQ 里出现空消息');
  assert.match(h2.disp.sent[0]!.title, /@watase_yuzuki/, '作者标注已收进标题行');
  assert.equal(h2.disp.sent[0]!.images, undefined, '未配图片缓存目录时图不下、按无图发');
});

test('多条命中规则：渠道取并集、推送词取首个非空（与开播规则同一套语义）', async () => {
  const h = feedHarness([
    postRule({ id: 1, sort: 0, channels: [1], messageTemplate: null }),
    postRule({ id: 2, sort: 1, channels: [2], messageTemplate: '{author} 更新了' }),
  ]);
  h.db.channels.push({
    id: 2, name: '粉丝群', notifier: 'onebot', targetType: 'group', targetId: '10001',
    enabled: true, createdAt: 0, updatedAt: 0,
  });
  h.bus.emit(feedSig());
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1);
  assert.deepEqual(h.disp.sent[0]!.channels, ['1', '2'], '渠道并集去重保序');
  assert.equal(h.disp.sent[0]!.title, '@watase_yuzuki 更新了', '首个非空模板生效');
});

// ---- 图文帖的分类判定 / 翻译（判定分类制 + 翻译独立，A.4）----

test('分类判定拦下 → 引用分类的规则不推；判定通过 → 照推', async () => {
  const deny = feedHarness([postRule({ categoryId: 7 })], [xAccount()], undefined, [], []);
  deny.bus.emit(feedSig());
  await deny.pipeline.whenIdle();
  assert.equal(deny.disp.sent.length, 0, '判否不推');
  assert.equal(deny.classifier.calls.length, 1, '确实做过一次分类判定');

  const allow = feedHarness([postRule({ categoryId: 7 })], [xAccount()], undefined, [], [classification(7)]);
  allow.bus.emit(feedSig());
  await allow.pipeline.whenIdle();
  assert.equal(allow.disp.sent.length, 1);
});

test('翻译失败不挡推送（生成类任务的任何抖动都不该让推文消失）', async () => {
  const fallback = new FakeTranslator(() => ({ source: 'fallback', translation: null }));
  const h = feedHarness([postRule({ llmTranslate: true })], [xAccount()], fallback);
  h.bus.emit(feedSig());
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1, '翻译失败照推');
  assert.equal(h.disp.sent[0]!.body, '今晚有直播', '不附译文');
});

test('未装配翻译器时 llm_translate 一律当关（老装配/测试桩不会因此丢推文）', async () => {
  const h = feedHarness([postRule({ llmTranslate: true })]);
  h.bus.emit(feedSig());
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1);
});

test('翻译：命中规则任一开 llm_translate 且是 X 帖 → 调一次生成，正文下方带【译】', async () => {
  const tr = translator('今晚有直播');
  const h = feedHarness([postRule({ llmTranslate: true })], [xAccount()], tr);
  h.bus.emit(feedSig());
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent[0]!.body, '今晚有直播\n\n【译】今晚有直播');
  assert.equal(tr.calls.length, 1);
});

test('翻译运行时门控：非 X 帖不请求翻译（微博/B站本就中文）', async () => {
  const tr = translator('译文不该出现');
  const h = weiboHarness([postRule({ llmTranslate: true })], [weiboAccount()], tr);
  h.bus.emit(weiboSig());
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1, '照推');
  assert.equal(h.disp.sent[0]!.body, '今晚九点直播！');
  assert.equal(tr.calls.length, 0, '非 X 帖根本不请求翻译');
});

test('多条命中：一条引用分类被判定拦下、另一条任意内容 → 仍推，且渠道只来自没被拦的那条', async () => {
  const h = feedHarness([
    postRule({ id: 1, sort: 0, channels: [1], categoryId: 7 }),
    postRule({ id: 2, sort: 1, channels: [2] }),
  ], [xAccount()], undefined, [], []); // 判否
  h.db.channels.push({
    id: 2, name: '粉丝群', notifier: 'onebot', targetType: 'group', targetId: '10001',
    enabled: true, createdAt: 0, updatedAt: 0,
  });
  h.bus.emit(feedSig());
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 1, '任意内容规则照常生效');
  assert.deepEqual(h.disp.sent[0]!.channels, ['2'], '被判定拦下的规则不贡献渠道');
});

test('多条规则都开翻译也只问模型一次（命中规则聚合后调一次生成）', async () => {
  const tr = translator('译文');
  const h = feedHarness([
    postRule({ id: 1, sort: 0, channels: [1], llmTranslate: true }),
    postRule({ id: 2, name: '图文帖规则 2', sort: 1, channels: [1], llmTranslate: true }),
  ], [xAccount()], tr);
  h.bus.emit(feedSig());
  await h.pipeline.whenIdle();
  assert.equal(tr.calls.length, 1, '聚合后只调一次（省额度与延迟）');
  assert.equal(h.disp.sent.length, 1);
  assert.deepEqual(h.disp.sent[0]!.channels, ['1']);
});

test('分类判定每帖单次（verdicts 由分类器落；按帖单次判定，不产生双推）', async () => {
  const h = feedHarness([
    postRule({ id: 1, sort: 0, channels: [1], categoryId: 7 }),
    postRule({ id: 2, sort: 1, channels: [1], categoryId: 8 }),
  ], [xAccount()], undefined, [], [classification(7), classification(8)]);
  h.bus.emit(feedSig());
  await h.pipeline.whenIdle();
  assert.equal(h.classifier.calls.length, 1, '两条规则共用一次判定');
  assert.equal(h.disp.sent.length, 1, '单次推送，不双推');
  assert.equal(h.classifier.calls[0]!.post?.post.screenName, 'watase_yuzuki', '判定入口带帖子投影');
});

// 判定归档（verdicts）随 P2「判定分类制」移进分类器（RulesClassifier）：
// 真实 categoryId、ruleId=0 哨兵、post 侧 LLM 判否也落 pass=0——行为用例见
// src/analysis/classify.test.ts（post 判定归档段）。pipeline 只负责按需触发判定。

// ---- feed_post 分支（B站动态）：与 X/微博同一条路径，账号是 bili_accounts ----

test('B站动态 feed_post 命中规则 → 推送；文案「发布新动态」、副行只留时间', async () => {
  const h = biliDynHarness([postRule({ channels: [1] })]);
  h.bus.emit(biliDynSig());
  await h.pipeline.whenIdle();

  assert.equal(h.disp.sent.length, 1);
  const m = h.disp.sent[0]!;
  assert.equal(m.title, '阿梓从小就很可爱 发布新动态', '默认推送词按平台走（展示名 = uname）');
  assert.equal(m.body, '今晚八点直播！');
  assert.match(m.attribution ?? '', /^\d{2}\/\d{2} \d{2}:\d{2}$/, '副行只留发布时间');
  assert.deepEqual(m.channels, ['1']);
  assert.equal(h.db.notified.size, 0, '帖子没有场次概念，不该 markNotified');
});

test('B站动态：转发帖的筛选由分类条件承担（判定 → 引用分类的规则只在命中时生效）', async () => {
  const catRule = postRule({ categoryId: 7 });
  // 判定未命中（转发帖被「只推原创」分类筛掉）→ 不推
  const h1 = feedHarness([catRule], [], undefined, [], []);
  h1.db.biliAccounts.set('80397', biliAccount());
  h1.bus.emit(biliDynSig({ payload: { type: 'retweet' } }));
  await h1.pipeline.whenIdle();
  assert.equal(h1.disp.sent.length, 0, '判否 = 不推');

  // 判定命中 → 推
  const h2 = feedHarness([catRule], [], undefined, [], [classification(7)]);
  h2.db.biliAccounts.set('80397', biliAccount());
  h2.bus.emit(biliDynSig({ payload: { type: 'retweet' } }));
  await h2.pipeline.whenIdle();
  assert.equal(h2.disp.sent.length, 1, '命中才推');
});

test('B站动态：不在 bili_accounts 名单的 uid 静默丢弃（防御分支——源只对名单账号发信号）', async () => {
  const h = biliDynHarness([postRule()], []);
  h.bus.emit(biliDynSig({ uid: '99999' }));
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 0);
});

test('B站动态：{liver} 直接按 uid 反查 streamers（动态账号本身就是 B站 uid）', async () => {
  const h = biliDynHarness(
    [postRule({ messageTemplate: '{liver} 发动态了' })],
    [biliAccount({ uid: '1', uname: '主播1' })],
  );
  h.bus.emit(biliDynSig({ uid: '1' }));
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent[0]!.title, '阿梓 发动态了', 'streamers 里 uid=1 的简称是阿梓');
});

test('B站动态：规则 scope 用 `bili:uid` 账号引用（不勾 = 全部生效，勾了才限定）', async () => {
  const h = biliDynHarness(
    [postRule({ channels: [1], scope: ['bili:99999'] })],
    [biliAccount()],
  );
  h.bus.emit(biliDynSig());
  await h.pipeline.whenIdle();
  assert.equal(h.disp.sent.length, 0, 'scope 不含该账号 = 不推');
});
