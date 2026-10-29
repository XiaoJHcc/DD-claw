/**
 * X 账号发现（没有「X 站内搜索」可用之后的替代路线）。
 *
 * 事实（2026-10-29 实测）：X 不提供免登录的账号搜索——v1.1 `users/search` 已下线（404）、
 * `search/typeahead` 同样 404；Nitter 搜索在用户配置的实例上返回
 * 「Search has been disabled due to abuse」，nitter.net 已下线、官方仓库 2026-10-09 归档；
 * `site:x.com` / `site:twitter.com` 在 DeepSeek 搜索里恒为 0 条（X 页面不进索引）。
 *
 * 所以路线是「网页检索挖 `x.com/<handle>` 线索 → 逐候选让 x.com 校验存在性」：
 * ① 检索 `<名字> twitter`（必要时再补 `<名字> x.com`），从 url / 标题 / 摘要里抠 handle；
 * ② 候选按出现次数排序，只校验前几个（`verify` 由装配层注入，走既有 X 代理链路）；
 * ③ 校验说不存在的直接丢弃——网页里常混着旧号/错号，这一步是唯一的假阳性防线。
 *
 * 局限（要如实告诉模型/用户）：候选来自第三方页面，可能同名、可能是粉丝号；校验只能证明
 * 「这个 handle 存在」，证明不了「这是要找的人」。所以结果必须带出处片段让人/模型自己判断。
 */
import type { WebSearchResult } from '../../search/web.js';

export interface XAccountCandidate {
  screenName: string;
  url: string;
  /** 校验抠到的显示名；未校验/抠不到为 null */
  name: string | null;
  /** true 存在 / false 不存在（会被丢弃）/ null 未校验或链路不通 */
  exists: boolean | null;
  /** 命中出处（标题 + 链接 + 含 handle 的片段），供模型判断是不是同一个人 */
  sources: Array<{ title: string; url: string; quote: string }>;
}

export interface XVerifyResult {
  checked: boolean;
  ok: boolean;
  kind: 'ok' | 'not-found' | 'link' | string;
  name?: string | null;
  message: string;
}

export interface XAccountSearchOptions {
  search: (query: string) => Promise<WebSearchResult[]>;
  /** x.com 存在性校验（装配层注入 verifyAccount）；不注入 = 只给未校验线索 */
  verify?: (screenName: string) => Promise<XVerifyResult>;
  limit?: number;
  /** 最多校验几个候选（缺省 4：一次搜索不打太多 x.com 请求） */
  verifyLimit?: number;
}

export const X_ACCOUNT_SEARCH_LIMIT_MAX = 10;
export const X_VERIFY_LIMIT_DEFAULT = 4;

/** 不是账号的 x.com 保留路径（intent/share/i 之类会混进正文链接里） */
const RESERVED = new Set([
  'i', 'home', 'explore', 'search', 'hashtag', 'intent', 'share', 'login', 'logout', 'signup',
  'tos', 'privacy', 'settings', 'messages', 'notifications', 'compose', 'account', 'about',
  'download', 'jobs', 'help', 'status', 'lists', 'communities', 'premium', 'verified',
  'following', 'followers', 'photo', 'video', 'pic', 'en', 'ja', 'zh', 'rules', 'connect',
]);

/** `x.com/<handle>` / `twitter.com/<handle>`；只认后接 `/ ? #` 或空白/引号/句末的形态。
 *  前置负向断言排除 `pic.twitter.com/<id>` 这类图片 CDN（域名前是点，不是协议/空白）。 */
const URL_RE = /(?<![A-Za-z0-9_.-])(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?=[/?#\s"'）)\]<>，。、]|$)/gi;
/** 正文里的 `@handle` 提及（排除邮箱：左侧紧邻字母数字/@ 的不算） */
const MENTION_RE = /(?:^|[^A-Za-z0-9_@])@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/g;

/** 一段文本里的 X handle（小写、去重、剔除保留路径） */
export function extractXHandles(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(URL_RE)) {
    const h = m[1]!.toLowerCase();
    if (!RESERVED.has(h)) out.add(h);
  }
  for (const m of text.matchAll(MENTION_RE)) {
    const h = m[1]!.toLowerCase();
    if (!RESERVED.has(h)) out.add(h);
  }
  return [...out];
}

/** 取命中位置附近的原文片段（折叠空白、限长），用作候选的出处证据 */
function quoteAround(text: string, handle: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  const at = lower.indexOf(handle);
  if (at < 0) return flat.slice(0, max);
  const start = Math.max(0, at - 60);
  const end = Math.min(flat.length, at + handle.length + 60);
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}

interface Bucket {
  screenName: string;
  hits: number;
  sources: Array<{ title: string; url: string; quote: string }>;
}

function collect(results: WebSearchResult[]): Map<string, Bucket> {
  const map = new Map<string, Bucket>();
  for (const r of results) {
    const fields = [r.url, r.title, r.snippet, r.summary].filter(Boolean);
    const handles = new Set<string>();
    for (const f of fields) for (const h of extractXHandles(f)) handles.add(h);
    for (const h of handles) {
      let b = map.get(h);
      if (!b) {
        b = { screenName: h, hits: 0, sources: [] };
        map.set(h, b);
      }
      b.hits += 1;
      if (b.sources.length < 3) {
        b.sources.push({ title: r.title, url: r.url, quote: quoteAround(`${r.title} ${r.snippet} ${r.summary}`, h) });
      }
    }
  }
  return map;
}

function merge(a: Map<string, Bucket>, b: Map<string, Bucket>): Map<string, Bucket> {
  for (const [k, v] of b) {
    const cur = a.get(k);
    if (!cur) {
      a.set(k, v);
      continue;
    }
    cur.hits += v.hits;
    for (const s of v.sources) {
      if (cur.sources.length >= 3) break;
      if (!cur.sources.some((x) => x.url === s.url)) cur.sources.push(s);
    }
  }
  return a;
}

function ranked(map: Map<string, Bucket>): Bucket[] {
  return [...map.values()].sort((x, y) => y.hits - x.hits || x.screenName.localeCompare(y.screenName));
}

/**
 * 名字/检索式 → X 账号候选。返回空数组 = 没挖到线索（不是错误）。
 * 抛错只在检索本身失败时（key 缺失/网络/限流），由工具层原样回给调用方。
 */
export async function searchXAccounts(
  query: string,
  opts: XAccountSearchOptions,
): Promise<XAccountCandidate[]> {
  const q = query.trim();
  if (!q) throw new Error('搜索词不能为空');
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 5), 1), X_ACCOUNT_SEARCH_LIMIT_MAX);

  const primary = await opts.search(`${q} twitter`);
  let buckets = collect(primary);
  if (buckets.size < 2) {
    const secondary = await opts.search(`${q} x.com`);
    buckets = merge(buckets, collect(secondary));
  }
  const ordered = ranked(buckets);
  if (ordered.length === 0) return [];

  const verifyLimit = Math.min(
    ordered.length,
    Math.max(0, Math.trunc(opts.verifyLimit ?? X_VERIFY_LIMIT_DEFAULT)),
    limit + 2,
  );
  const verify = opts.verify;
  const verdicts = new Map<string, { name: string | null; exists: boolean | null }>();
  if (verify && verifyLimit > 0) {
    const targets = ordered.slice(0, verifyLimit).map((b) => b.screenName);
    const results = await Promise.all(
      targets.map(async (screenName) => {
        try {
          return [screenName, await verify(screenName)] as const;
        } catch (e) {
          return [screenName, {
            checked: false, ok: false, kind: 'link',
            message: e instanceof Error ? e.message : String(e),
          }] as const;
        }
      }),
    );
    for (const [screenName, v] of results) {
      verdicts.set(screenName, {
        exists: v.kind === 'ok' ? true : v.kind === 'not-found' ? false : null,
        name: v.kind === 'ok' ? (v.name ?? null) : null,
      });
    }
  }

  const out: XAccountCandidate[] = [];
  for (const b of ordered) {
    const v = verdicts.get(b.screenName);
    if (v && v.exists === false) continue; // 校验说不存在：不把错号交给模型
    out.push({
      screenName: b.screenName,
      url: `https://x.com/${b.screenName}`,
      name: v?.name ?? null,
      exists: v?.exists ?? null,
      sources: b.sources,
    });
    if (out.length >= limit) break;
  }
  // 已确认真实存在的排前面（其余保持检索命中序）
  return out.sort((x, y) => Number(y.exists === true) - Number(x.exists === true));
}
