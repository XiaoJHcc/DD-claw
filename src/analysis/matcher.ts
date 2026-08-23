import type { LiveEvent } from '../core/types.js';
import type { Category, PushRule } from '../core/push.js';

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

/** 渲染 {liver} {uname} {title} 变量（liver 为主播名称，缺省回退 uname） */
export function renderTemplate(tpl: string, event: LiveEvent): string {
  return tpl
    .replaceAll('{liver}', event.alias || event.uname)
    .replaceAll('{uname}', event.uname)
    .replaceAll('{title}', event.title);
}
