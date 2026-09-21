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

/** 捕获请求头的假 fetch（Referer 按图床分支的回归测试用） */
function headerCaptureFetch(captured: Array<Record<string, string>>): typeof fetch {
  return (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    captured.push(init?.headers ?? {});
    return {
      ok: true, status: 200,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)),
      headers: new Headers({ 'content-type': 'image/jpeg' }),
    };
  }) as unknown as typeof fetch;
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

test('Referer 按图床分支：sinaimg 带 weibo.com（防盗链），其余带 B站 Referer', async () => {
  const captured: Array<Record<string, string>> = [];
  const f = headerCaptureFetch(captured);
  await localizeImage('https://wx1.sinaimg.cn/large/abc.jpg', dir, f);
  await localizeImage('https://i0.hdslb.com/x.jpg', dir, f);
  await localizeImage('https://fanyi.sinaimg.cn.t.example.com/a.jpg', dir, f);
  assert.equal(captured[0]!.Referer, 'https://weibo.com/', '微博图床带 weibo Referer');
  assert.equal(captured[1]!.Referer, 'https://live.bilibili.com/', 'B站图床保持原 Referer');
  assert.equal(captured[2]!.Referer, 'https://live.bilibili.com/', '后缀撞名的域不算 sinaimg');
  for (const h of captured) assert.ok(h['User-Agent'], 'UA 恒带');
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
