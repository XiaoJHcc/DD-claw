/**
 * QQ 自助入口（P3 NapCat 直连）契约测试——**全离线**，不连真 NapCat / QQ：
 * ① OneBot 11 事件解析（数组格式 / CQ 字符串格式 / 非消息 / 自发消息）；
 * ② 触发纪律（@、前缀、斜杠确定性命令、不触发即静默）；③ 对话限流；
 * ④ 会话→渠道映射（未映射**拒绝服务**，只对被唤起的消息回话）；⑤ 渠道隔离（上下文 + 撤销栈）；
 * ⑥ gateway 工具面（管理面工具不可见）；⑦ /reset；⑧ 回执裁剪与 /reset 附言；
 * ⑨ `POST /onebot` 路由（挂载门、响应形状、坏 body）与面板 `/api/chat` 回归（admin scope 不受影响）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { LlmProviderConfig } from '../config/schema.js';
import {
  createLlmRouter, setLlmEnabled, type ChatCompletion, type ChatMessage, type LlmRequest, type ToolCall,
} from '../analysis/providers.js';
import { ChatStore } from '../core/chat-store.js';
import { Db } from '../core/db.js';
import { UndoStore, adminScope, channelScope } from '../core/undo.js';
import { HttpError } from '../panel/http-util.js';
import { createPanelServer, type PanelDeps, type PanelStatus } from '../panel/server.js';
import { createQqbot, QQ_TURNS_PER_MINUTE } from './bot.js';
import type { QqConversation } from './onebot-event.js';
import { parseOnebotMessage } from './onebot-event.js';
import { QQ_REPLY_MAX_CHARS, QQ_TRUNCATED_SUFFIX, renderReply, resetHint } from './reply.js';
import { matchTriggerPrefix, parseChannelMap, saveChannelMap } from './settings.js';
import { decideTrigger } from './trigger.js';
import { RateLimiter } from '../mcp/rate-limit.js';

const STATUS: PanelStatus = {
  startedAt: 0, notifiers: [], watchedCount: 0, liveCount: 0, platforms: [],
};

const PROVIDER: LlmProviderConfig = {
  name: 'p3', baseURL: 'https://api.example.com/v1', model: 'm1', vision: false,
  keyEnvs: [], enabled: true, structuredOutput: 'schema', api: 'chat-completions',
};

const GROUP = 'group:111';
const GROUP2 = 'group:222';
const PRIVATE = 'private:333';

// ---- 夹具 ----

interface Fixture {
  db: Db;
  chat: ChatStore;
  undo: UndoStore;
  panel: PanelDeps;
  /** 假回执发送：记录每一条发出的回执（conv + 文本），断言渠道与文案 */
  sent: Array<{ conv: QqConversation; text: string }>;
  /** 假 LLM 每次请求都留档（断言工具面、历史回放与工具结果回填） */
  seen: LlmRequest[];
}

function fixture(opts: {
  script?: Array<(req: LlmRequest, i: number) => ChatCompletion>;
  resetHint?: { maxMessages: number; maxChars: number };
  limiter?: RateLimiter;
} = {}): Fixture & { bot: ReturnType<typeof createQqbot> } {
  const db = new Db(':memory:');
  // 生产装配里 bot 只在 qqbot_enabled=1 时才建（index.ts），这里等价地把开关打开；
  // 单独测「装配后热关」的用例再把它置 0。
  db.setSetting('qqbot_enabled', '1');
  const chat = new ChatStore(db.raw, opts.resetHint ? { resetHint: opts.resetHint } : {});
  chat.migrate();
  const undo = new UndoStore(db.raw);
  undo.migrate();
  const panel: PanelDeps = {
    db, chat, undo,
    undoLast: (scope) => undo.undo(scope ?? adminScope()),
    status: () => STATUS,
  };
  const seen: LlmRequest[] = [];
  const sent: Fixture['sent'] = [];
  const script = opts.script ?? [() => reply('好')];
  const completeChat = async (req: LlmRequest): Promise<ChatCompletion> => {
    seen.push({ ...req, messages: req.messages.map((m) => ({ ...m })) as ChatMessage[] });
    const step = script[seen.length - 1];
    if (!step) throw new Error(`剧本只准备了 ${script.length} 步，却被问了第 ${seen.length} 次`);
    // provider 由木偶补：剧本只关心正文/工具调用，真回答者由 provider 层给（loop 会把它落库）
    const out = step(req, seen.length - 1);
    return out.provider === undefined ? { ...out, provider: 'p1' } : out;
  };
  const bot = createQqbot({
    db,
    panel,
    send: async (conv, text) => { sent.push({ conv, text }); return { ok: true }; },
    completeChat,
    // 每个夹具一份限流桶（缺省 = 生产用的全局单例，测试间会互相污染）
    limiter: opts.limiter ?? new RateLimiter(QQ_TURNS_PER_MINUTE, 60_000),
  });
  return { db, chat, undo, panel, sent, seen, bot };
}

function reply(content: string): ChatCompletion {
  return { content, toolCalls: [] };
}

function toolCall(id: string, name: string, args: unknown = {}): ToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}

/** 群消息事件（数组格式，NapCat 默认；可覆盖任意字段） */
function groupEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    time: 1715000000, self_id: 10001, post_type: 'message', message_type: 'group',
    sub_type: 'normal', message_id: 1, group_id: 111, user_id: 222,
    raw_message: '[CQ:at,qq=10001] 加一下栞栞', font: 0, sender: { nickname: '群友' },
    message: [
      { type: 'at', data: { qq: '10001' } },
      { type: 'text', data: { text: ' 加一下栞栞' } },
    ],
    ...over,
  };
}

function privateEvent(text: string): Record<string, unknown> {
  return {
    time: 1715000000, self_id: 10001, post_type: 'message', message_type: 'private',
    sub_type: 'friend', message_id: 2, user_id: 333, raw_message: text,
    sender: { nickname: '某人' }, message: [{ type: 'text', data: { text } }],
  };
}

/** 只 @ 机器人、没正文 */
function rawEvent(over: Record<string, unknown>): Record<string, unknown> {
  return { time: 1, self_id: 10001, post_type: 'message', message_type: 'group', group_id: 111, user_id: 222, message: [], ...over };
}

function toolTexts(req: LlmRequest): string[] {
  return req.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
}

// ---- ① OneBot 事件解析 ----

test('数组格式群消息：剥离 @段取正文，认出 @机器人；群号/QQ号成为会话身份', () => {
  const msg = parseOnebotMessage(groupEvent())!;
  assert.equal(msg.conversation.key, GROUP);
  assert.equal(msg.conversation.kind, 'group');
  assert.equal(msg.conversation.id, '111');
  assert.equal(msg.userId, '222');
  assert.equal(msg.selfId, '10001');
  assert.equal(msg.mentionedSelf, true);
  assert.equal(msg.text, '加一下栞栞', '文本段拼接后 trim；@段不进正文');
});

test('CQ 字符串格式与实体还原：webui 里手配 messagePostFormat=string 也能用', () => {
  const msg = parseOnebotMessage({
    post_type: 'message', message_type: 'private', self_id: 10001, user_id: 333,
    raw_message: '[CQ:at,qq=10001]&#91;测试&#93; dd 加主播',
    message: '[CQ:at,qq=10001]&#91;测试&#93; dd 加主播',
  })!;
  assert.equal(msg.conversation.key, PRIVATE);
  assert.equal(msg.mentionedSelf, true, 'CQ 码里的 at 同样算 @机器人');
  assert.equal(msg.text, '[测试] dd 加主播', '&#91;/&#93; 还原成方括号');
});

test('非消息事件 / 自发消息 / 形状不认识：一律 null（调用方静默忽略）', () => {
  assert.equal(parseOnebotMessage({ post_type: 'meta_event', meta_event_type: 'heartbeat' }), null);
  assert.equal(parseOnebotMessage({ post_type: 'message', message_type: 'guild', user_id: 1 }), null);
  assert.equal(parseOnebotMessage({ post_type: 'message', message_type: 'group', group_id: 111 }), null, '缺 user_id');
  assert.equal(parseOnebotMessage({ post_type: 'message', message_type: 'group', group_id: 111, user_id: 10001, self_id: 10001 }), null, '自发消息');
  assert.equal(parseOnebotMessage('不是对象'), null);
  assert.equal(parseOnebotMessage(null), null);
  assert.equal(parseOnebotMessage({ ...groupEvent({ self_id: '10001' }) })!.selfId, '10001', '数字/字符串 self_id 都收');
});

// ---- ② 触发纪律 ----

test('触发判定：@机器人 / 前缀 / 私聊直通 / 斜杠命令 / 不触发', () => {
  const at = parseOnebotMessage(groupEvent())!;
  assert.deepEqual(decideTrigger(at, 'dd'), { kind: 'agent', prompt: '加一下栞栞' });

  const prefixed = parseOnebotMessage(groupEvent({
    message: [{ type: 'text', data: { text: 'dd加一下栞栞' } }],
  }))!;
  assert.deepEqual(decideTrigger(prefixed, 'dd'), { kind: 'agent', prompt: '加一下栞栞' }, '中文紧跟前缀也触发，前缀被剥掉');

  const longWord = parseOnebotMessage(groupEvent({
    message: [{ type: 'text', data: { text: 'dddd 我在说别的' } }],
  }))!;
  assert.equal(decideTrigger(longWord, 'dd').kind, 'ignore', '前缀后紧跟字母数字 = 不是唤起');

  const plain = parseOnebotMessage(groupEvent({
    message: [{ type: 'text', data: { text: '主播刚才那首歌叫什么' } }],
  }))!;
  assert.equal(decideTrigger(plain, 'dd').kind, 'ignore', '群里没人 @ 也没前缀 = 静默');

  const priv = parseOnebotMessage(privateEvent('现在推哪些主播'))!;
  assert.deepEqual(decideTrigger(priv, 'dd'), { kind: 'agent', prompt: '现在推哪些主播' }, '私聊直通');

  const reset = parseOnebotMessage(groupEvent({ message: [{ type: 'text', data: { text: '/reset' } }] }))!;
  assert.deepEqual(decideTrigger(reset, 'dd'), { kind: 'command', command: 'reset' }, '不 @ 也认斜杠命令');

  const unknown = decideTrigger(
    parseOnebotMessage(groupEvent({ message: [{ type: 'text', data: { text: '/whoami' } }] }))!,
    'dd',
  );
  assert.equal(unknown.kind, 'ignore', '未知斜杠命令不猜、不喂 LLM');

  const bare = parseOnebotMessage(rawEvent({ message: [{ type: 'at', data: { qq: 10001 } }] }))!;
  assert.deepEqual(decideTrigger(bare, 'dd'), { kind: 'empty' }, '只 @ 不说话');

  const emptyPrefix = parseOnebotMessage(groupEvent({
    message: [{ type: 'text', data: { text: 'dd' } }],
  }))!;
  assert.deepEqual(decideTrigger(emptyPrefix, 'dd'), { kind: 'empty' });
  assert.equal(matchTriggerPrefix('DD 加主播', 'dd'), '加主播', '前缀大小写不敏感');
  assert.equal(matchTriggerPrefix('dd 加主播', ''), null, '空前缀 = 关掉前缀触发');
});

test('群聊未被唤起：静默忽略，既不回执也不进 LLM', async () => {
  const { bot, sent, seen } = fixture();
  const out = await bot.handleEvent(groupEvent({ message: [{ type: 'text', data: { text: '你们在聊什么' } }] }));
  assert.deepEqual(out, { action: 'ignored', reason: '未 @机器人 且前缀不匹配' });
  assert.equal(sent.length, 0);
  assert.equal(seen.length, 0);
});

test('@机器人 触发一轮 LLM，回执按来源渠道回；/help 与 /reset 确定性执行不进 LLM', async () => {
  const { db, bot, sent, seen } = fixture({ script: [() => reply('查到了，栞栞在播。')] });
  saveChannelMap(db, { [GROUP]: 2 });

  const out = await bot.handleEvent(groupEvent());
  assert.equal(out.action, 'replied');
  assert.equal(seen.length, 1);
  assert.deepEqual(sent, [{ conv: { kind: 'group', id: '111', key: GROUP }, text: '查到了，栞栞在播。' }]);
  // 进 LLM 的正文是剥掉 @ 之后的
  assert.equal(seen[0]!.messages.at(-1)!.content, '加一下栞栞');

  const help = await bot.handleEvent(groupEvent({ message: [{ type: 'text', data: { text: '/help' } }] }));
  assert.equal(help.action, 'help');
  assert.equal(seen.length, 1, '/help 不接 LLM');
  assert.match(sent.at(-1)!.text, /DD-claw 自助推送/);

  const reset = await bot.handleEvent(groupEvent({ message: [{ type: 'text', data: { text: '/reset' } }] }));
  assert.equal(reset.action, 'reset');
  assert.equal(seen.length, 1, '/reset 不接 LLM');
  assert.match(sent.at(-1)!.text, /已清空/);
});

// ---- ③ 限流 ----

test('对话限流按渠道分桶：同一渠道第 N+1 条回缓和文案，别的渠道不受影响', async () => {
  const limiter = new RateLimiter(2, 60_000);
  const { db, bot, sent, seen } = fixture({ limiter, script: [() => reply('好'), () => reply('好'), () => reply('好')] });
  saveChannelMap(db, { [GROUP]: 2, [GROUP2]: 3 });

  assert.equal((await bot.handleEvent(groupEvent())).action, 'replied');
  assert.equal((await bot.handleEvent(groupEvent())).action, 'replied');
  const third = await bot.handleEvent(groupEvent());
  assert.equal(third.action, 'limited');
  assert.match(sent.at(-1)!.text, /说得有点快/);
  assert.equal(seen.length, 2, '超限不再调 LLM');

  const other = await bot.handleEvent(groupEvent({
    group_id: 222,
    message: [{ type: 'at', data: { qq: 10001 } }, { type: 'text', data: { text: ' 本群推哪些' } }],
  }));
  assert.equal(other.action, 'replied', '另一个渠道有自己的桶');
  assert.equal(seen.length, 3);
});

// ---- ④ 会话→渠道映射 ----

test('未映射渠道拒绝服务：不回落默认渠道、进不了 LLM；未被唤起则连拒绝都不回', async () => {
  const { bot, sent, seen } = fixture();
  const out = await bot.handleEvent(groupEvent());
  assert.deepEqual(out, { action: 'refused', reason: '未配置渠道映射' });
  assert.match(sent[0]!.text, /还没开通自助推送管理/);
  assert.equal(seen.length, 0);

  const quiet = await bot.handleEvent(groupEvent({ message: [{ type: 'text', data: { text: '随便聊聊' } }] }));
  assert.equal(quiet.action, 'ignored');
  assert.equal(sent.length, 1, '没开通的群里不对每条聊天插话');

  assert.deepEqual([...parseChannelMap('{"group:1":2,"private:3":"x","bad":0}')], [['group:1', 2]], '坏值静默丢弃');
  assert.equal(parseChannelMap('不是 JSON').size, 0);
});

test('总开关热关：装配后把 qqbot_enabled 置 0，事件被静默丢弃（不回执）', async () => {
  const { db, bot, sent } = fixture();
  saveChannelMap(db, { [GROUP]: 2 });
  db.setSetting('qqbot_enabled', '0');
  assert.deepEqual(await bot.handleEvent(groupEvent()), { action: 'disabled', reason: 'qqbot_enabled 未开' });
  assert.equal(sent.length, 0);
});

// ---- ⑤ 渠道隔离 + ⑥ gateway 工具面 ----

test('渠道隔离：A 群上下文与撤销栈对 B 群不可见；工具面只有 gateway（管理面工具不存在）', async () => {
  const { db, undo, chat, bot, seen } = fixture({
    script: [
      // A 群：先说一句，再撤销（撤本渠道栈顶）
      () => ({ content: '好，撤了。', toolCalls: [toolCall('c1', 'undo_last_change')] }),
      () => reply('已经撤掉了。'),
      // B 群：同样说「撤销」，但 B 群栈是空的
      () => ({ content: '我看看。', toolCalls: [toolCall('c2', 'undo_last_change')] }),
      () => reply('本群没有可撤的改动。'),
    ],
  });
  saveChannelMap(db, { [GROUP]: 2, [GROUP2]: 3 });
  // A 群栈预置一条记录（等价于「A 群之前改过一次」）
  await undo.track(
    { scope: channelScope(2), actor: 'qqbot-group:111', entry: 'agent', tool: 'set_push_enabled' },
    () => { db.setSetting('push_enabled', '0'); return { ok: true }; },
  );
  assert.equal(undo.peek(channelScope(2)) !== null, true);

  await bot.handleEvent(groupEvent());
  assert.match(toolTexts(seen[1]!)[0]!, /"tool": "set_push_enabled"/, 'A 群撤到自己渠道的记录');
  assert.equal(undo.peek(channelScope(2)), null, 'A 群栈顶已被撤');

  await bot.handleEvent(groupEvent({ group_id: 222, message: [{ type: 'at', data: { qq: 10001 } }, { type: 'text', data: { text: ' 撤销刚才那个' } }] }));
  assert.match(toolTexts(seen[3]!)[0]!, /没有可撤销的变更/, 'B 群看不到 A 群的撤销栈');
  assert.equal(undo.history({ scope: adminScope() }).length, 0, 'QQ 侧写不进 admin 全局栈');

  // 会话上下文互不可见（会话键 = 来源渠道）：B 群的历史里只有自己那一轮
  assert.deepEqual(
    chat.messages(channelScope(3)).filter((m) => m.role !== 'tool').map((m) => [m.role, m.content]),
    [['user', '撤销刚才那个'], ['assistant', '我看看。'], ['assistant', '本群没有可撤的改动。']],
  );
  assert.match(chat.messages(channelScope(2))[0]!.content, /加一下栞栞/);

  // 工具面：gateway = 只读 + 群自助 + 撤销；admin 工具与渠道列表都不在
  const names = seen[0]!.tools!.map((t) => t.name);
  for (const want of ['search_streamers', 'list_push_rules', 'add_group_push_rule', 'remove_group_push_rule', 'undo_last_change']) {
    assert.ok(names.includes(want), `${want} 应在 gateway 工具面`);
  }
  for (const not of ['set_push_enabled', 'watch_streamer', 'update_runtime_config', 'set_chat_mode', 'test_push', 'reorder_push_rules']) {
    assert.ok(!names.includes(not), `${not} 不该在 gateway 工具面`);
  }
  // 系统提示是 QQ 变体：只处理本渠道、没有任何渠道参数
  assert.match(String(seen[0]!.messages[0]!.content), /只处理本渠道|范围 = /);
  assert.match(String(seen[0]!.messages[0]!.content), /本群/);
});

// ---- ⑦ 会话键 = 来源渠道：/reset 只清自己的 ----

test('/reset 只清本渠道上下文，别的渠道与面板会话不动', async () => {
  const { db, chat, bot, sent } = fixture();
  saveChannelMap(db, { [GROUP]: 2, [GROUP2]: 3 });
  chat.append(channelScope(2), { role: 'user', content: 'A 群旧上下文' });
  chat.append(channelScope(3), { role: 'user', content: 'B 群旧上下文' });
  chat.append(adminScope(), { role: 'user', content: '面板旧上下文' });

  const out = await bot.handleEvent(groupEvent({ message: [{ type: 'text', data: { text: '/reset' } }] }));
  assert.equal(out.action, 'reset');
  assert.deepEqual(chat.messages(channelScope(2)), []);
  assert.equal(chat.messages(channelScope(3)).length, 1, 'B 群上下文不动');
  assert.equal(chat.messages(adminScope()).length, 1, '面板单会话不动');
  assert.ok(chat.find(channelScope(2)), 'reset 保留会话行');
  assert.match(sent[0]!.text, /已清空/);
});

// ---- ⑧ 回执裁剪与 /reset 附言 ----

test('回执裁剪：超长正文截断（正文优先、附截断说明），阈值内不动它', () => {
  const long = renderReply('啊'.repeat(1000), { kind: 'group' });
  assert.ok(long.length <= QQ_REPLY_MAX_CHARS, `截断后长度 ${long.length} ≤ ${QQ_REPLY_MAX_CHARS}`);
  assert.ok(long.endsWith(QQ_TRUNCATED_SUFFIX));
  assert.equal(renderReply('短回复', { kind: 'group' }), '短回复');
  assert.equal(renderReply('短回复\n\n\n\n\n后面', { kind: 'group' }), '短回复\n\n后面', '连续空行被压缩');

  const withHint = renderReply('啊'.repeat(1000), { kind: 'private', needsResetHint: true });
  assert.ok(withHint.length <= QQ_REPLY_MAX_CHARS, '附言占在同一预算里，不被截掉');
  assert.ok(withHint.endsWith(resetHint('private')));
  assert.match(resetHint('group'), /本群对话上下文已较长，发送 \/reset 可清空/, 'plan 原文口径');
});

test('上下文达阈值：回复末尾附 /reset 提示（QQ 侧替代面板的 UI 用量提示）', async () => {
  const { db, bot, sent } = fixture({
    script: [() => reply('收到。')],
    resetHint: { maxMessages: 2, maxChars: 100_000 },
  });
  saveChannelMap(db, { [GROUP]: 2 });
  const out = await bot.handleEvent(groupEvent());
  assert.equal(out.action, 'replied');
  assert.match(sent[0]!.text, /本群对话上下文已较长，发送 \/reset 可清空/);
});

// ---- 错误路径 ----

test('LLM 不可用：回一句如实说明，事件处理结果仍是 error 而不是抛给路由', async () => {
  const { db, panel, sent } = fixture();
  saveChannelMap(db, { [GROUP]: 2 });
  const bot = createQqbot({
    db,
    panel,
    send: async (conv, text) => { sent.push({ conv, text }); return { ok: true }; },
    // 与生产同源的两种失败：前置 400（未启用/无 provider）与调用彻底失败 502
    completeChat: async () => { throw new HttpError(400, 'LLM 未启用：请在设置页打开 LLM 总开关'); },
  });
  const out = await bot.handleEvent(groupEvent());
  assert.equal(out.action, 'error');
  assert.match(out.reason ?? '', /LLM 不可用 400/);
  assert.match(sent.at(-1)!.text, /模型暂时用不了/);

  const bot502 = createQqbot({
    db,
    panel,
    send: async (conv, text) => { sent.push({ conv, text }); return { ok: true }; },
    completeChat: async () => { throw new HttpError(502, 'LLM 调用失败：boom'); },
  });
  assert.equal((await bot502.handleEvent(groupEvent())).action, 'error');
  assert.match(sent.at(-1)!.text, /模型暂时用不了/);
});

test('回执发送失败：只记日志，处理结果照常回报（reason 带原因）', async () => {
  const { db, panel } = fixture();
  saveChannelMap(db, { [GROUP]: 2 });
  const bot = createQqbot({ db, panel, send: async () => ({ ok: false, error: '连接 NapCat 失败' }), completeChat: async () => reply('好') });
  const out = await bot.handleEvent(groupEvent());
  assert.equal(out.action, 'replied');
  assert.match(out.reason ?? '', /回执发送失败：连接 NapCat 失败/);
});

// ---- ⑨ 面板接线：POST /onebot 路由 + /api/chat 回归 ----

async function startPanel(
  t: import('node:test').TestContext,
  deps: PanelDeps,
): Promise<string> {
  const server: Server = createPanelServer(deps);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${port}`;
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text === '' ? {} : JSON.parse(text) as Record<string, unknown> };
}

test('POST /onebot：qqbot dep 注入才挂载；恒 200 + 动作摘要（不触发 OneBot 快速操作字段）', async (t) => {
  const { db, bot } = fixture();
  saveChannelMap(db, { [GROUP]: 2 });
  const events: unknown[] = [];
  const base = await startPanel(t, {
    db,
    status: () => STATUS,
    qqbot: { handleEvent: async (ev) => { events.push(ev); return bot.handleEvent(ev); } },
  });

  const ok = await post(base, '/onebot', groupEvent());
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true, action: 'replied' });
  assert.equal('reply' in ok.json, false, '响应里没有 quick-operation 字段');

  const ignored = await post(base, '/onebot', { post_type: 'meta_event' });
  assert.deepEqual(ignored.json, { ok: true, action: 'ignored', reason: '非消息事件 / 自发消息 / 形状不认识' });

  const bad = await post(base, '/onebot', '{不是 JSON');
  assert.equal(bad.status, 400, '坏 JSON 是传输层错误，照 400');

  const notPost = await fetch(`${base}/onebot`, { headers: { connection: 'close' } });
  assert.equal(notPost.status, 404, '事件入口只收 POST');

  const noDep = await startPanel(t, { db, status: () => STATUS });
  assert.equal((await post(noDep, '/onebot', groupEvent())).status, 404, 'dep 不注入 = 404（功能未装配）');
  assert.equal(events.length, 2, '只有注入 dep 的那个面板收到事件（两次 POST 都进了它，未装配的那个 404）');
});

test('面板 /api/chat 回归：admin 单会话照旧（工具面仍是 admin、上下文与 QQ 渠道互不可见）', async (t) => {
  const { db, chat, panel, seen, bot } = fixture();
  saveChannelMap(db, { [GROUP]: 2 });
  setLlmEnabled(db, true);
  const calls: string[] = [];
  panel.llm = {
    router: createLlmRouter(
      { requestTimeoutMs: 1_000, circuitThreshold: 3, circuitCooldownMs: 60_000, providers: [PROVIDER] },
      () => ['sk-admin'],
      {
        fetchFn: async (url: string) => {
          calls.push(url);
          return new Response(
            JSON.stringify({ choices: [{ message: { content: '面板这边一切正常。' } }] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        },
      },
    ),
  };
  const base = await startPanel(t, { ...panel, qqbot: { handleEvent: (ev) => bot.handleEvent(ev) } });

  const chatRes = await post(base, '/api/chat', { message: '现在谁在播' });
  assert.equal(chatRes.status, 200);
  assert.equal(chatRes.json.reply, '面板这边一切正常。');
  assert.match(calls[0]!, /\/chat\/completions$/);

  const hist = await fetch(`${base}/api/chat/history`, { headers: { connection: 'close' } });
  const histJson = (await hist.json()) as { messages: Array<{ content: string }>; usage: { messages: number } };
  assert.deepEqual(histJson.messages.map((m) => m.content), ['现在谁在播', '面板这边一切正常。'], '面板单会话在 admin scope');
  assert.equal(histJson.usage.messages, 2);

  // QQ 渠道的往来不落 admin scope；面板的历史也不进 QQ 渠道会话
  await bot.handleEvent(groupEvent());
  assert.equal(chat.messages(adminScope()).length, 2);
  assert.deepEqual(chat.messages(channelScope(2)).map((m) => m.role), ['user', 'assistant']);
  assert.equal(seen[0]!.messages.length, 2, '面板那轮没经过 qqbot 的假 LLM');
});