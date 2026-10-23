import type { LiveEvent } from '../core/types.js';
import type { Category, CondMode, SubjectKind } from '../core/push.js';
import type { PostPlatform } from '../core/post-rules.js';
import { fromLiveEvent, type ContentItem } from './content.js';

export interface CategoryMatch {
  matched: boolean;
  /** 命中的关键词/分区说明（入 verdicts.evidence，供事后追溯） */
  evidence: string;
  /** 该分类对本内容类型是否有可用条件组（false = 纯模型分类 / 死分类，确定性无从判定） */
  hasConditions: boolean;
}

// ---- 条件算子注册表：分类条件组的确定性判定按算子注册（图文 filters 的算子 P2b 接入）----

/** 条件算子：对一组条件串判定内容项，返回命中证据文案或 null（未命中） */
export interface ConditionOperator {
  id: string;
  /** 适用的内容类型；不适用的算子一律按未命中处理 */
  appliesTo: Array<'live' | 'post'>;
  test(condValue: string[], item: ContentItem): string | null;
}

/** keyword：text 大小写不敏感子串，任一命中（证据用配置串原文） */
const keywordOperator: ConditionOperator = {
  id: 'keyword',
  appliesTo: ['live', 'post'],
  test(condValue, item) {
    const text = item.text.toLowerCase();
    const hit = condValue.find((k) => text.includes(k.toLowerCase()));
    return hit !== undefined ? `关键词「${hit}」` : null;
  },
};

/** area：仅 live，对 tags.area / tags.parentArea（两分区拼一行再子串，口径同旧实现） */
const areaOperator: ConditionOperator = {
  id: 'area',
  appliesTo: ['live'],
  test(condValue, item) {
    const hay = `${item.tags.area ?? ''}\n${item.tags.parentArea ?? ''}`.toLowerCase();
    const hit = condValue.find((a) => hay.includes(a.toLowerCase()));
    return hit !== undefined ? `分区「${hit}」` : null;
  },
};

/** postType：仅 post，tags.type（投影时已折叠成 original/retweet）∈ 条件集合 */
const postTypeOperator: ConditionOperator = {
  id: 'postType',
  appliesTo: ['post'],
  test(condValue, item) {
    const t = item.tags.type ?? '';
    return condValue.includes(t) ? `类型「${t === 'retweet' ? '转发' : '原创'}」` : null;
  },
};

/** quote：仅 post，必须是引用帖（tags.isQuote==='true'；unknown 按未命中——沿用旧 quote 语义） */
const quoteOperator: ConditionOperator = {
  id: 'quote',
  appliesTo: ['post'],
  test(_condValue, item) {
    return item.tags.isQuote === 'true' ? '引用帖' : null;
  },
};

/** media：仅 post，必须带图（tags.hasMedia==='true'） */
const mediaOperator: ConditionOperator = {
  id: 'media',
  appliesTo: ['post'],
  test(_condValue, item) {
    return item.tags.hasMedia === 'true' ? '带图' : null;
  },
};

/** 条件算子注册表（分类条件组的确定性判定按算子注册；live 用 keyword/area，post 用 keyword/postType/quote/media） */
export const CONDITION_OPERATORS: Readonly<Record<string, ConditionOperator>> = {
  keyword: keywordOperator,
  area: areaOperator,
  postType: postTypeOperator,
  quote: quoteOperator,
  media: mediaOperator,
};

function testOperator(op: ConditionOperator, condValue: string[], item: ContentItem): string | null {
  return op.appliesTo.includes(item.subjectType) ? op.test(condValue, item) : null;
}

/**
 * 条件组判定（算子注册表版，分类条件组共用）：
 * - 每组 = 算子 + 条件串列表；空组忽略（只剩一组按该组判）
 * - condMode 控制组间关系：'and' 都中 / 'or' 任一中
 * - 无有效组 → 不命中（纯 LLM 分类不该被确定性路径误判为恒中）
 * - evidence = 命中的组证据按组序拼「命中关键词「xx」、分区「yy」」（部分组命中也照记）
 * - hasConditions = 至少一组在**本内容类型**上可判定（不适用的算子不算条件）
 */
function matchByGroups(
  groups: ReadonlyArray<{ op: ConditionOperator; values: string[] }>,
  item: ContentItem,
  condMode: CondMode,
): CategoryMatch {
  const active = groups.filter((g) => g.values.length > 0);
  const applicable = active.filter((g) => g.op.appliesTo.includes(item.subjectType));
  const hasConditions = applicable.length > 0;
  if (active.length === 0) return { matched: false, evidence: '', hasConditions };
  const hits = active
    .map((g) => testOperator(g.op, g.values, item))
    .filter((s): s is string => s !== null);
  const matched = condMode === 'or' ? hits.length > 0 : hits.length === active.length;
  return { matched, evidence: hits.length > 0 ? `命中${hits.join('、')}` : '', hasConditions };
}

/** 分类判定的内容项入口（matchCategory 的 ContentItem 形态）：keywords/areas/post_types/require_quote/require_media 五组 */
export function matchCategoryItem(cat: Category, item: ContentItem): CategoryMatch {
  return matchByGroups(
    [
      { op: keywordOperator, values: cat.keywords },
      { op: areaOperator, values: cat.areas },
      { op: postTypeOperator, values: cat.postTypes },
      // require_quote / require_media 是开关型条件组：置位即该组参与（算子只看内容标签，值仅占位）
      { op: quoteOperator, values: cat.requireQuote ? ['1'] : [] },
      { op: mediaOperator, values: cat.requireMedia ? ['1'] : [] },
    ],
    item,
    cat.condMode,
  );
}

/**
 * 分类规则的确定性判定（零 LLM 依赖）：投影 ContentItem 后走条件算子注册表。
 * - keywords 组 → keyword 算子（text 子串）；areas 组 → area 算子（分区标签）
 * - postTypes 组 → postType 算子；requireQuote / requireMedia → quote / media 算子（开关型）
 * - condMode / 空组忽略 / 无有效组不命中 / evidence 格式与旧实现逐字一致
 */
export function matchCategory(cat: Category, event: LiveEvent): CategoryMatch {
  return matchCategoryItem(cat, fromLiveEvent(event));
}

/**
 * 推送规则的命中判定（确定性，无 LLM；两形态统一的 matchRules）：
 * 命中 =（subjectKind 与内容形态一致）
 *      ∧（categoryId 为空 = 任意内容，或 ∈ matchedCategoryIds）
 *      ∧（scope 为空 = 全部生效，或含 subjectRef——live=uid / post=`平台:账号键`）
 * 返回全部命中规则（保持传入的 sort 顺序）：所有命中规则独立生效，
 * 由调用方对渠道取并集去重、推送词取首个非空。
 */
export function matchRules<T extends { subjectKind: SubjectKind; categoryId: number | null; scope: string[] }>(
  rules: T[],
  item: { subjectType: SubjectKind },
  matchedCategoryIds: Set<number>,
  subjectRef: string,
): T[] {
  const hits: T[] = [];
  for (const r of rules) {
    if (r.subjectKind !== item.subjectType) continue;
    if (r.categoryId !== null && !matchedCategoryIds.has(r.categoryId)) continue;
    if (r.scope.length > 0 && !r.scope.includes(subjectRef)) continue;
    hits.push(r);
  }
  return hits;
}

/**
 * 命中规则的聚合形态（结构化约束）：PushRule 两形态的公共子集，聚合只看这两字段。
 */
export interface RuleHit {
  channels: number[];
  messageTemplate: string | null;
}

export interface RuleAggregation {
  /** 各命中规则 channels 的并集（去重保序 = 首次出现序） */
  channels: number[];
  /** 命中序（调用方已按 sort 序）里首个非 null 的 messageTemplate；全 null = null */
  template: string | null;
}

/**
 * 命中规则 → 推送聚合（直播 / 图文共用的纯聚合，缺省模板回退由调用方注入）：
 * 渠道 = 各命中规则 channels 的并集（去重保序）；推送词 = 首个非 null 的 messageTemplate
 * （??= 语义，与旧两处内联实现逐字一致）。返回 null = 无命中规则 / 并集为空（= 不推）。
 */
export function aggregateRuleHits(hits: RuleHit[]): RuleAggregation | null {
  if (hits.length === 0) return null;
  const channels: number[] = [];
  let template: string | null = null;
  for (const r of hits) {
    for (const id of r.channels) {
      if (!channels.includes(id)) channels.push(id);
    }
    template ??= r.messageTemplate;
  }
  if (channels.length === 0) return null;
  return { channels, template };
}

/**
 * 模板渲染公共实现：变量名 → 取值函数的 map，按定义序逐个 replaceAll
 * （顺序替换语义与旧实现逐字一致：先替换出的文本若含后续占位符，也会被后续替换）。
 */
function renderByVars<T>(tpl: string, vars: Readonly<Record<string, (src: T) => string>>, src: T): string {
  let out = tpl;
  for (const [name, get] of Object.entries(vars)) out = out.replaceAll(`{${name}}`, get(src));
  return out;
}

/** 直播推送词变量集（定义序 = 替换序）：{liver} = 主播原名 uname，缺省回退简称 alias */
const LIVE_TEMPLATE_VARS: Readonly<Record<string, (e: LiveEvent) => string>> = {
  liver: (e) => e.uname || e.alias,
  uname: (e) => e.uname,
  title: (e) => e.title,
};

/** 渲染 {liver} {uname} {title} 变量（{liver} = 主播原名 uname，缺省回退简称 alias；推送文案一律原名） */
export function renderTemplate(tpl: string, event: LiveEvent): string {
  return renderByVars(tpl, LIVE_TEMPLATE_VARS, event);
}

// ---- 图文帖（X/推特 + 微博 + B站动态）：PostCandidate 投影 + 推送词渲染 ----
// 判定与规则命中已统一走分类条件组（matchCategoryItem）与 matchRules（subject_kind='post'），
// 这里只剩「一条帖子」的载体与文案渲染。

/** matcher 眼里的「一条帖子」——不依赖 Post 行，由 pipeline 从 feed_post 载荷组装 */
export interface PostCandidate {
  /** 帖子来源平台：决定文案措辞（{author}/「推文/微博/动态」）、quote 语义与 LLM 翻译门控 */
  platform: PostPlatform;
  /** 帖子平台内唯一 id（posts.item_id / feed_post 载荷）；ContentItem.subjectId 用它拼 `platform:itemId` */
  itemId?: string;
  /** 对应平台名单的行 id（x_accounts / weibo_accounts / bili_accounts） */
  accountId: number;
  /** 账号标识：X = screen name（不含 @）；微博 / B站动态 = 数字 uid。规则 scope 引用也用它（postSubjectRef） */
  screenName: string;
  /** 展示名：自定义显示名 → 平台昵称/用户名（再缺省回退标识本身，由渲染层兜底） */
  displayName?: string | null;
  /** 'tweet'/'retweet'（X）、'mblog'/'retweet'（微博）、B站动态 DYNAMIC_TYPE_*
   *  （FORWARD 已在 source 归一成 'retweet'，LIVE_RCMD 不再产出）——'retweet' 是
   *  三平台共用的转发语义，投影时折叠成 original/retweet（见 fromPostCandidate） */
  type: string;
  text: string | null;
  pics: string[];
  pubTs: number;
  url: string | null;
  /** 只有 X 免登录回退路线能识别引用；undefined = 未知（RSS / 微博 / B站动态不标） */
  isQuote?: boolean;
  /** 可选关联主播的展示名（模板变量 {liver} 用；B站动态按 uid 直接反查 streamers） */
  biliName?: string | null;
}

/** 推送文案里的作者名：X 带 @，其余平台用展示名（uid 对人没有意义，只作兜底） */
export function postAuthorName(post: PostCandidate): string {
  if (post.platform === 'twitter') return `@${post.screenName}`;
  return post.displayName || post.screenName;
}

/** 内置默认推送词（规则没填 messageTemplate 时用）：X 带「显示名 @账号」，其余平台用展示名 */
export function defaultPostTitle(post: PostCandidate): string {
  const noun = post.platform === 'weibo' ? '微博' : post.platform === 'bili_dynamic' ? '动态' : '推文';
  const author = post.platform === 'twitter' && post.displayName
    ? `${post.displayName} @${post.screenName}`
    : postAuthorName(post);
  return `${author} 发布新${noun}`;
}

/** 图文帖推送词变量集（定义序 = 替换序）：{author} = 作者（X=@账号 / 其余=展示名），{liver} = 关联主播回退作者 */
const POST_TEMPLATE_VARS: Readonly<Record<string, (p: PostCandidate) => string>> = {
  author: (p) => postAuthorName(p),
  screenName: (p) => p.screenName,
  text: (p) => p.text ?? '',
  url: (p) => p.url ?? '',
  liver: (p) => p.biliName || postAuthorName(p),
};

/** 渲染图文帖推送词变量：{author} = 作者（X=@账号 / 其余=展示名），{screenName} = 账号标识，{text} = 正文，{url} = 链接，{liver} = 关联主播 */
export function renderPostTemplate(tpl: string, post: PostCandidate): string {
  return renderByVars(tpl, POST_TEMPLATE_VARS, post);
}
