import { makeLogger } from '../logger.js';
import type { AppConfig, LlmProviderConfig } from '../config/index.js';
import type { Db } from '../core/db.js';

const log = makeLogger('llm');

/**
 * LLM provider 层：OpenAI 兼容端点聚合（chat/completions 与 responses 双协议，
 * 按 provider 的 api 字段选择；Anthropic /messages 协议不做）。
 *
 * 设计要点（docs/research/llm.md 2026-08 修订）：
 * - 不引外部网关（LiteLLM 等）：provider 配置数组本身就是聚合层，
 *   熔断 / key 池 / 降级全在这一个文件里，本项目已是常驻进程
 * - 任务按「输入是否含图」选路由：含图一律走 vision 路由（多模态模型），
 *   纯文本走 text 路由（便宜文本模型打头）
 * - 熔断：连续失败到阈值打开，冷却期内直接跳过，不去撞已知挂掉的端点
 * - 多 key 池：同 provider 下多个 key 轮询，延长额度寿命
 *
 * key 绝不进日志：只在 Authorization 头里出现，错误信息只带 provider name。
 */

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** 工具调用：assistant 发起、tool 结果按同一个 id 回填 */
export interface ToolCall {
  id: string;
  name: string;
  /** **原始 JSON 字符串**（与各协议一致）；解析与校验统一交给 `runTool()`，provider 层不解释业务 */
  arguments: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  /** role='assistant'：本轮发起的工具调用 */
  toolCalls?: ToolCall[];
  /** role='tool'：这是哪次调用的结果 */
  toolCallId?: string;
}

/** 暴露给 LLM 的工具定义（参数是 JSON Schema，由 zod shape 转换而来） */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** `completeChat` 的结果：正文 + 本轮的工具调用（可能同时有） */
export interface ChatCompletion {
  content: string;
  toolCalls: ToolCall[];
  /**
   * **实际回答的 provider 名**（router 路由后的落点）。agent 会话要把它落进库/回给面板——
   * 自动路由下一轮可能换人，只有 provider 层知道自己是谁。
   */
  provider: string;
}

export interface LlmRequest {
  messages: ChatMessage[];
  /** 强制指定路由；缺省按 messages 里有没有 image_url 自动判断 */
  vision?: boolean;
  /**
   * **强制指定哪个 provider 回答**（agent 会话模型选择，settings `chat_provider`）。
   * 与 `vision` 不同：这是硬约束，指定的 provider 不存在 / 未启用 / 熔断 / 调用失败都
   * **抛错且绝不回落别人**（`SelectedProviderError`）——主人选了模型，就不该被静默换掉。
   * 缺省（undefined 或空串）= 按路由优先级自动选，失败逐级降级。
   * **只被 `completeChat` 使用**（与 `tools` 同款口径）：分类任务走 `completeJson`，不看这个字段。
   */
  provider?: string;
  /** 请求级 JSON schema；provider 的 structuredOutput 模式决定怎么下发 */
  jsonSchema?: { name: string; schema: Record<string, unknown>; strict?: boolean };
  maxTokens?: number;
  temperature?: number;
  /** 工具面（只被 `completeChat` 使用；`complete` / `completeJson` 忽略） */
  tools?: ToolSpec[];
  /** 强制走「JSON 模拟」而非原生 tool_calls（端点已知不支持 tools 时用） */
  simulateTools?: boolean;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** key 解析器：按 provider 定义给出 key 池 */
export type SpecKeysOf = (spec: LlmProviderConfig) => string[];

/** 生产解析：面板填写的 key（settings 表 `llm_key:<providerName>`，逗号分隔多 key），唯一来源 */
export function dbKeysOf(db: Db): SpecKeysOf {
  return (spec) => {
    const panel = db.getSetting(`llm_key:${spec.name}`);
    return panel && panel.trim()
      ? panel.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
  };
}

/** 单次调用失败（HTTP 错误 / 响应缺内容 / JSON 解析失败），计入熔断 */
export class ProviderCallError extends Error {
  override name = 'ProviderCallError';
}

/**
 * 端点不支持原生 tool_calls（HTTP 4xx 且报文提到 tool/function 不认识）。
 * **不算 provider 故障**（端点本身是好的），由 router 就地降级为 JSON 模拟。
 */
export class ToolUnsupportedError extends ProviderCallError {
  override name = 'ToolUnsupportedError';
}

/** 路由内所有 provider 都不可用或全部失败 */
export class AllProvidersExhaustedError extends Error {
  override name = 'AllProvidersExhaustedError';
  constructor(
    readonly route: 'text' | 'vision',
    readonly attempts: string[],
  ) {
    super(`LLM ${route} 路由全部不可用: ${attempts.join(' → ') || '(路由为空或无可用 provider)'}`);
  }
}

/**
 * `LlmRequest.provider` 指定的 provider 这条硬路由走不通（不存在 / 未启用 / 缺 key / 熔断 / 调用失败）。
 * 与 `AllProvidersExhaustedError` 的区别：**不降级**——主人点名要的模型不该被静默换掉，
 * 出错比换人回答诚实。文案是中文（直接进 agent 回话与面板错误提示）。
 */
export class SelectedProviderError extends Error {
  override name = 'SelectedProviderError';
  constructor(
    readonly provider: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ProviderOptions {
  timeoutMs: number;
  circuitThreshold: number;
  circuitCooldownMs: number;
  fetchFn?: FetchLike;
  /** 可注入时钟，测试用 */
  now?: () => number;
}

export class OpenAiProvider {
  private keyIdx = 0;
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private keys: string[];
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;

  constructor(
    readonly spec: LlmProviderConfig,
    /** 已解析出的 key（可能为空 = 无鉴权端点） */
    keys: string[],
    private readonly opts: ProviderOptions,
  ) {
    this.keys = keys;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** 面板填写/清除 key 后热更新，不用重启；轮询位置归零 */
  setKeys(keys: string[]): void {
    this.keys = keys;
    this.keyIdx = 0;
  }

  get name(): string {
    return this.spec.name;
  }

  /** 是否需要鉴权：loopback（本地 LM Studio 等无鉴权端点）以外都算需要 */
  private get needsAuth(): boolean {
    try {
      const h = new URL(this.spec.baseURL).hostname;
      return h !== '127.0.0.1' && h !== 'localhost' && h !== '::1' && h !== '[::1]';
    } catch {
      return true;
    }
  }

  /** 需要鉴权但一个 key 都没有（面板没填、env 也没有） */
  get keyMissing(): boolean {
    return this.needsAuth && this.keys.length === 0;
  }

  isReady(): boolean {
    if (!this.spec.enabled || this.keyMissing) return false;
    return this.now() >= this.circuitOpenUntil;
  }

  /** probe / 日志用状态描述（不含 key） */
  status(): string {
    if (!this.spec.enabled) return 'disabled';
    if (this.keyMissing) return '缺 key（未填写）';
    if (this.now() < this.circuitOpenUntil) return '熔断中';
    return 'ready';
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  recordFailure(err: unknown): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.opts.circuitThreshold) {
      this.circuitOpenUntil = this.now() + this.opts.circuitCooldownMs;
      log.warn(
        `provider ${this.name} 连续失败 ${this.consecutiveFailures} 次，熔断 ` +
        `${Math.round(this.opts.circuitCooldownMs / 1000)}s`,
      );
    }
    log.warn(`provider ${this.name} 调用失败: ${(err as Error).message}`);
  }

  private nextKey(): string | undefined {
    if (this.keys.length === 0) return undefined;
    const key = this.keys[this.keyIdx % this.keys.length];
    this.keyIdx++;
    return key;
  }

  /** 按 spec.api 选调用的协议，返回解析后的 JSON。任何失败抛 ProviderCallError */
  async complete(req: LlmRequest): Promise<unknown> {
    const content = this.spec.api === 'responses'
      ? await this.callResponses(req)
      : await this.callChatCompletions(req);
    try {
      // structuredOutput=none 的端点可能把 JSON 包在 ```json 围栏里，剥掉兜底
      return JSON.parse(stripCodeFence(content));
    } catch {
      throw new ProviderCallError(`正文不是合法 JSON: ${content.slice(0, 120)}`);
    }
  }

  /** 共享：POST + 鉴权 + 错误归一化，返回响应 JSON。key 只在 Authorization 头 */
  private async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    const key = this.nextKey();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;

    let res: Response;
    const url = `${this.spec.baseURL.replace(/\/+$/, '')}${path}`;
    try {
      res = await this.fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (e) {
      throw new ProviderCallError(`请求异常: ${(e as Error).message}`);
    }
    if (!res.ok) {
      // 响应体可能含限流/额度信息，截断带上；key 不在响应里
      const text = (await res.text().catch(() => '')).slice(0, 200);
      throw new ProviderCallError(`HTTP ${res.status}${text ? `: ${text}` : ''}`);
    }
    try {
      return await res.json();
    } catch {
      throw new ProviderCallError('响应不是合法 JSON 信封');
    }
  }

  /**
   * 带工具的一轮对话（agent loop 用）：返回正文 + 本轮 tool_calls。
   * 双协议都实现原生通道：chat/completions 走 `tools` + `tool_calls` 回填；
   * responses 走 `tools` + `function_call` / `function_call_output`（回填必须带 `call_id`）。
   * 注意：这条路径**不设 response_format**（与 tools 同时下发会互相打架）；模拟降级见 `simulateToolCall`。
   */
  async completeChat(req: LlmRequest): Promise<ChatCompletion> {
    return this.spec.api === 'responses'
      ? await this.callResponsesChat(req)
      : await this.callChatCompletionsChat(req);
  }

  private async callChatCompletionsChat(req: LlmRequest): Promise<ChatCompletion> {
    const body: Record<string, unknown> = {
      model: this.spec.model,
      messages: req.messages.map(chatCompletionsMessage),
    };
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    const hasTools = req.tools !== undefined && req.tools.length > 0;
    if (hasTools) {
      body.tools = req.tools!.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    let data: { choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }> };
    try {
      data = (await this.post('/chat/completions', body)) as typeof data;
    } catch (e) {
      throw classifyToolError(e, hasTools);
    }
    const msg = data.choices?.[0]?.message;
    if (msg === undefined) throw new ProviderCallError('响应缺少 choices[0].message');
    return {
      content: typeof msg.content === 'string' ? msg.content : '',
      toolCalls: parseChatToolCalls(msg.tool_calls),
      provider: this.name,
    };
  }

  private async callChatCompletions(req: LlmRequest): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.spec.model,
      messages: req.messages,
    };
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (this.spec.structuredOutput === 'schema' && req.jsonSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: req.jsonSchema.name,
          schema: req.jsonSchema.schema,
          strict: req.jsonSchema.strict ?? true,
        },
      };
    } else if (this.spec.structuredOutput !== 'none') {
      body.response_format = { type: 'json_object' };
    }

    const data = (await this.post('/chat/completions', body)) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new ProviderCallError('响应缺少 choices[0].message.content');
    }
    return content;
  }

  /**
   * OpenAI Responses API（/responses，如 OpenCode Go 的 gpt-5.6-luna）：
   * system 消息合并进 instructions；内容部件换算成 input_text / input_image；
   * 结构化输出走 text.format；正文取 output_text 便捷字段，缺了再从 output 里找
   */
  private async callResponses(req: LlmRequest): Promise<string> {
    const instructions = req.messages
      .filter((m) => m.role === 'system')
      .map(messageText)
      .filter(Boolean)
      .join('\n');
    const input = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: responsesContent(m) }));

    const body: Record<string, unknown> = { model: this.spec.model, input };
    if (instructions) body.instructions = instructions;
    if (req.maxTokens !== undefined) body.max_output_tokens = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (this.spec.structuredOutput === 'schema' && req.jsonSchema) {
      body.text = {
        format: {
          type: 'json_schema',
          name: req.jsonSchema.name,
          schema: req.jsonSchema.schema,
          strict: req.jsonSchema.strict ?? true,
        },
      };
    } else if (this.spec.structuredOutput !== 'none') {
      body.text = { format: { type: 'json_object' } };
    }

    const data = (await this.post('/responses', body)) as {
      output_text?: unknown;
      output?: Array<{ type?: string; content?: Array<{ type?: string; text?: unknown }> }>;
    };
    let content: unknown =
      typeof data.output_text === 'string' && data.output_text.trim() ? data.output_text : undefined;
    if (content === undefined) {
      for (const item of data.output ?? []) {
        if (item.type !== 'message') continue;
        for (const part of item.content ?? []) {
          if (part.type === 'output_text' && typeof part.text === 'string' && part.text.trim()) {
            content = part.text;
            break;
          }
        }
        if (content !== undefined) break;
      }
    }
    if (typeof content !== 'string' || !content.trim()) {
      throw new ProviderCallError('响应缺少 output_text');
    }
    return content;
  }

  /**
   * Responses 协议的工具轮次。与 chat/completions 的**形状差异**（计划里点名的坑）：
   * 工具定义是 `{type:'function', name, parameters}`（不是嵌在 `function` 里）；
   * assistant 的工具调用在 `output` 里是**顶层** `function_call` 项（带 `call_id`）；
   * 结果回填是顶层 `function_call_output`（`call_id` + `output`），不是 role='tool' 的消息。
   */
  private async callResponsesChat(req: LlmRequest): Promise<ChatCompletion> {
    const instructions = req.messages
      .filter((m) => m.role === 'system')
      .map(messageText)
      .filter(Boolean)
      .join('\n');

    const input: Array<Record<string, unknown>> = [];
    for (const m of req.messages) {
      if (m.role === 'system') continue;
      if (m.role === 'tool') {
        input.push({ type: 'function_call_output', call_id: m.toolCallId ?? '', output: messageText(m) });
        continue;
      }
      if (m.role === 'assistant' && m.toolCalls !== undefined && m.toolCalls.length > 0) {
        for (const c of m.toolCalls) {
          input.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.arguments });
        }
        continue;
      }
      input.push({ role: m.role, content: responsesContent(m) });
    }

    const body: Record<string, unknown> = { model: this.spec.model, input };
    if (instructions) body.instructions = instructions;
    if (req.maxTokens !== undefined) body.max_output_tokens = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    const hasTools = req.tools !== undefined && req.tools.length > 0;
    if (hasTools) {
      body.tools = req.tools!.map((t) => ({
        type: 'function', name: t.name, description: t.description, parameters: t.parameters,
      }));
    }

    let data: { output?: Array<Record<string, unknown>> };
    try {
      data = (await this.post('/responses', body)) as typeof data;
    } catch (e) {
      throw classifyToolError(e, hasTools);
    }

    let content = '';
    const toolCalls: ToolCall[] = [];
    for (const item of data.output ?? []) {
      if (item.type === 'function_call') {
        const name = item.name;
        if (typeof name === 'string' && name) {
          toolCalls.push({
            id: typeof item.call_id === 'string' && item.call_id ? item.call_id : `call_${toolCalls.length}`,
            name,
            arguments: typeof item.arguments === 'string' ? item.arguments : '{}',
          });
        }
        continue;
      }
      if (item.type === 'message' && !content) {
        for (const part of (item.content as Array<{ type?: string; text?: unknown }> | undefined) ?? []) {
          if (part.type === 'output_text' && typeof part.text === 'string') {
            content = part.text;
            break;
          }
        }
      }
    }
    if (!content && toolCalls.length === 0) {
      throw new ProviderCallError('响应既没有 output_text 也没有 function_call');
    }
    return { content, toolCalls, provider: this.name };
  }
}

function stripCodeFence(s: string): string {
  const m = s.trim().match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return m ? m[1]!.trim() : s.trim();
}

/** 消息正文的纯文本（多模态时只取 text 部件，与旧 callResponses 的行为一致） */
function messageText(m: ChatMessage): string {
  return typeof m.content === 'string'
    ? m.content
    : m.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n');
}

/** 消息 → responses 协议的 content 部件 */
function responsesContent(m: ChatMessage): Array<Record<string, unknown>> {
  return typeof m.content === 'string'
    ? [{ type: 'input_text', text: m.content }]
    : m.content.map((c) => (c.type === 'text'
        ? { type: 'input_text', text: c.text }
        : { type: 'input_image', image_url: c.image_url.url }));
}

/** 消息 → chat/completions 协议的 message（含 tool_calls 与 tool 回填） */
function chatCompletionsMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: messageText(m) };
  }
  if (m.role === 'assistant' && m.toolCalls !== undefined && m.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: typeof m.content === 'string' ? m.content : messageText(m),
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

function parseChatToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolCall[] = [];
  for (const item of raw) {
    const it = item as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    const name = it.function?.name;
    if (typeof name !== 'string' || !name) continue;
    out.push({
      id: typeof it.id === 'string' && it.id ? it.id : `call_${out.length}`,
      name,
      arguments: typeof it.function?.arguments === 'string' ? it.function.arguments : '{}',
    });
  }
  return out;
}

/** HTTP 4xx 且报文明确说 tools/function 不认识 → 归为「端点不支持原生 tools」 */
function classifyToolError(e: unknown, hadTools: boolean): unknown {
  if (!hadTools || !(e instanceof ProviderCallError)) return e;
  if (!/HTTP (400|404|415|422)/.test(e.message)) return e;
  if (!/(unsupported|not supported|unrecognized|unknown)/i.test(e.message)) return e;
  if (!/(tool|function)/i.test(e.message)) return e;
  return new ToolUnsupportedError(e.message);
}

export interface ProviderStatus {
  name: string;
  model: string;
  vision: boolean;
  routes: string[];
  status: string;
  /**
   * 此刻能不能真的用（启用 + 有 key + 未熔断，= `isReady()`）：面板只展示，agent loop 用它
   * 区分「LLM 未就绪（400，去设置页修）」与「调用失败（502）」，不用去 parse status 文案。
   */
  ready: boolean;
}

export class LlmRouter {
  private readonly byName = new Map<string, OpenAiProvider>();

  constructor(
    providers: OpenAiProvider[],
    private readonly routes: { text: string[]; vision: string[] },
    /** 由 createLlmRouter 注入：面板改 key 后 refreshKeys() 热更新用 */
    private readonly resolveKeys?: (spec: LlmProviderConfig) => string[],
  ) {
    for (const p of providers) this.byName.set(p.name, p);
  }

  /** 重新解析所有 provider 的 key（面板保存/清除后调用，免重启生效） */
  refreshKeys(): void {
    if (!this.resolveKeys) return;
    for (const p of this.byName.values()) p.setKeys(this.resolveKeys(p.spec));
  }

  /** 面板「测试」按钮用：单 provider 状态；null = 不存在 */
  providerStatus(name: string): string | null {
    return this.byName.get(name)?.status() ?? null;
  }

  /**
   * 面板「测试」按钮：绕过熔断对该 provider 发一个最小 ping，返回毫秒耗时。
   * 失败照常计入熔断统计（ping 不通 = 端点确实有问题）。key 绝不进错误信息。
   */
  async ping(name: string): Promise<number> {
    const p = this.byName.get(name);
    if (!p) throw new ProviderCallError(`provider 不存在: ${name}`);
    if (p.keyMissing) throw new ProviderCallError('缺 key，请先填写');
    const t0 = Date.now();
    try {
      await p.complete({
        messages: [{ role: 'user', content: '只回复这个 JSON：{"pong": true}' }],
        maxTokens: 64,
      });
      p.recordSuccess();
      return Date.now() - t0;
    } catch (e) {
      p.recordFailure(e);
      throw e;
    }
  }

  /** probe / 面板用：所有 provider 的可用状态（不含 key） */
  describe(): ProviderStatus[] {
    return [...this.byName.values()].map((p) => ({
      name: p.name,
      model: p.spec.model,
      vision: p.spec.vision,
      routes: (['text', 'vision'] as const).filter((r) => this.routes[r].includes(p.name)),
      status: p.status(),
      ready: p.isReady(),
    }));
  }

  /**
   * 走路由调一个可用 provider，返回 parse 后的结果。
   * parse（任务层的 zod 校验）失败同样计入熔断并降级到下一个 ——
   * 模型没按 schema 输出和端点挂掉一样，都是这个 provider 本次不可靠。
   */
  async completeJson<T>(req: LlmRequest, parse?: (raw: unknown) => T): Promise<T> {
    const routeKind: 'text' | 'vision' = req.vision ?? hasImage(req.messages) ? 'vision' : 'text';
    const route = this.routes[routeKind];
    const attempts: string[] = [];

    for (const name of route) {
      const p = this.byName.get(name);
      if (!p) continue;
      if (!p.isReady()) {
        attempts.push(`${name}[跳过:${p.status()}]`);
        continue;
      }
      try {
        const raw = await p.complete(req);
        const result = parse ? parse(raw) : (raw as T);
        p.recordSuccess();
        return result;
      } catch (e) {
        p.recordFailure(e);
        attempts.push(`${name}[失败]`);
      }
    }
    throw new AllProvidersExhaustedError(routeKind, attempts);
  }

  /**
   * 带工具的一轮对话。熔断 / 路由 / 降级语义与 `completeJson` 同源：
   * 逐个 provider 试，失败的记熔断、换下一个。
   *
   * **点名 provider（`req.provider`）时不降级**：主人选了模型就不该被静默换掉——
   * 不存在 / 未启用 / 缺 key / 熔断 / 调用失败一律抛 `SelectedProviderError`（中文文案），
   * 绝不落到别人身上（见 `LlmRequest.provider`）。
   *
   * **JSON 模拟降级**：端点不支持原生 tools 时（`ToolUnsupportedError`，或调用方直接指定
   * `simulateTools`），就用提示词让模型输出 `{"tool":…,"arguments":…}` 再由我们拼成一次工具调用——
   * 这**不算 provider 故障**，不记熔断。模拟产出的 arguments 与原生 tool_calls 一样是原始 JSON 字符串，
   * 因此**同样必须过 `runTool()` 的 zod 校验**，写工具不得因此绕过 schema。
   */
  async completeChat(req: LlmRequest): Promise<ChatCompletion> {
    if (req.provider !== undefined && req.provider !== '') return this.completeChatWith(req.provider, req);
    const routeKind: 'text' | 'vision' = req.vision ?? hasImage(req.messages) ? 'vision' : 'text';
    const route = this.routes[routeKind];
    const attempts: string[] = [];

    for (const name of route) {
      const p = this.byName.get(name);
      if (!p) continue;
      if (!p.isReady()) {
        attempts.push(`${name}[跳过:${p.status()}]`);
        continue;
      }
      const out = await this.tryChat(p, req, attempts, name);
      if (out !== null) return out;
    }
    throw new AllProvidersExhaustedError(routeKind, attempts);
  }

  /**
   * 点名路由：只有这一个 provider 会被调用，任何一步不顺都抛错（不换人）。
   * 「未就绪」在调用前就判定（省一次注定失败的请求），调用失败照常计熔断。
   */
  private async completeChatWith(name: string, req: LlmRequest): Promise<ChatCompletion> {
    const p = this.byName.get(name);
    if (!p) throw new SelectedProviderError(name, `没有这个 LLM provider：${name}（请在设置页重新选择）`);
    if (!p.isReady()) {
      throw new SelectedProviderError(name, `指定的 LLM provider「${name}」当前不可用（${p.status()}）`);
    }
    const attempts: string[] = [];
    const out = await this.tryChat(p, req, attempts, name, true);
    // strict 下失败一律抛错，这行只是类型兜底（防御）
    if (out === null) throw new SelectedProviderError(name, `指定的 LLM provider「${name}」调用失败`);
    return out;
  }

  /**
   * 单 provider 的一次工具轮次（原生 → 端点不支持就地降级为 JSON 模拟）。
   * 成功返回结果；降级链走不通返回 null（由调用方决定「换下一个」还是抛错）。
   * `strict` = 点名路由：失败直接把原始错误包成 `SelectedProviderError` 抛出，不回落别人。
   */
  private async tryChat(
    p: OpenAiProvider,
    req: LlmRequest,
    attempts: string[],
    name: string,
    strict = false,
  ): Promise<ChatCompletion | null> {
    const fail = (e: unknown, tag: string): null => {
      p.recordFailure(e);
      attempts.push(`${name}[${tag}]`);
      if (strict) {
        throw new SelectedProviderError(name, `LLM provider「${name}」调用失败：${(e as Error).message}`);
      }
      return null;
    };
    if (req.simulateTools) {
      try {
        const out = await simulateToolCall(p, req);
        p.recordSuccess();
        return out;
      } catch (e) {
        return fail(e, '模拟失败');
      }
    }
    try {
      const out = await p.completeChat(req);
      p.recordSuccess();
      return out;
    } catch (e) {
      if (e instanceof ToolUnsupportedError) {
        attempts.push(`${name}[无原生 tools→JSON 模拟]`);
        try {
          const out = await simulateToolCall(p, req);
          p.recordSuccess();
          return out;
        } catch (e2) {
          return fail(e2, '模拟失败');
        }
      }
      return fail(e, '失败');
    }
  }
}

/** 模拟降级产出的工具调用 id（同一轮内自洽即可；回填走文本而非 call_id 通道） */
export const SIMULATED_TOOL_CALL_ID = 'sim_0';

/** 把工具定义与对话渲染成「只输出一个 JSON」的提示词（模拟降级用） */
function buildSimulationPrompt(req: LlmRequest): ChatMessage[] {
  const tools = req.tools ?? [];
  const catalog = tools
    .map((t) => `- ${t.name}：${t.description}\n  参数 JSON Schema：${JSON.stringify(t.parameters)}`)
    .join('\n');
  const instructions = [
    '你是一个工具执行器。可用工具：',
    catalog || '（当前没有可用工具）',
    '',
    '只输出一个 JSON 对象，不要任何多余文字或代码围栏：',
    '  需要调用工具时：{"tool":"<工具名>","arguments":{<按该工具的参数 Schema>}}',
    '  不需要调用工具时：{"reply":"<给用户看的中文回复>"}',
    '工具结果会在下一条 user 消息里以「工具结果：…」给出。一次只调用一个工具。',
  ].join('\n');

  const rest: ChatMessage[] = [];
  for (const m of req.messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      rest.push({ role: 'user', content: `工具结果：${messageText(m)}` });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls !== undefined && m.toolCalls.length > 0) {
      rest.push({
        role: 'assistant',
        content: m.toolCalls.map((c) => `已调用 ${c.name}(${c.arguments})`).join('\n'),
      });
      continue;
    }
    rest.push(m);
  }
  return [{ role: 'system', content: instructions }, ...rest];
}

/** 用一次普通 JSON 调用模拟工具选择，并把结果拼成 ChatCompletion */
async function simulateToolCall(p: OpenAiProvider, req: LlmRequest): Promise<ChatCompletion> {
  const raw = await p.complete({
    messages: buildSimulationPrompt(req),
    vision: req.vision,
    maxTokens: req.maxTokens,
    temperature: req.temperature,
  });
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as { tool?: unknown; arguments?: unknown; reply?: unknown };
  if (typeof obj.tool === 'string' && obj.tool) {
    return {
      content: typeof obj.reply === 'string' ? obj.reply : '',
      toolCalls: [{
        id: SIMULATED_TOOL_CALL_ID,
        name: obj.tool,
        arguments: JSON.stringify(obj.arguments ?? {}),
      }],
      provider: p.name,
    };
  }
  const reply = typeof obj.reply === 'string'
    ? obj.reply
    : (typeof raw === 'string' ? raw : JSON.stringify(raw));
  return { content: reply, toolCalls: [], provider: p.name };
}

function hasImage(messages: ChatMessage[]): boolean {
  return messages.some(
    (m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url'),
  );
}

/**
 * 从配置装配 router。keysOf 缺省 = 无 key（本地无鉴权端点用）；
 * 生产用 dbKeysOf(db)（面板填写的 key，唯一来源）。路由由 provider 列表自动推导
 *（deriveRoutes），顺序即优先级。
 */
export function createLlmRouter(
  cfg: AppConfig['llm'] & { providers: LlmProviderConfig[] },
  keysOf: SpecKeysOf = () => [],
  opts?: Partial<ProviderOptions>,
): LlmRouter {
  const providers = cfg.providers.map((spec) =>
    new OpenAiProvider(spec, keysOf(spec), {
      timeoutMs: cfg.requestTimeoutMs,
      circuitThreshold: cfg.circuitThreshold,
      circuitCooldownMs: cfg.circuitCooldownMs,
      ...opts,
    }),
  );
  return new LlmRouter(providers, deriveRoutes(cfg.providers), keysOf);
}

// ---- provider 名单：settings 表是唯一信源（面板 LLM 卡片管理）----

const LLM_PROVIDERS_SETTING = 'llm_providers';

export function listLlmProviders(db: Db): LlmProviderConfig[] {
  const raw = db.getSetting(LLM_PROVIDERS_SETTING);
  if (raw === null) return [];
  return JSON.parse(raw) as LlmProviderConfig[];
}

export function saveLlmProviders(db: Db, providers: LlmProviderConfig[]): void {
  db.setSetting(LLM_PROVIDERS_SETTING, JSON.stringify(providers));
}

// ---- LLM 总开关：settings 表（'1'/'0'），缺省 = 关 ----

const LLM_ENABLED_SETTING = 'llm_enabled';

export function isLlmEnabled(db: Db): boolean {
  return db.getSetting(LLM_ENABLED_SETTING) === '1';
}

export function setLlmEnabled(db: Db, on: boolean): void {
  db.setSetting(LLM_ENABLED_SETTING, on ? '1' : '0');
}

// ---- agent 会话的模型选择：settings 表（'' = 自动路由，缺省）----

const CHAT_PROVIDER_SETTING = 'chat_provider';

/**
 * agent 对话选定的 provider 名；`''` = 自动路由（按 provider 列表顺序 + 降级）。
 * 只认**已配置过**的名字（选定后 provider 被删/改名 → 退回自动？不——见 `chatProviderMissing`）：
 * 读取一律原样返回，配置是否还有效由调用方按 provider 名单判定（`chatBlockedReason`）。
 */
export function getChatProvider(db: Db): string {
  return (db.getSetting(CHAT_PROVIDER_SETTING) ?? '').trim();
}

/** 写入选定（`''` = 回到自动路由，key 直接删掉，与 listen 开关「回 auto」同语义） */
export function setChatProvider(db: Db, provider: string): string {
  const name = provider.trim();
  if (name === '') db.deleteSetting(CHAT_PROVIDER_SETTING);
  else db.setSetting(CHAT_PROVIDER_SETTING, name);
  return getChatProvider(db);
}

/** 该名字在 provider 名单里有没有（面板下拉与 `PUT /api/chat/provider` 的 400 判据） */
export function hasLlmProvider(list: readonly LlmProviderConfig[], name: string): boolean {
  return list.some((p) => p.name === name);
}

/**
 * 路由自动推导：列表顺序 = 优先级（排前面的先调，失败/熔断降级到后面）；
 * text 路由 = 全部启用的 provider（多模态模型也能做纯文本），
 * vision 路由 = 启用且 vision=true 的 provider。
 */
export function deriveRoutes(providers: LlmProviderConfig[]): { text: string[]; vision: string[] } {
  const on = providers.filter((p) => p.enabled);
  return {
    text: on.map((p) => p.name),
    vision: on.filter((p) => p.vision).map((p) => p.name),
  };
}
