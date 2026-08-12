import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotifyDispatcher } from './dispatcher.js';
import { Db } from '../core/db.js';
import type { PushMessage } from '../core/types.js';
import type { Notifier } from './types.js';

class FakeNotifier implements Notifier {
  readonly capabilities = { image: true, clickThrough: false };
  sent: PushMessage[] = [];
  alert?: (title: string, body: string) => Promise<void>;
  constructor(readonly name: string) {}
  async send(msg: PushMessage) {
    this.sent.push(msg);
    return [{ ok: true, target: this.name }];
  }
}

function msg(over: Partial<PushMessage> = {}): PushMessage {
  return { title: 't', body: 'b', priority: 'normal', ...over };
}

function harness(t: import('node:test').TestContext) {
  const db = new Db(':memory:');
  t.after(() => db.close());
  const toast = new FakeNotifier('toast');
  const onebot = new FakeNotifier('onebot');
  const disp = new NotifyDispatcher([toast, onebot], db);
  return { db, toast, onebot, disp };
}

/** 种子三条渠道：1=toast / 2=onebot 群 / 3=onebot 私聊（停用） */
function seedChannels(db: Db): void {
  db.seedPushChannelsIfEmpty([
    { name: '系统通知', notifier: 'toast', targetType: null, targetId: null, enabled: true },
    { name: '粉丝群', notifier: 'onebot', targetType: 'group', targetId: '11111', enabled: true },
    { name: '私聊', notifier: 'onebot', targetType: 'private', targetId: '22222', enabled: false },
  ]);
}

test('channels 路由：按 notifier 分组，onebot 渠道解析成 msg.targets', async (t) => {
  const { db, toast, onebot, disp } = harness(t);
  seedChannels(db);

  const out = await disp.broadcast(msg({ channels: ['1', '2'] }));
  assert.equal(out.anySuccess, true);
  assert.equal(toast.sent.length, 1, 'toast 组非空才发');
  assert.equal(onebot.sent.length, 1);
  assert.deepEqual(onebot.sent[0]!.targets, [{ type: 'group', id: '11111' }],
    '选中渠道解析成 onebot 目标');
  assert.equal(toast.sent[0]!.targets, undefined, 'toast 消息不带 targets');
});

test('channels 路由：禁用的渠道跳过；该 notifier 无选中渠道则不发', async (t) => {
  const { db, toast, onebot, disp } = harness(t);
  seedChannels(db);

  const out = await disp.broadcast(msg({ channels: ['3'] })); // 只有停用的私聊
  assert.equal(onebot.sent.length, 0, '停用渠道不发');
  assert.equal(toast.sent.length, 0, 'toast 无选中渠道跳过');
  assert.equal(out.anySuccess, false);
});

test('channels 缺省：旧行为全通道发，不动 msg.targets', async (t) => {
  const { toast, onebot, disp } = harness(t);
  const m = msg({ targets: [{ type: 'group', id: '99999' }] });
  await disp.broadcast(m);
  assert.equal(toast.sent.length, 1);
  assert.equal(onebot.sent.length, 1);
  assert.deepEqual(onebot.sent[0]!.targets, [{ type: 'group', id: '99999' }], '原样透传');
});

test('channels 路由：onebot 渠道被删/不存在时该组为空则跳过', async (t) => {
  const { db, toast, onebot, disp } = harness(t);
  seedChannels(db);
  db.deletePushChannel(2);

  await disp.broadcast(msg({ channels: ['2'] }));
  assert.equal(onebot.sent.length, 0);
  assert.equal(toast.sent.length, 0);
});

test('alertAll：本机告警只派发到实现 alert 的通道；带 qqTarget 时另走 onebot 私聊', async (t) => {
  const { toast, onebot, disp } = harness(t);
  toast.alert = async (title, body) => { toast.sent.push(msg({ title, body })); };

  await disp.alertAll('标题', '正文');
  assert.equal(toast.sent.length, 1, 'toast 收到本机告警');
  assert.equal(onebot.sent.length, 0, '不带 qqTarget 时 onebot 不收告警');

  await disp.alertAll('标题', '正文', '12345');
  assert.equal(toast.sent.length, 2);
  assert.equal(onebot.sent.length, 1, '带 qqTarget 时另走 onebot');
  assert.deepEqual(onebot.sent[0]!.targets, [{ type: 'private', id: '12345' }]);
  assert.match(onebot.sent[0]!.title, /【告警】标题/);
});
