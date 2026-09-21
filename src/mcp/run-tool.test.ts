/**
 * runTool() 的契约测试：校验不丢、审计不丢、错误归一、调用域透传。
 * 另一组用例覆盖 T2 的调用域解析（令牌绑定渠道 → ctx.scope）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { Db } from '../core/db.js';
import { UndoStore } from '../core/undo.js';
import type { PanelDeps } from '../panel/server.js';
import { HttpError } from '../panel/http-util.js';
import { resolveMcpAuth, saveMcpTokens, type McpAuth } from './auth.js';
import { runTool, runToolTracked, scopeChannelId, undoScopeOf, type ToolCall } from './run-tool.js';
import type { McpToolDef } from './tools.js';

/** runTool 不解释 deps，测试用空壳即可 */
const deps = {} as PanelDeps;
const admin: McpAuth = { name: 'adm', role: 'admin', scope: {} };
const gateway: McpAuth = { name: 'gw', role: 'gateway', scope: { channelId: 7 } };

function toolDef(over: Partial<McpToolDef> & { name: string }): McpToolDef {
  return {
    description: '',
    schema: {},
    role: 'admin',
    handler: () => ({ ok: true }),
    ...over,
  };
}

test('成功：data 原样返回，text 与改造前 /mcp 的 content 文本逐字一致', async () => {
  const def = toolDef({ name: 'get_status', role: 'shared', handler: () => ({ live: 3 }) });
  const r = await runTool(deps, def, {}, admin);
  assert.deepEqual(r, { ok: true, data: { live: 3 }, text: JSON.stringify({ live: 3 }, null, 2) });
});

test('handler 返回 undefined → text 是 {ok:true}（与旧行为一致）', async () => {
  const def = toolDef({ name: 'noop', handler: () => undefined });
  const r = await runTool(deps, def, {}, admin);
  assert.equal(r.ok, true);
  assert.equal(r.text, JSON.stringify({ ok: true }, null, 2));
});

test('HttpError → 状态码保留、文案归一为「错误：…」、不抛异常', async () => {
  const def = toolDef({ name: 'boom', handler: () => { throw new HttpError(429, '操作太频繁，请稍后再试'); } });
  const r = await runTool(deps, def, {}, admin);
  assert.deepEqual(r, { ok: false, error: '操作太频繁，请稍后再试', text: '错误：操作太频繁，请稍后再试', status: 429 });
});

test('普通 Error / 非 Error 抛出都归一为失败结果', async () => {
  const e1 = await runTool(deps, toolDef({ name: 'e1', handler: () => { throw new Error('炸了'); } }), {}, admin);
  assert.deepEqual(e1, { ok: false, error: '炸了', text: '错误：炸了' });
  const e2 = await runTool(deps, toolDef({ name: 'e2', handler: () => { throw 'string'; } }), {}, admin);
  assert.deepEqual(e2, { ok: false, error: 'string', text: '错误：string' });
});

test('参数不合法：handler 不会被调用，返回 400 口径', async () => {
  let called = 0;
  const def = toolDef({
    name: 'set_streamer',
    schema: { uid: z.string().regex(/^\d+$/, 'uid 必须是纯数字字符串') },
    handler: () => { called++; return { ok: true }; },
  });
  const r = await runTool(deps, def, { uid: 'abc' }, admin);
  assert.equal(r.ok, false);
  assert.equal(called, 0, '校验失败绝不能进 handler');
  assert.equal(r.status, 400);
  assert.match(r.text, /^错误：参数不合法：/);
  assert.match(r.text, /uid 必须是纯数字字符串/);
});

test('第二个适配器绕不过校验：未知键被剥离（身份字段永不作为参数进 handler）', async () => {
  let seen: Record<string, unknown> = {};
  const def = toolDef({
    name: 'add_group_push_rule',
    schema: { uid: z.string() },
    handler: (_deps, args) => { seen = args; return { ok: true }; },
  });
  await runTool(deps, def, { uid: '7706705', channelId: 7, groupId: 123 }, admin);
  assert.deepEqual(seen, { uid: '7706705' });
});

test('写操作：审计 + beforeWrite 快照钩子，顺序为 audit → beforeWrite → handler', async () => {
  const order: string[] = [];
  const def = toolDef({
    name: 'upsert_push_rule', write: true,
    handler: () => { order.push('handler'); return { id: 1 }; },
  });
  const calls: ToolCall[] = [];
  const r = await runTool(deps, def, {}, admin, {
    audit: (c) => { order.push('audit'); calls.push(c); },
    beforeWrite: (c) => { order.push('beforeWrite'); calls.push(c); },
  });
  assert.deepEqual(order, ['audit', 'beforeWrite', 'handler']);
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.def.name, 'upsert_push_rule');
});

test('读操作不触发审计与快照钩子', async () => {
  let touched = 0;
  const def = toolDef({ name: 'get_live_now', role: 'shared', handler: () => [] });
  await runTool(deps, def, {}, admin, {
    audit: () => { touched++; },
    beforeWrite: () => { touched++; },
  });
  assert.equal(touched, 0);
});

test('快照钩子抛错 → 调用失败且不写库（宁可不写，也不要写了撤不掉）', async () => {
  let wrote = false;
  const def = toolDef({ name: 'upsert_channel', write: true, handler: () => { wrote = true; return {}; } });
  const r = await runTool(deps, def, {}, admin, {
    audit: () => {},
    beforeWrite: () => { throw new Error('快照失败'); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.text, '错误：快照失败');
  assert.equal(wrote, false);
});

test('调用域透传：handler 读得到 scope.channelId，能力层不从参数推断', async () => {
  const def = toolDef({
    name: 'list_push_rules', role: 'gateway',
    handler: (_deps, _args, ctx) => ({ channelId: scopeChannelId(ctx) }),
  });
  const r = await runTool(deps, def, {}, gateway);
  assert.deepEqual(r.ok && r.data, { channelId: 7 });
  const noScope = await runTool(deps, def, {}, admin);
  assert.deepEqual(noScope.ok && noScope.data, { channelId: undefined });
});

test('缺省审计：写操作落日志且 llm key 值打码', async (t) => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  t.after(() => { console.log = orig; });

  const def = toolDef({
    name: 'set_llm_key', write: true,
    schema: { name: z.string(), value: z.string() },
    handler: () => ({ ok: true }),
  });
  const r = await runTool(deps, def, { name: 'p1', value: 'sk-secret' }, gateway);
  assert.equal(r.ok, true);

  const joined = lines.join('\n');
  assert.match(joined, /MCP 写操作 \[gateway:gw #ch7\] set_llm_key/, '审计应带角色与调用域渠道');
  assert.ok(!joined.includes('sk-secret'), 'llm key 明文不得进日志');
  assert.match(joined, /"\*\*\*"/);
});

test('调用域解析：令牌绑定渠道 → scope；admin 与非法绑定不产生 scope', (t) => {
  const db = new Db(':memory:');
  t.after(() => db.close());

  assert.equal(resolveMcpAuth(db, 'Bearer x'), 'unconfigured', '零令牌 = 503');

  saveMcpTokens(db, [
    { name: 'adm', role: 'admin', token: 'ddc_admin' },
    { name: 'gw1', role: 'gateway', token: 'ddc_gw1', channelId: 7 },
    { name: 'gw-zero', role: 'gateway', token: 'ddc_gw0', channelId: 0 },
    { name: 'gw-str', role: 'gateway', token: 'ddc_gws', channelId: '9' as unknown as number },
  ]);

  assert.deepEqual(resolveMcpAuth(db, `Bearer ddc_admin`), { name: 'adm', role: 'admin', scope: {} });
  assert.deepEqual(resolveMcpAuth(db, `Bearer ddc_gw1`), { name: 'gw1', role: 'gateway', scope: { channelId: 7 } });
  assert.deepEqual(resolveMcpAuth(db, `Bearer ddc_gw0`), { name: 'gw-zero', role: 'gateway', scope: {} });
  assert.deepEqual(resolveMcpAuth(db, `Bearer ddc_gws`), { name: 'gw-str', role: 'gateway', scope: {} });
  assert.equal(resolveMcpAuth(db, 'Bearer nope'), null);
  assert.equal(resolveMcpAuth(db, undefined), null);
});
// ---- 撤销接线（切片 C）：scope 解析与「撤销不进快照」 ----

test('undoScopeOf：admin 走全局栈；gateway 必须绑渠道，未绑定抛 403（绝不回落）', () => {
  assert.equal(undoScopeOf(admin), 'admin');
  assert.equal(undoScopeOf(gateway), 'ch:7');
  const unbound: McpAuth = { name: 'gw0', role: 'gateway', scope: {} };
  assert.throws(
    () => undoScopeOf(unbound),
    (e: unknown) => e instanceof HttpError && e.status === 403 && /未绑定渠道/.test(e.message),
    '未绑渠道的 gateway 不得回落 admin 全局栈',
  );
});

test('track:false 的写工具不进快照（撤销执行器专用）；同一写路径缺省就进', async (t) => {
  const db = new Db(':memory:');
  t.after(() => db.close());
  const undo = new UndoStore(db.raw);
  undo.migrate();
  const toolDeps = { db, undo } as unknown as PanelDeps;

  const mk = (value: string, track?: false): McpToolDef => toolDef({
    name: 'set_push_enabled',
    write: true,
    ...(track === false ? { track: false as const } : {}),
    handler: (d) => { d.db.setSetting('push_enabled', value); return { ok: true }; },
  });

  const r = await runToolTracked(toolDeps, mk('0', false), {}, admin, 'mcp');
  assert.equal(r.ok, true);
  assert.deepEqual(undo.history(), [], '撤销执行器这类写（track:false）不得进快照栈——否则撤销自己可撤');

  await runToolTracked(toolDeps, mk('1'), {}, admin, 'mcp');
  const hist = undo.history();
  assert.equal(hist.length, 1, '缺省 track 的写工具照常落记录');
  assert.equal(hist[0]!.tool, 'set_push_enabled');
  assert.deepEqual(hist[0]!.rows[0]!.pk, { key: 'push_enabled' });
});