/**
 * 能力面 → LLM 工具面：把注册表的 zod shape 转成 function 定义（`ToolSpec`）。
 *
 * 两道闸门，对应计划里「两个概念必须分开」：
 * ① **回滚覆盖**（配置写路径全部过注册表）由 `runTool` 承担，与本文件无关；
 * ② **工具暴露**（LLM 是否看得见）在这里用**显式排除名单**表达——默认全给，
 *    只挖掉「有对外副作用/不可撤销」与「排序类」。
 * 名单是生产代码里的常量（不是文档表格），`src/panel/write-path-inventory.test.ts` 会与它对齐校验，
 * 所以「哪些进 agent 工具面」只有一处信源。
 *
 * 角色过滤复用注册表已有的 `toolDefsForRole()`：调用方先按角色取 defs，再过 `agentToolSpecs()`。
 * 集成状态：**尚未接线**（新建文件、零冲突；agent loop 落地时用）。
 */
import { z } from 'zod';
import type { ToolSpec } from '../analysis/providers.js';
import type { McpToolDef } from '../mcp/tools.js';

/**
 * 有意**不**暴露给 agent 的工具：
 * - 排序类（`reorder_*`）：进注册表是为了纳入回滚覆盖；让 LLM 拖排序没有产品价值，反而多一次误写机会
 * - `test_push` / `test_llm_provider`：有对外副作用（真发一条消息）或触发熔断计数，不可撤销
 */
export const AGENT_EXCLUDED_TOOLS: readonly string[] = [
  'reorder_push_rules',
  'reorder_categories',
  'reorder_channels',
  'reorder_llm_providers',
  'test_push',
  'test_llm_provider',
];

/** LLM 是否看得见这个工具 */
export function isAgentExposed(name: string): boolean {
  return !AGENT_EXCLUDED_TOOLS.includes(name);
}

/**
 * zod raw shape → 参数 JSON Schema。
 * 用 zod v4 的 `toJSONSchema`（零新依赖），并剥掉 `$schema` 元键——部分端点对未知顶层字段敏感。
 */
export function paramsFromShape(shape: Record<string, z.ZodTypeAny>): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(shape), { io: 'input' }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

export function toolSpecFromDef(def: McpToolDef): ToolSpec {
  return {
    name: def.name,
    description: def.description,
    parameters: paramsFromShape(def.schema),
  };
}

/** 按暴露策略转换（调用方先按角色筛 defs，例如 `toolDefsForRole('admin')`） */
export function agentToolSpecs(defs: readonly McpToolDef[]): ToolSpec[] {
  return defs.filter((d) => isAgentExposed(d.name)).map(toolSpecFromDef);
}
