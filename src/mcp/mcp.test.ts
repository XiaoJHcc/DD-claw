/**
 * MCP 端点测试：真实 http.Server + SDK client 走完整 Streamable HTTP 链路。
 * 覆盖：token 鉴权（401/503）、角色工具面过滤、渠道自助约束（scope 注入的渠道类型/名单/配额/
 * created_by 隔离/渠道归属校验/copy-on-write 拆分/未绑渠道拒绝）、读侧服务端裁剪、按渠道限流、
 * admin 行为（写路径 + 不在自助面上）、写快照与撤销接线、search_posts 检索。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Db } from '../core/db.js';
import { createPanelServer, type PanelDeps, type PanelStatus } from '../panel/server.js';
import { listMcpTokens, saveMcpTokens, type McpTokenEntry } from '../mcp/auth.js';
import { resetMcpWriteLimiter } from '../mcp/rate-limit.js';
import { runTool } from '../mcp/run-tool.js';
import { allToolDefs } from '../mcp/tools.js';
import { saveLlmProviders, listLlmProviders } from '../analysis/providers.js';
import { listDecisionProviders, saveDecisionProviders } from '../analysis/decision-providers.js';
import { emptyXFeedSnapshot, getXConfig, saveXConfig } from '../core/x-config.js';
import { emptyWeiboFeedSnapshot } from '../core/weibo-accounts.js';
import { UndoStore, adminScope, channelScope, undoEffects, type UndoEffect } from '../core/undo.js';

const ADMIN_TOKEN = 'ddc_test_admin';
const GATEWAY_TOKEN = 'ddc_test_gateway';

interface Fixture {
  db: Db;
  base: string;
  listenChanged: { count: number };
  advancedChanged: { count: number };
  /** 写快照（P0 接线后所有写工具都经它落变更记录） */
  undo: UndoStore;
  /** 撤销执行器实际用过的栈标识（验证调用域解析：admin=全局、gateway=本渠道） */
  undoScopes: string[];
  /** 撤销后按 undoEffects 触发的热生效计数 */
  undoFired: Record<UndoEffect, number>;
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
  const undo = new UndoStore(db.raw);
  undo.migrate();
  // 撤销执行器（生产装配形状：撤栈顶 + 按 core/undo.ts 的 undoEffects 触发热生效回调；
  // 回调闭包在 index.ts，测试里用计数桩代替——映射函数是生产代码）
  const undoScopes: string[] = [];
  const undoFired: Record<UndoEffect, number> = { runtime: 0, listen: 0, llm: 0, notifiers: 0 };
  const undoLast: NonNullable<PanelDeps['undoLast']> = (scope) => {
    const s = scope ?? adminScope();
    undoScopes.push(s);
    const r = undo.undo(s);
    if (r.ok) for (const e of undoEffects(r)) undoFired[e]++;
    return r;
  };
  // X 分页 dep（生产装配形状）：配置落 settings，探测/校验走网络（测试里不触发）
  const xChanged = { count: 0 };
  const weiboChanged = { count: 0 };
  const deps: PanelDeps = {
    db,
    undo,
    undoLast,
    status: () => status,
    listen: {
      login: () => ({ bili: true, weibo: true, twitter: getXConfig(db).proxyUrl.trim() !== '' }),
      onChanged: () => listenChanged.count++,
    },
    advanced: { onChanged: () => advancedChanged.count++ },
    llm: {
      store: { list: () => listLlmProviders(db), save: (ps) => saveLlmProviders(db, ps) },
      // test_llm_provider 用的最小桩：状态按 settings 里的 key 推导，ping 不真实打网络
      router: {
        providerStatus: (name: string) =>
          listLlmProviders(db).some((p) => p.name === name)
            ? (db.getSetting(`llm_key:${name}`) ? '正常' : '缺 key')
            : null,
        ping: async (name: string) => {
          if (name === 'Broken') throw new Error('connect ECONNREFUSED');
          return 12;
        },
        refreshKeys: () => {},
      } as unknown as NonNullable<PanelDeps['llm']>['router'],
    },
    decision: {
      store: { list: () => listDecisionProviders(db), save: (ps) => saveDecisionProviders(db, ps) },
      probe: async (spec) => {
        if (spec.name === 'Broken') throw new Error('connect ECONNREFUSED');
        return { ms: 9, model: spec.model };
      },
    },
    x: {
      info: () => ({ config: getXConfig(db), status: { proxy: { ok: false, message: '尚未测试', checkedAt: null }, instances: [], web: { ok: false, message: '尚未测试', checkedAt: null }, feed: emptyXFeedSnapshot(), updatedAt: null } }),
      save: (patch) => { saveXConfig(db, patch); return getXConfig(db); },
      test: async (req) => ({ echo: req }),
      verify: async (screenName) => (screenName.includes('ghost')
        ? { checked: true, ok: false, kind: 'not-found' as const, message: '账号不存在' }
        : { checked: true, ok: true, kind: 'ok' as const, message: '账号存在' }),
      onChanged: () => xChanged.count++,
    },
    // 微博分页 dep（生产装配形状）：只有状态快照 + 名单热生效回调；昵称解析走 weiboResolver
    weibo: {
      info: () => ({
        config: { intervalSec: 300 },
        status: { feed: emptyWeiboFeedSnapshot(), accounts: db.listWeiboAccounts(true).length },
      }),
      onChanged: () => weiboChanged.count++,
    },
    weiboResolver: {
      resolveUid: async (nick) => (nick === '渡瀬結月' ? '2203177060' : null),
    },
    testPush: async () => ({ total: 2, succeeded: 2 }),
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
  return {
    db, base: `http://127.0.0.1:${port}`, listenChanged, advancedChanged, undo, undoScopes, undoFired, clients,
  };
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

test('真实 MCP 链路拒绝旧 uids，新建和更新都不会静默扩大范围', async (t) => {
  const fixture = await setup(t);
  const { toastChannelId } = seedBase(fixture.db);
  const client = await mcpClient(fixture, ADMIN_TOKEN);
  const args = { name: '旧规则', uids: ['7706705'], channels: [toastChannelId] };
  await assert.rejects(call(client, 'upsert_push_rule', args), /uids/);
  assert.equal(fixture.db.listPushRules().length, 0);
  const id = fixture.db.upsertPushRule({ scope: ['7706705'], channels: [toastChannelId] });
  await assert.rejects(call(client, 'upsert_push_rule', { ...args, id }), /uids/);
  assert.deepEqual(fixture.db.listPushRules()[0]!.scope, ['7706705']);
});

test('内容审计只暴露给 admin，gateway 工具面不可见', async (t) => {
  const fixture = await setup(t);
  const admin = await mcpClient(fixture, ADMIN_TOKEN);
  const gateway = await mcpClient(fixture, GATEWAY_TOKEN);
  assert.ok((await admin.listTools()).tools.some((tool) => tool.name === 'get_content_audit'));
  assert.ok(!(await gateway.listTools()).tools.some((tool) => tool.name === 'get_content_audit'));
  assert.deepEqual(await call(admin, 'get_content_audit', { subjectType: 'post', subjectId: 'twitter:missing' }), { audit: null, verdicts: [] });
});

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

/** 追加令牌（叠加在 fixture 已有令牌上）：绑渠道的 gateway 令牌要等渠道建出来才定得下 id */
function addTokens(db: Db, ...entries: McpTokenEntry[]): void {
  saveMcpTokens(db, [...listMcpTokens(db), ...entries]);
}

/** 绑渠道的 gateway 客户端（渠道 id 由 seed 决定，故只能在 seed 之后调） */
async function gwClient(f: Fixture, name: string, channelId: number): Promise<Client> {
  const token = `ddc_${name}`;
  addTokens(f.db, { name, role: 'gateway', token, channelId });
  return mcpClient(f, token);
}

/** 预置：A/B 两个群渠道 + 一个私聊渠道 + 一个 toast 渠道 + 一分类 + 两主播（渠道隔离测试用） */
function seedChannels(db: Db): {
  a: number; b: number; priv: number; toast: number; categoryId: number;
} {
  const a = db.upsertPushChannel({
    name: 'A群', notifier: 'onebot', targetType: 'group', targetId: '111', enabled: true,
  });
  const b = db.upsertPushChannel({
    name: 'B群', notifier: 'onebot', targetType: 'group', targetId: '222', enabled: true,
  });
  const priv = db.upsertPushChannel({
    name: '私聊', notifier: 'onebot', targetType: 'private', targetId: '333', enabled: true,
  });
  const toast = db.upsertPushChannel({ name: '系统通知', notifier: 'toast', enabled: true });
  const categoryId = db.upsertCategory({
    name: '歌回', llmPrompt: null, keywords: ['歌'], areas: [], condMode: 'and', enabled: true,
  });
  db.upsertStreamer({ uid: '7706705', uname: '阿梓从小就很可爱', watch: true });
  db.upsertStreamer({ uid: '1001', uname: '七海Nana7mi', watch: true });
  return { a, b, priv, toast, categoryId };
}

beforeEach(() => resetMcpWriteLimiter());

// ---- 鉴权 ----

test('未配置 token → 503；坏 token / 无 token → 401', async (t) => {
  const bare = await setup(t, { withTokens: false });
  const r1 = await fetch(`${bare.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r1.status, 503);

  const f = await setup(t);
  const headerCases: Record<string, string>[] = [{}, { authorization: 'Bearer wrong-token' }];
  for (const extra of headerCases) {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...extra };
    const r = await fetch(`${f.base}/mcp`, { method: 'POST', headers, body: '{}' });
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

// ---- gateway 渠道自助（渠道只来自令牌绑定的调用域）----

test('add_group_push_rule：渠道由 scope 注入（参数里没有渠道）；名单/分类/去重/渠道类型约束', async (t) => {
  const f = await setup(t);
  const { groupChannelId, toastChannelId, categoryId } = seedBase(f.db);
  const gw = await gwClient(f, 'gwA', groupChannelId);

  const ok = (await call(gw, 'add_group_push_rule', { uid: '7706705', categoryId })) as { id: number };
  const rule = f.db.listPushRules().find((r) => r.id === ok.id)!;
  assert.equal(rule.createdBy, 'mcp');
  assert.deepEqual(rule.channels, [groupChannelId], '渠道 = 令牌绑定的那条');
  assert.deepEqual(rule.scope, ['7706705']);

  // 身份字段不进 schema：tools/list 里看不到，参数里塞了也会被 zod 剥离
  const schema = (await gw.listTools()).tools.find((x) => x.name === 'add_group_push_rule')!.inputSchema;
  assert.equal('channelId' in (schema.properties ?? {}), false, 'add_group_push_rule 的 schema 里没有渠道字段');
  const spoof = (await call(gw, 'add_group_push_rule', {
    uid: '7706705', channelId: toastChannelId, groupId: '999',
  })) as { id: number };
  assert.deepEqual(f.db.listPushRules().find((r) => r.id === spoof.id)!.channels, [groupChannelId],
    '参数里的渠道声明无效（写在令牌绑定的渠道上）');

  // 不存在的主播拒、不存在的分类拒、重复拒
  await assert.rejects(call(gw, 'add_group_push_rule', { uid: '999' }), /不在监听名单/);
  await assert.rejects(call(gw, 'add_group_push_rule', { uid: '7706705', categoryId: 9999 }), /分类不存在/);
  await assert.rejects(call(gw, 'add_group_push_rule', { uid: '7706705', categoryId }), /已有相同规则/);

  // 渠道类型：绑到 toast 渠道的令牌自助被拒（空列表 + add 拒绝）
  const gwToast = await gwClient(f, 'gwToast', toastChannelId);
  await assert.rejects(call(gwToast, 'add_group_push_rule', { uid: '7706705' }), /QQ 群\/私聊渠道/);
  assert.deepEqual(await call(gwToast, 'list_group_channels'), []);

  // list_group_channels 只回本渠道一条
  const groups = (await call(gw, 'list_group_channels')) as Array<{ id: number; targetType: string; groupId: string }>;
  assert.deepEqual(groups, [{ id: groupChannelId, name: '粉丝群', targetType: 'group', groupId: '12345' }]);
});

test('渠道类型放开：私聊渠道一视同仁（list_group_channels 回本渠道、add 成功）', async (t) => {
  const f = await setup(t);
  const { priv, categoryId } = seedChannels(f.db);
  const gw = await gwClient(f, 'gwPriv', priv);

  assert.deepEqual(await call(gw, 'list_group_channels'), [
    { id: priv, name: '私聊', targetType: 'private', groupId: '333' },
  ]);
  const ok = (await call(gw, 'add_group_push_rule', { uid: '7706705', categoryId })) as { id: number };
  assert.deepEqual(f.db.listPushRules().find((r) => r.id === ok.id)!.channels, [priv], '私聊渠道与群同一条路径');
});

test('未绑渠道的 gateway：读写一律拒绝（绝不回落默认渠道，也不回落「全部」）', async (t) => {
  const f = await setup(t);
  seedBase(f.db);
  const gw = await mcpClient(f, GATEWAY_TOKEN); // fixture 的 gateway 令牌未绑渠道

  await assert.rejects(call(gw, 'add_group_push_rule', { uid: '7706705' }), /未绑定渠道/);
  await assert.rejects(call(gw, 'remove_group_push_rule', { id: 1 }), /未绑定渠道/);
  await assert.rejects(call(gw, 'list_push_rules'), /未绑定渠道/);
  await assert.rejects(call(gw, 'list_group_channels'), /未绑定渠道/);
  assert.deepEqual(f.db.listPushRules(), [], '一行都没写');
});

test('remove_group_push_rule：非 mcp 单渠道规则也移出本渠道（channels 置空、行与内容保留、可撤销）', async (t) => {
  const f = await setup(t);
  const { groupChannelId } = seedBase(f.db);
  const gw = await gwClient(f, 'gwA', groupChannelId);

  // 面板规则（createdBy=null）且只推本渠道：只允许渠道级操作 → channels 置空，不整条删
  const panelRuleId = f.db.upsertPushRule({
    name: '面板规则', categoryId: null, scope: ['7706705'], channels: [groupChannelId],
    messageTemplate: '{liver} 来了', enabled: true,
  });
  const r = (await call(gw, 'remove_group_push_rule', { id: panelRuleId })) as {
    ok: boolean; id: number; split: boolean; ruleRemoved: boolean;
  };
  assert.deepEqual(r, { ok: true, id: panelRuleId, split: false, ruleRemoved: false },
    '渠道级移出（不是整条删除，也没有可拆的其余渠道）');

  const kept = f.db.listPushRules().find((x) => x.id === panelRuleId)!;
  assert.deepEqual(kept.channels, [], '本渠道已移出（规则不再推任何地方）');
  assert.equal(kept.createdBy, null, 'createdBy 保持原值（不是自助规则）');
  assert.equal(kept.name, '面板规则', '行与内容全留（主人可在面板删除）');
  assert.equal(kept.messageTemplate, '{liver} 来了');
  assert.deepEqual(kept.scope, ['7706705']);
  assert.equal(kept.categoryId, null);
  assert.equal(kept.enabled, true);

  // 渠道级移出也是写路径：走本渠道撤销栈，撤销即还原
  await call(gw, 'undo_last_change');
  assert.deepEqual(f.db.listPushRules().find((x) => x.id === panelRuleId)!.channels, [groupChannelId],
    '撤销还原本渠道');
});

test('remove_group_push_rule：自助规则只推本渠道 → 就地整条删除', async (t) => {
  const f = await setup(t);
  const { groupChannelId } = seedBase(f.db);
  const gw = await gwClient(f, 'gwA', groupChannelId);

  const created = (await call(gw, 'add_group_push_rule', { uid: '7706705' })) as { id: number };
  const r = (await call(gw, 'remove_group_push_rule', { id: created.id })) as {
    ok: boolean; id: number; split: boolean; ruleRemoved: boolean;
  };
  assert.deepEqual(r, { ok: true, id: created.id, split: false, ruleRemoved: true });
  assert.equal(f.db.listPushRules().some((x) => x.id === created.id), false, '自助规则整条删除');
});

test('remove_group_push_rule：渠道归属校验——推别的渠道的规则碰不到', async (t) => {
  const f = await setup(t);
  const { a, b } = seedChannels(f.db);
  const gwA = await gwClient(f, 'gwA', a);
  const gwB = await gwClient(f, 'gwB', b);
  const bRule = (await call(gwB, 'add_group_push_rule', { uid: '7706705' })) as { id: number };

  await assert.rejects(call(gwA, 'remove_group_push_rule', { id: bRule.id }), /不推送本渠道/);
  assert.ok(f.db.listPushRules().some((r) => r.id === bRule.id), 'B 群的规则一行不动');
  await call(gwB, 'remove_group_push_rule', { id: bRule.id }); // 自己那条照删
});

test('remove_group_push_rule：多渠道规则走 copy-on-write（原规则保留其余渠道、内容一行不动）', async (t) => {
  const f = await setup(t);
  const { a, b } = seedChannels(f.db);
  const gwA = await gwClient(f, 'gwA', a);

  // 面板规则推 A+B（本渠道是其中一条）
  const sharedId = f.db.upsertPushRule({
    name: '双群规则', categoryId: null, scope: ['7706705'], channels: [a, b],
    messageTemplate: '{liver} 来了', enabled: true,
  });
  const r = (await call(gwA, 'remove_group_push_rule', { id: sharedId })) as {
    ok: boolean; id: number; split: boolean; ruleRemoved: boolean;
  };
  assert.deepEqual(r, { ok: true, id: sharedId, split: true, ruleRemoved: false });

  const rules = f.db.listPushRules();
  assert.equal(rules.length, 1, '拆出的副本随同一次写删掉，不留半成品');
  const kept = rules[0]!;
  assert.equal(kept.id, sharedId, '原规则还是它自己（不是新拆的那条）');
  assert.deepEqual(kept.channels, [b], '原规则保留其余渠道');
  assert.equal(kept.createdBy, null, '原规则 createdBy 原样，没被标成 mcp 规则');
  assert.equal(kept.name, '双群规则', '内容一行不动');
  assert.equal(kept.messageTemplate, '{liver} 来了');
  assert.deepEqual(kept.scope, ['7706705']);

  // 自助的多渠道规则同理（admin 给它加了别的渠道后，本渠道只能把自己移出）
  const mcpId = (await call(gwA, 'add_group_push_rule', { uid: '7706705' })) as { id: number };
  const mcpRule = f.db.listPushRules().find((x) => x.id === mcpId.id)!;
  f.db.upsertPushRule({ id: mcpId.id, channels: [...mcpRule.channels, b] }); // 不动 createdBy → 仍是 mcp 规则
  const r2 = (await call(gwA, 'remove_group_push_rule', { id: mcpId.id })) as { split: boolean; ruleRemoved: boolean };
  assert.deepEqual(r2, { ok: true, id: mcpId.id, split: true, ruleRemoved: false });
  assert.deepEqual(f.db.listPushRules().find((x) => x.id === mcpId.id)!.channels, [b], '原规则保留 B 群');
});

test('add_group_push_rule：单渠道 20 条配额上限', async (t) => {
  const f = await setup(t);
  const { groupChannelId } = seedBase(f.db);
  for (let i = 1; i <= 20; i++) f.db.upsertStreamer({ uid: String(1000 + i), uname: `主播${i}` });
  const gw = await gwClient(f, 'gwA', groupChannelId);
  for (let i = 1; i <= 20; i++) {
    await call(gw, 'add_group_push_rule', { uid: String(1000 + i) });
  }
  resetMcpWriteLimiter(); // 绕过限流，专测配额
  await assert.rejects(
    call(gw, 'add_group_push_rule', { uid: '7706705', categoryId: null, name: 'x', messageTemplate: 'y' }),
    /已达上限/,
  );
});

test('gateway 写限流：20 次/10 分钟后拒绝（按渠道分桶：A 群打满不影响 B 群）', async (t) => {
  const f = await setup(t);
  const { a, b } = seedChannels(f.db);
  const gwA = await gwClient(f, 'gwA', a);
  const gwB = await gwClient(f, 'gwB', b);
  for (let i = 0; i < 20; i++) {
    await assert.rejects(call(gwA, 'remove_group_push_rule', { id: 99999 }), /规则不存在/);
  }
  await assert.rejects(call(gwA, 'remove_group_push_rule', { id: 99999 }), /太频繁/);

  // 另一个渠道的桶是独立的：B 群照常能写（A 群吵不影响 B 群）
  const okB = (await call(gwB, 'add_group_push_rule', { uid: '7706705' })) as { id: number };
  assert.ok(okB.id > 0, 'B 群的桶没被 A 群打满');

  // 同一渠道的另一条令牌共桶（一渠道一桶，换令牌不改桶）
  const gwA2 = await gwClient(f, 'gwA2', a);
  await assert.rejects(call(gwA2, 'remove_group_push_rule', { id: 99999 }), /太频繁/);
});

// ---- 读侧服务端裁剪 + admin 行为不变 ----

test('读侧服务端裁剪：gateway 只看到本渠道规则与渠道；admin 全量（行为不变）', async (t) => {
  const f = await setup(t);
  const { a, b, priv, toast } = seedChannels(f.db);
  const gwA = await gwClient(f, 'gwA', a);
  const adm = await mcpClient(f, ADMIN_TOKEN);

  const rA = f.db.upsertPushRule({ name: 'A 规则', categoryId: null, scope: [], channels: [a], messageTemplate: null, enabled: true });
  const rB = f.db.upsertPushRule({ name: 'B 规则', categoryId: null, scope: [], channels: [b], messageTemplate: null, enabled: true });
  const rShared = f.db.upsertPushRule({ name: 'A+B 共享', categoryId: null, scope: [], channels: [a, b], messageTemplate: null, enabled: true });

  const mine = (await call(gwA, 'list_push_rules')) as Array<{ id: number; sharedWithOtherChannels: boolean }>;
  assert.deepEqual(mine.map((r) => r.id), [rA, rShared], '只回本渠道的规则（含与其他渠道共享的多渠道规则）');
  assert.equal(mine.find((r) => r.id === rShared)!.sharedWithOtherChannels, true, '共享的多渠道规则带标注');
  assert.equal(mine.find((r) => r.id === rA)!.sharedWithOtherChannels, false);
  assert.equal(mine.some((r) => r.id === rB), false, '别渠道的规则不进上下文');

  const chans = (await call(gwA, 'list_channels')) as Array<{ id: number }>;
  assert.deepEqual(chans.map((c) => c.id), [a], 'gateway 只看到本渠道一条渠道（别渠道的群号不进上下文）');

  // admin / 面板：全量、形状与改造前一致（不带裁剪标注）
  const all = (await call(adm, 'list_push_rules')) as Array<{ id: number; sharedWithOtherChannels?: boolean }>;
  assert.deepEqual(all.map((r) => r.id), [rA, rB, rShared]);
  assert.equal('sharedWithOtherChannels' in all[0]!, false, 'admin 拿到的规则对象形状不变');
  assert.deepEqual(((await call(adm, 'list_channels')) as Array<{ id: number }>).map((c) => c.id), [a, b, priv, toast]);
});

test('admin 行为不变：自助工具对 admin 不可见；落到自助 handler 上被明确拒绝（不静默写某个渠道）', async (t) => {
  const f = await setup(t);
  const { a, b } = seedChannels(f.db);
  const adm = await mcpClient(f, ADMIN_TOKEN);
  const admTools = (await adm.listTools()).tools.map((x) => x.name);
  for (const name of ['add_group_push_rule', 'remove_group_push_rule', 'list_group_channels']) {
    assert.equal(admTools.includes(name), false, `admin 不应看到渠道自助工具 ${name}`);
  }

  // admin 侧指定渠道一直有别的形状：upsert_push_rule 的 channels 参数（全量 CRUD，行为不变）
  const { id } = (await call(adm, 'upsert_push_rule', { name: '双群规则', channels: [a, b] })) as { id: number };
  assert.deepEqual(f.db.listPushRules().find((r) => r.id === id)!.channels, [a, b]);
  assert.equal(f.db.listPushRules().find((r) => r.id === id)!.createdBy, null, 'admin 建的是面板规则（非 mcp 标记）');

  // 万一有别的接线用 admin ctx 直调自助工具：明确 403 指路，绝不静默挑渠道
  const def = allToolDefs().find((d) => d.name === 'add_group_push_rule')!;
  const r = await runTool({} as PanelDeps, def, { uid: '7706705' }, { name: 'panel', role: 'admin', scope: {} });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.match(r.error, /admin 令牌没有渠道 scope/);
  assert.equal(f.db.listPushRules().length, 1, '拒绝时一行都不写');
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

// ---- X / 推特（轴 B：新能力先进注册表，MCP 与面板共用同一套校验与 Db 方法）----

test('X 工具：list/upsert/delete 账号与配置读写走注册表，写路径与面板同语义', async (t) => {
  const f = await setup(t);
  const adm = await mcpClient(f, ADMIN_TOKEN);

  const empty = (await call(adm, 'list_x_accounts')) as { accounts: unknown[] };
  assert.deepEqual(empty.accounts, [], '初始空名单');

  const created = (await call(adm, 'upsert_x_account', { screenName: '@Watase_Yuzuki' })) as {
    id: number; account: { screenName: string; enabled: boolean };
  };
  assert.equal(created.account.screenName, 'watase_yuzuki', '归一化与面板一致');
  assert.equal(f.db.listXAccounts().length, 1);

  // 重名 409（错误消息透传到 MCP 客户端）
  await assert.rejects(() => call(adm, 'upsert_x_account', { screenName: 'watase_yuzuki' }), /已在名单里/);

  // 关联主播必须存在
  await assert.rejects(() => call(adm, 'upsert_x_account', { screenName: 'd4dj_pj', biliUid: '9999' }), /不在监听名单/);
  f.db.upsertStreamer({ uid: '1001', uname: '阿梓', watch: true });
  await call(adm, 'upsert_x_account', { screenName: 'd4dj_pj', biliUid: '1001', enabled: false });

  const listed = (await call(adm, 'list_x_accounts')) as { accounts: Array<{ screenName: string; biliName: string | null; enabled: boolean }> };
  assert.deepEqual(listed.accounts.map((a) => a.screenName), ['d4dj_pj', 'watase_yuzuki']);
  assert.equal(listed.accounts[0]!.biliName, '阿梓', '回显关联主播展示名');
  assert.equal(listed.accounts[0]!.enabled, false, '停用状态可见');

  // 更新（带 id）
  await call(adm, 'upsert_x_account', { id: created.id, enabled: false });
  assert.equal(f.db.getXAccount(created.id)!.enabled, false);

  // 配置读写
  await call(adm, 'update_x_config', { intervalSec: 600, fallbackHtml: false });
  assert.equal(f.db.getSetting('x_interval_sec'), '600');
  const got = (await call(adm, 'get_x_config')) as { config: { intervalSec: number; fallbackHtml: boolean } };
  assert.equal(got.config.intervalSec, 600);
  assert.equal(got.config.fallbackHtml, false);

  // 删除
  await call(adm, 'delete_x_account', { id: created.id });
  assert.equal(f.db.listXAccounts().length, 1);
  await assert.rejects(() => call(adm, 'delete_x_account', { id: created.id }), /X 账号不存在/);
});

test('X 工具：gateway 角色看不到（配置含代理地址，属运维面）', async (t) => {
  const f = await setup(t);
  const gw = await mcpClient(f, GATEWAY_TOKEN);
  const tools = (await gw.listTools()).tools.map((x) => x.name);
  assert.equal(tools.includes('get_x_config'), false, 'admin 专属');
  assert.equal(tools.includes('upsert_x_account'), false, 'admin 专属');
  assert.equal(tools.includes('list_x_accounts'), true, '只读名单对群友可见');
});

// ---- 微博（图文分页第二个来源）：与 X 同构的一整套工具 ----

test('微博工具：list/upsert/delete 账号；昵称解析补 uid；写路径与面板同语义', async (t) => {
  const f = await setup(t);
  const adm = await mcpClient(f, ADMIN_TOKEN);

  assert.deepEqual(((await call(adm, 'list_weibo_accounts')) as { accounts: unknown[] }).accounts, []);

  // 只给昵称 → 走解析链；解析不到 → 拒
  await assert.rejects(() => call(adm, 'upsert_weibo_account', { nickname: '查无此人' }), /找不到这个昵称/);
  const byNick = (await call(adm, 'upsert_weibo_account', { nickname: '渡瀬結月' })) as {
    id: number; account: { uid: string; nickname: string };
  };
  assert.equal(byNick.account.uid, '2203177060');
  assert.equal(byNick.account.nickname, '渡瀬結月');
  assert.equal(f.db.listWeiboAccounts().length, 1);
  await assert.rejects(() => call(adm, 'upsert_weibo_account', { uid: '2203177060' }), /已在名单里/);

  // 直填 uid 也能建（另起一个账号）
  const created = (await call(adm, 'upsert_weibo_account', { uid: '9999' })) as {
    id: number; account: { uid: string; enabled: boolean };
  };
  assert.equal(created.account.uid, '9999');
  assert.equal(f.db.listWeiboAccounts().length, 2);

  // 关联主播必须存在；更新带 id。uid 与昵称是平台事实：更新时传入直接拒绝
  await assert.rejects(() => call(adm, 'upsert_weibo_account', { uid: '111', biliUid: '9999' }), /不在监听名单/);
  f.db.upsertStreamer({ uid: '1001', uname: '阿梓', watch: true });
  await assert.rejects(
    () => call(adm, 'upsert_weibo_account', { id: byNick.id, nickname: '阿梓' }),
    /平台事实不可改/,
  );
  await assert.rejects(
    () => call(adm, 'upsert_weibo_account', { id: byNick.id, uid: '8888' }),
    /平台事实不可改/,
  );
  await call(adm, 'upsert_weibo_account', { id: byNick.id, biliUid: '1001', enabled: false });
  const listed = (await call(adm, 'list_weibo_accounts')) as {
    accounts: Array<{ uid: string; nickname: string; biliName: string | null; enabled: boolean }>;
  };
  assert.equal(listed.accounts.find((a) => a.uid === '2203177060')!.biliName, '阿梓');
  assert.equal(listed.accounts.find((a) => a.uid === '2203177060')!.enabled, false);
  assert.equal(listed.accounts.find((a) => a.uid === '2203177060')!.nickname, '渡瀬結月', '昵称是平台事实，更新改不动');

  await call(adm, 'delete_weibo_account', { id: byNick.id });
  await assert.rejects(() => call(adm, 'delete_weibo_account', { id: byNick.id }), /微博账号不存在/);
});

test('微博工具：gateway 只读可见；set_streamer 填微博昵称会建/关联名单行', async (t) => {
  const f = await setup(t);
  const adm = await mcpClient(f, ADMIN_TOKEN);
  const gw = await mcpClient(f, GATEWAY_TOKEN);
  const tools = (await gw.listTools()).tools.map((x) => x.name);
  assert.equal(tools.includes('list_weibo_accounts'), true, '只读名单对群友可见');
  assert.equal(tools.includes('upsert_weibo_account'), false, '写是 admin 专属');
  assert.equal(tools.includes('delete_weibo_account'), false);

  f.db.upsertStreamer({ uid: '1001', uname: '阿梓', watch: true });
  await call(adm, 'set_streamer', { uid: '1001', weiboNick: '渡瀬結月' });
  const acc = f.db.getWeiboAccountByUid('2203177060')!;
  assert.equal(acc.biliUid, '1001', '主播详情填昵称 = 在微博名单里建行并关联');
  await call(adm, 'set_streamer', { uid: '1001', weiboNick: null });
  assert.equal(f.db.getWeiboAccountByUid('2203177060')!.biliUid, null, '清空 → 解关联但保留行');
});

test('upsert_push_rule：subject_kind=post 的规则——引用/翻译按新模型保存（图片筛选已上移进分类）', async (t) => {
  const f = await setup(t);
  const adm = await mcpClient(f, ADMIN_TOKEN);
  const { groupChannelId } = seedBase(f.db);

  const wbRule = (await call(adm, 'upsert_push_rule', {
    name: '通用规则', subjectKind: 'post', channels: [groupChannelId],
  })) as { id: number };
  const stored = f.db.listPushRules().find((r) => r.id === wbRule.id)!;
  assert.equal(stored.subjectKind, 'post');
  assert.deepEqual(stored.scope, [], '空 scope = 全部账号生效（D1）');

  // require_quote 分类对非 X 帖永不命中是语义（matcher 按帖子平台自然生效），不是保存校验错误；
  // 翻译是规则附加动作（D3），任何规则都可开
  const cat = (await call(adm, 'upsert_category', {
    name: '引用帖', appliesTo: 'post', requireQuote: true,
  })) as { id: number };
  const q = (await call(adm, 'upsert_push_rule', {
    name: '引用规则', subjectKind: 'post', categoryId: cat.id,
  })) as { id: number };
  assert.equal(f.db.listPushRules().find((r) => r.id === q.id)!.categoryId, cat.id);
  const tr = (await call(adm, 'upsert_push_rule', {
    name: '翻译规则', subjectKind: 'post', llmTranslate: true,
  })) as { id: number };
  assert.equal(f.db.listPushRules().find((r) => r.id === tr.id)!.llmTranslate, true);
});

test('search_posts：platform=twitter 可检索 X 归档；set_listen 支持 twitter', async (t) => {
  const f = await setup(t);
  const adm = await mcpClient(f, ADMIN_TOKEN);
  f.db.insertPosts([
    { platform: 'twitter', uid: 'watase_yuzuki', itemId: '9001', type: 'retweet', text: '转发的推文', pics: ['https://pbs.twimg.com/media/a.jpg'], pubTs: 5000, url: 'https://x.com/a/status/9001', raw: '{"b":2}' },
  ]);
  const only = (await call(adm, 'search_posts', { platform: 'twitter' })) as Array<{ itemId: string; pics: string[] }>;
  assert.equal(only.length, 1);
  assert.equal(only[0]!.itemId, '9001', 'X 帖也能按平台检索');
  assert.equal(only[0]!.pics.length, 1);

  const set = (await call(adm, 'set_listen', { feature: 'twitter', enabled: false })) as { feature: string; enabled: boolean };
  assert.equal(set.feature, 'twitter');
  assert.equal(set.enabled, false, '推特开关经 MCP 可关');
  assert.equal(f.db.getSetting('listen_twitter'), '0');
});

test('gateway 开播自助规则不能引用图文分类', async (t) => {
  const fixture = await setup(t);
  const { groupChannelId } = seedBase(fixture.db);
  const categoryId = fixture.db.upsertCategory({
    name: '图文带图', appliesTo: 'post', requireMedia: true,
    llmPrompt: null, keywords: [], areas: [], condMode: 'and', enabled: true,
  });
  const gateway = await gwClient(fixture, 'type-boundary', groupChannelId);
  await assert.rejects(
    () => call(gateway, 'add_group_push_rule', { uid: '7706705', categoryId }),
    /内容类型不一致/,
  );
  assert.equal(fixture.db.listPushRules().length, 0);
});

test('分类 + 图文规则工具：applies_to/post 条件组、引用校验、scope 账号引用校验、合并后校验', async (t) => {
  const f = await setup(t);
  const adm = await mcpClient(f, ADMIN_TOKEN);
  const { groupChannelId } = seedBase(f.db);

  // 分类：appliesTo=post + 条件组（原 filters 上移进分类）
  const cat = (await call(adm, 'upsert_category', {
    name: '只推带图原创', appliesTo: 'post', postTypes: ['original'], requireMedia: true,
  })) as { id: number };
  const cats = (await call(adm, 'list_categories')) as Array<{
    name: string; appliesTo: string; postTypes: string[]; requireMedia: boolean;
  }>;
  const row = cats.find((c) => c.name === '只推带图原创')!;
  assert.equal(row.appliesTo, 'post');
  assert.deepEqual(row.postTypes, ['original']);
  assert.equal(row.requireMedia, true);

  await assert.rejects(
    () => call(adm, 'upsert_push_rule', { categoryId: cat.id }),
    /内容类型不一致/,
  );
  await assert.rejects(
    () => call(adm, 'upsert_category', { id: cat.id, appliesTo: 'live' }),
    /内容类型不可更改/,
  );
  await assert.rejects(
    () => call(adm, 'upsert_category', { id: cat.id, areas: ['游戏'] }),
    /图文分类不能配置直播分区/,
  );

  // 死分类拒绝：所有条件组皆空且无 LLM 提示词
  await assert.rejects(
    () => call(adm, 'upsert_category', { name: '死分类', appliesTo: 'post' }),
    /至少配置/,
  );

  // 图文规则：引用该分类 + 渠道
  const created = (await call(adm, 'upsert_push_rule', {
    name: '带图原创规则', subjectKind: 'post', categoryId: cat.id, channels: [groupChannelId],
  })) as { id: number };
  const listed = (await call(adm, 'list_push_rules')) as Array<{
    subjectKind: string; scope: string[]; channels: number[];
  }>;
  const ruleRow = listed.find((r) => r.subjectKind === 'post')!;
  assert.deepEqual(ruleRow.scope, [], '空 scope = 全部生效');
  assert.deepEqual(ruleRow.channels, [groupChannelId]);

  await assert.rejects(() => call(adm, 'upsert_push_rule', { channels: [9999] }), /渠道不存在/);
  await assert.rejects(
    () => call(adm, 'upsert_push_rule', { subjectKind: 'post', scope: ['twitter:不存在'] }),
    /账号引用不存在/,
    'scope 账号引用必须在名单里',
  );

  // 更新：只改推送词，渠道沿用旧值（合并后仍要校验通过）
  await call(adm, 'upsert_push_rule', { id: created.id, messageTemplate: '{author} 更新了' });
  assert.equal(f.db.listPushRules().find((r) => r.id === created.id)!.messageTemplate, '{author} 更新了');

  await call(adm, 'delete_push_rule', { id: created.id });
  assert.equal(f.db.listPushRules().filter((r) => r.subjectKind === 'post').length, 0);
  await assert.rejects(() => call(adm, 'delete_push_rule', { id: created.id }), /不存在/);
});

test('账号工具的 ruleIds 入参退役：生效范围单一信源在规则 scope（双向视图写同一份数据）', async (t) => {
  const f = await setup(t);
  const adm = await mcpClient(f, ADMIN_TOKEN);

  const x = (await call(adm, 'upsert_x_account', { screenName: 'watase_yuzuki' })) as {
    id: number; account: Record<string, unknown>;
  };
  assert.equal('ruleIds' in x.account, false, '账号对象不再带 ruleIds');

  // 账号选用规则 = 写规则的 scope（A.2：账号卡勾选改写规则 scope）
  const rule = (await call(adm, 'upsert_push_rule', {
    name: 'r1', subjectKind: 'post', scope: ['twitter:watase_yuzuki'],
  })) as { id: number };
  assert.deepEqual(
    f.db.listPushRules().find((r) => r.id === rule.id)!.scope,
    ['twitter:watase_yuzuki'],
    'scope 是生效范围的唯一数据',
  );
  // 传 ruleIds 会被 schema 剥离（入参退役）：与真字段同传时静默忽略，只传 ruleIds 时按「没有可更新的字段」拒绝
  await call(adm, 'upsert_x_account', { id: x.id, displayName: '结月', ruleIds: [12345] });
  assert.equal(f.db.getXAccount(x.id)!.displayName, '结月', '真字段生效');
  await assert.rejects(
    () => call(adm, 'upsert_x_account', { id: x.id, ruleIds: [12345] }),
    /没有可更新的字段/,
  );

  // 三平台账号引用都能进 scope
  await call(adm, 'upsert_weibo_account', { uid: '2203177060' });
  await call(adm, 'upsert_bili_account', { uid: '7706705' });
  await call(adm, 'upsert_push_rule', {
    id: rule.id,
    scope: ['twitter:watase_yuzuki', 'weibo:2203177060', 'bili:7706705'],
  });
  assert.deepEqual(
    f.db.listPushRules().find((r) => r.id === rule.id)!.scope,
    ['twitter:watase_yuzuki', 'weibo:2203177060', 'bili:7706705'],
  );
});

test('B站动态账号工具：list/upsert/delete；uid 链接归一化；gateway 只读可见', async (t) => {
  const f = await setup(t);
  const adm = await mcpClient(f, ADMIN_TOKEN);
  const gw = await mcpClient(f, GATEWAY_TOKEN);
  const gwTools = (await gw.listTools()).tools.map((x) => x.name);
  assert.equal(gwTools.includes('list_bili_accounts'), true, '只读名单对群友可见');
  assert.equal(gwTools.includes('upsert_bili_account'), false, '写是 admin 专属');
  assert.equal(gwTools.includes('delete_bili_account'), false);

  assert.deepEqual(((await call(adm, 'list_bili_accounts')) as { accounts: unknown[] }).accounts, [], '初始空名单');

  const created = (await call(adm, 'upsert_bili_account', {
    uid: 'https://space.bilibili.com/7706705/dynamic', displayName: '阿梓',
  })) as { id: number; account: { uid: string; enabled: boolean } };
  assert.equal(created.account.uid, '7706705', '链接归一化成纯数字 uid');
  assert.equal(created.account.enabled, true, '新增默认启用');
  await assert.rejects(() => call(adm, 'upsert_bili_account', { uid: '7706705' }), /已在名单里/);

  // uname 是平台事实：新建/更新都不收手填，传入直接拒绝
  await assert.rejects(() => call(adm, 'upsert_bili_account', { uid: '9', uname: '手填名' }), /不接受手填/);
  await assert.rejects(
    () => call(adm, 'upsert_bili_account', { id: created.id, uname: '阿梓从小就很可爱' }),
    /不接受手填/,
  );

  // 更新（带 id）：启停；uid 是身份锚点不可改
  await assert.rejects(() => call(adm, 'upsert_bili_account', { id: created.id, uid: '9' }), /身份锚点不可改/);
  await call(adm, 'upsert_bili_account', { id: created.id, enabled: false });
  const acc = f.db.getBiliAccount(created.id)!;
  assert.equal(acc.enabled, false);
  assert.equal(acc.uname, null, 'uname 由抓取回写（touch），输入面动不了');

  const listed = (await call(adm, 'list_bili_accounts')) as { accounts: Array<{ uid: string; enabled: boolean }> };
  assert.equal(listed.accounts.length, 1);
  assert.equal(listed.accounts[0]!.enabled, false, '停用状态可见');

  await call(adm, 'delete_bili_account', { id: created.id });
  assert.equal(f.db.listBiliAccounts().length, 0);
  await assert.rejects(() => call(adm, 'delete_bili_account', { id: created.id }), /不存在/);
});

test('图文规则：gateway 只读可见（list_push_rules 共享）、写是 admin 专属', async (t) => {
  const f = await setup(t);
  const gw = await mcpClient(f, GATEWAY_TOKEN);
  const tools = (await gw.listTools()).tools.map((x) => x.name);
  assert.equal(tools.includes('list_push_rules'), true, '只读对群友可见（含 subject_kind=post 规则）');
  assert.equal(tools.includes('upsert_push_rule'), false, '写是 admin 专属');
  assert.equal(tools.includes('delete_push_rule'), false);
  assert.equal(tools.includes('upsert_category'), false, '分类（判定口径）也是 admin 专属');
  assert.equal(tools.includes('upsert_post_rule'), false, 'post_rule 工具已退役，两角色都不可见');
});

// ---- P0 补齐的排序/测试类工具（write-path-inventory 的 8 条 planned → exists）----

test('reorder_channels / reorder_categories：全排列校验 + 落库顺序', async (t) => {
  const f = await setup(t);
  const adm = await mcpClient(f, ADMIN_TOKEN);
  const { groupChannelId, toastChannelId, categoryId } = seedBase(f.db);

  await call(adm, 'reorder_channels', { ids: [toastChannelId, groupChannelId] });
  assert.deepEqual(f.db.listPushChannels().map((c) => c.id), [toastChannelId, groupChannelId]);

  const cat2 = f.db.upsertCategory({ name: '杂谈', llmPrompt: null, keywords: ['杂谈'], areas: [], condMode: 'and', enabled: true });
  await call(adm, 'reorder_categories', { ids: [cat2, categoryId] });
  assert.deepEqual(f.db.listCategories().map((c) => c.id), [cat2, categoryId]);

  // 非全排列（少一个 / 多一个 / 有重复）一律 400 口径
  await assert.rejects(call(adm, 'reorder_channels', { ids: [toastChannelId] }), /必须与现有渠道一一对应/);
  await assert.rejects(call(adm, 'reorder_channels', { ids: [toastChannelId, groupChannelId, 999] }), /一一对应/);
  await assert.rejects(call(adm, 'reorder_categories', { ids: [cat2, cat2] }), /一一对应/);
});

test('reorder_push_rules：全排列校验 + 落库顺序（live 与 post 规则共用一张全局序）', async (t) => {
  const f = await setup(t);
  const adm = await mcpClient(f, ADMIN_TOKEN);
  const { groupChannelId } = seedBase(f.db);

  const r1 = f.db.upsertPushRule({ name: 'r1', categoryId: null, scope: [], channels: [groupChannelId], messageTemplate: null, enabled: true });
  const r2 = f.db.upsertPushRule({ name: 'r2', subjectKind: 'post', categoryId: null, scope: [], channels: [], messageTemplate: null, enabled: true });
  await call(adm, 'reorder_push_rules', { ids: [r2, r1] });
  assert.deepEqual(f.db.listPushRules().map((r) => r.id), [r2, r1], '两形态同表同序');
  await assert.rejects(call(adm, 'reorder_push_rules', { ids: [r1] }), /必须与现有规则一一对应/);
});

test('reorder_llm_providers：names 全排列，保存后名单顺序即路由优先级', async (t) => {
  const f = await setup(t, { withLlm: true });
  saveLlmProviders(f.db, [
    ...listLlmProviders(f.db),
    { name: 'Second', baseURL: 'http://127.0.0.1:2/v1', model: 'm2', vision: false, keyEnvs: [], enabled: true, structuredOutput: 'schema', api: 'chat-completions' },
  ]);
  const adm = await mcpClient(f, ADMIN_TOKEN);

  await call(adm, 'reorder_llm_providers', { names: ['Second', 'TestLLM'] });
  assert.deepEqual(listLlmProviders(f.db).map((p) => p.name), ['Second', 'TestLLM']);

  await assert.rejects(call(adm, 'reorder_llm_providers', { names: ['TestLLM'] }), /一一对应/);
  await assert.rejects(call(adm, 'reorder_llm_providers', { names: ['TestLLM', 'TestLLM'] }), /names 有重复/);
  await assert.rejects(call(adm, 'reorder_llm_providers', { names: ['TestLLM', 'Nope'] }), /一一对应/);
});

test('决策模型工具：名单/新增/排序/测试/删除走注册表，与 LLM 通道独立', async (t) => {
  const f = await setup(t);
  const adm = await mcpClient(f, ADMIN_TOKEN);

  assert.deepEqual(await call(adm, 'list_decision_providers'), { providers: [] });

  await call(adm, 'upsert_decision_provider', {
    name: 'jev', baseURL: 'https://api.typesafe.ai/v1', model: 'jev-1.14.0',
  });
  await call(adm, 'upsert_decision_provider', {
    name: 'local', baseURL: 'http://127.0.0.1:8080/v1', model: 'clef-flash', protocol: 'systemone',
  });
  let list = (await call(adm, 'list_decision_providers')) as { providers: Array<{ name: string; protocol: string; keyCount: number }> };
  assert.deepEqual(list.providers.map((p) => p.name), ['jev', 'local']);
  assert.deepEqual(list.providers.map((p) => p.protocol), ['systemone', 'systemone'], '缺省协议 systemone');
  assert.deepEqual(list.providers.map((p) => p.keyCount), [0, 0]);

  await assert.rejects(call(adm, 'upsert_decision_provider', {
    name: 'bad', baseURL: 'not-a-url', model: 'm',
  }), /baseURL/);
  await assert.rejects(call(adm, 'upsert_decision_provider', {
    name: 'bad2', baseURL: 'https://x.com/v1', model: 'm', protocol: 'decisions',
  }));

  await call(adm, 'reorder_decision_providers', { names: ['local', 'jev'] });
  assert.deepEqual(listDecisionProviders(f.db).map((p) => p.name), ['local', 'jev']);
  await assert.rejects(call(adm, 'reorder_decision_providers', { names: ['local'] }), /一一对应/);

  await assert.rejects(call(adm, 'test_decision_provider', { name: 'Nope' }), /provider 不存在/);
  await assert.rejects(call(adm, 'test_decision_provider', { name: 'jev' }), /缺 key/);
  f.db.setSetting('decision_key:jev', 'sk-decision');
  const ping = (await call(adm, 'test_decision_provider', { name: 'jev' })) as { ok: boolean; ms: number; model: string };
  assert.deepEqual(ping, { ok: true, ms: 9, model: 'jev-1.14.0' });

  // 本地 loopback 无鉴权：不需要 key 也能测
  const local = (await call(adm, 'test_decision_provider', { name: 'local' })) as { ok: boolean; model: string };
  assert.equal(local.model, 'clef-flash');

  await call(adm, 'delete_decision_provider', { name: 'local' });
  assert.deepEqual(listDecisionProviders(f.db).map((p) => p.name), ['jev']);
  await assert.rejects(call(adm, 'delete_decision_provider', { name: 'local' }), /provider 不存在/);
  assert.equal(f.db.getSetting('decision_key:jev'), 'sk-decision', '删除 provider 不动 key 设置项');
});

test('test_push：走装配的测试推送链路并回传统计', async (t) => {
  const f = await setup(t);
  const adm = await mcpClient(f, ADMIN_TOKEN);
  const r = (await call(adm, 'test_push')) as { ok: boolean; total: number; succeeded: number };
  assert.deepEqual(r, { ok: true, total: 2, succeeded: 2 });
});

test('test_llm_provider：404 / 缺 key / ping 成功 / ping 失败（502 口径）', async (t) => {
  const f = await setup(t, { withLlm: true });
  const adm = await mcpClient(f, ADMIN_TOKEN);

  await assert.rejects(call(adm, 'test_llm_provider', { name: 'Nope' }), /provider 不存在/);
  await assert.rejects(call(adm, 'test_llm_provider', { name: 'TestLLM' }), /缺 key/);

  f.db.setSetting('llm_key:TestLLM', 'sk-x');
  const ok = (await call(adm, 'test_llm_provider', { name: 'TestLLM' })) as { ok: boolean; ms: number };
  assert.deepEqual(ok, { ok: true, ms: 12 });

  // ping 失败：错误归一为 502 口径文本（失败计熔断由 router.ping 自身保证）
  saveLlmProviders(f.db, [
    ...listLlmProviders(f.db),
    { name: 'Broken', baseURL: 'http://127.0.0.1:3/v1', model: 'm', vision: false, keyEnvs: [], enabled: true, structuredOutput: 'schema', api: 'chat-completions' },
  ]);
  f.db.setSetting('llm_key:Broken', 'sk-y');
  await assert.rejects(call(adm, 'test_llm_provider', { name: 'Broken' }), /ECONNREFUSED/);
});

test('test_x_connection：覆盖值透传 + 缺省 target=all；快照写库语义在 deps.x.test 内（同 REST）', async (t) => {
  const f = await setup(t);
  const adm = await mcpClient(f, ADMIN_TOKEN);

  const def = (await call(adm, 'test_x_connection')) as { echo: { target: string } };
  assert.equal(def.echo.target, 'all', '缺省探测目标 = all（parseXTestRequest 同 REST）');

  const r = (await call(adm, 'test_x_connection', {
    target: 'proxy', proxyUrl: ' http://127.0.0.1:7890 ', screenName: '@Some_One',
  })) as { echo: { target: string; proxyUrl: string; screenName: string } };
  assert.equal(r.echo.target, 'proxy');
  assert.equal(r.echo.proxyUrl, 'http://127.0.0.1:7890', '覆盖值 trim 与 REST 同口径');
  assert.equal(r.echo.screenName, '@Some_One', 'screenName 只 trim 不去 @（与 REST 同口径）');

  await assert.rejects(call(adm, 'test_x_connection', { target: 'bogus' }));
});

test('排序/测试类工具：admin 可见、gateway 不可见；schema 校验错误经 runTool 归一', async (t) => {
  const f = await setup(t);
  const adm = await mcpClient(f, ADMIN_TOKEN);
  const gw = await mcpClient(f, GATEWAY_TOKEN);
  const admTools = (await adm.listTools()).tools.map((x) => x.name);
  const gwTools = (await gw.listTools()).tools.map((x) => x.name);
  for (const name of [
    'reorder_channels', 'reorder_categories', 'reorder_push_rules',
    'reorder_llm_providers', 'test_push', 'test_llm_provider', 'test_x_connection',
  ]) {
    assert.ok(admTools.includes(name), `admin 应可见 ${name}`);
    assert.ok(!gwTools.includes(name), `gateway 不应可见 ${name}`);
  }

  // runTool 的校验归一（第二个适配器也绕不过的那层）：handler 不被调用、文案「错误：参数不合法：…」
  const def = allToolDefs().find((d) => d.name === 'reorder_channels')!;
  const r = await runTool({} as PanelDeps, def, { ids: 'not-an-array' }, { name: 'adm', role: 'admin', scope: {} });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.text, /^错误：参数不合法：/);
});

// ---- 写快照接线（MCP 入口）：写工具经 runToolTracked 落变更记录，scope 按调用域分栈 ----

test('MCP 写落变更记录：admin 进全局栈；gateway 按令牌绑定渠道进独立栈；失败不写记录', async (t) => {
  const f = await setup(t);
  const { groupChannelId } = seedBase(f.db);
  // 绑渠道的 gateway 令牌（叠加在 fixture 已有令牌上）
  saveMcpTokens(f.db, [
    { name: 'adm', role: 'admin', token: ADMIN_TOKEN },
    { name: 'gw', role: 'gateway', token: GATEWAY_TOKEN },
    { name: 'gw7', role: 'gateway', token: 'ddc_gw7', channelId: groupChannelId },
  ]);

  const adm = await mcpClient(f, ADMIN_TOKEN);
  await call(adm, 'set_push_enabled', { enabled: false });
  const gw7 = await mcpClient(f, 'ddc_gw7');
  await call(gw7, 'add_group_push_rule', { uid: '7706705' });
  // 失败调用不落记录
  await assert.rejects(call(gw7, 'add_group_push_rule', { uid: '7706705' }), /已有相同规则/);

  const adminHist = f.undo.history({ scope: adminScope() });
  assert.equal(adminHist.length, 1);
  assert.equal(adminHist[0]!.tool, 'set_push_enabled');
  assert.equal(adminHist[0]!.entry, 'mcp');
  assert.equal(adminHist[0]!.actor, 'adm');

  const gwHist = f.undo.history({ scope: channelScope(groupChannelId) });
  assert.equal(gwHist.length, 1, 'gateway 写进渠道独立栈');
  assert.equal(gwHist[0]!.tool, 'add_group_push_rule');
  assert.equal(gwHist[0]!.actor, 'gw7');
  assert.equal(gwHist[0]!.rows[0]!.table, 'push_rules');
});
// ---- 撤销工具（切片 C）：admin 撤全局栈、gateway 撤本渠道栈（scope 隔离）----

test('undo_last_change：未绑渠道的 gateway 拒绝；gateway 只撤本渠道栈，admin 全局栈不受影响', async (t) => {
  const f = await setup(t);
  const { groupChannelId } = seedBase(f.db);
  saveMcpTokens(f.db, [
    { name: 'adm', role: 'admin', token: ADMIN_TOKEN },
    { name: 'gw', role: 'gateway', token: GATEWAY_TOKEN }, // 未绑渠道
    { name: 'gw7', role: 'gateway', token: 'ddc_gw7', channelId: groupChannelId },
  ]);
  const adm = await mcpClient(f, ADMIN_TOKEN);
  const gw = await mcpClient(f, GATEWAY_TOKEN);
  const gw7 = await mcpClient(f, 'ddc_gw7');

  // 撤销是内部工具（不为它设专门命令）：两个角色都看得见，栈由调用域决定
  const admTools = (await adm.listTools()).tools.map((x) => x.name);
  const gwTools = (await gw.listTools()).tools.map((x) => x.name);
  assert.ok(admTools.includes('undo_last_change') && gwTools.includes('undo_last_change'));

  // 空栈：中文文案（与面板端点同一句）
  await assert.rejects(call(adm, 'undo_last_change'), /没有可撤销的变更/);

  // admin 写一笔进全局栈；gateway 写一笔进本渠道栈
  await call(adm, 'set_push_enabled', { enabled: false });
  const rule = (await call(gw7, 'add_group_push_rule', { uid: '7706705' })) as { id: number };

  // 未绑渠道的 gateway 拒绝（绝不回落 admin 全局栈——否则 QQ 侧一句话就能回退主人配置）
  await assert.rejects(call(gw, 'undo_last_change'), /本令牌未绑定渠道，不能撤销变更/);
  assert.equal(f.db.getSetting('push_enabled'), '0', '拒绝时不得动 admin 的栈顶');
  assert.deepEqual(f.undoScopes, ['admin'], '拒绝发生在解析调用域时，没进任何栈');

  // 渠道栈撤销：只撤自己的规则；撤的是本渠道那条记录
  const r = (await call(gw7, 'undo_last_change')) as {
    ok: boolean; change: { id: number; tool: string }; applied: number;
  };
  assert.equal(r.ok, true);
  assert.equal(r.change.tool, 'add_group_push_rule');
  assert.equal(r.applied, 1);
  assert.equal(f.db.listPushRules().some((x) => x.id === rule.id), false, '群自助规则被撤销删除');
  assert.equal(f.db.getSetting('push_enabled'), '0', 'admin 的写不受渠道撤销影响');
  assert.deepEqual(f.undoScopes, ['admin', channelScope(groupChannelId)], '撤销走的是令牌绑定的渠道栈');
  assert.equal(f.undo.peek(channelScope(groupChannelId)), null, '渠道栈顶已撤完');
  assert.equal(f.undo.peek(adminScope())!.tool, 'set_push_enabled', 'admin 栈顶原样保留');
  // 撤销自身不入栈（工具体 track:false）：历史里仍只有最初那一条
  assert.equal(f.undo.history({ scope: channelScope(groupChannelId) }).length, 1);
  // gateway 能产生的记录只有 push_rules（无热生效对象），故该路径映射结果为空集
  assert.deepEqual(f.undoFired, { runtime: 0, listen: 0, llm: 0, notifiers: 0 });

  // admin 撤全局栈：首写的前像 = key 不存在 → 撤销把 key 删掉
  const r2 = (await call(adm, 'undo_last_change')) as { change: { tool: string }; applied: number };
  assert.equal(r2.change.tool, 'set_push_enabled');
  assert.equal(f.db.getSetting('push_enabled'), null);
  assert.equal(f.undo.peek(adminScope()), null);
  assert.deepEqual(f.undoScopes, ['admin', channelScope(groupChannelId), adminScope()]);
});

test('undo_last_change：撤 LLM key = 清空 + refill 提示，且触发 router 重建', async (t) => {
  const f = await setup(t, { withLlm: true });
  const adm = await mcpClient(f, ADMIN_TOKEN);
  await call(adm, 'set_llm_key', { name: 'TestLLM', value: 'sk-live-1' });

  const r = (await call(adm, 'undo_last_change')) as { refill?: string[]; change: { tool: string } };
  assert.equal(r.change.tool, 'set_llm_key');
  assert.deepEqual(r.refill, ['settings.(key=llm_key:TestLLM)'], '隐私例外：值不落库，撤销后要点名重填');
  assert.equal(f.db.getSetting('llm_key:TestLLM'), null, '撤销 = 清空该 key');
  assert.equal(f.undoFired.llm, 1, '撤 key 要重建 router（与面板手写等价）');
  assert.deepEqual(Object.entries(f.undoFired).filter(([, n]) => n > 0), [['llm', 1]]);
});

test('undo_last_change：撤 streamers 写（set_streamer 改别名）还原配置列、不回滚轮询列', async (t) => {
  const f = await setup(t);
  const adm = await mcpClient(f, ADMIN_TOKEN);
  f.db.upsertStreamer({ uid: '1001', uname: '阿梓', alias: '旧别名' });
  f.db.raw.prepare(`UPDATE streamers SET face = 'old.jpg', updated_at = 1111 WHERE uid = ?`).run('1001');

  // P1 真机冒烟场景：agent / MCP 用 set_streamer 改别名，主人要能从变更历史撤回来
  await call(adm, 'set_streamer', { uid: '1001', alias: '梓宝', notify: false });
  assert.equal(f.db.getStreamer('1001')!.alias, '梓宝');
  const rec = f.undo.history({ scope: adminScope() })[0]!;
  assert.equal(rec.tool, 'set_streamer');
  assert.equal(rec.entry, 'mcp');
  assert.equal(rec.rows.length, 1, '只有 streamers 这一行（轮询列不额外产生行）');
  assert.equal(rec.rows[0]!.table, 'streamers');

  // 撤销前轮询源回填同一行 → 比对只看配置列，仍撤得掉；轮询列不回滚
  f.db.raw
    .prepare(`UPDATE streamers SET uname = '阿梓从小就很可爱', face = 'new.jpg', room_id = '80397', updated_at = 2222 WHERE uid = ?`)
    .run('1001');
  const r = (await call(adm, 'undo_last_change')) as { change: { tool: string }; applied: number };
  assert.equal(r.change.tool, 'set_streamer');
  assert.equal(r.applied, 1);
  const s = f.db.getStreamer('1001')!;
  assert.equal(s.alias, '旧别名', '配置列还原');
  assert.equal(s.notify, true, '配置列还原');
  assert.equal(s.uname, '阿梓从小就很可爱', '平台事实列保持撤销前的值');
  assert.equal(s.face, 'new.jpg', '头像同属轮询列');
  assert.equal(s.roomId, '80397', '房间号同属轮询列');
  // streamers 无热生效对象（监听名单每轮直读 DB）——撤销不触发任何装配级回调
  assert.deepEqual(f.undoFired, { runtime: 0, listen: 0, llm: 0, notifiers: 0 });
});
