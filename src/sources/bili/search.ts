/**
 * B站用户搜索（`x/web-interface/wbi/search/type`，search_type=bili_user）。
 *
 * 为什么要单独一条：`search_streamers` 只搜本地监听名单/关注池，回答不了「这个人是哪个 uid」；
 * 而添加监听/动态账号的入口都要真 uid。B站这个接口免登录可用（2026-10-29 实测连打 3 次 200），
 * 但**必须带 `Referer: https://search.bilibili.com/`**，且只能用 wbi 前缀的路径：
 * 非 wbi 的 `/x/web-interface/search/type` 直接 412（风控）。
 *
 * 没做 wbi 签名：实测未签名也能拿到 200（B站按端点灰度，签名不是每次都校验）。若哪天开始
 * 稳定 -352/412，就在这里补 img_key/sub_key 与 mixin 表；错误文案已把风控单独点出来。
 */
import { BiliApiError, biliRequest, type RequestOptions } from './client.js';

export interface BiliUserHit {
  uid: string;
  uname: string;
  /** 个性签名（模型据此判断是不是同一个人） */
  sign: string;
  fans: number;
  level: number;
  /** 认证说明（`official_verify.desc`）；无认证为 null */
  official: string | null;
  live: boolean;
  roomId: string | null;
  avatar: string | null;
}

export const BILI_USER_SEARCH_LIMIT_MAX = 20;

interface RawBiliUser {
  mid?: number | string;
  uname?: string;
  usign?: string;
  fans?: number;
  level?: number;
  official_verify?: { type?: number; desc?: string };
  is_live?: number;
  room_id?: number | string;
  upic?: string;
}

interface SearchData {
  result?: RawBiliUser[] | null;
}

export interface BiliUserSearchOptions {
  limit?: number;
  /** 注入点：单测用假请求（biliRequest 是泛型，这里收窄成搜索响应的形状） */
  request?: (url: string, opts?: RequestOptions) => Promise<SearchData>;
}

/** 用户名关键词 → B站用户候选（空数组 = 没搜到，不是错误） */
export async function searchBiliUsers(
  keyword: string,
  opts: BiliUserSearchOptions = {},
): Promise<BiliUserHit[]> {
  const q = keyword.trim();
  if (!q) throw new Error('搜索词不能为空');
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 10), 1), BILI_USER_SEARCH_LIMIT_MAX);
  const request = opts.request ?? biliRequest;
  const url = 'https://api.bilibili.com/x/web-interface/wbi/search/type'
    + `?search_type=bili_user&keyword=${encodeURIComponent(q)}&page=1`;

  let data: SearchData;
  try {
    data = await request(url, { referer: 'https://search.bilibili.com/' });
  } catch (e) {
    if (e instanceof BiliApiError && (e.code === -352 || e.code === -412 || e.code === -403)) {
      throw new Error(`B站搜索被风控（${e.code}），稍后再试`);
    }
    throw new Error(`B站搜索失败：${e instanceof Error ? e.message : String(e)}`);
  }

  const rows = Array.isArray(data?.result) ? data.result : [];
  return rows
    .map((r): BiliUserHit | null => {
      const uid = r.mid === undefined ? '' : String(r.mid);
      if (!uid) return null;
      return {
        uid,
        uname: (r.uname ?? '').trim(),
        sign: (r.usign ?? '').trim(),
        fans: typeof r.fans === 'number' ? r.fans : 0,
        level: typeof r.level === 'number' ? r.level : 0,
        official: (r.official_verify?.desc ?? '').trim() || null,
        live: r.is_live === 1,
        roomId: r.room_id === undefined || Number(r.room_id) <= 0 ? null : String(r.room_id),
        avatar: (r.upic ?? '').trim() || null,
      };
    })
    .filter((r): r is BiliUserHit => r !== null)
    .slice(0, limit);
}
