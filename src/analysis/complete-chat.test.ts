/**
 * completeChat 的契约测试：双协议原生 tool_calls 的线上形状、JSON 模拟降级、路由与熔断语义，
 * 以及计划里点名的硬要求——**模拟降级产出的 args 同样必须过 runTool 的 zod 校验**。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import type { LlmProviderConfig } from '../config/index.js';
import type { PanelDeps } from '../panel/server.js';
import { runTool } from '../mcp/run-tool.js';
import type { McpToolDef } from '../mcp/tools.js';
import {
  AllProvidersExhaustedError, LlmRouter, OpenAiProvider, SelectedProviderError, SIMULATED_TOOL_CALL_ID,
  type FetchLike, type LlmRequest, type ToolSpec,
} from './providers.js';

function spec(over: Partial<LlmProviderConfig> = {}): LlmProviderConfig {
  return {
    name: 'p1', baseURL: 'https://api.example.com/v1', model: 'm1',
    vision: false, keyEnvs: [], enabled: true, structuredOutput: 'schema',
    api: 'chat-completions',
    ...over,
    id: over.id ?? over.name ?? 'p1',
  };
}

const OPTS = { timeoutMs: 1_000, circuitThreshold: 3, circuitCooldownMs: 60_000 };

function fakeFetch(queue: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> });
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (!next) throw new Error('fake fetch 队列空');
    if (next instanceof Error) throw next;
    return next.clone();
  };
  return { fn, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function chatResponse(message: Record<string, unknown>): Response {
  return jsonResponse({ choices: [{ message }] });
}

const TOOLS: ToolSpec[] = [
  {
    name: 'search_streamers',
    description: '按名字搜主播',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  },
];

function provider(over: Partial<LlmProviderConfig>, queue: Array<Response | Error>) {
  const fake = fakeFetch(queue);
  const p = new OpenAiProvider(spec(over), ['k1'], { ...OPTS, fetchFn: fake.fn });
  return { p, calls: fake.calls };
}

/** 按请求体决定响应：原生（带 tools）与模拟（不带 tools）走同一个端点，必须按 body 分流 */
function providerWith(
  over: Partial<LlmProviderConfig>,
  handler: (body: Record<string, unknown>, callIndex: number) => Response | Error,
) {
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const fn: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    calls.push({ url, init, body });
    const r = handler(body, calls.length - 1);
    if (r instanceof Error) throw r;
    return r.clone();
  };
  const p = new OpenAiProvider(spec(over), ['k1'], { ...OPTS, fetchFn: fn });
  return { p, calls };
}

function routerOf(providers: OpenAiProvider[]) {
  return new LlmRouter(providers, { text: providers.map((p) => p.name), vision: providers.map((p) => p.name) });
}

// ---- chat/completions 原生 ----

test('chat/completions：tools 传成 function 形态，tool_calls 原样解析', async (t) => {
  const { p, calls } = provider({}, [
    chatResponse({
      content: '我查一下',
      tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'search_streamers', arguments: '{"q":"栞栞"}' } }],
    }),
  ]);
  t.after(() => {});

  const out = await p.completeChat({ messages: [{ role: 'user', content: '找栞栞' }], tools: TOOLS });
  assert.equal(out.content, '我查一下');
  assert.deepEqual(out.toolCalls, [{ id: 'call_a', name: 'search_streamers', arguments: '{"q":"栞栞"}' }]);

  const body = calls[0]!.body;
  assert.deepEqual(body.tools, [{
    type: 'function',
    function: { name: 'search_streamers', description: '按名字搜主播', parameters: TOOLS[0]!.parameters },
  }]);
  assert.equal('response_format' in body, false, '工具轮次不下发 response_format');
});

test('chat/completions：assistant 的 tool_calls 与 tool 结果按协议回填', async (t) => {
  const { p, calls } = provider({}, [chatResponse({ content: '好' })]);
  t.after(() => {});

  const req: LlmRequest = {
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '找栞栞' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_a', name: 'search_streamers', arguments: '{"q":"x"}' }] },
      { role: 'tool', content: '{"uid":"7706705"}', toolCallId: 'call_a' },
    ],
    tools: TOOLS,
  };
  await p.completeChat(req);

  const msgs = calls[0]!.body.messages as Array<Record<string, unknown>>;
  assert.deepEqual(msgs[2], {
    role: 'assistant', content: '',
    tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'search_streamers', arguments: '{"q":"x"}' } }],
  });
  assert.deepEqual(msgs[3], { role: 'tool', tool_call_id: 'call_a', content: '{"uid":"7706705"}' });
});

test('chat/completions：tool_call 缺 id 时兜底 call_N；无 content 视为空串', async (t) => {
  const { p } = provider({}, [chatResponse({ tool_calls: [{ function: { name: 'get_status' } }] })]);
  t.after(() => {});
  const out = await p.completeChat({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS });
  assert.deepEqual(out.toolCalls, [{ id: 'call_0', name: 'get_status', arguments: '{}' }]);
  assert.equal(out.content, '');
});

test('chat/completions：缺 choices[0].message → ProviderCallError', async (t) => {
  const { p } = provider({}, [jsonResponse({ choices: [] })]);
  t.after(() => {});
  await assert.rejects(
    () => p.completeChat({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS }),
    /choices\[0\]\.message/,
  );
});

// ---- responses 原生 ----

test('responses：tools 是顶层 {type,name,parameters}；function_call / function_call_output 顶层回填', async (t) => {
  const { p, calls } = provider({ api: 'responses' }, [
    jsonResponse({
      output: [
        { type: 'message', content: [{ type: 'output_text', text: '我来查' }] },
        { type: 'function_call', call_id: 'fc_1', name: 'search_streamers', arguments: '{"q":"栞栞"}' },
      ],
    }),
  ]);
  t.after(() => {});

  const req: LlmRequest = {
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '找栞栞' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'fc_1', name: 'search_streamers', arguments: '{"q":"栞栞"}' }] },
      { role: 'tool', content: '{"uid":"7706705"}', toolCallId: 'fc_1' },
    ],
    tools: TOOLS,
  };
  const out = await p.completeChat(req);
  assert.equal(out.content, '我来查');
  assert.deepEqual(out.toolCalls, [{ id: 'fc_1', name: 'search_streamers', arguments: '{"q":"栞栞"}' }]);

  const body = calls[0]!.body;
  assert.equal(calls[0]!.url, 'https://api.example.com/v1/responses');
  assert.deepEqual(body.tools, [{
    type: 'function', name: 'search_streamers', description: '按名字搜主播', parameters: TOOLS[0]!.parameters,
  }]);
  const input = body.input as Array<Record<string, unknown>>;
  assert.deepEqual(input[1], {
    type: 'function_call', call_id: 'fc_1', name: 'search_streamers', arguments: '{"q":"栞栞"}',
  });
  assert.deepEqual(input[2], { type: 'function_call_output', call_id: 'fc_1', output: '{"uid":"7706705"}' });
  assert.equal(body.instructions, 'sys');
});

test('responses：既无 output_text 也无 function_call → ProviderCallError', async (t) => {
  const { p } = provider({ api: 'responses' }, [jsonResponse({ output: [] })]);
  t.after(() => {});
  await assert.rejects(
    () => p.completeChat({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS }),
    /没有 output_text 也没有 function_call/,
  );
});

// ---- JSON 模拟降级 ----

test('端点不支持原生 tools（HTTP 400 unknown parameter: tools）→ 自动降级模拟，且不算 provider 故障', async (t) => {
  const { p, calls } = providerWith({}, (body) =>
    body.tools !== undefined
      ? new Response('{"error":"unknown parameter: tools"}', { status: 400 })
      : jsonResponse({ choices: [{ message: { content: '{"tool":"search_streamers","arguments":{"q":"栞栞"}}' } }] }));
  t.after(() => {});

  const out = await p.completeChat({ messages: [{ role: 'user', content: '找栞栞' }], tools: TOOLS }).catch((e: unknown) => e);
  // provider 层不降级——降级由 router 做；这里断言异常类型
  assert.equal((out as Error).name, 'ToolUnsupportedError');

  const router = routerOf([p]);
  const out2 = await router.completeChat({ messages: [{ role: 'user', content: '找栞栞' }], tools: TOOLS });
  assert.deepEqual(out2.toolCalls, [{
    id: SIMULATED_TOOL_CALL_ID, name: 'search_streamers', arguments: '{"q":"栞栞"}',
  }]);
  assert.equal(out2.content, '');

  // 第一次带 tools 的原生尝试（router 内）失败后，紧跟一次不带 tools 的模拟请求
  const sim = calls.find((c) => c.body.tools === undefined)!;
  assert.equal(sim.tools, undefined);
  assert.deepEqual(sim.body.response_format, { type: 'json_object' });
  const sys = (sim.body.messages as Array<{ role: string; content: string }>).find((m) => m.role === 'system')!;
  assert.match(sys.content, /search_streamers/);
  assert.match(sys.content, /只输出一个 JSON 对象/);

  // 降级不算故障：连做 3 次（阈值）后 provider 仍然可用
  for (let i = 0; i < 3; i++) {
    await router.completeChat({
      messages: [{ role: 'user', content: '再来' }],
      tools: TOOLS,
      simulateTools: true,
    });
  }
  assert.equal(p.status(), 'ready', '不支持 tools 不该打开熔断');
});

test('模拟降级：{"reply":…} → 只有正文没有工具调用', async (t) => {
  const { p } = provider({}, [jsonResponse({ choices: [{ message: { content: '{"reply":"本群现在推 3 位主播"}' } }] })]);
  t.after(() => {});
  const router = routerOf([p]);
  const out = await router.completeChat({
    messages: [{ role: 'user', content: '推哪些' }], tools: TOOLS, simulateTools: true,
  });
  assert.equal(out.content, '本群现在推 3 位主播');
  assert.deepEqual(out.toolCalls, []);
});

test('模拟降级：非 JSON 正文按 ProviderCallError 计失败（不静默当正文）', async (t) => {
  const { p } = provider({}, [jsonResponse({ choices: [{ message: { content: '我不太确定' } }] })]);
  t.after(() => {});
  const router = routerOf([p]);
  await assert.rejects(
    () => router.completeChat({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS, simulateTools: true }),
    (e: unknown) => e instanceof AllProvidersExhaustedError,
  );
});

test('模拟降级的工具结果回填：tool 消息渲染成「工具结果：…」的 user 消息', async (t) => {
  const { p, calls } = provider({}, [jsonResponse({ choices: [{ message: { content: '{"reply":"好"}' } }] })]);
  t.after(() => {});
  await routerOf([p]).completeChat({
    messages: [
      { role: 'user', content: '找栞栞' },
      { role: 'assistant', content: '', toolCalls: [{ id: SIMULATED_TOOL_CALL_ID, name: 'search_streamers', arguments: '{"q":"x"}' }] },
      { role: 'tool', content: '{"uid":"7706705"}', toolCallId: SIMULATED_TOOL_CALL_ID },
    ],
    tools: TOOLS,
    simulateTools: true,
  });
  const msgs = calls[0]!.body.messages as Array<{ role: string; content: string }>;
  assert.equal(msgs[0]!.role, 'system', '模拟提示词在最前');
  assert.deepEqual(msgs[1], { role: 'user', content: '找栞栞' });
  assert.match(msgs[2]!.content, /已调用 search_streamers/);
  assert.deepEqual(msgs[3], { role: 'user', content: '工具结果：{"uid":"7706705"}' });
});

// ---- 路由 / 降级链 ----

test('第一个 provider 降级后模拟也失败 → 换下一个 provider；全失败抛 AllProvidersExhaustedError', async (t) => {
  const bad = provider({ name: 'bad' }, [
    new Response('{"error":"unsupported: tools"}', { status: 400 }), // 原生不支持
    new Response('boom', { status: 500 }),                           // 模拟也失败
  ]);
  const good = provider({ name: 'good' }, [chatResponse({ content: '直接回答' })]);
  t.after(() => {});

  const out = await routerOf([bad.p, good.p]).completeChat({
    messages: [{ role: 'user', content: 'x' }], tools: TOOLS,
  });
  assert.equal(out.content, '直接回答');

  const all = provider({ name: 'only' }, [
    new Response('{"error":"unsupported: tools"}', { status: 400 }),
    new Response('boom', { status: 500 }),
    new Response('boom2', { status: 500 }),
    new Response('boom3', { status: 500 }),
  ]);
  t.after(() => {});
  await assert.rejects(
    () => routerOf([all.p]).completeChat({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS }),
    (e: unknown) => {
      assert.ok(e instanceof AllProvidersExhaustedError);
      assert.equal(e.route, 'text');
      assert.match(e.attempts.join(' '), /无原生 tools→JSON 模拟/);
      assert.match(e.attempts.join(' '), /模拟失败/);
      return true;
    },
  );
});

// ---- 点名 provider（LlmRequest.provider）：硬路由，绝不降级 ----

test('点名 provider：只有它被调用，返回里带 provider = 实际回答者；自动路由缺省不变', async (t) => {
  const a = provider({ name: 'a' }, [chatResponse({ content: 'a 答的' })]);
  const b = provider({ name: 'b' }, [chatResponse({ content: 'b 答的' })]);
  t.after(() => {});
  const router = routerOf([a.p, b.p]);

  // 缺省（自动路由）：路由顺序第一个回答
  const auto = await router.completeChat({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS });
  assert.equal(auto.content, 'a 答的');
  assert.equal(auto.provider, 'a', 'ChatCompletion.provider = 实际落点');
  assert.equal(b.calls.length, 0);

  // 点名 b：只打 b（a 一次都不碰），结果里的 provider 是 b
  const picked = await router.completeChat({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS, provider: 'b' });
  assert.equal(picked.content, 'b 答的');
  assert.equal(picked.provider, 'b');
  assert.equal(a.calls.length, 1, '点名时不去试别的 provider');
  assert.equal(b.calls.length, 1);

  // 空串 = 自动路由（面板「自动」就是写空串，不会长成「点名空名字」）
  const blank = await router.completeChat({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS, provider: '' });
  assert.equal(blank.provider, 'a');
  assert.equal(b.calls.length, 1);
});

test('点名 provider：不存在 / 未启用 / 缺 key / 熔断 都抛 SelectedProviderError，不回落别人', async (t) => {
  const good = provider({ name: 'good' }, [chatResponse({ content: '好' })]);
  const off = provider({ name: 'off', enabled: false }, [chatResponse({ content: '不该被调到' })]);
  t.after(() => {});
  const router = routerOf([off.p, good.p]);

  // ① 不存在
  await assert.rejects(
    () => router.completeChat({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS, provider: 'nope' }),
    (e: unknown) => {
      assert.ok(e instanceof SelectedProviderError);
      assert.equal(e.provider, 'nope');
      assert.match(e.message, /没有这个 LLM provider：nope/);
      return true;
    },
  );

  // ② 已配置但关掉了（checkbox）——明确中文错误，且不落到 good 身上
  await assert.rejects(
    () => router.completeChat({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS, provider: 'off' }),
    (e: unknown) => {
      assert.match((e as Error).message, /指定的 LLM provider「off」当前不可用（disabled）/);
      return true;
    },
  );
  assert.equal(good.calls.length, 0, '点名失败绝不回落别人');

  // ③ 缺 key（isReady=false 的另一支）
  const missing = new OpenAiProvider(
    spec({ name: 'nokey' }), [], { ...OPTS, fetchFn: fakeFetch([]).fn },
  );
  await assert.rejects(
    () => routerOf([missing]).completeChat({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS, provider: 'nokey' }),
    /缺 key/,
  );
});

test('点名 provider：调用失败照常计熔断，但不换人（抛 SelectedProviderError 带原始原因）', async (t) => {
  const bad = provider({ name: 'bad' }, [new Response('boom', { status: 500 })]);
  const good = provider({ name: 'good' }, [chatResponse({ content: '兜底回答' })]);
  t.after(() => {});
  const router = routerOf([bad.p, good.p]);

  await assert.rejects(
    () => router.completeChat({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS, provider: 'bad' }),
    (e: unknown) => {
      assert.ok(e instanceof SelectedProviderError);
      assert.match(e.message, /LLM provider「bad」调用失败：HTTP 500/);
      return true;
    },
  );
  assert.equal(good.calls.length, 0, '点名的 provider 失败也不换人');
  assert.equal(bad.p.status(), 'ready', '一次失败不到熔断阈值');

  // 连失败到阈值 → 它自己熔断；下次点名直接「当前不可用（熔断中）」
  for (let i = 0; i < 2; i++) {
    await router.completeChat({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS, provider: 'bad' })
      .catch(() => undefined);
  }
  assert.equal(bad.p.status(), '熔断中');
  await assert.rejects(
    () => router.completeChat({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS, provider: 'bad' }),
    /当前不可用（熔断中）/,
  );
});

test('点名 provider + JSON 模拟降级：模拟落点也算它，模拟失败不换人', async (t) => {
  // 端点不支持原生 tools → 就地降级模拟（模拟请求不带 tools）
  const { p } = providerWith({ name: 'sim' }, (body) =>
    body.tools !== undefined
      ? new Response('{"error":"unknown parameter: tools"}', { status: 400 })
      : jsonResponse({ choices: [{ message: { content: '{"reply":"模拟答的"}' } }] }));
  t.after(() => {});
  const out = await routerOf([p]).completeChat({
    messages: [{ role: 'user', content: 'x' }], tools: TOOLS, provider: 'sim',
  });
  assert.equal(out.content, '模拟答的');
  assert.equal(out.provider, 'sim', '模拟降级产出的结果同样带 provider');

  // 原生不支持 + 模拟也失败 → 抛 SelectedProviderError（不是 AllProvidersExhausted），也不换人
  const bad = provider({ name: 'sb' }, [new Response('boom', { status: 500 })]);
  const fallback = provider({ name: 'other' }, [chatResponse({ content: '不该被调到' })]);
  t.after(() => {});
  await assert.rejects(
    () => routerOf([bad.p, fallback.p]).completeChat({
      messages: [{ role: 'user', content: 'x' }], tools: TOOLS, provider: 'sb', simulateTools: true,
    }),
    (e: unknown) => {
      assert.ok(e instanceof SelectedProviderError, `应是点名错误，实际 ${String(e)}`);
      assert.match(e.message, /调用失败：HTTP 500/);
      return true;
    },
  );
  assert.equal(fallback.calls.length, 0, '点名失败不换人');
});

// ---- 计划里的硬要求：模拟产出的 args 必须过 runTool 校验 ----

test('JSON 模拟产出的 arguments 是原始字符串，且必须过 runTool 的 zod 校验（写工具不得绕过 schema）', async (t) => {
  const { p } = provider({}, [
    jsonResponse({
      choices: [{ message: { content: '{"tool":"upsert_push_rule","arguments":{"name":"本群","categoryId":"不是数字"}}' } }],
    }),
  ]);
  t.after(() => {});

  const out = await routerOf([p]).completeChat({
    messages: [{ role: 'user', content: '加规则' }], tools: TOOLS, simulateTools: true,
  });
  const call = out.toolCalls[0]!;
  assert.equal(typeof call.arguments, 'string', 'router 不解析业务参数，交给 runTool');

  let called = 0;
  const def: McpToolDef = {
    name: 'upsert_push_rule', description: '', role: 'admin', write: true,
    schema: { name: z.string(), categoryId: z.number().int().nullable().optional() },
    handler: () => { called++; return { ok: true }; },
  };
  const r = await runTool({} as PanelDeps, def, JSON.parse(call.arguments) as Record<string, unknown>, {
    name: 'agent', role: 'admin', scope: {},
  }, { audit: () => {}, beforeWrite: () => {} });

  assert.equal(r.ok, false, '模型编造的 categoryId 必须被拦下');
  assert.equal(r.status, 400);
  assert.equal(called, 0);
  assert.match(r.text, /参数不合法/);
});
