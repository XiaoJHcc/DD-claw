/**
 * DeepSeek Search 客户端单测（不走网络）：请求形状、结果映射、错误文案与一次重试。
 * 端点/计费/限流的实测证据见 docs/research/web-search.md。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchWeb } from './web.js';
import type { FetchLike } from '../analysis/providers.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function recorder(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { calls, fetchImpl };
}

test('searchWeb：POST /v1/tools/search，Bearer key，query/count 原样进 body', async () => {
  const { calls, fetchImpl } = recorder(() => jsonResponse({ results: [] }));
  await searchWeb('sk-test', ' 羊宮妃那 ', { count: 3, fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://api.deepseek.com/v1/tools/search');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, 'Bearer sk-test');
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { query: '羊宮妃那', count: 3 });
});

test('searchWeb：结果映射 + 非 http(s) / 缺 url 的条目丢弃', async () => {
  const { fetchImpl } = recorder(() => jsonResponse({
    results: [
      { title: ' A ', url: 'https://a.example/1', snippet: 's1', summary: 'm1', site_name: '站点', date: '2026-10-01T00:00:00+00:00' },
      { title: 'B', url: 'ftp://b.example', snippet: 's2' },
      { title: 'C', url: '', snippet: 's3' },
    ],
  }));
  const out = await searchWeb('k', 'q', { fetchImpl });
  assert.deepEqual(out, [{
    title: 'A', url: 'https://a.example/1', snippet: 's1', summary: 'm1',
    site: '站点', date: '2026-10-01T00:00:00+00:00',
  }]);
});

test('searchWeb：空结果 = 空数组（不是错误）', async () => {
  const { fetchImpl } = recorder(() => jsonResponse({ results: [] }));
  assert.deepEqual(await searchWeb('k', 'q', { fetchImpl }), []);
});

test('searchWeb：count 夹到 1~10（0 → 1，99 → 10）', async () => {
  const { calls, fetchImpl } = recorder(() => jsonResponse({ results: [] }));
  await searchWeb('k', 'q', { count: 0, fetchImpl });
  await searchWeb('k', 'q', { count: 99, fetchImpl });
  assert.equal(JSON.parse(calls[0]!.init.body as string).count, 1);
  assert.equal(JSON.parse(calls[1]!.init.body as string).count, 10);
});

test('searchWeb：401/402/429 各给可执行中文提示', async () => {
  const cases: Array<[number, RegExp]> = [
    [401, /key 无效/],
    [402, /余额不足/],
    [429, /过于频繁/],
  ];
  for (const [status, pattern] of cases) {
    const { fetchImpl } = recorder(() => new Response('{"error":{"message":"x"}}', { status }));
    await assert.rejects(() => searchWeb('k', 'q', { fetchImpl }), pattern);
  }
});

test('searchWeb：5xx 先重试一次，仍失败才报错', async () => {
  let n = 0;
  const ok = recorder(() => {
    n += 1;
    return n === 1 ? new Response('boom', { status: 503 }) : jsonResponse({ results: [] });
  });
  assert.deepEqual(await searchWeb('k', 'q', { fetchImpl: ok.fetchImpl }), []);
  assert.equal(ok.calls.length, 2, '第一次 503 → 重试');

  const bad = recorder(() => new Response('boom', { status: 500 }));
  await assert.rejects(() => searchWeb('k', 'q', { fetchImpl: bad.fetchImpl }), /暂时不可用（HTTP 500）/);
  assert.equal(bad.calls.length, 2, '最多重试一次');
});

test('searchWeb：400 把网关错误信息带出来', async () => {
  const { fetchImpl } = recorder(() => new Response(
    JSON.stringify({ error: { message: "'count' must be between 1 and 50" } }),
    { status: 400 },
  ));
  await assert.rejects(() => searchWeb('k', 'q', { fetchImpl }), /搜索参数不合法.*between 1 and 50/);
});

test('searchWeb：响应不是 JSON / 网络异常都给中文错误', async () => {
  const notJson = recorder(() => new Response('<html>', { status: 200 }));
  await assert.rejects(() => searchWeb('k', 'q', { fetchImpl: notJson.fetchImpl }), /不是合法 JSON/);

  const netErr: FetchLike = async () => {
    throw new Error('ECONNRESET');
  };
  await assert.rejects(() => searchWeb('k', 'q', { fetchImpl: netErr }), /搜索请求失败：ECONNRESET/);
});

test('searchWeb：空检索词直接拒绝（不打网络）', async () => {
  const { calls, fetchImpl } = recorder(() => jsonResponse({ results: [] }));
  await assert.rejects(() => searchWeb('k', '   ', { fetchImpl }), /搜索词不能为空/);
  assert.equal(calls.length, 0);
});
