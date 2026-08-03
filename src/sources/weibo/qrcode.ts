/**
 * 微博扫码登录客户端：生成二维码 → 轮询扫码状态 → confirmed 后跟随 data.url
 * 的 302 链收集 Set-Cookie 换得登录 cookie（SUB/SUBP 等）。
 * 不走统一封装 —— 换票的 cookie 在响应 Set-Cookie 头里，且每跳要带已收集的 cookie。
 * 【已实测 2026-08-03】全链路真扫通过：generate（retcode:20000000 + data.qrid/image）、
 * 未扫描态（check retcode:50114001「未使用」）、confirmed 换票落盘、mymblog 时间线归档。
 * **generate 必须带 Referer: https://weibo.com/，否则 403**（冒烟实测）。
 * 50114002=scanned 与其余 50114xxx 的映射是防御式的（未单独观测），见 pollQrcode。
 * cookie 值绝不进日志、不进错误消息。
 */
import { makeLogger } from '../../logger.js';

const log = makeLogger('weibo/qrcode');

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15_000;
/** 换票 302 链的跟随上限（实测配方一般 2-3 跳） */
const MAX_HOPS = 5;

const GENERATE_URL = 'https://passport.weibo.com/sso/v2/qrcode/image?entry=miniblog&size=180';
// url 参数是登录成功后的固定回调地址（实测配方：newlogin → weibo.com 首页，双重编码）
const CHECK_URL =
  'https://passport.weibo.com/sso/v2/qrcode/check?entry=miniblog&source=miniblog&url=' +
  encodeURIComponent(
    'https://weibo.com/newlogin?tabtype=weibo&gid=102803&openLoginLayer=0&url=' +
      encodeURIComponent('https://weibo.com/'),
  ) +
  '&disp=popup';

/** fetch 的函数形态，供单测注入假实现 */
export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface WeiboQrcodeInfo {
  qrid: string;
  /** 二维码 png 直链，面板直接 <img src> 显示（不用内嵌二维码库） */
  image: string;
}

export type WeiboQrcodePollStatus = 'waiting' | 'scanned' | 'confirmed' | 'expired';

export interface WeiboQrcodePollResult {
  status: WeiboQrcodePollStatus;
  /** 仅 confirmed 时存在：跨域登录跳转地址，换票（exchangeWeiboCookies）的输入 */
  loginUrl?: string;
}

async function rawGet(url: string, fetchImpl: FetchImpl, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      ...init,
      headers: {
        'User-Agent': DESKTOP_UA,
        Accept: 'application/json',
        // 实测：passport.weibo.com 无 Referer 直接 403
        Referer: 'https://weibo.com/',
        ...init?.headers,
      },
      signal: init?.signal ?? AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const err = e as Error;
    throw new Error(
      err.name === 'TimeoutError' || err.name === 'AbortError'
        ? `微博请求超时 (${TIMEOUT_MS}ms)`
        : `微博网络错误: ${err.message}`,
    );
  }
  // redirect: 'manual' 时 3xx 是正常一跳（res.ok=false），不抛
  if (!res.ok && !(init?.redirect === 'manual' && res.status >= 300 && res.status < 400)) {
    throw new Error(`微博接口 HTTP ${res.status} ${res.statusText}`);
  }
  return res;
}

interface RetcodeEnvelope<T> {
  retcode?: number;
  msg?: string;
  data?: T;
}

async function parseJson<T>(res: Response, what: string): Promise<RetcodeEnvelope<T>> {
  try {
    return (await res.json()) as RetcodeEnvelope<T>;
  } catch {
    throw new Error(`微博${what}响应不是合法 JSON`);
  }
}

export async function generateQrcode(fetchImpl: FetchImpl = fetch): Promise<WeiboQrcodeInfo> {
  const json = await parseJson<{ qrid?: string; image?: string }>(
    await rawGet(GENERATE_URL, fetchImpl), '扫码 generate',
  );
  if (json.retcode !== 20000000) {
    throw new Error(`微博扫码 generate 返回 retcode=${json.retcode} ${json.msg ?? ''}`.trim());
  }
  if (!json.data?.qrid || !json.data?.image) {
    throw new Error('微博扫码 generate 响应缺少 qrid/image');
  }
  return { qrid: json.data.qrid, image: json.data.image };
}

export async function pollQrcode(qrid: string, fetchImpl: FetchImpl = fetch): Promise<WeiboQrcodePollResult> {
  const json = await parseJson<{ url?: string }>(
    await rawGet(`${CHECK_URL}&qrid=${encodeURIComponent(qrid)}`, fetchImpl), '扫码 check',
  );
  switch (json.retcode) {
    case 20000000: // [已实测] 确认
      if (!json.data?.url) throw new Error('微博扫码 confirmed 响应缺少 data.url');
      return { status: 'confirmed', loginUrl: json.data.url };
    case 50114001: // [已实测] 未使用（未扫描）
      return { status: 'waiting' };
    case 50114002: // 按文档映射为已扫未确认（防御式，未单独观测）
      return { status: 'scanned' };
    default:
      // 其他 50114xxx（含过期码）防御式归到 expired
      if (json.retcode != null && json.retcode >= 50114000 && json.retcode < 50115000) {
        return { status: 'expired' };
      }
      // 完全未知的码按 waiting 处理：轮询继续，最差是超时后重新生成
      log.warn(`微博扫码 check 返回未知 retcode=${json.retcode}，按 waiting 继续轮询`);
      return { status: 'waiting' };
  }
}

/** 从 Set-Cookie 头提取所有 name=value 对（每段第一个是 cookie 本体，后面是属性） */
function collectSetCookies(res: Response, into: Record<string, string>): void {
  for (const line of res.headers.getSetCookie()) {
    const first = line.split(';', 1)[0]!;
    const eq = first.indexOf('=');
    if (eq > 0) into[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
  }
}

/**
 * 换票：从 confirmed 的 data.url 起跟随 302 链（redirect: 'manual'，最多 5 跳），
 * 每跳收集 Set-Cookie、带上已收集的 cookie 继续走（跨域登录链依赖前面落下的
 * 中间 cookie）。整条链合并成全套 name→value 返回。cookie 值绝不进日志。
 */
export async function exchangeCookies(
  loginUrl: string, fetchImpl: FetchImpl = fetch,
): Promise<Record<string, string>> {
  const cookies: Record<string, string> = {};
  let url = loginUrl;
  for (let hop = 0; ; hop++) {
    const collected = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await rawGet(url, fetchImpl, {
      redirect: 'manual',
      headers: collected ? { Cookie: collected } : {},
    });
    collectSetCookies(res, cookies);
    if (res.status < 300 || res.status >= 400) return finalize(cookies, url);
    const location = res.headers.get('location');
    if (!location) return finalize(cookies, url);
    if (hop >= MAX_HOPS) throw new Error(`微博换票跳转超过 ${MAX_HOPS} 跳仍未落地`);
    url = new URL(location, url).toString(); // Location 可能是相对路径
  }

  function finalize(map: Record<string, string>, lastUrl: string): Record<string, string> {
    if (Object.keys(map).length === 0) {
      throw new Error(`微博换票完成但未获得任何 Set-Cookie（最后一跳 ${new URL(lastUrl).host}）`);
    }
    if (!map['SUB']) {
      log.warn('微博换票结果缺少 SUB，登录态接口大概率不可用（不拦截，下轮心跳会判失效）');
    }
    return map;
  }
}
