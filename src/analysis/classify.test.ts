import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../core/db.js';
import { toLiveEvent, type LiveStatus, type Signal } from '../core/types.js';
import type { NewCategory } from '../core/push.js';
import { RulesClassifier, runJudgeChain, deterministicJudge, llmJudge } from './classifier.js';
import { fromLiveEvent } from './content.js';
import {
  buildClassifyRequest, parseClassifyResults, toClassifyCategory, MIN_CONFIDENCE,
  type ClassifyCategory,
} from './tasks/classify.js';
import type { LlmRequest, LlmRouter } from './providers.js';
import type { AnalysisContext } from './types.js';

// ---- 公共构造 ----

function status(over: Partial<LiveStatus> = {}): LiveStatus {
  return {
    uid: '1', roomId: 'r1', uname: '主播1', title: '今晚歌回！',
    isLive: true, liveTime: 1_785_310_737,
    areaName: '虚拟Singer', parentAreaName: '虚拟主播', cover: '', keyframe: 'k.jpg',
    ...over,
  };
}

function ctx(kind: Signal['kind'] = 'live_start', over: Partial<LiveStatus> = {}): AnalysisContext {
  return {
    event: toLiveEvent(status(over), '阿梓'),
    signal: { source: 'bili/live-status', kind, uid: '1', roomId: 'r1', ts: 0, status: status(over) },
  };
}

const CATS: ClassifyCategory[] = [
  { id: 1, name: '歌回', prompt: '在以唱歌为主' },
  { id: 2, name: '游戏', prompt: '在打游戏' },
];

function memDb(t: import('node:test').TestContext): Db {
  const db = new Db(':memory:');
  t.after(() => db.close());
  return db;
}

function category(over: Partial<NewCategory> = {}): NewCategory {
  return {
    name: '', llmPrompt: null, keywords: [], areas: [],
    postTypes: [], requireQuote: false, requireMedia: false, appliesTo: 'live',
    condMode: 'and', enabled: true,
    ...over,
  };
}

type CompleteJson = (req: LlmRequest, parse?: (raw: unknown) => unknown) => Promise<unknown>;

/** 假 router：实现只给 completeJson，按 LlmRouter 形状断言即可（classifier 只用这一个方法） */
function fakeRouter(impl: CompleteJson): { router: LlmRouter; calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  const router = {
    completeJson: (req: LlmRequest, parse?: (raw: unknown) => unknown) => {
      calls.push(req);
      return impl(req, parse);
    },
  } as unknown as LlmRouter;
  return { router, calls };
}

// ---- tasks/classify：请求构建 ----

test('buildClassifyRequest：直播信息 + 分类清单进 user 文本，关键帧进图片部件', () => {
  const req = buildClassifyRequest(fromLiveEvent(ctx().event), CATS);
  assert.equal(req.messages.length, 2);
  assert.equal(req.messages[0]!.role, 'system');
  const content = req.messages[1]!.content;
  assert.ok(Array.isArray(content));
  const text = content.find((c) => c.type === 'text')!;
  assert.equal(text.type, 'text');
  if (text.type === 'text') {
    assert.match(text.text, /主播：主播1/);
    assert.match(text.text, /标题：今晚歌回！/);
    assert.match(text.text, /分区：虚拟主播 \/ 虚拟Singer/);
    assert.match(text.text, /id=1 「歌回」：在以唱歌为主/);
    assert.match(text.text, /id=2 「游戏」：在打游戏/);
  }
  const img = content.find((c) => c.type === 'image_url');
  assert.ok(img && img.type === 'image_url' && img.image_url.url === 'k.jpg', '关键帧进图片部件（走 vision 路由）');
  assert.ok(req.jsonSchema, '带结构化输出 schema');
});

test('buildClassifyRequest：无关键帧用封面兜底，都无图则纯文本', () => {
  const withCover = buildClassifyRequest(fromLiveEvent(ctx('live_start', { keyframe: '', cover: 'c.jpg' }).event), CATS);
  const c1 = withCover.messages[1]!.content;
  assert.ok(Array.isArray(c1) && c1.some((p) => p.type === 'image_url' && p.image_url.url === 'c.jpg'));

  const noImage = buildClassifyRequest(fromLiveEvent(ctx('live_start', { keyframe: '', cover: '' }).event), CATS);
  const c2 = noImage.messages[1]!.content;
  assert.ok(Array.isArray(c2) && !c2.some((p) => p.type === 'image_url'), '无图 = 纯文本（走 text 路由）');
});

// ---- tasks/classify：结果解析 ----

test('parseClassifyResults：逐项全部返回带 pass 标注（match 且置信度达标 = 属于），未知 id 丢弃', () => {
  const out = parseClassifyResults({
    results: [
      { id: 1, match: true, confidence: 0.9, evidence: '在唱歌' },
      { id: 2, match: false, confidence: 0.95, evidence: '不是游戏' }, // LLM 判否 → pass=false 入档
      { id: 3, match: true, confidence: MIN_CONFIDENCE - 0.01, evidence: '不确定' }, // 置信度不达标 = 判否
      { id: 99, match: true, confidence: 1, evidence: '编造的 id' }, // 未知 id 丢弃
    ],
  }, [...CATS, { id: 3, name: '杂谈', prompt: '在杂谈' }]);
  assert.deepEqual(out, [
    { categoryId: 1, name: '歌回', source: 'llm', confidence: 0.9, evidence: '在唱歌', pass: true },
    { categoryId: 2, name: '游戏', source: 'llm', confidence: 0.95, evidence: '不是游戏', pass: false },
    { categoryId: 3, name: '杂谈', source: 'llm', confidence: MIN_CONFIDENCE - 0.01, evidence: '不确定', pass: false },
  ]);
});

test('parseClassifyResults：非 schema 输出抛错（计入熔断并触发回退）', () => {
  assert.throws(() => parseClassifyResults('{"results": 不是数组}', CATS));
  assert.throws(() => parseClassifyResults({ results: [{ id: '1' }] }, CATS));
  assert.throws(() => parseClassifyResults(null, CATS));
});

test('toClassifyCategory：取 Category 的 id/name/llmPrompt', () => {
  const db = new Db(':memory:');
  try {
    const id = db.upsertCategory(category({ name: '歌回', llmPrompt: '在唱歌' }));
    const c = db.listCategories().find((x) => x.id === id)!;
    assert.deepEqual(toClassifyCategory(c), { id, name: '歌回', prompt: '在唱歌' });
  } finally {
    db.close();
  }
});

// ---- RulesClassifier 分支 ----

test('非 live_start 信号不判定（不调 LLM、不入库）', async (t) => {
  const db = memDb(t);
  db.upsertStreamer({ uid: '1', analyze: true });
  db.upsertCategory(category({ name: '歌回', llmPrompt: '在唱歌', keywords: ['歌'] }));
  const { router, calls } = fakeRouter(async () => { throw new Error('不该被调用'); });
  const clf = new RulesClassifier(db, () => router, () => true);
  assert.deepEqual(await clf.classify(ctx('live_end')), []);
  assert.equal(calls.length, 0);
  assert.equal(db.listVerdicts('live', 'r1:1785310737').length, 0);
});

test('LLM 命中：总开关开 → LLM 判定权威入库（source=llm）', async (t) => {
  const db = memDb(t);
  db.upsertStreamer({ uid: '1', analyze: true });
  const catId = db.upsertCategory(category({ name: '歌回', llmPrompt: '在唱歌' }));
  const { router } = fakeRouter(async (_req, parse) =>
    parse!({ results: [{ id: catId, match: true, confidence: 0.88, evidence: '主播在唱歌' }] }));
  const clf = new RulesClassifier(db, () => router, () => true);

  const out = await clf.classify(ctx());
  assert.deepEqual(out, [
    { categoryId: catId, name: '歌回', source: 'llm', confidence: 0.88, evidence: '主播在唱歌', pass: true },
  ]);
  const v = db.listVerdicts('live', 'r1:1785310737');
  assert.equal(v.length, 1);
  assert.equal(v[0]!.subjectType, 'live', '直播判定归档为 live 主体');
  assert.equal(v[0]!.subjectId, 'r1:1785310737', 'subject_id = room_id:live_time');
  assert.equal(v[0]!.ruleId, 0);
  assert.equal(v[0]!.source, 'llm');
  assert.equal(v[0]!.confidence, 0.88);
});

test('LLM 说否：不回看确定性条件（关键词命中也不入）', async (t) => {
  const db = memDb(t);
  db.upsertStreamer({ uid: '1', analyze: true });
  const catId = db.upsertCategory(category({ name: '歌回', llmPrompt: '在唱歌', keywords: ['歌'] }));
  const { router } = fakeRouter(async (_req, parse) =>
    parse!({ results: [{ id: catId, match: false, confidence: 0.7, evidence: '只是标题玩梗' }] }));
  const clf = new RulesClassifier(db, () => router, () => true);

  assert.deepEqual(await clf.classify(ctx()), [], 'LLM 判否即不命中，确定性条件不参与');
  assert.equal(db.listVerdicts('live', 'r1:1785310737').length, 0);
});

test('router 抛错（含熔断耗尽）：回退确定性条件', async (t) => {
  const db = memDb(t);
  db.upsertStreamer({ uid: '1', analyze: true });
  const catId = db.upsertCategory(category({ name: '歌回', llmPrompt: '在唱歌', keywords: ['歌'] }));
  const { router } = fakeRouter(async () => { throw new Error('AllProvidersExhausted'); });
  const clf = new RulesClassifier(db, () => router, () => true);

  const out = await clf.classify(ctx());
  assert.deepEqual(out.map((c) => [c.categoryId, c.source]), [[catId, 'rule']], '回退后关键词命中');
  const v = db.listVerdicts('live', 'r1:1785310737');
  assert.equal(v[0]!.source, 'rule');
  assert.equal(v[0]!.confidence, null, 'rule 路径置信度为 null');
  assert.match(v[0]!.evidence, /关键词「歌」/);
});

test('LLM 总开关关 / router 缺失：均回退确定性条件（analyze 开关已删除）', async (t) => {
  for (const [name, llmOn, withRouter] of [
    ['llmEnabled=false', false, true],
    ['router=null', true, false],
  ] as const) {
    const db = memDb(t);
    db.upsertStreamer({ uid: '1' });
    const catId = db.upsertCategory(category({ name: '歌回', llmPrompt: '在唱歌', keywords: ['歌'] }));
    const { router, calls } = fakeRouter(async (_req, parse) =>
      parse!({ results: [{ id: catId, match: false, confidence: 0.9, evidence: 'LLM 说不是' }] }));
    const clf = new RulesClassifier(db, () => (withRouter ? router : null), () => llmOn);

    const out = await clf.classify(ctx());
    assert.deepEqual(out.map((c) => c.source), ['rule'], `${name}：走确定性路径`);
    assert.equal(calls.length, 0, `${name}：不调 LLM`);
    db.close();
  }
});

test('无 llmPrompt 的分类永远走确定性路径（即使 LLM 全可用）', async (t) => {
  const db = memDb(t);
  db.upsertStreamer({ uid: '1', analyze: true });
  const catId = db.upsertCategory(category({ name: '歌回', keywords: ['歌'] }));
  const { router, calls } = fakeRouter(async () => { throw new Error('不该有 LLM 调用'); });
  const clf = new RulesClassifier(db, () => router, () => true);

  const out = await clf.classify(ctx());
  assert.deepEqual(out.map((c) => [c.categoryId, c.source]), [[catId, 'rule']]);
  assert.equal(calls.length, 0, '无提示词分类不进 LLM 批量调用');
});

test('禁用的分类不参与判定', async (t) => {
  const db = memDb(t);
  db.upsertStreamer({ uid: '1', analyze: true });
  db.upsertCategory(category({ name: '歌回', keywords: ['歌'], enabled: false }));
  const clf = new RulesClassifier(db, () => null, () => true);
  assert.deepEqual(await clf.classify(ctx()), []);
});

test('verdicts 入库去重：同一场重复判定只留一条', async (t) => {
  const db = memDb(t);
  db.upsertStreamer({ uid: '1', analyze: false });
  db.upsertCategory(category({ name: '歌回', keywords: ['歌'] }));
  const clf = new RulesClassifier(db, () => null, () => true);
  await clf.classify(ctx());
  await clf.classify(ctx());
  assert.equal(db.listVerdicts('live', 'r1:1785310737').length, 1, 'UNIQUE(subject_type, subject_id, category_id, rule_id) 去重');
});

// ---- 判决链（runJudgeChain / 各档）----

test('runJudgeChain：首个非 null 档定案，空 Map 也是定案（不落到下一档）', async () => {
  const item = fromLiveEvent(ctx().event);
  const cats = [{ id: 1, name: '歌回', llmPrompt: '在唱歌', keywords: ['歌'], areas: [], postTypes: [], requireQuote: false, requireMedia: false, appliesTo: 'live' as const, condMode: 'and' as const, enabled: true, createdAt: 0, updatedAt: 0 }];
  const ctxJ = {
    getRouter: () => null,
    llmEnabled: () => true,
  };
  // llm 档返回空 Map（权威判否）→ 不交给 deterministic（关键词本可命中）
  const emptyLlm = { name: 'llm', judge: async () => new Map() } as typeof llmJudge;
  const viaLlm = await runJudgeChain([emptyLlm, deterministicJudge], item, cats, ctxJ);
  assert.equal(viaLlm.size, 0, 'llm 定案空 Map = 判否，不回看确定性');

  // llm 档返回 null（不可用）→ 交 deterministic
  const offLlm = { name: 'llm', judge: async () => null } as typeof llmJudge;
  const viaDet = await runJudgeChain([offLlm, deterministicJudge], item, cats, ctxJ);
  assert.deepEqual([...viaDet.keys()], [1]);
  assert.equal(viaDet.get(1)!.source, 'rule');

  // 全档 null → 空 Map
  const allOff = await runJudgeChain([offLlm], item, cats, ctxJ);
  assert.equal(allOff.size, 0);
});

test('llmJudge：无 provider / 总开关关返回 null；调用失败返回 null（交下一档）', async () => {
  const item = fromLiveEvent(ctx().event);
  const cats = [{ id: 1, name: '歌回', llmPrompt: '在唱歌', keywords: [], areas: [], postTypes: [], requireQuote: false, requireMedia: false, appliesTo: 'live' as const, condMode: 'and' as const, enabled: true, createdAt: 0, updatedAt: 0 }];
  assert.equal(await llmJudge.judge(item, cats, { getRouter: () => null, llmEnabled: () => true }), null);

  const { router, calls } = fakeRouter(async () => { throw new Error('boom'); });
  assert.equal(await llmJudge.judge(item, cats, { getRouter: () => router, llmEnabled: () => false }), null);
  assert.equal(calls.length, 0, '总开关关不调 LLM');
  assert.equal(await llmJudge.judge(item, cats, { getRouter: () => router, llmEnabled: () => true }), null, '调用失败交下一档');
  assert.equal(calls.length, 1);
});

test('deterministicJudge：命中才入 Map（键 = 分类 id，source=rule）', async () => {
  const item = fromLiveEvent(ctx().event);
  const hit = { id: 1, name: '歌回', llmPrompt: null, keywords: ['歌'], areas: [], postTypes: [], requireQuote: false, requireMedia: false, appliesTo: 'live' as const, condMode: 'and' as const, enabled: true, createdAt: 0, updatedAt: 0 };
  const miss = { ...hit, id: 2, name: '游戏', keywords: ['APEX'] };
  const out = await deterministicJudge.judge(item, [hit, miss], { getRouter: () => null, llmEnabled: () => false });
  assert.deepEqual([...out.keys()], [1]);
  assert.deepEqual(out.get(1), { categoryId: 1, name: '歌回', source: 'rule', confidence: null, evidence: '命中关键词「歌」', pass: true });
});

// ---- post 判定归档（A.4 判定分类制）：feed_post 同走判决链，verdicts 落真实 categoryId、ruleId=0 哨兵 ----

function postCtx(over: Partial<import('./matcher.js').PostCandidate> = {}): AnalysisContext {
  return {
    signal: {
      source: 'twitter/feed', kind: 'feed_post', uid: 'watase_yuzuki', roomId: '', ts: 0,
      payload: { platform: 'twitter', itemId: '9001', type: 'tweet', text: '今晚有直播', pics: [], pubTs: 1, url: 'u' },
    },
    post: {
      post: {
        platform: 'twitter', itemId: '9001', accountId: 1, screenName: 'watase_yuzuki',
        type: 'tweet', text: '今晚有直播', pics: [], pubTs: 1, url: 'u', ...over,
      },
    },
  };
}

test('post 判定：只判 applies_to=post 的分类，verdicts 落真实 categoryId（ruleId=0 哨兵）', async (t) => {
  const db = memDb(t);
  const liveCat = db.upsertCategory(category({ name: '歌回', keywords: ['歌'] })); // applies_to=live
  const postCat = db.upsertCategory(category({
    name: '直播预告', appliesTo: 'post', keywords: ['直播'],
  }));
  const clf = new RulesClassifier(db, () => null, () => true);

  const out = await clf.classify(postCtx());
  assert.deepEqual(out.map((c) => c.categoryId), [postCat], 'live 分类不参与 post 判定');
  assert.notEqual(postCat, liveCat);

  const v = db.listVerdicts('post', 'twitter:9001');
  assert.equal(v.length, 1);
  assert.equal(v[0]!.subjectType, 'post');
  assert.equal(v[0]!.subjectId, 'twitter:9001', '身份键 = platform:item_id');
  assert.equal(v[0]!.categoryId, postCat, '真实 categoryId（不再是 ruleId 级哨兵）');
  assert.equal(v[0]!.ruleId, 0, 'ruleId 回 0 哨兵');
  assert.equal(v[0]!.source, 'rule');
  assert.equal(v[0]!.pass, true);
});

test('post 侧 LLM 判否也落 pass=0（「为什么没推」可回看）；直播侧保持只记「属于」', async (t) => {
  const db = memDb(t);
  const catId = db.upsertCategory(category({ name: '直播预告', appliesTo: 'post', llmPrompt: '是直播预告' }));
  const liveCatId = db.upsertCategory(category({ name: '歌回', llmPrompt: '在唱歌' }));
  const { router } = fakeRouter(async (_req, parse) =>
    parse!({ results: [{ id: catId, match: false, confidence: 0.9, evidence: '只是日常闲聊' }] }));
  const clf = new RulesClassifier(db, () => router, () => true);

  const out = await clf.classify(postCtx());
  assert.deepEqual(out, [], '判否不属于任何分类（返回值只含属于）');
  const v = db.listVerdicts('post', 'twitter:9001');
  assert.equal(v.length, 1, '判否也落档');
  assert.equal(v[0]!.pass, false, '判否 = 0 落库');
  assert.equal(v[0]!.evidence, '只是日常闲聊');
  assert.equal(v[0]!.source, 'llm');

  // 同一形态的判否在直播侧不落档（只记「属于」，行为逐字保持）
  const { router: r2 } = fakeRouter(async (_req, parse) =>
    parse!({ results: [{ id: liveCatId, match: false, confidence: 0.9, evidence: '不在唱歌' }] }));
  const clf2 = new RulesClassifier(db, () => r2, () => true);
  const out2 = await clf2.classify(ctx());
  assert.deepEqual(out2, []);
  assert.equal(db.listVerdicts('live', 'r1:1785310737').length, 0, '直播侧判否不落档');
});

test('post 判定去重：同一帖重复判定只留一条（UNIQUE 身份键）', async (t) => {
  const db = memDb(t);
  db.upsertCategory(category({ name: '直播预告', appliesTo: 'post', keywords: ['直播'] }));
  const clf = new RulesClassifier(db, () => null, () => true);
  await clf.classify(postCtx());
  await clf.classify(postCtx());
  assert.equal(db.listVerdicts('post', 'twitter:9001').length, 1);
});
