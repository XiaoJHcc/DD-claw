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
import { runTool } from '../mcp/run-tool.js';
import { allToolDefs } from '../mcp/tools.js';
import { saveLlmProviders, listLlmProviders } from '../analysis/providers.js';
import { emptyXFeedSnapshot, getXConfig, saveXConfig } from '../core/x-config.js';
import { emptyWeiboFeedSnapshot } from '../core/weibo-accounts.js';
import { UndoStore, adminScope, channelScope } from '../core/undo.js';

const ADMIN_TOKEN = 'ddc_test_admin';
const GATEWAY_TOKEN = 'ddc_test_gateway';

interface Fixture {
  db: Db;
  base: string;
  listenChanged: { count: number };
  advancedChanged: { count: number };
  /** 写快照（P0 接线后所有写工具都经它落变更记录） */
  undo: UndoStore;
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
  // X 分页 dep（生产装配形状）：配置落 settings，探测/校验走网络（测试里不触发）
  const xChanged = { count: 0 };
  const weiboChanged = { count: 0 };
  const deps: PanelDeps = {
    db,
    undo,
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
  return { db, base: `http://127.0.0.1:${port}`, listenChanged, advancedChanged, undo, clients };
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

test('upsert_post_rule：规则平台无关——「引用」/「翻译」不再拒绝，规则对象不再带 platform', async (t) => {
  const f = await setup(t);
  const adm = await mcpClient(f, ADMIN_TOKEN);
  const { groupChannelId } = seedBase(f.db);

  const wbRule = (await call(adm, 'upsert_post_rule', {
    name: '通用规则', channels: [groupChannelId],
  })) as { id: number };
  const stored = f.db.listPostRules().find((r) => r.id === wbRule.id)!;
  assert.ok(!('platform' in stored), '规则已平台无关，对象不再带 platform');

  // quote 对非 X 帖永不命中是语义（matcher 按帖子平台自然生效），不是保存校验错误；
  // 翻译改为运行时门控（非 X 帖不译），任何规则都可开
  const q = (await call(adm, 'upsert_post_rule', { name: '引用规则', filters: { quote: true } })) as { id: number };
  assert.equal(f.db.listPostRules().find((r) => r.id === q.id)!.filters.quote, true);
  const tr = (await call(adm, 'upsert_post_rule', { name: '翻译规则', llmTranslate: true })) as { id: number };
  assert.equal(f.db.listPostRules().find((r) => r.id === tr.id)!.llmTranslate, true);
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

test('图文帖规则工具：list/upsert/delete + 引用校验 + 死规则拒绝 + 合并后校验', async (t) => {
  const f = await setup(t);
  const adm = await mcpClient(f, ADMIN_TOKEN);
  const { groupChannelId } = seedBase(f.db);

  assert.deepEqual(((await call(adm, 'list_post_rules')) as { rules: unknown[] }).rules, []);

  const created = (await call(adm, 'upsert_post_rule', {
    name: '只推带图原创', channels: [groupChannelId], filters: { media: true },
  })) as { id: number };
  const listed = (await call(adm, 'list_post_rules')) as {
    rules: Array<{ filters: { original: boolean; media: boolean }; channels: number[] }>;
  };
  assert.equal(listed.rules[0]!.filters.original, true, '未提供的筛选回落默认');
  assert.equal(listed.rules[0]!.filters.media, true);
  assert.deepEqual(listed.rules[0]!.channels, [groupChannelId]);
  assert.equal('accountIds' in listed.rules[0]!, false, '规则不再携带账号集合（生效范围在账号侧 ruleIds）');
  assert.equal('platform' in listed.rules[0]!, false, '规则已平台无关，不再带 platform');

  await assert.rejects(
    () => call(adm, 'upsert_post_rule', { filters: { original: false, retweet: false } }),
    /至少要勾一个/,
  );
  await assert.rejects(() => call(adm, 'upsert_post_rule', { channels: [9999] }), /渠道不存在/);

  // 更新：只改推送词，渠道沿用旧值（合并后仍要校验通过）
  await call(adm, 'upsert_post_rule', { id: created.id, messageTemplate: '{author} 更新了' });
  assert.equal(f.db.listPostRules()[0]!.messageTemplate, '{author} 更新了');

  // LLM 判定：开了就必须给标准（与面板同一条校验）
  await assert.rejects(
    () => call(adm, 'upsert_post_rule', { id: created.id, llmJudge: true }),
    /必须填判定提示词/,
  );
  await call(adm, 'upsert_post_rule', {
    id: created.id, llmJudge: true, judgePrompt: '只推直播预告', llmTranslate: true,
  });
  const withLlm = f.db.listPostRules()[0]!;
  assert.equal(withLlm.llmJudge, true);
  assert.equal(withLlm.judgePrompt, '只推直播预告');
  assert.equal(withLlm.llmTranslate, true);

  await call(adm, 'delete_post_rule', { id: created.id });
  assert.equal(f.db.listPostRules().length, 0);
  await assert.rejects(() => call(adm, 'delete_post_rule', { id: created.id }), /不存在/);
});

test('账号 ruleIds 选用规则：规则平台无关（存在即可选用）；delete_post_rule 连带清扫三份名单', async (t) => {
  const f = await setup(t);
  const adm = await mcpClient(f, ADMIN_TOKEN);
  const rule1 = (await call(adm, 'upsert_post_rule', { name: 'r1' })) as { id: number };
  const rule2 = (await call(adm, 'upsert_post_rule', { name: 'r2' })) as { id: number };

  // X 账号：任何规则都可选用；不存在的拒
  const x = (await call(adm, 'upsert_x_account', { screenName: 'watase_yuzuki', ruleIds: [rule1.id, rule2.id] })) as {
    id: number; account: { ruleIds: number[] };
  };
  assert.deepEqual(x.account.ruleIds, [rule1.id, rule2.id], '规则平台无关，任意选用');
  await assert.rejects(
    () => call(adm, 'upsert_x_account', { id: x.id, ruleIds: [9999] }),
    /图文帖规则不存在/,
  );

  // 微博 / B站账号同口径（同一条规则跨平台选用）
  const wb = (await call(adm, 'upsert_weibo_account', { uid: '2203177060', ruleIds: [rule1.id] })) as { id: number };
  assert.deepEqual(f.db.getWeiboAccount(wb.id)!.ruleIds, [rule1.id]);
  const bi = (await call(adm, 'upsert_bili_account', { uid: '7706705', ruleIds: [rule2.id] })) as { id: number };
  assert.deepEqual(f.db.getBiliAccount(bi.id)!.ruleIds, [rule2.id]);

  // 删规则 → 三份名单的 ruleIds 不残留已删 id
  await call(adm, 'delete_post_rule', { id: rule1.id });
  assert.deepEqual(f.db.getXAccount(x.id)!.ruleIds, [rule2.id], 'X 名单清扫已删 id');
  assert.deepEqual(f.db.getWeiboAccount(wb.id)!.ruleIds, [], '微博名单清扫');
  await call(adm, 'delete_post_rule', { id: rule2.id });
  assert.deepEqual(f.db.getXAccount(x.id)!.ruleIds, [], 'X 名单清扫');
  assert.deepEqual(f.db.getBiliAccount(bi.id)!.ruleIds, [], 'B站名单清扫');
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

test('图文帖规则：gateway 能看不能改（list 共享、写是 admin 专属）', async (t) => {
  const f = await setup(t);
  const gw = await mcpClient(f, GATEWAY_TOKEN);
  const tools = (await gw.listTools()).tools.map((x) => x.name);
  assert.equal(tools.includes('list_post_rules'), true, '只读对群友可见');
  assert.equal(tools.includes('upsert_post_rule'), false, '写是 admin 专属');
  assert.equal(tools.includes('delete_post_rule'), false);
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

test('reorder_push_rules / reorder_post_rules：全排列校验 + 落库顺序', async (t) => {
  const f = await setup(t);
  const adm = await mcpClient(f, ADMIN_TOKEN);
  const { groupChannelId } = seedBase(f.db);

  const r1 = f.db.upsertPushRule({ name: 'r1', categoryId: null, uids: [], channels: [groupChannelId], messageTemplate: null, enabled: true });
  const r2 = f.db.upsertPushRule({ name: 'r2', categoryId: null, uids: [], channels: [], messageTemplate: null, enabled: true });
  await call(adm, 'reorder_push_rules', { ids: [r2, r1] });
  assert.deepEqual(f.db.listPushRules().map((r) => r.id), [r2, r1]);
  await assert.rejects(call(adm, 'reorder_push_rules', { ids: [r1] }), /必须与现有规则一一对应/);

  const p1 = f.db.upsertPostRule({ name: 'p1' });
  const p2 = f.db.upsertPostRule({ name: 'p2' });
  await call(adm, 'reorder_post_rules', { ids: [p2, p1] });
  assert.deepEqual(f.db.listPostRules().map((r) => r.id), [p2, p1]);
  await assert.rejects(call(adm, 'reorder_post_rules', { ids: [p1, 999] }), /必须与现有图文帖规则一一对应/);
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
    'reorder_channels', 'reorder_categories', 'reorder_push_rules', 'reorder_post_rules',
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
  await call(gw7, 'add_group_push_rule', { channelId: groupChannelId, uid: '7706705' });
  // 失败调用不落记录
  await assert.rejects(call(gw7, 'add_group_push_rule', { channelId: groupChannelId, uid: '7706705' }), /已有相同规则/);

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
