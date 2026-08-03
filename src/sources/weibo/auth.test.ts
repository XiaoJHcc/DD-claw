import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fetchWeiboSelf, loadWeiboCookies, saveWeiboCookies, weiboCookieHeader,
} from './auth.js';
import { ConfigError } from '../../config/index.js';

function tmp(t: import('node:test').TestContext): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ddclaw-weibo-auth-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, 'weibo-cookies.json') };
}

// ---- loadWeiboCookies ----

test('loadWeiboCookies 文件不存在返回 null', (t) => {
  const { file } = tmp(t);
  assert.equal(loadWeiboCookies(file), null);
});

test('loadWeiboCookies 正常读取：只留字符串字段，兼容 BOM', (t) => {
  const { file } = tmp(t);
  writeFileSync(file, '﻿' + JSON.stringify({ SUB: 's', SUBP: 'p', weird: 123, obj: {} }));
  assert.deepEqual(loadWeiboCookies(file), { SUB: 's', SUBP: 'p' });
});

test('loadWeiboCookies 坏 JSON / 非对象：启动即失败（ConfigError）', (t) => {
  const { file } = tmp(t);
  writeFileSync(file, '{oops');
  assert.throws(() => loadWeiboCookies(file), (e) => e instanceof ConfigError && /不是合法 JSON/.test(e.message));

  writeFileSync(file, '["SUB=s"]');
  assert.throws(() => loadWeiboCookies(file), (e) => e instanceof ConfigError && /JSON 对象/.test(e.message));
});

// ---- saveWeiboCookies ----

test('saveWeiboCookies 不存在直接写；已存在 merge（新值覆盖、旧值兜底）', (t) => {
  const { file } = tmp(t);
  saveWeiboCookies(file, { SUB: 's1' });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { SUB: 's1' });

  saveWeiboCookies(file, { SUB: 's2', ALC: 'a' });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { SUB: 's2', ALC: 'a' },
    '新值覆盖、旧值（SUB 已有则覆盖，未提字段保留）兜底');

  // 旧文件坏 JSON：直接覆盖不炸
  writeFileSync(file, '{broken');
  saveWeiboCookies(file, { SUB: 's3' });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { SUB: 's3' });
});

test('weiboCookieHeader 拼 name=value 分号串', () => {
  assert.equal(weiboCookieHeader({ SUB: 's', SUBP: 'p' }), 'SUB=s; SUBP=p');
});

// ---- fetchWeiboSelf（X-Log-Uid 响应头）----

function resWith(init: { status?: number; logUid?: string }): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (init.logUid !== undefined) headers.set('x-log-uid', init.logUid);
  return new Response('{"ok":1}', { status: init.status ?? 200, headers });
}

test('fetchWeiboSelf 有 X-Log-Uid → loggedIn + uid；缺头 → 未登录', async () => {
  assert.deepEqual(
    await fetchWeiboSelf('CK', async () => resWith({ logUid: '2203177060' })),
    { loggedIn: true, uid: '2203177060' },
  );
  assert.deepEqual(
    await fetchWeiboSelf('CK', async () => resWith({})),
    { loggedIn: false, uid: null },
  );
});

test('fetchWeiboSelf HTTP 错误 / 网络异常归一化为未登录', async () => {
  assert.deepEqual(
    await fetchWeiboSelf('CK', async () => resWith({ status: 500 })),
    { loggedIn: false, uid: null },
  );
  assert.deepEqual(
    await fetchWeiboSelf('CK', async () => { throw new Error('connect ETIMEDOUT'); }),
    { loggedIn: false, uid: null },
  );
});

test('fetchWeiboSelf 请求带 UA 与 cookie 头', async () => {
  let seenUa: string | null = null;
  let seenCookie: string | null = null;
  await fetchWeiboSelf('SUB=s', async (_url, init) => {
    const h = new Headers(init?.headers);
    seenUa = h.get('user-agent');
    seenCookie = h.get('cookie');
    return resWith({ logUid: '1' });
  });
  assert.match(seenUa ?? '', /Mozilla/);
  assert.equal(seenCookie, 'SUB=s');
});
