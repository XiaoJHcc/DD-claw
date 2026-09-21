import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { biliAvatarFileName, cacheBiliAvatar } from './avatar.js';

const FACE = 'https://i0.hdslb.com/bfs/face/abc123.jpg';
const PNG = 'https://i2.hdslb.com/bfs/face/def456.png';

function tmpdir_(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'ddclaw-bili-avatar-'));
  return { dir, cleanup() { rmSync(dir, { recursive: true, force: true }); } };
}

test('biliAvatarFileName：md5(url) + 扩展名，png 保留、其余归 jpg', () => {
  assert.equal(
    biliAvatarFileName(FACE),
    createHash('md5').update(FACE).digest('hex') + '.jpg',
  );
  assert.equal(biliAvatarFileName(PNG), createHash('md5').update(PNG).digest('hex') + '.png');
});

test('cacheBiliAvatar：下载成功落盘并返回文件名；已缓存直接命中不再下载', async (t) => {
  const { dir, cleanup } = tmpdir_();
  t.after(cleanup);
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response(Buffer.from('fake-image-bytes'), { status: 200 });
  }) as typeof fetch;

  const name = await cacheBiliAvatar(FACE, dir, fetchImpl);
  assert.equal(name, biliAvatarFileName(FACE));
  assert.ok(existsSync(join(dir, name!)), '文件真实落盘');

  const again = await cacheBiliAvatar(FACE, dir, (async () => { throw new Error('不该再请求'); }) as typeof fetch);
  assert.equal(again, name, '缓存命中不再走网络');
  assert.equal(calls, 1);
});

test('cacheBiliAvatar：HTTP 非 200 / 空响应 / 超大 / 网络异常一律 null（不炸主流程）', async (t) => {
  const { dir, cleanup } = tmpdir_();
  t.after(cleanup);

  assert.equal(await cacheBiliAvatar(FACE, dir, (async () => new Response('x', { status: 404 })) as typeof fetch), null);
  assert.equal(await cacheBiliAvatar(FACE, dir, (async () => new Response(null, { status: 200 })) as typeof fetch), null);
  assert.equal(
    await cacheBiliAvatar(FACE, dir, (async () =>
      new Response(Buffer.alloc(3 * 1024 * 1024 + 1), { status: 200 })) as typeof fetch),
    null,
    '超过 3MB 拒绝',
  );
  assert.equal(
    await cacheBiliAvatar(FACE, dir, (async () => { throw new Error('connect ETIMEDOUT'); }) as typeof fetch),
    null,
  );
  assert.equal(existsSync(join(dir, biliAvatarFileName(FACE))), false, '失败不落半成品文件');
});

test('cacheBiliAvatar：缓存目录不存在时按需创建', async (t) => {
  const { dir, cleanup } = tmpdir_();
  t.after(cleanup);
  const nested = join(dir, 'a', 'b');
  const name = await cacheBiliAvatar(FACE, nested, (async () =>
    new Response(Buffer.from('img'), { status: 200 })) as typeof fetch);
  assert.ok(name && existsSync(join(nested, name)));
});
