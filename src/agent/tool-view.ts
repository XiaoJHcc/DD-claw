/**
 * 工具调用 → 面板 Agent 视图的展示形状（kimi 式工具行：图标 + 中文操作名 + 关键参数 +
 * 可展开的参数/结果明细）。
 *
 * 为什么在后端拼：同一轮工具往来要喂两个消费点——`POST /api/chat` 的实时回包（loop 累积）
 * 与 `GET /api/chat/history` 的历史回放（server 按 call id 配对后重建）——形状若各拼一份，
 * 前端就要面对两种口径。故本文件是唯一信源，loop 与 server 都从这里过。
 *
 * 中文操作名复用 `panel/undo-view.ts` 的 `undoToolTitle`（工具名 → 中文名的既有唯一信源）；
 * 失败判定与 `loop.runOneTool` 的失败回填文案同源（`错误：` 前缀），不另造口径。
 */
import type { ToolCall } from '../analysis/providers.js';
import { undoToolTitle } from '../panel/undo-view.js';

export interface ToolCallView {
  /** LLM 给的 call id（与 tool 结果行的配对键，也是前端轮询去重键） */
  id: string;
  /** 工具名 */
  name: string;
  /** 中文操作名（undoToolTitle；未知工具回退原名） */
  title: string;
  /** 关键参数一句话（'' = 无）；给人一眼认出「动了谁」 */
  target: string;
  /** 执行是否成功（结果文本不以「错误：」开头） */
  ok: boolean;
  /** 参数 JSON 美化串（截断；参数本身不是合法 JSON 时放原文） */
  args: string;
  /** 工具结果文本（截断，防历史载荷膨胀——list_* 全量名单可能很大） */
  output: string;
}

/** target 的优先取参顺序（覆盖了绝大多数工具的「操作对象」参数名） */
const TARGET_KEYS = ['name', 'query', 'key', 'uid', 'screen_name'] as const;

function cap(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

/** 从参数里挑一个「操作对象」给人看：优先具名键，否则第一个 string/number 值 */
function targetOf(args: Record<string, unknown> | null): string {
  if (args === null) return '';
  for (const k of TARGET_KEYS) {
    const v = args[k];
    if (typeof v === 'string' && v.trim() !== '') return cap(v.trim(), 24);
    if (typeof v === 'number') return String(v);
  }
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && v.trim() !== '') return cap(v.trim(), 24);
    if (typeof v === 'number') return String(v);
  }
  return '';
}

/** 一次工具调用 + 它的回填文本 → 展示形状（resultText = loop 回填给模型的同一份文本） */
export function toolCallView(call: ToolCall, resultText: string): ToolCallView {
  let args: Record<string, unknown> | null = null;
  try {
    const raw = call.arguments.trim();
    const parsed: unknown = raw === '' ? {} : JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    // 参数不是合法 JSON：target 留空，args 放原文（信息不丢，与 loop 的回填报错各司其职）
  }
  return {
    id: call.id,
    name: call.name,
    title: undoToolTitle(call.name),
    target: targetOf(args),
    ok: !resultText.startsWith('错误：'),
    args: cap(args === null ? call.arguments : JSON.stringify(args, null, 2), 800),
    output: cap(resultText, 1500),
  };
}
