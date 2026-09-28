/**
 * 图文帖 LLM 任务：**一次调用同时做「要不要推」的判定与翻译**（X / 微博 / B站动态共用）。
 *
 * 为什么合并成一次：两者吃的是同一段正文，分开调用就是两倍延迟与两倍额度；
 * 而用户关心的是「这条推文要不要发到群里、发的时候带不带译文」——一件事。
 *
 * 平台差异：判定的口径由人填（规则里的 `judgePrompt`），各平台通用；
 * **翻译只对 X 帖出现**（微博与B站动态本就中文，译文没有意义）——运行时由
 * post-analyzer 按 `platformSupportsTranslate(post.platform)` 门控，非 X 帖根本不会带 translate=true 进来。
 *
 * 附图：调用方传入已本地化的配图（data URL）时，请求带 image_url 部件、自动走 vision 路由——
 * 「只推自拍」这类判定标准只看文字判不出来；没传图（或没有可用 vision provider）就是纯文本请求。
 *
 * 口径由人填（与分类一致的原则）：没开判定时要求模型 pass 恒 true，
 * 没开翻译时要求 translation 恒 null，免得调用方还要猜模型有没有越权替它决定。
 */
import { z } from 'zod';
import { platformLabel } from '../../core/post-rules.js';
import type { PostCandidate } from '../matcher.js';
import type { ContentPart, LlmRequest } from '../providers.js';

export interface PostAnalysisOptions {
  /** 是否要判定「要不要推」 */
  judge: boolean;
  /** 判定标准（用户填写；judge=true 时调用方保证非空） */
  judgePrompt: string | null;
  /** 是否要翻译成简体中文 */
  translate: boolean;
}

export interface PostAnalysisResult {
  pass: boolean;
  reason: string;
  translation: string | null;
}

const resultSchema = z.object({
  pass: z.boolean(),
  reason: z.string(),
  translation: z.string().nullable(),
});

const SYSTEM_PROMPT =
  '你是社交平台图文过滤器兼翻译器。严格按 JSON schema 输出，不要输出任何多余内容。';

const MAX_TRANSLATION_CHARS = 1200;

export function buildPostAnalysisRequest(
  post: PostCandidate,
  opts: PostAnalysisOptions,
  /** 已本地化的配图（data URL）。带上 = 请求含图 → providers 层自动走 vision 路由 */
  imageUrls?: string[],
): LlmRequest {
  // 平台决定措辞：对模型说「推文」而给它一条微博/动态，只会白白引入噪声
  const kind = post.platform === 'weibo' ? '微博' : post.platform === 'bili_dynamic' ? '动态' : '推文';
  const author = post.platform === 'twitter'
    ? `@${post.screenName}`
    : (post.displayName ? `${post.displayName}（uid ${post.screenName}）` : `uid ${post.screenName}`);
  const withImages = (imageUrls?.length ?? 0) > 0;
  const head = [
    `平台：${platformLabel(post.platform)}`,
    `账号：${author}`,
    post.biliName ? `关联主播：${post.biliName}` : '',
    `类型：${post.type === 'retweet' ? '转发' : '原创'}`,
    post.pubTs > 0 ? `发布时间：${new Date(post.pubTs * 1000).toISOString()}` : '',
    post.pics.length > 0 ? `配图：${post.pics.length} 张${withImages ? '（见下方附图）' : ''}` : '',
  ].filter(Boolean);

  const tail = [
    opts.judge
      ? `判定标准（用户填写，据此判断是否值得推送）：\n${opts.judgePrompt}\n\n` +
        '判断结果放 pass；一句话理由放 reason。'
      : '本次不做判定：pass 一律返回 true，reason 返回空字符串。',
    opts.translate
      ? '同时把正文翻译成简体中文（原文已是中文则原样返回），译文放 translation。'
      : '本次不做翻译：translation 一律返回 null。',
    // 判定输入要包含全部可用信息：「只推自拍」这类标准靠文字判不出来
    ...(withImages ? ['下方附图就是这条帖子的配图，判定与翻译都要结合图片内容，不要只看文字。'] : []),
  ];

  const text = [...head, '', `${kind}正文：`, post.text || `（无正文，仅图片）`, '', ...tail].join('\n');
  const content: string | ContentPart[] = withImages
    ? [{ type: 'text', text }, ...imageUrls!.map((url) => ({ type: 'image_url' as const, image_url: { url } }))]
    : text;

  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content },
    ],
    jsonSchema: {
      name: 'post_analysis',
      schema: {
        type: 'object',
        properties: {
          pass: { type: 'boolean' },
          reason: { type: 'string' },
          translation: { type: ['string', 'null'] },
        },
        required: ['pass', 'reason', 'translation'],
        additionalProperties: false,
      },
    },
    maxTokens: 1024,
  };
}

/**
 * zod 校验 + 裁剪。parse 抛错（模型没按 schema 输出）由 providers 层计入熔断，
 * 调用方据此回退机械筛选——**LLM 的任何失败都不该让这条推文凭空消失**。
 */
export function parsePostAnalysis(raw: unknown): PostAnalysisResult {
  const parsed = resultSchema.parse(raw);
  const translation = parsed.translation?.trim();
  return {
    pass: parsed.pass,
    reason: parsed.reason.trim(),
    translation:
      translation && translation.length > 0
        ? translation.slice(0, MAX_TRANSLATION_CHARS)
        : null,
  };
}