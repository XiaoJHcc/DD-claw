/**
 * B站头像本地化：动态轮询时顺手把账号头像下载到本地缓存。
 *
 * 与 weibo/avatar.ts 的差异：B站图床（i0.hdslb.com 等 hdslb 域）境内直连可达、
 * 不校验 Referer，所以这里用普通 fetch 且只带 UA，不走代理隧道。
 *
 * 存库的是文件名（不是绝对路径），面板按文件名从受信目录读（同 weibo/x 头像）。
 * 与微博同样的问题：face URL 里可能带缩放参数（@xxx.webp 等后缀不影响），下载由
 * dynamic.ts 的「还没有本地头像才下载」守卫把关——已有头像不重复下载，换头像不更新
 * 本地缓存（要更新得删号重加）。旧文件体积小，随缓存目录自然淘汰。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeLogger } from '../../logger.js';

const log = makeLogger('bili/avatar');

const MAX_BYTES = 3 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 存库文件名：md5(url) + 扩展名（face 多为 jpg，png 保留） */
export function biliAvatarFileName(url: string): string {
  const ext = url.includes('.png') ? '.png' : '.jpg';
  return createHash('md5').update(url).digest('hex') + ext;
}

/**
 * 下载并缓存头像，返回文件名。
 * 已缓存直接命中不重复下载；任何失败都返回 null（头像缺失不影响抓取主流程）。
 */
export async function cacheBiliAvatar(
  url: string, dir: string, fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const name = biliAvatarFileName(url);
  const file = join(dir, name);
  if (existsSync(file)) return name;
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_BYTES) return null;
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, buf);
    return name;
  } catch (e) {
    log.debug(`B站头像下载失败（按无头像处理）: ${(e as Error).message}`);
    return null;
  }
}
