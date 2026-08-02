import type { LiveEvent, PushMessage } from '../core/types.js';
import type { PreferenceClause } from '../core/streamers.js';
import type { SceneVerdict } from './types.js';
import { liveEventToMessage } from '../notify/message.js';

const PRIORITY_RANK = { high: 3, normal: 2, low: 1 } as const;

/**
 * 单条子句的命中判定。条件为 AND：
 * - scenes 非空 → verdict 非空、scene 命中、且 confidence ≥ (minConfidence ?? 0)
 * - titleKeywords 非空 → event.title 大小写不敏感子串命中任一
 * 两者都空 = 该主播的兜底子句，恒命中。
 */
function clauseMatches(
  c: PreferenceClause,
  event: LiveEvent,
  verdict: SceneVerdict | null,
): boolean {
  if (c.uid !== event.uid) return false;
  const needScene = c.scenes.length > 0;
  const needTitle = c.titleKeywords.length > 0;
  if (!needScene && !needTitle) return true;
  if (needScene) {
    if (!verdict) return false;
    if (!c.scenes.includes(verdict.scene)) return false;
    if (verdict.confidence < (c.minConfidence ?? 0)) return false;
  }
  if (needTitle) {
    const title = event.title.toLowerCase();
    if (!c.titleKeywords.some((k) => title.includes(k.toLowerCase()))) return false;
  }
  return true;
}

/**
 * 确定性偏好执行：verdict × preference_clauses → 命中的子句（无命中返回 null，
 * 调用方走 M1 默认行为）。偏好链路零 LLM 依赖，verdict 可来自 LLM 也可来自 L0。
 * 多条命中取优先级高者（high > normal > low），同级取 id 小者（先填先生效）。
 */
export function matchClauses(
  clauses: PreferenceClause[],
  event: LiveEvent,
  verdict: SceneVerdict | null,
): PreferenceClause | null {
  let best: PreferenceClause | null = null;
  for (const c of clauses) {
    if (!clauseMatches(c, event, verdict)) continue;
    if (
      !best ||
      PRIORITY_RANK[c.priority] > PRIORITY_RANK[best.priority] ||
      (c.priority === best.priority && c.id < best.id)
    ) {
      best = c;
    }
  }
  return best;
}

/** 渲染 {alias} {uname} {title} 变量（alias 缺省回退 uname） */
function renderTemplate(tpl: string, event: LiveEvent, alias: string): string {
  return tpl
    .replaceAll('{alias}', alias || event.uname)
    .replaceAll('{uname}', event.uname)
    .replaceAll('{title}', event.title);
}

/**
 * 子句 → PushMessage：模板渲染结果为标题；正文/图片/跳转/ref 沿用 M1 默认
 * 消息的形状（liveEventToMessage），优先级与 targets 来自子句。
 * targets 为 null 时缺省，各通道用自己配置的默认目标。
 */
export function composeMessage(
  clause: PreferenceClause,
  event: LiveEvent,
  alias: string,
): PushMessage {
  const base = liveEventToMessage(event);
  const text = renderTemplate(clause.messageTemplate, event, alias).trim();
  return {
    ...base,
    title: text || base.title,
    priority: clause.priority,
    targets: clause.targets ?? undefined,
  };
}
