/**
 * 决策模型路由：名单顺序 = 优先级，逐个候选试到成功为止。
 *
 * 与 LLM 通道彻底隔离：本文件自带 key 池、失败计数与熔断窗口，不 import 也不复用
 * `LlmRouter` / `OpenAiProvider` 的任何运行时状态（只复用 `FetchLike` 类型）。
 *
 * 候选顺序（见 docs/plan/decision-model.md §2.6）：
 * - 含图内容：先试「启用且 vision」的供应商（名单序），都不可用/失败再试纯文本供应商；
 *   纯文本供应商调用时**不带 assets、state 里也没有图片 ref**（由调用方按 withImages 分别构造）。
 * - 无图内容：按名单序。
 *
 * 一次候选失败不放弃整条链：换下一个；全部失败抛 `DecisionUnavailableError`
 * 由判定档回退到下一档。可重试失败（网络 / 超时 / 429 / 5xx）在**同一供应商**就地重试
 * 一次，400/413 这类确定性错误不重试。
 */
import type { DecisionProviderConfig } from '../config/index.js';
import type { Db } from '../core/db.js';
import type { ModelAttempt } from '../core/content-audit.js';
import type { RuntimeConfig } from '../core/runtime-config.js';
import { makeLogger } from '../logger.js';
import {
  callSystemOne, dbDecisionKeysOf, decisionNeedsAuth, listDecisionProviders, DecisionCallError,
  type DecisionAsset, type SystemOneRequest, type SystemOneResponse,
} from './decision-providers.js';
import type { FetchLike } from './providers.js';

const log = makeLogger('analysis/decision-router');

/** 可重试失败（网络 / 超时 / 429 / 5xx）的就地重试次数（共 1 + 1 次尝试） */
const MAX_RETRIES = 1;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 是否值得就地重试：网络异常与超时（无状态码）、限流、服务端故障；4xx 业务错不重试 */
function retryable(e: unknown): boolean {
  if (!(e instanceof DecisionCallError)) return false;
  if (e.status === undefined) return true;
  return e.status === 429 || e.status >= 500;
}

export interface DecisionProviderOptions {
  timeoutMs: number;
  circuitThreshold: number;
  circuitCooldownMs: number;
  fetchFn?: FetchLike;
  /** 可注入时钟（测试用） */
  now?: () => number;
  /** 就地重试间隔（毫秒）；缺省 1000，测试传 0 */
  retryDelayMs?: number;
}

/** 面板 / 日志用的供应商状态（不含 key） */
export type DecisionProviderStatus = 'ready' | 'disabled' | '缺 key（未填写）' | '熔断中';

/** 单个决策供应商：key 池轮换 + 连续失败熔断。只做「一次调用」，挑候选是 router 的事。 */
export class DecisionProvider {
  private keyIdx = 0;
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private keys: string[];
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;

  constructor(
    readonly spec: DecisionProviderConfig,
    /** 已解析出的 key 池（loopback 无鉴权端点可以为空） */
    keys: string[],
    private readonly opts: DecisionProviderOptions,
  ) {
    this.keys = keys;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  get name(): string {
    return this.spec.name;
  }

  /** 面板改 key 后热更新（router 重建时也会重来一遍）；轮询位置归零 */
  setKeys(keys: string[]): void {
    this.keys = keys;
    this.keyIdx = 0;
  }

  /** 需要鉴权但一个 key 都没有（loopback 端点免 key） */
  get keyMissing(): boolean {
    return decisionNeedsAuth(this.spec) && this.keys.length === 0;
  }

  isReady(): boolean {
    if (!this.spec.enabled || this.keyMissing) return false;
    return this.now() >= this.circuitOpenUntil;
  }

  status(): DecisionProviderStatus {
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
        `决策供应商 ${this.name} 连续失败 ${this.consecutiveFailures} 次，熔断 ` +
        `${Math.round(this.opts.circuitCooldownMs / 1000)}s`,
      );
    }
    log.warn(`决策供应商 ${this.name} 调用失败: ${(err as Error).message}`);
  }

  private nextKey(): string | undefined {
    if (this.keys.length === 0) return undefined;
    const key = this.keys[this.keyIdx % this.keys.length];
    this.keyIdx++;
    return key;
  }

  /** 发一次请求（可重试失败就地重试一次，每次尝试自然轮换池内下一个 key） */
  async call(req: SystemOneRequest): Promise<SystemOneResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await callSystemOne(this.spec, this.nextKey() ?? null, req, {
          fetchFn: this.fetchFn,
          timeoutMs: this.opts.timeoutMs,
        });
      } catch (e) {
        if (attempt >= MAX_RETRIES || !retryable(e)) throw e;
        log.debug(`决策供应商 ${this.name} 第 ${attempt + 1} 次重试: ${(e as Error).message}`);
        await sleep(this.opts.retryDelayMs ?? 1_000);
      }
    }
  }
}

/** 一次候选要发的东西：请求体 + （含图时的）图片资产 */
export interface DecisionCall {
  req: SystemOneRequest;
  assets?: Record<string, DecisionAsset>;
}

/**
 * 按候选构造请求：`withImages` = 这次是否允许带图（纯文本供应商恒 false），
 * `spec` 给出该候选的 model（不同供应商模型 ID 可以不同）。
 */
export type DecisionRequestBuilder = (withImages: boolean, spec: DecisionProviderConfig) => DecisionCall;

export interface DecisionResult {
  response: SystemOneResponse;
  /** 实际回答的供应商（`response.model` 才是回显版本，别名会漂） */
  provider: DecisionProviderConfig;
  /** 这次调用是否带了图（false + 内容有图 = 纯文本兜底，结果只落库不定案） */
  withImages: boolean;
}

/** 全部候选都不可用 / 都失败：本档本次没有结果，未定案项交下一档 */
export class DecisionUnavailableError extends Error {
  override name = 'DecisionUnavailableError';
  constructor(readonly attempts: string[]) {
    super(`决策模型不可用: ${attempts.join(' → ') || '(无候选供应商)'}`);
  }
}

export interface DecisionRouterOptions {
  timeoutMs: number;
  circuitThreshold: number;
  circuitCooldownMs: number;
  fetchFn?: FetchLike;
  now?: () => number;
  retryDelayMs?: number;
}

/** 装进请求体：只认本次允许的 assets，其余情况一律不带（纯文本供应商不得看到图片 ref） */
function withAssets(req: SystemOneRequest, assets?: Record<string, DecisionAsset>): SystemOneRequest {
  const { assets: _drop, ...rest } = req;
  return assets && Object.keys(assets).length > 0 ? { ...rest, assets } : rest;
}

export class DecisionRouter {
  private readonly providers: DecisionProvider[];

  constructor(
    specs: DecisionProviderConfig[],
    keysOf: (spec: DecisionProviderConfig) => string[],
    private readonly opts: DecisionRouterOptions,
  ) {
    this.providers = specs.map((spec) => new DecisionProvider(spec, keysOf(spec), opts));
  }

  /** 面板 / 排障用的状态快照（不含 key） */
  describe(): Array<{ id: string; name: string; model: string; vision: boolean; status: DecisionProviderStatus }> {
    return this.providers.map((p) => ({
      id: p.spec.id, name: p.name, model: p.spec.model, vision: p.spec.vision, status: p.status(),
    }));
  }

  /** 候选顺序：含图时 vision 供应商优先（各自保持名单序），纯文本供应商排在其后 */
  private candidates(hasImages: boolean): DecisionProvider[] {
    if (!hasImages) return this.providers;
    return [
      ...this.providers.filter((p) => p.spec.vision),
      ...this.providers.filter((p) => !p.spec.vision),
    ];
  }

  /**
   * 依次试候选直到有人给出**通过 validate 的**响应。
   * validate 抛错 = 这份响应不符合契约，与 HTTP 失败同等对待（计熔断、换下一个）。
   */
  async decide(
    build: DecisionRequestBuilder,
    opts: { hasImages: boolean },
    validate: (res: SystemOneResponse) => void,
    onAttempt?: (attempt: ModelAttempt) => void,
  ): Promise<DecisionResult> {
    const attempts: string[] = [];
    for (const p of this.candidates(opts.hasImages)) {
      const withImages = opts.hasImages && p.spec.vision;
      if (!p.isReady()) {
        const why = p.status();
        onAttempt?.({ provider: p.name, model: p.spec.model, status: 'skipped', channel: 'decision', error: why });
        attempts.push(`${p.name}(${why})`);
        continue;
      }
      try {
        const call = build(withImages, p.spec);
        const response = await p.call(withAssets(call.req, withImages ? call.assets : undefined));
        validate(response);
        p.recordSuccess();
        onAttempt?.({
          provider: p.name, model: response.model || p.spec.model, status: 'success', channel: 'decision',
        });
        return { response, provider: p.spec, withImages };
      } catch (e) {
        const message = (e as Error).message;
        p.recordFailure(e);
        onAttempt?.({ provider: p.name, model: p.spec.model, status: 'failed', channel: 'decision', error: message });
        attempts.push(`${p.name}(${message})`);
      }
    }
    throw new DecisionUnavailableError(attempts);
  }
}

/** 生产装配：名单 / key / 超时熔断都取自 settings（settings 是唯一信源） */
export function createDecisionRouter(
  db: Db,
  rc: RuntimeConfig,
  opts?: Partial<DecisionRouterOptions>,
): DecisionRouter {
  return new DecisionRouter(listDecisionProviders(db), dbDecisionKeysOf(db), {
    timeoutMs: rc.decisionRequestTimeoutMs,
    circuitThreshold: rc.decisionCircuitThreshold,
    circuitCooldownMs: rc.decisionCircuitCooldownMs,
    ...opts,
  });
}
