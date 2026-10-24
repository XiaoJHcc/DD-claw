/**
 * 分类草稿试跑（panel/category-test.ts）的契约回归：
 * 三档独立 / 灰区不定案 / 无判定描述跳过 / 开关与未配置不可用 / 样本过滤 /
 * 图片口径（缺省加载器真的本地化 + 规范化）/ 不写库（草稿未保存）/ 样本串行。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { Db } from '../core/db.js';
import { DEFAULT_DECISION_THRESHOLDS } from '../analysis/tasks/decide.js';
import type { DecisionRouter } from '../analysis/decision-router.js';
import type { DecisionProviderConfig } from '../config/schema.js';
import type { SystemOneRequest, SystemOneResponse } from '../analysis/decision-providers.js';
import type { LlmRequest, LlmRouter } from '../analysis/providers.js';
import type { PreparedImages } from '../analysis/image-prep.js';
import {
  parseCategorySampleRequest, parseCategoryTestRequest, runCategoryTest, sampleCategoryRecords,
  type AnalysisGate, type CategoryTestDeps, type CategoryTestResponse, type ImageLoader, type PendingImage,
} from './category-test.js';

// ---- 夹具 ----

function memDb(t: import('node:test').TestContext): Db {
  const db = new Db(':memory:');
  t.after(() => db.close());
  return db;
}

/**
 * 直播场次：三场，主播 uid / 开播时间 / 标题分区各不相同（过滤与随机取样的素材）。
 * r3 **没有任何图**（无关键帧无封面）：试判列表要缩略图，它不进随机抽样池，
 * 只能作为「旧锚点」被 sampleIds 精确点名（那时 `image` 回 null）。
 */
function seedLive(db: Db): void {
  db.upsertStreamer({ uid: '1', uname: '主播一', alias: '小一' });
  db.recordSession({
    roomId: 'r1', liveTime: 1_700_000_000, uid: '1', uname: '主播一', title: '今晚歌回！',
    areaName: '唱见', parentAreaName: '虚拟主播', keyframe: 'k1.jpg', cover: 'c1.jpg',
  });
  db.recordSession({
    roomId: 'r2', liveTime: 1_700_100_000, uid: '2', uname: '主播二', title: '来打游戏',
    areaName: '单机', parentAreaName: '单机游戏', cover: 'c2.jpg',
  });
  db.recordSession({
    roomId: 'r3', liveTime: 1_700_200_000, uid: '3', uname: '主播三', title: '随便聊聊',
    areaName: '杂谈', parentAreaName: '虚拟主播',
  });
}

/**
 * 图文帖：X（两张图 / 带引用）/ 微博（一张图）/ B站动态（**无配图**）各一条，账号名单补展示名。
 * d1 是「纯文字动态」：不进随机抽样池，只能被 sampleIds 精确点名。
 */
function seedPosts(db: Db): void {
  const x = db.upsertXAccount({ screenName: 'alice', displayName: null, biliUid: null, enabled: true });
  db.touchXAccount(x, { nickname: '爱丽丝' });
  db.upsertWeiboAccount({ uid: '2203177060', nickname: '微小微', biliUid: null, enabled: true });
  db.insertPosts([
    {
      platform: 'twitter', uid: 'alice', itemId: 't1', type: 'tweet', text: '今天也在唱歌',
      pics: ['https://pbs.twimg.com/a.jpg', 'https://pbs.twimg.com/b.jpg'],
      pubTs: 100, url: 'https://x.com/alice/status/t1', raw: '{"isQuote":true}',
    },
    { platform: 'weibo', uid: '2203177060', itemId: 'm1', type: 'mblog', text: '微博正文', pics: ['https://wx1.sinaimg.cn/m.jpg'], pubTs: 200, url: null, raw: null },
    { platform: 'bili_dynamic', uid: '1', itemId: 'd1', type: 'DYNAMIC_TYPE_WORD', text: '动态正文', pics: [], pubTs: 300, url: null, raw: null },
  ]);
}

const noImages: ImageLoader = async () => ({ dataUrls: [], skipped: [] });

function deps(db: Db, over: Partial<CategoryTestDeps> = {}): CategoryTestDeps {
  return {
    db,
    queue: { run: <T>(fn: () => Promise<T>) => fn() },
    getRouter: () => null,
    llmEnabled: () => false,
    getDecisionRouter: () => null,
    decisionEnabled: () => false,
    decisionThresholds: () => DEFAULT_DECISION_THRESHOLDS,
    getProxyUrl: () => '',
    imageLoader: noImages,
    ...over,
  };
}

/** 假 LLM 路由：只实现 completeJson（试跑只走这一个方法），按 raw 走真实 parse */
function fakeRouter(impl: (req: LlmRequest) => unknown): { router: LlmRouter; calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  const router = {
    completeJson: (req: LlmRequest, parse?: (raw: unknown) => unknown) => {
      calls.push(req);
      return Promise.resolve(parse!(impl(req)));
    },
  } as unknown as LlmRouter;
  return { router, calls };
}

/** 判定描述 → LLM 结论（match + 证据）：试跑只带一个分类，回一行就够 */
function llmMatch(match: boolean, evidence: string) {
  return (req: LlmRequest): unknown => {
    const text = requestText(req);
    const id = Number(/- id=(-?\d+)/.exec(text)![1]);
    return { results: [{ id, match, evidence }] };
  };
}

/** 请求 user 文本（第一个 text 部件） */
function requestText(req: LlmRequest): string {
  const content = req.messages[1]!.content;
  assert.ok(Array.isArray(content));
  const part = content.find((p) => p.type === 'text');
  assert.ok(part && part.type === 'text');
  return part.type === 'text' ? part.text : '';
}

const DECISION_SPEC: DecisionProviderConfig = {
  name: 'jev', baseURL: 'https://api.typesafe.ai/v1', model: 'jev-1.14.0',
  protocol: 'systemone', vision: false, enabled: true,
};

/** 假决策路由：noul 一律回同一个概率（试跑只问一道题）；throwOnCall = 整档失败 */
function fakeDecisionRouter(p: number | null): { router: DecisionRouter; requests: SystemOneRequest[] } {
  const requests: SystemOneRequest[] = [];
  const router = {
    decide: async (
      build: (withImages: boolean, spec: DecisionProviderConfig) => { req: SystemOneRequest; assets?: unknown },
      _opts: { hasImages: boolean },
      validate: (res: SystemOneResponse) => void,
    ) => {
      const call = build(false, DECISION_SPEC);
      requests.push(call.req);
      if (p === null) throw new Error('决策端点 500');
      const answers: Record<string, { type: 'noul'; noul: number }> = {};
      for (const [key, q] of Object.entries(call.req.questions)) {
        if (q.type === 'noul') answers[key] = { type: 'noul', noul: p };
      }
      const response: SystemOneResponse = { model: 'jev-1.13.0', answers };
      validate(response);
      return { response, provider: DECISION_SPEC, withImages: false };
    },
  } as unknown as DecisionRouter;
  return { router, requests };
}

/** 三档一起开：返回试跑结果 + 两边的请求记录 */
async function runLive(
  db: Db,
  category: Record<string, unknown>,
  opts: {
    llm?: { match: boolean; evidence: string } | null;
    /** null = 决策调用抛错（整档失败） */
    decision?: number | null;
    filter?: Record<string, unknown>;
    /** 复测锚点（顺序即判定顺序） */
    sampleIds?: string[];
    deps?: Partial<CategoryTestDeps>;
  } = {},
): Promise<{ samples: CategoryTestResponse['samples']; llmCalls: LlmRequest[]; decisionCalls: SystemOneRequest[] }> {
  const llm = opts.llm === undefined ? { match: true, evidence: '在唱歌' } : opts.llm;
  const decision = opts.decision === undefined ? 0.1 : opts.decision;
  const { router: llmRouter, calls: llmCalls } = fakeRouter(llm === null
    ? () => { throw new Error('boom'); }
    : llmMatch(llm.match, llm.evidence));
  const { router: decisionRouter, requests: decisionCalls } = fakeDecisionRouter(decision);
  const d = deps(db, {
    getRouter: () => llmRouter,
    llmEnabled: () => true,
    getDecisionRouter: () => decisionRouter,
    decisionEnabled: () => true,
    ...opts.deps,
  });
  const res = await runCategoryTest(d, {
    category,
    ...(opts.filter ? { filter: opts.filter } : {}),
    ...(opts.sampleIds ? { sampleIds: opts.sampleIds } : {}),
  });
  return { samples: res.samples, llmCalls, decisionCalls };
}

// ---- 请求解析 ----

test('parseCategoryTestRequest：草稿走新建分类同一套校验，合成 id 不是 0 哨兵', () => {
  const { category, filter } = parseCategoryTestRequest({ category: { keywords: ['歌回'] } });
  assert.equal(category.id, -1, '0 是「不适用 / 其他」哨兵，草稿用负数');
  assert.equal(category.appliesTo, 'live');
  assert.equal(category.condMode, 'and');
  assert.equal(category.name, '草稿分类', '没填名字时给个可读的临时名');
  assert.deepEqual(filter, { limit: 10 }, 'limit 缺省 10');

  assert.throws(
    () => parseCategoryTestRequest({ category: {} }),
    /至少配置判定描述或一组确定性条件/,
    '死草稿直接 400（与新建分类同一条校验）',
  );
  assert.throws(() => parseCategoryTestRequest({ category: { keywords: ['x'] }, nope: 1 }), /未知字段: nope/);
});

test('parseCategoryTestRequest：filter 的 limit / 时间 / 平台 / uid 校验', () => {
  assert.equal(parseCategoryTestRequest({ category: { keywords: ['x'] }, filter: { limit: 20 } }).filter.limit, 20);
  assert.throws(() => parseCategoryTestRequest({ category: { keywords: ['x'] }, filter: { limit: 0 } }), /1~20/);
  assert.throws(() => parseCategoryTestRequest({ category: { keywords: ['x'] }, filter: { limit: 21 } }), /1~20/);
  assert.throws(
    () => parseCategoryTestRequest({ category: { keywords: ['x'] }, filter: { fromTs: 9, toTs: 5 } }),
    /不能晚于/,
  );
  assert.throws(
    () => parseCategoryTestRequest({ category: { keywords: ['x'] }, filter: { platform: 'bili' } }),
    /platform 必须是/,
  );
  assert.throws(
    () => parseCategoryTestRequest({ category: { keywords: ['x'] }, filter: { uid: 'alice' } }),
    /纯数字主播 uid/,
    '直播样本的 uid 是主播 uid',
  );
  // 图文分类的 uid 可以是 X screen name
  assert.equal(
    parseCategoryTestRequest({ category: { appliesTo: 'post', keywords: ['x'] }, filter: { uid: 'alice' } }).filter.uid,
    'alice',
  );
  assert.throws(
    () => parseCategoryTestRequest({ category: { appliesTo: 'post', keywords: ['x'] }, filter: { uid: '  ' } }),
    /非空字符串/,
  );
});

// ---- 三档独立 ----

test('三档独立：rule / llm / decision 各有结论，互不覆盖', async (t) => {
  const db = memDb(t);
  seedLive(db);
  const { samples, llmCalls, decisionCalls } = await runLive(
    db,
    { keywords: ['歌回'], llmPrompt: '以唱歌为主' },
    { filter: { uid: '1' }, llm: { match: true, evidence: '在唱歌' }, decision: 0.1 },
  );
  assert.equal(samples.length, 1);
  const sample = samples[0]!;
  assert.deepEqual(sample.results.map((r) => r.source), ['rule', 'llm', 'decision'], '三档恒在，顺序固定');

  const [rule, llm, decision] = sample.results;
  assert.equal(rule!.status, 'ok');
  assert.equal(rule!.pass, true);
  assert.equal(rule!.decided, true);
  assert.match(rule!.evidence!, /关键词「歌回」/);

  assert.equal(llm!.status, 'ok');
  assert.equal(llm!.pass, true, 'LLM 定案为「是」，决策档的「否」不影响它');
  assert.equal(llm!.confidence, null, 'LLM 自报置信度不采信');
  assert.equal(llm!.decided, true);

  assert.equal(decision!.status, 'ok');
  assert.equal(decision!.pass, false, '决策档的结论独立保留');
  assert.equal(decision!.confidence, 0.1, 'P(属于) 原样回给面板');
  assert.equal(decision!.decided, true);

  assert.equal(llmCalls.length, 1);
  assert.equal(decisionCalls.length, 1);
  assert.equal(sample.authorName, '主播一', '直播样本的作者名 = uname（缺省回退 alias）');
  assert.equal(sample.text, '今晚歌回！');
  assert.deepEqual(sample.tags, { area: '唱见', parentArea: '虚拟主播' }, '分区标签带首段父分区');
});

test('灰区：决策档有结论但不定案，confidence 保留', async (t) => {
  const db = memDb(t);
  seedLive(db);
  const { samples } = await runLive(db, { llmPrompt: '以唱歌为主' }, {
    filter: { uid: '1', limit: 1 }, decision: 0.5,
  });
  const decision = samples[0]!.results.find((r) => r.source === 'decision')!;
  assert.equal(decision.status, 'ok');
  assert.equal(decision.pass, true, 'p ≥ 0.5 就是「属于」');
  assert.equal(decision.confidence, 0.5);
  assert.equal(decision.decided, false, '灰区不定案（线上要交下一档）');
  assert.match(decision.evidence!, /灰区/);
});

test('无判定描述：两个模型档 skipped，确定性档照跑', async (t) => {
  const db = memDb(t);
  seedLive(db);
  const { samples } = await runLive(db, { keywords: ['打游戏'] }, { filter: { uid: '2', limit: 1 } });
  const sample = samples[0]!;
  assert.equal(sample.results.length, 3);
  assert.equal(sample.results[0]!.status, 'ok', 'rule 不依赖判定描述');
  assert.equal(sample.results[0]!.pass, true);
  for (const tier of sample.results.slice(1)) {
    assert.equal(tier.status, 'skipped', `${tier.source} 不该问模型`);
    assert.equal(tier.reason, '未填写判定描述');
    assert.equal(tier.pass, null);
    assert.equal(tier.decided, false);
  }
});

test('模型档不可用：开关关 / 未配置 / 调用失败都回 unavailable + 回调原因', async (t) => {
  const db = memDb(t);
  seedLive(db);
  const live = { keywords: ['歌回'], llmPrompt: '以唱歌为主' };
  const only = async (over: Partial<CategoryTestDeps>): Promise<CategoryTestResponse['samples'][number]['results']> => {
    const { samples } = await runLive(db, live, { filter: { uid: '1', limit: 1 }, deps: over });
    return samples[0]!.results;
  };

  // 总开关关（线上判决链的文案由 onFallback 给出）
  const offResults = await only({ llmEnabled: () => false, decisionEnabled: () => false });
  assert.equal(offResults[1]!.status, 'unavailable');
  assert.match(offResults[1]!.reason!, /LLM 总开关关闭/);
  assert.equal(offResults[2]!.status, 'unavailable');
  assert.match(offResults[2]!.reason!, /决策模型总开关关闭/);
  assert.equal(offResults[0]!.status, 'ok', '模型不可用不影响确定性档');

  // 未配置 provider
  const noneResults = await only({ getRouter: () => null, getDecisionRouter: () => null });
  assert.match(noneResults[1]!.reason!, /未配置 LLM provider/);
  assert.match(noneResults[2]!.reason!, /未配置决策模型供应商/);

  // 调用失败
  const failResults = await only({
    getRouter: () => fakeRouter(() => { throw new Error('endpoint down'); }).router,
    getDecisionRouter: () => fakeDecisionRouter(null).router,
  });
  assert.equal(failResults[1]!.status, 'unavailable');
  assert.match(failResults[1]!.reason!, /endpoint down/);
  assert.equal(failResults[2]!.status, 'unavailable');
  assert.match(failResults[2]!.reason!, /决策端点 500/);
});

test('草稿不会落库：verdicts / primary_verdicts / content_audit / categories 行数不变', async (t) => {
  const db = memDb(t);
  seedLive(db);
  const counts = () => ({
    categories: (db.raw.prepare('SELECT COUNT(*) AS n FROM categories').get() as { n: number }).n,
    verdicts: (db.raw.prepare('SELECT COUNT(*) AS n FROM verdicts').get() as { n: number }).n,
    primary: (db.raw.prepare('SELECT COUNT(*) AS n FROM primary_verdicts').get() as { n: number }).n,
    audit: (db.raw.prepare('SELECT COUNT(*) AS n FROM content_audit').get() as { n: number }).n,
  });
  const before = counts();
  await runLive(db, { keywords: ['歌回'], llmPrompt: '以唱歌为主' }, { filter: { limit: 2 } });
  assert.deepEqual(counts(), before, '试跑只读：判定表 / 审计表 / 分类表都不动');
  assert.equal(db.getContentAudit('live', 'r1:1700000000'), null, '也不写审计');
});

test('合成草稿 id 进 prompt 时不是 0 哨兵', async (t) => {
  const db = memDb(t);
  seedLive(db);
  const { llmCalls, decisionCalls } = await runLive(db, { llmPrompt: '以唱歌为主' }, {
    filter: { uid: '1', limit: 1 },
  });
  assert.match(requestText(llmCalls[0]!), /- id=-1 「草稿分类」：以唱歌为主/);
  assert.ok(JSON.stringify(decisionCalls[0]!.questions).includes('c-1'), '决策题目键同样用 -1');
});

// ---- 过滤与样本形态 ----

test('样本过滤：uid / fromTs / toTs / limit 都作用在归档上', async (t) => {
  const db = memDb(t);
  seedLive(db);
  const category = { keywords: ['歌回'] };
  const ids = async (filter: Record<string, unknown>): Promise<string[]> =>
    (await runLive(db, category, { filter })).samples.map((s) => s.subjectId).sort();
  assert.deepEqual(await ids({ limit: 10 }), ['r1:1700000000', 'r2:1700100000']);
  assert.deepEqual(await ids({ uid: '2' }), ['r2:1700100000']);
  assert.deepEqual(await ids({ fromTs: 1_700_050_000 }), ['r2:1700100000']);
  assert.deepEqual(await ids({ toTs: 1_700_050_000 }), ['r1:1700000000']);
  assert.equal((await ids({ limit: 1 })).length, 1);
});

test('图文样本：身份键 / 账号展示名 / X raw 的 isQuote / 图片位序标签 / 缩略图源图', async (t) => {
  const db = memDb(t);
  seedPosts(db);
  const seen: PendingImage[][] = [];
  const loader: ImageLoader = async (images) => {
    seen.push(images);
    return { dataUrls: [], skipped: [{ ref: images[0]?.ref ?? '#1', reason: '下载失败' }] };
  };
  const { samples } = await runCategoryTest(deps(db, { imageLoader: loader }), {
    category: { appliesTo: 'post', llmPrompt: '发的是自拍' },
    filter: { platform: 'twitter', uid: 'alice', limit: 10 },
  });
  assert.equal(samples.length, 1);
  const sample = samples[0]!;
  assert.equal(sample.subjectType, 'post');
  assert.equal(sample.subjectId, 'twitter:t1');
  assert.equal(sample.authorName, '@alice', 'X 作者名带 @（与推送文案同一投影）');
  assert.equal(sample.tags.isQuote, 'true', 'isQuote 从 posts.raw 读出来');
  assert.equal(sample.tags.platform, 'twitter');
  assert.equal(sample.tags.hasMedia, 'true');
  assert.equal(sample.image, 'https://pbs.twimg.com/a.jpg', '缩略图取第一张配图');
  assert.deepEqual(sample.skippedImages, [{ ref: 'pic#1', reason: '下载失败' }]);
  assert.equal(sample.imageCount, 0, '图没送出去就是 0 张');
  assert.deepEqual(seen[0]!.map((i) => [i.ref, i.viaProxy]), [['pic#1', true], ['pic#2', true]], 'X 图走代理');

  // 微博帖：展示名走账号名单（displayName → nickname），图直连
  const weiboSeen: PendingImage[][] = [];
  const weiboLoader: ImageLoader = async (images) => { weiboSeen.push(images); return { dataUrls: [], skipped: [] }; };
  const { samples: weibo } = await runCategoryTest(deps(db, { imageLoader: weiboLoader }), {
    category: { appliesTo: 'post', keywords: ['微博'] },
    filter: { platform: 'weibo' },
  });
  assert.equal(weibo[0]!.authorName, '微小微');
  assert.equal(weibo[0]!.tags.isQuote, 'unknown', '非 X 平台不提供引用状态');
  assert.equal(weibo[0]!.image, 'https://wx1.sinaimg.cn/m.jpg');
  assert.deepEqual(
    weiboSeen[0]!.map((i) => [i.ref, i.viaProxy]),
    [['pic#1', false]],
    '微博图直连（X 之外不走代理）',
  );
});

test('抽样池只收带图记录：无图场次 / 纯文字动态抽不到，但旧锚点仍可精确复测（image=null）', async (t) => {
  const db = memDb(t);
  seedLive(db);
  seedPosts(db);
  const loads: PendingImage[][] = [];
  const loader: ImageLoader = async (images) => { loads.push(images); return { dataUrls: [], skipped: [] }; };
  const d = deps(db, { imageLoader: loader });

  // 随机抽样：r3（无图）/ d1（无配图）永不出现，且反复抽也不会混进来
  for (let i = 0; i < 5; i++) {
    const live = sampleCategoryRecords(d, { kind: 'live', limit: 20 }).samples.map((s) => s.subjectId);
    assert.ok(!live.includes('r3:1700200000'), '无关键帧无封面的场次不进抽样池');
    assert.deepEqual(live.slice().sort(), ['r1:1700000000', 'r2:1700100000']);
  }
  assert.deepEqual(sampleCategoryRecords(d, { kind: 'live', uid: '3' }).samples, [], '指名也没用：池子先过滤');
  assert.deepEqual(sampleCategoryRecords(d, { kind: 'post', platform: 'bili_dynamic' }).samples, [], '纯文字动态不进池');

  // 旧锚点（当年抽中、现在没图）：精确复测放行，摘要 image = null，也不会有图送模型
  const retest = await runCategoryTest(d, {
    category: { keywords: ['聊聊'] },
    sampleIds: ['r3:1700200000'],
  });
  assert.equal(retest.samples[0]!.subjectId, 'r3:1700200000');
  assert.equal(retest.samples[0]!.image, null, '无图记录没有缩略图');
  assert.equal(retest.samples[0]!.imageCount, 0);
  assert.deepEqual(loads[0], [], '没有待下图就不调加载器');
  const legacyPost = await runCategoryTest(d, {
    category: { appliesTo: 'post', keywords: ['动态'] },
    sampleIds: ['bili_dynamic:d1'],
  });
  assert.equal(legacyPost.samples[0]!.image, null);
  assert.equal(legacyPost.samples[0]!.imageCount, 0);
});

test('图片口径：live 取 keyframe，缺则 cover；准备好的图进 imageCount', async (t) => {
  const db = memDb(t);
  seedLive(db);
  const seen: PendingImage[][] = [];
  const loader: ImageLoader = async (images) => {
    seen.push(images);
    const prepared: PreparedImages = { dataUrls: ['data:image/jpeg;base64,AAA'], skipped: [] };
    return prepared;
  };
  const { samples } = await runCategoryTest(deps(db, { imageLoader: loader }), {
    category: { keywords: ['歌回'] },
    filter: { limit: 10 },
  });
  const refs = samples
    .map((s, i) => ({ id: s.subjectId, refs: seen[i]!.map((x) => x.ref), imageCount: s.imageCount }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  assert.deepEqual(refs, [
    { id: 'r1:1700000000', refs: ['keyframe'], imageCount: 1 },
    { id: 'r2:1700100000', refs: ['cover'], imageCount: 1 },
  ]);
});

// ---- 串行 ----

test('样本串行：多条样本时模型调用不重叠（共享队列的并发上限 2 之外，试跑自身串行）', async (t) => {
  const db = memDb(t);
  seedLive(db);
  let active = 0;
  let peak = 0;
  const gate: AnalysisGate = {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      active++;
      peak = Math.max(peak, active);
      try {
        return await fn();
      } finally {
        active--;
      }
    },
  };
  const { samples } = await runLive(db, { llmPrompt: '以唱歌为主' }, { filter: { limit: 10 }, deps: { queue: gate } });
  assert.equal(samples.length, 2);
  assert.equal(peak, 1, '逐条串行：一次只有一条样本在跑');
});

// ---- 缺省图片加载器（本地化 → prepareImageFiles，不联网：本地 HTTP 冒充图床）----

test('缺省图片加载：合法图经本地化 + 规范化成为视觉输入，坏图记 skipped 且不回 dataURL/URL', async (t) => {
  const db = memDb(t);
  seedLive(db);
  // 300×300 的合法 JPEG：prepareImage 的边长下限是 280，正好落在合规区间
  const jpeg = await sharp({
    create: { width: 300, height: 300, channels: 3, background: '#ffffff' },
  }).jpeg().toBuffer();
  const imageServer = http.createServer((req, res) => {
    if (req.url === '/bad.jpg') {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end(Buffer.from('not-an-image'));
      return;
    }
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    res.end(jpeg);
  });
  await new Promise<void>((resolve) => imageServer.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => imageServer.close(() => resolve()));
  });
  const origin = `http://127.0.0.1:${(imageServer.address() as AddressInfo).port}`;
  const cacheDir = mkdtempSync(join(tmpdir(), 'ddclaw-cat-test-'));
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));

  // 样本的图指向本地服务：r1 好图（keyframe）、r2 坏图（cover）
  db.raw.prepare("UPDATE live_sessions SET keyframe = ? WHERE room_id = 'r1'").run(`${origin}/ok.jpg`);
  db.raw.prepare("UPDATE live_sessions SET cover = ? WHERE room_id = 'r2'").run(`${origin}/bad.jpg`);

  const res = await runCategoryTest(deps(db, { imageLoader: undefined, imageCacheDir: cacheDir }), {
    category: { keywords: ['歌回'] },
    filter: { limit: 10 },
  });
  const byId = new Map(res.samples.map((s) => [s.subjectId, s]));
  const ok = byId.get('r1:1700000000')!;
  assert.equal(ok.imageCount, 1, '合规 JPEG 经 prepareImageFiles 成为视觉输入');
  assert.deepEqual(ok.skippedImages, [], '成功的那张不进 skipped');
  const bad = byId.get('r2:1700100000')!;
  assert.equal(bad.imageCount, 0);
  assert.deepEqual(bad.skippedImages, [{ ref: 'cover', reason: '无法解码' }], 'skipped 的 ref 回填成稳定标签');

  const body = JSON.stringify(res);
  assert.ok(!body.includes('data:image'), '只回摘要：dataURL 绝不出现在响应里');
  // 唯一允许回给调用方的图源是摘要的 image（列表缩略图）；其余位置不得出现图床地址
  assert.deepEqual(
    res.samples.map((s) => s.image).sort(),
    [`${origin}/bad.jpg`, `${origin}/ok.jpg`],
    '缩略图源图就是本次要送模型的那张',
  );
  const withoutImage = JSON.stringify(res.samples.map(({ image: _image, ...rest }) => rest));
  assert.ok(!withoutImage.includes(origin), '除 image 之外，图床 URL 不回给调用方');
});

// ---- 两段式：先抽样（只回摘要），再按锚点复测同一条内容 ----

test('抽样：只回样本摘要，零模型调用、零下图、不写库；只要 kind + 过滤面', (t) => {
  const db = memDb(t);
  seedLive(db);
  seedPosts(db);
  const touched = { gate: 0, router: 0, decision: 0, images: 0 };
  const d = deps(db, {
    queue: { run: async <T>(fn: () => Promise<T>): Promise<T> => { touched.gate++; return fn(); } },
    getRouter: () => { touched.router++; return null; },
    getDecisionRouter: () => { touched.decision++; return null; },
    imageLoader: async () => { touched.images++; return { dataUrls: [], skipped: [] }; },
  });
  const counts = () => ({
    categories: (db.raw.prepare('SELECT COUNT(*) AS n FROM categories').get() as { n: number }).n,
    verdicts: (db.raw.prepare('SELECT COUNT(*) AS n FROM verdicts').get() as { n: number }).n,
    audit: (db.raw.prepare('SELECT COUNT(*) AS n FROM content_audit').get() as { n: number }).n,
  });
  const before = counts();

  const live = sampleCategoryRecords(d, { kind: 'live', limit: 10 });
  assert.equal(live.samples.length, 2);
  const byId = new Map(live.samples.map((s) => [s.subjectId, s]));
  assert.deepEqual([...byId.keys()].sort(), ['r1:1700000000', 'r2:1700100000']);
  assert.deepEqual(byId.get('r1:1700000000'), {
    subjectType: 'live',
    subjectId: 'r1:1700000000',
    uid: '1',
    authorName: '主播一',
    image: 'k1.jpg',
    text: '今晚歌回！',
    tags: { area: '唱见', parentArea: '虚拟主播' },
    url: 'https://live.bilibili.com/r1',
    ts: 1_700_000_000,
  });
  assert.deepEqual(
    Object.keys(byId.get('r1:1700000000')!).sort(),
    ['authorName', 'image', 'subjectId', 'subjectType', 'tags', 'text', 'ts', 'uid', 'url'],
    '摘要里没有结果，但带一张缩略图源图',
  );

  // 图文：身份键与展示名/标签与判定输入同源
  const posts = sampleCategoryRecords(d, { kind: 'post', platform: 'twitter' });
  assert.deepEqual(posts.samples.map((s) => s.subjectId), ['twitter:t1']);
  assert.equal(posts.samples[0]!.authorName, '@alice');
  assert.equal(posts.samples[0]!.tags.isQuote, 'true');

  // 缩略图源图：live = keyframe || cover（r2 没有关键帧 → 用封面），post = 首张配图
  assert.equal(byId.get('r1:1700000000')!.image, 'k1.jpg', '有关键帧就用关键帧');
  assert.equal(byId.get('r2:1700100000')!.image, 'c2.jpg', '没有关键帧回落到封面');
  assert.equal(posts.samples[0]!.image, 'https://pbs.twimg.com/a.jpg', '图文取第一张配图');
  assert.equal(
    sampleCategoryRecords(d, { kind: 'post', platform: 'weibo' }).samples[0]!.image,
    'https://wx1.sinaimg.cn/m.jpg',
  );
  assert.ok(
    sampleCategoryRecords(d, { kind: 'live', limit: 20 }).samples.every((s) => s.image !== null),
    '抽样池保证每行都有缩略图',
  );

  // 过滤面照常生效（uid / 时间 / 条数）；抽样不看草稿条件
  assert.deepEqual(
    sampleCategoryRecords(d, { kind: 'live', uid: '2' }).samples.map((s) => s.subjectId),
    ['r2:1700100000'],
  );
  assert.deepEqual(
    sampleCategoryRecords(d, { kind: 'live', toTs: 1_700_050_000 }).samples.map((s) => s.subjectId),
    ['r1:1700000000'],
  );
  assert.equal(sampleCategoryRecords(d, { kind: 'live', limit: 1 }).samples.length, 1);

  assert.deepEqual(touched, { gate: 0, router: 0, decision: 0, images: 0 }, '抽样不调模型、不下图、不占队列');
  assert.deepEqual(counts(), before, '抽样不写库（判定表 / 审计表 / 分类表都不动）');

  // 只校验 kind + filter：坏 kind / 坏过滤面 / 未知字段都 400
  assert.throws(() => sampleCategoryRecords(d, {}), /kind 必须是 live \/ post/);
  assert.throws(() => sampleCategoryRecords(d, { kind: 'movie' }), /kind 必须是 live \/ post/);
  assert.throws(() => sampleCategoryRecords(d, { kind: 'live', uid: 'alice' }), /纯数字主播 uid/);
  assert.throws(() => sampleCategoryRecords(d, { kind: 'live', limit: 21 }), /1~20/);
  assert.throws(() => sampleCategoryRecords(d, { kind: 'live', nope: 1 }), /未知字段: nope/);
  assert.deepEqual(parseCategorySampleRequest({ kind: 'post' }).filter, { limit: 10 }, 'limit 缺省 10');
});

test('复测（sampleIds）：按给定顺序逐条精确加载，不再随机、忽略 filter', async (t) => {
  const db = memDb(t);
  seedLive(db);
  seedPosts(db);

  // 反序请求 + 与锚点矛盾的 filter（uid 指向另一场、limit=1、时间也排除它）：复测只认锚点
  const { samples } = await runLive(db, { keywords: ['歌回'] }, {
    sampleIds: ['r2:1700100000', 'r1:1700000000'],
    filter: { uid: '2', limit: 1, fromTs: 1_700_100_000 },
  });
  assert.deepEqual(
    samples.map((s) => s.subjectId),
    ['r2:1700100000', 'r1:1700000000'],
    '顺序照传、条数照传、filter 被忽略',
  );
  assert.equal(samples[0]!.text, '来打游戏', '第一条就是锚点那一场');
  assert.equal(samples[1]!.text, '今晚歌回！');
  assert.equal(samples[0]!.results.length, 3, '复测照样跑三档（响应形状不变）');
  assert.deepEqual(
    samples.map((s) => s.image),
    ['c2.jpg', 'k1.jpg'],
    '复测的 image 与抽样时同一口径（同一条内容 → 同一张源图）',
  );

  // 身份精确：连续复测都是同两条同顺序（对照：随机抽样每次可能是另一序）
  const draws = new Set<string>();
  for (let i = 0; i < 5; i++) {
    const r = await runLive(db, { keywords: ['歌回'] }, { sampleIds: ['r1:1700000000', 'r2:1700100000'] });
    draws.add(r.samples.map((s) => s.subjectId).join(','));
  }
  assert.deepEqual([...draws], ['r1:1700000000,r2:1700100000'], '复测不重新随机');

  // 图文复测：身份键 = platform:itemId
  const posts = await runCategoryTest(deps(db), {
    category: { appliesTo: 'post', keywords: ['正文'] },
    sampleIds: ['weibo:m1', 'twitter:t1'],
  });
  assert.deepEqual(posts.samples.map((s) => s.subjectId), ['weibo:m1', 'twitter:t1']);
  assert.deepEqual(posts.samples.map((s) => s.image), ['https://wx1.sinaimg.cn/m.jpg', 'https://pbs.twimg.com/a.jpg']);
});

test('复测拒绝：缺失 / 非法 / 跨类型 / 重复 / 超限都是 400（绝不静默换一条）', async (t) => {
  const db = memDb(t);
  seedLive(db);
  seedPosts(db);
  const live = { keywords: ['歌回'] };
  const post = { appliesTo: 'post', keywords: ['正文'] };
  const run = (body: Record<string, unknown>) => runCategoryTest(deps(db), body);

  // 身份对但库里没有（含「部分缺失」：整次拒绝，不做跳过）
  await assert.rejects(run({ category: live, sampleIds: ['r9:1700000000'] }), /样本不存在: r9:1700000000/);
  await assert.rejects(run({ category: post, sampleIds: ['twitter:nope'] }), /样本不存在: twitter:nope/);
  await assert.rejects(run({ category: live, sampleIds: ['r1:1700000000', 'r9:1'] }), /样本不存在: r9:1/);

  // 跨类型：直播分类配图文 id、图文分类配直播 id
  await assert.rejects(run({ category: live, sampleIds: ['twitter:t1'] }), /跨类型/);
  await assert.rejects(run({ category: post, sampleIds: ['r1:1700000000'] }), /跨类型/);

  // 非法：缺段 / 场次不是数字
  await assert.rejects(run({ category: live, sampleIds: ['nope'] }), /sampleIds 非法/);
  await assert.rejects(run({ category: live, sampleIds: ['r1:abc'] }), /sampleIds 非法/);
  await assert.rejects(run({ category: post, sampleIds: ['twitter:'] }), /sampleIds 非法/);
  await assert.rejects(run({ category: post, sampleIds: ['weibo:m1:extra'] }), /样本不存在: weibo:m1:extra/);

  // 形态：空 / 超上限 / 重复 / 非字符串 / 不是数组
  await assert.rejects(run({ category: live, sampleIds: [] }), /1~20/);
  await assert.rejects(
    run({ category: live, sampleIds: Array.from({ length: 21 }, (_, i) => `r1:${i}`) }),
    /1~20/,
  );
  await assert.rejects(run({ category: live, sampleIds: ['r1:1700000000', 'r1:1700000000'] }), /不能重复/);
  await assert.rejects(run({ category: live, sampleIds: [1] }), /必须是非空字符串/);
  await assert.rejects(run({ category: live, sampleIds: 'r1:1700000000' }), /必须是字符串数组/);

  // 没传 sampleIds 时仍然是原来那套随机抽样（向后兼容：不给锚点就不校验它们）
  const legacy = await run({ category: live, filter: { limit: 10 } });
  assert.equal(legacy.samples.length, 2);
});
