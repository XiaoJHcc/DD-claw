/**
 * post_rules 表（图文帖规则，X/推特 + 微博）的行类型与「行 ↔ 对象」映射。
 *
 * 与 push_rules（开播规则）**平行**、互不影响：开播规则卡一个字没动，
 * 图文帖规则有自己的一张表、一套排序、一套 matcher（见 analysis/matcher.ts）。
 *
 * **platform 决定这条规则吃哪个平台的账号**：`accountIds` 引用对应平台的名单
 * （twitter → x_accounts.id，weibo → weibo_accounts.id）——两张名单的自增 id 会撞，
 * 所以「生效账号」离开 platform 就没有意义，规则创建时必须先定平台（面板从账号卡进入）。
 *
 * filters 语义（钉死在这里，UI 与 matcher 都照它）：
 *  · original / retweet：**二选一必选**（都不选 = 规则永不命中，保存时就拒绝）
 *  · media：勾上则必须带图（AND）
 *  · keywords：非空则正文需命中任一（大小写不敏感子串，AND）
 *  · quote：**仅 X 支持**（免登录两条路线里只有 HTML 回退能识别引用推文；RSS 不标）。
 *    微博的「转发」在抓取层就折进 retweet（正文带 `//转发自 @原作者`），没有独立的引用实体，
 *    所以微博规则带 quote=true 会被保存校验拒绝（放个永远不命中的勾是骗人）。
 */

/** 图文来源平台：账号名单、规则、推送文案都按它分支 */
export type PostPlatform = 'twitter' | 'weibo';

export const POST_PLATFORMS: readonly PostPlatform[] = ['twitter', 'weibo'];

/** 面板 / 推送文案里的平台名 */
export function platformLabel(platform: PostPlatform): string {
  return platform === 'weibo' ? '微博' : 'X';
}

/** 该平台是否识别「引用」（见文件头：只有 X 的 HTML 回退路线能给出 isQuote） */
export function platformSupportsQuote(platform: PostPlatform): boolean {
  return platform === 'twitter';
}

/** 该平台是否需要 LLM 翻译（微博本就中文，译文没有意义；判定两头都适用） */
export function platformSupportsTranslate(platform: PostPlatform): boolean {
  return platform === 'twitter';
}

export interface PostFilters {
  original: boolean;
  retweet: boolean;
  /** P3 才有来源能识别（见文件头）；false = 不约束 */
  quote: boolean;
  media: boolean;
  keywords: string[];
}

/** 默认只推原创、不论有没有图（用户 2026-09-16 选定） */
export function defaultPostFilters(): PostFilters {
  return { original: true, retweet: false, quote: false, media: false, keywords: [] };
}

export interface PostRuleRow {
  id: number;
  name: string;
  platform: string;
  account_ids: string;
  channels: string;
  filters: string;
  message_template: string | null;
  llm_judge: number;
  judge_prompt: string | null;
  llm_translate: number;
  enabled: number;
  sort: number;
  created_at: number;
  updated_at: number;
}

export interface PostRule {
  id: number;
  name: string;
  /** 这条规则吃哪个平台的帖子（账号 id 的解释域，见文件头） */
  platform: PostPlatform;
  /** 生效账号（对应平台名单的 id）；空 = 该平台全部账号（含以后新增的） */
  accountIds: number[];
  /** 引用 push_channels.id（与开播规则共用设置页那份渠道） */
  channels: number[];
  filters: PostFilters;
  messageTemplate: string | null;
  /** 交给 LLM 判定「要不要推」（口径 = judgePrompt，由人填） */
  llmJudge: boolean;
  /** 判定标准；llmJudge=true 时必填（没有标准的判定等于让模型自由发挥） */
  judgePrompt: string | null;
  /** 推送时附上 LLM 译文 */
  llmTranslate: boolean;
  enabled: boolean;
  /** 全局顺序 = 匹配优先级 */
  sort: number;
  createdAt: number;
  updatedAt: number;
}

export interface PostRuleInput {
  /** 带 id 且存在 = 改行；否则建行 */
  id?: number;
  name?: string;
  platform?: PostPlatform;
  accountIds?: number[];
  channels?: number[];
  filters?: Partial<PostFilters>;
  messageTemplate?: string | null;
  llmJudge?: boolean;
  judgePrompt?: string | null;
  llmTranslate?: boolean;
  enabled?: boolean;
}

export interface NewPostRule {
  name: string;
  platform: PostPlatform;
  accountIds: number[];
  channels: number[];
  filters: PostFilters;
  messageTemplate: string | null;
  llmJudge: boolean;
  judgePrompt: string | null;
  llmTranslate: boolean;
  enabled: boolean;
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

/** 库存 platform 宽松解析：认不出的值一律当 'twitter'（旧库全是 X 规则，不会误伤） */
export function parsePlatform(raw: string | null | undefined): PostPlatform {
  return raw === 'weibo' ? 'weibo' : 'twitter';
}

/** 过滤条件是否至少能命中点什么（original / retweet 都不勾 = 死规则） */
export function filtersAreUsable(f: PostFilters): boolean {
  return f.original || f.retweet;
}

/** 过滤条件在该平台上是否全部有意义（微博规则带 quote=true = 永不适用的死筛选） */
export function filtersSupported(platform: PostPlatform, f: PostFilters): boolean {
  return platformSupportsQuote(platform) || !f.quote;
}

/** 开了 LLM 判定就必须填判定标准：没有标准的判定等于让模型自由发挥（口径必须由人填） */
export function judgeIsUsable(llmJudge: boolean, judgePrompt: string | null): boolean {
  return !llmJudge || Boolean(judgePrompt && judgePrompt.trim());
}

export function rowToPostRule(r: PostRuleRow): PostRule {
  return {
    id: r.id,
    name: r.name,
    platform: parsePlatform(r.platform),
    accountIds: JSON.parse(r.account_ids) as number[],
    channels: JSON.parse(r.channels) as number[],
    filters: parseFilters(r.filters),
    messageTemplate: r.message_template,
    llmJudge: r.llm_judge === 1,
    judgePrompt: r.judge_prompt,
    llmTranslate: r.llm_translate === 1,
    enabled: r.enabled === 1,
    sort: r.sort,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}