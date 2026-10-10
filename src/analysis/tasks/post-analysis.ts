/**
 * 图文帖 LLM 任务：**只做翻译**（X / 微博 / B站动态共用；运行时只对 X 帖请求）。
 *
 * 历史注记：这里曾是「判定 + 翻译」一次调用的合并任务（判定口径内嵌在图文规则的
 * judgePrompt）。2026-10-10 统一计划 P2（附录 A.4）把判定挪进分类（判决链 + verdicts），
 * 翻译留在规则层作附加动作（D3：翻译是输出物不是判定口径）——故本任务只剩生成译文。
 *
 * 平台差异：翻译只对 X 帖出现（微博与B站动态本就中文，译文没有意义）——运行时由
 * post-analyzer 按 `platformSupportsTranslate(post.platform)` 门控，非 X 帖根本不会被请求。
 */
import { z } from 'zod';
import { platformLabel } from '../../core/post-rules.js';
import type { PostCandidate } from '../matcher.js';
import type { LlmRequest } from '../providers.js';

const resultSchema = z.object({
  translation: z.string().nullable(),
});

const SYSTEM_PROMPT =
  '你是社交平台图文翻译器。把用户给出的帖子正文翻译成简体中文，严格按 JSON schema 输出，不要输出任何多余内容。';

const MAX_TRANSLATION_CHARS = 1200;

export function buildTranslateRequest(post: PostCandidate): LlmRequest {
  const kind = post.platform === 'weibo' ? '微博' : post.platform === 'bili_dynamic' ? '动态' : '推文';
  const author = post.platform === 'twitter'
    ? `@${post.screenName}`
    : (post.displayName ? `${post.displayName}（uid ${post.screenName}）` : `uid ${post.screenName}`);
  const text = [
    `平台：${platformLabel(post.platform)}`,
    `账号：${author}`,
    '',
    `${kind}正文：`,
    post.text || `（无正文，仅图片）`,
    '',
    '把正文翻译成简体中文（原文已是中文则原样返回），译文放 translation。',
  ].join('\n');
  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: text },
    ],
    jsonSchema: {
      name: 'post_translate',
      schema: {
        type: 'object',
        properties: {
          translation: { type: ['string', 'null'] },
        },
        required: ['translation'],
        additionalProperties: false,
      },
    },
    maxTokens: 1024,
  };
}

/**
 * zod 校验 + 裁剪。parse 抛错（模型没按 schema 输出）由 providers 层计入熔断，
 * 调用方据此不附译文——**翻译失败绝不挡推送**（正文照发）。
 */
export function parseTranslation(raw: unknown): string | null {
  const parsed = resultSchema.parse(raw);
  const translation = parsed.translation?.trim();
  return translation && translation.length > 0
    ? translation.slice(0, MAX_TRANSLATION_CHARS)
    : null;
}
