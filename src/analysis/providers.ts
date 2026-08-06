import { makeLogger } from '../logger.js';
import type { AppConfig, LlmProviderConfig } from '../config/index.js';
import type { Db } from '../core/db.js';

const log = makeLogger('llm');

/**
 * LLM provider 层：OpenAI 兼容端点聚合。
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

/** key 解析器：按 provider 定义给出 key 池（面板填写 > .env keyEnvs，由装配处选择实现） */
export type SpecKeysOf = (spec: LlmProviderConfig) => string[];

/** 默认解析：keyEnvs 里的变量名逐个查 env */
export function envKeysOf(env: NodeJS.ProcessEnv = process.env): SpecKeysOf {
  return (spec) => spec.keyEnvs.map((n) => env[n]).filter((k): k is string => !!k);
}

/**
 * 生产解析：面板填写的 key（settings 表 `llm_key:<providerName>`，逗号分隔多 key）
 * 优先；没填才回退 keyEnvs 环境变量。
 */
export function dbKeysOf(db: Db, env: NodeJS.ProcessEnv = process.env): SpecKeysOf {
  const fromEnv = envKeysOf(env);
  return (spec) => {
    const panel = db.getSetting(`llm_key:${spec.name}`);
    if (panel && panel.trim()) {
      return panel.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return fromEnv(spec);
  };
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 一次性迁移：早期面板把 key 值本身误填进 keyEnvs（环境变量名）字段的，
 * 识别出来（不是合法变量名 = 是 key 值）挪进只写不读的 `llm_key:<name>`，
 * keyEnvs 只保留真变量名。迁移后 key 值不再出现在 provider 定义和任何展示里。
 * 返回迁移的 provider 数；值绝不进日志。
 */
export function migrateLiteralKeys(db: Db): number {
  const list = listLlmProviders(db);
  let migrated = 0;
  const next = list.map((p) => {
    const literals = p.keyEnvs.filter((e) => !ENV_NAME_RE.test(e));
    if (literals.length === 0) return p;
    migrated++;
    const existing = db.getSetting(`llm_key:${p.name}`);
    const merged = [existing?.trim(), ...literals].filter(Boolean).join(',');
    db.setSetting(`llm_key:${p.name}`, merged);
    return { ...p, keyEnvs: p.keyEnvs.filter((e) => ENV_NAME_RE.test(e)) };
  });
  if (migrated > 0) saveLlmProviders(db, next);
  return migrated;
}

/** 单次调用失败（HTTP 错误 / 响应缺内容 / JSON 解析失败），计入熔断 */
export class ProviderCallError extends Error {
  override name = 'ProviderCallError';
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

  /** 调 chat/completions，返回解析后的 JSON。任何失败抛 ProviderCallError */
  async complete(req: LlmRequest): Promise<unknown> {
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

    const key = this.nextKey();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;

    let res: Response;
    const url = `${this.spec.baseURL.replace(/\/+$/, '')}/chat/completions`;
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

    let content: unknown;
    try {
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      content = data.choices?.[0]?.message?.content;
    } catch {
      throw new ProviderCallError('响应不是合法 JSON 信封');
    }
    if (typeof content !== 'string' || !content.trim()) {
      throw new ProviderCallError('响应缺少 choices[0].message.content');
    }
    try {
      // structuredOutput=none 的端点可能把 JSON 包在 ```json 围栏里，剥掉兜底
      return JSON.parse(stripCodeFence(content));
    } catch {
      throw new ProviderCallError(`正文不是合法 JSON: ${content.slice(0, 120)}`);
    }
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
}

function hasImage(messages: ChatMessage[]): boolean {
  return messages.some(
    (m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url'),
  );
}

/**
 * 从配置装配 router。keysOf 缺省 = keyEnvs 逐个查 process.env；
 * 生产用 dbKeysOf(db)（面板填写 > .env）。路由由 provider 列表自动推导
 *（deriveRoutes），顺序即优先级。
 */
export function createLlmRouter(
  cfg: Omit<AppConfig['llm'], 'enabled'>,
  keysOf: SpecKeysOf = envKeysOf(),
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

// ---- provider 名单：settings 表是事实来源（面板管理），config.json 仅作首次种子 ----

const LLM_PROVIDERS_SETTING = 'llm_providers';

/** 仅当 settings 里没有 llm_providers 且 config 提供了名单时种子导入；返回导入数 */
export function seedLlmProvidersIfEmpty(db: Db, providers: LlmProviderConfig[]): number {
  if (db.getSetting(LLM_PROVIDERS_SETTING) !== null || providers.length === 0) return 0;
  db.setSetting(LLM_PROVIDERS_SETTING, JSON.stringify(providers));
  return providers.length;
}

export function listLlmProviders(db: Db): LlmProviderConfig[] {
  const raw = db.getSetting(LLM_PROVIDERS_SETTING);
  if (raw === null) return [];
  return JSON.parse(raw) as LlmProviderConfig[];
}

export function saveLlmProviders(db: Db, providers: LlmProviderConfig[]): void {
  db.setSetting(LLM_PROVIDERS_SETTING, JSON.stringify(providers));
}

// ---- LLM 总开关：settings 表覆盖（'1'/'0'）> config.json 默认值 ----

const LLM_ENABLED_SETTING = 'llm_enabled';

export function isLlmEnabled(db: Db, cfg: { enabled: boolean }): boolean {
  const v = db.getSetting(LLM_ENABLED_SETTING);
  if (v === '1') return true;
  if (v === '0') return false;
  return cfg.enabled;
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
