import type { LiveEvent } from '../core/types.js';
import type { Category, PushRule } from '../core/push.js';
import type { PostFilters, PostPlatform, PostRule } from '../core/post-rules.js';

export interface CategoryMatch {
  matched: boolean;
  /** 命中的关键词/分区说明（入 verdicts.evidence，供事后追溯） */
  evidence: string;
}

/**
 * 分类规则的确定性判定（零 LLM 依赖）：
 * - keywords 组 → event.title 大小写不敏感子串命中任一
 * - areas 组 → areaName / parentAreaName 任一字段子串命中任一
 * - condMode 控制两组间关系：'and' 都中 / 'or' 任一中；空组忽略（只剩一组按该组判）
 * - 两组皆空 → 不命中（纯 LLM 分类不该被确定性路径误判为恒中）
 */
export function matchCategory(cat: Category, event: LiveEvent): CategoryMatch {
  const title = event.title.toLowerCase();
  const area = `${event.areaName}\n${event.parentAreaName}`.toLowerCase();
  const keywordHit = cat.keywords.find((k) => title.includes(k.toLowerCase()));
  const areaHit = cat.areas.find((a) => area.includes(a.toLowerCase()));
  const hasKeywords = cat.keywords.length > 0;
  const hasAreas = cat.areas.length > 0;

  let matched: boolean;
  if (!hasKeywords && !hasAreas) return { matched: false, evidence: '' };
  else if (cat.condMode === 'or') matched = keywordHit !== undefined || areaHit !== undefined;
  else matched = (!hasKeywords || keywordHit !== undefined) && (!hasAreas || areaHit !== undefined);

  const parts: string[] = [];
  if (keywordHit !== undefined) parts.push(`关键词「${keywordHit}」`);
  if (areaHit !== undefined) parts.push(`分区「${areaHit}」`);
  return { matched, evidence: parts.length > 0 ? `命中${parts.join('、')}` : '' };
}

/**
 * 推送规则的命中判定（确定性，无 LLM）：
 * 命中 =（categoryId 为空 = 任意开播，或 ∈ matchedCategoryIds）
 *      且（uids 为空 = 全部主播，或含 event.uid）
 * 返回全部命中规则（保持传入的 sort 顺序）：所有命中规则独立生效，
 * 由调用方对渠道取并集去重、推送词取首个非空。
 */
export function matchPushRules(
  rules: PushRule[],
  event: LiveEvent,
  matchedCategoryIds: Set<number>,
): PushRule[] {
  const hits: PushRule[] = [];
  for (const r of rules) {
    if (r.categoryId !== null && !matchedCategoryIds.has(r.categoryId)) continue;
    if (r.uids.length > 0 && !r.uids.includes(event.uid)) continue;
    hits.push(r);
  }
  return hits;
}

/** 渲染 {liver} {uname} {title} 变量（{liver} = 主播原名 uname，缺省回退简称 alias；推送文案一律原名） */
export function renderTemplate(tpl: string, event: LiveEvent): string {
  return tpl
    .replaceAll('{liver}', event.uname || event.alias)
    .replaceAll('{uname}', event.uname)
    .replaceAll('{title}', event.title);
}

// ---- 图文帖（X/推特 + 微博）：与开播规则平行的一套确定性判定 ----

/** matcher 眼里的「一条帖子」——不依赖 Post 行，由 pipeline 从 feed_post 载荷组装 */
export interface PostCandidate {
  /** 图文来源平台（规则按 platform + accountId 生效） */
  platform: PostPlatform;
  /** x_accounts.id / weibo_accounts.id（对应平台名单的行 id） */
  accountId: number;
  /** 账号标识：X = screen name（不含 @）；微博 = 数字 uid */
  screenName: string;
  /** 展示名：X = display_name（缺省回退 screen name）；微博 = 昵称（缺省回退 uid） */
  displayName?: string | null;
  /** 'tweet'/'retweet'（X）或 'mblog'/'retweet'（微博）——'retweet' 是两平台共用的转发语义 */
  type: string;
  text: string | null;
  pics: string[];
  pubTs: number;
  url: string | null;
  /** 只有 X 免登录回退路线能识别引用；undefined = 未知（RSS / 微博不标） */
  isQuote?: boolean;
  /** 可选关联主播的展示名（模板变量 {liver} 用） */
  biliName?: string | null;
}

/**
 * 机械筛选（纯确定性，零 LLM）：
 *  · 原创 / 转发 二选一（都不勾 = 死规则，保存时已拒绝）
 *  · 必须带图：勾上则 pics 非空
 *  · 关键词：非空则正文需命中任一（大小写不敏感子串）
 *  · quote：勾上则要求 isQuote === true —— 目前只有回退路线可能给出，RSS 帖永不命中
 */
export function matchPostFilters(f: PostFilters, post: PostCandidate): boolean {
  const kindOk = post.type === 'retweet' ? f.retweet : f.original;
  if (!kindOk) return false;
  if (f.quote && post.isQuote !== true) return false;
  if (f.media && post.pics.length === 0) return false;
  if (f.keywords.length > 0) {
    const text = (post.text ?? '').toLowerCase();
    if (!f.keywords.some((k) => text.includes(k.toLowerCase()))) return false;
  }
  return true;
}

/**
 * 图文帖规则命中判定：命中 =（platform 相同）且（accountIds 空 = 该平台全部账号，
 * 或含该账号）且通过机械筛选。返回全部命中规则（保持 sort 顺序）——
 * 所有命中规则独立生效，渠道取并集、推送词取首个非空。
 */
export function matchPostRules(rules: PostRule[], post: PostCandidate): PostRule[] {
  const hits: PostRule[] = [];
  for (const r of rules) {
    if (r.platform !== post.platform) continue;
    if (r.accountIds.length > 0 && !r.accountIds.includes(post.accountId)) continue;
    if (!matchPostFilters(r.filters, post)) continue;
    hits.push(r);
  }
  return hits;
}

/** 推送文案里的作者名：X 带 @，微博用昵称（uid 对人没有意义） */
export function postAuthorName(post: PostCandidate): string {
  if (post.platform === 'weibo') return post.displayName || post.screenName;
  return `@${post.screenName}`;
}

/** 内置默认推送词（规则没填 messageTemplate 时用） */
export function defaultPostTitle(post: PostCandidate): string {
  return post.platform === 'weibo'
    ? `${postAuthorName(post)} 发了新微博`
    : `${postAuthorName(post)} 发了新推文`;
}

/** 渲染图文帖推送词变量：{author} = 作者（X=@账号 / 微博=昵称），{text} = 正文，{url} = 链接，{liver} = 关联主播 */
export function renderPostTemplate(tpl: string, post: PostCandidate): string {
  return tpl
    .replaceAll('{author}', postAuthorName(post))
    .replaceAll('{screenName}', post.screenName)
    .replaceAll('{text}', post.text ?? '')
    .replaceAll('{url}', post.url ?? '')
    .replaceAll('{liver}', post.biliName || postAuthorName(post));
}
