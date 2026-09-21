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
import { UndoStore, adminScope } from '../core/undo.js';
import { HttpError } from '../panel/http-util.js';
import type { PanelDeps, PanelStatus } from '../panel/server.js';
import { AGENT_MAX_STEPS, chatBlockedReason, runAgentTurn } from './loop.js';
import { getChatWriteMode, setChatWriteMode } from './system-prompt.js';

const STATUS: PanelStatus = {
  startedAt: 0, notifiers: [], watchedCount: 0, liveCount: 0, platforms: [],
};

const PROVIDER: LlmProviderConfig = {
  name: 'p1', baseURL: 'https://api.example.com/v1', model: 'm1', vision: false,
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

/** 假 LLM：第 i 次请求取剧本第 i 步；请求深拷留档（loop 会继续往自己的数组里 push） */
function fakeChat(script: Array<(req: LlmRequest, i: number) => ChatCompletion>) {
  const seen: LlmRequest[] = [];
  const fn = async (req: LlmRequest): Promise<ChatCompletion> => {
    seen.push({ ...req, messages: req.messages.map((m) => ({ ...m })) as ChatMessage[] });
    const step = script[seen.length - 1];
    if (!step) throw new Error(`剧本只准备了 ${script.length} 步，却被问了第 ${seen.length} 次`);
    return step(req, seen.length - 1);
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
  for (const not of ['set_chat_mode', 'test_push', 'reorder_push_rules', 'list_group_channels']) {
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