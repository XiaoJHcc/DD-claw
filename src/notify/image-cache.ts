import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeLogger } from '../logger.js';

const log = makeLogger('notify/image-cache');

/** Windows toast 单图上限 3MB（超出会被系统丢图，不如主动放弃） */
const MAX_BYTES = 3 * 1024 * 1024;
const KEEP_MS = 3 * 24 * 3600 * 1000;

/** B站图床要 UA + Referer，否则 403 */
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Referer: 'https://live.bilibili.com/',
};

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
    const res = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_BYTES) return null;
    const ext = (res.headers.get('content-type') ?? '').includes('png') ? '.png' : '.jpg';
    mkdirSync(cacheDir, { recursive: true });
    const file = join(cacheDir, createHash('md5').update(url).digest('hex') + ext);
    writeFileSync(file, buf);
    prune(cacheDir);
    return file;
  } catch (e) {
    log.debug(`图片本地化失败（按无图发送）: ${(e as Error).message}`);
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
