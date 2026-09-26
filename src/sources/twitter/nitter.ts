/**
 * Nitter 实例 RSS —— X 免登录路线的主数据源。
 *
 * 字段形态（2026-09-16 实测，见 docs/research/twitter.md §2/§3）：
 *  · `<guid isPermaLink="false">` = 推文 id；**转发时是原作者那条推文的 id**
 *  · `<dc:creator>` = `@原作者`；转发时**不是**被轮询的账号
 *  · `<title>` = 完整正文（转发带 `RT by @xxx: ` 前缀，URL 是展开的完整形态）
 *  · `<description>` CDATA HTML：有换行（`<br>`）但外链是截断显示
 *    → 正文取 `title`（URL 完整），原文 HTML 交给 feed 存进 `raw`，两边都不丢
 *  · `<pubDate>` RFC822；`<link>` = `http://<实例>/<作者>/status/<id>#m`
 *  · 图片 = **实例代理 URL**（`http://<实例>/pic/media%2FXXX.jpg`）
 *    → 还原成 `https://pbs.twimg.com/media/XXX.jpg` 存库：实例随时会死，CDN 形态才是长期可用的
 *
 * 已知短板（实现时别当 bug）：RSS 不标引用推文（`is_quote_status` 只在免登录 HTML/单推接口里有），
 * 也拿不到转发自身的 id（RSS 给的是原推 id）——"同一推文被多次转发"因此折叠成一条。
 */
import { parseProxyUrl, tunnelFetch, describeTunnelError } from '../../core/proxy.js';
import { normalizeScreenName } from '../../core/x-accounts.js';

export interface ParsedTweet {
  /** 推文 id（转发时=原作者推文 id） */
  id: string;
  /** 原作者 screen name（不含 @）；转发时是别人 */
  author: string;
  isRetweet: boolean;
  /** 转发者（被轮询的账号）；原创为 null */
  retweetedBy: string | null;
  text: string | null;
  /** 图片直链（已还原为 pbs.twimg.com 形态） */
  pics: string[];
  pubTs: number;
  /** 规范链接（指向 x.com 原文） */
  url: string;
  /**
   * 是否引用推文。**RSS 给不了**（Nitter 的 RSS 不标引用）→ undefined = 未知；
   * 免登录回退路线的单推接口能给出 true/false。规则里的 quote 筛选据此判定。
   */
  isQuote?: boolean;
}

/** 常见 HTML 实体 + 数字实体（RSS 正文里 `&#39;` `&amp;` 很常见） */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * 实例代理图片 URL → 原图 CDN URL。
 * 两种实测形态（2026-09-17 真机核对）：
 *  · `/pic/media%2FHSU.jpg`（正文图，路径形态）→ `https://pbs.twimg.com/media/HSU.jpg`
 *  · `/pic/https%3A%2F%2Fpbs.twimg.com%2Fprofile_images%2F…`（频道头像，完整 URL 编码形态）→ 解出即直链
 * 无法识别（相对路径、非 /pic/ 前缀、完整 URL 但不是 pbs.twimg.com）返回 null，
 * 由调用方丢弃——宁可不带图，也不存一个会随实例消失或来路不明的链接。
 */
export function instancePicToCdn(src: string): string | null {
  const m = src.match(/\/pic\/([^"'\s]+)$/);
  if (!m) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
  if (!decoded || decoded.includes('..')) return null;
  // 完整 URL 形态：只信 pbs.twimg.com（统一成 https），其他 host 丢弃
  const full = decoded.match(/^https?:\/\/pbs\.twimg\.com\/(.+)$/);
  if (full) return `https://pbs.twimg.com/${full[1]}`;
  if (/^https?:\/\//.test(decoded)) return null;
  return `https://pbs.twimg.com/${decoded.replace(/^\/+/, '')}`;
}

function tag(item: string, name: string): string | null {
  const m = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? m[1]! : null;
}

/** 单个 `<item>` → ParsedTweet；缺 id / 缺标题时间都返回 null（跳过而不是产出半条数据） */
export function parseNitterItem(item: string): ParsedTweet | null {
  const guid = (tag(item, 'guid') ?? '').trim();
  const id = /^\d{10,25}$/.test(guid) ? guid : (tag(item, 'link')?.match(/\/status\/(\d{10,25})/) ?? [])[1];
  if (!id) return null;

  const rawTitle = decodeEntities(tag(item, 'title') ?? '').trim();
  const rt = rawTitle.match(/^RT by @([A-Za-z0-9_]+):\s*/);
  const isRetweet = Boolean(rt);
  const retweetedBy = rt ? normalizeScreenName(rt[1]!) : null;
  let text = isRetweet ? rawTitle.slice(rt![0].length).trim() : rawTitle;

  const creator = decodeEntities(tag(item, 'dc:creator') ?? '').replace(/^@+/, '').trim();
  const linkAuthor = (tag(item, 'link')?.match(/\/([A-Za-z0-9_]+)\/status\//) ?? [])[1] ?? '';
  const author = normalizeScreenName(creator || linkAuthor);
  if (!author) return null;

  const desc = tag(item, 'description') ?? '';
  const pics: string[] = [];
  for (const m of desc.matchAll(/<img[^>]+src="([^"]+)"/g)) {
    const cdn = instancePicToCdn(decodeEntities(m[1]!));
    if (cdn && !pics.includes(cdn)) pics.push(cdn);
  }

  const parsedDate = Date.parse(tag(item, 'pubDate') ?? '');
  const pubTs = Number.isNaN(parsedDate) ? 0 : Math.floor(parsedDate / 1000);

  // 纯图推文的 title 就是空的（或只剩 RT 前缀），存 null 而不是空串
  if (!text) text = '';

  return {
    id,
    author,
    isRetweet,
    retweetedBy,
    text: text || null,
    pics,
    pubTs,
    url: `https://x.com/${author}/status/${id}`,
  };
}

/** 整份 RSS → 推文数组（按 pubTs 倒序，供增量判断与展示一致） */
export function parseNitterRss(xml: string): ParsedTweet[] {
  const out: ParsedTweet[] = [];
  const seen = new Set<string>();
  for (const chunk of xml.split('<item>').slice(1)) {
    const item = chunk.split('</item>')[0] ?? chunk;
    const t = parseNitterItem(item);
    if (t && !seen.has(t.id)) {
      seen.add(t.id);
      out.push(t);
    }
  }
  return out.sort((a, b) => b.pubTs - a.pubTs);
}

/**
 * 频道头 `<image><url>` → 账号头像 CDN URL。
 * 实测形态是完整 URL 编码（`/pic/https%3A%2F%2Fpbs.twimg.com%2Fprofile_images%2F…`），
 * 与正文图的路径形态不同——都交给 instancePicToCdn 还原；
 * 拿不到（实例没给 / 结构变了）返回 null，调用方按「无头像」处理。
 */
export function parseNitterAvatar(xml: string): string | null {
  const channel = xml.split('<item>')[0] ?? '';
  const m = channel.match(/<image>[\s\S]*?<url>([\s\S]*?)<\/url>[\s\S]*?<\/image>/);
  if (!m) return null;
  return instancePicToCdn(decodeEntities(m[1]!.trim()));
}

/**
 * 频道头 `<title>` → 账号显示名。实测形态（2026-09 真机核对）：`渡瀬 結月 / @Watase_Yuzuki`。
 * 贪婪剥掉尾部的 ` / @handle`（显示名本身可能含 `/`，取最后一个 `/@`）。
 * 形态对不上（实例只给 `@handle`、结构变了）返回 null——昵称缺失不影响抓取主流程。
 */
export function parseNitterAuthorName(xml: string): string | null {
  const channel = xml.split('<item>')[0] ?? '';
  const m = channel.match(/<title>([\s\S]*?)<\/title>/);
  if (!m) return null;
  const raw = decodeEntities(m[1]!).trim();
  const mm = raw.match(/^(.*)\s*\/\s*@[A-Za-z0-9_]+\s*$/);
  const name = (mm ? mm[1]! : '').trim();
  return name || null;
}

export interface NitterFetchResult {
  host: string;
  tweets: ParsedTweet[];
  /** 频道头抠出的账号头像（pbs.twimg.com 形态）；实例没给为 null */
  avatarCdn: string | null;
  /** 频道头 `<title>` 抠出的账号显示名；实例没给或形态对不上为 null */
  authorName?: string | null;
  bytes: number;
  ms: number;
}

/** 拉某个实例的 `/<screen>/rss`；非 200 或不是 RSS 都算失败（抛可读错误） */
export async function fetchNitterTimeline(
  host: string,
  screen: string,
  proxyUrl: string,
  opts: { timeoutMs?: number } = {},
): Promise<NitterFetchResult> {
  const started = Date.now();
  const proxy = parseProxyUrl(proxyUrl);
  if (!proxy) throw new Error('未配置代理，无法访问 Nitter 实例');
  const user = normalizeScreenName(screen);
  let res;
  try {
    res = await tunnelFetch(`https://${host}/${encodeURIComponent(user)}/rss`, proxy, {
      timeoutMs: opts.timeoutMs ?? 20_000,
      maxBytes: 4 * 1024 * 1024,
    });
  } catch (e) {
    throw new Error(`${host} 请求失败：${describeTunnelError(e)}`);
  }
  if (res.status !== 200) throw new Error(`${host} HTTP ${res.status}`);
  if (!/<rss|<feed/i.test(res.text.slice(0, 500))) {
    throw new Error(`${host} 返回的不是 RSS（实例可能已被换成挑战页）`);
  }
  return {
    host,
    tweets: parseNitterRss(res.text),
    avatarCdn: parseNitterAvatar(res.text),
    authorName: parseNitterAuthorName(res.text),
    bytes: res.body.length,
    ms: Date.now() - started,
  };
}

/**
 * 多实例轮询：按顺序试，第一个成功的获胜。
 * 全挂时抛一条聚合错误（每个实例一行原因）——失败与「没有新推文」必须能分开，
 * 这条错误是 feed 层发健康告警的唯一依据。
 */
export async function fetchFromAnyInstance(
  hosts: string[],
  screen: string,
  proxyUrl: string,
  opts: { timeoutMs?: number } = {},
): Promise<NitterFetchResult> {
  if (hosts.length === 0) throw new Error('没有配置任何 Nitter 实例');
  const reasons: string[] = [];
  for (const host of hosts) {
    try {
      const r = await fetchNitterTimeline(host, screen, proxyUrl, opts);
      if (r.tweets.length === 0) {
        // 空 feed 也可能是实例半死（RSS 正常但内容为空），继续试下一个，但记下这条
        reasons.push(`${host} 返回 0 条`);
        continue;
      }
      return r;
    } catch (e) {
      reasons.push(e instanceof Error ? e.message : String(e));
    }
  }
  throw new Error(`全部 ${hosts.length} 个实例都失败：${reasons.join('；')}`);
}