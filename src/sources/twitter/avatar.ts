/**
 * X 账号头像本地化：抓取时间线时顺手把头像经代理隧道下载到本地缓存。
 *
 * 为什么不复用 notify/image-cache 的 localizeImageViaProxy：依赖方向纪律是
 * sources / notify 互不 import，而这里只需要「隧道下载 + md5 落盘」这一小段。
 * 存库的是文件名（不是绝对路径），面板经 /api/x-avatar 按文件名从受信目录读。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeLogger } from '../../logger.js';
import { parseProxyUrl, tunnelFetch } from '../../core/proxy.js';

const log = makeLogger('twitter/avatar');

const MAX_BYTES = 3 * 1024 * 1024;

/**
 * 下载并缓存头像，返回文件名（md5(url) + 扩展名）。
 * 已缓存直接命中不重复下载；任何失败都返回 null（头像缺失不影响抓取主流程）。
 */
export async function cacheXAvatar(url: string, dir: string, proxyUrl: string): Promise<string | null> {
  let proxy;
  try {
    proxy = parseProxyUrl(proxyUrl);
  } catch {
    return null;
  }
  if (!proxy) return null;
  const ext = url.includes('.png') ? '.png' : '.jpg';
  const name = createHash('md5').update(url).digest('hex') + ext;
  const file = join(dir, name);
  if (existsSync(file)) return name;
  try {
    const res = await tunnelFetch(url, proxy, { timeoutMs: 15_000, maxBytes: MAX_BYTES + 1 });
    if (res.status !== 200 || res.body.length === 0 || res.body.length > MAX_BYTES) return null;
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, res.body);
    return name;
  } catch (e) {
    log.debug(`X 头像下载失败（按无头像处理）: ${(e as Error).message}`);
    return null;
  }
}
