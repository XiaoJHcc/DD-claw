import { biliRequest, type BiliRequestFn } from './client.js';

export interface Following {
  uid: string;
  uname: string;
  face?: string;
}

const PAGE_SIZE = 50;

interface FollowingsPage {
  total?: number;
  list?: Array<{ mid?: number; uname?: string; face?: string }> | null;
}

/**
 * 分页拉全量关注列表（x/relation/followings，需 SESSDATA）。
 * 按返回的 total 翻页到底；短页（不足一页）视为到底，防止 total 不可靠时死循环。
 *
 * 【已实测 2026-08-03】604 关注、13 页连续翻页无需 WBI 签名，扫码登录的 cookie 即可。
 * 若中间页返回 code != 0（如 -352 风控），BiliApiError 直接抛给上层，
 * 由上层整轮放弃 —— 绝不用半截数据覆盖 follows 表。
 */
export async function fetchFollowings(
  cookie: string,
  mid: string,
  req: BiliRequestFn = biliRequest,
): Promise<Following[]> {
  const out: Following[] = [];
  for (let pn = 1; ; pn++) {
    const url = 'https://api.bilibili.com/x/relation/followings' +
      `?vmid=${mid}&pn=${pn}&ps=${PAGE_SIZE}&order=desc`;
    const data = await req<FollowingsPage>(url, { cookie });
    const list = Array.isArray(data?.list) ? data.list : [];
    for (const it of list) {
      if (it?.mid != null) out.push({ uid: String(it.mid), uname: it.uname ?? '', face: it.face ?? undefined });
    }
    const total = data?.total ?? 0;
    if (out.length >= total || list.length < PAGE_SIZE) break;
  }
  return out;
}
