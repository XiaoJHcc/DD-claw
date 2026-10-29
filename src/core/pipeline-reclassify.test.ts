import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from './db.js';
import { Bus } from './bus.js';
import { Pipeline } from './pipeline.js';
import { RulesClassifier } from '../analysis/classifier.js';
import { AnalysisQueue } from '../analysis/queue.js';
import { OncePerSessionRule } from '../rules/once-per-session.js';
import { saveRuntimeConfig } from './runtime-config.js';
import type { AnalysisContext, Classification, Classifier } from '../analysis/types.js';
import type { PushMessage, Signal } from './types.js';
import type { AppConfig } from '../config/schema.js';
import type { RoomStatus } from '../sources/bili/types.js';

const LIVE_TIME = 1_785_310_737;
const SUBJECT = `r1:${LIVE_TIME}`;

function status(over: Partial<RoomStatus> = {}): RoomStatus {
  return {
    uid: '1', roomId: 'r1', uname: '主播1', title: '今晚歌回！',
    isLive: true, rawLiveStatus: 1, liveTime: LIVE_TIME,
    areaName: '虚拟Singer', parentAreaName: '虚拟主播', cover: '', keyframe: 'k.jpg',
    ...over,
  };
}

function sig(over: Partial<Signal> & { statusOver?: Partial<RoomStatus> } = {}): Signal {
  const { statusOver, ...rest } = over;
  return {
    source: 'bili/live-status', kind: 'live_start', uid: '1', roomId: 'r1',
    ts: Math.floor(Date.now() / 1000), status: status(statusOver), ...rest,
  };
}

/** 内部分类信号（analysis/triggers 产出）：delayed = startDelay / periodic / titleDelay */
function reclassify(trigger: 'startDelay' | 'periodic' | 'titleDelay', statusOver: Partial<RoomStatus> = {}): Signal {
  return {
    source: 'analysis/triggers', kind: 'live_reclassify', uid: '1', roomId: 'r1',
    ts: Math.floor(Date.now() / 1000), status: status(statusOver), payload: { trigger },
  };
}

class FakeDispatcher {
  sent: PushMessage[] = [];
  async broadcast(msg: PushMessage) {
    this.sent.push(msg);
    return { anySuccess: true, total: 1, succeeded: 1 };
  }
  async alertAll() { /* 本文件不测告警 */ }
}

const config = { notifyOnFirstRun: false, notifyOnNewSubscription: true, subscriptions: [] } as unknown as AppConfig;

function memDb(t: import('node:test').TestContext): Db {
  const db = new Db(':memory:');
  t.after(() => db.close());
  return db;
}

/** 真实 Db + 真实分类器（无 LLM provider → 判定只由确定性条件定案） */
function harness(t: import('node:test').TestContext, db = memDb(t)) {
  const bus = new Bus();
  const dispatcher = new FakeDispatcher();
  const classifier = new RulesClassifier(db, { getRouter: () => null, llmEnabled: () => false });
  const pipeline = new Pipeline({
    bus, db, config, queue: new AnalysisQueue(classifier),
    rule: new OncePerSessionRule(db), dispatcher: dispatcher as never,
  });
  pipeline.attach();
  return { db, bus, dispatcher, pipeline };
}

/** 桩分类器编排（测「分类失败 ≠ 变成空」这类分类器本身不提供的形态） */
function stubHarness(t: import('node:test').TestContext, classify: () => Promise<Classification[]>) {
  const db = memDb(t);
  const bus = new Bus();
  const dispatcher = new FakeDispatcher();
  const classifier: Classifier = { name: 'stub', classify: () => classify() };
  const pipeline = new Pipeline({
    bus, db, config, queue: new AnalysisQueue(classifier),
    rule: new OncePerSessionRule(db), dispatcher: dispatcher as never,
  });
  pipeline.attach();
  return { db, bus, dispatcher, pipeline };
}

/** 歌回 / 游戏 两个关键词分类 + 各自一条渠道与规则 */
function seedRules(db: Db) {
  db.upsertStreamer({ uid: '1', uname: '主播1' });
  const song = db.upsertCategory({ name: '歌回', keywords: ['歌'] });
  const game = db.upsertCategory({ name: '游戏', keywords: ['游戏'] });
  const songChannel = db.upsertPushChannel({ name: '歌回群', notifier: 'onebot', targetType: 'group', targetId: '1', enabled: true });
  const gameChannel = db.upsertPushChannel({ name: '游戏群', notifier: 'onebot', targetType: 'group', targetId: '2', enabled: true });
  db.upsertPushRule({ name: '歌回规则', categoryId: song, channels: [songChannel] });
  db.upsertPushRule({ name: '游戏规则', categoryId: game, channels: [gameChannel] });
  return { song, game, songChannel, gameChannel };
}

// ---- 五个时机：各自读自己的三档开关 ----

test('时机选择：开播默认只走规则+决策（LLM 不进），标题变更同样判一次', async (t) => {
  const db = memDb(t);
  seedRules(db);
  const calls: AnalysisContext[] = [];
  const bus = new Bus();
  const classifier: Classifier = {
    name: 'spy',
    classify: async (ctx) => { calls.push(ctx); return []; },
  };
  const pipeline = new Pipeline({
    bus, db, config, queue: new AnalysisQueue(classifier),
    rule: new OncePerSessionRule(db), dispatcher: new FakeDispatcher() as never,
  });
  pipeline.attach();
  bus.emit(sig());
  await pipeline.whenIdle();
  bus.emit(sig({ kind: 'title_change', statusOver: { title: '打游戏' } }));
  await pipeline.whenIdle();

  assert.equal(calls.length, 2, '开播与标题变更各判定一次');
  assert.deepEqual(calls[0]!.judge, { rule: true, decision: true, llm: false }, '开播：规则+决策');
  assert.deepEqual(calls[1]!.judge, { rule: true, decision: true, llm: false }, '变更：规则+决策');

  bus.emit(reclassify('startDelay'));
  await pipeline.whenIdle();
  assert.deepEqual(calls[2]!.judge, { rule: true, decision: true, llm: true }, '延迟后：三档全开');

  bus.emit(reclassify('periodic'));
  await pipeline.whenIdle();
  assert.equal(calls.length, 3, '定时时机默认三档全关 = 该时机不判定');

  bus.emit(reclassify('titleDelay'));
  await pipeline.whenIdle();
  assert.deepEqual(calls[3]!.judge, { rule: true, decision: true, llm: true }, '变更延迟后：三档全开');
});

test('时机选择可配：periodic 只有 LLM 档时判定就带着这个口径跑', async (t) => {
  const db = memDb(t);
  seedRules(db);
  saveRuntimeConfig(db, { liveClassifyPeriodicLlm: true });
  const calls: AnalysisContext[] = [];
  const bus = new Bus();
  const classifier: Classifier = { name: 'spy', classify: async (ctx) => { calls.push(ctx); return []; } };
  const pipeline = new Pipeline({
    bus, db, config, queue: new AnalysisQueue(classifier),
    rule: new OncePerSessionRule(db), dispatcher: new FakeDispatcher() as never,
  });
  pipeline.attach();
  bus.emit(sig());
  await pipeline.whenIdle();
  bus.emit(reclassify('periodic'));
  await pipeline.whenIdle();
  assert.deepEqual(calls[1]!.judge, { rule: false, decision: false, llm: true });
});

// ---- 重推语义：只有分类集合真的改变才重推 ----

test('分类变更重推：集合变了推所有当前命中规则，不变不推，开播初判不重推', async (t) => {
  const { db, bus, dispatcher, pipeline } = harness(t);
  seedRules(db);

  bus.emit(sig()); // 开播：{歌回} → 歌回群
  await pipeline.whenIdle();
  assert.equal(dispatcher.sent.length, 1);
  assert.deepEqual(dispatcher.sent[0]!.channels, ['1'], '开播按分类规则推到歌回群');

  // 改标题但仍是歌回：集合没变 → 不重推
  bus.emit(sig({ kind: 'title_change', statusOver: { title: '歌回继续' } }));
  await pipeline.whenIdle();
  assert.equal(dispatcher.sent.length, 1, '分类集合未变不重推');

  // 换内容打游戏：{歌回} → {游戏} → 重推到游戏群
  bus.emit(sig({ kind: 'title_change', statusOver: { title: '来打游戏' } }));
  await pipeline.whenIdle();
  assert.equal(dispatcher.sent.length, 2, '集合变了重推');
  assert.deepEqual(dispatcher.sent[1]!.channels, ['2'], '推到当前命中的规则渠道');

  // 延迟时机同理（同一场次，不需要新的 liveTime）
  bus.emit(reclassify('startDelay', { title: '还是打游戏' }));
  await pipeline.whenIdle();
  assert.equal(dispatcher.sent.length, 2, '延迟时机集合没变也不重推');

  bus.emit(reclassify('periodic', { title: '唱歌了' }));
  await pipeline.whenIdle();
  assert.equal(dispatcher.sent.length, 2, '定时时机默认不判定，自然不重推');
});

test('重推不经过 OncePerSession：同一场多次分类变化每次都推', async (t) => {
  const { db, bus, dispatcher, pipeline } = harness(t);
  seedRules(db);
  bus.emit(sig());
  await pipeline.whenIdle();
  assert.equal(dispatcher.sent.length, 1);
  assert.equal(db.hasNotified('r1', LIVE_TIME), true, '开播初判照常写每场一次的水位');

  bus.emit(sig({ kind: 'title_change', statusOver: { title: '来打游戏' } }));
  await pipeline.whenIdle();
  bus.emit(sig({ kind: 'title_change', statusOver: { title: '唱歌' } }));
  await pipeline.whenIdle();
  assert.equal(dispatcher.sent.length, 3, '每场通知水位不挡重推');
  assert.deepEqual(dispatcher.sent[2]!.channels, ['1'], '回到歌回分类 → 歌回群');
});

test('分类失败不当作「变成空」：不重推，也不改写当前判定', async (t) => {
  let fail = false;
  const stubResult: Classification[] = [{
    categoryId: 7, name: '歌回', source: 'rule', confidence: null, evidence: '关键词',
    pass: true, effective: true,
  }];
  const { db, bus, dispatcher, pipeline } = stubHarness(t, async () => {
    if (fail) throw new Error('分类炸了');
    return stubResult;
  });
  db.upsertCategory({ name: '歌回', keywords: ['歌'] });
  const channel = db.upsertPushChannel({ name: '歌回群', notifier: 'onebot', targetType: 'group', targetId: '1', enabled: true });
  db.upsertPushRule({ name: '歌回规则', categoryId: 7, channels: [channel] });

  bus.emit(sig());
  await pipeline.whenIdle();
  assert.equal(dispatcher.sent.length, 1);

  fail = true;
  bus.emit(sig({ kind: 'title_change', statusOver: { title: '打游戏' } }));
  await pipeline.whenIdle();
  assert.equal(dispatcher.sent.length, 1, '分类失败不重推');
  const audit = db.getContentAudit('live', SUBJECT)!.push!;
  assert.equal(audit.status, 'skipped');
  assert.equal(audit.reason, '分类失败，本轮不重推');
});

// ---- 抑制只挡推送：判定与历史照做 ----

test('推送总开关关闭：判定与历史照做，只是不发送', async (t) => {
  const { db, bus, dispatcher, pipeline } = harness(t);
  seedRules(db);
  db.setSetting('push_enabled', '0');

  bus.emit(sig());
  await pipeline.whenIdle();
  assert.equal(dispatcher.sent.length, 0);
  assert.equal(db.listVerdicts('live', SUBJECT).filter((v) => v.effective && v.pass).length, 1, '开播判定照常入库');
  const runs = db.listLiveClassificationRuns('r1', LIVE_TIME);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.triggerKind, 'start');

  bus.emit(sig({ kind: 'title_change', statusOver: { title: '打游戏' } }));
  await pipeline.whenIdle();
  assert.equal(dispatcher.sent.length, 0, '重分时机也照旧不发送');
  assert.deepEqual(db.listLiveClassificationRuns('r1', LIVE_TIME).map((r) => r.triggerKind), ['start', 'titleChange']);
  assert.deepEqual(
    db.listVerdicts('live', SUBJECT).filter((v) => v.effective && v.pass).map((v) => v.categoryName), ['游戏'],
    '当前判定跟最新一轮走',
  );
});

test('冷启动抑制：只挡开播推送，判定与历史照做', async (t) => {
  const { db, bus, dispatcher, pipeline } = harness(t);
  seedRules(db);
  bus.emit(sig({ coldStart: 'first_run' }));
  await pipeline.whenIdle();
  assert.equal(dispatcher.sent.length, 0, '首次运行已在播不推');
  assert.equal(db.listVerdicts('live', SUBJECT).filter((v) => v.effective && v.pass).length, 1, '分类照跑');
  assert.equal(db.listLiveClassificationRuns('r1', LIVE_TIME).length, 1, '历史照记');
});

// ---- 多次判定的归档：当前 verdicts 被替换、历史追加 ----

test('多次判定：当前 verdicts/primary 被最新一轮替换，历史按轮次追加', async (t) => {
  const { db, bus, pipeline } = harness(t);
  const { song, game } = seedRules(db);
  db.upsertCategory({ id: song, name: '歌回', keywords: ['歌'], primary: true });

  bus.emit(sig());
  await pipeline.whenIdle();
  bus.emit(sig({ kind: 'title_change', statusOver: { title: '来打游戏' } }));
  await pipeline.whenIdle();

  const verdicts = db.listVerdicts('live', SUBJECT).filter((v) => v.effective && v.pass);
  assert.deepEqual(verdicts.map((v) => v.categoryId), [game], '当前判定 = 最新一轮（不留第一次）');
  const primaries = db.listPrimaryVerdicts('live', SUBJECT).filter((p) => p.effective);
  assert.equal(primaries.length, 1, '主分类同样被替换，至多一条生效');

  const runs = db.listLiveClassificationRuns('r1', LIVE_TIME);
  assert.deepEqual(runs.map((r) => r.triggerKind), ['start', 'titleChange']);
  assert.deepEqual(runs[0]!.verdicts.map((v) => v.categoryName), ['歌回'], '历史保留第一轮');
  assert.deepEqual(runs[1]!.verdicts.map((v) => v.categoryName), ['游戏']);
  assert.equal(runs[0]!.primary?.categoryName, '歌回');
  assert.deepEqual(runs[1]!.primary, { categoryId: 0, categoryName: '其他', source: 'rule' },
    '游戏不是主分类 → 历史如实记「其他」（前端不外显）');
});

test('分类为空也留一轮历史（表示从该时刻起未分类），且通常无命中规则不推', async (t) => {
  const { db, bus, dispatcher, pipeline } = harness(t);
  seedRules(db);
  bus.emit(sig({ statusOver: { title: '随便聊聊' } })); // 两个分类都不命中
  await pipeline.whenIdle();
  const runs = db.listLiveClassificationRuns('r1', LIVE_TIME);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0]!.verdicts, [], '空结果同样入历史');
  assert.equal(dispatcher.sent.length, 0, '没有分类 = 没有分类规则命中 = 不推');
});

// ---- 时间轴：分类历史随场次返回 ----

test('listTimeline：每场带 classificationRuns（按 ts 升序）并保留 verdicts/primary', async (t) => {
  const { db, bus, pipeline } = harness(t);
  seedRules(db);
  bus.emit(sig());
  await pipeline.whenIdle();
  bus.emit(sig({ kind: 'title_change', statusOver: { title: '来打游戏' } }));
  await pipeline.whenIdle();

  const now = Math.floor(Date.now() / 1000);
  const entries = db.listTimeline(now - 3600, now + 3600);
  assert.equal(entries.length, 1);
  const e = entries[0]!;
  assert.deepEqual(e.classificationRuns.map((r) => r.triggerKind), ['start', 'titleChange']);
  assert.ok(e.classificationRuns[0]!.ts <= e.classificationRuns[1]!.ts, 'ts 升序');
  assert.deepEqual(e.verdicts.map((v) => v.categoryName), ['游戏'], '最新一轮仍走旧字段');
  const older = db.listTimeline(now + 7200, now + 10_800);
  assert.deepEqual(older, [], '窗口外不返回');
});

test('旧场次没有历史时 classificationRuns 为空（前端回退 verdicts/primary）', async (t) => {
  const db = memDb(t);
  db.recordSession({
    roomId: 'r9', liveTime: 123, uid: '9', uname: '旧主播',
    title: '旧场', areaName: 'A', parentAreaName: 'B',
  });
  const now = Math.floor(Date.now() / 1000);
  const entries = db.listTimeline(now - 60, now + 60);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0]!.classificationRuns, []);
});

test('同场两个分类时机同时到：按真正的前一轮判断，不重复重推', async (t) => {
  const { db, bus, dispatcher, pipeline } = harness(t);
  seedRules(db);
  bus.emit(sig());
  await pipeline.whenIdle();
  assert.equal(dispatcher.sent.length, 1);

  // 同一 tick 内两个时机信号：第二个看到的前一轮必须是第一个判定后的结果
  bus.emit(sig({ kind: 'title_change', statusOver: { title: '来打游戏' } }));
  bus.emit(sig({ kind: 'title_change', statusOver: { title: '来打游戏' } }));
  await pipeline.whenIdle();
  assert.equal(dispatcher.sent.length, 2, '同一次分类变化只重推一次');
  assert.deepEqual(dispatcher.sent[1]!.channels, ['2']);
});

// ---- 只有 LLM 档且冷却中：整轮跳过（不写判定、不记历史、不重推）----

/** 带 LLM router 的 harness：分类只由 LLM 定案（rule / decision 档由调用方关掉） */
function llmHarness(t: import('node:test').TestContext, calls: string[]) {
  const db = memDb(t);
  db.upsertStreamer({ uid: '1', uname: '主播1' });
  const song = db.upsertCategory({ name: '歌回', llmPrompt: '在唱歌', keywords: ['歌'] });
  const channel = db.upsertPushChannel({ name: '歌回群', notifier: 'onebot', targetType: 'group', targetId: '1', enabled: true });
  db.upsertPushRule({ name: '歌回规则', categoryId: song, channels: [channel] });
  const router = {
    completeJson: async (req: unknown, parse?: (raw: unknown) => unknown) => {
      calls.push('llm');
      const text = JSON.stringify(req);
      const match = text.includes('打游戏') ? null : song;
      return parse!({ results: match === null ? [] : [{ id: match, match: true, evidence: '在唱' }] });
    },
  };
  const bus = new Bus();
  const dispatcher = new FakeDispatcher();
  const classifier = new RulesClassifier(db, {
    getRouter: () => router as never, llmEnabled: () => true, llmCooldownMin: () => 5,
  });
  const pipeline = new Pipeline({
    bus, db, config, queue: new AnalysisQueue(classifier),
    rule: new OncePerSessionRule(db), dispatcher: dispatcher as never,
  });
  pipeline.attach();
  // 只启用 LLM 档的重分时机（变更时 + 变更延迟后）；开播初判保持默认，不掺和冷却
  saveRuntimeConfig(db, {
    liveClassifyTitleChangeRule: false, liveClassifyTitleChangeDecision: false, liveClassifyTitleChangeLlm: true,
  });
  return { db, bus, dispatcher, pipeline, song };
}

test('只有 LLM 档且冷却中：重分整轮跳过——当前结论与历史不变、不推、审计记为跳过而非失败', async (t) => {
  const calls: string[] = [];
  const { db, bus, dispatcher, pipeline, song } = llmHarness(t, calls);

  // 开播初判（默认规则+决策）：确定性关键词定案 → 一条统计
  bus.emit(sig());
  await pipeline.whenIdle();
  assert.equal(dispatcher.sent.length, 1, '开播按分类规则推送一次');
  const runsAfterStart = db.listLiveClassificationRuns('r1', LIVE_TIME).length;
  assert.equal(runsAfterStart, 1, '开播留一条历史');
  const verdictsAfterStart = db.listVerdicts('live', SUBJECT)
    .filter((v) => v.effective).map((v) => [v.categoryId, v.source, v.pass]);
  assert.deepEqual(verdictsAfterStart, [[song, 'rule', true]]);

  // 第一次重分：只有 LLM 档，真的问了一次 → 分类不变（还是歌回），不重推
  bus.emit(sig({ kind: 'title_change', statusOver: { title: '继续唱歌' } }));
  await pipeline.whenIdle();
  assert.equal(calls.length, 1, '第一次重分真的问了 LLM（起了冷却）');
  assert.equal(dispatcher.sent.length, 1, '分类不变不重推');
  const beforeSkip = db.listVerdicts('live', SUBJECT)
    .filter((v) => v.effective).map((v) => [v.categoryId, v.source, v.pass]);

  // 冷却中的第二次重分：整轮跳过
  bus.emit(sig({ kind: 'title_change', statusOver: { title: '来打游戏' } }));
  await pipeline.whenIdle();
  assert.equal(calls.length, 1, '冷却中不再调 LLM');
  assert.equal(db.listLiveClassificationRuns('r1', LIVE_TIME).length, runsAfterStart + 1,
    '只有第一次重分追加了历史；跳过的那轮不写历史');
  assert.deepEqual(
    db.listVerdicts('live', SUBJECT).filter((v) => v.effective).map((v) => [v.categoryId, v.source, v.pass]),
    beforeSkip,
    '当前结论原样保留（没有被替换为空）',
  );
  assert.equal(dispatcher.sent.length, 1, '跳过的那轮不重推');
  const audit = db.getContentAudit('live', SUBJECT)!;
  assert.equal(audit.push!.status, 'skipped');
  assert.match(audit.push!.reason, /LLM 冷却中/);
  assert.equal(audit.analysis!.status, 'skipped', '审计记未执行，不是 failed、也不停在 pending');
});

test('只有 LLM 档且冷却中：开播延迟时机的跳过同样不动结论与历史', async (t) => {
  const calls: string[] = [];
  const { db, bus, dispatcher, pipeline } = llmHarness(t, calls);
  saveRuntimeConfig(db, {
    liveClassifyStartDelayRule: false, liveClassifyStartDelayDecision: false, liveClassifyStartDelayLlm: true,
  });
  bus.emit(sig());
  await pipeline.whenIdle();
  const runsBefore = db.listLiveClassificationRuns('r1', LIVE_TIME).length;

  // 开播初判默认不含 LLM，所以此时没有冷却：第一轮延迟真的问一次
  bus.emit(reclassify('startDelay', { title: '继续唱歌' }));
  await pipeline.whenIdle();
  assert.equal(calls.length, 1);
  // 第二次延迟（同场、同 roomId）在冷却中 → 整轮跳过
  bus.emit(reclassify('startDelay', { title: '继续唱歌' }));
  await pipeline.whenIdle();
  assert.equal(calls.length, 1);
  assert.equal(db.listLiveClassificationRuns('r1', LIVE_TIME).length, runsBefore + 1);
  assert.equal(db.getContentAudit('live', SUBJECT)!.analysis!.status, 'skipped');
  assert.equal(dispatcher.sent.length, 1, '两条都不重推（分类集合没变）');
});
