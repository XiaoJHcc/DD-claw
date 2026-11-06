/**
 * 微博用户搜索。
 *
 * 两条路线，由 `mode` 选择：
 * - `suggest`（输入框联想）：有登录 cookie 时先走 m.weibo.cn 全站用户搜索
 *   `getIndex?containerid=100103type=3&q=<词>`，失败或空结果回落匿名侧栏建议；
 *   不跑昂贵的精确昵称解析。没 cookie 时只走匿名侧栏建议。
 * - `discover`（默认）：有 cookie 时全站用户搜索 → 匿名侧栏建议 → 调用方给的 `resolveUid`
 *   精确昵称解析；没 cookie 时只走匿名侧栏建议（精确解析由调用方在工具层补位）。
 *
 * 匿名侧栏建议 `weibo.com/ajax/side/search?q=<词>`（桌面 UA + Referer）是昵称前缀补全，
 * 一次最多几条，覆盖人气账号，长尾不一定有；全站搜索才覆盖未认证长尾账号。
 *
 * 空结果只表示「这条链路没找到」，不表示账号不存在：discover 会把三级依次走完。
 * 网络/解析错误在级内降级（登录搜索失败→匿名建议），但匿名建议也没有结果时抛错，
 * 不把网络错误伪装成空结果；昵称解析抛错同样上抛。
 * cookie 只经 options 注入，不读文件、不写日志、不进错误文本。
 */
import type { FetchImpl } from './resolve.js';

export type SearchMode = 'discover' | 'suggest';

/** search = 匿名建议命中；full-search = 登录态全站搜索命中；nickname = 精确昵称解析补位 */
export type WeiboUserHitVia = 'search' | 'full-search' | 'nickname';

export interface WeiboUserHit {
  uid: string;
  nickname: string;
  description: string;
  followers: number;
  verified: boolean;
  location: string | null;
  via?: WeiboUserHitVia;
}

export const WEIBO_USER_SEARCH_LIMIT_MAX = 20;

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

interface RawWeiboUser {
  id?: number | string;
  idstr?: string;
  screen_name?: string;
  name?: string;
  description?: string;
  /** 侧栏建议是数字，m.weibo.cn 全站搜索给的是字符串（如 "2025"） */
  followers_count?: number | string;
  verified?: boolean;
  location?: string;
}

interface SideSearchData {
  users?: RawWeiboUser[] | null;
  user?: Array<{ uid?: number | string; nick?: string }> | null;
}

interface FullSearchCard {
  user?: RawWeiboUser | null;
  card_group?: FullSearchCard[] | null;
  cards?: FullSearchCard[] | null;
}

interface FullSearchData {
  cards?: FullSearchCard[] | null;
}

export interface WeiboUserSearchOptions {
  limit?: number;
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
  /**
   * discover（默认）：有 cookie 时先登录全站搜索，空结果回落匿名建议与精确解析；
   * suggest：有 cookie 时先登录全站搜索，失败或空结果回落匿名建议，不跑精确解析。
   * 两者没 cookie 时都只走匿名侧栏建议。
   */
  mode?: SearchMode;
  /** 微博登录 cookie，由调用方注入；不读文件、不写日志 */
  cookie?: string;
  /** 精确昵称 → uid；仅在 discover + cookie 且登录搜索与匿名建议都为空时调用 */
  resolveUid?: (nick: string) => Promise<string | null>;
}

function clampLimit(value: number | undefined): number {
  return Math.min(Math.max(Math.trunc(value ?? 10), 1), WEIBO_USER_SEARCH_LIMIT_MAX);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function countOf(v: number | string | undefined): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toHit(u: RawWeiboUser, via: WeiboUserHitVia): WeiboUserHit | null {
  const uid = (u.idstr ?? (u.id === undefined ? '' : String(u.id))).trim();
  if (!uid) return null;
  return {
    uid,
    nickname: (u.screen_name ?? u.name ?? '').trim(),
    description: (u.description ?? '').trim(),
    followers: countOf(u.followers_count),
    verified: u.verified === true,
    location: (u.location ?? '').trim() || null,
    via,
  };
}

function dedupeHits(raws: RawWeiboUser[], via: WeiboUserHitVia, limit: number): WeiboUserHit[] {
  const seen = new Set<string>();
  const out: WeiboUserHit[] = [];
  for (const raw of raws) {
    const hit = toHit(raw, via);
    if (!hit || seen.has(hit.uid)) continue;
    seen.add(hit.uid);
    out.push(hit);
    if (out.length >= limit) break;
  }
  return out;
}

/** 匿名侧栏建议：始终不带登录 cookie */
async function searchSide(
  q: string,
  limit: number,
  doFetch: FetchImpl,
): Promise<WeiboUserHit[]> {
  let res: Response;
  try {
    res = await doFetch(
      `https://weibo.com/ajax/side/search?q=${encodeURIComponent(q)}`,
      {
        headers: {
          'user-agent': DESKTOP_UA,
          referer: 'https://weibo.com/',
          accept: 'application/json',
        },
        redirect: 'manual',
      },
    );
  } catch (e) {
    throw new Error(`微博搜索请求失败：${errText(e)}`);
  }
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`微博搜索被跳转（HTTP ${res.status}），可能需要登录态或已被风控`);
  }
  if (res.status === 403) throw new Error('微博搜索被拒绝（HTTP 403），可能已被风控');
  if (!res.ok) throw new Error(`微博搜索失败（HTTP ${res.status}）`);

  let json: { data?: SideSearchData };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    throw new Error('微博搜索响应不是合法 JSON');
  }
  const data = json.data ?? {};
  const full = Array.isArray(data.users) ? data.users : [];
  const thin = Array.isArray(data.user)
    ? data.user.map((u) => ({ id: u.uid, screen_name: u.nick }))
    : [];
  return dedupeHits([...full, ...thin], 'search', limit);
}

/** 递归收集卡片里的用户对象；用户搜索的 cards 可能是 card_group 嵌套结构 */
function collectCardUsers(node: FullSearchCard | FullSearchCard[] | null | undefined, out: RawWeiboUser[], depth = 0): void {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) {
    for (const item of node) collectCardUsers(item, out, depth + 1);
    return;
  }
  if (node.user && typeof node.user === 'object') out.push(node.user);
  collectCardUsers(node.card_group, out, depth + 1);
  collectCardUsers(node.cards, out, depth + 1);
}

/**
 * 登录态全站用户搜索。cookie 由调用方注入；任何网络/登录/解析失败都抛错，
 * 由调用方决定降级，不能返回空数组冒充「没搜到」。
 */
async function searchFull(
  q: string,
  limit: number,
  cookie: string,
  doFetch: FetchImpl,
): Promise<WeiboUserHit[]> {
  const containerId = `100103type=3&q=${q}`;
  const url =
    'https://m.weibo.cn/api/container/getIndex?containerid=' +
    encodeURIComponent(containerId) +
    '&page_type=searchall';

  let res: Response;
  try {
    res = await doFetch(url, {
      headers: {
        'user-agent': MOBILE_UA,
        referer: 'https://m.weibo.cn/',
        accept: 'application/json',
        cookie,
      },
      redirect: 'manual',
    });
  } catch (e) {
    throw new Error(`微博完整搜索请求失败：${errText(e)}`);
  }
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`微博完整搜索被跳转（HTTP ${res.status}），登录态可能失效或已被风控`);
  }
  if (res.status === 403) throw new Error('微博完整搜索被拒绝（HTTP 403），可能已被风控');
  if (!res.ok) throw new Error(`微博完整搜索失败（HTTP ${res.status}）`);

  let json: { ok?: number; data?: FullSearchData };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    throw new Error('微博完整搜索响应不是合法 JSON');
  }
  if (typeof json.ok === 'number' && json.ok !== 1) {
    throw new Error(`微博完整搜索返回失败（ok=${json.ok}），登录态可能失效`);
  }
  if (!json.data) throw new Error('微博完整搜索响应缺少 data 字段');

  const raws: RawWeiboUser[] = [];
  collectCardUsers(json.data.cards, raws);
  return dedupeHits(raws, 'full-search', limit);
}

/**
 * 昵称/关键词 → 微博用户候选（空数组 = 链路都没找到，不是错误）。
 *
 * 有 cookie：登录全站搜索 → 匿名侧栏建议；discover 再补精确昵称解析，suggest 到此为止。
 * 登录搜索出错也降级匿名建议；匿名建议失败或降级后仍无结果时抛错。
 * 无 cookie：suggest 与 discover 都只走匿名侧栏建议（保持原有行为）。
 */
export async function searchWeiboUsers(
  keyword: string,
  opts: WeiboUserSearchOptions = {},
): Promise<WeiboUserHit[]> {
  const q = keyword.trim();
  if (!q) throw new Error('搜索词不能为空');
  const limit = clampLimit(opts.limit);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const doFetch: FetchImpl = opts.fetchImpl
    ?? ((url, init) => fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) }));

  const mode: SearchMode = opts.mode ?? 'discover';
  const cookie = opts.cookie?.trim();

  if (!cookie) {
    return searchSide(q, limit, doFetch);
  }

  let fullHits: WeiboUserHit[] | null = null;
  let fullError: Error | null = null;
  try {
    fullHits = await searchFull(q, limit, cookie, doFetch);
  } catch (e) {
    fullError = new Error(errText(e));
  }
  if (fullHits && fullHits.length > 0) return fullHits;

  let sideHits: WeiboUserHit[];
  try {
    sideHits = await searchSide(q, limit, doFetch);
  } catch (e) {
    if (fullError) {
      throw new Error(
        `微博用户发现失败：登录搜索不可用（${fullError.message}），` +
          `匿名建议失败（${errText(e)}）`,
      );
    }
    throw e;
  }
  if (sideHits.length > 0) return sideHits;

  // suggest 是联想语义：匿名建议已为空就到此为止，不替用户跑昂贵的精确昵称解析
  if (mode === 'suggest') {
    if (fullError) {
      throw new Error(
        `微博候选建议失败：登录搜索不可用（${fullError.message}），匿名建议无结果`,
      );
    }
    return [];
  }

  if (opts.resolveUid) {
    let uid: string | null;
    try {
      uid = await opts.resolveUid(q);
    } catch (e) {
      throw new Error(`微博精确昵称解析失败：${errText(e)}`);
    }
    if (uid) {
      return [{
        uid,
        nickname: q,
        description: '',
        followers: 0,
        verified: false,
        location: null,
        via: 'nickname',
      }];
    }
  }

  if (fullError) {
    throw new Error(
      `微博用户发现失败：登录搜索不可用（${fullError.message}），` +
        '匿名建议与精确解析均无结果',
    );
  }
  return [];
}
