/**
 * 微博用户搜索单测（不走网络）：匿名侧栏搜索的解析、去重与登录墙文案。
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

test('searchWeiboUsers：走 ajax/side/search，带浏览器 UA 与 referer', async () => {
  let seen: { url?: string; init?: RequestInit } = {};
  const hits = await searchWeiboUsers('mygo', {
    fetchImpl: fakeFetch((url, init) => {
      seen = { url, init };
      return jsonResponse({ data: { users: [] } });
    }),
  });
  assert.match(seen.url!, /^https:\/\/weibo\.com\/ajax\/side\/search\?q=mygo$/);
  const headers = seen.init!.headers as Record<string, string>;
  assert.match(headers['user-agent']!, /Mozilla\/5\.0/);
  assert.equal(headers.referer, 'https://weibo.com/');
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

test('searchWeiboUsers：limit 截断', async () => {
  const users = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, screen_name: `u${i}` }));
  const hits = await searchWeiboUsers('x', { limit: 3, fetchImpl: fakeFetch(() => jsonResponse({ data: { users } })) });
  assert.equal(hits.length, 3);
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
