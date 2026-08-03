import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localizeImage } from './image-cache.js';

/** 构造假的 fetch Response（只需 ok/arrayBuffer/headers 三件套） */
function fakeFetch(status: number, body: Buffer | null, contentType = 'image/jpeg'): typeof fetch {
  return (() => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: () => Promise.resolve(body ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : new ArrayBuffer(0)),
    headers: new Headers({ 'content-type': contentType }),
  })) as unknown as typeof fetch;
}

let dir = '';
test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dd-claw-imgcache-')); });
test.afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('下载成功：写入缓存文件并返回本地路径', async () => {
  const file = await localizeImage('https://i0.hdslb.com/x.jpg', dir, fakeFetch(200, Buffer.from('fake-jpg')));
  assert.ok(file);
  assert.ok(existsSync(file));
  assert.ok(file.endsWith('.jpg'));
  // 同一 URL 命中同一缓存文件名
  const again = await localizeImage('https://i0.hdslb.com/x.jpg', dir, fakeFetch(200, Buffer.from('fake-jpg')));
  assert.equal(again, file);
});

test('png content-type 用 .png 扩展名', async () => {
  const file = await localizeImage('https://i0.hdslb.com/x', dir, fakeFetch(200, Buffer.from('x'), 'image/png'));
  assert.ok(file?.endsWith('.png'));
});

test('HTTP 失败 / 空body / 超大图 / 网络异常都返回 null，不抛异常', async () => {
  assert.equal(await localizeImage('https://x/a.jpg', dir, fakeFetch(403, null)), null);
  assert.equal(await localizeImage('https://x/a.jpg', dir, fakeFetch(200, Buffer.alloc(0))), null);
  assert.equal(await localizeImage('https://x/a.jpg', dir, fakeFetch(200, Buffer.alloc(3 * 1024 * 1024 + 1))), null);
  const boom = (() => Promise.reject(new Error('timeout'))) as unknown as typeof fetch;
  assert.equal(await localizeImage('https://x/a.jpg', dir, boom), null);
});

test('下载成功时顺便清理 3 天前的旧缓存', async () => {
  const stale = join(dir, 'old.jpg');
  writeFileSync(stale, 'x');
  const old = new Date(Date.now() - 4 * 24 * 3600 * 1000);
  utimesSync(stale, old, old);
  const fresh = join(dir, 'fresh.jpg');
  writeFileSync(fresh, 'x');

  await localizeImage('https://x/new.jpg', dir, fakeFetch(200, Buffer.from('y')));

  const names = readdirSync(dir);
  assert.ok(!names.includes('old.jpg'), '过期缓存应被清理');
  assert.ok(names.includes('fresh.jpg'), '新缓存应保留');
  assert.ok(statSync(join(dir, names.find((n) => n.endsWith('.jpg') && n !== 'fresh.jpg')!)).size > 0);
});
