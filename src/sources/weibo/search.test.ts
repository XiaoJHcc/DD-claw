/**
 * 微博用户搜索单测（不走网络）：匿名侧栏建议、登录态完整搜索、降级顺序与精确解析。
 * 端点能力边界见 docs/research/web-search.md。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchWeiboUsers } from './search.js';
import type { FetchImpl } from './resolve.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function fakeFetch(fn: (url: string, init?: RequestInit) => Response | Promise<Response>): FetchImpl {
  return async (url, init) => fn(url, init);
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

/** 按主机路由并记录调用顺序：full = m.weibo.cn 登录搜索，side = 匿名侧栏建议 */
function routeFetch(routes: {
  full?: (url: string, init?: RequestInit) => Response | Promise<Response>;
  side?: (url: string, init?: RequestInit) => Response | Promise<Response>;
}): { fetchImpl: FetchImpl; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      if (url.startsWith('https://m.weibo.cn/api/container/getIndex')) {
        calls.push('full');
        if (!routes.full) throw new Error('未预期的完整搜索请求');
        return routes.full(url, init);
      }
      if (url.startsWith('https://weibo.com/ajax/side/search')) {
        calls.push('side');
        if (!routes.side) throw new Error('未预期的匿名建议请求');
        return routes.side(url, init);
      }
      throw new Error(`未预期的 URL：${url}`);
    },
  };
}

test('searchWeiboUsers：缺省 discover 且无 cookie 时仍走匿名侧栏搜索', async () => {
  let seen: { url?: string; init?: RequestInit } = {};
  const hits = await searchWeiboUsers('mygo', {
    fetchImpl: fakeFetch((url, init) => {
      seen = { url, init };
      return jsonResponse({ data: { users: [] } });
    }),
    // 无 cookie 时不应触发精确解析
    resolveUid: async () => {
      throw new Error('不应调用精确解析');
    },
  });
  assert.match(seen.url!, /^https:\/\/weibo\.com\/ajax\/side\/search\?q=mygo$/);
  const headers = headersOf(seen.init);
  assert.match(headers['user-agent']!, /Mozilla\/5\.0/);
  assert.equal(headers.referer, 'https://weibo.com/');
  assert.equal(headers.cookie, undefined);
  assert.deepEqual(hits, []);
});

test('searchWeiboUsers：users 全字段映射；user 简表补位并去重', async () => {
  const hits = await searchWeiboUsers('微博', {
    fetchImpl: fakeFetch(() => jsonResponse({
      data: {
        users: [{
          id: 1642909335,
          idstr: '1642909335',
          screen_name: '微博小秘书',
          description: '官方账号',
          followers_count: 168212552,
          verified: true,
          location: '北京',
        }],
        user: [
          { uid: 1642909335, nick: '微博小秘书' },
          { uid: 2016713117, nick: '微博客服' },
        ],
      },
    })),
  });
  assert.deepEqual(hits, [
    {
      uid: '1642909335', nickname: '微博小秘书', description: '官方账号',
      followers: 168212552, verified: true, location: '北京', via: 'search',
    },
    {
      uid: '2016713117', nickname: '微博客服', description: '',
      followers: 0, verified: false, location: null, via: 'search',
    },
  ]);
});

test('searchWeiboUsers：limit 截断，且夹在 1..20', async () => {
  const users = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, screen_name: `u${i}` }));
  const hits = await searchWeiboUsers('x', {
    limit: 3,
    fetchImpl: fakeFetch(() => jsonResponse({ data: { users } })),
  });
  assert.equal(hits.length, 3);

  const clamped = await searchWeiboUsers('x', {
    limit: 999,
    fetchImpl: fakeFetch(() => jsonResponse({ data: { users } })),
  });
  assert.equal(clamped.length, 20);

  const floored = await searchWeiboUsers('x', {
    limit: 0,
    fetchImpl: fakeFetch(() => jsonResponse({ data: { users } })),
  });
  assert.equal(floored.length, 1);
});

test('searchWeiboUsers：302/403 给登录态或风控提示', async () => {
  await assert.rejects(
    () => searchWeiboUsers('x', { fetchImpl: fakeFetch(() => new Response('', { status: 302 })) }),
    /被跳转（HTTP 302）.*登录态/,
  );
  await assert.rejects(
    () => searchWeiboUsers('x', { fetchImpl: fakeFetch(() => new Response('', { status: 403 })) }),
    /被拒绝（HTTP 403）/,
  );
});

test('searchWeiboUsers：非 JSON 响应报解析错', async () => {
  await assert.rejects(
    () => searchWeiboUsers('x', { fetchImpl: fakeFetch(() => new Response('<html>')) }),
    /不是合法 JSON/,
  );
});

test('searchWeiboUsers：suggest 有 cookie 时先走全站搜索，命中就不再请求匿名建议', async () => {
  const route = routeFetch({
    full: (_url, init) => {
      assert.equal(headersOf(init).cookie, 'SUB=secret; SUBP=secret');
      return jsonResponse({
        ok: 1,
        data: { cards: [{ user: { id: 42, screen_name: '弥月Mizuki', verified: false } }] },
      });
    },
  });
  const hits = await searchWeiboUsers('弥月Mizuki', {
    mode: 'suggest',
    cookie: 'SUB=secret; SUBP=secret',
    fetchImpl: route.fetchImpl,
    resolveUid: async () => {
      throw new Error('不应调用精确解析');
    },
  });
  assert.deepEqual(route.calls, ['full']);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.uid, '42');
  assert.equal(hits[0]!.via, 'full-search');
});

test('searchWeiboUsers：suggest 全站搜索空结果回落匿名建议，不跑精确解析', async () => {
  const route = routeFetch({
    full: () => jsonResponse({ ok: 1, data: { cards: [] } }),
    side: (_url, init) => {
      assert.equal(headersOf(init).cookie, undefined, '匿名建议始终不带登录 cookie');
      return jsonResponse({ data: { users: [{ id: 3, screen_name: '人气号' }] } });
    },
  });
  const hits = await searchWeiboUsers('长尾昵称', {
    mode: 'suggest',
    cookie: 'SUB=abc',
    fetchImpl: route.fetchImpl,
    resolveUid: async () => {
      throw new Error('suggest 不应调用精确解析');
    },
  });
  assert.deepEqual(route.calls, ['full', 'side']);
  assert.equal(hits[0]!.via, 'search');
});

test('searchWeiboUsers：suggest 全站搜索失败也回落匿名建议，不跑精确解析', async () => {
  const route = routeFetch({
    full: () => new Response('', { status: 302 }),
    side: () => jsonResponse({ data: { users: [{ id: 4, screen_name: '降级命中' }] } }),
  });
  const hits = await searchWeiboUsers('降级', {
    mode: 'suggest',
    cookie: 'SUB=secret',
    fetchImpl: route.fetchImpl,
    resolveUid: async () => {
      throw new Error('suggest 不应调用精确解析');
    },
  });
  assert.deepEqual(route.calls, ['full', 'side']);
  assert.equal(hits[0]!.uid, '4');
  assert.equal(hits[0]!.via, 'search');
});

test('searchWeiboUsers：suggest 两条链路都为空时给空数组，不跑精确解析', async () => {
  const route = routeFetch({
    full: () => jsonResponse({ ok: 1, data: { cards: [] } }),
    side: () => jsonResponse({ data: { users: [] } }),
  });
  const hits = await searchWeiboUsers('查无此人', {
    mode: 'suggest',
    cookie: 'SUB=abc',
    fetchImpl: route.fetchImpl,
    resolveUid: async () => {
      throw new Error('suggest 不应调用精确解析');
    },
  });
  assert.deepEqual(hits, []);
  assert.deepEqual(route.calls, ['full', 'side']);
});

test('searchWeiboUsers：suggest 无 cookie 只走匿名建议，不碰全站搜索', async () => {
  const route = routeFetch({
    side: () => jsonResponse({ data: { users: [{ id: 5, screen_name: '匿名命中' }] } }),
  });
  const hits = await searchWeiboUsers('匿名', {
    mode: 'suggest',
    fetchImpl: route.fetchImpl,
  });
  assert.deepEqual(route.calls, ['side']);
  assert.equal(hits[0]!.via, 'search');
});

test('searchWeiboUsers：suggest 两条链路都失败时报错，文本不含 cookie', async () => {
  const route = routeFetch({
    full: () => new Response('', { status: 403 }),
    side: () => new Response('', { status: 500 }),
  });
  await assert.rejects(
    () => searchWeiboUsers('x', {
      mode: 'suggest',
      cookie: 'SUB=secret; SUBP=secret',
      fetchImpl: route.fetchImpl,
    }),
    (e: Error) => {
      assert.match(e.message, /微博用户发现失败：登录搜索不可用（.*被拒绝（HTTP 403）.*匿名建议失败（微博搜索失败（HTTP 500））/);
      assert.equal(e.message.includes('SUB=secret'), false);
      return true;
    },
  );
  assert.deepEqual(route.calls, ['full', 'side']);
});

test('searchWeiboUsers：discover 登录搜索走 getIndex，注入 cookie 并解析卡片用户', async () => {
  let seen: { url?: string; init?: RequestInit } = {};
  const route = routeFetch({
    full: (url, init) => {
      seen = { url, init };
      return jsonResponse({
        ok: 1,
        data: {
          cards: [{
            card_type: 11,
            card_group: [
              {
                user: {
                  id: 1642909335,
                  idstr: '1642909335',
                  screen_name: 'MyGO_AveMujica',
                  description: '官方账号',
                  followers_count: 12345,
                  verified: true,
                  location: '东京',
                },
              },
              { user: { id: 2, screen_name: 'mygo粉丝团' } },
            ],
          }],
        },
      });
    },
  });

  const hits = await searchWeiboUsers('mygo', {
    cookie: 'SUB=abc; SUBP=def',
    fetchImpl: route.fetchImpl,
  });

  assert.deepEqual(route.calls, ['full']);
  assert.match(seen.url!, /^https:\/\/m\.weibo\.cn\/api\/container\/getIndex\?containerid=/);
  assert.match(decodeURIComponent(seen.url!), /containerid=100103type=3&q=mygo&page_type=searchall/);
  const headers = headersOf(seen.init);
  assert.equal(headers.cookie, 'SUB=abc; SUBP=def');
  assert.match(headers['user-agent']!, /iPhone|Mobile/);
  assert.equal(headers.referer, 'https://m.weibo.cn/');
  assert.deepEqual(hits, [
    {
      uid: '1642909335', nickname: 'MyGO_AveMujica', description: '官方账号',
      followers: 12345, verified: true, location: '东京', via: 'full-search',
    },
    {
      uid: '2', nickname: 'mygo粉丝团', description: '',
      followers: 0, verified: false, location: null, via: 'full-search',
    },
  ]);
});

test('searchWeiboUsers：全站搜索的 followers_count 字符串归一到数字（真实响应形态）', async () => {
  const route = routeFetch({
    full: () => jsonResponse({
      ok: 1,
      data: {
        cards: [{
          card_type: 11,
          card_group: [{
            user: {
              id: 7865636226,
              screen_name: '弥月Mizuki',
              description: '虚拟主播',
              followers_count: '2025',
              verified: false,
            },
          }],
        }],
      },
    }),
  });
  const hits = await searchWeiboUsers('弥月Mizuki', {
    mode: 'suggest',
    cookie: 'SUB=abc',
    fetchImpl: route.fetchImpl,
  });
  assert.equal(hits[0]!.uid, '7865636226');
  assert.equal(hits[0]!.followers, 2025);
  assert.equal(hits[0]!.verified, false);
  assert.equal(hits[0]!.via, 'full-search');
});

test('searchWeiboUsers：登录搜索命中时不回落匿名建议与解析器', async () => {
  const route = routeFetch({
    full: () => jsonResponse({ ok: 1, data: { cards: [{ user: { id: 7, screen_name: '命中' } }] } }),
  });
  const hits = await searchWeiboUsers('命中', {
    cookie: 'SUB=abc',
    fetchImpl: route.fetchImpl,
    resolveUid: async () => {
      throw new Error('不应调用精确解析');
    },
  });
  assert.deepEqual(route.calls, ['full']);
  assert.equal(hits[0]!.via, 'full-search');
});

test('searchWeiboUsers：登录搜索空结果回落匿名建议，不再走精确解析', async () => {
  const route = routeFetch({
    full: () => jsonResponse({ ok: 1, data: { cards: [] } }),
    side: () => jsonResponse({ data: { users: [{ id: 8, screen_name: '建议命中' }] } }),
  });
  const hits = await searchWeiboUsers('建议', {
    cookie: 'SUB=abc',
    fetchImpl: route.fetchImpl,
    resolveUid: async () => {
      throw new Error('匿名建议命中时不应调用精确解析');
    },
  });
  assert.deepEqual(route.calls, ['full', 'side']);
  assert.equal(hits[0]!.uid, '8');
  assert.equal(hits[0]!.via, 'search');
});

test('searchWeiboUsers：登录搜索与匿名建议都为空时走精确昵称解析', async () => {
  const route = routeFetch({
    full: () => jsonResponse({ ok: 1, data: { cards: [] } }),
    side: () => jsonResponse({ data: { users: [] } }),
  });
  let asked: string | null = null;
  const hits = await searchWeiboUsers('羊宫妃那', {
    cookie: 'SUB=abc',
    fetchImpl: route.fetchImpl,
    resolveUid: async (nick) => {
      asked = nick;
      return '1889464875';
    },
  });
  assert.deepEqual(route.calls, ['full', 'side']);
  assert.equal(asked, '羊宫妃那');
  assert.deepEqual(hits, [{
    uid: '1889464875',
    nickname: '羊宫妃那',
    description: '',
    followers: 0,
    verified: false,
    location: null,
    via: 'nickname',
  }]);
});

test('searchWeiboUsers：精确解析返回 null 时给空数组（空结果不等于账号不存在）', async () => {
  const route = routeFetch({
    full: () => jsonResponse({ ok: 1, data: { cards: [] } }),
    side: () => jsonResponse({ data: { users: [] } }),
  });
  const hits = await searchWeiboUsers('不存在的人', {
    cookie: 'SUB=abc',
    fetchImpl: route.fetchImpl,
    resolveUid: async () => null,
  });
  assert.deepEqual(hits, []);
});

test('searchWeiboUsers：登录搜索 302 时降级匿名建议', async () => {
  const route = routeFetch({
    full: () => new Response('', { status: 302, headers: { location: 'https://passport.weibo.cn/sso/login' } }),
    side: () => jsonResponse({ data: { users: [{ id: 9, screen_name: '降级命中' }] } }),
  });
  const hits = await searchWeiboUsers('降级', {
    cookie: 'SUB=secret',
    fetchImpl: route.fetchImpl,
  });
  assert.deepEqual(route.calls, ['full', 'side']);
  assert.equal(hits[0]!.via, 'search');
});

test('searchWeiboUsers：登录搜索非 JSON 响应也降级匿名建议', async () => {
  const route = routeFetch({
    full: () => new Response('<html>'),
    side: () => jsonResponse({ data: { users: [{ id: 10, screen_name: '降级命中' }] } }),
  });
  const hits = await searchWeiboUsers('降级', {
    cookie: 'SUB=abc',
    fetchImpl: route.fetchImpl,
  });
  assert.equal(hits[0]!.uid, '10');
  assert.deepEqual(route.calls, ['full', 'side']);
});

test('searchWeiboUsers：ok:0 视为登录失败并降级匿名建议', async () => {
  const route = routeFetch({
    full: () => jsonResponse({ ok: 0, msg: '登录' }),
    side: () => jsonResponse({ data: { users: [{ id: 11, screen_name: '降级命中' }] } }),
  });
  const hits = await searchWeiboUsers('降级', {
    cookie: 'SUB=abc',
    fetchImpl: route.fetchImpl,
  });
  assert.equal(hits[0]!.uid, '11');
  assert.deepEqual(route.calls, ['full', 'side']);
});

test('searchWeiboUsers：登录搜索失败且匿名建议也没有结果时抛错，不伪装成空结果', async () => {
  const route = routeFetch({
    full: () => jsonResponse({ ok: 0 }),
    side: () => jsonResponse({ data: { users: [] } }),
  });
  await assert.rejects(
    () => searchWeiboUsers('x', {
      cookie: 'SUB=secret',
      fetchImpl: route.fetchImpl,
      resolveUid: async () => null,
    }),
    (e: Error) => {
      assert.match(e.message, /登录搜索不可用/);
      assert.match(e.message, /匿名建议与精确解析均无结果/);
      assert.equal(e.message.includes('SUB=secret'), false);
      return true;
    },
  );
  assert.deepEqual(route.calls, ['full', 'side']);
});

test('searchWeiboUsers：登录搜索与匿名建议都失败时抛组合错误，错误文本不含 cookie', async () => {
  const route = routeFetch({
    full: () => new Response('', { status: 403 }),
    side: () => new Response('', { status: 500 }),
  });
  await assert.rejects(
    () => searchWeiboUsers('x', { cookie: 'SUB=secret; SUBP=secret', fetchImpl: route.fetchImpl }),
    (e: Error) => {
      assert.match(e.message, /登录搜索不可用（.*被拒绝（HTTP 403）.*匿名建议失败（微博搜索失败（HTTP 500））/);
      assert.equal(e.message.includes('SUB=secret'), false);
      return true;
    },
  );
});

test('searchWeiboUsers：精确解析抛错时不吞成空数组', async () => {
  const route = routeFetch({
    full: () => jsonResponse({ ok: 1, data: { cards: [] } }),
    side: () => jsonResponse({ data: { users: [] } }),
  });
  await assert.rejects(
    () => searchWeiboUsers('x', {
      cookie: 'SUB=abc',
      fetchImpl: route.fetchImpl,
      resolveUid: async () => {
        throw new Error('访客令牌申请失败');
      },
    }),
    /微博精确昵称解析失败：访客令牌申请失败/,
  );
});

test('searchWeiboUsers：登录搜索与匿名建议都为空且没有解析器时给空数组', async () => {
  const route = routeFetch({
    full: () => jsonResponse({ ok: 1, data: { cards: [] } }),
    side: () => jsonResponse({ data: { users: [] } }),
  });
  assert.deepEqual(
    await searchWeiboUsers('x', { cookie: 'SUB=abc', fetchImpl: route.fetchImpl }),
    [],
  );
});

test('searchWeiboUsers：匿名建议网络异常时抛错', async () => {
  await assert.rejects(
    () => searchWeiboUsers('x', {
      fetchImpl: fakeFetch(() => {
        throw new Error('socket hang up');
      }),
    }),
    /微博搜索请求失败：socket hang up/,
  );
});

test('searchWeiboUsers：空搜索词直接拒绝', async () => {
  await assert.rejects(() => searchWeiboUsers('   '), /搜索词不能为空/);
});
