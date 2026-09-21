/**
 * post_rules 表（图文帖规则，平台无关）的行类型与「行 ↔ 对象」映射。
 *
 * 与 push_rules（开播规则）**平行**、互不影响：开播规则卡一个字没动，
 * 图文帖规则有自己的一张表、一套排序、一套 matcher（见 analysis/matcher.ts）。
 *
 * **规则只定义「筛选 + 渠道 + 推送词」，生效范围在账号侧**：账号名单行
 * （x_accounts / weibo_accounts / bili_accounts）的 `rule_ids` 选用本表规则——
 * 「这个账号的帖子按哪几条规则推」是账号的属性，规则本身不含账号集合。
 * 库里的 `account_ids` 列是旧设计的遗留，保留不删但写入侧恒 '[]'
 * （旧数据由 Db.migratePostRuleScopes 一次性搬到账号侧）。
 *
 * **规则平台无关**：任何平台的账号都可选用任何规则，命中 = 账号侧 ruleIds 包含
 * 该规则 + 过机械筛选。库里的 `platform` 列是旧设计的遗留，保留不删（SQLite 不删列），
 * 但代码不再读不再写；`PostRuleRow.platform` 字段仅为 SELECT * 的形状保留。
 * PostPlatform / platformLabel / platformSupportsQuote / platformSupportsTranslate
 * 转为**帖子侧**语义：PostCandidate.platform 决定文案措辞、quote 语义与翻译门控。
 *
 * filters 语义（钉死在这里，UI 与 matcher 都照它）：
 *  · original / retweet：**二选一必选**（都不选 = 规则永不命中，保存时就拒绝）
 *  · media：勾上则必须带图（AND）
 *  · keywords：非空则正文需命中任一（大小写不敏感子串，AND）
 *  · quote：勾上则要求帖子确实标了引用——只有 X 的免登录 HTML 回退路线能给出 isQuote，
 *    其余来源 isQuote 恒 undefined，勾 quote 的规则对非 X 帖**永不命中**
 *    （这是语义而非校验错误：规则平台无关，同一条规则可能被 X 账号选用）。
 *    微博的「转发」在抓取层就折进 retweet（正文带 `//转发自 @原作者`），B站动态同理
 *    （DYNAMIC_TYPE_FORWARD 在 pipeline 归一成 retweet），都没有独立的引用实体。
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

/** 该平台的帖子是否需要 LLM 翻译（微博与B站动态本就中文，译文没有意义；运行时按 post.platform 门控，判定各平台都适用） */
export function platformSupportsTranslate(platform: PostPlatform): boolean {
  return platform === 'twitter';
}

export interface PostFilters {
  original: boolean;
  retweet: boolean;
  /** 勾上要求帖子标了引用（isQuote === true）；只有 X 帖可能给出，对非 X 帖永不命中（语义，见文件头） */
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
  /** 旧设计的遗留列（规则已平台无关），保留不删但不再读不再写；仅为 SELECT * 的形状保留 */
  platform: string;
  /** 旧设计的生效范围（遗留列，保留不删）；rowToPostRule 不读，生效范围在账号侧 rule_ids */
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
  /** 引用 push_channels.id（与开播规则共用设置页那份渠道） */
  channels: number[];
  filters: PostFilters;
  messageTemplate: string | null;
  /** 交给 LLM 判定「要不要推」（口径 = judgePrompt，由人填） */
  llmJudge: boolean;
  /** 判定标准；llmJudge=true 时必填（没有标准的判定等于让模型自由发挥） */
  judgePrompt: string | null;
  /** 推送时附上 LLM 译文（运行时只对 X 帖生效，见 analysis/post-analyzer） */
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

/** 过滤条件是否至少能命中点什么（original / retweet 都不勾 = 死规则） */
export function filtersAreUsable(f: PostFilters): boolean {
  return f.original || f.retweet;
}

/** 开了 LLM 判定就必须填判定标准：没有标准的判定等于让模型自由发挥（口径必须由人填） */
export function judgeIsUsable(llmJudge: boolean, judgePrompt: string | null): boolean {
  return !llmJudge || Boolean(judgePrompt && judgePrompt.trim());
}

export function rowToPostRule(r: PostRuleRow): PostRule {
  return {
    id: r.id,
    name: r.name,
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