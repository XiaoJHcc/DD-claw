import { makeLogger } from '../../logger.js';
import type { BiliApiEnvelope } from './types.js';

const log = makeLogger('bili/client');

/**
 * UA 在这一层强制注入，不给调用方覆盖的机会。
 * 实测：缺 UA 会导致部分接口直接 -352（见 docs/research/danmaku.md）。
 * tiny-bilibili-ws 就是栽在调用方 headers 覆盖掉内置 UA 上。
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DEFAULT_TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [1_000, 3_000];

/** 网络/HTTP 层失败，可重试 */
export class BiliHttpError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'BiliHttpError';
  }
}

/** 业务层失败：HTTP 200 但 code != 0。多为风控或参数问题 */
export class BiliApiError extends Error {
  constructor(readonly code: number, message: string) {
    super(`code=${code} ${message}`);
    this.name = 'BiliApiError';
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  timeoutMs?: number;
  referer?: string;
}

async function once<T>(url: string, opts: RequestOptions): Promise<BiliApiEnvelope<T>> {
  const headers: Record<string, string> = { 'User-Agent': UA, Accept: 'application/json' };
  if (opts.referer) headers['Referer'] = opts.referer;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (e) {
    const err = e as Error;
    throw new BiliHttpError(
      err.name === 'TimeoutError' || err.name === 'AbortError'
        ? `请求超时 (${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms)`
        : `网络错误: ${err.message}`,
    );
  }

  if (!res.ok) throw new BiliHttpError(`HTTP ${res.status} ${res.statusText}`, res.status);

  let json: BiliApiEnvelope<T>;
  try {
    json = (await res.json()) as BiliApiEnvelope<T>;
  } catch {
    // 412 风控页面会返回 HTML 而非 JSON
    throw new BiliHttpError('响应不是合法 JSON（可能是风控页面）', res.status);
  }

  if (json.code !== 0) {
    throw new BiliApiError(json.code, json.message ?? json.msg ?? '(无 message)');
  }
  return json;
}

/**
 * 带退避重试。只重试 HTTP 层错误 —— 业务层 code != 0 立刻重试没有意义，
 * 风控只会更严，交给上层计入健康计数。
 */
export async function biliRequest<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const json = await once<T>(url, opts);
      return json.data;
    } catch (e) {
      lastErr = e;
      if (e instanceof BiliApiError) throw e;
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      log.warn(`第 ${attempt + 1} 次失败，${delay}ms 后重试`, e);
      await sleep(delay);
    }
  }
  throw lastErr;
}

export { UA };
