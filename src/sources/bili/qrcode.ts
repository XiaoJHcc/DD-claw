/**
 * passport 扫码登录客户端：生成二维码 → 轮询扫码状态 → confirmed 时提取 cookie。
 * 不走 biliRequest —— confirmed 的 cookie 在响应 Set-Cookie 头里，biliRequest 不暴露响应头。
 * 【已实测 2026-08-03】真实扫码全链路通过：generate → poll 四态 → confirmed 提 cookie。
 * cookie 值绝不进日志、不进错误消息。
 */
import { BiliHttpError, UA } from './client.js';

const GENERATE_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate';
const POLL_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll';
const TIMEOUT_MS = 10_000;

/** fetch 的函数形态，供单测注入假实现 */
export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface QrcodeInfo {
  key: string;
  url: string;
}

export type QrcodePollStatus = 'waiting' | 'scanned' | 'confirmed' | 'expired';

export interface QrcodePollResult {
  status: QrcodePollStatus;
  /** 仅 confirmed 时存在：从 Set-Cookie 提取的全套 name→value */
  cookies?: Record<string, string>;
}

async function rawGet(url: string, fetchImpl: FetchImpl): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const err = e as Error;
    throw new BiliHttpError(
      err.name === 'TimeoutError' || err.name === 'AbortError'
        ? `请求超时 (${TIMEOUT_MS}ms)`
        : `网络错误: ${err.message}`,
    );
  }
  if (!res.ok) throw new BiliHttpError(`HTTP ${res.status} ${res.statusText}`, res.status);
  return res;
}

/** 解析外层 envelope；坏 JSON / code != 0 一律归到 HTTP 层错误（扫码接口业务码在 data.code 里） */
async function parseEnvelope<T>(res: Response): Promise<T> {
  let json: { code?: number; message?: string; msg?: string; data?: T };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    throw new BiliHttpError('响应不是合法 JSON（可能是风控页面）', res.status);
  }
  if (json.code !== 0) {
    throw new BiliHttpError(`扫码接口返回 code=${json.code} ${json.message ?? json.msg ?? ''}`.trim(), res.status);
  }
  return json.data as T;
}

export async function generateQrcode(fetchImpl: FetchImpl = fetch): Promise<QrcodeInfo> {
  const data = await parseEnvelope<{ qrcode_key?: string; url?: string }>(
    await rawGet(GENERATE_URL, fetchImpl),
  );
  if (!data?.qrcode_key || !data?.url) {
    throw new BiliHttpError('扫码 generate 响应缺少 qrcode_key/url');
  }
  return { key: data.qrcode_key, url: data.url };
}

/** 从 Set-Cookie 头提取所有 name=value 对（每段第一个是 cookie 本体，后面是属性） */
function extractCookies(res: Response): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const line of res.headers.getSetCookie()) {
    const first = line.split(';', 1)[0]!;
    const eq = first.indexOf('=');
    if (eq > 0) cookies[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
  }
  return cookies;
}

export async function pollQrcode(key: string, fetchImpl: FetchImpl = fetch): Promise<QrcodePollResult> {
  const res = await rawGet(`${POLL_URL}?qrcode_key=${encodeURIComponent(key)}`, fetchImpl);
  const data = await parseEnvelope<{ code?: number }>(res);
  // 已实测：86101=未扫 86090=已扫未确认 86038=已过期 0=确认
  switch (data?.code) {
    case 0:
      return { status: 'confirmed', cookies: extractCookies(res) };
    case 86090:
      return { status: 'scanned' };
    case 86038:
      return { status: 'expired' };
    case 86101:
    default:
      // 未知 code 按 waiting 处理：轮询继续，最差是超时后用户重新生成
      return { status: 'waiting' };
  }
}
