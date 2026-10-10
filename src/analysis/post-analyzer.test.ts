/**
 * 图文帖翻译编排单测（判定已挪进分类判决链，这里只剩规则层的附加动作）：
 * 重点是**降级路径**——LLM 关/无 provider/调用失败/解析失败，都必须不附译文照发，
 * 绝不能因为翻译抖动让推文凭空消失。平台门控（只对 X 请求翻译）在 pipeline 层。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PostAnalyzer } from './post-analyzer.js';
import type { PostCandidate } from './matcher.js';
import type { LlmRouter } from './providers.js';

function post(over: Partial<PostCandidate> = {}): PostCandidate {
  return {
    platform: 'twitter', accountId: 1, screenName: 'watase_yuzuki', type: 'tweet', text: '今晚有直播',
    pics: [], pubTs: 1_789_549_200, url: 'https://x.com/watase_yuzuki/status/9001',
    ...over,
  };
}

/** 假 router：只实现 completeJson（parseFn 收到的是「模型返回的原始对象」） */
function router(impl: (raw: unknown) => unknown): LlmRouter {
  return {
    completeJson: async (_req: unknown, parse: (raw: unknown) => unknown) => parse(impl({})),
  } as unknown as LlmRouter;
}

test('翻译成功 → source=llm 且带译文', async () => {
  const a = new PostAnalyzer(() => router(() => ({ translation: 'live tonight' })), () => true);
  const r = await a.translate(post());
  assert.equal(r.source, 'llm');
  assert.equal(r.translation, 'live tonight');
});

test('LLM 总开关关 / 无 provider → fallback，不附译文', async () => {
  const off = new PostAnalyzer(() => router(() => ({ translation: '不该出现' })), () => false);
  const r1 = await off.translate(post());
  assert.equal(r1.source, 'fallback');
  assert.equal(r1.translation, null);

  const none = new PostAnalyzer(() => null, () => true);
  const r2 = await none.translate(post());
  assert.equal(r2.source, 'fallback');
  assert.equal(r2.translation, null);
});

test('调用失败 / 解析失败 → fallback（翻译失败绝不挡推送）', async () => {
  const boom = new PostAnalyzer(
    () => ({ completeJson: async () => { throw new Error('服务 500'); } } as unknown as LlmRouter),
    () => true,
  );
  const r1 = await boom.translate(post());
  assert.equal(r1.source, 'fallback');
  assert.equal(r1.translation, null, '失败照样推，不能让推文消失');

  // 解析失败（模型没按 schema 输出 → zod 抛错）走同一条路
  const bad = new PostAnalyzer(() => router(() => ({ translation: 42 })), () => true);
  const r2 = await bad.translate(post());
  assert.equal(r2.source, 'fallback');
  assert.equal(r2.translation, null);
});

test('翻译为空串 / 空白 / null → 归一成 null（消息层不该拼出空译文块）', async () => {
  for (const raw of [{ translation: '' }, { translation: '   ' }, { translation: null }]) {
    const a = new PostAnalyzer(() => router(() => raw), () => true);
    assert.equal((await a.translate(post())).translation, null);
  }
});

test('超长译文截断（消息有上限，长文截断而不是整条丢弃）', async () => {
  const long = 'あ'.repeat(2000);
  const a = new PostAnalyzer(() => router(() => ({ translation: long })), () => true);
  const r = await a.translate(post());
  assert.equal(r.translation!.length, 1200);
});
