/**
 * 图文帖的**平台语义**（PostPlatform 与平台相关门控）+ 旧 post_rules 表的 filters 形状
 * （A.3 一次性搬家的解析口径，仅迁移用）。
 *
 * 历史注记：这里曾是 post_rules 表（图文帖规则，与 push_rules 平行）的行类型与映射。
 * 2026-10-10 统一计划 P2（docs/plan/unify-classify-push.md 附录 A）把图文判定口径上移进
 * categories（applies_to='post' 的条件组 + llm_prompt）、推送并入 push_rules
 * （subject_kind='post'，scope=账号引用），post_rules 表搬完即 DROP。
 * PostFilters / defaultPostFilters / parseFilters 保留给 Db.migratePostRulesToCategories
 * 解析老行——搬家完成后它们就是死代码，可以随迁移下线一起删。
 *
 * PostPlatform / platformLabel / platformSupportsQuote / platformSupportsTranslate
 * 是**帖子侧**语义：PostCandidate.platform 决定文案措辞、quote 语义与翻译门控。
 * quote 只有 X 的免登录 HTML 回退路线能给出 isQuote，其余来源 isQuote 恒 undefined，
 * 勾了 require_quote 的分类对非 X 帖**永不命中**（这是语义而非校验错误：分类平台无关）。
 * 微博的「转发」在抓取层就折进 retweet（正文带 `//转发自 @原作者`），B站动态同理
 * （DYNAMIC_TYPE_FORWARD 在 source 归一成 retweet），都没有独立的引用实体。
 */

/** 图文来源平台：帖子侧语义（PostCandidate.platform 决定文案措辞、quote 语义、翻译门控） */
export type PostPlatform = 'twitter' | 'weibo' | 'bili_dynamic';

export const POST_PLATFORMS: readonly PostPlatform[] = ['twitter', 'weibo', 'bili_dynamic'];

/** 面板 / 推送文案里的平台名 */
export function platformLabel(platform: PostPlatform): string {
  return platform === 'weibo' ? '微博' : platform === 'bili_dynamic' ? 'B站' : 'X';
}

/** 该平台的帖子是否能识别「引用」（只有 X 的 HTML 回退路线能给出 isQuote；matcher 按帖子平台自然生效） */
export function platformSupportsQuote(platform: PostPlatform): boolean {
  return platform === 'twitter';
}

/** 该平台的帖子是否需要 LLM 翻译（微博与B站动态本就中文，译文没有意义；运行时按 post.platform 门控） */
export function platformSupportsTranslate(platform: PostPlatform): boolean {
  return platform === 'twitter';
}

/** 旧 post_rules.filters 形状（A.3 迁移解析口径；运行时判定已走 categories 条件组） */
export interface PostFilters {
  original: boolean;
  retweet: boolean;
  /** 勾上要求帖子标了引用（isQuote === true）；只有 X 帖可能给出，对非 X 帖永不命中 */
  quote: boolean;
  media: boolean;
  keywords: string[];
}

/** 默认只推原创、不论有没有图（用户 2026-09-16 选定） */
export function defaultPostFilters(): PostFilters {
  return { original: true, retweet: false, quote: false, media: false, keywords: [] };
}

/** 宽松解析库存 filters：缺字段回落默认，非法类型忽略（防御式，与 posts.pics 同风格） */
export function parseFilters(raw: string | null): PostFilters {
  const def = defaultPostFilters();
  if (!raw) return def;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return def;
  }
  if (typeof v !== 'object' || v === null) return def;
  const o = v as Record<string, unknown>;
  return {
    original: typeof o.original === 'boolean' ? o.original : def.original,
    retweet: typeof o.retweet === 'boolean' ? o.retweet : def.retweet,
    quote: typeof o.quote === 'boolean' ? o.quote : def.quote,
    media: typeof o.media === 'boolean' ? o.media : def.media,
    keywords: Array.isArray(o.keywords) ? o.keywords.filter((k): k is string => typeof k === 'string') : [],
  };
}
