/**
 * MCP 端点测试：真实 http.Server + SDK client 走完整 Streamable HTTP 链路。
 * 覆盖：token 鉴权（401/503）、角色工具面过滤、群规则自助约束（渠道类型/名单/配额/created_by 隔离）、
 * admin 写路径（watch/运行时参数/LLM key）、写限流、search_posts 检索。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Db } from '../core/db.js';
import { createPanelServer, type PanelDeps, type PanelStatus } from '../panel/server.js';
import { saveMcpTokens } from '../mcp/auth.js';
import { resetMcpWriteLimiter } from '../mcp/rate-limit.js';
import { saveLlmProviders, listLlmProviders } from '../analysis/providers.js';

const ADMIN_TOKEN = 'ddc_test_admin';
const GATEWAY_TOKEN = 'ddc_test_gateway';

interface Fixture {
  db: Db;
  base: string;
  listenChanged: { count: number };
  advancedChanged: { count: number };
  /** 该测试开过的 MCP client（teardown 先关 client 再关 server，否则 keep-alive 连接拖住 server.close） */
  clients: Client[];
}

async function setup(
  t: import('node:test').TestContext,
  opts: { withTokens?: boolean; withLlm?: boolean } = {},
): Promise<Fixture> {
  const db = new Db(':memory:');
  if (opts.withTokens !== false) {
    saveMcpTokens(db, [
      { name: 'adm', role: 'admin', token: ADMIN_TOKEN },
      { name: 'gw', role: 'gateway', token: GATEWAY_TOKEN },
    ]);
  }
  if (opts.withLlm) {
    saveLlmProviders(db, [{
      name: 'TestLLM', baseURL: 'http://127.0.0.1:1/v1', model: 'm',
      vision: false, keyEnvs: [], enabled: true, structuredOutput: 'schema', api: 'chat-completions',
    }]);
  }
  const status: PanelStatus = {
    startedAt: Math.floor(Date.now() / 1000),
    notifiers: ['toast'], watchedCount: 0, liveCount: 0,
    platforms: [{ key: 'bili', name: 'B站', state: 'ok', mid: '1' }],
  };
  const listenChanged = { count: 0 };
  const advancedChanged = { count: 0 };
  const deps: PanelDeps = {
    db,
    status: () => status,
    listen: { login: () => ({ bili: true, weibo: true }), onChanged: () => listenChanged.count++ },
    advanced: { onChanged: () => advancedChanged.count++ },
    llm: { store: { list: () => listLlmProviders(db), save: (ps) => saveLlmProviders(db, ps) } },
  };
  const server: Server = createPanelServer(deps);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const clients: Client[] = [];
  // 注意：node:test 的 t.after 按注册顺序（FIFO）执行——必须先关 client 再关 server，
  // 否则客户端的 keep-alive 连接会拖住 server.close 永久挂起
  t.after(async () => {
    for (const c of clients) await c.close();
    await new Promise((r) => server.close(r));
    db.close();
  });
  const { port } = server.address() as AddressInfo;
  return { db, base: `http://127.0.0.1:${port}`, listenChanged, advancedChanged, clients };
}

/** SDK client（stateless 模式，Bearer 头走 requestInit）；登记进 fixture 统一 teardown */
async function mcpClient(f: Fixture, token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${f.base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  f.clients.push(client);
  return client;
}

/** callTool → 解析 text JSON；isError 时抛带文本的错 */
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
  if (r.isError) throw new Error(text);
  return JSON.parse(text) as unknown;
}

/** 预置：一群渠道 + 一 toast 渠道 + 一分类 + 一主播 */
function seedBase(db: Db): { groupChannelId: number; toastChannelId: number; categoryId: number } {
  const groupChannelId = db.upsertPushChannel({
    name: '粉丝群', notifier: 'onebot', targetType: 'group', targetId: '12345', enabled: true,
  });
  const toastChannelId = db.upsertPushChannel({ name: '系统通知', notifier: 'toast', enabled: true });
  const categoryId = db.upsertCategory({
    name: '歌回', llmPrompt: null, keywords: ['歌'], areas: [], condMode: 'and', enabled: true,
  });
  db.upsertStreamer({ uid: '7706705', uname: '阿梓从小就很可爱', watch: true });
  return { groupChannelId, toastChannelId, categoryId };
}

beforeEach(() => resetMcpWriteLimiter());

// ---- 鉴权 ----

test('未配置 token → 503；坏 token / 无 token → 401', async (t) => {
  const bare = await setup(t, { withTokens: false });
  const r1 = await fetch(`${bare.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r1.status, 503);

  const f = await setup(t);
  for (const headers of [{}, { authorization: 'Bearer wrong-token' }]) {
    const r = await fetch(`${f.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
    assert.equal(r.status, 401);
  }
});

// ---- 角色工具面过滤 ----

test('gateway 看不到 admin 工具，admin 看不到 gateway 工具', async (t) => {
  const f = await setup(t);
  const gw = await mcpClient(f, GATEWAY_TOKEN);
  const gwTools = (await gw.listTools()).tools.map((x) => x.name);
  assert.ok(gwTools.includes('get_status'));
  assert.ok(gwTools.includes('add_group_push_rule'));
  assert.ok(!gwTools.includes('set_push_enabled'));
  assert.ok(!gwTools.includes('set_llm_key'));

  const adm = await mcpClient(f, ADMIN_TOKEN);
  const admTools = (await adm.listTools()).tools.map((x) => x.name);
  assert.ok(admTools.includes('set_push_enabled'));
  assert.ok(admTools.includes('update_runtime_config'));
  assert.ok(!admTools.includes('add_group_push_rule')); // admin 走全量规则 CRUD
});

// ---- gateway 群规则自助 ----

test('add_group_push_rule：正常建（createdBy=mcp）+ 渠道类型/名单/分类约束', async (t) => {
  const f = await setup(t);
  const { groupChannelId, toastChannelId, categoryId } = seedBase(f.db);
  const gw = await mcpClient(f, GATEWAY_TOKEN);

  const ok = (await call(gw, 'add_group_push_rule', { channelId: groupChannelId, uid: '7706705', categoryId })) as { id: number };
  const rule = f.db.listPushRules().find((r) => r.id === ok.id)!;
  assert.equal(rule.createdBy, 'mcp');
  assert.deepEqual(rule.channels, [groupChannelId]);
  assert.deepEqual(rule.uids, ['7706705']);

  // toast 渠道拒、不存在的主播拒、不存在的分类拒、重复拒
  await assert.rejects(call(gw, 'add_group_push_rule', { channelId: toastChannelId, uid: '7706705' }), /群渠道/);
  await assert.rejects(call(gw, 'add_group_push_rule', { channelId: groupChannelId, uid: '999' }), /不在监听名单/);
  await assert.rejects(call(gw, 'add_group_push_rule', { channelId: groupChannelId, uid: '7706705', categoryId: 9999 }), /分类不存在/);
  await assert.rejects(call(gw, 'add_group_push_rule', { channelId: groupChannelId, uid: '7706705', categoryId }), /已有相同规则/);

  // list_group_channels 只回群渠道
  const groups = (await call(gw, 'list_group_channels')) as Array<{ id: number; groupId: string }>;
  assert.deepEqual(groups, [{ id: groupChannelId, name: '粉丝群', groupId: '12345' }]);
});

test('remove_group_push_rule：只能删 createdBy=mcp 的规则', async (t) => {
  const f = await setup(t);
  const { groupChannelId } = seedBase(f.db);
  const gw = await mcpClient(f, GATEWAY_TOKEN);

  // 面板规则（createdBy=null）动不了
  const panelRuleId = f.db.upsertPushRule({ name: '面板规则', categoryId: null, uids: [], channels: [groupChannelId], messageTemplate: null, enabled: true });
  await assert.rejects(call(gw, 'remove_group_push_rule', { id: panelRuleId }), /群自助/);

  const created = (await call(gw, 'add_group_push_rule', { channelId: groupChannelId, uid: '7706705' })) as { id: number };
  await call(gw, 'remove_group_push_rule', { id: created.id });
  assert.equal(f.db.listPushRules().some((r) => r.id === created.id), false);
  assert.ok(f.db.listPushRules().some((r) => r.id === panelRuleId)); // 面板规则还在
});

test('add_group_push_rule：单渠道 20 条配额上限', async (t) => {
  const f = await setup(t);
  const { groupChannelId } = seedBase(f.db);
  for (let i = 1; i <= 20; i++) f.db.upsertStreamer({ uid: String(1000 + i), uname: `主播${i}` });
  const gw = await mcpClient(f, GATEWAY_TOKEN);
  for (let i = 1; i <= 20; i++) {
    await call(gw, 'add_group_push_rule', { channelId: groupChannelId, uid: String(1000 + i) });
  }
  resetMcpWriteLimiter(); // 绕过限流，专测配额
  await assert.rejects(
    call(gw, 'add_group_push_rule', { channelId: groupChannelId, uid: '7706705', categoryId: null, name: 'x', messageTemplate: 'y' }),
    /已达上限/,
  );
});

test('gateway 写限流：20 次/10 分钟后拒绝', async (t) => {
  const f = await setup(t);
  seedBase(f.db);
  const gw = await mcpClient(f, GATEWAY_TOKEN);
  for (let i = 0; i < 20; i++) {
    await assert.rejects(call(gw, 'remove_group_push_rule', { id: 99999 }), /规则不存在/);
  }
  await assert.rejects(call(gw, 'remove_group_push_rule', { id: 99999 }), /太频繁/);
});

// ---- admin 写路径 ----

test('admin：watch_streamer / unwatch_streamer / set_streamer', async (t) => {
  const f = await setup(t);
  f.db.upsertFollows([{ uid: '33999142', uname: '七海Nana7mi', face: 'http://example.com/f.jpg' }]);
  const adm = await mcpClient(f, ADMIN_TOKEN);

  // 从候选池新建监听（预填 uname/face）
  const w = (await call(adm, 'watch_streamer', { uid: '33999142' })) as { streamer: { uname: string; watch: boolean; face: string } };
  assert.equal(w.streamer.uname, '七海Nana7mi');
  assert.equal(w.streamer.watch, true);
  assert.equal(w.streamer.face, 'http://example.com/f.jpg');
  await assert.rejects(call(adm, 'watch_streamer', { uid: '33999142' }), /已在监听名单/);

  await call(adm, 'set_streamer', { uid: '33999142', alias: '海子姐', profileNote: '测试备注' });
  const s = f.db.getStreamer('33999142')!;
  assert.equal(s.alias, '海子姐');
  assert.equal(s.profileNote, '测试备注');

  await call(adm, 'unwatch_streamer', { uid: '33999142' });
  assert.equal(f.db.getStreamer('33999142')!.watch, false);
});

test('admin：update_runtime_config 校验 + 热生效回调；set_listen 回调', async (t) => {
  const f = await setup(t);
  const adm = await mcpClient(f, ADMIN_TOKEN);

  const r = (await call(adm, 'update_runtime_config', { pollIntervalSec: 120 })) as { pollIntervalSec: number };
  assert.equal(r.pollIntervalSec, 120);
  assert.equal(f.db.getSetting('poll_interval_sec'), '120');
  assert.equal(f.advancedChanged.count, 1);

  await assert.rejects(call(adm, 'update_runtime_config', {}), /没有可保存的字段/);

  const l = (await call(adm, 'set_listen', { feature: 'dynamic', enabled: false })) as { enabled: boolean; setting: string };
  assert.equal(l.enabled, false);
  assert.equal(l.setting, '0');
  assert.equal(f.listenChanged.count, 1);
});

test('admin：set_llm_key 存 settings 且不回显值', async (t) => {
  const f = await setup(t, { withLlm: true });
  const adm = await mcpClient(f, ADMIN_TOKEN);

  await call(adm, 'set_llm_key', { name: 'TestLLM', value: 'sk-a,sk-b' });
  assert.equal(f.db.getSetting('llm_key:TestLLM'), 'sk-a,sk-b');

  const list = (await call(adm, 'list_llm_providers')) as { providers: Array<{ name: string; keyCount: number }> };
  assert.equal(list.providers[0]!.keyCount, 2);
  assert.ok(!JSON.stringify(list).includes('sk-a')); // key 值不出现在工具结果里

  await assert.rejects(call(adm, 'set_llm_key', { name: 'Nope', value: 'x' }), /provider 不存在/);
});

// ---- 共享只读 ----

test('search_posts：keyword/uid 过滤 + limit 上限 + raw 不下发', async (t) => {
  const f = await setup(t);
  seedBase(f.db);
  f.db.insertPosts([
    { platform: 'bili_dynamic', uid: '7706705', itemId: '1', type: 'DYNAMIC_TYPE_WORD', text: '今晚八点歌回', pics: [], pubTs: 1000, url: null, raw: '{"a":1}' },
    { platform: 'bili_dynamic', uid: '7706705', itemId: '2', type: 'DYNAMIC_TYPE_WORD', text: '明天休息', pics: [], pubTs: 2000, url: null, raw: null },
    { platform: 'weibo', uid: '7706705', itemId: '3', type: 'weibo', text: '歌回预告在微博', pics: [], pubTs: 3000, url: null, raw: null },
  ]);
  const adm = await mcpClient(f, ADMIN_TOKEN);

  const all = (await call(adm, 'search_posts', { uid: '7706705' })) as Array<{ text: string; raw?: string }>;
  assert.equal(all.length, 3);
  assert.equal(all[0]!.text, '歌回预告在微博'); // pub_ts 倒序
  assert.equal(all[0]!.raw, undefined);

  const kw = (await call(adm, 'search_posts', { keyword: '歌回', platform: 'bili_dynamic' })) as Array<{ text: string }>;
  assert.deepEqual(kw.map((p) => p.text), ['今晚八点歌回']);

  // LIKE 通配符按字面处理（% 不炸库也不放大匹配）
  const wild = (await call(adm, 'search_posts', { keyword: '%' })) as unknown[];
  assert.equal(wild.length, 0);
});
