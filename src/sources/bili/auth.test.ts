import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCookies, cookieHeader, fetchSelf, saveCookies } from './auth.js';
import { BiliApiError, BiliHttpError } from './client.js';
import { ConfigError } from '../../config/index.js';

function tmpdir_(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'ddclaw-auth-'));
  return { dir, cleanup() { rmSync(dir, { recursive: true, force: true }); } };
}

test('cookieHeader 拼成 name=value; ... 形式', () => {
  assert.equal(
    cookieHeader({ SESSDATA: 'abc', bili_jct: 'def', buvid3: 'g' }),
    'SESSDATA=abc; bili_jct=def; buvid3=g',
  );
  assert.equal(cookieHeader({}), '');
});

test('loadCookies 文件不存在返回 null', (t) => {
  const { dir, cleanup } = tmpdir_();
  t.after(cleanup);
  assert.equal(loadCookies(join(dir, 'cookies.json')), null);
});

test('loadCookies 坏 JSON 抛 ConfigError 并指明文件', (t) => {
  const { dir, cleanup } = tmpdir_();
  t.after(cleanup);
  const p = join(dir, 'cookies.json');
  writeFileSync(p, '{not json');
  assert.throws(() => loadCookies(p), (e) => {
    assert.ok(e instanceof ConfigError);
    assert.match(e.message, /cookies\.json 不是合法 JSON/);
    return true;
  });
});

test('loadCookies 非对象（数组）也抛 ConfigError', (t) => {
  const { dir, cleanup } = tmpdir_();
  t.after(cleanup);
  const p = join(dir, 'cookies.json');
  writeFileSync(p, '[1,2]');
  assert.throws(() => loadCookies(p), /JSON 对象/);
});

test('loadCookies 正常读取，非字符串值被丢弃', (t) => {
  const { dir, cleanup } = tmpdir_();
  t.after(cleanup);
  const p = join(dir, 'cookies.json');
  writeFileSync(p, '﻿{"SESSDATA":"s","bili_jct":"j","n":1}');
  assert.deepEqual(loadCookies(p), { SESSDATA: 's', bili_jct: 'j' });
});

test('fetchSelf 正常返回 isLogin 与 mid（number 转 string）', async () => {
  const self = await fetchSelf('cookie', async () => ({ isLogin: true, mid: 12345 }));
  assert.deepEqual(self, { isLogin: true, mid: '12345' });
});

test('fetchSelf 传 cookie 给底层请求', async () => {
  let seen: string | undefined;
  await fetchSelf('SESSDATA=x', async (_url, opts) => {
    seen = opts?.cookie;
    return { isLogin: true, mid: 1 };
  });
  assert.equal(seen, 'SESSDATA=x');
});

test('fetchSelf code=-101 归一化成未登录，而不是抛错', async () => {
  const self = await fetchSelf('c', async () => { throw new BiliApiError(-101, '账号未登录'); });
  assert.deepEqual(self, { isLogin: false, mid: null });
});

test('fetchSelf 其他错误（HTTP 层/其他业务码）继续抛出', async () => {
  await assert.rejects(
    fetchSelf('c', async () => { throw new BiliHttpError('HTTP 412', 412); }),
    BiliHttpError,
  );
  await assert.rejects(
    fetchSelf('c', async () => { throw new BiliApiError(-352, '风控'); }),
    BiliApiError,
  );
});

// ---- saveCookies ----

test('saveCookies 文件不存在直接写', (t) => {
  const { dir, cleanup } = tmpdir_();
  t.after(cleanup);
  const p = join(dir, 'cookies.json');
  saveCookies(p, { SESSDATA: 's', bili_jct: 'j' });
  assert.deepEqual(loadCookies(p), { SESSDATA: 's', bili_jct: 'j' });
});

test('saveCookies merge：新值覆盖、旧值兜底（扫码不发 buvid3 等风控字段）', (t) => {
  const { dir, cleanup } = tmpdir_();
  t.after(cleanup);
  const p = join(dir, 'cookies.json');
  writeFileSync(p, JSON.stringify({ SESSDATA: 'old', buvid3: 'keep-me', n: 1 }));
  saveCookies(p, { SESSDATA: 'new', bili_jct: 'j' });
  assert.deepEqual(loadCookies(p), { SESSDATA: 'new', bili_jct: 'j', buvid3: 'keep-me' },
    '旧的风控字段保留，SESSDATA 被新值覆盖，非字符串旧值被丢弃');
});

test('saveCookies 旧文件是坏 JSON 直接覆盖', (t) => {
  const { dir, cleanup } = tmpdir_();
  t.after(cleanup);
  const p = join(dir, 'cookies.json');
  writeFileSync(p, '{not json');
  saveCookies(p, { SESSDATA: 's' });
  assert.deepEqual(loadCookies(p), { SESSDATA: 's' });
});

test('saveCookies 旧文件不是对象（数组）直接覆盖', (t) => {
  const { dir, cleanup } = tmpdir_();
  t.after(cleanup);
  const p = join(dir, 'cookies.json');
  writeFileSync(p, '[1,2]');
  saveCookies(p, { SESSDATA: 's' });
  assert.deepEqual(loadCookies(p), { SESSDATA: 's' });
});
