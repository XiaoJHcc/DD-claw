/**
 * 免登录回退路线（Nitter 实例全挂时用）：
 *   ① `https://x.com/<screen>` 无 cookie 取 HTML → 抠 `rest_id` 得到**最新推文 id 列表**
 *   ② 对每个新 id 打 `cdn.syndication.twimg.com/tweet-result` 换正文 / 时间 / 图片
 *
 * 为什么这样分工：HTML 里的数据是 React Flight 载荷，id 与正文的配对关系不可靠；
 * 而单推接口给的是干净 JSON。于是 HTML 只用来「发现 id」，详情一律走单推接口。
 *
 * 能力差异（实测，别当 bug）：这条路线的 HTML **拿不到转发**（`retweeted_status_results` 恒 null），
 * 也拿不到引用标记；所以这里产出的推文 `isRetweet` 恒 false——用回退路线时「转发」筛选永不命中。
 * 需要转发就得让 Nitter 实例活着（RSS 是唯一能区分转发的免登录路线）。
 */
import { parseProxyUrl, tunnelFetch, describeTunnelError } from '../../core/proxy.js';
import { normalizeScreenName } from '../../core/x-accounts.js';
import type { ParsedTweet } from './nitter.js';

const TWEET_RESULT_HOST = 'cdn.syndication.twimg.com';

export interface WebIdsResult {
  ids: string[];
  bytes: number;
  ms: number;
}

/** 免登录 HTML → 推文 id 列表（降序）。返回空数组 = 页面结构变了或没有推文 */
export async function fetchWebTweetIds(
  screen: string,
  proxyUrl: string,
  opts: { timeoutMs?: number } = {},
): Promise<WebIdsResult> {
  const started = Date.now();
  const proxy = parseProxyUrl(proxyUrl);
  if (!proxy) throw new Error('未配置代理，无法访问 x.com');
  const user = normalizeScreenName(screen);
  let res;
  try {
    res = await tunnelFetch(`https://x.com/${encodeURIComponent(user)}`, proxy, {
      timeoutMs: opts.timeoutMs ?? 20_000,
      maxBytes: 8 * 1024 * 1024,
    });
  } catch (e) {
    throw new Error(`x.com 请求失败：${describeTunnelError(e)}`);
  }
  if (res.status !== 200) throw new Error(`x.com HTTP ${res.status}`);
  const ids = [...new Set([...res.text.matchAll(/rest_id:"(\d{15,25})"/g)].map((m) => m[1]!))]
    .sort((a, b) => (BigInt(b) > BigInt(a) ? 1 : -1));
  return { ids, bytes: res.body.length, ms: Date.now() - started };
}

export interface AccountVerify {
  checked: boolean;
  ok: boolean;
  /** ok=账号存在；not-found=账号不存在；link=链路原因，判不了 */
  kind: 'ok' | 'not-found' | 'link';
  message: string;
}

/**
 * 账号存在性校验（面板添加 X 账号时用）。
 *
 * 为什么必须把 `not-found` 与 `link` 分开：面板据此决定「拒绝添加」（敲错了）
 * 还是「照收但提示原因」（代理不通 / 被限流）——代理没开就加不了账号是很烦的体验。
 */
export async function verifyAccount(
  screenName: string,
  proxyUrl: string,
  opts: { timeoutMs?: number } = {},
): Promise<AccountVerify> {
  const user = normalizeScreenName(screenName);
  let res;
  try {
    res = await fetchWebTweetIds(user, proxyUrl, opts);
  } catch (e) {
    return { checked: true, ok: false, kind: 'link', message: e instanceof Error ? e.message : String(e) };
  }
  if (res.ids.length > 0) {
    return { checked: true, ok: true, kind: 'ok', message: `账号存在（页面含 ${res.ids.length} 条推文）` };
  }
  // 免登录 HTML 的 id 列表为空：用页面文案区分「账号不存在」与「页面结构变了」
  const proxy = parseProxyUrl(proxyUrl);
  if (!proxy) return { checked: true, ok: false, kind: 'link', message: '未配置代理' };
  try {
    const page = await tunnelFetch(`https://x.com/${encodeURIComponent(user)}`, proxy, {
      timeoutMs: opts.timeoutMs ?? 15_000,
      maxBytes: 4 * 1024 * 1024,
    });
    if (page.status === 404) return { checked: true, ok: false, kind: 'not-found', message: `x.com 返回 404` };
    if (/doesn'?t exist|account doesn'?t exist|このアカウントは存在しません|不存在/i.test(page.text)) {
      return { checked: true, ok: false, kind: 'not-found', message: 'x.com 提示该账号不存在' };
    }
    return {
      checked: true,
      ok: false,
      kind: 'link',
      message: `页面没抓到推文（HTTP ${page.status}）——可能是空账号，也可能是页面结构已变`,
    };
  } catch (e) {
    return { checked: true, ok: false, kind: 'link', message: describeTunnelError(e) };
  }
}

interface SyndicationPhoto {
  url?: string;
}
interface SyndicationMedia {
  type?: string;
  media_url_https?: string;
}
interface SyndicationUser {
  screen_name?: string;
  name?: string;
}
interface SyndicationTweet {
  id_str?: string;
  created_at?: string;
  text?: string;
  lang?: string;
  possibly_sensitive?: boolean;
  user?: SyndicationUser;
  mediaDetails?: SyndicationMedia[];
  photos?: SyndicationPhoto[];
  note_tweet?: { note_tweet_results?: { result?: { text?: string } } };
}

/**
 * 单推详情。`token` 只需存在且非空（实测任意值即可，缺失时接口回 200 + `{}`）；
 * 返回 `{}` 说明推文不可见/已删除，必须当失败——空对象不是「没有内容」。
 */
export async function fetchTweetDetail(
  id: string,
  proxyUrl: string,
  opts: { timeoutMs?: number } = {},
): Promise<ParsedTweet> {
  const proxy = parseProxyUrl(proxyUrl);
  if (!proxy) throw new Error('未配置代理，无法访问 x.com');
  let res;
  try {
    res = await tunnelFetch(`https://${TWEET_RESULT_HOST}/tweet-result?id=${id}&lang=ja&token=dd-claw`, proxy, {
      timeoutMs: opts.timeoutMs ?? 15_000,
      maxBytes: 2 * 1024 * 1024,
    });
  } catch (e) {
    throw new Error(`单推接口请求失败：${describeTunnelError(e)}`);
  }
  if (res.status !== 200) throw new Error(`单推接口 HTTP ${res.status}`);
  let j: SyndicationTweet;
  try {
    j = JSON.parse(res.text) as SyndicationTweet;
  } catch {
    throw new Error('单推接口返回的不是 JSON');
  }
  if (!j.id_str) throw new Error(`推文 ${id} 不可见或已删除（接口返回空对象）`);

  const author = normalizeScreenName(j.user?.screen_name ?? '');
  const pics: string[] = [];
  for (const m of j.mediaDetails ?? []) {
    if (m.media_url_https && !pics.includes(m.media_url_https)) pics.push(m.media_url_https);
  }
  if (pics.length === 0) {
    for (const p of j.photos ?? []) {
      if (p.url && !pics.includes(p.url)) pics.push(p.url);
    }
  }
  const parsed = Date.parse(j.created_at ?? '');
  const longText = j.note_tweet?.note_tweet_results?.result?.text;
  return {
    id: j.id_str,
    author: author || normalizeScreenName(j.user?.name ?? ''),
    isRetweet: false, // 这条路线看不到转发（见文件头的能力差异说明）
    retweetedBy: null,
    text: (longText || j.text || '').trim() || null,
    pics,
    pubTs: Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000),
    url: `https://x.com/${author || 'i'}/status/${j.id_str}`,
  };
}

/**
 * 回退路线的完整时间线：先拿 id 列表，再只对**新于游标**的 id 取详情。
 * `sinceId` 为 null（该账号首次抓取）时只取最近 `maxDetails` 条——冷启动不做全量详情，
 * 归档够用即可，避免一次打十几个单推请求。
 */
export async function fetchWebTimeline(
  screen: string,
  proxyUrl: string,
  opts: { sinceId?: string | null; maxDetails?: number; timeoutMs?: number } = {},
): Promise<{ tweets: ParsedTweet[]; bytes: number; ms: number }> {
  const started = Date.now();
  const listed = await fetchWebTweetIds(screen, proxyUrl, opts);
  const since = opts.sinceId && /^\d+$/.test(opts.sinceId) ? BigInt(opts.sinceId) : null;
  const fresh = since ? listed.ids.filter((id) => BigInt(id) > since) : listed.ids;
  const cap = Math.max(1, opts.maxDetails ?? 10);
  const targets = fresh.slice(0, cap);
  const tweets: ParsedTweet[] = [];
  const failures: string[] = [];
  for (const id of targets) {
    try {
      tweets.push(await fetchTweetDetail(id, proxyUrl, opts));
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
    }
  }
  // 一条都没取到且有失败 → 抛错让 feed 记一次失败；部分失败只少几条，不算整体失败
  if (tweets.length === 0 && failures.length > 0) {
    throw new Error(`单推详情全部失败：${failures.join('；')}`);
  }
  return { tweets: tweets.sort((a, b) => b.pubTs - a.pubTs), bytes: listed.bytes, ms: Date.now() - started };
}