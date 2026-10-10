import { makeLogger } from '../logger.js';
import type { AppConfig, LlmProviderConfig } from '../config/index.js';
import { splitCsvText } from '../core/csv.js';
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
 * - 可重试失败（网络/超时/429/5xx/脏响应）先就地重试，重试耗尽才计入熔断——
 *   瞬时抖动不该喂给熔断计数器，更不该让译文因单次抖动凭空消失
 * - 多 key 池：同 provider 下多个 key 轮询，延长额度寿命
 *
 * key 绝不进日志：只在 Authorization 头里出现，错误信息只带 provider name。
 */

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface LlmRequest {
  messages: ChatMessage[];
  /** 强制指定路由；缺省按 messages 里有没有 image_url 自动判断 */
  vision?: boolean;
  /** 请求级 JSON schema；provider 的 structuredOutput 模式决定怎么下发 */
  jsonSchema?: { name: string; schema: Record<string, unknown>; strict?: boolean };
  maxTokens?: number;
  temperature?: number;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** key 解析器：按 provider 定义给出 key 池 */
export type SpecKeysOf = (spec: LlmProviderConfig) => string[];

/** 生产解析：面板填写的 key（settings 表 `llm_key:<providerName>`，逗号分隔多 key，中英文逗号均可），唯一来源 */
export function dbKeysOf(db: Db): SpecKeysOf {
  return (spec) => splitCsvText(db.getSetting(`llm_key:${spec.name}`));
}

/**
 * 单次调用失败（HTTP 错误 / 响应缺内容 / JSON 解析失败），计入熔断。
 * retryable=true 表示瞬时故障（网络抖动 / 超时 / 429 / 5xx / 网关返回脏数据），
 * complete() 会先就地重试，重试耗尽才抛给上层计入熔断；
 * false = 确定性错误（401 key 失效 / 404 模型名错 / 400 请求不被接受），重试无意义。
 */
export class ProviderCallError extends Error {
  override name = 'ProviderCallError';
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
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

export interface ProviderOptions {
  timeoutMs: number;
  circuitThreshold: number;
  circuitCooldownMs: number;
  fetchFn?: FetchLike;
  /** 可重试失败的重试间隔（毫秒，按第 N 次重试取下标）；缺省 [1s, 3s]。测试可传 [0, 0] */
  retryBackoffMs?: number[];
  /** 可注入时钟，测试用 */
  now?: () => number;
}

/** 可重试失败的额外重试次数（共 1 + MAX_RETRIES 次尝试） */
const MAX_RETRIES = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

  /**
   * 按 spec.api 选调用的协议，返回解析后的 JSON。任何失败抛 ProviderCallError。
   * 可重试失败（retryable）就地重试 MAX_RETRIES 次（间隔 retryBackoffMs，每次重试
   * 自然轮换池内下一个 key），重试耗尽才抛出——上层 recordFailure 计的是「真失败」。
   */
  async complete(req: LlmRequest): Promise<unknown> {
    const backoff = this.opts.retryBackoffMs ?? [1_000, 3_000];
    for (let attempt = 0; ; attempt++) {
      try {
        const content = this.spec.api === 'responses'
          ? await this.callResponses(req)
          : await this.callChatCompletions(req);
        try {
          // structuredOutput=none 的端点可能把 JSON 包在 ```json 围栏里，剥掉兜底
          return JSON.parse(stripCodeFence(content));
        } catch {
          // 模型输出抽风是采样级抖动，重试一次常能救 → retryable
          throw new ProviderCallError(`正文不是合法 JSON: ${content.slice(0, 120)}`, true);
        }
      } catch (e) {
        const retryable = e instanceof ProviderCallError && e.retryable;
        if (!retryable || attempt >= MAX_RETRIES) throw e;
        log.debug(`provider ${this.name} 第 ${attempt + 1} 次重试: ${e.message}`);
        await sleep(backoff[attempt] ?? backoff[backoff.length - 1] ?? 3_000);
      }
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
      // 网络异常 / 超时：瞬时故障
      throw new ProviderCallError(`请求异常: ${(e as Error).message}`, true);
    }
    if (!res.ok) {
      // 响应体可能含限流/额度信息，截断带上；key 不在响应里。
      // 408/409/425/429/5xx 是瞬时故障可重试；4xx 其余（401 key 失效 / 404 模型名错 /
      // 400 请求不被接受 / 402 欠费）是确定性错误，重试无意义
      const retryable = res.status === 408 || res.status === 409 || res.status === 425 ||
        res.status === 429 || res.status >= 500;
      const text = (await res.text().catch(() => '')).slice(0, 200);
      throw new ProviderCallError(`HTTP ${res.status}${text ? `: ${text}` : ''}`, retryable);
    }
    try {
      return await res.json();
    } catch {
      // 200 但信封脏：网关/中间层抽风，重试常有救
      throw new ProviderCallError('响应不是合法 JSON 信封', true);
    }
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
    const textOf = (m: ChatMessage): string =>
      typeof m.content === 'string'
        ? m.content
        : m.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n');
    const instructions = req.messages
      .filter((m) => m.role === 'system')
      .map(textOf)
      .filter(Boolean)
      .join('\n');
    const input = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role,
        content: typeof m.content === 'string'
          ? [{ type: 'input_text', text: m.content }]
          : m.content.map((c) => c.type === 'text'
              ? { type: 'input_text', text: c.text }
              : { type: 'input_image', image_url: c.image_url.url }),
      }));

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
}

function stripCodeFence(s: string): string {
  const m = s.trim().match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return m ? m[1]!.trim() : s.trim();
}

export interface ProviderStatus {
  name: string;
  model: string;
  vision: boolean;
  routes: string[];
  status: string;
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
    }));
  }

  /**
   * vision 路由是否有立即可用的 provider：含图请求先发问，没有就降级纯文本——
   * 硬着头皮带图会让整个请求在空路由上失败，把本可走 text 路由的判定/翻译一起拖死。
   */
  hasVision(): boolean {
    return this.routes.vision.some((name) => this.byName.get(name)?.isReady() ?? false);
  }

  /**
   * 走路由调一个可用 provider，返回 parse 后的结果。
   * parse（任务层的 zod 校验）失败同样计入熔断并降级到下一个 ——
   * 模型没按 schema 输出和端点挂掉一样，都是这个 provider 本次不可靠。
   * 注意 parse 失败不做就地重试（schema 不符偏确定性，重试同一模型意义不大，
   * 且 retryable 标记是传输层的概念，够不着任务层）；provider 内部的
   * 可重试失败（网络/超时/429/5xx/正文非 JSON）已在 complete() 里重试过。
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
