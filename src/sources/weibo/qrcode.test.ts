import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exchangeCookies, generateQrcode, pollQrcode, type FetchImpl } from './qrcode.js';

function jsonRes(body: unknown, init: { status?: number; setCookies?: string[] } = {}): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const c of init.setCookies ?? []) headers.append('set-cookie', c);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

const ret = (retcode: number, data?: unknown, init?: { setCookies?: string[] }): FetchImpl =>
  async () => jsonRes({ retcode, msg: '', data }, init);

// ---- generate（已实测：retcode 20000000 + data.qrid/image）----

test('generateQrcode 提取 qrid/image（image 是 png 直链）', async () => {
  const r = await generateQrcode(ret(20000000, {
    qrid: 'abc123', image: 'https://passport.weibo.com/sso/v2/qrcode/abc123.png',
  }));
  assert.deepEqual(r, { qrid: 'abc123', image: 'https://passport.weibo.com/sso/v2/qrcode/abc123.png' });
});

test('generateQrcode retcode != 20000000 抛中文错', async () => {
  await assert.rejects(
    generateQrcode(async () => jsonRes({ retcode: 50114999, msg: '参数错误' })),
    /retcode=50114999/,
  );
});

test('generateQrcode data 缺 qrid/image 抛中文错', async () => {
  await assert.rejects(generateQrcode(ret(20000000, { image: 'only-image' })), /缺少 qrid\/image/);
});

test('generateQrcode HTTP 错误 / 坏 JSON 抛中文错', async () => {
  await assert.rejects(
    generateQrcode(async () => jsonRes({}, { status: 412 })),
    /HTTP 412/,
  );
  await assert.rejects(
    generateQrcode(async () => new Response('<html>风控</html>', { status: 200 })),
    /不是合法 JSON/,
  );
  await assert.rejects(
    generateQrcode(async () => { throw new Error('connect ETIMEDOUT'); }),
    /微博网络错误/,
  );
});

// ---- poll：retcode 归一化（50114001/20000000 已实测，其余防御式映射）----

test('pollQrcode 50114001 → waiting（已实测「未使用」）', async () => {
  assert.deepEqual(await pollQrcode('q', ret(50114001)), { status: 'waiting' });
});

test('pollQrcode 50114002 → scanned（防御式映射）', async () => {
  assert.deepEqual(await pollQrcode('q', ret(50114002)), { status: 'scanned' });
});

test('pollQrcode 20000000 → confirmed，带 data.url 换票地址', async () => {
  const r = await pollQrcode('q', ret(20000000, { url: 'https://login.sina.com.cn/crossdomain/abc' }));
  assert.deepEqual(r, { status: 'confirmed', loginUrl: 'https://login.sina.com.cn/crossdomain/abc' });
});

test('pollQrcode confirmed 缺 data.url 抛中文错', async () => {
  await assert.rejects(pollQrcode('q', ret(20000000, {})), /缺少 data\.url/);
});

test('pollQrcode 其他 50114xxx → expired（防御式）；完全未知码 → waiting', async () => {
  assert.deepEqual(await pollQrcode('q', ret(50114003)), { status: 'expired' });
  assert.deepEqual(await pollQrcode('q', ret(50114999)), { status: 'expired' });
  assert.deepEqual(await pollQrcode('q', ret(50000000)), { status: 'waiting' });
});

test('pollQrcode qrid 拼进 query 且带 UA', async () => {
  let seenUrl = '';
  let seenUa: string | null = null;
  await pollQrcode('qr id', async (url, init) => {
    seenUrl = url;
    seenUa = new Headers(init?.headers).get('user-agent');
    return jsonRes({ retcode: 50114001, data: {} });
  });
  assert.match(seenUrl, /sso\/v2\/qrcode\/check/);
  assert.match(seenUrl, /qrid=qr%20id/);
  assert.match(seenUrl, /entry=miniblog/);
  assert.match(seenUa ?? '', /Mozilla/);
});

// ---- exchangeCookies：302 链合并 ----

function redirectRes(location: string | null, setCookies: string[], status = 302): Response {
  const headers = new Headers();
  if (location !== null) headers.set('location', location);
  for (const c of setCookies) headers.append('set-cookie', c);
  return new Response(null, { status, headers });
}

test('exchangeCookies 多跳 302 链合并全套 Set-Cookie（属性丢弃）', async () => {
  const seenCookies: (string | null)[] = [];
  const hops: Record<string, Response> = {
    'https://login.sina.com.cn/crossdomain/abc': redirectRes(
      'https://passport.weibo.com/sso/login?ticket=t1',
      ['ALC=alc-val; Path=/; HttpOnly', 'sso_info=v02; Path=/'],
    ),
    'https://passport.weibo.com/sso/login?ticket=t1': redirectRes(
      '/crossdomain/step2',
      ['SUBP=subp-val; Path=/; domain=.sina.com.cn'],
    ),
    'https://passport.weibo.com/crossdomain/step2': redirectRes(
      null,
      ['SUB=sub-val; Path=/; domain=.weibo.com; HttpOnly'],
      200,
    ),
  };
  const cookies = await exchangeCookies('https://login.sina.com.cn/crossdomain/abc', async (url, init) => {
    seenCookies.push(new Headers(init?.headers).get('cookie'));
    const r = hops[url];
    assert.ok(r, `意外跳转到 ${url}`);
    return r;
  });
  assert.deepEqual(cookies, { ALC: 'alc-val', sso_info: 'v02', SUBP: 'subp-val', SUB: 'sub-val' });
  assert.equal(seenCookies[0], null, '第一跳无 cookie');
  assert.match(seenCookies[1] ?? '', /ALC=alc-val/, '第二跳带上第一跳落下的 cookie');
  assert.match(seenCookies[2] ?? '', /SUBP=subp-val/, '第三跳带上前面落下的 cookie');
});

test('exchangeCookies 相对 Location 按上一跳解析', async () => {
  const seen: string[] = [];
  const cookies = await exchangeCookies('https://login.sina.com.cn/crossdomain/abc', async (url) => {
    seen.push(url);
    if (seen.length === 1) return redirectRes('../sso/end?x=1', ['SUB=sub-val; Path=/']);
    return redirectRes(null, [], 200);
  });
  assert.equal(seen[1], 'https://login.sina.com.cn/sso/end?x=1');
  assert.deepEqual(cookies, { SUB: 'sub-val' });
});

test('exchangeCookies 超过 5 跳仍未落地抛中文错', async () => {
  await assert.rejects(
    exchangeCookies('https://login.sina.com.cn/a', async () =>
      redirectRes('https://login.sina.com.cn/next', ['X=1; Path=/'])),
    /超过 5 跳/,
  );
});

test('exchangeCookies 整链零 Set-Cookie 抛中文错', async () => {
  await assert.rejects(
    exchangeCookies('https://login.sina.com.cn/a', async () => redirectRes(null, [], 200)),
    /未获得任何 Set-Cookie/,
  );
});

test('exchangeCookies 网络异常抛中文错', async () => {
  await assert.rejects(
    exchangeCookies('https://login.sina.com.cn/a', async () => { throw new Error('ECONNRESET'); }),
    /微博网络错误/,
  );
});
