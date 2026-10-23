import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../core/db.js';
import { toLiveEvent, type LiveStatus, type Signal } from '../core/types.js';
import type { Category, NewCategory } from '../core/push.js';
import { RulesClassifier, llmJudge, decisionJudge, JUDGE_STAGES, type JudgeContext } from './classifier.js';
import { fromLiveEvent } from './content.js';
import {
  buildClassifyRequest, parseClassifyResults, toClassifyCategory, PRIMARY_OTHER_ID,
  type ClassifyCategory,
} from './tasks/classify.js';
import { DEFAULT_DECISION_THRESHOLDS } from './tasks/decide.js';
import type { LlmRequest, LlmRouter } from './providers.js';
import type { DecisionRouter } from './decision-router.js';
import type { DecisionProviderConfig } from '../config/schema.js';
import type { SystemOneRequest, SystemOneResponse } from './decision-providers.js';
import type { ModelAttempt } from '../core/content-audit.js';
import type { AnalysisContext, Classification } from './types.js';

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
    condMode: 'and', primary: false, enabled: true,
    ...over,
  };
}

/** 库里的分类（含 id / primary 等完整形状），供 payload 构造用 */
function storedCategory(db: Db, id: number): Category {
  return db.listCategories().find((c) => c.id === id)!;
}

type CompleteJson = (
  req: LlmRequest,
  parse?: (raw: unknown) => unknown,
  onAttempt?: (attempt: import('../core/content-audit.js').ModelAttempt) => void,
) => Promise<unknown>;

/** 假 router：实现只给 completeJson，按 LlmRouter 形状断言即可（classifier 只用这一个方法） */
function fakeRouter(impl: CompleteJson): { router: LlmRouter; calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  const router = {
    completeJson: (
      req: LlmRequest,
      parse?: (raw: unknown) => unknown,
      onAttempt?: (attempt: import('../core/content-audit.js').ModelAttempt) => void,
    ) => {
      calls.push(req);
      return impl(req, parse, onAttempt);
    },
  } as unknown as LlmRouter;
  return { router, calls };
}

/** 请求里的 user 文本（第一个 text 部件） */
function requestText(req: LlmRequest): string {
  const content = req.messages[1]!.content;
  assert.ok(Array.isArray(content));
  const text = content.find((p) => p.type === 'text');
  assert.ok(text && text.type === 'text');
  return text.type === 'text' ? text.text : '';
}

// ---- 决策档测试件：判决上下文 / 假决策路由 ----

/** 判决链上下文：默认决策档不参与（只有 LLM 档跑），需要时逐项覆盖 */
function judgeCtx(over: Partial<JudgeContext> = {}): JudgeContext {
  return {
    getRouter: () => null,
    llmEnabled: () => true,
    getDecisionRouter: () => null,
    decisionEnabled: () => false,
    decisionThresholds: () => DEFAULT_DECISION_THRESHOLDS,
    ...over,
  };
}

/** 按请求题目作答：noul 取给定概率（缺省 0.9），choice 取 pick（缺省第一个选项）并给出分布 */
function decisionAnswers(
  req: SystemOneRequest,
  opts: { noul?: Record<string, number>; pick?: string; top?: number } = {},
): SystemOneResponse {
  const answers: SystemOneResponse['answers'] = {};
  for (const [id, q] of Object.entries(req.questions)) {
    if (q.type === 'noul') {
      answers[id] = { type: 'noul', noul: opts.noul?.[id] ?? 0.9 };
    } else if (q.type === 'choice') {
      const keys = Object.keys(q.criteria);
      const pick = opts.pick ?? keys[0]!;
      const top = opts.top ?? 0.9;
      const rest = keys.length > 1 ? (1 - top) / (keys.length - 1) : 0;
      const probabilities: Record<string, number> = {};
      for (const k of keys) probabilities[k] = k === pick ? top : rest;
      answers[id] = { type: 'choice', choice: pick, probabilities };
    }
  }
  return { model: 'jev-1.13.0', answers };
}

interface FakeDecisionOptions {
  /** 供应商是否 vision（决定带图内容是否会真的带图） */
  vision?: boolean;
  /** 作答；抛错 = 整档失败（等同 HTTP 失败 / 全部候选不可用） */
  respond?: (req: SystemOneRequest, withImages: boolean) => SystemOneResponse | Promise<SystemOneResponse>;
}

/** 假决策路由：按真实 DecisionRouter.decide 的语义走（build → 作答 → validate → 返回） */
function fakeDecisionRouter(o: FakeDecisionOptions = {}): {
  router: DecisionRouter;
  spec: DecisionProviderConfig;
  requests: SystemOneRequest[];
} {
  const spec: DecisionProviderConfig = {
    name: 'jev', baseURL: 'https://api.typesafe.ai/v1', model: 'jev-1.14.0',
    protocol: 'systemone', vision: o.vision ?? false, enabled: true,
  };
  const requests: SystemOneRequest[] = [];
  const router = {
    decide: async (
      build: (withImages: boolean, s: DecisionProviderConfig) => { req: SystemOneRequest; assets?: unknown },
      decideOpts: { hasImages: boolean },
      validate: (res: SystemOneResponse) => void,
      onAttempt?: (a: ModelAttempt) => void,
    ) => {
      const withImages = decideOpts.hasImages && spec.vision;
      const call = build(withImages, spec);
      // 与真实 router 同语义：只有允许带图时才把 assets 并进请求体
      requests.push(withImages && call.assets
        ? { ...call.req, assets: call.assets as SystemOneRequest['assets'] }
        : call.req);
      try {
        const response = await (o.respond ?? ((req) => decisionAnswers(req)))(call.req, withImages);
        validate(response);
        onAttempt?.({ provider: spec.name, model: response.model, status: 'success', channel: 'decision' });
        return { response, provider: spec, withImages };
      } catch (e) {
        onAttempt?.({ provider: spec.name, model: spec.model, status: 'failed', channel: 'decision', error: (e as Error).message });
        throw e;
      }
    },
  } as unknown as DecisionRouter;
  return { router, spec, requests };
}

// ---- tasks/classify：请求构建 ----

test('buildClassifyRequest：直播信息 + 分类清单进 user 文本，视觉输入进图片部件', () => {
  const req = buildClassifyRequest(fromLiveEvent(ctx().event!, ['data:image/jpeg;base64,AAA']), CATS);
  assert.equal(req.messages.length, 2);
  assert.equal(req.messages[0]!.role, 'system');
  const text = requestText(req);
  assert.match(text, /主播：主播1/);
  assert.match(text, /标题：今晚歌回！/);
  assert.match(text, /分区：虚拟主播 \/ 虚拟Singer/);
  assert.match(text, /分类清单（id、名称、判定描述）：/);
  assert.match(text, /- id=1 「歌回」：在以唱歌为主/);
  assert.match(text, /- id=2 「游戏」：在打游戏/);
  const content = req.messages[1]!.content;
  assert.ok(Array.isArray(content));
  const img = content.find((c) => c.type === 'image_url');
  assert.ok(img && img.type === 'image_url' && img.image_url.url === 'data:image/jpeg;base64,AAA',
    '规范化后的 data URL 进图片部件（走 vision 路由）');
  const schema = req.jsonSchema!.schema as { properties: Record<string, unknown>; required: string[] };
  assert.deepEqual(schema.required, ['results'], '没请求主分类就不要求 primary');
  assert.equal(schema.properties['primary'], undefined);
});

test('buildClassifyRequest：请求主分类时清单追加单选段，schema 要求 primary', () => {
  const primary = [CATS[0]!];
  const req = buildClassifyRequest(fromLiveEvent(ctx().event!, ['data:image/jpeg;base64,AAA']), CATS, primary);
  const text = requestText(req);
  assert.match(text, /主分类（单选，选最像的一项；都不像选 id=0「其他」）：/);
  assert.match(text, /- id=1 「歌回」：在以唱歌为主/);
  const schema = req.jsonSchema!.schema as { properties: Record<string, unknown>; required: string[] };
  assert.deepEqual(schema.required, ['results', 'primary']);
  assert.ok(schema.properties['primary']);
  // system prompt 两个形态都要求选主分类
  assert.match(String(req.messages[0]!.content), /并在要求时选出主分类/);
  assert.match(String(buildClassifyRequest(fromLiveEvent(ctx().event!), CATS).messages[0]!.content), /并在要求时选出主分类/);
});

test('buildClassifyRequest：无规范化图片 = 纯文本，远程关键帧 / 封面 URL 不进请求', () => {
  const withKeyframe = buildClassifyRequest(fromLiveEvent(ctx('live_start', { keyframe: 'k.jpg', cover: 'c.jpg' }).event!), CATS);
  const c1 = withKeyframe.messages[1]!.content;
  assert.ok(Array.isArray(c1) && !c1.some((p) => p.type === 'image_url'), '图床 URL 绝不进模型请求');

  const noImage = buildClassifyRequest(fromLiveEvent(ctx('live_start', { keyframe: '', cover: '' }).event!), CATS);
  const c2 = noImage.messages[1]!.content;
  assert.ok(Array.isArray(c2) && !c2.some((p) => p.type === 'image_url'), '无图 = 纯文本（走 text 路由）');
});

// ---- tasks/classify：结果解析 ----

test('parseClassifyResults：逐项全部返回，pass = match，来源 llm 且不带置信度，未知 id 丢弃', () => {
  const out = parseClassifyResults({
    results: [
      { id: 1, match: true, evidence: '在唱歌' },
      { id: 2, match: false, evidence: '不是游戏' }, // 判否同样入档
      { id: 99, match: true, evidence: '编造的 id' }, // 未知 id 丢弃
    ],
  }, [...CATS, { id: 3, name: '杂谈', prompt: '在杂谈' }].slice(0, 2));
  assert.deepEqual(out.results, [
    { categoryId: 1, name: '歌回', source: 'llm', confidence: null, evidence: '在唱歌', pass: true, effective: false },
    { categoryId: 2, name: '游戏', source: 'llm', confidence: null, evidence: '不是游戏', pass: false, effective: false },
  ]);
  assert.equal(out.primary, null, '没请求主分类就没有主分类结论');
});

test('parseClassifyResults：非 schema 输出抛错（计入熔断并触发回退）', () => {
  assert.throws(() => parseClassifyResults('{"results": 不是数组}', CATS));
  assert.throws(() => parseClassifyResults({ results: [{ id: '1' }] }, CATS));
  assert.throws(() => parseClassifyResults(null, CATS));
  // 模型多给的置信度不采信（结论只留 match 与理由）
  const out = parseClassifyResults(
    { results: [{ id: 1, match: true, evidence: 'x', confidence: 0.9 }] }, [CATS[0]!],
  );
  assert.equal(out.results[0]!.confidence, null, 'LLM 不产出置信度');
});

test('分类结果漏项或重复不得误成功', () => {
  const first = { id: 1, match: true, evidence: '歌回' };
  assert.throws(() => parseClassifyResults({ results: [first] }, CATS), /不完整/);
  assert.throws(() => parseClassifyResults({ results: [first, first] }, [CATS[0]!]), /重复/);
});

test('parseClassifyResults 主分类：选项内 id / 「其他」/ 不存在 id 判失败 / 请求了必答', () => {
  const results = [{ id: 1, match: true, evidence: '在唱' }, { id: 2, match: false, evidence: '没打游戏' }];
  const picked = parseClassifyResults(
    { results, primary: { id: 2, evidence: '最像游戏' } }, CATS, [CATS[1]!],
  );
  assert.deepEqual(picked.primary, {
    source: 'llm', categoryId: 2, name: '游戏', distribution: null, evidence: '最像游戏', effective: false,
  });

  const other = parseClassifyResults(
    { results, primary: { id: PRIMARY_OTHER_ID, evidence: '都不像' } }, CATS, [CATS[1]!],
  );
  assert.deepEqual(
    [other.primary!.categoryId, other.primary!.name, other.primary!.source],
    [0, '其他', 'llm'],
  );

  assert.throws(
    () => parseClassifyResults({ results, primary: { id: 7, evidence: '编造' } }, CATS, [CATS[1]!]),
    /不在选项集内/,
  );
  assert.throws(() => parseClassifyResults({ results }, CATS, [CATS[1]!]), /主分类结果缺失/);
});

test('toClassifyCategory：取 Category 的 id/name/llmPrompt', () => {
  const db = new Db(':memory:');
  try {
    const id = db.upsertCategory(category({ name: '歌回', llmPrompt: '在唱歌' }));
    assert.deepEqual(toClassifyCategory(storedCategory(db, id)), { id, name: '歌回', prompt: '在唱歌' });
  } finally {
    db.close();
  }
});

// ---- llmJudge 档 ----

test('llmJudge：无 provider / 总开关关返回 null；调用失败返回 null', async () => {
  const item = fromLiveEvent(ctx().event!);
  const db = new Db(':memory:');
  try {
    db.upsertCategory(category({ name: '歌回', llmPrompt: '在唱歌' }));
    const req = { cats: db.listCategories(), primaryCats: null };
    assert.equal(await llmJudge.judge(item, req, judgeCtx()), null);

    const { router, calls } = fakeRouter(async () => { throw new Error('boom'); });
    assert.equal(await llmJudge.judge(item, req, judgeCtx({ getRouter: () => router, llmEnabled: () => false })), null);
    assert.equal(calls.length, 0, '总开关关不调 LLM');
    assert.equal(await llmJudge.judge(item, req, judgeCtx({ getRouter: () => router })), null, '调用失败交下一档');
    assert.equal(calls.length, 1);
  } finally {
    db.close();
  }
});

test('llmJudge：成功时返回全部结论 + 定案集合，模型尝试标 channel=llm', async () => {
  const db = new Db(':memory:');
  try {
    db.upsertCategory(category({ name: '歌回', llmPrompt: '在唱歌' }));
    db.upsertCategory(category({ name: '游戏', llmPrompt: '在打游戏', primary: true }));
    const cats = db.listCategories();
    const { router } = fakeRouter(async (_req, parse, onAttempt) => {
      onAttempt?.({ provider: 'p1', model: 'm1', status: 'success' });
      return parse!({
        results: [
          { id: cats[0]!.id, match: true, evidence: '在唱' },
          { id: cats[1]!.id, match: false, evidence: '没打游戏' },
        ],
        primary: { id: 0, evidence: '都不像' },
      });
    });
    const attempts: Array<{ channel?: string }> = [];
    const out = await llmJudge.judge(fromLiveEvent(ctx().event!), {
      cats, primaryCats: [cats[1]!],
    }, judgeCtx({ getRouter: () => router, onAttempt: (a) => attempts.push(a) }));
    assert.ok(out);
    assert.deepEqual(out.results.map((r) => [r.categoryId, r.pass, r.effective]), [
      [cats[0]!.id, true, false], [cats[1]!.id, false, false],
    ]);
    assert.deepEqual([...out.decided], [cats[0]!.id, cats[1]!.id]);
    assert.deepEqual([out.primary!.categoryId, out.primaryDecided], [0, true]);
    assert.deepEqual(attempts.map((a) => a.channel), ['llm'], '模型尝试标通道');
  } finally {
    db.close();
  }
});

test('JUDGE_STAGES：决策档在 LLM 档之前', () => {
  assert.deepEqual(JUDGE_STAGES.map((s) => s.name), ['decision', 'llm']);
});

// ---- decisionJudge 档 ----

test('decisionJudge：无路由 / 总开关关返回 null，原因只进 stageNotes（不覆盖 LLM 的 fallbackReason）', async () => {
  const db = new Db(':memory:');
  try {
    db.upsertCategory(category({ name: '歌回', llmPrompt: '在唱歌' }));
    const item = fromLiveEvent(ctx().event!);
    const req = { cats: db.listCategories(), primaryCats: null };
    const skips: Array<[string, string]> = [];

    assert.equal(await decisionJudge.judge(item, req, judgeCtx({
      onStageSkip: (stage, reason) => skips.push([stage, reason]),
    })), null);
    assert.equal(await decisionJudge.judge(item, req, judgeCtx({
      onStageSkip: (stage, reason) => skips.push([stage, reason]),
      getDecisionRouter: () => fakeDecisionRouter().router,
    })), null, '总开关缺省关');
    assert.deepEqual(skips.map((s) => s[0]), ['decision', 'decision']);
    assert.match(skips[0]![1], /供应商/);
    assert.match(skips[1]![1], /总开关关闭/);
  } finally {
    db.close();
  }
});

test('决策定案：p 高于上界 / 低于下界都直接生效（source=decision，confidence=p），不再问 LLM', async (t) => {
  const db = memDb(t);
  const song = db.upsertCategory(category({ name: '歌回', llmPrompt: '在唱歌' }));
  const game = db.upsertCategory(category({ name: '游戏', llmPrompt: '在打游戏' }));
  const { router: decisionRouter } = fakeDecisionRouter({
    respond: (req) => decisionAnswers(req, { noul: { [`c${song}`]: 0.93, [`c${game}`]: 0.04 } }),
  });
  const { router: llmRouter, calls } = fakeRouter(async () => { throw new Error('决策已定案，不该问 LLM'); });

  const out = await new RulesClassifier(db, {
    getRouter: () => llmRouter,
    llmEnabled: () => true,
    getDecisionRouter: () => decisionRouter,
    decisionEnabled: () => true,
  }).classify(ctx());

  assert.equal(calls.length, 0, '决策档定案后不进 LLM');
  assert.deepEqual(out.map((c) => [c.categoryId, c.source]), [[song, 'decision']], '返回值只含生效且属于');
  const v = db.listVerdicts('live', 'r1:1785310737');
  assert.deepEqual(
    v.map((r) => [r.categoryId, r.source, r.pass, r.confidence, r.effective]),
    [[song, 'decision', true, 0.93, true], [game, 'decision', false, 0.04, true]],
    '逐分类恰一行生效，判否同样落库，confidence = p',
  );
  assert.match(v[0]!.evidence, /jev · jev-1\.13\.0/, '证据记供应商与响应回显的版本');
});

test('决策灰区：结论落库但不定案，交 LLM 且请求只含灰区分类', async (t) => {
  const db = memDb(t);
  const song = db.upsertCategory(category({ name: '歌回', llmPrompt: '在唱歌' }));
  const game = db.upsertCategory(category({ name: '游戏', llmPrompt: '在打游戏' }));
  const { router: decisionRouter } = fakeDecisionRouter({
    respond: (req) => decisionAnswers(req, { noul: { [`c${song}`]: 0.5, [`c${game}`]: 0.95 } }),
  });
  const { router: llmRouter, calls } = fakeRouter(async (_req, parse) =>
    parse!({ results: [{ id: song, match: true, evidence: '还是在唱歌' }] }));

  await new RulesClassifier(db, {
    getRouter: () => llmRouter,
    llmEnabled: () => true,
    getDecisionRouter: () => decisionRouter,
    decisionEnabled: () => true,
  }).classify(ctx());

  assert.equal(calls.length, 1);
  const text = requestText(calls[0]!);
  assert.match(text, /歌回/, '灰区分类交 LLM');
  assert.doesNotMatch(text, /游戏/, '已定案的分类不再发给 LLM');
  const v = db.listVerdicts('live', 'r1:1785310737');
  const songRows = v.filter((r) => r.categoryId === song);
  assert.deepEqual(
    songRows.map((r) => [r.source, r.effective]),
    [['decision', false], ['llm', true]],
    '灰区决策行落库但不定案，LLM 行生效',
  );
  assert.match(songRows[0]!.evidence, /灰区/);
  assert.deepEqual(
    v.filter((r) => r.categoryId === game).map((r) => [r.source, r.effective]),
    [['decision', true]],
    '高 p 分类由决策档定案',
  );
});

test('决策档不可用（开关关 / 无路由 / 调用失败 / 解析失败）一律交 LLM', async (t) => {
  const cases: Array<{ name: string; decision: FakeDecisionOptions | null; enabled: boolean }> = [
    { name: '总开关关', decision: {}, enabled: false },
    { name: '无路由', decision: null, enabled: true },
    { name: '调用失败', decision: { respond: () => { throw new Error('HTTP 502'); } }, enabled: true },
    { name: '解析失败-缺题', decision: { respond: () => ({ model: 'm', answers: {} }) }, enabled: true },
    {
      name: '解析失败-类型不符',
      decision: {
        respond: (req) => {
          const id = Object.keys(req.questions)[0]!;
          return { model: 'm', answers: { [id]: { type: 'choice', choice: 'x', probabilities: {} } } };
        },
      },
      enabled: true,
    },
    {
      name: '解析失败-越界',
      decision: {
        respond: (req) => {
          const id = Object.keys(req.questions)[0]!;
          return { model: 'm', answers: { [id]: { type: 'noul', noul: 1.5 } } };
        },
      },
      enabled: true,
    },
  ];
  for (const c of cases) {
    const db = new Db(':memory:');
    try {
      db.upsertCategory(category({ name: '歌回', llmPrompt: '在唱歌', keywords: ['歌'] }));
      const catId = db.listCategories()[0]!.id;
      const { router: llmRouter, calls } = fakeRouter(async (_req, parse) =>
        parse!({ results: [{ id: catId, match: true, evidence: 'LLM 判定为歌回' }] }));
      const fake = c.decision === null ? null : fakeDecisionRouter(c.decision);
      const out = await new RulesClassifier(db, {
        getRouter: () => llmRouter,
        llmEnabled: () => true,
        getDecisionRouter: () => (fake === null ? null : fake.router),
        decisionEnabled: () => c.enabled,
      }).classify(ctx());
      assert.equal(calls.length, 1, `${c.name}：交 LLM`);
      assert.deepEqual(out.map((x) => x.source), ['llm'], `${c.name}：LLM 定案`);
      const v = db.listVerdicts('live', 'r1:1785310737');
      assert.deepEqual(
        v.filter((r) => r.effective).map((r) => [r.source, r.effective]),
        [['llm', true]],
        `${c.name}：决策档没有可用结论，LLM 行生效`,
      );
      assert.equal(v.filter((r) => r.source === 'decision').length, 0, `${c.name}：没有决策行`);
    } finally {
      db.close();
    }
  }
});

test('决策与 LLM 都不可用：确定性条件定案（决策档失败后仍回退）', async (t) => {
  const db = memDb(t);
  const catId = db.upsertCategory(category({ name: '歌回', llmPrompt: '在唱歌', keywords: ['歌'] }));
  const { router: decisionRouter } = fakeDecisionRouter({
    respond: () => { throw new Error('决策端点全挂'); },
  });
  const out = await new RulesClassifier(db, {
    getRouter: () => null,
    llmEnabled: () => true,
    getDecisionRouter: () => decisionRouter,
    decisionEnabled: () => true,
  }).classify(ctx());
  assert.deepEqual(out.map((c) => [c.categoryId, c.source]), [[catId, 'rule']]);
  const audit = db.getContentAudit('live', 'r1:1785310737')!.analysis!;
  assert.deepEqual(audit.stageNotes!.map((n) => n.stage), ['decision'], '决策档失败原因单独记，不覆盖 LLM 回退文案');
  assert.match(audit.stageNotes![0]!.reason, /决策模型/);
  assert.match(audit.fallbackReason!, /未配置 LLM/, 'fallbackReason 仍只承载 LLM 档');
});

test('带图内容只有纯文本供应商：决策结论落库但不定案，交 LLM；vision 供应商则带图请求', async (t) => {
  // ① 纯文本供应商：请求里没有 assets / 图片 ref，结论不定案
  {
    const db = memDb(t);
    const catId = db.upsertCategory(category({ name: '自拍', appliesTo: 'post', llmPrompt: '是自拍' }));
    const { router: decisionRouter, requests } = fakeDecisionRouter({
      vision: false,
      respond: (req) => decisionAnswers(req, { noul: { [`c${catId}`]: 0.99 } }),
    });
    const { router: llmRouter, calls } = fakeRouter(async (_req, parse) =>
      parse!({ results: [{ id: catId, match: true, evidence: '看图是自拍' }] }));
    await new RulesClassifier(db, {
      getRouter: () => llmRouter,
      llmEnabled: () => true,
      getDecisionRouter: () => decisionRouter,
      decisionEnabled: () => true,
    }).classify({ ...postCtx(), images: { dataUrls: ['data:image/jpeg;base64,AAA'], skipped: [] } });

    assert.equal(requests[0]!.assets, undefined, '纯文本供应商请求不带 assets');
    const state = requests[0]!.state as Record<string, unknown>;
    assert.equal(state.配图, undefined, 'state 里也不留图片 ref');
    const v = db.listVerdicts('post', 'twitter:9001');
    const decisionRow = v.find((r) => r.source === 'decision')!;
    assert.equal(decisionRow.effective, false, '没看图的结论不定案');
    assert.equal(decisionRow.pass, true, '结论仍然落库');
    assert.equal(decisionRow.confidence, 0.99);
    assert.match(decisionRow.evidence, /纯文本供应商未看图/);
    assert.equal(v.find((r) => r.source === 'llm')!.effective, true);
    assert.equal(calls.length, 1, '带图内容交 LLM（它真的能看图）');
    db.close();
  }
  // ② vision 供应商：带图请求里有 assets 与 state ref
  {
    const db = memDb(t);
    const catId = db.upsertCategory(category({ name: '自拍', appliesTo: 'post', llmPrompt: '是自拍' }));
    const { router: decisionRouter, requests } = fakeDecisionRouter({
      vision: true,
      respond: (req) => decisionAnswers(req, { noul: { [`c${catId}`]: 0.99 } }),
    });
    const { router: llmRouter, calls } = fakeRouter(async () => { throw new Error('决策已定案'); });
    const out = await new RulesClassifier(db, {
      getRouter: () => llmRouter,
      llmEnabled: () => true,
      getDecisionRouter: () => decisionRouter,
      decisionEnabled: () => true,
    }).classify({ ...postCtx(), images: { dataUrls: ['data:image/jpeg;base64,AAA'], skipped: [] } });

    const assets = requests[0]!.assets!;
    const refs = Object.keys(assets);
    assert.equal(refs.length, 1);
    assert.equal(assets[refs[0]!]!.data_base64, 'AAA', '纯 base64（剥掉 data URL 前缀）');
    assert.deepEqual((requests[0]!.state as Record<string, unknown>).配图, refs, 'state 里的 ref 与 assets 对齐');
    assert.equal(calls.length, 0);
    assert.deepEqual(out.map((c) => c.source), ['decision'], 'vision 供应商的结论可定案');
    db.close();
  }
});

test('主分类：决策 choice 定案（分布入 primary_verdicts），最高项低于门槛则交 LLM', async (t) => {
  // ① 定案
  {
    const db = memDb(t);
    const song = db.upsertCategory(category({ name: '歌回', llmPrompt: '在唱歌', primary: true }));
    const game = db.upsertCategory(category({ name: '游戏', llmPrompt: '在打游戏', primary: true }));
    const { router: decisionRouter } = fakeDecisionRouter({
      respond: (req) => decisionAnswers(req, { noul: { [`c${song}`]: 0.9, [`c${game}`]: 0.1 }, pick: '歌回', top: 0.9 }),
    });
    const { router: llmRouter, calls } = fakeRouter(async () => { throw new Error('主分类已定案'); });
    await new RulesClassifier(db, {
      getRouter: () => llmRouter,
      llmEnabled: () => true,
      getDecisionRouter: () => decisionRouter,
      decisionEnabled: () => true,
    }).classify(ctx());

    assert.equal(calls.length, 0);
    const primary = db.listPrimaryVerdicts('live', 'r1:1785310737');
    assert.equal(primary.length, 1, '主分类恰一行生效');
    assert.deepEqual(
      [primary[0]!.categoryId, primary[0]!.name, primary[0]!.source, primary[0]!.effective],
      [song, '歌回', 'decision', true],
    );
    assert.deepEqual(Object.keys(primary[0]!.distribution!), ['歌回', '游戏', '其他'], '分布按键落库');
    assert.equal(primary[0]!.distribution!['歌回'], 0.9);
    db.close();
  }
  // ② 低于门槛：不定案，交 LLM
  {
    const db = memDb(t);
    const song = db.upsertCategory(category({ name: '歌回', llmPrompt: '在唱歌', primary: true }));
    const game = db.upsertCategory(category({ name: '游戏', llmPrompt: '在打游戏', primary: true }));
    const { router: decisionRouter } = fakeDecisionRouter({
      respond: (req) => decisionAnswers(req, { noul: { [`c${song}`]: 0.9, [`c${game}`]: 0.1 }, pick: '歌回', top: 0.5 }),
    });
    const { router: llmRouter, calls } = fakeRouter(async (_req, parse) => parse!({
      results: [
        { id: song, match: true, evidence: '在唱' },
        { id: game, match: false, evidence: '没打游戏' },
      ],
      primary: { id: game, evidence: 'LLM 觉得更像游戏' },
    }));
    await new RulesClassifier(db, {
      getRouter: () => llmRouter,
      llmEnabled: () => true,
      getDecisionRouter: () => decisionRouter,
      decisionEnabled: () => true,
    }).classify(ctx());

    assert.equal(calls.length, 1, '主分类未定案 → 问 LLM');
    const primary = db.listPrimaryVerdicts('live', 'r1:1785310737');
    assert.deepEqual(
      primary.map((p) => [p.source, p.categoryId, p.effective]),
      [['decision', song, false], ['llm', game, true]],
      '未定案的决策主分类落库不生效，LLM 定案生效',
    );
    assert.equal(primary.filter((p) => p.effective).length, 1, '主分类至多一行生效');
    db.close();
  }
});

// ---- RulesClassifier 编排（直播）----

test('非 live_start 信号不判定（不调 LLM、不入库）', async (t) => {
  const db = memDb(t);
  db.upsertStreamer({ uid: '1', analyze: true });
  db.upsertCategory(category({ name: '歌回', llmPrompt: '在唱歌', keywords: ['歌'] }));
  const { router, calls } = fakeRouter(async () => { throw new Error('不该被调用'); });
  const clf = new RulesClassifier(db, { getRouter: () => router, llmEnabled: () => true });
  assert.deepEqual(await clf.classify(ctx('live_end')), []);
  assert.equal(calls.length, 0);
  assert.equal(db.listVerdicts('live', 'r1:1785310737').length, 0);
});

test('LLM 定案属于：结论生效入库（source=llm，effective=1），无确定性行', async (t) => {
  const db = memDb(t);
  db.upsertStreamer({ uid: '1', analyze: true });
  const catId = db.upsertCategory(category({ name: '歌回', llmPrompt: '在唱歌' }));
  const { router } = fakeRouter(async (_req, parse) =>
    parse!({ results: [{ id: catId, match: true, evidence: '主播在唱歌' }] }));
  const clf = new RulesClassifier(db, { getRouter: () => router, llmEnabled: () => true });

  const out = await clf.classify(ctx());
  assert.deepEqual(out, [
    { categoryId: catId, name: '歌回', source: 'llm', confidence: null, evidence: '主播在唱歌', pass: true, effective: true },
  ]);
  const v = db.listVerdicts('live', 'r1:1785310737');
  assert.equal(v.length, 1, '无确定性条件 + 模型定案 = 只有模型行');
  assert.equal(v[0]!.subjectType, 'live', '直播判定归档为 live 主体');
  assert.equal(v[0]!.subjectId, 'r1:1785310737', 'subject_id = room_id:live_time');
  assert.equal(v[0]!.ruleId, 0);
  assert.equal(v[0]!.source, 'llm');
  assert.equal(v[0]!.confidence, null, 'LLM 不给置信度');
  assert.equal(v[0]!.effective, true);
});

test('LLM 判否也落库（直播侧同样落 pass=0）：不回看确定性条件', async (t) => {
  const db = memDb(t);
  db.upsertStreamer({ uid: '1', analyze: true });
  const catId = db.upsertCategory(category({ name: '歌回', llmPrompt: '在唱歌', keywords: ['歌'] }));
  const { router } = fakeRouter(async (_req, parse) =>
    parse!({ results: [{ id: catId, match: false, evidence: '只是标题玩梗' }] }));
  const clf = new RulesClassifier(db, { getRouter: () => router, llmEnabled: () => true });

  assert.deepEqual(await clf.classify(ctx()), [], '判否不属于任何分类（返回值只含生效且属于）');
  const v = db.listVerdicts('live', 'r1:1785310737');
  assert.deepEqual(v.map((r) => [r.source, r.pass, r.effective]), [
    ['rule', true, false], // 确定性条件本可命中，但模型定案后不生效
    ['llm', false, true],
  ]);
  assert.equal(v.filter((r) => r.effective).length, 1, '每个分类恰一行生效');
});

test('router 抛错：回退确定性条件定案，模型档无行', async (t) => {
  const db = memDb(t);
  db.upsertStreamer({ uid: '1', analyze: true });
  const catId = db.upsertCategory(category({ name: '歌回', llmPrompt: '在唱歌', keywords: ['歌'] }));
  const { router } = fakeRouter(async () => { throw new Error('AllProvidersExhausted'); });
  const clf = new RulesClassifier(db, { getRouter: () => router, llmEnabled: () => true });

  const out = await clf.classify(ctx());
  assert.deepEqual(out.map((c) => [c.categoryId, c.source, c.effective]), [[catId, 'rule', true]]);
  const v = db.listVerdicts('live', 'r1:1785310737');
  assert.equal(v.length, 1, '模型档没跑出结论 = 没有模型行');
  assert.equal(v[0]!.source, 'rule');
  assert.equal(v[0]!.confidence, null, 'rule 路径置信度为 null');
  assert.equal(v[0]!.effective, true);
  assert.match(v[0]!.evidence, /模型不可用/);
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
      parse!({ results: [{ id: catId, match: false, evidence: 'LLM 说不是' }] }));
    const clf = new RulesClassifier(db, {
      getRouter: () => (withRouter ? router : null), llmEnabled: () => llmOn,
    });

    const out = await clf.classify(ctx());
    assert.deepEqual(out.map((c) => c.source), ['rule'], `${name}：走确定性路径`);
    assert.equal(calls.length, 0, `${name}：不调 LLM`);
    db.close();
  }
});

test('无 llmPrompt 的分类永远走确定性路径（即使 LLM 全可用），结论即生效', async (t) => {
  const db = memDb(t);
  db.upsertStreamer({ uid: '1', analyze: true });
  const catId = db.upsertCategory(category({ name: '歌回', keywords: ['歌'] }));
  const { router, calls } = fakeRouter(async () => { throw new Error('不该有 LLM 调用'); });
  const clf = new RulesClassifier(db, { getRouter: () => router, llmEnabled: () => true });

  const out = await clf.classify(ctx());
  assert.deepEqual(out.map((c) => [c.categoryId, c.source, c.effective]), [[catId, 'rule', true]]);
  assert.equal(calls.length, 0, '无提示词分类不进 LLM 批量调用');
});

test('禁用的分类不参与判定', async (t) => {
  const db = memDb(t);
  db.upsertStreamer({ uid: '1', analyze: true });
  db.upsertCategory(category({ name: '歌回', keywords: ['歌'], enabled: false }));
  const clf = new RulesClassifier(db, { getRouter: () => null, llmEnabled: () => true });
  assert.deepEqual(await clf.classify(ctx()), []);
});

test('verdicts 入库去重：同一场重复判定只留一条（唯一键含 source）', async (t) => {
  const db = memDb(t);
  db.upsertStreamer({ uid: '1', analyze: false });
  db.upsertCategory(category({ name: '歌回', keywords: ['歌'] }));
  const clf = new RulesClassifier(db, { getRouter: () => null, llmEnabled: () => true });
  await clf.classify(ctx());
  await clf.classify(ctx());
  assert.equal(db.listVerdicts('live', 'r1:1785310737').length, 1);
});

// ---- 主分类 ----

test('主分类：LLM 选中组内分类 → source=llm 的生效行', async (t) => {
  const db = memDb(t);
  const song = db.upsertCategory(category({ name: '歌回', llmPrompt: '在唱歌', primary: true }));
  const game = db.upsertCategory(category({ name: '游戏', llmPrompt: '在打游戏', primary: true }));
  const { router, calls } = fakeRouter(async (_req, parse) => parse!({
    results: [
      { id: song, match: true, evidence: '在唱歌' },
      { id: game, match: false, evidence: '没打游戏' },
    ],
    primary: { id: song, evidence: '整场都在唱' },
  }));
  const clf = new RulesClassifier(db, { getRouter: () => router, llmEnabled: () => true });

  await clf.classify(ctx());
  assert.match(requestText(calls[0]!), /主分类（单选/, '请求带主分类选项');
  const primary = db.listPrimaryVerdicts('live', 'r1:1785310737');
  assert.equal(primary.length, 1);
  assert.deepEqual(
    [primary[0]!.categoryId, primary[0]!.name, primary[0]!.source, primary[0]!.effective, primary[0]!.distribution],
    [song, '歌回', 'llm', true, null],
  );
  assert.equal(primary[0]!.evidence, '整场都在唱');
});

test('主分类：LLM 选「其他」→ categoryId=0', async (t) => {
  const db = memDb(t);
  const song = db.upsertCategory(category({ name: '歌回', llmPrompt: '在唱歌', primary: true }));
  const { router } = fakeRouter(async (_req, parse) => parse!({
    results: [{ id: song, match: false, evidence: '没在唱' }],
    primary: { id: PRIMARY_OTHER_ID, evidence: '都不像' },
  }));
  await new RulesClassifier(db, { getRouter: () => router, llmEnabled: () => true }).classify(ctx());
  const primary = db.listPrimaryVerdicts('live', 'r1:1785310737');
  assert.deepEqual([primary[0]!.categoryId, primary[0]!.name, primary[0]!.source], [0, '其他', 'llm']);
});

test('主分类：LLM 选不存在 id → 整份判失败，回退确定性主分类', async (t) => {
  const db = memDb(t);
  const song = db.upsertCategory(category({
    name: '歌回', llmPrompt: '在唱歌', keywords: ['歌'], primary: true,
  }));
  const { router } = fakeRouter(async (_req, parse) => parse!({
    results: [{ id: song, match: false, evidence: '没在唱' }],
    primary: { id: 999, evidence: '编造的选项' },
  }));
  const out = await new RulesClassifier(db, { getRouter: () => router, llmEnabled: () => true }).classify(ctx());
  assert.deepEqual(out.map((c) => c.source), ['rule'], '解析失败整份不用，确定性定案');
  const v = db.listVerdicts('live', 'r1:1785310737');
  assert.deepEqual(v.map((r) => r.source), ['rule'], '模型档无行');
  const primary = db.listPrimaryVerdicts('live', 'r1:1785310737');
  assert.deepEqual(
    [primary[0]!.categoryId, primary[0]!.name, primary[0]!.source, primary[0]!.effective],
    [song, '歌回', 'rule', true],
  );
});

test('主分类：确定性回退按分类排序取第一个「生效且属于」', async (t) => {
  const db = memDb(t);
  const first = db.upsertCategory(category({ name: '歌回', keywords: ['歌'], primary: true }));
  const second = db.upsertCategory(category({ name: '杂谈', keywords: ['聊'], primary: true }));
  db.upsertCategory(category({ name: '游戏', keywords: ['APEX'], primary: true }));
  const clf = new RulesClassifier(db, { getRouter: () => null, llmEnabled: () => true });

  await clf.classify(ctx()); // 标题「今晚歌回！」同时含「歌」
  const primary = db.listPrimaryVerdicts('live', 'r1:1785310737');
  assert.equal(primary.length, 1);
  assert.deepEqual([primary[0]!.categoryId, primary[0]!.source], [first, 'rule']);

  // 两者都命中时仍然取排序在前的一个（不被后出现的覆盖）
  db.upsertCategory({ id: second, keywords: ['歌', '聊'] });
  await new RulesClassifier(db, { getRouter: () => null, llmEnabled: () => true }).classify(ctx('live_start', { liveTime: 1_785_310_738 }));
  const p2 = db.listPrimaryVerdicts('live', 'r1:1785310738');
  assert.deepEqual([p2[0]!.categoryId, p2[0]!.name], [first, '歌回'], '按分类排序，不看命中顺序');
});

test('主分类：组内都不属于 → 「其他」', async (t) => {
  const db = memDb(t);
  db.upsertCategory(category({ name: '歌回', keywords: ['唱歌'], primary: true }));
  await new RulesClassifier(db, { getRouter: () => null, llmEnabled: () => true }).classify(ctx());
  const primary = db.listPrimaryVerdicts('live', 'r1:1785310737');
  assert.deepEqual([primary[0]!.categoryId, primary[0]!.name], [0, '其他']);
});

test('主分类：没有主分类组时不写主分类行', async (t) => {
  const db = memDb(t);
  const cat = db.upsertCategory(category({ name: '歌回', llmPrompt: '在唱歌' }));
  const { router } = fakeRouter(async (_req, parse) =>
    parse!({ results: [{ id: cat, match: true, evidence: '在唱' }] }));
  await new RulesClassifier(db, { getRouter: () => router, llmEnabled: () => true }).classify(ctx());
  assert.deepEqual(db.listPrimaryVerdicts('live', 'r1:1785310737'), []);
});

// ---- 生效行唯一性 + 审计 ----

test('每个（主体, 分类）恰一行 effective=1', async (t) => {
  const db = memDb(t);
  const withPrompt = db.upsertCategory(category({ name: '歌回', llmPrompt: '在唱歌', keywords: ['歌'] }));
  const pureModel = db.upsertCategory(category({ name: '杂谈', llmPrompt: '在杂谈' }));
  const pureRule = db.upsertCategory(category({ name: '分区命中', areas: ['Singer'] }));
  const { router } = fakeRouter(async (_req, parse) => parse!({
    results: [
      { id: withPrompt, match: true, evidence: '在唱歌' },
      { id: pureModel, match: false, evidence: '不是杂谈' },
    ],
  }));
  await new RulesClassifier(db, { getRouter: () => router, llmEnabled: () => true }).classify(ctx());

  const v = db.listVerdicts('live', 'r1:1785310737');
  for (const id of [withPrompt, pureModel, pureRule]) {
    const rows = v.filter((r) => r.categoryId === id);
    assert.equal(rows.filter((r) => r.effective).length, 1, `分类 ${id} 恰一行生效`);
  }
  assert.deepEqual(
    v.filter((r) => r.categoryId === withPrompt).map((r) => [r.source, r.effective]),
    [['rule', false], ['llm', true]],
    '非生效的确定性行也落库（回看判据）',
  );
});

test('审计记录逐来源结论、生效标记、回退原因与当时标准，后续修改分类不改历史', async (t) => {
  const db = memDb(t);
  const id = db.upsertCategory(category({ name: '自拍', appliesTo: 'post', keywords: ['自拍'], llmPrompt: '是自拍' }));
  const { router } = fakeRouter(async () => { throw new Error('connect ECONNREFUSED'); });
  await new RulesClassifier(db, { getRouter: () => router, llmEnabled: () => true }).classify(postCtx());
  db.upsertCategory({ id, llmPrompt: '新的标准' });
  const audit = db.getContentAudit('post', 'twitter:9001')!;
  assert.equal(audit.analysis!.status, 'done');
  assert.deepEqual(
    audit.analysis!.results.map((r) => [r.source, r.pass, r.effective]),
    [['rule', false, true]],
  );
  assert.equal(audit.analysis!.categories[0]!.llmPrompt, '是自拍');
  assert.match(audit.analysis!.fallbackReason!, /ECONNREFUSED/);
  assert.equal(audit.analysis!.input!.text, '今晚有直播');
  assert.equal(audit.analysis!.primary, undefined, '没有主分类组就没有主分类审计段');
});

test('漏返分类触发确定性回退并记录解析失败原因', async (t) => {
  const db = memDb(t);
  const id = db.upsertCategory(category({ name: '预告', appliesTo: 'post', keywords: ['直播'], llmPrompt: '是预告' }));
  const { router } = fakeRouter(async (_req, parse) => parse!({ results: [] }));
  const result = await new RulesClassifier(db, { getRouter: () => router, llmEnabled: () => true }).classify(postCtx());
  assert.equal(result[0]!.categoryId, id);
  assert.equal(result[0]!.source, 'rule');
  assert.match(db.getContentAudit('post', 'twitter:9001')!.analysis!.fallbackReason!, /不完整/);
});

// ---- post 判定归档：feed_post 同走判决链，verdicts 落真实 categoryId、ruleId=0 哨兵 ----

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
  const clf = new RulesClassifier(db, { getRouter: () => null, llmEnabled: () => true });

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
  assert.equal(v[0]!.effective, true);
});

test('post 侧判否也落 pass=0（与直播同一口径）；classify 只返回生效属于', async (t) => {
  const db = memDb(t);
  const catId = db.upsertCategory(category({ name: '直播预告', appliesTo: 'post', llmPrompt: '是直播预告' }));
  const { router } = fakeRouter(async (_req, parse) =>
    parse!({ results: [{ id: catId, match: false, evidence: '只是日常闲聊' }] }));
  const clf = new RulesClassifier(db, { getRouter: () => router, llmEnabled: () => true });

  assert.deepEqual(await clf.classify(postCtx()), [], '判否不属于任何分类（返回值只含属于）');
  const v = db.listVerdicts('post', 'twitter:9001');
  assert.equal(v.length, 1, '判否也落档');
  assert.equal(v[0]!.pass, false, '判否 = 0 落库');
  assert.equal(v[0]!.evidence, '只是日常闲聊');
  assert.equal(v[0]!.source, 'llm');
  assert.equal(v[0]!.effective, true);
});

test('post 判定去重：同一帖重复判定只留一条（UNIQUE 身份键）', async (t) => {
  const db = memDb(t);
  db.upsertCategory(category({ name: '直播预告', appliesTo: 'post', keywords: ['直播'] }));
  const clf = new RulesClassifier(db, { getRouter: () => null, llmEnabled: () => true });
  await clf.classify(postCtx());
  await clf.classify(postCtx());
  assert.equal(db.listVerdicts('post', 'twitter:9001').length, 1);
});

// ---- 视觉输入：ctx.images 是两种内容共用的入口，送模型张数与拦截原因分开记 ----

test('ctx.images → ContentItem：imageCount = 送模型的张数，被拦下的图逐张进 skippedImages', async (t) => {
  const db = memDb(t);
  const catId = db.upsertCategory(category({ name: '直播预告', appliesTo: 'post', keywords: ['直播'], llmPrompt: '直播预告帖' }));
  const { router, calls } = fakeRouter(async (_req, parse) =>
    parse!({ results: [{ id: catId, match: true, evidence: '有图有文' }] }));
  await new RulesClassifier(db, { getRouter: () => router, llmEnabled: () => true }).classify({
    ...postCtx(),
    images: {
      dataUrls: ['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB'],
      skipped: [{ ref: 'broken.jpg', reason: '无法解码' }],
    },
  });

  const content = calls[0]!.messages[1]!.content;
  assert.ok(Array.isArray(content));
  assert.deepEqual(
    content.filter((p) => p.type === 'image_url').map((p) => (p.type === 'image_url' ? p.image_url.url : '')),
    ['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB'],
    'LLM 请求拿到的是规范化后的 data URL',
  );
  const audit = db.getContentAudit('post', 'twitter:9001')!.analysis!;
  assert.equal(audit.imageCount, 2, 'imageCount = 实际送模型的张数');
  assert.deepEqual(audit.skippedImages, [{ ref: 'broken.jpg', reason: '无法解码' }]);
});

test('无 ctx.images：按无图判定，imageCount=0 且不写 skippedImages', async (t) => {
  const db = memDb(t);
  db.upsertCategory(category({ name: '直播预告', appliesTo: 'post', keywords: ['直播'] }));
  await new RulesClassifier(db, { getRouter: () => null, llmEnabled: () => true }).classify(postCtx());
  const audit = db.getContentAudit('post', 'twitter:9001')!.analysis!;
  assert.equal(audit.imageCount, 0);
  assert.equal(audit.skippedImages, undefined);
});

/** 类型自检：Classification 的 pass/effective 必填（编译期约束，运行时无副作用） */
const _typecheck: Classification = {
  categoryId: 0, name: '', source: 'rule', confidence: null, evidence: '', pass: false, effective: false,
};
void _typecheck;
