import type { LiveEvent } from '../core/types.js';
import type { PushRule } from '../core/push.js';

/**
 * 透明条件规则的命中判定（确定性，无 LLM）：
 * - keywords 非空 → event.title 大小写不敏感子串命中任一
 * - areas 非空 → areaName / parentAreaName 任一字段子串命中任一
 * - 两组都非空 = AND（都要中）；两组都空 = 空条件规则（恒命中 = 任意匹配）
 * 返回全部命中规则（保持传入的 sort 顺序）：所有命中规则独立生效，
 * 由调用方对渠道取并集去重。空条件规则与其他规则同等参与，不再单独兜底。
 */
export function matchPushRules(rules: PushRule[], event: LiveEvent): PushRule[] {
  const title = event.title.toLowerCase();
  const area = `${event.areaName}\n${event.parentAreaName}`.toLowerCase();
  const hits: PushRule[] = [];
  for (const r of rules) {
    const needKeywords = r.keywords.length > 0;
    const needAreas = r.areas.length > 0;
    if (needKeywords && !r.keywords.some((k) => title.includes(k.toLowerCase()))) continue;
    if (needAreas && !r.areas.some((a) => area.includes(a.toLowerCase()))) continue;
    hits.push(r);
  }
  return hits;
}

/** 渲染 {alias} {uname} {title} 变量（alias 缺省回退 uname） */
export function renderTemplate(tpl: string, event: LiveEvent): string {
  return tpl
    .replaceAll('{alias}', event.alias || event.uname)
    .replaceAll('{uname}', event.uname)
    .replaceAll('{title}', event.title);
}
