import type { LiveEvent } from '../core/types.js';
import type { PushRule } from '../core/push.js';

/**
 * 透明条件规则的命中判定（确定性，无 LLM）：
 * - keywords 非空 → event.title 大小写不敏感子串命中任一
 * - areas 非空 → areaName / parentAreaName 任一字段子串命中任一
 * - 两组都非空 = AND（都要中）；两组都空 = 空条件规则（恒命中）
 * 调用方按 id 升序传入，第一条命中生效。
 * 空条件规则 = 旧「默认推送」，已改为全局默认推送（settings.default_channels，pipeline 兜底），
 * 面板/API 不再产生；这里的 fallback 分支仅作存量数据防御。
 */
export function matchPushRule(rules: PushRule[], event: LiveEvent): PushRule | null {
  const title = event.title.toLowerCase();
  const area = `${event.areaName}\n${event.parentAreaName}`.toLowerCase();
  let fallback: PushRule | null = null;
  for (const r of rules) {
    const needKeywords = r.keywords.length > 0;
    const needAreas = r.areas.length > 0;
    if (!needKeywords && !needAreas) {
      fallback ??= r; // 默认规则：只留第一条，等其他规则都不命中时兜底
      continue;
    }
    if (needKeywords && !r.keywords.some((k) => title.includes(k.toLowerCase()))) continue;
    if (needAreas && !r.areas.some((a) => area.includes(a.toLowerCase()))) continue;
    return r;
  }
  return fallback;
}

/** 渲染 {alias} {uname} {title} 变量（alias 缺省回退 uname） */
export function renderTemplate(tpl: string, event: LiveEvent): string {
  return tpl
    .replaceAll('{alias}', event.alias || event.uname)
    .replaceAll('{uname}', event.uname)
    .replaceAll('{title}', event.title);
}
