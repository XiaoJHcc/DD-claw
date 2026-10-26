import { normalizeProviderBaseURL, type DecisionProviderConfig } from '../config/index.js';
import { splitCsvText } from '../core/csv.js';
import type { Db } from '../core/db.js';
import type { FetchLike } from './providers.js';

/**
 * 决策模型 provider 层（System One）：`POST <baseURL>/v1/systemone`，请求体是
 * `state + questions`（含图时另带顶层 `assets`），响应是同 id 的 typed answers。
 *
 * 本文件只管线格式、探活、名单与 key 的存取；调用顺序 / 熔断 / key 轮换在
 * `decision-router.ts`，判定任务（请求打包与解析）在 `tasks/decide.ts`。
 *
 * 设计边界：
 * - **只认 `systemone` 线格式**：`choice` / `score` / `noul`（`box` 是图片实验特性，未接）。
 *   OpenAI / Perplexity 的 `/v1/decisions` 形状不同，等接入时再加协议值。
 * - **与 LLM 通道彻底隔离**：独立 key（`decision_key:<id>`）、独立协议、独立错误类型；
 *   这里不读 `llm_*` 设置，也不复用 `LlmRouter` 的熔断状态。
 * - **key 绝不进日志/错误信息**：只在 Authorization 头出现；错误只带 HTTP 状态与响应摘要。
 * - **图片走 TypeSafe 原生 `assets`**：纯 base64（无 data URL 前缀），ref 写进 `state`
 *   的字符串值里；含图请求必须带 `TypeSafe-Danger-Zone-Images: true` 头。
 */

/** System One 的单题形状：只有当前实现用到的三种原语；`box` 等图片实验特性未接。 */
export type SystemOneQuestion =
  | { type: 'noul'; instructions?: string; criteria?: Record<string, unknown> }
  | { type: 'choice'; instructions?: string; criteria: Record<string, unknown> }
  | { type: 'score'; instructions?: string; criteria: Array<unknown> };

export interface SystemOneRequest {
  model: string;
  state: unknown;
  questions: Record<string, SystemOneQuestion>;
  /** 含图请求的图片资产：ref → { type:'image', format:'jpg', data_base64 }；无图时不带这个键 */
  assets?: Record<string, DecisionAsset>;
}

/** System One 的图片资产：`data_base64` 是纯 base64（无 `data:` 前缀），ref 必须写进 state */
export interface DecisionAsset {
  type: 'image';
  format: 'jpg';
  data_base64: string;
}

export interface SystemOneAnswer {
  type: 'noul' | 'choice' | 'score' | 'box';
  noul?: number;
  choice?: string;
  score?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
  legend?: Record<string, unknown>;
}

export interface SystemOneResponse {
  /** 实际回答的模型版本（别名会漂，审计必须记这个回显值） */
  model: string;
  answers: Record<string, SystemOneAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** 单次决策调用失败（HTTP 错误 / 响应不符合 System One 契约）。 */
export class DecisionCallError extends Error {
  override name = 'DecisionCallError';
  constructor(
    message: string,
    /** HTTP 状态码（网络异常时为 undefined） */
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface DecisionCallOptions {
  fetchFn?: FetchLike;
  timeoutMs?: number;
}

/** 决策通道默认超时：装配根传入的取值来自运行时参数 `decision_request_timeout_ms`。 */
export const DECISION_REQUEST_TIMEOUT_MS = 30_000;

/** 含图请求必须带这个头（TypeSafe 的图片危险区开关），否则端点拒收 assets。 */
export const IMAGES_HEADER = 'TypeSafe-Danger-Zone-Images';

/**
 * 发一次 System One 请求。目前只有一个协议，但分派保留在函数入口：
 * 将来加 `/v1/decisions` 时在这里加分支，业务层仍只看到 `state + questions + answers`。
 * `req.assets` 非空 = 含图请求：加图片危险区头，assets 原样进请求体。
 */
export async function callSystemOne(
  spec: DecisionProviderConfig,
  key: string | null,
  req: SystemOneRequest,
  opts: DecisionCallOptions = {},
): Promise<SystemOneResponse> {
  if (spec.protocol !== 'systemone') {
    throw new DecisionCallError(`不支持的决策模型协议: ${spec.protocol}`);
  }
  const url = `${normalizeProviderBaseURL(spec.baseURL)}/v1/systemone`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  if (req.assets && Object.keys(req.assets).length > 0) headers[IMAGES_HEADER] = 'true';

  const fetchFn = opts.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DECISION_REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    throw new DecisionCallError(`请求异常: ${(e as Error).message}`);
  }
  if (!res.ok) {
    // 响应体可能含限流/额度信息，截断带上；即使端点把 key 回显进错误体也要打码
    const raw = (await res.text().catch(() => '')).slice(0, 200);
    const text = key ? raw.split(key).join('***') : raw;
    throw new DecisionCallError(`HTTP ${res.status}${text ? `: ${text}` : ''}`, res.status);
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new DecisionCallError('响应不是合法 JSON 信封');
  }
  const out = data as Partial<SystemOneResponse> | null;
  if (!out || typeof out !== 'object' || !out.answers || typeof out.answers !== 'object') {
    throw new DecisionCallError('响应缺少 answers');
  }
  return {
    model: typeof out.model === 'string' ? out.model : '',
    answers: out.answers,
    ...(out.usage ? { usage: out.usage } : {}),
  };
}

/**
 * 面板「测试」按钮：发一道最小 `noul`，只验证鉴权、端点与线格式。
 * 返回**响应里回显的模型版本**——别名会漂，让用户看到实际回答者。
 */
export async function pingDecisionProvider(
  spec: DecisionProviderConfig,
  key: string | null,
  opts: DecisionCallOptions = {},
): Promise<{ ms: number; model: string }> {
  const t0 = Date.now();
  const out = await callSystemOne(spec, key, {
    model: spec.model,
    state: 'ping',
    questions: {
      probe: { type: 'noul', instructions: 'Is this a connectivity probe?' },
    },
  }, opts);
  const answer = out.answers.probe;
  if (!answer || answer.type !== 'noul' || typeof answer.noul !== 'number') {
    throw new DecisionCallError('响应缺少 noul 答案');
  }
  return { ms: Date.now() - t0, model: out.model || spec.model };
}

/** 需要鉴权：loopback（本地 llama.cpp / Ollaya 等无鉴权端点）以外都算需要。 */
export function decisionNeedsAuth(spec: DecisionProviderConfig): boolean {
  try {
    const h = new URL(spec.baseURL).hostname;
    return h !== '127.0.0.1' && h !== 'localhost' && h !== '::1' && h !== '[::1]';
  } catch {
    return true;
  }
}

// ---- provider 名单与 key：settings 表是唯一信源（面板决策模型卡片管理）----

const DECISION_PROVIDERS_SETTING = 'decision_providers';

export function listDecisionProviders(db: Db): DecisionProviderConfig[] {
  const raw = db.getSetting(DECISION_PROVIDERS_SETTING);
  if (raw === null) return [];
  return JSON.parse(raw) as DecisionProviderConfig[];
}

export function saveDecisionProviders(db: Db, providers: DecisionProviderConfig[]): void {
  db.setSetting(DECISION_PROVIDERS_SETTING, JSON.stringify(providers));
}

/** key 设置项名（`decision_key:<providerId>`，与 LLM 的 `llm_key:` 平行且不共享）。 */
export function decisionKeySetting(id: string): string {
  return `decision_key:${id}`;
}

/** key 解析器：按 provider 定义给出 key 池（逗号分隔多 key，轮换在 decision-router） */
export function dbDecisionKeysOf(db: Db): (spec: DecisionProviderConfig) => string[] {
  return (spec) => splitCsvText(db.getSetting(decisionKeySetting(spec.id)));
}

// ---- 决策档总开关：settings 表（'1'/'0'），缺省 = 关（与 LLM 总开关平行且不共享）----

const DECISION_ENABLED_SETTING = 'decision_enabled';

export function isDecisionEnabled(db: Db): boolean {
  return db.getSetting(DECISION_ENABLED_SETTING) === '1';
}

export function setDecisionEnabled(db: Db, on: boolean): void {
  db.setSetting(DECISION_ENABLED_SETTING, on ? '1' : '0');
}
