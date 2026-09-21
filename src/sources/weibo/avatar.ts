/**
 * 微博账号头像本地化：抓取时间线时顺手把头像下载到本地缓存。
 *
 * 与 twitter/avatar.ts 的差异：微博图床（sinaimg.cn）境内直连可达，**不需要代理隧道**，
 * 所以这里用普通 fetch。类型字段（avatar_large / profile_image_url）在 feed.ts 里取。
 *
 * 存库的是文件名（不是绝对路径），面板经 /api/weibo-avatar 按文件名从受信目录读。
 * 注意：微博头像 URL 带签名与过期参数，**同一头像每轮拿到的 URL 也可能不同**，所以下载由
 * feed.ts 的「还没有本地头像才下载」守卫把关——已有头像不重复下载（否则每轮都在重下签名 URL），
 * 换头像也不会更新本地缓存（要更新得删号重加）。旧文件体积小，随缓存目录自然淘汰。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeLogger } from '../../logger.js';

const log = makeLogger('weibo/avatar');

const MAX_BYTES = 3 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * 下载并缓存头像，返回文件名（md5(url) + 扩展名）。
 * 已缓存直接命中不重复下载；任何失败都返回 null（头像缺失不影响抓取主流程）。
 */
export async function cacheWeiboAvatar(url: string, dir: string): Promise<string | null> {
  const ext = url.includes('.png') ? '.png' : '.jpg';
  const name = createHash('md5').update(url).digest('hex') + ext;
  const file = join(dir, name);
  if (existsSync(file)) return name;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://weibo.com/' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_BYTES) return null;
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, buf);
    return name;
  } catch (e) {
    log.debug(`微博头像下载失败（按无头像处理）: ${(e as Error).message}`);
    return null;
  }
}
