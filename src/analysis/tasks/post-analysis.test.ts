/**
 * 图文帖 LLM 任务单测：请求里该带什么（正文/判定标准/两个开关的指令）与解析的裁剪。
 * 关键点：没开判定时要明确要求模型 pass 恒 true，没开翻译时要求 translation 恒 null——
 * 否则「模型有没有越权替我们决定」就成了调用方要猜的事。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPostAnalysisRequest, parsePostAnalysis } from './post-analysis.js';
import type { PostCandidate } from '../matcher.js';

function post(over: Partial<PostCandidate> = {}): PostCandidate {
  return {
    platform: 'twitter', accountId: 1, ruleIds: [1], screenName: 'watase_yuzuki', type: 'tweet', text: '今晚20時から配信',
    pics: [], pubTs: 1_789_549_200, url: 'https://x.com/watase_yuzuki/status/9001',
    ...over,
  };
}

function userText(req: ReturnType<typeof buildPostAnalysisRequest>): string {
  const part = req.messages.find((m) => m.role === 'user')!;
  return typeof part.content === 'string' ? part.content : '';
}

test('请求：带账号/类型/正文；判定开时带判定标准，翻译开时要求译文', () => {
  const req = buildPostAnalysisRequest(post({ biliName: '阿梓', pics: ['a', 'b'] }), {
    judge: true, judgePrompt: '只推直播预告', translate: true,
  });
  const text = userText(req);
  assert.match(text, /@watase_yuzuki/);
  assert.match(text, /关联主播：阿梓/);
  assert.match(text, /今晚20時から配信/);
  assert.match(text, /配图：2 张/);
  assert.match(text, /只推直播预告/, '判定标准由人填，必须原样进提示词');
  assert.match(text, /翻译成简体中文/);
  assert.equal(req.jsonSchema?.name, 'post_analysis');
  const schema = req.jsonSchema!.schema as { required: string[] };
  assert.deepEqual(schema.required, ['pass', 'reason', 'translation']);
});

test('请求：判定关 → 明确要求 pass 恒 true；翻译关 → 明确要求 translation 恒 null', () => {
  const text = userText(buildPostAnalysisRequest(post(), { judge: false, judgePrompt: null, translate: false }));
  assert.match(text, /pass 一律返回 true/);
  assert.match(text, /translation 一律返回 null/);
  assert.doesNotMatch(text, /翻译成简体中文/);
});

test('请求：纯图推文（无正文）也有占位，不让提示词里出现空白正文段', () => {
  const text = userText(buildPostAnalysisRequest(post({ text: null }), { judge: true, judgePrompt: 'x', translate: false }));
  assert.match(text, /（无正文，仅图片）/);
});

test('请求：平台措辞——微博说「微博」、B站动态说「动态」，账号用展示名 + uid', () => {
  const wb = userText(buildPostAnalysisRequest(
    post({ platform: 'weibo', screenName: '2203177060', displayName: '渡瀬結月', type: 'mblog' }),
    { judge: true, judgePrompt: 'x', translate: false },
  ));
  assert.match(wb, /平台：微博/);
  assert.match(wb, /账号：渡瀬結月（uid 2203177060）/);
  assert.match(wb, /微博正文：/);

  const dyn = userText(buildPostAnalysisRequest(
    post({ platform: 'bili_dynamic', screenName: '80397', displayName: null, type: 'dynamic' }),
    { judge: true, judgePrompt: 'x', translate: false },
  ));
  assert.match(dyn, /平台：B站/);
  assert.match(dyn, /账号：uid 80397/, '展示名缺省只给 uid');
  assert.match(dyn, /动态正文：/);
});

test('解析：正常返回；理由与译文两侧空白被裁掉', () => {
  const r = parsePostAnalysis({ pass: true, reason: '  值得推  ', translation: '  今晚有直播  ' });
  assert.equal(r.pass, true);
  assert.equal(r.reason, '值得推');
  assert.equal(r.translation, '今晚有直播');
});

test('解析：空/全空白译文归一成 null', () => {
  assert.equal(parsePostAnalysis({ pass: false, reason: 'r', translation: '' }).translation, null);
  assert.equal(parsePostAnalysis({ pass: false, reason: 'r', translation: '   ' }).translation, null);
  assert.equal(parsePostAnalysis({ pass: false, reason: 'r', translation: null }).translation, null);
});

test('解析：缺字段 / 类型不对 → 抛错（由调用方回退机械筛选，不猜）', () => {
  assert.throws(() => parsePostAnalysis({ pass: true, reason: 'r' }));
  assert.throws(() => parsePostAnalysis({ pass: 'yes', reason: 'r', translation: null }));
  assert.throws(() => parsePostAnalysis(null));
});

test('解析：超长译文按上限截断（QQ 气泡放不下几千字）', () => {
  const long = 'あ'.repeat(5000);
  const r = parsePostAnalysis({ pass: true, reason: '', translation: long });
  assert.equal(r.translation!.length, 1200);
});