import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeLogger } from '../logger.js';
import { parseProxyUrl, tunnelFetch } from '../core/proxy.js';

const log = makeLogger('notify/image-cache');

/** Windows toast 单图上限 3MB（超出会被系统丢图，不如主动放弃） */
const MAX_BYTES = 3 * 1024 * 1024;
const KEEP_MS = 3 * 24 * 3600 * 1000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

/**
 * 按图床选 Referer（都要 UA，否则 403）：
 *  · B站图床要 `live.bilibili.com`；
 *  · 微博图床（sinaimg.cn）要 `weibo.com` —— 头像链路带它实测可达，带外站 Referer 会被防盗链 403
 *    （2026-09-20 实测 no-referrer 也 403，面板帖子图走 /api/weibo-image 反代，见 boundaries #38）。
 */
function imageHeaders(url: string): { 'User-Agent': string; Referer: string } {
  let host = '';
  try { host = new URL(url).hostname; } catch { /* 坏 URL 交给 fetch 报错 */ }
  const referer = /(^|\.)sinaimg\.cn$/i.test(host) ? 'https://weibo.com/' : 'https://live.bilibili.com/';
  return { 'User-Agent': UA, Referer: referer };
}

/** 已是本地路径就当本地用（X 图在 pipeline 里已用代理下载好，见 localizeImageViaProxy） */
export function isLocalImage(src: string): boolean {
  return !/^https?:\/\//i.test(src);
}

/** 字节 → 缓存文件；空、超限、写盘失败都返回 null（调用方按「无图」处理） */
function writeCached(buf: Buffer, key: string, contentType: string, cacheDir: string): string | null {
  if (buf.length === 0 || buf.length > MAX_BYTES) return null;
  const ext = contentType.includes('png') ? '.png' : contentType.includes('webp') ? '.webp' : '.jpg';
  mkdirSync(cacheDir, { recursive: true });
  const file = join(cacheDir, createHash('md5').update(key).digest('hex') + ext);
  writeFileSync(file, buf);
  prune(cacheDir);
  return file;
}

/**
 * Win32 AUMID 的 toast 不支持远程图片（微软限制，仅 UWP 身份可用 http 图），
 * 下载到本地缓存再发。任何失败都返回 null —— 通知照样发，只是无图。
 */
export async function localizeImage(
  url: string,
  cacheDir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(url, { headers: imageHeaders(url), signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return writeCached(buf, url, res.headers.get('content-type') ?? '', cacheDir);
  } catch (e) {
    log.debug(`图片本地化失败（按无图发送）: ${(e as Error).message}`);
    return null;
  }
}

/**
 * 经 HTTP 代理下载并本地化（X/推特图专用）。
 *
 * 为什么必须走隧道：`pbs.twimg.com` 在墙内直连超时，原生 fetch 又用不了代理
 * （Node 22 不认 HTTPS_PROXY），而 NapCat 与本进程在同一个网络里，把远程 URL 交给它
 * 让它自己去拉同样拉不到 —— 唯一可行形态是**先把图落到本地**，再把本地路径给它。
 */
export async function localizeImageViaProxy(
  url: string,
  cacheDir: string,
  proxyUrl: string,
): Promise<string | null> {
  let proxy;
  try {
    proxy = parseProxyUrl(proxyUrl);
  } catch {
    return null;
  }
  if (!proxy) return null;
  try {
    const res = await tunnelFetch(url, proxy, { timeoutMs: 15_000, maxBytes: MAX_BYTES + 1 });
    if (res.status !== 200) return null;
    return writeCached(res.body, url, res.headers['content-type'] ?? '', cacheDir);
  } catch (e) {
    log.debug(`X 图经代理本地化失败（按无图发送）: ${(e as Error).message}`);
    return null;
  }
}

/** 顺便清理过期缓存，避免无限膨胀。失败无所谓 */
function prune(cacheDir: string): void {
  try {
    const cutoff = Date.now() - KEEP_MS;
    for (const name of readdirSync(cacheDir)) {
      const p = join(cacheDir, name);
      if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
    }
  } catch { /* 清理失败不影响发通知 */ }
}