/**
 * agent loop 契约测试：用注入的假 `completeChat` 驱动多轮 tool_calls 剧本，验证
 * 「工具面 → 执行 → 结果/错误回填 → 终答」的整个回路、轮次截断、会话持久、
 * 写模式（系统提示层）与 `entry='agent'` 的写记录，以及缺省 LLM 接缝（真走 router）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { LlmProviderConfig } from '../config/schema.js';
import {
  createLlmRouter, setLlmEnabled, type ChatCompletion, type ChatMessage, type LlmRequest, type ToolCall,
} from '../analysis/providers.js';
import { ChatStore } from '../core/chat-store.js';
import { Db } from '../core/db.js';
import { getChatProvider, setChatProvider } from '../analysis/providers.js';
import { UndoStore, adminScope, channelScope } from '../core/undo.js';
import { HttpError } from '../panel/http-util.js';
import type { PanelDeps, PanelStatus } from '../panel/server.js';
import { AGENT_MAX_STEPS, chatBlockedReason, runAgentTurn } from './loop.js';
import { getChatWriteMode, setChatWriteMode } from './system-prompt.js';

const STATUS: PanelStatus = {
  startedAt: 0, notifiers: [], watchedCount: 0, liveCount: 0, platforms: [],
};

const PROVIDER: LlmProviderConfig = {
  id: 'p1', name: 'p1', baseURL: 'https://api.example.com/v1', model: 'm1', vision: false,
  keyEnvs: [], enabled: true, structuredOutput: 'schema', api: 'chat-completions',
};

/** 内存库 + 会话存储 + 撤销栈（生产装配形状；undoLast 用生产同款「撤该栈顶」语义） */
function fixture(): { db: Db; chat: ChatStore; undo: UndoStore; deps: PanelDeps } {
  const db = new Db(':memory:');
  const chat = new ChatStore(db.raw);
  chat.migrate();
  const undo = new UndoStore(db.raw);
  undo.migrate();
  return {
    db, chat, undo,
    deps: {
      db, chat, undo,
      undoLast: (scope) => undo.undo(scope ?? adminScope()),
      status: () => STATUS,
    },
  };
}

/** 挂一个真 router（keys 决定 provider 是否 ready；fetchFn 可注入以走真 provider 路径） */
function attachRouter(deps: PanelDeps, keys: string[], fetchFn?: (url: string, init: RequestInit) => Promise<Response>): void {
  deps.llm = {
    router: createLlmRouter(
      { requestTimeoutMs: 1_000, circuitThreshold: 3, circuitCooldownMs: 60_000, providers: [PROVIDER] },
      () => keys,
      fetchFn ? { fetchFn } : undefined,
    ),
  };
}

function toolCall(id: string, name: string, args: unknown = {}): ToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}

/** 假 LLM：第 i 次请求取剧本第 i 步；请求深拷留档（loop 会继续往自己的数组里 push）。
 *  provider 由木偶补：剧本只关心正文/工具调用，真回答者由 provider 层给（loop 读它落库/回显）。 */
function fakeChat(script: Array<(req: LlmRequest, i: number) => ChatCompletion>) {
  const seen: LlmRequest[] = [];
  const fn = async (req: LlmRequest): Promise<ChatCompletion> => {
    seen.push({ ...req, messages: req.messages.map((m) => ({ ...m })) as ChatMessage[] });
    const step = script[seen.length - 1];
    if (!step) throw new Error(`剧本只准备了 ${script.length} 步，却被问了第 ${seen.length} 次`);
    const out = step(req, seen.length - 1);
    return out.provider === undefined ? { ...out, provider: 'p1' } : out;
  };
  return { fn, seen };
}

const reply = (content: string): ChatCompletion => ({ content, toolCalls: [] });

function toolTexts(req: LlmRequest): string[] {
  return req.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
}

// ---- 基本回路 ----

test('单轮直答：没有 tool_calls 就是终答；工具面按角色+排除名单给', async () => {
  const { chat, deps } = fixture();
  const llm = fakeChat([() => reply('当前没有在播的监听主播。')]);

  const r = await runAgentTurn(deps, '现在谁在播', { completeChat: llm.fn });
  assert.equal(r.reply, '当前没有在播的监听主播。');
  assert.deepEqual({ steps: r.steps, toolCalls: r.toolCalls, truncated: r.truncated },
    { steps: 1, toolCalls: 0, truncated: false });

  // user / assistant 落库；system 提示每轮重拼、不落库
  const stored = chat.messages(adminScope());
  assert.deepEqual(stored.map((m) => [m.role, m.content]),
    [['user', '现在谁在播'], ['assistant', '当前没有在播的监听主播。']]);

  const names = llm.seen[0]!.tools!.map((t) => t.name);
  for (const want of ['search_streamers', 'list_streamers', 'set_push_enabled', 'undo_last_change']) {
    assert.ok(names.includes(want), `${want} 应在工具面`);
  }
  for (const not of ['set_chat_mode', 'set_chat_provider', 'test_push', 'reorder_push_rules', 'list_group_channels']) {
    assert.ok(!names.includes(not), `${not} 不该在工具面`);
  }
});

test('两轮：请求写工具 → 执行落地 → 结果回填 → 终答；变更记录 entry=agent', async () => {
  const { db, chat, undo, deps } = fixture();
  const llm = fakeChat([
    () => ({ content: '好，我把推送总开关关掉。', toolCalls: [toolCall('c1', 'set_push_enabled', { enabled: false })] }),
    () => reply('已关闭推送总开关。'),
  ]);

  const r = await runAgentTurn(deps, '把推送关了', { completeChat: llm.fn });
  assert.equal(r.reply, '已关闭推送总开关。');
  assert.deepEqual({ steps: r.steps, toolCalls: r.toolCalls }, { steps: 2, toolCalls: 1 });
  assert.equal(db.getSetting('push_enabled'), '0', '工具真的执行了（经 runTool 写库）');

  // 第二轮请求带上 assistant(tool_calls) 与 tool 结果，call id 配对
  const second = llm.seen[1]!.messages;
  assert.equal(second.find((m) => m.role === 'assistant')!.toolCalls?.[0]?.id, 'c1');
  const toolMsg = second.find((m) => m.role === 'tool')!;
  assert.equal(toolMsg.toolCallId, 'c1');
  assert.match(String(toolMsg.content), /"enabled": false/);

  // 往来全部落库（含带 toolCalls 的那轮 assistant）
  const stored = chat.messages(adminScope());
  assert.deepEqual(stored.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal((stored[1]!.toolCalls as ToolCall[])[0]!.id, 'c1');
  assert.equal(stored[2]!.toolCallId, 'c1');

  // 变更记录：entry=agent / actor=webui-agent —— 面板变更历史里能区分于人手操作
  const hist = undo.history();
  assert.equal(hist.length, 1);
  assert.deepEqual(
    { entry: hist[0]!.entry, actor: hist[0]!.actor, tool: hist[0]!.tool, scope: hist[0]!.scope },
    { entry: 'agent', actor: 'webui-agent', tool: 'set_push_enabled', scope: 'admin' },
  );
});

test('P1 冒烟回归：agent 用 set_streamer 改别名后能撤回（streamers 已纳入快照）', async (t) => {
  const { db, undo, deps } = fixture();
  db.upsertStreamer({ uid: '1001', uname: '阿梓', alias: '旧别名' });
  const llm = fakeChat([
    () => ({ content: '给它起个简称。', toolCalls: [toolCall('c1', 'set_streamer', { uid: '1001', alias: '梓宝' })] }),
    () => ({ content: '起好了。', toolCalls: [toolCall('c2', 'undo_last_change', {})] }),
    () => reply('已经改回去了。'),
  ]);

  const r = await runAgentTurn(deps, '给阿梓起个简称', { completeChat: llm.fn });
  assert.equal(r.reply, '已经改回去了。');
  assert.equal(r.toolCalls, 2);

  // 改别名落一条 entry=agent 的记录；agent 自己调 undo_last_change 就撤得回来（撤销自身不入栈）
  const rec = undo.history()[0]!;
  assert.deepEqual(
    { entry: rec.entry, tool: rec.tool, table: rec.rows[0]!.table },
    { entry: 'agent', tool: 'set_streamer', table: 'streamers' },
  );
  assert.ok(rec.undoneAt !== null, '撤销把这条记录标记为已撤销');
  assert.equal(undo.history().length, 1, '撤销自身不落新记录');
  assert.equal(db.getStreamer('1001')!.alias, '旧别名', '别名回到改动前');
});

test('工具错误回填：第二轮 LLM 收到中文错误文本后纠正；失败的写不留记录', async () => {
  const { undo, deps } = fixture();
  const llm = fakeChat([
    () => ({ content: '我给它起个别名。', toolCalls: [toolCall('c1', 'set_streamer', { uid: '999', alias: 'x' })] }),
    () => reply('名单里没有 uid 999，要先确认是哪位。'),
  ]);

  const r = await runAgentTurn(deps, '给 999 起个别名', { completeChat: llm.fn });
  assert.equal(r.reply, '名单里没有 uid 999，要先确认是哪位。');
  assert.match(toolTexts(llm.seen[1]!)[0]!, /错误：该 uid 不在监听名单/);
  assert.equal(undo.history().length, 0, '失败的写不落变更记录');
});

test('未知工具名 / 参数不是 JSON / 参数非对象：都以错误文本回填，loop 不崩', async () => {
  const { chat, deps } = fixture();
  const llm = fakeChat([
    () => ({
      content: '',
      toolCalls: [
        { id: 'c1', name: 'launch_rocket', arguments: '{}' },
        { id: 'c2', name: 'set_push_enabled', arguments: '{不是 JSON' },
        { id: 'c3', name: 'set_push_enabled', arguments: '["enabled"]' },
      ],
    }),
    () => reply('这几件事我做不了。'),
  ]);

  const r = await runAgentTurn(deps, '发个火箭并关推送', { completeChat: llm.fn });
  assert.equal(r.toolCalls, 3);
  assert.equal(r.reply, '这几件事我做不了。');
  const texts = toolTexts(llm.seen[1]!);
  assert.match(texts[0]!, /没有这个工具：launch_rocket/);
  assert.match(texts[1]!, /参数不是合法 JSON/);
  assert.match(texts[2]!, /参数必须是 JSON 对象/);
  assert.deepEqual(chat.messages(adminScope()).filter((m) => m.role === 'tool').map((m) => m.toolCallId),
    ['c1', 'c2', 'c3'], '三个调用都有一一对应的回填');
});

test('maxSteps 截断：一直要工具也给兜底回复，不卡死', async () => {
  const { chat, deps } = fixture();
  const always = (): ChatCompletion => ({ content: '', toolCalls: [toolCall('c', 'list_streamers')] });
  const llm = fakeChat(Array.from({ length: AGENT_MAX_STEPS }, () => always));

  const r = await runAgentTurn(deps, '看看名单', { completeChat: llm.fn });
  assert.equal(r.truncated, true);
  assert.equal(r.steps, AGENT_MAX_STEPS);
  assert.equal(llm.seen.length, AGENT_MAX_STEPS, '到上限就停，不再问模型');
  assert.match(r.reply, /连续 8 轮工具调用/);
  assert.equal(chat.messages(adminScope()).at(-1)!.content, r.reply, '兜底回复也落库');

  // 上限可配（测试用；未来 QQ 侧按渠道收敛也走这个口子）
  const short = fakeChat([always, always, always]);
  const r2 = await runAgentTurn(deps, '再看一遍', { completeChat: short.fn, maxSteps: 3 });
  assert.deepEqual({ steps: r2.steps, truncated: r2.truncated }, { steps: 3, truncated: true });
});

// ---- 会话持久 ----

test('会话持久：两条消息跨调用累积并回放进下一轮请求；reset 清消息保会话行', async () => {
  const { chat, deps } = fixture();
  const first = fakeChat([() => reply('第一次回答')]);
  await runAgentTurn(deps, '第一个问题', { completeChat: first.fn });
  const second = fakeChat([() => reply('第二次回答')]);
  await runAgentTurn(deps, '第二个问题', { completeChat: second.fn });

  assert.deepEqual(chat.messages(adminScope()).map((m) => m.content),
    ['第一个问题', '第一次回答', '第二个问题', '第二次回答']);

  const sent = second.seen[0]!.messages;
  assert.deepEqual(sent.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(sent[1]!.content, '第一个问题', '历史被回放');
  assert.equal(sent[3]!.content, '第二个问题');

  assert.equal(chat.reset(adminScope()), 4);
  assert.ok(chat.find(adminScope()), 'reset 保留会话行（id 不变）');
  assert.deepEqual(chat.messages(adminScope()), []);

  // 重置后再问：历史为空，只有本轮
  const third = fakeChat([() => reply('新对话')]);
  await runAgentTurn(deps, '重新开始', { completeChat: third.fn });
  assert.deepEqual(third.seen[0]!.messages.map((m) => m.role), ['system', 'user']);
});

test('历史回放：半截轮次（有 tool_calls 无 tool 结果 / 孤儿 tool 结果）被摘掉，不把会话卡死', async () => {
  const { chat, deps } = fixture();
  const scope = adminScope();
  // 模拟「进程在记录 tool 结果之前挂掉」留下的残局
  chat.append(scope, { role: 'user', content: '早先的问题' });
  chat.append(scope, { role: 'assistant', content: '', toolCalls: [toolCall('lost', 'list_streamers')] });
  chat.append(scope, { role: 'tool', content: '[]', toolCallId: 'ghost' });
  chat.append(scope, { role: 'assistant', content: '早先的回答' });

  const llm = fakeChat([() => reply('好')]);
  await runAgentTurn(deps, '新问题', { completeChat: llm.fn });

  const sent = llm.seen[0]!.messages;
  assert.deepEqual(sent.map((m) => m.role), ['system', 'user', 'assistant', 'user'], '空壳轮次与孤儿 tool 结果都不回放');
  assert.equal(sent[2]!.content, '早先的回答');
  assert.equal(sent[2]!.toolCalls, undefined);
  assert.equal(sent[3]!.content, '新问题');
});

// ---- 写模式（系统提示层）----

test('写模式：缺省 ask；settings 的值决定系统提示里的写纪律', async () => {
  const { db, deps } = fixture();
  assert.equal(getChatWriteMode(db), 'ask', '没配过 = 写前询问');

  const ask = fakeChat([() => reply('好')]);
  await runAgentTurn(deps, '把推送关了', { completeChat: ask.fn });
  const sys = String(ask.seen[0]!.messages[0]!.content);
  assert.match(sys, /写前询问/);
  assert.match(sys, /等主人下一轮确认/);
  assert.match(sys, /先查再引用/);
  assert.match(sys, /绝不编造/);
  assert.match(sys, /search_streamers/);
  assert.match(sys, /undo_last_change/);

  setChatWriteMode(db, 'auto');
  assert.equal(getChatWriteMode(db), 'auto');
  assert.equal(db.getSetting('chat_write_mode'), 'auto', 'settings 是唯一信源');
  const auto = fakeChat([() => reply('好')]);
  await runAgentTurn(deps, '把推送关了', { completeChat: auto.fn });
  const sys2 = String(auto.seen[0]!.messages[0]!.content);
  assert.match(sys2, /自动修改/);
  assert.ok(!sys2.includes('等主人下一轮确认'), 'auto 模式不该再要求先确认');

  // 脏值按安全默认（ask），不让一个坏值把「写前询问」关掉
  db.setSetting('chat_write_mode', 'nope');
  assert.equal(getChatWriteMode(db), 'ask');
});

// ---- 模型选择（settings chat_provider）----

test('模型选择：chat_provider 非空 → 每轮请求带 provider；结果与实际回答者落进 assistant 消息', async () => {
  const { db, chat, deps } = fixture();

  // 缺省 = 自动路由（请求里不带 provider，router 按路由顺序降级）
  const auto = fakeChat([() => reply('自动答的')]);
  const r0 = await runAgentTurn(deps, '谁在播', { completeChat: auto.fn });
  assert.equal(auto.seen[0]!.provider, undefined, '自动路由不带 provider');
  assert.equal(r0.provider, 'p1', '返回值给出实际回答者');
  assert.equal(chat.messages(adminScope())[1]!.provider, 'p1', 'assistant 消息落库带 provider');

  // 点名 p9：请求带 provider（假 LLM 照原样回一个别的名字，验证「结果里的才是事实」）
  setChatProvider(db, 'p9');
  assert.equal(getChatProvider(db), 'p9');
  const picked = fakeChat([(req) => ({ content: '点名答的', toolCalls: [], provider: req.provider ?? '?' })]);
  const r1 = await runAgentTurn(deps, '再来一次', { completeChat: picked.fn });
  assert.equal(picked.seen[0]!.provider, 'p9', 'settings 的值进了 LlmRequest.provider');
  assert.equal(r1.provider, 'p9');
  assert.equal(chat.messages(adminScope()).at(-1)!.provider, 'p9');

  // 工具轮次也带 provider，且整轮（含中间轮）的 provider 都落库
  const multi = fakeChat([
    (req) => ({ content: '先看一眼。', toolCalls: [toolCall('c1', 'list_streamers')], provider: req.provider ?? '?' }),
    (req) => ({ content: '看完了。', toolCalls: [], provider: req.provider ?? '?' }),
  ]);
  const r2 = await runAgentTurn(deps, '看看名单', { completeChat: multi.fn });
  assert.deepEqual(multi.seen.map((s) => s.provider), ['p9', 'p9']);
  assert.equal(r2.provider, 'p9');
  const stored = chat.messages(adminScope()).filter((m) => m.role === 'assistant');
  assert.deepEqual(stored.map((m) => m.provider), ['p1', 'p9', 'p9', 'p9']);

  // 回到自动：写空串 = 删键，请求里又不见 provider
  setChatProvider(db, '');
  assert.equal(db.getSetting('chat_provider'), null);
  const back = fakeChat([() => reply('又自动了')]);
  await runAgentTurn(deps, '回到自动', { completeChat: back.fn });
  assert.equal(back.seen[0]!.provider, undefined);
});

test('模型选择：选定的 provider 没了/不可用 → chatBlockedReason 给中文指引（400，不是 502）', async () => {
  const { db, deps } = fixture();
  attachRouter(deps, ['k1']); // p1 就绪
  setLlmEnabled(db, true);

  assert.equal(chatBlockedReason(deps), null, '自动路由下有就绪 provider 就是可用');

  setChatProvider(db, 'ghost');
  assert.match(chatBlockedReason(deps)!, /选定的 LLM provider「ghost」不在配置里/);

  // 选定的 provider 缺 key（attachRouter 的 key 池为空）→ 明确说它不可用，而不是笼统「没有可用 provider」
  deps.llm!.router = createLlmRouter(
    { requestTimeoutMs: 1_000, circuitThreshold: 3, circuitCooldownMs: 60_000, providers: [PROVIDER] },
    () => [],
  );
  setChatProvider(db, 'p1');
  assert.match(chatBlockedReason(deps)!, /选定的 LLM provider「p1」当前不可用（缺 key（未填写））/);
});

// ---- 撤销 ----

test('undo_last_change 在 loop 里可用：撤掉上一轮 agent 自己的写，且撤销自身不入栈', async () => {
  const { db, undo, deps } = fixture();
  const llm = fakeChat([
    () => ({ content: '先关推送。', toolCalls: [toolCall('c1', 'set_push_enabled', { enabled: false })] }),
    () => ({ content: '好，撤回。', toolCalls: [toolCall('c2', 'undo_last_change')] }),
    () => reply('已恢复。'),
  ]);

  const r = await runAgentTurn(deps, '关了再撤销', { completeChat: llm.fn });
  assert.equal(r.reply, '已恢复。');
  assert.equal(db.getSetting('push_enabled'), null, '撤销 = 把 settings 行删回「未设置」');
  assert.match(toolTexts(llm.seen[2]!).at(-1)!, /"tool": "set_push_enabled"/);
  assert.equal(undo.history().length, 1, '撤销自己不进变更记录（track:false）');
  assert.equal(undo.peek('admin'), null);
});

// ---- 入口泛化（P3：QQ 直连复用同一个 loop）----

test('入口泛化：role/scope/actor/channelId 全由 opts 决定，工具面与调用域随之变', async () => {
  const { chat, undo, deps } = fixture();
  const llm = fakeChat([
    () => ({ content: '我看看。', toolCalls: [toolCall('c1', 'search_streamers', { query: '阿梓' })] }),
    () => reply('没有找到。'),
  ]);

  const r = await runAgentTurn(deps, '本群推了哪些', {
    completeChat: llm.fn,
    scope: channelScope(7),
    role: 'gateway',
    actor: 'qqbot-group:111',
    channelId: 7,
    systemPrompt: '（QQ 变体）',
    fallbacks: { truncated: '（QQ 兜底）' },
  });
  assert.equal(r.reply, '没有找到。');

  // 工具面按角色过滤：gateway 看不到 admin 工具（不可见即不存在）
  const names = llm.seen[0]!.tools!.map((t) => t.name);
  assert.ok(names.includes('add_group_push_rule'));
  assert.ok(!names.includes('set_push_enabled'));

  // 系统提示用注入的变体（不再读 chat_write_mode）；往来落该渠道自己的会话
  assert.equal(llm.seen[0]!.messages[0]!.content, '（QQ 变体）');
  assert.deepEqual(chat.messages(channelScope(7)).map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.deepEqual(chat.messages(adminScope()), [], '面板会话不受影响');
  // 历史回放也只回放本渠道的（第二轮请求里带上第一轮的 tool 结果）
  assert.equal(toolTexts(llm.seen[1]!)[0]!, '[]', 'search_streamers 的 tool 结果原样回填');

  // 撤销域 = 该渠道栈：undo_last_change 在 gateway ctx 下会去 ch:7（未绑渠道会 403，见 run-tool.ts）
  const llm2 = fakeChat([
    () => ({ content: '好。', toolCalls: [toolCall('c9', 'undo_last_change')] }),
    () => reply('本渠道没有可撤的。'),
  ]);
  await runAgentTurn(deps, '撤销刚才那个', {
    completeChat: llm2.fn, scope: channelScope(7), role: 'gateway', actor: 'qqbot-group:111', channelId: 7,
  });
  assert.match(toolTexts(llm2.seen[1]!).at(-1)!, /没有可撤销的变更/, 'gateway 走渠道栈（本渠道栈为空，撤不到 admin 全局栈）');
  assert.equal(undo.peek(channelScope(7)), null, '撤销失败不留记录');

  // 缺省（不传 opts）仍是面板那套：admin scope / admin 工具面 / 面板提示
  const panelLlm = fakeChat([() => reply('面板答')]);
  await runAgentTurn(deps, '再问一次', { completeChat: panelLlm.fn });
  assert.ok(panelLlm.seen[0]!.tools!.some((t) => t.name === 'set_push_enabled'));
  assert.equal(panelLlm.seen[0]!.messages[0]!.content, panelLlm.seen[0]!.messages[0]!.content);
  assert.match(String(panelLlm.seen[0]!.messages[0]!.content), /DD-claw 控制面板里的助手/);
  assert.deepEqual(chat.messages(adminScope()).map((m) => m.role), ['user', 'assistant']);
});

test('入口泛化：兜底文案可覆盖（超轮次），未传 opts 时用面板原文案', async () => {
  const { deps } = fixture();
  const always = (): ChatCompletion => ({ content: '', toolCalls: [toolCall('c', 'list_streamers')] });
  const qq = fakeChat([always, always]);
  const r = await runAgentTurn(deps, '帮我处理一堆事', {
    completeChat: qq.fn, maxSteps: 2, scope: channelScope(9), role: 'gateway', actor: 'qqbot-group:222', channelId: 9,
    fallbacks: { truncated: '（QQ 兜底：拆两句再说）' },
  });
  assert.equal(r.truncated, true);
  assert.equal(r.reply, '（QQ 兜底：拆两句再说）');

  const panel = fakeChat([always, always]);
  const r2 = await runAgentTurn(deps, '面板也一样', { completeChat: panel.fn, maxSteps: 2 });
  assert.match(r2.reply, /连续 2 轮工具调用/);

  const empty = fakeChat([() => ({ content: '   ', toolCalls: [] })]);
  const r3 = await runAgentTurn(deps, '空回复', { completeChat: empty.fn, fallbacks: { empty: '（QQ：没生成出回复）' } });
  assert.equal(r3.reply, '（QQ：没生成出回复）');
});

// ---- 前置检查与缺省 LLM 接缝 ----

test('chatBlockedReason：未装配 / 总开关关 / 无可用 provider 各自给中文指引', async () => {
  const { db, deps } = fixture();
  assert.match(chatBlockedReason(deps)!, /LLM 未启用：请在设置页打开 LLM 总开关并添加 provider/);

  attachRouter(deps, ['sk']);
  assert.match(chatBlockedReason(deps)!, /LLM 未启用：请在设置页打开 LLM 总开关/);

  setLlmEnabled(db, true);
  assert.equal(chatBlockedReason(deps), null, '总开关开 + provider ready = 可用');

  attachRouter(deps, []);
  assert.match(chatBlockedReason(deps)!, /没有可用的 LLM provider/);
  assert.match(chatBlockedReason(deps)!, /缺 key/);

  const empty = { ...deps, llm: { router: createLlmRouter(
    { requestTimeoutMs: 1_000, circuitThreshold: 3, circuitCooldownMs: 60_000, providers: [] }, () => []) } };
  assert.match(chatBlockedReason(empty)!, /还没有配置 LLM provider/);

  const noChat: PanelDeps = { ...deps, chat: undefined };
  assert.equal(chatBlockedReason(noChat), '对话存储未装配');

  // 前置问题抛 400（不是 502）：调用方（REST）照它映射状态码
  await assert.rejects(runAgentTurn(deps, '在吗'), (e: unknown) => e instanceof HttpError && e.status === 400);
});

test('缺省 LLM 接缝：不注入 completeChat 时走 deps.llm.router 的真实 provider 路径', async () => {
  const { db, deps } = fixture();
  setLlmEnabled(db, true);
  const calls: string[] = [];
  attachRouter(deps, ['sk-chat'], async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ choices: [{ message: { content: '在的。' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const r = await runAgentTurn(deps, '在吗');
  assert.equal(r.reply, '在的。');
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /\/chat\/completions$/);
});

test('LLM 彻底失败 → 502（前置 400 之外的调用失败）', async () => {
  const { db, deps } = fixture();
  setLlmEnabled(db, true);
  attachRouter(deps, ['sk-chat'], async () => new Response('boom', { status: 500 }));

  await assert.rejects(
    runAgentTurn(deps, '在吗'),
    (e: unknown) => e instanceof HttpError && e.status === 502 && /LLM 调用失败/.test(e.message),
  );
});

test('入参校验：空消息 400；未装配会话存储 400', async () => {
  const { deps } = fixture();
  await assert.rejects(runAgentTurn(deps, '   '), (e: unknown) => e instanceof HttpError && e.status === 400);
  await assert.rejects(
    runAgentTurn({ ...deps, chat: undefined }, '在吗'),
    /对话存储未装配/,
  );
});