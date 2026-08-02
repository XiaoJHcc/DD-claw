import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateQrcode, pollQrcode, type FetchImpl } from './qrcode.js';
import { BiliHttpError } from './client.js';

function jsonRes(body: unknown, init: { status?: number; setCookies?: string[] } = {}): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const c of init.setCookies ?? []) headers.append('set-cookie', c);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

const ok = (data: unknown, init?: { setCookies?: string[] }): FetchImpl =>
  async () => jsonRes({ code: 0, message: '0', data }, init);

// ---- generate ----

test('generateQrcode 提取 qrcode_key/url', async () => {
  const r = await generateQrcode(ok({ qrcode_key: 'k123', url: 'https://bilibili.tv/qr' }));
  assert.deepEqual(r, { key: 'k123', url: 'https://bilibili.tv/qr' });
});

test('generateQrcode HTTP 错误抛 BiliHttpError', async () => {
  await assert.rejects(
    generateQrcode(async () => jsonRes({}, { status: 412 })),
    (e) => e instanceof BiliHttpError && e.status === 412,
  );
});

test('generateQrcode 坏 JSON 抛 BiliHttpError', async () => {
  await assert.rejects(
    generateQrcode(async () => new Response('<html>风控</html>', { status: 200 })),
    BiliHttpError,
  );
});

test('generateQrcode 外层 envelope code != 0 抛 BiliHttpError', async () => {
  await assert.rejects(
    generateQrcode(async () => jsonRes({ code: -400, message: '请求错误' })),
    BiliHttpError,
  );
});

test('generateQrcode data 缺字段抛 BiliHttpError', async () => {
  await assert.rejects(generateQrcode(ok({ url: 'only-url' })), BiliHttpError);
});

// ---- poll：data.code 归一化 ----

test('pollQrcode 86101 → waiting（未知 code 也按 waiting）', async () => {
  assert.deepEqual(await pollQrcode('k', ok({ code: 86101 })), { status: 'waiting' });
  assert.deepEqual(await pollQrcode('k', ok({ code: 12345 })), { status: 'waiting' });
});

test('pollQrcode 86090 → scanned', async () => {
  assert.deepEqual(await pollQrcode('k', ok({ code: 86090 })), { status: 'scanned' });
});

test('pollQrcode 86038 → expired', async () => {
  assert.deepEqual(await pollQrcode('k', ok({ code: 86038 })), { status: 'expired' });
});

test('pollQrcode 0 → confirmed，Set-Cookie 全套提取（属性丢弃）', async () => {
  const r = await pollQrcode('k', ok({ code: 0, url: 'https://passport.bilibili.com/' }, {
    setCookies: [
      'SESSDATA=abc%2C123; Expires=Wed, 01-Jan-2031 00:00:00 GMT; Path=/; HttpOnly; Secure',
      'bili_jct=def456; Path=/',
      'DedeUserID=999; Path=/',
    ],
  }));
  assert.equal(r.status, 'confirmed');
  assert.deepEqual(r.cookies, { SESSDATA: 'abc%2C123', bili_jct: 'def456', DedeUserID: '999' });
});

test('pollQrcode HTTP 错误抛 BiliHttpError', async () => {
  await assert.rejects(
    pollQrcode('k', async () => jsonRes({}, { status: 500 })),
    (e) => e instanceof BiliHttpError && e.status === 500,
  );
});

test('pollQrcode key 拼进 query 且带 UA', async () => {
  let seenUrl = '';
  let seenUa: string | null = null;
  await pollQrcode('k with space', async (url, init) => {
    seenUrl = url;
    seenUa = new Headers(init?.headers).get('user-agent');
    return jsonRes({ code: 0, data: { code: 86101 } });
  });
  assert.match(seenUrl, /qrcode_key=k%20with%20space/);
  assert.match(seenUa ?? '', /Mozilla/);
});
