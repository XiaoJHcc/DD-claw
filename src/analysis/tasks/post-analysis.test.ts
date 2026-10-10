/**
 * 图文帖翻译 LLM 任务单测（判定已挪进分类判决链，本任务只剩生成译文）：
 * 请求里该带什么（平台/账号/正文 + 翻译指令）与解析的裁剪。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTranslateRequest, parseTranslation } from './post-analysis.js';
import type { PostCandidate } from '../matcher.js';

function post(over: Partial<PostCandidate> = {}): PostCandidate {
  return {
    platform: 'twitter', accountId: 1, screenName: 'watase_yuzuki', type: 'tweet', text: '今晚20時から配信',
    pics: [], pubTs: 1_789_549_200, url: 'https://x.com/watase_yuzuki/status/9001',
    ...over,
  };
}

function userText(req: ReturnType<typeof buildTranslateRequest>): string {
  const part = req.messages.find((m) => m.role === 'user')!;
  return typeof part.content === 'string' ? part.content : '';
}

test('请求：带平台/账号/正文 + 翻译指令；schema 只有 translation', () => {
  const req = buildTranslateRequest(post({ displayName: '渡濑结月' }));
  const text = userText(req);
  assert.match(text, /平台：X/);
  assert.match(text, /@watase_yuzuki/);
  assert.match(text, /今晚20時から配信/);
  assert.match(text, /翻译成简体中文/);
  assert.equal(req.jsonSchema?.name, 'post_translate');
  const schema = req.jsonSchema!.schema as { required: string[] };
  assert.deepEqual(schema.required, ['translation']);
});

test('请求：平台措辞按帖子平台（微博/动态说「微博正文/动态正文」）', () => {
  assert.match(userText(buildTranslateRequest(post({ platform: 'weibo' }))), /微博正文/);
  assert.match(userText(buildTranslateRequest(post({ platform: 'bili_dynamic' }))), /动态正文/);
  assert.match(userText(buildTranslateRequest(post({ platform: 'twitter' }))), /推文正文/);
});

test('请求：无正文给占位（纯图帖也有可翻译的输入面）', () => {
  assert.match(userText(buildTranslateRequest(post({ text: null }))), /（无正文，仅图片）/);
});

test('parseTranslation：空白/空串归一 null；超长截断；非法输出抛错（计入熔断）', () => {
  assert.equal(parseTranslation({ translation: '今晚有直播' }), '今晚有直播');
  assert.equal(parseTranslation({ translation: null }), null);
  assert.equal(parseTranslation({ translation: '' }), null);
  assert.equal(parseTranslation({ translation: '  \n ' }), null);
  assert.equal(parseTranslation({ translation: 'あ'.repeat(2000) })!.length, 1200);

  assert.throws(() => parseTranslation({ translation: 42 }), '非字符串抛错');
  assert.throws(() => parseTranslation({}), '缺字段抛错');
  assert.throws(() => parseTranslation('不是对象'), '非对象抛错');
});
