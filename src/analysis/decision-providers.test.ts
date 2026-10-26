import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  callSystemOne, pingDecisionProvider, DecisionCallError, decisionNeedsAuth,
  listDecisionProviders, saveDecisionProviders, dbDecisionKeysOf, decisionKeySetting,
} from './decision-providers.js';
import { Db } from '../core/db.js';
import type { DecisionProviderConfig } from '../config/index.js';
import type { FetchLike } from './providers.js';

function spec(over: Partial<DecisionProviderConfig> = {}): DecisionProviderConfig {
  return {
    name: 'jev', baseURL: 'https://api.typesafe.ai/v1', model: 'jev-1.14.0',
    protocol: 'systemone', enabled: true,
    ...over,
    id: over.id ?? over.name ?? 'jev',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

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

const OK_BODY = {
  model: 'jev-1.13.0',
  answers: { probe: { type: 'noul', noul: 0.98 } },
  usage: { input_tokens: 12, output_tokens: 1 },
};

test('callSystemOne：POST <baseURL>/v1/systemone，带 Bearer 与 state+questions，解析 typed answers', async () => {
  const f = fakeFetch([jsonResponse(OK_BODY)]);
  const out = await callSystemOne(spec({ baseURL: 'https://api.typesafe.ai/v1/' }), 'sk-test', {
    model: 'jev-1.14.0',
    state: { title: '歌回' },
    questions: { probe: { type: 'noul', instructions: '是否歌回？' } },
  }, { fetchFn: f.fn });

  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.url, 'https://api.typesafe.ai/v1/systemone', 'baseURL 尾部斜杠归一');
  const headers = f.calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer sk-test');
  assert.equal(headers['Content-Type'], 'application/json');
  const req = JSON.parse(String(f.calls[0]!.init.body)) as Record<string, unknown>;
  assert.equal(req.model, 'jev-1.14.0');
  assert.deepEqual(req.state, { title: '歌回' });
  assert.deepEqual((req.questions as Record<string, unknown>).probe, {
    type: 'noul', instructions: '是否歌回？',
  });
  assert.deepEqual(out, OK_BODY);
});

test('callSystemOne：无 key 不写 Authorization 头（本地无鉴权端点）', async () => {
  const f = fakeFetch([jsonResponse(OK_BODY)]);
  await callSystemOne(spec({ baseURL: 'http://127.0.0.1:8080/v1' }), null, {
    model: 'm', state: 'x', questions: { probe: { type: 'noul' } },
  }, { fetchFn: f.fn });
  const headers = f.calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, undefined);
});

test('callSystemOne：HTTP 错误归一成 DecisionCallError（带状态码），错误文本不含 key', async () => {
  const f = fakeFetch([new Response('invalid api key: sk-secret-xyz', { status: 401 })]);
  await assert.rejects(
    callSystemOne(spec(), 'sk-secret-xyz', {
      model: 'm', state: 'x', questions: { probe: { type: 'noul' } },
    }, { fetchFn: f.fn }),
    (e: unknown) => {
      assert.ok(e instanceof DecisionCallError);
      assert.equal(e.status, 401);
      assert.match(e.message, /HTTP 401/);
      assert.ok(!e.message.includes('sk-secret-xyz'), '即使端点回显 key 也要打码');
      return true;
    },
  );
});

test('callSystemOne：网络异常 / 信封缺 answers / 非 JSON 都判失败', async () => {
  await assert.rejects(
    callSystemOne(spec(), null, { model: 'm', state: 'x', questions: {} }, {
      fetchFn: fakeFetch([new Error('ECONNREFUSED')]).fn,
    }),
    /请求异常: ECONNREFUSED/,
  );
  await assert.rejects(
    callSystemOne(spec(), null, { model: 'm', state: 'x', questions: {} }, {
      fetchFn: fakeFetch([jsonResponse({ model: 'm' })]).fn,
    }),
    /响应缺少 answers/,
  );
  await assert.rejects(
    callSystemOne(spec(), null, { model: 'm', state: 'x', questions: {} }, {
      fetchFn: fakeFetch([new Response('not json', { status: 200 })]).fn,
    }),
    /响应不是合法 JSON 信封/,
  );
});

test('pingDecisionProvider：发一道 noul 并返回响应回显的模型版本', async () => {
  const f = fakeFetch([jsonResponse(OK_BODY)]);
  const r = await pingDecisionProvider(spec(), 'sk-test', { fetchFn: f.fn });
  assert.equal(r.model, 'jev-1.13.0', '返回的是实际回答版本，不是请求里的别名/版本');
  assert.equal(typeof r.ms, 'number');
  const req = JSON.parse(String(f.calls[0]!.init.body)) as {
    state: unknown; questions: Record<string, { type: string; instructions: string }>;
  };
  assert.equal(req.state, 'ping');
  assert.equal(req.questions.probe!.type, 'noul');
});

test('pingDecisionProvider：答案不是 noul 或缺失即失败', async () => {
  const bad = {
    model: 'jev-1.13.0',
    answers: { probe: { type: 'choice', choice: 'x', probabilities: {}, confidence: 1 } },
  };
  await assert.rejects(
    pingDecisionProvider(spec(), null, { fetchFn: fakeFetch([jsonResponse(bad)]).fn }),
    /响应缺少 noul 答案/,
  );
  await assert.rejects(
    pingDecisionProvider(spec(), null, { fetchFn: fakeFetch([jsonResponse({ model: 'm', answers: {} })]).fn }),
    /响应缺少 noul 答案/,
  );
});

test('decisionNeedsAuth：loopback 无鉴权，其余需要', () => {
  assert.equal(decisionNeedsAuth(spec({ baseURL: 'http://127.0.0.1:8080/v1' })), false);
  assert.equal(decisionNeedsAuth(spec({ baseURL: 'http://localhost:8080/v1' })), false);
  assert.equal(decisionNeedsAuth(spec()), true);
});

test('listDecisionProviders/saveDecisionProviders 往返（settings 表唯一信源）与独立 key 前缀', () => {
  const db = new Db(':memory:');
  assert.deepEqual(listDecisionProviders(db), []);
  saveDecisionProviders(db, [spec({ name: 'a' })]);
  assert.deepEqual(listDecisionProviders(db).map((p) => p.name), ['a']);
  assert.equal(decisionKeySetting('a'), 'decision_key:a');
  db.setSetting(decisionKeySetting('a'), 'k1，k2');
  assert.deepEqual(dbDecisionKeysOf(db)(spec({ name: 'a' })), ['k1', 'k2'], '中文逗号归一，与 LLM key 池同口径');
  assert.deepEqual(dbDecisionKeysOf(db)(spec({ name: 'b' })), []);
  db.close();
});
