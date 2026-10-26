import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DecisionProvider, DecisionRouter, DecisionUnavailableError, createDecisionRouter,
} from './decision-router.js';
import type { DecisionProviderConfig } from '../config/schema.js';
import type { FetchLike } from './providers.js';
import type { SystemOneRequest } from './decision-providers.js';
import { Db } from '../core/db.js';
import { saveDecisionProviders, decisionKeySetting } from './decision-providers.js';
import { saveRuntimeConfig, getRuntimeConfig } from '../core/runtime-config.js';
import type { ModelAttempt } from '../core/content-audit.js';

function spec(over: Partial<DecisionProviderConfig> = {}): DecisionProviderConfig {
  return {
    name: 'jev', baseURL: 'https://api.typesafe.ai/v1', model: 'jev-1.14.0',
    protocol: 'systemone', vision: false, enabled: true,
    ...over,
    id: over.id ?? over.name ?? 'jev',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const okBody = (model = 'jev-1.13.0'): unknown => ({
  model,
  answers: { q: { type: 'noul', noul: 0.9 } },
});

interface FetchCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** fetch 桩：记录每次请求（URL / 头 / 解析后的 body），响应由 handler 给 */
function fetchStub(handler: (call: FetchCall, index: number) => Response | Error) {
  const calls: FetchCall[] = [];
  const fn: FetchLike = async (url, init) => {
    const call: FetchCall = {
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    };
    calls.push(call);
    const out = handler(call, calls.length - 1);
    if (out instanceof Error) throw out;
    return out;
  };
  return { fn, calls };
}

/** 每次判定构造请求：state 里带不带图片 ref 由 withImages 决定；assets 故意始终给出，验证 router 会剥掉 */
function builder(): (withImages: boolean, sp: DecisionProviderConfig) => { req: SystemOneRequest; assets?: Record<string, unknown> } {
  return (withImages, sp) => ({
    req: {
      model: sp.model,
      state: withImages ? { 标题: '歌回', 画面: 'ref-1' } : { 标题: '歌回' },
      questions: { q: { type: 'noul', instructions: '是歌回吗？' } },
    },
    assets: { 'ref-1': { type: 'image', format: 'jpg', data_base64: 'AAA' } },
  });
}

const noValidate = (): void => {};

const OPTS = { timeoutMs: 1_000, circuitThreshold: 3, circuitCooldownMs: 60_000, retryDelayMs: 0 };

/** 路由构造：key 缺省给一个测试 key（需要「缺 key」场景的用例显式传空数组） */
function router(
  specs: DecisionProviderConfig[],
  keys: Record<string, string[]> = {},
  fetchFn: FetchLike,
  over: Partial<typeof OPTS & { now: () => number }> = {},
): DecisionRouter {
  return new DecisionRouter(specs, (s) => keys[s.name] ?? ['sk-test'], { ...OPTS, fetchFn, ...over });
}

test('候选顺序：含图时 vision 供应商优先（各自保持名单序），纯文本供应商排后且不带图', async () => {
  const specs = [
    spec({ name: 'A-text' }),
    spec({ name: 'B-vision', baseURL: 'https://b/v1', vision: true }),
    spec({ name: 'C-text', baseURL: 'https://c/v1' }),
    spec({ name: 'D-vision', baseURL: 'https://d/v1', vision: true }),
  ];
  // 全部失败（500 不重试？500 会重试一次）——只为收集候选顺序
  const stub = fetchStub(() => jsonResponse({ error: 'boom' }, 500));
  const attempts: ModelAttempt[] = [];
  await assert.rejects(
    router(specs, {}, stub.fn).decide(builder(), { hasImages: true }, noValidate, (a) => attempts.push(a)),
    DecisionUnavailableError,
  );
  assert.deepEqual(
    attempts.map((a) => a.provider),
    ['B-vision', 'D-vision', 'A-text', 'C-text'],
    '带图：vision 供应商先试，各自按名单序，纯文本供应商最后',
  );
  assert.deepEqual(attempts.map((a) => a.channel), Array(4).fill('decision'), '尝试都标 decision 通道');

  // 无图：按名单序
  const stub2 = fetchStub(() => jsonResponse(okBody()));
  const r2 = router(specs, {}, stub2.fn);
  const out = await r2.decide(builder(), { hasImages: false }, noValidate);
  assert.equal(out.provider.name, 'A-text', '无图按名单顺序，第一个就成功');
  assert.equal(stub2.calls[0]!.body['assets'], undefined);
});

test('含图时：vision 候选请求带 assets 与图片危险区头，纯文本候选请求里没有 assets / 图片 ref', async () => {
  const specs = [spec({ name: 'text' }), spec({ name: 'vision', baseURL: 'https://b/v1', vision: true })];
  const stub = fetchStub((call) => (call.url.startsWith('https://b') ? jsonResponse(okBody()) : jsonResponse(okBody())));
  const out = await router(specs, {}, stub.fn).decide(builder(), { hasImages: true }, noValidate);
  assert.equal(out.provider.name, 'vision');
  assert.equal(out.withImages, true);
  assert.equal(stub.calls.length, 1, 'vision 供应商先成功');
  const call = stub.calls[0]!;
  assert.equal(call.headers['TypeSafe-Danger-Zone-Images'], 'true');
  assert.deepEqual(call.body['assets'], { 'ref-1': { type: 'image', format: 'jpg', data_base64: 'AAA' } });
  assert.deepEqual(call.body['state'], { 标题: '歌回', 画面: 'ref-1' });

  // 纯文本供应商兜底：即便调用方给了 assets，router 也必须剥掉
  const failing = fetchStub((call) => (call.url.startsWith('https://b')
    ? jsonResponse({ error: 'no' }, 400)
    : jsonResponse(okBody())));
  const fallback = await router(specs, {}, failing.fn).decide(builder(), { hasImages: true }, noValidate);
  assert.equal(fallback.provider.name, 'text');
  assert.equal(fallback.withImages, false, '纯文本供应商 = 没看图');
  const textCall = failing.calls[1]!;
  assert.equal(textCall.body['assets'], undefined);
  assert.equal(textCall.headers['TypeSafe-Danger-Zone-Images'], undefined);
});

test('未就绪跳过：未启用 / 缺 key / 熔断中都不发请求，尝试记为 skipped', async () => {
  const specs = [
    spec({ name: 'off', enabled: false }),
    spec({ name: 'nokey', baseURL: 'https://nokey/v1' }),
    spec({ name: 'ready', baseURL: 'https://ready/v1' }),
  ];
  const stub = fetchStub(() => jsonResponse(okBody()));
  const attempts: ModelAttempt[] = [];
  const out = await router(specs, { nokey: [] }, stub.fn)
    .decide(builder(), { hasImages: false }, noValidate, (a) => attempts.push(a));
  assert.equal(out.provider.name, 'ready');
  assert.equal(stub.calls.length, 1, '只对就绪的供应商发请求');
  assert.deepEqual(
    attempts.map((a) => [a.provider, a.status]),
    [['off', 'skipped'], ['nokey', 'skipped'], ['ready', 'success']],
  );
  assert.match(attempts[0]!.error!, /disabled/);
  assert.match(attempts[1]!.error!, /缺 key/);
});

test('失败换下一个：400 不重试，直接试下一个候选', async () => {
  const specs = [spec({ name: 'bad' }), spec({ name: 'good', baseURL: 'https://good/v1' })];
  const stub = fetchStub((call, i) => (i === 0 ? jsonResponse({ error: 'bad request' }, 400) : jsonResponse(okBody())));
  const out = await router(specs, {}, stub.fn).decide(builder(), { hasImages: false }, noValidate);
  assert.equal(out.provider.name, 'good');
  assert.equal(stub.calls.length, 2, '400 不重试（1 次失败 + 1 次成功）');
});

test('可重试失败：429 / 5xx / 网络异常就地重试一次（成功即算成功）', async () => {
  for (const first of [
    () => jsonResponse({ error: 'rate limited' }, 429),
    () => jsonResponse({ error: 'boom' }, 503),
    () => new Error('ECONNRESET'),
  ]) {
    const stub = fetchStub((_call, i) => (i === 0 ? first() : jsonResponse(okBody())));
    const out = await router([spec()], {}, stub.fn).decide(builder(), { hasImages: false }, noValidate);
    assert.equal(out.provider.name, 'jev');
    assert.equal(stub.calls.length, 2, '失败一次 → 重试成功');
  }
  // 重试仍失败：只重试一次，然后换候选（这里没有下一个 → 全部不可用）
  const stub = fetchStub(() => jsonResponse({ error: 'boom' }, 502));
  await assert.rejects(
    router([spec()], {}, stub.fn).decide(builder(), { hasImages: false }, noValidate),
    DecisionUnavailableError,
  );
  assert.equal(stub.calls.length, 2, '共 1 + 1 次尝试');
});

test('熔断：连续失败达阈值后跳过该供应商，冷却过后恢复', async () => {
  let now = 1_000;
  const stub = fetchStub(() => jsonResponse({ error: 'down' }, 400));
  const r = router([spec()], {}, stub.fn, { circuitThreshold: 2, circuitCooldownMs: 10_000, now: () => now });

  await assert.rejects(r.decide(builder(), { hasImages: false }, noValidate), DecisionUnavailableError);
  await assert.rejects(r.decide(builder(), { hasImages: false }, noValidate), DecisionUnavailableError);
  assert.equal(stub.calls.length, 2, '两次失败 → 熔断');

  const attempts: ModelAttempt[] = [];
  await assert.rejects(
    r.decide(builder(), { hasImages: false }, noValidate, (a) => attempts.push(a)),
    DecisionUnavailableError,
  );
  assert.equal(stub.calls.length, 2, '熔断期间不再发请求');
  assert.equal(attempts[0]!.status, 'skipped');
  assert.match(attempts[0]!.error!, /熔断中/);

  now += 10_001;
  const before = stub.calls.length;
  // 冷却结束：仍会尝试（这次仍失败，但请求已发出 = 熔断已解除）
  await assert.rejects(r.decide(builder(), { hasImages: false }, noValidate), DecisionUnavailableError);
  assert.ok(stub.calls.length > before, '冷却过后重新尝试');
});

test('key 轮换：池内依次取用，成功后计数归零；setKeys 让轮换位置归零', async () => {
  const stub = fetchStub(() => jsonResponse(okBody()));
  const r = router([spec()], { jev: ['k1', 'k2'] }, stub.fn);
  await r.decide(builder(), { hasImages: false }, noValidate);
  await r.decide(builder(), { hasImages: false }, noValidate);
  assert.deepEqual(
    stub.calls.map((c) => c.headers['Authorization']),
    ['Bearer k1', 'Bearer k2'],
  );

  const p = new DecisionProvider(spec(), ['k1', 'k2'], {
    timeoutMs: 1_000, circuitThreshold: 3, circuitCooldownMs: 1_000, fetchFn: stub.fn, retryDelayMs: 0,
  });
  await p.call({ model: 'm', state: 'x', questions: { q: { type: 'noul' } } });
  p.setKeys(['k1', 'k2']);
  await p.call({ model: 'm', state: 'x', questions: { q: { type: 'noul' } } });
  assert.deepEqual(
    stub.calls.slice(2).map((c) => c.headers['Authorization']),
    ['Bearer k1', 'Bearer k1'],
    'setKeys 把轮换位置归零',
  );
});

test('错误信息不含 key；全部候选失败抛 DecisionUnavailableError 并列出原因', async () => {
  const stub = fetchStub(() => new Response('invalid api key: sk-secret-xyz', { status: 401 }));
  const err = await router([spec()], { jev: ['sk-secret-xyz'] }, stub.fn)
    .decide(builder(), { hasImages: false }, noValidate)
    .then(() => null, (e: unknown) => e as Error);
  assert.ok(err instanceof DecisionUnavailableError);
  assert.doesNotMatch(err.message, /sk-secret-xyz/);
  assert.match(err.message, /401/);
  assert.deepEqual(err.attempts.length, 1);
});

test('validate 抛错等同失败：换下一个候选；全部不合契约则整档不可用', async () => {
  const specs = [spec({ name: 'one' }), spec({ name: 'two', baseURL: 'https://two/v1' })];
  const stub = fetchStub(() => jsonResponse(okBody()));
  const out = await router(specs, {}, stub.fn).decide(builder(), { hasImages: false }, () => {
    throw new Error('响应不符合契约');
  }).catch((e: unknown) => e);
  assert.ok(out instanceof DecisionUnavailableError);
  assert.equal(stub.calls.length, 2, '两个候选都试过');
  assert.match(out.message, /响应不符合契约/);
});

test('供应商状态：status() 区分 disabled / 缺 key / 熔断 / ready，loopback 免 key', () => {
  assert.equal(new DecisionProvider(spec({ enabled: false }), [], { ...OPTS }).status(), 'disabled');
  assert.equal(new DecisionProvider(spec(), [], { ...OPTS }).status(), '缺 key（未填写）');
  assert.equal(
    new DecisionProvider(spec({ baseURL: 'http://127.0.0.1:8080/v1' }), [], { ...OPTS }).status(),
    'ready',
    'loopback 端点无鉴权也算就绪',
  );
  const p = new DecisionProvider(spec(), ['k'], { ...OPTS, circuitThreshold: 1 });
  p.recordFailure(new Error('boom'));
  assert.equal(p.status(), '熔断中');
  assert.equal(p.isReady(), false);
});

test('createDecisionRouter：名单 / key / 超时熔断都取自 settings，判定即可用', async () => {
  const db = new Db(':memory:');
  try {
    saveDecisionProviders(db, [spec({ name: 'jev', vision: true })]);
    db.setSetting(decisionKeySetting('jev'), 'sk-a,sk-b');
    saveRuntimeConfig(db, {
      decisionRequestTimeoutMs: 5_000, decisionCircuitThreshold: 5, decisionCircuitCooldownMs: 60_000,
    });
    const stub = fetchStub(() => jsonResponse(okBody()));
    const r = createDecisionRouter(db, getRuntimeConfig(db), { fetchFn: stub.fn, retryDelayMs: 0 });
    const out = await r.decide(builder(), { hasImages: true }, noValidate);
    assert.equal(out.provider.name, 'jev');
    assert.equal(stub.calls[0]!.headers['Authorization'], 'Bearer sk-a');
    assert.deepEqual(r.describe().map((d) => [d.name, d.vision, d.status]), [['jev', true, 'ready']]);
  } finally {
    db.close();
  }
});
