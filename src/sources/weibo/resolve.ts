import { makeLogger } from '../../logger.js';

const log = makeLogger('weibo/resolve');

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface WeiboResolver {
  /** 昵称 → 微博 UID；昵称不存在返回 null；网络/解析失败抛中文 Error */
  resolveUid(nick: string): Promise<string | null>;
  /** 微博 UID → 昵称；uid 不存在返回 null；网络/解析失败抛中文 Error */
  resolveNick(uid: string): Promise<string | null>;
}

interface VisitorCookies {
  sub: string;
  subp: string;
}

/** JSONP 响应 `window.xxx && xxx({...})` 提取 data 字段 */
function extractJsonpData(body: string, what: string): Record<string, unknown> {
  const m = body.match(/\((\{[\s\S]*\})\)/);
  if (!m) throw new Error(`微博${what}响应不是预期的 JSONP 格式`);
  let parsed: { data?: Record<string, unknown> };
  try {
    parsed = JSON.parse(m[1]!) as { data?: Record<string, unknown> };
  } catch {
    throw new Error(`微博${what}响应 JSON 解析失败`);
  }
  if (!parsed.data) throw new Error(`微博${what}响应缺少 data 字段`);
  return parsed.data;
}

/**
 * 微博昵称 ↔ UID 解析器（匿名访客通道，无需登录；昵称→UID 流程已实测 2026-08-03）：
 * 1. passport genvisitor 拿 tid
 * 2. passport visitor/incarnate 拿访客 cookie（SUB/SUBP）
 * 3. m.weibo.cn/n/<昵称> 302 跳 /u/<uid>；m.weibo.cn/api/container/getIndex?type=uid 取 userInfo.screen_name
 * 访客 cookie 模块级缓存；跳回 visitor 验证页视为失效，重建后重试一次。
 * cookie 绝不进日志。fetch 可注入便于单测。
 */
export function createWeiboResolver(fetchImpl?: FetchImpl): WeiboResolver {
  const doFetch: FetchImpl =
    fetchImpl ??
    ((url, init) =>
      fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(15_000) }));

  let cached: VisitorCookies | null = null;

  async function fetchVisitorCookies(): Promise<VisitorCookies> {
    const headers = { 'user-agent': DESKTOP_UA, referer: 'https://weibo.com/' };
    const r1 = await doFetch(
      'https://passport.weibo.com/visitor/genvisitor?cb=gen_callback' +
        '&fp=%7B%22os%22%3A%221%22%7D&ret=1',
      { headers },
    );
    if (!r1.ok) throw new Error(`微博访客令牌申请失败（HTTP ${r1.status}）`);
    const tid = extractJsonpData(await r1.text(), '访客令牌').tid;
    if (typeof tid !== 'string' || !tid) throw new Error('微博访客令牌响应缺少 tid');

    const r2 = await doFetch(
      'https://passport.weibo.com/visitor/visitor?a=incarnate&t=' + encodeURIComponent(tid) +
        '&w=2&c=095&cb=cross_domain&from=weibo&_rand=0.1',
      { headers },
    );
    if (!r2.ok) throw new Error(`微博访客凭证换取失败（HTTP ${r2.status}）`);
    const data = extractJsonpData(await r2.text(), '访客凭证');
    if (typeof data.sub !== 'string' || typeof data.subp !== 'string' || !data.sub || !data.subp) {
      throw new Error('微博访客凭证响应缺少 sub/subp');
    }
    return { sub: data.sub, subp: data.subp };
  }

  async function lookupOnce(nick: string, cookies: VisitorCookies): Promise<string | null | 'expired'> {
    const res = await doFetch('https://m.weibo.cn/n/' + encodeURIComponent(nick), {
      headers: {
        'user-agent': MOBILE_UA,
        cookie: `SUB=${cookies.sub}; SUBP=${cookies.subp}`,
      },
      redirect: 'manual',
    });
    if (res.status === 200) return null; // 昵称不存在
    if (res.status === 301 || res.status === 302) {
      const loc = res.headers.get('location') ?? '';
      if (/visitor\.passport\.weibo\.(com|cn)/.test(loc)) return 'expired';
      const m = loc.match(/\/u\/(\d+)/);
      if (m) return m[1]!;
      throw new Error(`微博昵称解析跳转目标无法识别（Location 不含 /u/<uid>）`);
    }
    throw new Error(`微博昵称解析请求失败（HTTP ${res.status}）`);
  }

  /** uid → 昵称：getIndex 的 userInfo；跳登录/验证页视为 cookie 失效，缺 userInfo 视为 uid 不存在 */
  async function lookupNickOnce(uid: string, cookies: VisitorCookies): Promise<string | null | 'expired'> {
    const res = await doFetch(
      'https://m.weibo.cn/api/container/getIndex?type=uid&value=' + encodeURIComponent(uid),
      {
        headers: {
          'user-agent': MOBILE_UA,
          cookie: `SUB=${cookies.sub}; SUBP=${cookies.subp}`,
          referer: 'https://m.weibo.cn/',
        },
        redirect: 'manual',
      },
    );
    if (res.status === 301 || res.status === 302) {
      const loc = res.headers.get('location') ?? '';
      if (/visitor\.passport\.weibo\.(com|cn)|login/.test(loc)) return 'expired';
      throw new Error(`微博 uid 解析跳转目标无法识别（Location: 非资料页）`);
    }
    if (!res.ok) throw new Error(`微博 uid 解析请求失败（HTTP ${res.status}）`);
    let json: { ok?: number; data?: { userInfo?: { screen_name?: unknown } } };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      throw new Error('微博 uid 解析响应不是合法 JSON');
    }
    const name = json.data?.userInfo?.screen_name;
    if (typeof name === 'string' && name.trim()) return name.trim();
    return null; // uid 不存在（或该账号无资料页）
  }

  return {
    async resolveUid(nick: string): Promise<string | null> {
      try {
        if (!cached) cached = await fetchVisitorCookies();
        let result = await lookupOnce(nick, cached);
        if (result === 'expired') {
          log.info('微博访客 cookie 已失效，重建后重试一次');
          cached = null;
          cached = await fetchVisitorCookies();
          result = await lookupOnce(nick, cached);
          if (result === 'expired') throw new Error('微博访客 cookie 重建后仍失效，昵称解析失败');
        }
        return result;
      } catch (e) {
        // 底层网络/超时异常统一包成带中文说明的 Error；自己抛的中文错原样上抛
        if (e instanceof Error && e.message.startsWith('微博')) throw e;
        throw new Error(`微博昵称解析请求异常：${e instanceof Error ? e.message : String(e)}`);
      }
    },
    async resolveNick(uid: string): Promise<string | null> {
      try {
        if (!cached) cached = await fetchVisitorCookies();
        let result = await lookupNickOnce(uid, cached);
        if (result === 'expired') {
          log.info('微博访客 cookie 已失效，重建后重试一次');
          cached = null;
          cached = await fetchVisitorCookies();
          result = await lookupNickOnce(uid, cached);
          if (result === 'expired') throw new Error('微博访客 cookie 重建后仍失效，uid 解析失败');
        }
        return result;
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('微博')) throw e;
        throw new Error(`微博 uid 解析请求异常：${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}
