/**
 * 微博用户搜索。
 *
 * 结论（2026-10-29 实测）：微博**全站搜索**（`m.weibo.cn/api/container/getIndex`、
 * `s.weibo.com/user`、`weibo.com/ajax/search/*`）一律 302 到登录页，且 `m.weibo.cn/n/<昵称>`
 * 在带过期登录 cookie 时同样被踢去登录——即「模糊搜账号」目前只能走**侧栏搜索建议**：
 * `weibo.com/ajax/side/search?q=<词>`，匿名可用，返回 `data.users[]`（昵称前缀匹配，
 * 一次最多几条；命中的是人气账号，长尾不一定有）。`data.user[]` 是同批账号的
 * `{uid, nick}` 简表，接口形态变动时作为兜底。
 *
 * 精确「昵称 → uid」不走这里，仍由 `weibo/resolve.ts` 的匿名 visitor 链负责（实测可用）；
 * 工具层会把两条结果合并，避免把「搜不到」误报成「没有这个人」。
 */
import type { FetchImpl } from './resolve.js';

export interface WeiboUserHit {
  uid: string;
  nickname: string;
  description: string;
  followers: number;
  verified: boolean;
  location: string | null;
  /** search = 搜索建议命中；nickname = 工具层补的精确昵称解析（仅当搜索空结果时出现） */
  via?: 'search' | 'nickname';
}

export const WEIBO_USER_SEARCH_LIMIT_MAX = 20;

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

interface RawWeiboUser {
  id?: number | string;
  idstr?: string;
  screen_name?: string;
  name?: string;
  description?: string;
  followers_count?: number;
  verified?: boolean;
  location?: string;
}

interface SideSearchData {
  users?: RawWeiboUser[] | null;
  user?: Array<{ uid?: number | string; nick?: string }> | null;
}

export interface WeiboUserSearchOptions {
  limit?: number;
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
}

function toHit(u: RawWeiboUser): WeiboUserHit | null {
  const uid = (u.idstr ?? (u.id === undefined ? '' : String(u.id))).trim();
  if (!uid) return null;
  return {
    uid,
    nickname: (u.screen_name ?? u.name ?? '').trim(),
    description: (u.description ?? '').trim(),
    followers: typeof u.followers_count === 'number' ? u.followers_count : 0,
    verified: u.verified === true,
    location: (u.location ?? '').trim() || null,
    via: 'search' as const,
  };
}

/** 昵称/关键词 → 微博用户候选（空数组 = 没搜到，不是错误） */
export async function searchWeiboUsers(
  keyword: string,
  opts: WeiboUserSearchOptions = {},
): Promise<WeiboUserHit[]> {
  const q = keyword.trim();
  if (!q) throw new Error('搜索词不能为空');
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 10), 1), WEIBO_USER_SEARCH_LIMIT_MAX);
  const doFetch: FetchImpl = opts.fetchImpl
    ?? ((url, init) => fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(15_000) }));

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
    throw new Error(`微博搜索请求失败：${e instanceof Error ? e.message : String(e)}`);
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
  const full = Array.isArray(data.users) ? data.users.map(toHit) : [];
  const thin = Array.isArray(data.user)
    ? data.user.map((u) => toHit({ id: u.uid, screen_name: u.nick }))
    : [];
  const seen = new Set<string>();
  const out: WeiboUserHit[] = [];
  for (const hit of [...full, ...thin]) {
    if (!hit || seen.has(hit.uid)) continue;
    seen.add(hit.uid);
    out.push(hit);
    if (out.length >= limit) break;
  }
  return out;
}
