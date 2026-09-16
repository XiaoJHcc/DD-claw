/**
 * X / 推特 连通性探测：只回答「今天还能不能用」，不落库、不发信号、不进管线。
 *
 * 三种探测各自对应一个真实失败点（调研 docs/research/twitter.md §1-§3）：
 *  · 代理     —— 境内直连 x.com 的 TLS 被重置，一切能力都压在代理上；
 *  · 实例     —— Nitter 系公共实例随时死/限流/被停止函打死（xcancel 已 451）；
 *  · 免登录   —— x.com 免登录 HTML 是否仍内嵌最新推文（回退路线的前提）。
 *
 * 面板「X / 推特」页的两个「测试」按钮与 `npm run probe-x` 共用这里的实现，
 * 保证「面板显示可用」与「CLI 说可用」不会各说各话。
 */
import { mapLimit } from '../../core/concurrency.js';
import { parseInstanceList, parseProxyUrl, tunnelFetch, TunnelError, describeTunnelError } from '../../core/proxy.js';

/** 探测用的代理可达性目标：极小、稳定、无风控语义 */
const PROXY_TARGET = 'https://x.com/robots.txt';
/** 免登录探测默认账号（调研基准账号，仅作 CLI 默认值） */
export const DEFAULT_PROBE_SCREEN = 'Watase_Yuzuki';

export function normalizeScreenName(raw: string): string {
  return raw.trim().replace(/^@+/, '').toLowerCase();
}

export interface ProxyProbe {
  ok: boolean;
  kind: 'ok' | 'unconfigured' | 'error';
  target: string;
  status: number | null;
  ms: number;
  message: string;
}

/** 直接请求 x.com 的一个小文件，确认「代理 → 境外」这条链路真的通 */
export async function probeProxy(proxyUrl: string, timeoutMs = 15_000): Promise<ProxyProbe> {
  const started = Date.now();
  const base = { target: PROXY_TARGET, status: null, ms: 0 };
  let proxy;
  try {
    proxy = parseProxyUrl(proxyUrl);
  } catch (e) {
    return { ...base, ok: false, kind: 'error', ms: Date.now() - started, message: describeTunnelError(e) };
  }
  if (!proxy) {
    return {
      ...base,
      ok: false,
      kind: 'unconfigured',
      ms: Date.now() - started,
      message: '未配置代理；境内直连 x.com 会 TLS 被重置，X 功能不可用',
    };
  }
  try {
    const res = await tunnelFetch(PROXY_TARGET, proxy, { timeoutMs });
    const ms = Date.now() - started;
    return {
      ...base,
      status: res.status,
      ms,
      ok: res.status === 200,
      kind: res.status === 200 ? 'ok' : 'error',
      message:
        res.status === 200
          ? `代理可达 · x.com ${res.status} · ${ms}ms`
          : `代理通了但 x.com 返回 ${res.status}（多为代理规则把 x.com 走了直连）`,
    };
  } catch (e) {
    return {
      ...base,
      ok: false,
      kind: 'error',
      ms: Date.now() - started,
      message: describeTunnelError(e),
    };
  }
}

/** 瞬时错误（TLS 被重置 / 超时 / 连接中断）值得再来一次；语义错误（451/403/解析）不重试 */
function isTransient(e: unknown): boolean {
  return e instanceof TunnelError && (e.kind === 'tls' || e.kind === 'timeout' || e.kind === 'truncated');
}

/**
 * 实例探测专用的一次重试。公共 Nitter 实例会随机抖（同一实例几分钟前还通、
 * 这次 TLS 就被重置），单次失败不足以判定它死了；但重试过仍失败要如实写在结果里，
 * 免得把「抖」读成「稳」。
 */
async function fetchWithRetry(
  url: string,
  proxy: { host: string; port: number },
  timeoutMs: number,
): Promise<Awaited<ReturnType<typeof tunnelFetch>>> {
  try {
    return await tunnelFetch(url, proxy, { timeoutMs, maxBytes: 1024 * 1024 });
  } catch (e) {
    if (!isTransient(e)) throw e;
    await new Promise((r) => setTimeout(r, 800));
    try {
      return await tunnelFetch(url, proxy, { timeoutMs, maxBytes: 1024 * 1024 });
    } catch (e2) {
      throw new TunnelError(
        e2 instanceof TunnelError ? e2.kind : 'truncated',
        `${describeTunnelError(e2)}（已重试 1 次）`,
      );
    }
  }
}

export type InstanceKind = 'ok' | 'cloudflare' | 'anubis' | 'legal' | 'blocked' | 'empty' | 'error';

export interface InstanceProbe {
  host: string;
  ok: boolean;
  kind: InstanceKind;
  status: number | null;
  ms: number;
  /** RSS 里的条目数（仅 kind='ok' 时有意义） */
  items: number;
  message: string;
}

/**
 * 实例探活：**打 RSS 而不是首页**。
 *
 * 首页是否可访问与能不能用是两件事——2026-09-16 实测 `x.n0g.xyz` 首页挂着
 * Anubis 工作量证明（脚本取不到），但它 `/<user>/rss` 仍正常返回 20 条。
 * 按首页判活会误杀真正要用的那条路，所以主判据只有 RSS。
 */
export async function probeInstance(
  host: string,
  proxyUrl: string,
  screen = DEFAULT_PROBE_SCREEN,
  timeoutMs = 15_000,
): Promise<InstanceProbe> {
  const started = Date.now();
  const base = { host, status: null, ms: 0, items: 0 };
  let proxy;
  try {
    proxy = parseProxyUrl(proxyUrl);
  } catch (e) {
    return { ...base, ok: false, kind: 'error', message: describeTunnelError(e) };
  }
  if (!proxy) return { ...base, ok: false, kind: 'error', message: '未配置代理，无法访问公网实例' };
  try {
    const res = await fetchWithRetry(
      `https://${host}/${encodeURIComponent(normalizeScreenName(screen))}/rss`,
      proxy,
      timeoutMs,
    );
    const ms = Date.now() - started;
    const body = res.text.slice(0, 3000);
    const mk = (ok: boolean, kind: InstanceKind, message: string, items = 0): InstanceProbe =>
      ({ ...base, ok, kind, status: res.status, ms, items, message });
    if (res.status === 451) return mk(false, 'legal', '451 法律原因下架（同 xcancel）');
    if (res.status === 429) return mk(false, 'blocked', '429 被限速');
    if (res.status === 403 && /Just a moment|Attention Required|cf-/i.test(body)) {
      return mk(false, 'cloudflare', '403 Cloudflare 挑战（脚本不可用）');
    }
    if (res.status === 403) return mk(false, 'blocked', '403 拒绝访问');
    if (/not a bot|anubis|within\.website/i.test(body)) {
      return mk(false, 'anubis', `${res.status} 挂着 Anubis 工作量证明（脚本不可用）`);
    }
    if (res.status === 200) {
      const items = (res.text.match(/<item>/g) ?? []).length;
      if (items > 0) return mk(true, 'ok', `可用 · ${items} 条 · ${ms}ms`, items);
      if (/<rss|<feed/i.test(body)) return mk(true, 'empty', `RSS 可用但暂无条目 · ${ms}ms`);
      return mk(false, 'error', `200 但不是 RSS（页面结构可能已变）`);
    }
    return mk(false, 'error', `HTTP ${res.status}`);
  } catch (e) {
    return { ...base, ok: false, kind: 'error', ms: Date.now() - started, message: describeTunnelError(e) };
  }
}

/** 实例列表逐个探活（并发 2，对公共实例客气一点）。mapLimit 会吞掉任务异常，这里补回一行可读结果。 */
export async function probeInstances(
  hosts: string[],
  proxyUrl: string,
  screen = DEFAULT_PROBE_SCREEN,
  timeoutMs = 15_000,
): Promise<InstanceProbe[]> {
  const results = await mapLimit(hosts, 2, (h) => probeInstance(h, proxyUrl, screen, timeoutMs));
  return results.map((r, i) => r ?? {
    host: hosts[i]!,
    ok: false,
    kind: 'error' as const,
    status: null,
    ms: 0,
    items: 0,
    message: '探测任务异常中断（未返回结果）',
  });
}

export function summarizeInstances(list: InstanceProbe[]): { ok: number; total: number; summary: string } {
  const ok = list.filter((i) => i.ok).length;
  return { ok, total: list.length, summary: `${ok}/${list.length} 实例可用` };
}

export interface WebProbe {
  ok: boolean;
  screenName: string;
  status: number | null;
  ms: number;
  /** 免登录 HTML 里抠到的推文 id 数（含置顶） */
  tweetIds: number;
  latestId: string | null;
  /** 用 syndication 换出的最新推文时间（秒级时间戳），拿不到为 null */
  latestAt: number | null;
  message: string;
}

/**
 * 免登录路线探测：GET `x.com/<screen>`（无 cookie）→ 抠 `rest_id` →
 * 用最大 id 打 `cdn.syndication.twimg.com/tweet-result` 换 `created_at`。
 * 这是「Nitter 全挂时的回退路线」是否仍成立唯一的判据。
 */
export async function probeWeb(
  screenName: string,
  proxyUrl: string,
  timeoutMs = 20_000,
): Promise<WebProbe> {
  const started = Date.now();
  const screen = normalizeScreenName(screenName);
  const base = { screenName: screen, status: null, tweetIds: 0, latestId: null, latestAt: null };
  let proxy;
  try {
    proxy = parseProxyUrl(proxyUrl);
  } catch (e) {
    return { ...base, ok: false, ms: 0, message: describeTunnelError(e) };
  }
  if (!proxy) return { ...base, ok: false, ms: 0, message: '未配置代理，无法访问 x.com' };
  if (!screen) return { ...base, ok: false, ms: 0, message: '账号为空' };

  try {
    const res = await tunnelFetch(`https://x.com/${encodeURIComponent(screen)}`, proxy, { timeoutMs });
    const ids = [...new Set([...res.text.matchAll(/rest_id:"(\d{15,25})"/g)].map((m) => m[1]!))];
    if (res.status !== 200 || ids.length === 0) {
      return {
        ...base,
        status: res.status,
        ms: Date.now() - started,
        ok: false,
        message: `x.com 返回 ${res.status}，未抠到推文 id（页面结构可能已变）`,
      };
    }
    const latestId = ids.reduce((a, b) => (BigInt(a) > BigInt(b) ? a : b));
    let latestAt: number | null = null;
    try {
      const tr = await tunnelFetch(
        `https://cdn.syndication.twimg.com/tweet-result?id=${latestId}&lang=ja&token=dd-claw`,
        proxy,
        { timeoutMs },
      );
      const j = JSON.parse(tr.text) as { created_at?: string };
      const t = j.created_at ? Date.parse(j.created_at) : NaN;
      latestAt = Number.isNaN(t) ? null : Math.floor(t / 1000);
    } catch {
      latestAt = null; // 换不到时间不算失败：id 已拿到
    }
    return {
      ...base,
      status: res.status,
      ms: Date.now() - started,
      ok: true,
      tweetIds: ids.length,
      latestId,
      latestAt,
      message: `免登录可用 · ${ids.length} 个 id · 最新 ${latestAt ? new Date(latestAt * 1000).toISOString() : latestId}`,
    };
  } catch (e) {
    return { ...base, ok: false, ms: Date.now() - started, message: describeTunnelError(e) };
  }
}

export interface XProbeReport {
  proxy: ProxyProbe;
  instances: InstanceProbe[];
  web: WebProbe | null;
}

/** CLI 与面板共用的一次性总探测：代理 → 实例 → 免登录（依次，后面依赖前面通） */
export async function probeAll(
  cfg: { proxyUrl: string; instances: string[] },
  screenName = DEFAULT_PROBE_SCREEN,
): Promise<XProbeReport> {
  const proxy = await probeProxy(cfg.proxyUrl);
  const instances = await probeInstances(parseInstanceList(cfg.instances.join(',')), cfg.proxyUrl, screenName);
  const web = proxy.ok ? await probeWeb(screenName, cfg.proxyUrl) : null;
  return { proxy, instances, web };
}