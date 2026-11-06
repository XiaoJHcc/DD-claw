/**
 * X People 搜索（Apify Actor `arjun_code~x-twitter-people-search-scraper`）。
 *
 * 与 `search.ts` 的网页发现路线互补：网页路线无需凭据，但只能证明「handle 存在」；
 * 这里调 X 原生 People 搜索，直接拿到真实 profile（显示名 / 简介 / 粉丝 / 认证 / 头像）。
 * 只在调用方拿到了 Apify token 时使用；没有 token 或调用失败时由调用方回退网页路线。
 *
 * 一次调用 = 起一个 Actor run（`searchQueries` 只放一个词）→ 轮询 run 状态 →
 * 读 `defaultDatasetId` 的 items。单次查询不再打 `verifyAccount`：Actor 返回的就是真实 profile。
 *
 * 契约：
 * - 空结果 / `no_results` → `[]`；Actor 失败、部分失败、超时 → 抛中文错误（不把失败伪装成空）。
 * - token 只出现在请求 URL 里，错误文本统一脱敏，绝不进日志。
 */
import type { XAccountCandidate } from './search.js';

export const APIFY_PEOPLE_SEARCH_ACTOR = 'arjun_code~x-twitter-people-search-scraper';
export const APIFY_PEOPLE_SEARCH_LIMIT_MAX = 10;

const APIFY_API_BASE_DEFAULT = 'https://api.apify.com/v2';
const REQUEST_TIMEOUT_MS_DEFAULT = 30_000;
const RUN_TIMEOUT_MS_DEFAULT = 120_000;
const POLL_INTERVAL_MS_DEFAULT = 2_000;
const RUN_SUCCEEDED = 'SUCCEEDED';
const RUN_TERMINAL_FAILURE = new Set(['FAILED', 'TIMED-OUT', 'TIMING-OUT', 'ABORTED']);

/** 原生 fetch 形状；测试注入替身，不额外引依赖 */
export type ApifyFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface ApifyPeopleSearchOptions {
  /** Apify API token（由调用方注入，绝不打印/写日志） */
  token: string;
  /** 候选数，1..10，缺省 5 */
  limit?: number;
  /** 单次 HTTP 请求超时（毫秒），缺省 30s */
  timeoutMs?: number;
  /** 等待 Actor run 完成的总时限（毫秒），缺省 120s */
  runTimeoutMs?: number;
  /** 轮询 run 状态的间隔（毫秒），缺省 2s */
  pollIntervalMs?: number;
  /** Apify API 基址，缺省官方地址；测试可注入 */
  apiBaseUrl?: string;
  /** fetch 替身（测试用） */
  fetchImpl?: ApifyFetch;
}

interface ApifyRun {
  id?: unknown;
  status?: unknown;
  defaultDatasetId?: unknown;
  statusMessage?: unknown;
}

function clampLimit(v: number | undefined): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 5;
  return Math.min(Math.max(n, 1), APIFY_PEOPLE_SEARCH_LIMIT_MAX);
}

function positive(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : fallback;
}

/** 外部文本进错误前一律抹掉 token（含 URL 编码形态） */
function redact(text: string, token: string): string {
  let out = text;
  if (!token) return out;
  out = out.split(token).join('***');
  const encoded = encodeURIComponent(token);
  if (encoded !== token) out = out.split(encoded).join('***');
  return out;
}

/** 响应体里的错误信息：兼容 Apify `{error:{message}}` / `{message}` / 纯文本 */
async function errorDetail(res: Response, token: string): Promise<string> {
  let text = '';
  try {
    text = (await res.text()).trim();
  } catch {
    return '';
  }
  if (!text) return '';
  try {
    const json = JSON.parse(text) as { error?: unknown; message?: unknown };
    const err = json.error;
    const msg = typeof err === 'string'
      ? err
      : err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string'
        ? (err as { message: string }).message
        : typeof json.message === 'string'
          ? json.message
          : '';
    if (msg) text = msg;
  } catch {
    // 非 JSON：原样截取
  }
  return redact(text.replace(/\s+/g, ' ').slice(0, 200), token);
}

function httpError(status: number, detail: string): Error {
  if (status === 401) return new Error('Apify token 无效或已过期（HTTP 401）');
  if (status === 402) return new Error('Apify 账户额度不足（HTTP 402）');
  if (status === 403) return new Error('Apify 拒绝访问（HTTP 403）');
  if (status === 429) return new Error('Apify 请求过于频繁（HTTP 429）');
  return new Error(`Apify 请求失败（HTTP ${status}）${detail ? `：${detail}` : ''}`);
}

interface RequestScope {
  token: string;
  timeoutMs: number;
  fetchImpl: ApifyFetch;
  label: string;
}

async function request(url: string, init: RequestInit, scope: RequestScope): Promise<Response> {
  let res: Response;
  try {
    res = await scope.fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(Math.max(1, scope.timeoutMs)),
    });
  } catch (e) {
    const err = e as { name?: unknown; message?: unknown };
    const message = redact(
      typeof err?.message === 'string' ? err.message : String(e),
      scope.token,
    );
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error(`Apify ${scope.label}超时（${scope.timeoutMs}ms）`);
    }
    throw new Error(`Apify ${scope.label}失败：${message}`);
  }
  if (!res.ok) throw httpError(res.status, await errorDetail(res, scope.token));
  return res;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('Apify 响应不是合法 JSON');
  }
}

function pickRun(json: unknown): ApifyRun {
  const wrapped = json && typeof json === 'object' ? (json as { data?: unknown }).data : undefined;
  const run = wrapped ?? json;
  if (!run || typeof run !== 'object') throw new Error('Apify 运行响应格式异常');
  return run as ApifyRun;
}

function runStatus(run: ApifyRun): string {
  if (typeof run.status !== 'string' || run.status.length === 0) {
    throw new Error('Apify 运行响应缺少状态');
  }
  return run.status;
}

function runMessage(run: ApifyRun, token: string): string {
  if (typeof run.statusMessage !== 'string') return '';
  const msg = redact(run.statusMessage.replace(/\s+/g, ' ').slice(0, 200), token);
  return msg ? `：${msg}` : '';
}

/** run 已失败就立即抛错；RUNNING / READY / ABORTING 等继续等 */
function assertRunNotFailed(run: ApifyRun, token: string): void {
  const status = runStatus(run);
  if (status === RUN_SUCCEEDED) return;
  if (status === 'TIMED-OUT' || status === 'TIMING-OUT') {
    throw new Error(`Apify 运行超时（状态 ${status}）`);
  }
  if (RUN_TERMINAL_FAILURE.has(status)) {
    throw new Error(`Apify 运行失败（状态 ${status}）${runMessage(run, token)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** pbs.twimg.com 的 `_normal` 是缩略图；换成 400x400 更适合作候选展示 */
function enlargeAvatar(url: string): string {
  return url.replace(/_normal(\.(?:jpg|jpeg|png|webp))$/i, '_400x400$1');
}

function toCandidate(rec: Record<string, unknown>): XAccountCandidate | null {
  const screenName = str(rec.screen_name).replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(screenName)) return null;
  const profileUrl = str(rec.profile_url);
  const avatar = str(rec.profile_image_url);
  return {
    screenName,
    url: /^https?:\/\//i.test(profileUrl) ? profileUrl : `https://x.com/${screenName}`,
    name: str(rec.name) || null,
    exists: true,
    sources: [],
    provider: 'apify',
    ...(str(rec.user_id) ? { userId: str(rec.user_id) } : {}),
    ...(str(rec.description) ? { description: str(rec.description) } : {}),
    followers: num(rec.followers_count),
    verified: rec.verified === true || rec.is_blue_verified === true,
    avatar: avatar ? enlargeAvatar(avatar) : null,
    location: str(rec.location) || null,
    website: str(rec.website_url) || null,
    tweets: num(rec.tweets_count),
    ...(str(rec.search_query) ? { matchedQuery: str(rec.search_query) } : {}),
  };
}

function failureError(
  rec: Record<string, unknown>,
  successCount: number,
  token: string,
): Error {
  const status = typeof rec.status === 'string' && rec.status ? rec.status : 'unknown';
  const message = typeof rec.message === 'string'
    ? redact(rec.message.replace(/\s+/g, ' ').slice(0, 200), token)
    : '';
  const suffix = message ? `：${message}` : '';
  const note = successCount > 0 ? `（另有 ${successCount} 条成功结果未返回）` : '';
  if (status === 'partial') return new Error(`Apify People 搜索部分失败${suffix}${note}`);
  if (status === 'request_failed') return new Error(`Apify People 搜索请求失败${suffix}${note}`);
  if (status === 'invalid_input') return new Error(`Apify 拒绝了搜索输入${suffix}`);
  return new Error(`Apify People 搜索未完成（状态 ${status}）${suffix}${note}`);
}

function mapItems(raw: unknown[], limit: number, token: string): XAccountCandidate[] {
  const successes: Array<Record<string, unknown>> = [];
  const failures: Array<Record<string, unknown>> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      failures.push({ status: 'unknown' });
      continue;
    }
    const rec = item as Record<string, unknown>;
    if (rec.status === 'success') successes.push(rec);
    else if (rec.status === 'no_results') continue;
    else failures.push(rec);
  }
  if (failures.length > 0) throw failureError(failures[0]!, successes.length, token);

  const seen = new Set<string>();
  const out: XAccountCandidate[] = [];
  for (const rec of successes) {
    const candidate = toCandidate(rec);
    if (!candidate) continue;
    const key = candidate.screenName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 关键词 → X 账号候选（真实 profile）。空数组 = 确实没搜到（含 `no_results`）。
 * Actor 失败 / 部分失败 / 超时抛中文错误，由调用方决定是否回退网页路线。
 */
export async function searchXAccountsViaApify(
  query: string,
  opts: ApifyPeopleSearchOptions,
): Promise<XAccountCandidate[]> {
  const q = query.trim();
  if (!q) throw new Error('搜索词不能为空');
  const token = (opts.token ?? '').trim();
  if (!token) throw new Error('Apify token 未配置，无法使用 People 搜索');

  const limit = clampLimit(opts.limit);
  const timeoutMs = positive(opts.timeoutMs, REQUEST_TIMEOUT_MS_DEFAULT);
  const runTimeoutMs = positive(opts.runTimeoutMs, RUN_TIMEOUT_MS_DEFAULT);
  const pollIntervalMs = positive(opts.pollIntervalMs, POLL_INTERVAL_MS_DEFAULT);
  const base = (opts.apiBaseUrl ?? APIFY_API_BASE_DEFAULT).replace(/\/+$/, '');
  const fetchImpl: ApifyFetch = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const tokenQuery = `token=${encodeURIComponent(token)}`;
  const deadline = Date.now() + runTimeoutMs;
  const timeoutError = () => new Error(`Apify People 搜索超时（${runTimeoutMs}ms 内未完成）`);

  const startRes = await request(
    // waitForFinish=0：立刻返回 run 句柄，等待节奏完全由本函数的轮询参数控制
    `${base}/acts/${APIFY_PEOPLE_SEARCH_ACTOR}/runs?${tokenQuery}&waitForFinish=0`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ searchQueries: [q], maxUsersPerQuery: limit }),
    },
    { token, timeoutMs: Math.min(timeoutMs, runTimeoutMs), fetchImpl, label: 'People 搜索' },
  );
  let run = pickRun(await readJson(startRes));
  assertRunNotFailed(run, token);

  while (runStatus(run) !== RUN_SUCCEEDED) {
    const left = deadline - Date.now();
    if (left <= 0) throw timeoutError();
    await sleep(Math.min(pollIntervalMs, left));
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw timeoutError();
    const runId = str(run.id);
    if (!runId) throw new Error('Apify 运行响应缺少 run id');
    const pollRes = await request(
      `${base}/actor-runs/${encodeURIComponent(runId)}?${tokenQuery}`,
      { headers: { accept: 'application/json' } },
      {
        token,
        timeoutMs: Math.min(timeoutMs, remaining),
        fetchImpl,
        label: '运行状态查询',
      },
    );
    run = pickRun(await readJson(pollRes));
    assertRunNotFailed(run, token);
  }

  const datasetId = str(run.defaultDatasetId);
  if (!datasetId) throw new Error('Apify 运行成功但缺少数据集 id');

  const itemsRes = await request(
    `${base}/datasets/${encodeURIComponent(datasetId)}/items?${tokenQuery}&clean=true&format=json`,
    { headers: { accept: 'application/json' } },
    { token, timeoutMs, fetchImpl, label: '数据集读取' },
  );
  const items = await readJson(itemsRes);
  if (!Array.isArray(items)) throw new Error('Apify 数据集响应格式异常');
  return mapItems(items, limit, token);
}
