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
 * 集成状态：**已接线**（`src/agent/loop.ts` 每轮按 admin 角色取工具面）。
 */
import { z } from 'zod';
import type { ToolSpec } from '../analysis/providers.js';
import type { McpToolDef } from '../mcp/tools.js';

/**
 * 有意**不**暴露给 agent 的工具：
 * - 排序类（`reorder_*`）：进注册表是为了纳入回滚覆盖；让 LLM 拖排序没有产品价值，反而多一次误写机会
 * - `test_push` / `test_llm_provider` / `test_x_connection`：有对外副作用（真发一条消息）或触发熔断计数/网络探测，不可撤销
 * - `test_category`：分类草稿试跑要读历史归档并占分析队列（一次最多 20 条样本 × 两档模型），
 *   结论是给人看的；让 LLM 自己在对话里跑测试既浪费额度又拿不到可信对照
 * - `set_chat_mode`：写前询问的开关**不能让 agent 自己关**——能切到 auto 就等于把
 *   「未经确认不写」的门槛交回给模型，P1 验收的「误写率 0 容忍」会名存实亡
 * - `set_chat_provider`：换模型**同样是主人的决定**（选便宜/贵的、选更听话的），理由与上一条同：
 *   模型若能自己指定「谁来答」，就等于绕开主人对成本与质量的取舍；它也不该在自己出问题时改配置
 */
export const AGENT_EXCLUDED_TOOLS: readonly string[] = [
  'reorder_push_rules',
  'reorder_categories',
  'reorder_channels',
  'reorder_llm_providers',
  'reorder_decision_providers',
  'test_push',
  'test_llm_provider',
  'test_decision_provider',
  'test_x_connection',
  'test_category',
  'set_chat_mode',
  'set_chat_provider',
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
