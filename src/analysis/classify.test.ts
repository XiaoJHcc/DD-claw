import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../core/db.js';
import { toLiveEvent, type LiveStatus, type Signal } from '../core/types.js';
import type { NewCategory } from '../core/push.js';
import { RulesClassifier } from './classifier.js';
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
    name: '', llmPrompt: null, keywords: [], areas: [], condMode: 'and', enabled: true,
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
  const req = buildClassifyRequest(ctx().event, CATS);
  assert.equal(req.messages.length, 2);
  assert.equal(req.messages[0]!.role, 'system');
  const content = req.messages[1]!.content;
  assert.ok(Array.isArray(content));
  const text = content.find((c) => c.type === 'text')!;
  assert.equal(text.type, 'text');
  if (text.type === 'text') {
    assert.match(text.text, /主播：阿梓（主播1）/);
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
  const withCover = buildClassifyRequest(ctx('live_start', { keyframe: '', cover: 'c.jpg' }).event, CATS);
  const c1 = withCover.messages[1]!.content;
  assert.ok(Array.isArray(c1) && c1.some((p) => p.type === 'image_url' && p.image_url.url === 'c.jpg'));

  const noImage = buildClassifyRequest(ctx('live_start', { keyframe: '', cover: '' }).event, CATS);
  const c2 = noImage.messages[1]!.content;
  assert.ok(Array.isArray(c2) && !c2.some((p) => p.type === 'image_url'), '无图 = 纯文本（走 text 路由）');
});

// ---- tasks/classify：结果解析 ----

test('parseClassifyResults：match=true 且置信度达标才采纳，未知 id 丢弃', () => {
  const out = parseClassifyResults({
    results: [
      { id: 1, match: true, confidence: 0.9, evidence: '在唱歌' },
      { id: 2, match: false, confidence: 0.95, evidence: '不是游戏' }, // match=false 不采纳
      { id: 3, match: true, confidence: MIN_CONFIDENCE - 0.01, evidence: '不确定' }, // 置信度不达标
      { id: 99, match: true, confidence: 1, evidence: '编造的 id' }, // 未知 id 丢弃
    ],
  }, [...CATS, { id: 3, name: '杂谈', prompt: '在杂谈' }]);
  assert.deepEqual(out, [
    { categoryId: 1, name: '歌回', source: 'llm', confidence: 0.9, evidence: '在唱歌' },
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
  assert.equal(db.listVerdicts('r1', 1_785_310_737).length, 0);
});

test('LLM 命中：analyze=1 + 开关开 → LLM 判定权威入库（source=llm）', async (t) => {
  const db = memDb(t);
  db.upsertStreamer({ uid: '1', analyze: true });
  const catId = db.upsertCategory(category({ name: '歌回', llmPrompt: '在唱歌' }));
  const { router } = fakeRouter(async (_req, parse) =>
    parse!({ results: [{ id: catId, match: true, confidence: 0.88, evidence: '主播在唱歌' }] }));
  const clf = new RulesClassifier(db, () => router, () => true);

  const out = await clf.classify(ctx());
  assert.deepEqual(out, [
    { categoryId: catId, name: '歌回', source: 'llm', confidence: 0.88, evidence: '主播在唱歌' },
  ]);
  const v = db.listVerdicts('r1', 1_785_310_737);
  assert.equal(v.length, 1);
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
  assert.equal(db.listVerdicts('r1', 1_785_310_737).length, 0);
});

test('router 抛错（含熔断耗尽）：回退确定性条件', async (t) => {
  const db = memDb(t);
  db.upsertStreamer({ uid: '1', analyze: true });
  const catId = db.upsertCategory(category({ name: '歌回', llmPrompt: '在唱歌', keywords: ['歌'] }));
  const { router } = fakeRouter(async () => { throw new Error('AllProvidersExhausted'); });
  const clf = new RulesClassifier(db, () => router, () => true);

  const out = await clf.classify(ctx());
  assert.deepEqual(out.map((c) => [c.categoryId, c.source]), [[catId, 'rule']], '回退后关键词命中');
  const v = db.listVerdicts('r1', 1_785_310_737);
  assert.equal(v[0]!.source, 'rule');
  assert.equal(v[0]!.confidence, null, 'rule 路径置信度为 null');
  assert.match(v[0]!.evidence, /关键词「歌」/);
});

test('LLM 总开关关 / analyze=0 / router 缺失：均回退确定性条件', async (t) => {
  for (const [name, analyze, llmOn, withRouter] of [
    ['llmEnabled=false', true, false, true],
    ['analyze=0', false, true, true],
    ['router=null', true, true, false],
  ] as const) {
    const db = memDb(t);
    db.upsertStreamer({ uid: '1', analyze });
    const catId = db.upsertCategory(category({ name: '歌回', llmPrompt: '在唱歌', keywords: ['歌'] }));
    const { router, calls } = fakeRouter(async (_req, parse) =>
      parse!({ results: [{ id: catId, match: false, confidence: 0.9, evidence: 'LLM 说不是' }] }));
    const clf = new RulesClassifier(db, () => (withRouter ? router : null), () => llmOn);

    const out = await clf.classify(ctx());
    assert.deepEqual(out.map((c) => c.source), ['rule'], `${name}：走确定性路径`);
    assert.equal(calls.length, withRouter ? 0 : 0, `${name}：不调 LLM`);
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
  assert.equal(db.listVerdicts('r1', 1_785_310_737).length, 1, 'UNIQUE(room_id, live_time, category_id) 去重');
});
