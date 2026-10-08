import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OpenAiProvider, LlmRouter, AllProvidersExhaustedError, ProviderCallError, createLlmRouter,
  listLlmProviders, saveLlmProviders, deriveRoutes,
  isLlmEnabled, setLlmEnabled, dbKeysOf,
  type ChatMessage, type FetchLike,
} from './providers.js';
import { Db } from '../core/db.js';
import type { LlmProviderConfig } from '../config/index.js';

function spec(over: Partial<LlmProviderConfig> = {}): LlmProviderConfig {
  return {
    name: 'p1', baseURL: 'https://api.example.com/v1', model: 'm1',
    vision: false, keyEnvs: [], enabled: true, structuredOutput: 'schema',
    api: 'chat-completions',
    ...over,
  };
}

/** 造一个 OpenAI 信封响应；content 原样进 message.content */
function okResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/** 记录请求并按队列返回响应（或抛错）的 fake fetch */
function fakeFetch(queue: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (!next) throw new Error('fake fetch 队列空');
    if (next instanceof Error) throw next;
    return next.clone();
  };
  return { fn, calls };
}

const OPTS = { timeoutMs: 5000, circuitThreshold: 2, circuitCooldownMs: 60_000, retryBackoffMs: [0, 0] };

function provider(
  over: Partial<LlmProviderConfig> = {},
  keys: string[] = ['test-key'],
  fetchFn?: FetchLike,
  now?: () => number,
): OpenAiProvider {
  // 这些用例不关心 key 内容，空数组 = 「无所谓」给个占位 key
  //（非 loopback 端点无 key 会被判「缺 key」跳过；要测缺 key 走 createLlmRouter 的用例）
  return new OpenAiProvider(spec(over), keys.length ? keys : ['test-key'], { ...OPTS, fetchFn, now });
}

const textMsg: ChatMessage[] = [{ role: 'user', content: '你好' }];
const imgMsg: ChatMessage[] = [{
  role: 'user',
  content: [
    { type: 'text', text: '这是什么' },
    { type: 'image_url', image_url: { url: 'https://i0.hdslb.com/x.jpg' } },
  ],
}];

// ---- 路由 ----

test('纯文本走 text 路由，不碰 vision provider', async () => {
  const { fn: textFetch, calls } = fakeFetch([okResponse('{"a":1}')]);
  const { fn: visionFetch, calls: visionCalls } = fakeFetch([okResponse('{"a":2}')]);
  const router = new LlmRouter(
    [provider({ name: 't' }, [], textFetch), provider({ name: 'v', vision: true }, [], visionFetch)],
    { text: ['t'], vision: ['v'] },
  );
  const r = await router.completeJson<{ a: number }>({ messages: textMsg });
  assert.equal(r.a, 1);
  assert.equal(calls.length, 1);
  assert.equal(visionCalls.length, 0);
});

test('含 image_url 自动走 vision 路由；显式 vision=false 可覆盖', async () => {
  const { fn: textFetch, calls: textCalls } = fakeFetch([okResponse('{"a":1}')]);
  const { fn: visionFetch, calls: visionCalls } = fakeFetch([okResponse('{"a":2}')]);
  const router = new LlmRouter(
    [provider({ name: 't' }, [], textFetch), provider({ name: 'v', vision: true }, [], visionFetch)],
    { text: ['t'], vision: ['v'] },
  );
  const r1 = await router.completeJson<{ a: number }>({ messages: imgMsg });
  assert.equal(r1.a, 2, '有图自动走 vision');
  const r2 = await router.completeJson<{ a: number }>({ messages: imgMsg, vision: false });
  assert.equal(r2.a, 1, '显式 vision=false 强制 text');
  assert.equal(textCalls.length, 1);
  assert.equal(visionCalls.length, 1);
});

test('路由为空直接抛 AllProvidersExhaustedError，不发请求', async () => {
  const router = new LlmRouter([], { text: [], vision: [] });
  await assert.rejects(
    router.completeJson({ messages: textMsg }),
    (e) => e instanceof AllProvidersExhaustedError && e.route === 'text',
  );
});

// ---- 降级与熔断 ----

test('首个 provider 失败降级到下一个；失败原因不含 key', async () => {
  const { fn: f1 } = fakeFetch([new Response('quota', { status: 429 })]);
  const { fn: f2, calls } = fakeFetch([okResponse('{"ok":true}')]);
  const router = new LlmRouter(
    [provider({ name: 'a' }, ['k1'], f1), provider({ name: 'b' }, ['k2'], f2)],
    { text: ['a', 'b'], vision: [] },
  );
  const r = await router.completeJson<{ ok: boolean }>({ messages: textMsg });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
});

test('连续失败到阈值打开熔断，冷却期内跳过，冷却结束恢复', async () => {
  let clock = 0;
  const now = () => clock;
  // 前两次失败 → 熔断；第三次应在熔断期被跳过；时钟前进后第四次恢复。
  // 用 400（非可重试）让每次 completeJson 只发一次请求，隔离熔断机制本身；
  // 可重试失败的重试耗尽后计入熔断由「429 重试耗尽」用例覆盖
  const { fn, calls } = fakeFetch([
    new Response('x', { status: 400 }),
    new Response('x', { status: 400 }),
    okResponse('{"ok":true}'),
  ]);
  const p = provider({ name: 'a' }, [], fn, now);
  const router = new LlmRouter([p], { text: ['a'], vision: [] });

  await assert.rejects(router.completeJson({ messages: textMsg }), AllProvidersExhaustedError);
  await assert.rejects(router.completeJson({ messages: textMsg }), AllProvidersExhaustedError);
  assert.equal(calls.length, 2, '两次失败');
  assert.equal(p.status(), '熔断中');

  await assert.rejects(router.completeJson({ messages: textMsg }), AllProvidersExhaustedError);
  assert.equal(calls.length, 2, '熔断期内不再发请求');

  clock += 60_001;
  assert.equal(p.status(), 'ready');
  const r = await router.completeJson<{ ok: boolean }>({ messages: textMsg });
  assert.equal(r.ok, true, '冷却结束后恢复');
  assert.equal(p.status(), 'ready');
});

test('parse（zod 校验）失败同样计入熔断并降级', async () => {
  const { fn: f1 } = fakeFetch([okResponse('{"wrong":1}')]);
  const { fn: f2 } = fakeFetch([okResponse('{"v":2}')]);
  const router = new LlmRouter(
    [provider({ name: 'a' }, [], f1), provider({ name: 'b' }, [], f2)],
    { text: ['a', 'b'], vision: [] },
  );
  const parse = (raw: unknown): { v: number } => {
    const o = raw as { v?: number };
    if (typeof o.v !== 'number') throw new Error('schema 不符');
    return { v: o.v };
  };
  const r = await router.completeJson({ messages: textMsg }, parse);
  assert.equal(r.v, 2);
});

// ---- 可重试失败：就地重试，重试耗尽才计入熔断 ----

test('429 后 200：重试成功，不计失败', async () => {
  const { fn, calls } = fakeFetch([
    new Response('quota', { status: 429 }),
    okResponse('{"ok":true}'),
  ]);
  const p = provider({ name: 'a' }, [], fn);
  const router = new LlmRouter([p], { text: ['a'], vision: [] });
  const r = await router.completeJson<{ ok: boolean }>({ messages: textMsg });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2, '重试了一次');
  assert.equal(p.status(), 'ready', '重试成功不进熔断统计');
});

test('网络异常（fetch 抛错）后重试成功', async () => {
  const { fn, calls } = fakeFetch([new Error('socket hangup'), okResponse('{"ok":true}')]);
  const router = new LlmRouter([provider({ name: 'a' }, [], fn)], { text: ['a'], vision: [] });
  const r = await router.completeJson<{ ok: boolean }>({ messages: textMsg });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2);
});

test('正文非法 JSON 后重试成功（模型输出抽风是瞬时故障）', async () => {
  const { fn, calls } = fakeFetch([okResponse('好的，主播在唱歌'), okResponse('{"v":1}')]);
  const router = new LlmRouter([provider({ name: 'a' }, [], fn)], { text: ['a'], vision: [] });
  const r = await router.completeJson<{ v: number }>({ messages: textMsg });
  assert.equal(r.v, 1);
  assert.equal(calls.length, 2);
});

test('400 是确定性错误：不重试，直接抛出', async () => {
  const { fn, calls } = fakeFetch([new Response('bad request', { status: 400 })]);
  const p = provider({ name: 'a' }, [], fn);
  await assert.rejects(
    p.complete({ messages: textMsg }),
    (e) => e instanceof ProviderCallError && e.retryable === false,
  );
  assert.equal(calls.length, 1, '非可重试错误只发一次请求');
});

test('429 重试耗尽（共 3 次尝试）才抛错，且一次 completeJson 只计一次失败', async () => {
  const { fn, calls } = fakeFetch([new Response('quota', { status: 429 })]); // 单元素队列无限重复
  const p = provider({ name: 'a' }, [], fn); // OPTS.circuitThreshold = 2
  const router = new LlmRouter([p], { text: ['a'], vision: [] });

  await assert.rejects(router.completeJson({ messages: textMsg }), AllProvidersExhaustedError);
  assert.equal(calls.length, 3, '1 + MAX_RETRIES 次尝试');
  assert.equal(p.status(), 'ready', '重试耗尽只算一次失败，未到阈值不熔断');

  await assert.rejects(router.completeJson({ messages: textMsg }), AllProvidersExhaustedError);
  assert.equal(calls.length, 6);
  assert.equal(p.status(), '熔断中', '第二次真失败到阈值才熔断');
});

test('重试轮换池内下一个 key', async () => {
  const { fn, calls } = fakeFetch([
    new Response('x', { status: 500 }),
    okResponse('{}'),
  ]);
  const router = new LlmRouter(
    [provider({ name: 'a' }, ['K1', 'K2'], fn)],
    { text: ['a'], vision: [] },
  );
  await router.completeJson({ messages: textMsg });
  const auths = calls.map((c) => (c.init.headers as Record<string, string>).Authorization);
  assert.deepEqual(auths, ['Bearer K1', 'Bearer K2'], '重试换了下一个 key');
});

// ---- key 池与鉴权 ----

test('多 key 轮询，Authorization 头轮换', async () => {
  const { fn, calls } = fakeFetch([okResponse('{}')]);
  const router = new LlmRouter([provider({ name: 'a' }, ['K1', 'K2'], fn)], { text: ['a'], vision: [] });
  await router.completeJson({ messages: textMsg });
  await router.completeJson({ messages: textMsg });
  await router.completeJson({ messages: textMsg });
  const auths = calls.map((c) => (c.init.headers as Record<string, string>).Authorization);
  assert.deepEqual(auths, ['Bearer K1', 'Bearer K2', 'Bearer K1']);
});

test('keyEnvs 声明了但 env 全空 → 标缺 key 并跳过', async () => {
  const { fn, calls } = fakeFetch([okResponse('{"ok":true}')]);
  const router = createLlmRouter(
    {
      requestTimeoutMs: 5000, circuitThreshold: 2, circuitCooldownMs: 60_000,
      providers: [
        spec({ name: 'cloud', keyEnvs: ['NOPE_KEY_1', 'NOPE_KEY_2'] }),
        spec({ name: 'local', baseURL: 'http://127.0.0.1:1234/v1' }),
      ],
    },
    () => [], // 无 key：云端标「缺 key」跳过，本地无鉴权端点 ready
    { fetchFn: fn },
  );
  const d = router.describe();
  assert.match(d.find((s) => s.name === 'cloud')!.status, /缺 key/);
  assert.equal(d.find((s) => s.name === 'local')!.status, 'ready');
  const r = await router.completeJson<{ ok: boolean }>({ messages: textMsg });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1, '只打了 local');
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, undefined, '无 key 端点不带 Authorization');
});

test('createLlmRouter 从 keysOf 解析 key', () => {
  const router = createLlmRouter(
    {
      requestTimeoutMs: 5000, circuitThreshold: 2, circuitCooldownMs: 60_000,
      providers: [spec({ name: 'ds' })],
    },
    () => ['sk-test'],
  );
  assert.equal(router.describe()[0]!.status, 'ready');
});

// ---- 请求体 ----

test('structuredOutput=schema 下发 json_schema；object 下发 json_object；none 不带', async () => {
  const schema = { name: 's', schema: { type: 'object' } };
  for (const [mode, expectFmt] of [
    ['schema', 'json_schema'],
    ['object', 'json_object'],
  ] as const) {
    const { fn, calls } = fakeFetch([okResponse('{}')]);
    const router = new LlmRouter(
      [provider({ name: 'a', structuredOutput: mode }, [], fn)],
      { text: ['a'], vision: [] },
    );
    await router.completeJson({ messages: textMsg, jsonSchema: schema });
    const body = JSON.parse(calls[0]!.init.body as string);
    assert.equal(body.response_format?.type, expectFmt, mode);
  }
  const { fn, calls } = fakeFetch([okResponse('{}')]);
  const router = new LlmRouter(
    [provider({ name: 'a', structuredOutput: 'none' }, [], fn)],
    { text: ['a'], vision: [] },
  );
  await router.completeJson({ messages: textMsg, jsonSchema: schema });
  const body = JSON.parse(calls[0]!.init.body as string);
  assert.equal(body.response_format, undefined, 'none 不下发 response_format');
});

test('响应正文带 ```json 围栏也能解析', async () => {
  const { fn } = fakeFetch([okResponse('```json\n{"a": 7}\n```')]);
  const router = new LlmRouter(
    [provider({ name: 'a', structuredOutput: 'none' }, [], fn)],
    { text: ['a'], vision: [] },
  );
  const r = await router.completeJson<{ a: number }>({ messages: textMsg });
  assert.equal(r.a, 7);
});

test('正文不是 JSON 计入失败并降级', async () => {
  const { fn: f1 } = fakeFetch([okResponse('好的，主播在唱歌')]);
  const { fn: f2 } = fakeFetch([okResponse('{"v":1}')]);
  const router = new LlmRouter(
    [provider({ name: 'a' }, [], f1), provider({ name: 'b' }, [], f2)],
    { text: ['a', 'b'], vision: [] },
  );
  const r = await router.completeJson<{ v: number }>({ messages: textMsg });
  assert.equal(r.v, 1);
});

// ---- Responses API（api=responses）----

/** 造一个 Responses API 信封响应；text 进 output[0] 的 output_text */
function okResponsesApi(text: string): Response {
  return new Response(
    JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

test('api=responses 打 /responses：system 进 instructions，text.format 下发 json_schema', async () => {
  const { fn, calls } = fakeFetch([okResponsesApi('{"a":1}')]);
  const router = new LlmRouter(
    [provider({ name: 'a', api: 'responses' }, [], fn)],
    { text: ['a'], vision: [] },
  );
  const r = await router.completeJson<{ a: number }>({
    messages: [{ role: 'system', content: '你是分类器' }, ...textMsg],
    jsonSchema: { name: 's', schema: { type: 'object' } },
    maxTokens: 100,
  });
  assert.equal(r.a, 1);
  assert.match(calls[0]!.url, /\/responses$/, '不打 /chat/completions');
  const body = JSON.parse(calls[0]!.init.body as string);
  assert.equal(body.instructions, '你是分类器');
  assert.deepEqual(body.input, [{ role: 'user', content: [{ type: 'input_text', text: '你好' }] }]);
  assert.equal(body.text.format.type, 'json_schema');
  assert.equal(body.max_output_tokens, 100);
  assert.equal(body.messages, undefined);
});

test('api=responses 图片部件换算成 input_image；output_text 便捷字段优先', async () => {
  const { fn, calls } = fakeFetch([new Response(
    JSON.stringify({ output_text: '{"a":3}', output: [] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )]);
  const router = new LlmRouter(
    [provider({ name: 'a', api: 'responses', vision: true }, [], fn)],
    { text: ['a'], vision: ['a'] },
  );
  const r = await router.completeJson<{ a: number }>({ messages: imgMsg });
  assert.equal(r.a, 3);
  const body = JSON.parse(calls[0]!.init.body as string);
  assert.deepEqual(body.input[0].content, [
    { type: 'input_text', text: '这是什么' },
    { type: 'input_image', image_url: 'https://i0.hdslb.com/x.jpg' },
  ]);
});

test('api=responses 响应缺 output_text 计入失败并降级', async () => {
  const { fn: f1 } = fakeFetch([new Response(
    JSON.stringify({ output: [] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )]);
  const { fn: f2 } = fakeFetch([okResponse('{"v":1}')]);
  const router = new LlmRouter(
    [provider({ name: 'a', api: 'responses' }, [], f1), provider({ name: 'b' }, [], f2)],
    { text: ['a', 'b'], vision: [] },
  );
  const r = await router.completeJson<{ v: number }>({ messages: textMsg });
  assert.equal(r.v, 1);
});

// ---- key 热更新（面板填写后 refreshKeys）----

test('refreshKeys：resolver 值变化后热更新，轮询归零', async () => {
  const store: Record<string, string | undefined> = {};
  const { fn, calls } = fakeFetch([okResponse('{}')]);
  const router = createLlmRouter(
    {
      requestTimeoutMs: 5000, circuitThreshold: 2, circuitCooldownMs: 60_000,
      providers: [spec({ name: 'ds', keyEnvs: ['K_A', 'K_B'] })],
    },
    (s) => s.keyEnvs.map((n) => store[n]).filter((k): k is string => !!k),
    { fetchFn: fn },
  );
  assert.match(router.describe()[0]!.status, /缺 key/, '初始缺 key');

  store.K_A = 'key-a';
  router.refreshKeys();
  assert.equal(router.describe()[0]!.status, 'ready');
  await router.completeJson({ messages: textMsg });
  assert.equal(
    (calls[0]!.init.headers as Record<string, string>).Authorization,
    'Bearer key-a',
  );

  // 再填第二个 key：轮询从新池子的第一个开始
  store.K_B = 'key-b';
  router.refreshKeys();
  await router.completeJson({ messages: textMsg });
  await router.completeJson({ messages: textMsg });
  const auths = calls.slice(1).map((c) => (c.init.headers as Record<string, string>).Authorization);
  assert.deepEqual(auths, ['Bearer key-a', 'Bearer key-b'], '轮询从头开始');

  // 清空 = 回到缺 key
  delete store.K_A;
  delete store.K_B;
  router.refreshKeys();
  assert.match(router.describe()[0]!.status, /缺 key/);
});

// ---- provider 名单存储（settings 表）与路由推导 ----

test('listLlmProviders/saveLlmProviders 往返（settings 表唯一信源）', () => {
  const db = new Db(':memory:');
  try {
    assert.equal(listLlmProviders(db).length, 0);
    saveLlmProviders(db, [spec({ name: 'a' })]);
    assert.deepEqual(listLlmProviders(db).map((p) => p.name), ['a']);
    saveLlmProviders(db, [spec({ name: 'c', vision: true })]);
    assert.deepEqual(listLlmProviders(db).map((p) => p.name), ['c']);
  } finally {
    db.close();
  }
});

test('deriveRoutes：顺序即优先级；vision 路由只含启用的多模态', () => {
  const routes = deriveRoutes([
    spec({ name: 't1' }),
    spec({ name: 'v1', vision: true }),
    spec({ name: 'off', vision: true, enabled: false }),
  ]);
  assert.deepEqual(routes, { text: ['t1', 'v1'], vision: ['v1'] }, '多模态也能接纯文本任务');
});

test('isLlmEnabled：settings 唯一信源，缺省 = 关', () => {
  const db = new Db(':memory:');
  try {
    assert.equal(isLlmEnabled(db), false, '缺省关');
    setLlmEnabled(db, true);
    assert.equal(isLlmEnabled(db), true);
    setLlmEnabled(db, false);
    assert.equal(isLlmEnabled(db), false);
  } finally {
    db.close();
  }
});

test('dbKeysOf：面板填写（逗号分隔多 key）是唯一来源', () => {
  const db = new Db(':memory:');
  try {
    const keysOf = dbKeysOf(db);
    assert.deepEqual(keysOf(spec({ name: 'p' })), [], '未填 = 无 key');
    db.setSetting('llm_key:p', 'sk-1, sk-2');
    assert.deepEqual(keysOf(spec({ name: 'p' })), ['sk-1', 'sk-2'], '拆分多 key');
    db.setSetting('llm_key:p', '  ');
    assert.deepEqual(keysOf(spec({ name: 'p' })), [], '空白 = 未填');
  } finally {
    db.close();
  }
});
