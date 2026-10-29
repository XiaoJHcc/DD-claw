/**
 * 网页检索：DeepSeek Search API（2026-10-17 上线，`POST /v1/tools/search`）。
 *
 * 为什么是它：返回结构化结果（title / url / snippet / summary / date / authority）而不是 HTML，
 * 中文长尾（声优、乐队、活动）命中率明显好过自建抓取；与 LLM 共用 DeepSeek key，
 * 按成功请求计费（失败 / 空结果不计费），对「人偶尔问一句」的量级成本可忽略。
 *
 * 调用纪律：只做一次检索、一次重试（408/429/5xx 是文档明说的可重试类），不做翻页与站内搜索。
 * 结果是**外部不可信文本**——调用方（工具层）负责在 description 里告诉模型别照做。
 */
import type { FetchLike } from '../analysis/providers.js';
import { SEARCH_ENDPOINT } from './config.js';

export interface WebSearchResult {
  title: string;
  url: string;
  /** 100~200 字摘要（给 UI/模型扫读） */
  snippet: string;
  /** 600~800 字长摘要（模型判断用） */
  summary: string;
  site: string | null;
  /** RFC 3339；未知为 null */
  date: string | null;
}

export interface WebSearchOptions {
  count?: number;
  timeoutMs?: number;
  /** 注入点：单测用假 fetch，生产缺省全局 fetch */
  fetchImpl?: FetchLike;
}

export const WEB_SEARCH_COUNT_MAX = 10;
export const WEB_SEARCH_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 1_200;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface RawResult {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
  summary?: unknown;
  site_name?: unknown;
  date?: unknown;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** HTTP 错误 → 中文可执行提示（402 是余额，429 是 QPS，401 是 key） */
function httpMessage(status: number, body: string): string {
  let detail = '';
  try {
    const err = (JSON.parse(body) as { error?: { message?: unknown } }).error;
    if (typeof err?.message === 'string') detail = `：${err.message}`;
  } catch {
    /* 非 JSON 错误体：忽略细节 */
  }
  if (status === 400) return `搜索参数不合法（HTTP 400）${detail}`;
  if (status === 401) return '搜索 key 无效（HTTP 401）：请在设置页「网页搜索」填对 DeepSeek API key';
  if (status === 402) return 'DeepSeek 账户余额不足（HTTP 402），请充值后再试';
  if (status === 408) return '搜索请求超时（HTTP 408）';
  if (status === 429) return '搜索请求过于频繁（HTTP 429），稍后再试';
  if (status >= 500) return `搜索服务暂时不可用（HTTP ${status}）`;
  return `搜索请求失败（HTTP ${status}）${detail}`;
}

/**
 * 检索一次。返回空数组 = 没有命中（正常结果，不是错误）。
 * 抛出的错误一律带中文可执行提示（key 缺失由调用方先行拦截）。
 */
export async function searchWeb(
  key: string,
  query: string,
  opts: WebSearchOptions = {},
): Promise<WebSearchResult[]> {
  const q = query.trim();
  if (!q) throw new Error('搜索词不能为空');
  const count = Math.min(Math.max(Math.trunc(opts.count ?? 5), 1), WEB_SEARCH_COUNT_MAX);
  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const body = JSON.stringify({ query: q, count });

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await doFetch(SEARCH_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? WEB_SEARCH_TIMEOUT_MS),
      });
    } catch (e) {
      const err = e as Error;
      const why = err.name === 'TimeoutError' || err.name === 'AbortError'
        ? `请求超时（${opts.timeoutMs ?? WEB_SEARCH_TIMEOUT_MS}ms）`
        : err.message;
      throw new Error(`搜索请求失败：${why}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      if (retryable && attempt === 0) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw new Error(httpMessage(res.status, text));
    }

    let json: { results?: RawResult[] };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      throw new Error('搜索响应不是合法 JSON');
    }
    const raw = Array.isArray(json.results) ? json.results : [];
    return raw
      .map((r): WebSearchResult | null => {
        const url = str(r.url);
        if (!/^https?:\/\//i.test(url)) return null;
        return {
          title: str(r.title),
          url,
          snippet: str(r.snippet),
          summary: str(r.summary),
          site: str(r.site_name) || null,
          date: str(r.date) || null,
        };
      })
      .filter((r): r is WebSearchResult => r !== null);
  }
}
