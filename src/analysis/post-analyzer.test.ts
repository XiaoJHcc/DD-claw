/**
 * 图文帖分析编排单测：重点是**降级路径**——LLM 关/无 provider/调用失败/解析失败，
 * 都必须按机械筛选放行（判定视为通过、不附译文），绝不能让推文凭空消失。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PostAnalyzer, ruleNeedsLlm } from './post-analyzer.js';
import type { PostCandidate } from './matcher.js';
import { defaultPostFilters, type PostRule } from '../core/post-rules.js';
import type { LlmRouter } from './providers.js';

function post(over: Partial<PostCandidate> = {}): PostCandidate {
  return {
    platform: 'twitter', accountId: 1, ruleIds: [1], screenName: 'watase_yuzuki', type: 'tweet', text: '今晚有直播',
    pics: [], pubTs: 1_789_549_200, url: 'https://x.com/watase_yuzuki/status/9001',
    ...over,
  };
}

function rule(over: Partial<PostRule> = {}): PostRule {
  return {
    id: 1, name: 'r', channels: [1], filters: defaultPostFilters(),
    messageTemplate: null, llmJudge: false, judgePrompt: null, llmTranslate: false,
    enabled: true, sort: 0, createdAt: 0, updatedAt: 0,
    ...over,
  };
}

/** 假 router：只实现 completeJson（parseFn 收到的是「模型返回的原始对象」） */
function router(impl: (raw: unknown) => unknown): LlmRouter {
  return {
    completeJson: async (_req: unknown, parse: (raw: unknown) => unknown) => parse(impl({})),
  } as unknown as LlmRouter;
}

const judgeRule = rule({ llmJudge: true, judgePrompt: '只推与直播预告相关的内容' });

test('ruleNeedsLlm：判定或翻译任一开启才需要 LLM', () => {
  assert.equal(ruleNeedsLlm(rule()), false);
  assert.equal(ruleNeedsLlm(judgeRule), true);
  assert.equal(ruleNeedsLlm(rule({ llmTranslate: true })), true);
});

test('规则没开 LLM → 直接 off，不碰 provider', async () => {
  let called = 0;
  const a = new PostAnalyzer(
    () => router(() => { called++; return { pass: false, reason: 'x', translation: null }; }),
    () => true,
  );
  const r = await a.analyze(post(), rule());
  assert.equal(r.source, 'off');
  assert.equal(r.pass, true);
  assert.equal(r.translation, null);
  assert.equal(called, 0, '没开 LLM 就不该调用');
});

test('LLM 总开关关 / 无 provider → fallback 且判定视为通过', async () => {
  const off = new PostAnalyzer(() => router(() => ({ pass: false, reason: 'no', translation: null })), () => false);
  const r1 = await off.analyze(post(), judgeRule);
  assert.equal(r1.source, 'fallback');
  assert.equal(r1.pass, true, '总开关关 = 按机械筛选放行，不能拦下');
  assert.equal(r1.translation, null);

  const none = new PostAnalyzer(() => null, () => true);
  const r2 = await none.analyze(post(), judgeRule);
  assert.equal(r2.source, 'fallback');
  assert.equal(r2.pass, true);
});

test('模型说「不推」→ llm 权威：pass=false 且带理由', async () => {
  const a = new PostAnalyzer(
    () => router(() => ({ pass: false, reason: '只是日常闲聊', translation: null })),
    () => true,
  );
  const r = await a.analyze(post(), judgeRule);
  assert.equal(r.source, 'llm');
  assert.equal(r.pass, false);
  assert.equal(r.reason, '只是日常闲聊');
});

test('调用失败 / 解析失败 → fallback（计入熔断的是 providers 层，这里只管放行）', async () => {
  const boom = new PostAnalyzer(
    () => ({ completeJson: async () => { throw new Error('服务 500'); } } as unknown as LlmRouter),
    () => true,
  );
  const r1 = await boom.analyze(post(), judgeRule);
  assert.equal(r1.source, 'fallback');
  assert.equal(r1.pass, true, '失败照样推，不能让推文消失');

  // 解析失败（模型没按 schema 输出 → zod 抛错）走同一条路
  const bad = new PostAnalyzer(
    () => router(() => ({ pass: 'yes', reason: 1 })),
    () => true,
  );
  const r2 = await bad.analyze(post(), judgeRule);
  assert.equal(r2.source, 'fallback');
  assert.equal(r2.pass, true);
});

test('翻译：开了才附译文；没开时即使模型返回了也丢掉', async () => {
  const withTr = new PostAnalyzer(
    () => router(() => ({ pass: true, reason: '', translation: '今晚有直播' })),
    () => true,
  );
  const r1 = await withTr.analyze(post(), rule({ llmTranslate: true }));
  assert.equal(r1.source, 'llm');
  assert.equal(r1.translation, '今晚有直播');
  assert.equal(r1.pass, true, '没开判定 → pass 恒 true（不让模型替我们决定）');

  const noTr = new PostAnalyzer(
    () => router(() => ({ pass: false, reason: '', translation: '不该出现' })),
    () => true,
  );
  const r2 = await noTr.analyze(post(), judgeRule);
  assert.equal(r2.translation, null, '没开翻译就不采纳');
  assert.equal(r2.pass, false, '开了判定则采纳');
  assert.equal(r2.reason, '', '模型给空理由时如实为空');
});

test('翻译为空串 / 空白 → 归一成 null（消息层不该拼出空译文块）', async () => {
  const a = new PostAnalyzer(
    () => router(() => ({ pass: true, reason: '', translation: '   ' })),
    () => true,
  );
  const r = await a.analyze(post(), rule({ llmTranslate: true }));
  assert.equal(r.translation, null);
});

// ---- 翻译运行时门控：llmTranslate 只对 X 帖生效（微博/B站动态本就中文）；判定不受平台影响 ----

test('非 X 帖只开了翻译 → 根本不调 LLM（翻译被平台门控掉后等于没开任何 LLM）', async () => {
  let called = 0;
  const a = new PostAnalyzer(
    () => router(() => { called++; return { pass: true, reason: '', translation: '译文' }; }),
    () => true,
  );
  for (const platform of ['weibo', 'bili_dynamic'] as const) {
    const r = await a.analyze(post({ platform }), rule({ llmTranslate: true }));
    assert.equal(r.source, 'off', `${platform} 帖不请求翻译`);
    assert.equal(r.translation, null);
  }
  assert.equal(called, 0);
});

test('非 X 帖开了判定 + 翻译 → 调 LLM 判定但译文被丢弃（判定三平台通用）', async () => {
  const a = new PostAnalyzer(
    () => router(() => ({ pass: false, reason: '不是直播相关', translation: '不该出现' })),
    () => true,
  );
  const r = await a.analyze(
    post({ platform: 'weibo' }),
    rule({ llmJudge: true, judgePrompt: '只推直播预告', llmTranslate: true }),
  );
  assert.equal(r.source, 'llm');
  assert.equal(r.pass, false, '判定不受平台影响');
  assert.equal(r.translation, null, '非 X 帖不采纳译文');
});

// ---- 附图：判定输入要包含全部可用信息（「只推自拍」靠文字判不出来）；无 vision 路由降级纯文本 ----

test('带图且 vision 路由可用 → 请求带 image_url 部件（走 vision 路由）', async () => {
  let seen: { messages: Array<{ content: unknown }> } | null = null;
  const r = {
    hasVision: () => true,
    completeJson: async (req: { messages: Array<{ content: unknown }> }, parse: (raw: unknown) => unknown) => {
      seen = req;
      return parse({ pass: true, reason: '', translation: null });
    },
  } as unknown as LlmRouter;
  const a = new PostAnalyzer(() => r, () => true);
  const res = await a.analyze(
    post({ pics: ['https://pbs.twimg.com/media/1.jpg'] }),
    judgeRule,
    ['data:image/jpeg;base64,QUJD'],
  );
  assert.equal(res.source, 'llm');
  const content = seen!.messages[1]!.content;
  assert.ok(Array.isArray(content), '带图时 user 消息应是 ContentPart 数组');
  const parts = content as Array<{ type: string; image_url?: { url: string } }>;
  assert.equal(parts[0]!.type, 'text');
  assert.deepEqual(parts[1], { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } });
});

test('带图但无可用 vision provider → 降级纯文本（含图请求会在空路由上整路失败）', async () => {
  let seen: { messages: Array<{ content: unknown }> } | null = null;
  const r = {
    hasVision: () => false,
    completeJson: async (req: { messages: Array<{ content: unknown }> }, parse: (raw: unknown) => unknown) => {
      seen = req;
      return parse({ pass: true, reason: '', translation: null });
    },
  } as unknown as LlmRouter;
  const a = new PostAnalyzer(() => r, () => true);
  await a.analyze(post({ pics: ['https://pbs.twimg.com/media/1.jpg'] }), judgeRule, ['data:image/jpeg;base64,QUJD']);
  assert.equal(typeof seen!.messages[1]!.content, 'string', '无 vision 路由时不带图');
});