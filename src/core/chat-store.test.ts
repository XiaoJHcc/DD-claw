/**
 * 会话存储测试：按来源渠道隔离、不自动裁剪、用量提示、重置上下文。
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { adminScope, channelScope } from './undo.js';
import { ChatStore } from './chat-store.js';

function setup(t: TestContext) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  let clock = 1_000;
  const store = new ChatStore(db, { now: () => (clock += 1) });
  store.migrate();
  return { db, store };
}

test('migrate 幂等；同一 scope 只建一个会话', (t) => {
  const { store } = setup(t);
  store.migrate();
  const a = store.session(adminScope());
  const b = store.session(adminScope());
  assert.equal(a.id, b.id);
  assert.equal(store.list().length, 1);
  assert.equal(store.session(channelScope(7)).id !== a.id, true);
  assert.equal(store.list().length, 2);
});

test('append / messages 往返（含 assistant 的 tool_calls 与 tool 回填）', (t) => {
  const { store } = setup(t);
  const scope = channelScope(7);
  store.append(scope, { role: 'user', content: '把栞栞推到本群' });
  store.append(scope, {
    role: 'assistant', content: '',
    toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'search_streamers', arguments: '{"q":"栞栞"}' } }],
  });
  store.append(scope, { role: 'tool', content: '{"uid":"7706705"}', toolCallId: 'call_1' });
  store.append(scope, { role: 'assistant', content: '已加好' });

  const msgs = store.messages(scope);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(msgs[1]!.toolCalls!.length, 1);
  assert.equal(msgs[2]!.toolCallId, 'call_1');
  assert.equal(msgs[3]!.content, '已加好');
  assert.ok(msgs[0]!.createdAt < msgs[3]!.createdAt, '按时间升序');
});

test('provider 列：assistant 记「谁答的」；未给/非 assistant/老消息一律 null', (t) => {
  const { store } = setup(t);
  const scope = channelScope(7);
  store.append(scope, { role: 'user', content: '谁在播' });
  store.append(scope, { role: 'assistant', content: '自动答的', provider: 'p1' });
  store.append(scope, { role: 'assistant', content: '没记 provider 的老消息形态', provider: null });
  store.append(scope, { role: 'assistant', content: '空串按没记处理', provider: '' });
  store.append(scope, { role: 'tool', content: '[]', toolCallId: 'c1', provider: 'p1' });

  assert.deepEqual(store.messages(scope).map((m) => m.provider), [null, 'p1', null, null, 'p1'],
    'provider 原样读回；空串 = 没记（不是「provider 名叫空串」）');

  // 老库在线补列：加列之前建的表只有老列（provider 不存在）——migrate 后能读写，且老行为 null
  const old = new Database(':memory:');
  t.after(() => old.close());
  old.exec(`CREATE TABLE chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL,
    role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', tool_calls TEXT,
    tool_call_id TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE chat_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
  old.prepare(`INSERT INTO chat_sessions (scope, created_at, updated_at) VALUES ('admin', 1, 1)`).run();
  old.prepare(`INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (1, 'assistant', '老行', 1)`).run();
  const upgraded = new ChatStore(old);
  upgraded.migrate();
  assert.deepEqual(upgraded.messages('admin').map((m) => [m.content, m.provider]), [['老行', null]]);
  upgraded.append('admin', { role: 'assistant', content: '新行', provider: 'p2' });
  assert.equal(upgraded.messages('admin').at(-1)!.provider, 'p2');
});

test('渠道隔离：不同群 / 私聊 / 面板的上下文互不可见', (t) => {
  const { store } = setup(t);
  store.append(channelScope(7), { role: 'user', content: '群 7 的话' });
  store.append(channelScope(8), { role: 'user', content: '群 8 的话' });
  store.append(adminScope(), { role: 'user', content: '面板的话' });

  assert.deepEqual(store.messages(channelScope(7)).map((m) => m.content), ['群 7 的话']);
  assert.deepEqual(store.messages(channelScope(8)).map((m) => m.content), ['群 8 的话']);
  assert.deepEqual(store.messages(adminScope()).map((m) => m.content), ['面板的话']);
  assert.deepEqual(store.messages(channelScope(99)), []);
});

test('不自动裁剪：超过阈值仍全量返回，由调用方决定提示', (t) => {
  const { store } = setup(t);
  const scope = channelScope(7);
  for (let i = 0; i < 50; i++) store.append(scope, { role: 'user', content: `第 ${i} 条` });
  assert.equal(store.messages(scope).length, 50, '不得自动裁剪');
  assert.equal(store.usage(scope).messages, 50);
  assert.equal(store.usage(scope).needsResetHint, true);
});

test('用量提示阈值：40 条消息 / 8k 字符', (t) => {
  const { store } = setup(t);
  const scope = channelScope(7);
  assert.deepEqual(store.usage(scope), { messages: 0, chars: 0, needsResetHint: false }, '无会话时用量为 0');

  for (let i = 0; i < 39; i++) store.append(scope, { role: 'user', content: 'x' });
  assert.equal(store.usage(scope).needsResetHint, false, '39 条还没到阈值');
  store.append(scope, { role: 'user', content: 'x' });
  assert.equal(store.usage(scope).needsResetHint, true, '40 条到阈值');

  const big = channelScope(8);
  store.append(big, { role: 'user', content: 'a'.repeat(7_999) });
  assert.equal(store.usage(big).needsResetHint, false);
  store.append(big, { role: 'user', content: 'b' });
  assert.equal(store.usage(big).needsResetHint, true, '8000 字符到阈值');
  assert.equal(store.usage(big).chars, 8_000);
});

test('reset 清空消息但保留会话行（id 不变），之后再 append 正常', (t) => {
  const { store } = setup(t);
  const scope = channelScope(7);
  const id = store.session(scope).id;
  store.append(scope, { role: 'user', content: '一' });
  store.append(scope, { role: 'assistant', content: '二' });

  assert.equal(store.reset(scope), 2);
  assert.deepEqual(store.messages(scope), []);
  assert.equal(store.find(scope)!.id, id, '会话行保留');
  assert.equal(store.usage(scope).messages, 0);
  assert.equal(store.usage(scope).needsResetHint, false);

  store.append(scope, { role: 'user', content: '重置后' });
  assert.deepEqual(store.messages(scope).map((m) => m.content), ['重置后']);
});

test('reset 未知 scope：返回 0 且不新建会话；peek 不影响别的渠道', (t) => {
  const { store } = setup(t);
  store.append(channelScope(7), { role: 'user', content: 'x' });
  assert.equal(store.reset(channelScope(99)), 0);
  assert.equal(store.find(channelScope(99)), null);
  assert.equal(store.reset(channelScope(7)), 1);
  assert.equal(store.find(channelScope(7))!.id > 0, true, '该渠道的会话行仍在');
});

test('limit 只影响展示：取最近 N 条且仍按升序', (t) => {
  const { store } = setup(t);
  const scope = channelScope(7);
  for (let i = 1; i <= 10; i++) store.append(scope, { role: 'user', content: `#${i}` });
  assert.deepEqual(store.messages(scope, { limit: 3 }).map((m) => m.content), ['#8', '#9', '#10']);
  assert.equal(store.messages(scope).length, 10, 'limit 不改动存储');
});
