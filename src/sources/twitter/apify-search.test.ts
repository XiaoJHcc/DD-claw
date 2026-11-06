/**
 * Apify X People 搜索单测（不走网络）：请求构造、run 轮询、字段映射、
 * 空结果 / Actor 失败 / 超时 / token 脱敏。Actor 行为见
 * https://apify.com/arjun_code/x-twitter-people-search-scraper
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APIFY_PEOPLE_SEARCH_LIMIT_MAX,
  searchXAccountsViaApify,
  type ApifyFetch,
} from './apify-search.js';

const TOKEN = 'apify_api_SECRET_token_123';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function run(status: string, opts: { datasetId?: string; message?: string } = {}): unknown {
  return {
    data: {
      id: 'run_1',
      status,
      defaultDatasetId: opts.datasetId ?? 'dataset_1',
      ...(opts.message ? { statusMessage: opts.message } : {}),
    },
  };
}

interface Call {
  url: string;
  init?: RequestInit;
}

function scripted(
  handler: (url: string, init: RequestInit | undefined, call: number) => Response | Promise<Response>,
): { calls: Call[]; fetchImpl: ApifyFetch } {
  const calls: Call[] = [];
  const fetchImpl: ApifyFetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  return { calls, fetchImpl };
}

/** run 同步成功 + 指定数据集 items 的最小剧本 */
function succeededWithItems(items: unknown[]): { calls: Call[]; fetchImpl: ApifyFetch } {
  return scripted((url) => {
    if (url.includes('/items?')) return json(items);
    return json(run('SUCCEEDED'));
  });
}

test('searchXAccountsViaApify：POST 单条查询 + limit 夹紧，同步完成即读数据集', async () => {
  const { calls, fetchImpl } = scripted((url) => {
    if (url.includes('/items?')) return json([]);
    return json(run('SUCCEEDED'));
  });
  const out = await searchXAccountsViaApify('  羊宮妃那  ', {
    token: TOKEN,
    limit: 99,
    fetchImpl,
  });
  assert.deepEqual(out, []);
  assert.equal(calls.length, 2);

  const [start, items] = calls;
  assert.match(
    start!.url,
    /\/v2\/acts\/arjun_code~x-twitter-people-search-scraper\/runs\?token=apify_api_SECRET_token_123&waitForFinish=0$/,
    '立即返回 run 句柄，等待节奏由轮询参数控制',
  );
  assert.equal(start!.init!.method, 'POST');
  const headers = start!.init!.headers as Record<string, string>;
  assert.equal(headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(String(start!.init!.body)), {
    searchQueries: ['羊宮妃那'],
    maxUsersPerQuery: APIFY_PEOPLE_SEARCH_LIMIT_MAX,
  });
  assert.match(items!.url, /\/datasets\/dataset_1\/items\?token=.*&clean=true&format=json$/);
});

test('searchXAccountsViaApify：limit 下限夹到 1', async () => {
  const { calls, fetchImpl } = succeededWithItems([]);
  await searchXAccountsViaApify('x', { token: TOKEN, limit: 0, fetchImpl });
  assert.equal(JSON.parse(String(calls[0]!.init!.body)).maxUsersPerQuery, 1);
});

test('searchXAccountsViaApify：RUNNING 时按 pollIntervalMs 轮询到 SUCCEEDED', async () => {
  const { calls, fetchImpl } = scripted((url, _init, call) => {
    if (url.includes('/items?')) return json([{ status: 'success', screen_name: 'late_one' }]);
    if (call === 1) return json(run('RUNNING'));
    if (call === 2) return json(run('RUNNING'));
    return json(run('SUCCEEDED'));
  });
  const started = Date.now();
  const out = await searchXAccountsViaApify('late', {
    token: TOKEN,
    pollIntervalMs: 10,
    runTimeoutMs: 5_000,
    fetchImpl,
  });
  const elapsed = Date.now() - started;
  assert.deepEqual(out.map((c) => c.screenName), ['late_one']);
  assert.equal(calls.length, 4, 'POST + 两次轮询 + 数据集');
  assert.match(calls[1]!.url, /\/actor-runs\/run_1\?token=/);
  assert.match(calls[2]!.url, /\/actor-runs\/run_1\?token=/);
  assert.doesNotMatch(calls[1]!.url, /waitForFinish/, '轮询不再带 waitForFinish');
  assert.ok(elapsed >= 15, `至少等过两个轮询间隔（实际 ${elapsed}ms）`);
});

test('searchXAccountsViaApify：success 字段映射、蓝标、头像放大与 profile url 兜底', async () => {
  const { fetchImpl } = succeededWithItems([
    {
      status: 'success',
      search_query: 'AI researcher',
      user_id: '891077171673931776',
      screen_name: 'berkeley_ai',
      profile_url: 'https://x.com/berkeley_ai',
      name: 'Berkeley AI Research',
      description: 'AI research at Berkeley.',
      followers_count: 288339,
      tweets_count: 1588,
      verified: false,
      is_blue_verified: true,
      profile_image_url: 'https://pbs.twimg.com/profile_images/1/abc_normal.jpg',
      location: 'Berkeley, CA',
      website_url: 'http://bair.berkeley.edu/',
    },
    { status: 'no_results', search_query: 'other' },
    {
      status: 'success',
      screen_name: '@min_user',
      profile_url: 'javascript:alert(1)',
      name: '',
      followers_count: '123',
    },
  ]);
  const out = await searchXAccountsViaApify('AI researcher', { token: TOKEN, fetchImpl });
  assert.equal(out.length, 2);

  const full = out[0]!;
  assert.equal(full.screenName, 'berkeley_ai');
  assert.equal(full.name, 'Berkeley AI Research');
  assert.equal(full.url, 'https://x.com/berkeley_ai');
  assert.equal(full.exists, true);
  assert.deepEqual(full.sources, []);
  assert.equal(full.provider, 'apify');
  assert.equal(full.userId, '891077171673931776');
  assert.equal(full.description, 'AI research at Berkeley.');
  assert.equal(full.followers, 288339);
  assert.equal(full.tweets, 1588);
  assert.equal(full.verified, true, 'is_blue_verified 也计入认证');
  assert.equal(full.avatar, 'https://pbs.twimg.com/profile_images/1/abc_400x400.jpg');
  assert.equal(full.location, 'Berkeley, CA');
  assert.equal(full.website, 'http://bair.berkeley.edu/');
  assert.equal(full.matchedQuery, 'AI researcher');

  const minimal = out[1]!;
  assert.equal(minimal.screenName, 'min_user', '去掉句柄前的 @');
  assert.equal(minimal.url, 'https://x.com/min_user', '非法 profile_url 用 handle 拼');
  assert.equal(minimal.name, null, '空显示名归一成 null');
  assert.equal(minimal.followers, null, '非数字粉丝数不猜成 0');
  assert.equal(minimal.verified, false);
  assert.equal(minimal.avatar, null);
  assert.equal(minimal.location, null);
  assert.equal(minimal.website, null);
  assert.equal(minimal.tweets, null);
  assert.equal(minimal.userId, undefined);
  assert.equal(minimal.description, undefined);
  assert.equal(minimal.matchedQuery, undefined);
});

test('searchXAccountsViaApify：按 handle 去重并截断到 limit', async () => {
  const { fetchImpl } = succeededWithItems([
    { status: 'success', screen_name: 'First_One', followers_count: 10 },
    { status: 'success', screen_name: 'first_one', followers_count: 20 },
    { status: 'success', screen_name: 'second_one' },
    { status: 'success', screen_name: 'third_one' },
  ]);
  const out = await searchXAccountsViaApify('x', { token: TOKEN, limit: 2, fetchImpl });
  assert.deepEqual(out.map((c) => c.screenName), ['First_One', 'second_one']);
  assert.equal(out[0]!.followers, 10, '保留先出现的记录');
});

test('searchXAccountsViaApify：空数据集与只有 no_results 都返回 []', async () => {
  const empty = succeededWithItems([]);
  assert.deepEqual(await searchXAccountsViaApify('x', { token: TOKEN, fetchImpl: empty.fetchImpl }), []);

  const noResults = succeededWithItems([
    { status: 'no_results', search_query: 'example keyword', message: 'No X People profiles matched.' },
  ]);
  assert.deepEqual(
    await searchXAccountsViaApify('example keyword', { token: TOKEN, fetchImpl: noResults.fetchImpl }),
    [],
  );
});

test('searchXAccountsViaApify：run FAILED / TIMED-OUT 给中文错误', async () => {
  const failed = scripted(() => json(run('FAILED', { message: 'actor crashed' })));
  await assert.rejects(
    () => searchXAccountsViaApify('x', { token: TOKEN, fetchImpl: failed.fetchImpl }),
    /Apify 运行失败（状态 FAILED）：actor crashed/,
  );

  const timedOut = scripted(() => json(run('TIMED-OUT')));
  await assert.rejects(
    () => searchXAccountsViaApify('x', { token: TOKEN, fetchImpl: timedOut.fetchImpl }),
    /Apify 运行超时（状态 TIMED-OUT）/,
  );
});

test('searchXAccountsViaApify：request_failed / partial / invalid_input 报错，不把失败当空', async () => {
  const requestFailed = succeededWithItems([
    { status: 'request_failed', search_query: 'x', message: 'X People search could not be completed.' },
  ]);
  await assert.rejects(
    () => searchXAccountsViaApify('x', { token: TOKEN, fetchImpl: requestFailed.fetchImpl }),
    /Apify People 搜索请求失败：X People search could not be completed\./,
  );

  const partial = succeededWithItems([
    { status: 'success', screen_name: 'partially_ok' },
    { status: 'partial', search_query: 'x', message: 'Only first pages saved.' },
  ]);
  await assert.rejects(
    () => searchXAccountsViaApify('x', { token: TOKEN, fetchImpl: partial.fetchImpl }),
    /部分失败：Only first pages saved\.（另有 1 条/,
  );

  const invalid = succeededWithItems([{ status: 'invalid_input', message: 'searchQueries is empty' }]);
  await assert.rejects(
    () => searchXAccountsViaApify('x', { token: TOKEN, fetchImpl: invalid.fetchImpl }),
    /Apify 拒绝了搜索输入：searchQueries is empty/,
  );
});

test('searchXAccountsViaApify：run 一直 RUNNING 时按 runTimeoutMs 超时', async () => {
  const { calls, fetchImpl } = scripted(() => json(run('RUNNING')));
  const started = Date.now();
  await assert.rejects(
    () => searchXAccountsViaApify('x', {
      token: TOKEN,
      runTimeoutMs: 40,
      pollIntervalMs: 5,
      fetchImpl,
    }),
    /Apify People 搜索超时（40ms 内未完成）/,
  );
  assert.ok(Date.now() - started < 1_000, '超时后不再继续轮询');
  assert.ok(calls.length >= 2, 'POST 后至少轮询过一次');
});

test('searchXAccountsViaApify：HTTP 错误给中文提示，token 不出现在错误里', async () => {
  const unauthorized = scripted(() => json({ error: { message: `bad token ${TOKEN}` } }, 401));
  const e1 = await searchXAccountsViaApify('x', { token: TOKEN, fetchImpl: unauthorized.fetchImpl })
    .then(() => null, (e: Error) => e);
  assert.ok(e1);
  assert.match(e1.message, /HTTP 401/);
  assert.doesNotMatch(e1.message, /SECRET/);

  const boom = scripted((url) => {
    throw new Error(`connect failed: ${url}`);
  });
  const e2 = await searchXAccountsViaApify('x', { token: TOKEN, fetchImpl: boom.fetchImpl })
    .then(() => null, (e: Error) => e);
  assert.ok(e2);
  assert.match(e2.message, /Apify .*失败：connect failed/);
  assert.doesNotMatch(e2.message, /SECRET/, 'fetch 异常里带 URL 也不泄露 token');
});

test('searchXAccountsViaApify：run statusMessage 里的 token 也脱敏', async () => {
  const { fetchImpl } = scripted(() => json(run('FAILED', { message: `token ${TOKEN} rejected` })));
  const err = await searchXAccountsViaApify('x', { token: TOKEN, fetchImpl })
    .then(() => null, (e: Error) => e);
  assert.ok(err);
  assert.match(err.message, /Apify 运行失败/);
  assert.doesNotMatch(err.message, /SECRET/);
});

test('searchXAccountsViaApify：token 未配置直接报错且不发请求', async () => {
  const { calls, fetchImpl } = succeededWithItems([]);
  await assert.rejects(
    () => searchXAccountsViaApify('x', { token: '   ', fetchImpl }),
    /Apify token 未配置/,
  );
  assert.equal(calls.length, 0);
});

test('searchXAccountsViaApify：数据集响应异常时明确报错', async () => {
  const notArray = scripted((url) => (
    url.includes('/items?') ? json({ items: [] }) : json(run('SUCCEEDED'))
  ));
  await assert.rejects(
    () => searchXAccountsViaApify('x', { token: TOKEN, fetchImpl: notArray.fetchImpl }),
    /Apify 数据集响应格式异常/,
  );

  const serverError = scripted((url) => (
    url.includes('/items?') ? json({ error: { message: 'dataset unavailable' } }, 500) : json(run('SUCCEEDED'))
  ));
  await assert.rejects(
    () => searchXAccountsViaApify('x', { token: TOKEN, fetchImpl: serverError.fetchImpl }),
    /Apify 请求失败（HTTP 500）：dataset unavailable/,
  );
});
