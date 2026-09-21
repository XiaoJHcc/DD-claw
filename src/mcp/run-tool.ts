/**
 * runTool()：能力层的**唯一执行入口**（docs/plan/agent-access.md「能力层调用域」/「P0 地基」）。
 *
 * 为什么需要它：现在参数校验由 MCP SDK 按 zod shape 做、审计写在 `tools.ts` 的 registerTools 闭包里。
 * 一旦出现第二个适配器（面板 REST 收敛、WebUI Agent、NapCat 直连）**直调 handler**，
 * 校验与审计会同时丢掉——写操作的撤销栈也就不可能彻底。故校验/审计/错误归一收在这一处。
 *
 * 契约：
 * - `ctx = { name, role, scope: { channelId? } }`：身份与调用域由**接入层**解析后传入；
 *   能力层只读不推断，`channelId` 这类身份字段**永不进工具 schema**（进去就等于交给 LLM）。
 * - 结果与错误文案在这里归一：同一条工具调用在任何入口拿到同一句中文结果/错误；
 *   `text` 字段与改造前 `/mcp` 的输出**逐字一致**（`JSON.stringify(data ?? {ok:true}, null, 2)` /
 *   `错误：<msg>`），所以接线 registerTools 时 MCP 侧行为零变化。
 * - 写操作（`def.write`）在执行前经过审计与 `beforeWrite` 快照钩子。
 *
 * 有意未做的部分：
 * - 快照与写入的**同事务**保证不在本函数里：better-sqlite3 事务不能跨 await，而 handler 的
 *   异步校验（如 resolveWeiboNick）发生在写之前。实际记录点是 `UndoStore.track()`
 *   （经 `runToolTracked` 接线，REST 与 /mcp 同走），取舍见 `undo.ts`；`beforeWrite` 钩子保留给
 *   后续逐路径把「快照 + 同步 SQL 写」收进同一个 `Db.transaction` 的精修。
 */
import { z } from 'zod';
import { makeLogger } from '../logger.js';
import { HttpError } from '../panel/http-util.js';
import type { PanelDeps } from '../panel/server.js';
import { adminScope, channelScope, type ChangeMeta } from '../core/undo.js';
import type { McpAuth } from './auth.js';
import type { McpToolDef } from './tools.js';

const log = makeLogger('mcp');

/** 一次工具调用的完整描述（审计与快照钩子的入参） */
export interface ToolCall {
  def: McpToolDef;
  /** 已过 zod 校验的参数（未知键被剥离） */
  args: Record<string, unknown>;
  ctx: McpAuth;
}

export interface RunToolHooks {
  /**
   * 写操作执行**前**的记录点（P0 撤销栈：记录受影响行的前像）。
   * 抛错则整次调用失败且不写库（宁可写不进去，也不要写了却撤不掉）。
   */
  beforeWrite?: (call: ToolCall) => void | Promise<void>;
  /** 审计；缺省写结构化日志（写操作 + 参数摘要，llm key 打码） */
  audit?: (call: ToolCall) => void;
}

export interface ToolSuccess {
  ok: true;
  data: unknown;
  /** 与改造前 /mcp 的 content[0].text 逐字一致 */
  text: string;
}

export interface ToolFailure {
  ok: false;
  /** 归一后的中文错误（不含「错误：」前缀） */
  error: string;
  /** `错误：${error}`，与改造前 /mcp 的 isError 文案逐字一致 */
  text: string;
  /** 供 REST 收敛时映射状态码（HttpError 的原状态；参数不合法 = 400） */
  status?: number;
}

export type ToolResult = ToolSuccess | ToolFailure;

/** 取调用域渠道。未绑定返回 undefined——gateway 写路径必须自行拒绝，绝不回落默认渠道 */
export function scopeChannelId(ctx: McpAuth): number | undefined {
  return ctx.scope.channelId;
}

/** 变更记录/撤销栈的归属：gateway 按令牌绑定渠道独立栈；admin（含面板）共用全局栈 */
export function scopeOf(ctx: McpAuth): string {
  const ch = scopeChannelId(ctx);
  return ch === undefined ? adminScope() : channelScope(ch);
}

/**
 * 撤销栈标识：admin 一律全局栈；gateway 必须绑渠道，未绑定**拒绝**（绝不回落 admin 栈——
 * 否则 QQ 侧一句「撤销」就能回退主人的全局配置）。
 */
export function undoScopeOf(ctx: McpAuth): string {
  if (ctx.role === 'admin') return adminScope();
  const ch = scopeChannelId(ctx);
  if (ch === undefined) throw new HttpError(403, '本令牌未绑定渠道，不能撤销变更');
  return channelScope(ch);
}

/** zod 校验：只有过了这一关的 args 才可能进 handler（第二个适配器也绕不过） */
function validateArgs(
  def: McpToolDef,
  args: Record<string, unknown>,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const parsed = z.object(def.schema).safeParse(args);
  if (parsed.success) return { ok: true, args: parsed.data as Record<string, unknown> };
  const detail = parsed.error.issues
    .map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`)
    .join('；');
  return { ok: false, error: `参数不合法：${detail}` };
}

/** 审计日志：写操作 + 角色 + 调用域渠道 + 参数摘要（llm key 值打码）。entry 是入口名（MCP / 面板） */
function auditLine(entry: string, call: ToolCall): void {
  const sanitized = { ...call.args };
  if (call.def.name === 'set_llm_key' && 'value' in sanitized) sanitized.value = '***';
  if ('key' in sanitized) sanitized.key = '***';
  const scope = scopeChannelId(call.ctx);
  const who = scope === undefined
    ? `${call.ctx.role}:${call.ctx.name}`
    : `${call.ctx.role}:${call.ctx.name} #ch${scope}`;
  log.info(`${entry} 写操作 [${who}] ${call.def.name} ${JSON.stringify(sanitized)}`);
}

/** 审计：写操作 + 角色 + 调用域渠道 + 参数摘要（llm key 打码） */
function defaultAudit(call: ToolCall): void {
  auditLine('MCP', call);
}

function fail(error: string, status?: number): ToolFailure {
  return status === undefined
    ? { ok: false, error, text: `错误：${error}` }
    : { ok: false, error, text: `错误：${error}`, status };
}

/**
 * 执行一次工具调用。**不抛异常**：业务错误（含 HttpError）归一为 ToolFailure，
 * 由各入口决定怎么呈现（/mcp → isError 文本；REST → status + {error}）。
 */
export async function runTool(
  deps: PanelDeps,
  def: McpToolDef,
  args: Record<string, unknown>,
  ctx: McpAuth,
  hooks: RunToolHooks = {},
): Promise<ToolResult> {
  const validated = validateArgs(def, args);
  if (!validated.ok) return fail(validated.error, 400);

  const call: ToolCall = { def, args: validated.args, ctx };
  try {
    if (def.write) {
      if (hooks.audit) hooks.audit(call);
      else defaultAudit(call);
      if (hooks.beforeWrite) await hooks.beforeWrite(call);
    }
    const data = await def.handler(deps, call.args, ctx);
    return { ok: true, data, text: JSON.stringify(data ?? { ok: true }, null, 2) };
  } catch (e) {
    if (e instanceof HttpError) return fail(e.message, e.status);
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/** 面板 REST 入口的固定身份：回环免 token = admin（鉴权口径见 auth.ts 头注释） */
export const PANEL_TOOL_CTX: McpAuth = { name: 'panel', role: 'admin', scope: {} };

/** 变更记录归属：gateway 按令牌绑定渠道独立栈；admin / 面板共用全局栈（主人只有一个） */
export function toolChangeMeta(ctx: McpAuth, entry: 'panel' | 'mcp', tool: string): ChangeMeta {
  return {
    scope: scopeOf(ctx),
    actor: ctx.name,
    entry,
    tool,
  };
}

/**
 * 写工具的快照接线（P0 判据 3 的执行形态）：`def.write` 且装配了 UndoStore 时，
 * 整个调用经 `UndoStore.track()` 串行落变更记录（前像/后像差分方案与取舍见 undo.ts）；
 * 否则直退 runTool（校验/审计/错误归一不变）。写路径的两类入口（/mcp 与面板 REST）都走这里。
 *
 * `def.track === false` 的写工具（只有撤销执行器 `undo_last_change`）照常审计，但**不进快照**：
 * 它的写是把已记录的前像写回去，再记一笔会把自己变成下一条可撤销记录。
 */
export async function runToolTracked(
  deps: PanelDeps,
  def: McpToolDef,
  args: Record<string, unknown>,
  ctx: McpAuth,
  entry: 'panel' | 'mcp',
): Promise<ToolResult> {
  const hooks: RunToolHooks = { audit: (call) => auditLine(entry === 'panel' ? '面板' : 'MCP', call) };
  if (!def.write || def.track === false || !deps.undo) return runTool(deps, def, args, ctx, hooks);
  const { value } = await deps.undo.track(
    toolChangeMeta(ctx, entry, def.name),
    () => runTool(deps, def, args, ctx, hooks),
  );
  return value;
}
