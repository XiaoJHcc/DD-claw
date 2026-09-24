/**
 * DD-claw 自己的 agent loop（P1 WebUI Agent / P3 NapCat 直连，docs/plan/agent-access.md
 * 「P1：agent loop + WebUI Agent」「P3：NapCat 直连」）。
 *
 * 一轮对话的形状：读会话历史 → 拼 `[system, ...history, user]` → 循环（≤ maxSteps）：
 * `completeChat`（工具面 = 该角色可见且未被 `AGENT_EXCLUDED_TOOLS` 挖掉的）→ 有 tool_calls 就
 * 逐个经 `runToolTracked` 执行（zod 校验 / 审计 / 写快照全在能力层，loop 不直调 handler）→
 * 工具结果或错误文本回填 messages → 再问；没有 tool_calls 即终答。
 * user / assistant（含 tool_calls）/ tool 往来**全部落 ChatStore**；system 提示每轮重拼、不落库
 * （面板那套随写模式变化）。
 *
 * **两个入口共用这一个 loop**，差异全部走 `AgentOptions`（接入层给什么就是什么，loop 不推断）：
 * - 面板（P1）：单会话，scope = `adminScope()`、角色 admin、actor `webui-agent`；
 * - QQ 直连（P3）：每个来源渠道一份会话，scope = `channelScope(channelId)`、角色 **gateway**、
 *   actor 形如 `qqbot-group-123`、调用域带 `channelId`（身份由 OneBot 事件解析后注入，
 *   **永不进工具参数**），系统提示换成 QQ 变体（system-prompt.ts）。
 *
 * 变更记录 entry 只有 'panel' | 'mcp' | 'agent' 三档（mcp/run-tool.ts）：面板与 QQ 都写 'agent'
 * ——两者都是「DD-claw 自己的进程内 loop」，来源靠 scope（渠道栈）与 actor 区分。
 *
 * 有意未做（计划明确不要的机制）：
 * - **不按 mode 硬拦写工具**：ask 模式的「先问再写」是系统提示层的纪律（system-prompt.ts），
 *   不是 loop 里的闸门。误写率靠提示词与工具 description 调优，兜底是「写可撤销」。
 * - **不自动裁剪上下文**：历史原样回放（面板由 UI 提示用量，QQ 侧由回执附 /reset 提示）。
 *
 * 依赖注入：`opts.completeChat` 是唯一的 LLM 接缝（测试用假 LLM 驱动多轮 tool_calls 剧本）；
 * 生产缺省走 `deps.llm.router.completeChat`——熔断 / 路由 / 降级语义与分类任务同源。
 *
 * **模型选择**（settings `chat_provider`）：每轮直读并塞进 `LlmRequest.provider`——非空即「点名」，
 * router 侧不降级（`SelectedProviderError` 中文报错，`analysis/providers.ts`）；空串 = 自动路由。
 * 每轮的 `ChatCompletion.provider`（实际回答者）随 assistant 消息落库、并在返回值里给出，
 * 面板据此显示「这句是谁答的」（自动路由下轮与轮之间可能不同）。
 */
import type { ChatCompletion, ChatMessage, LlmRequest, ToolCall } from '../analysis/providers.js';
import { getChatProvider, isLlmEnabled } from '../analysis/providers.js';
import type { ChatMessage as StoredMessage } from '../core/chat-store.js';
import { adminScope } from '../core/undo.js';
import type { McpAuth, McpRole } from '../mcp/auth.js';
import { runToolTracked, type ToolEntry } from '../mcp/run-tool.js';
import { toolDefsForRole, type McpToolDef } from '../mcp/tools.js';
import { HttpError } from '../panel/http-util.js';
import type { PanelDeps } from '../panel/server.js';
import { buildSystemPrompt, getChatWriteMode } from './system-prompt.js';
import { agentToolSpecs, isAgentExposed } from './tool-schema.js';

/** 单轮上限：防止模型无限「调工具 → 再调工具」空转（超了就兜底回复，不卡死） */
export const AGENT_MAX_STEPS = 8;

/** 审计/变更记录里的调用者名（面板入口的 actor） */
export const AGENT_ACTOR = 'webui-agent';

/**
 * 面板入口缺省身份（= 缺省 opts 下 loop 自构的 ctx：本机绑定即主人 = admin，无渠道 scope）。
 * QQ 入口**不用**它——那边由事件来源解析出 channelId 后自构 ctx（身份绝不进工具参数）。
 */
export const AGENT_TOOL_CTX: McpAuth = { name: AGENT_ACTOR, role: 'admin', scope: {} };

/** 模型没返回内容时的兜底（面板措辞；QQ 变体由 opts.fallbacks 覆盖） */
const EMPTY_REPLY = '（模型没有返回内容，请再问一次）';

export interface AgentOptions {
  /** LLM 对话函数（测试注入点）；缺省 = `deps.llm.router.completeChat` */
  completeChat?: (req: LlmRequest) => Promise<ChatCompletion>;
  /** 轮次上限；缺省 AGENT_MAX_STEPS */
  maxSteps?: number;
  /** 会话键与撤销栈 scope（缺省 `adminScope()` = 面板单会话；QQ = `channelScope(channelId)`） */
  scope?: string;
  /** 工具面角色（缺省 admin = 面板；QQ 入口 = gateway） */
  role?: McpRole;
  /** 调用者名：`ctx.name` + 审计/变更记录的 actor（缺省 AGENT_ACTOR） */
  actor?: string;
  /** 变更记录 entry（缺省 'agent'；只有 mcp/run-tool.ts 定义的三档可选） */
  entry?: ToolEntry;
  /** 渠道调用域：注入 `ctx.scope.channelId`（QQ 按消息来源解析后传入；面板不带） */
  channelId?: number;
  /** 系统提示全文（缺省 = 面板提示，每轮按 `chat_write_mode` 重拼） */
  systemPrompt?: string;
  /** 兜底文案：模型没返回内容 / 达到轮次上限（面板与 QQ 措辞不同） */
  fallbacks?: { empty?: string; truncated?: string };
}

export interface AgentTurnResult {
  reply: string;
  /** LLM 轮次（含被截断的那轮） */
  steps: number;
  /** 实际执行的工具调用次数 */
  toolCalls: number;
  /** 达到轮次上限：reply 是兜底文案，不是模型结论 */
  truncated: boolean;
  /** 本轮**实际回答**的 provider 名（面板显示「谁答的」；自动路由下每轮可能不同） */
  provider: string;
}

/**
 * agent 是否可用（`/api/chat` 的前置检查，映射 400）：可用返回 null，否则给中文原因，
 * 并指明去设置页做什么（契约：LLM 未启用 / 无可用 provider 都是 400 而不是 502）。
 *
 * 选了具体 provider（settings `chat_provider`）时按**它**判：选的人不存在 / 不可用都算 400，
 * 而不是先放过去再让 router 抛错——「去设置页换一个」是用户动作，不该长成 502 的失败回执。
 * router 侧的点名不降级（`SelectedProviderError`）仍是兜底：从这次检查到真正调用之间
 * provider 熔断/被删，错误一样是明确中文（只是状态码落 502）。
 */
export function chatBlockedReason(deps: PanelDeps): string | null {
  if (!deps.chat) return '对话存储未装配';
  const router = deps.llm?.router;
  if (!router) return 'LLM 未启用：请在设置页打开 LLM 总开关并添加 provider';
  if (!isLlmEnabled(deps.db)) return 'LLM 未启用：请在设置页打开 LLM 总开关';
  const providers = router.describe();
  if (providers.length === 0) return '还没有配置 LLM provider：请在设置页添加';
  const selected = getChatProvider(deps.db);
  if (selected !== '') {
    const p = providers.find((x) => x.name === selected);
    if (!p) return `选定的 LLM provider「${selected}」不在配置里：请在设置页重新选择或改回自动`;
    if (!p.ready) {
      return `选定的 LLM provider「${selected}」当前不可用（${p.status}）：请在设置页检查它，或改回自动`;
    }
    return null;
  }
  if (!providers.some((p) => p.ready)) {
    const why = providers.map((p) => `${p.name}（${p.status}）`).join('、');
    return `没有可用的 LLM provider：${why}——请在设置页检查 provider 开关与 API key`;
  }
  return null;
}

/**
 * 跑一轮对话：
 * 用户消息先落库，再按上面的循环推进，最后把终答落库并返回。
 * 入口差异（面板 / QQ）全部来自 `opts`；LLM 彻底失败（路由全挂 / 熔断）抛 502；
 * 未装配 / 未启用等前置问题抛 400。
 */
export async function runAgentTurn(
  deps: PanelDeps,
  userMessage: string,
  opts: AgentOptions = {},
): Promise<AgentTurnResult> {
  const store = deps.chat;
  if (!store) throw new HttpError(400, '对话存储未装配');
  const message = userMessage.trim();
  if (message === '') throw new HttpError(400, '消息不能为空');

  const scope = opts.scope ?? adminScope();
  const role = opts.role ?? 'admin';
  const actor = opts.actor ?? AGENT_ACTOR;
  const entry = opts.entry ?? 'agent';
  const maxSteps = opts.maxSteps ?? AGENT_MAX_STEPS;
  const completeChat = opts.completeChat ?? defaultCompleteChat(deps);
  // 模型选择（settings `chat_provider`，'' = 自动路由）：每轮直读，改了下一句即生效（不必重启/重建 router）
  const selectedProvider = getChatProvider(deps.db);
  // 身份与调用域只由接入层构造（能力层只读）：channelId 缺席 = admin 全量，在场 = 限定该渠道
  const toolCtx: McpAuth = {
    name: actor,
    role,
    scope: opts.channelId === undefined ? {} : { channelId: opts.channelId },
  };

  // 工具面 = 该角色可见 ∩ 未被排除名单挖掉（「哪些进 agent 工具面」只有 tool-schema.ts 一处信源）
  const exposed = toolDefsForRole(role).filter((d) => isAgentExposed(d.name));
  const specs = agentToolSpecs(exposed);
  const defByName = new Map(exposed.map((d) => [d.name, d]));

  // 历史（前几轮的 user / assistant / tool 往来）原样回放；system 每轮重拼（面板随 mode 变，QQ 固定变体）
  const history = toLlmMessages(store.messages(scope));
  const messages: ChatMessage[] = [
    { role: 'system', content: opts.systemPrompt ?? buildSystemPrompt(getChatWriteMode(deps.db)) },
    ...history,
    { role: 'user', content: message },
  ];
  store.append(scope, { role: 'user', content: message });

  let executed = 0;
  /** 本轮实际回答的 provider（最后一轮的落点：终答是它给的） */
  let answeredBy = '';
  for (let step = 1; step <= maxSteps; step++) {
    let out: ChatCompletion;
    try {
      out = await completeChat({
        messages: [...messages],
        tools: specs,
        ...(selectedProvider === '' ? {} : { provider: selectedProvider }),
      });
    } catch (e) {
      // 前置问题（未装配 / 未启用）原样上抛；其余一律「LLM 调用彻底失败」= 502
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, `LLM 调用失败：${e instanceof Error ? e.message : String(e)}`);
    }
    answeredBy = out.provider ?? '';

    if (out.toolCalls.length === 0) {
      const reply = out.content.trim() === '' ? (opts.fallbacks?.empty ?? EMPTY_REPLY) : out.content;
      store.append(scope, { role: 'assistant', content: reply, provider: out.provider });
      return { reply, steps: step, toolCalls: executed, truncated: false, provider: out.provider };
    }

    // 工具调用轮次整段落库：下一轮历史回放要靠 toolCalls 里的 call id 与 tool 结果配对
    store.append(scope, { role: 'assistant', content: out.content, toolCalls: out.toolCalls, provider: out.provider });
    messages.push({ role: 'assistant', content: out.content, toolCalls: out.toolCalls });
    for (const call of out.toolCalls) {
      const text = await runOneTool(deps, defByName, call, toolCtx, entry);
      executed++;
      store.append(scope, { role: 'tool', content: text, toolCallId: call.id });
      messages.push({ role: 'tool', content: text, toolCallId: call.id });
    }
  }

  const reply = opts.fallbacks?.truncated
    ?? `（连续 ${maxSteps} 轮工具调用仍没有得出结论，先停下了。可以把问题拆小一点再问，或直接在面板上操作。）`;
  store.append(scope, { role: 'assistant', content: reply, provider: answeredBy });
  return { reply, steps: maxSteps, toolCalls: executed, truncated: true, provider: answeredBy };
}

/** 缺省 LLM 接缝：走装配根的 router（与分类任务同一个熔断/降级语义） */
function defaultCompleteChat(deps: PanelDeps): (req: LlmRequest) => Promise<ChatCompletion> {
  return (req) => {
    const blocked = chatBlockedReason(deps);
    if (blocked !== null) throw new HttpError(400, blocked);
    return deps.llm!.router!.completeChat(req);
  };
}

/**
 * 执行一次模型请求的工具调用，返回**回填给模型的文本**（成功 = 结果 JSON；
 * 失败 = `错误：…` 中文文案，模型据此自我纠正）。
 * 参数只在这里做 JSON 解析——业务校验一律交给 `runTool` 的 zod 层（与 /mcp 同一份）。
 * ctx 由调用方（接入层）解析后顺着传下来：loop 从不从模型参数里读身份。
 */
async function runOneTool(
  deps: PanelDeps,
  defByName: Map<string, McpToolDef>,
  call: ToolCall,
  ctx: McpAuth,
  entry: ToolEntry,
): Promise<string> {
  const def = defByName.get(call.name);
  if (!def) return `错误：没有这个工具：${call.name}（只能调用工具列表里给出的工具）`;
  let args: unknown;
  try {
    const raw = call.arguments.trim();
    args = raw === '' ? {} : JSON.parse(raw);
  } catch {
    return `错误：${call.name} 的参数不是合法 JSON`;
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return `错误：${call.name} 的参数必须是 JSON 对象`;
  }
  // 审计与变更记录都能区分入口来源（entry）与调用者（ctx.name = actor）
  const r = await runToolTracked(deps, def, args as Record<string, unknown>, ctx, entry);
  return r.text;
}

/** 库里的消息 → LLM 消息（assistant 的 toolCalls 与 tool 结果的 call id 原样带上） */
function toLlmMessages(history: StoredMessage[]): ChatMessage[] {
  // **半截轮次要摘掉**：assistant 的 tool_calls 与配对的 tool 结果必须成对出现，若进程在两者
  // 之间挂掉（或 tool 行写失败），原样回放会让端点直接拒请求——那之后每一轮都失败，用户只能
  // 靠重置上下文自救。故双向配对：assistant 只保留有 tool 结果的调用，孤儿 tool 结果也丢掉。
  const called = new Set<string>();
  const answered = new Set<string>();
  for (const m of history) {
    if (m.role === 'assistant') for (const c of (m.toolCalls ?? []) as ToolCall[]) called.add(c.id);
    else if (m.role === 'tool' && m.toolCallId !== null) answered.add(m.toolCallId);
  }

  const out: ChatMessage[] = [];
  for (const m of history) {
    if (m.role === 'tool') {
      if (m.toolCallId !== null && called.has(m.toolCallId)) {
        out.push({ role: 'tool', content: m.content, toolCallId: m.toolCallId });
      }
      continue;
    }
    if (m.role === 'assistant') {
      const paired = ((m.toolCalls ?? []) as ToolCall[]).filter((c) => answered.has(c.id));
      if (paired.length === 0 && m.content.trim() === '') continue;
      out.push(paired.length > 0
        ? { role: 'assistant', content: m.content, toolCalls: paired }
        : { role: 'assistant', content: m.content });
      continue;
    }
    out.push({ role: m.role === 'system' ? 'system' : 'user', content: m.content });
  }
  return out;
}