import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bus } from './bus.js';
import type { Signal } from './types.js';

function signal(kind: Signal['kind'] = 'live_start'): Signal {
  return { source: 'test', kind, uid: '1', roomId: 'r1', ts: 0 };
}

test('多个 handler 都收到信号，* 与具体 kind 都生效', () => {
  const bus = new Bus();
  const got: string[] = [];
  bus.on('*', () => got.push('star'));
  bus.on('live_start', () => got.push('start'));
  bus.on('live_end', () => got.push('end'));

  bus.emit(signal('live_start'));
  assert.deepEqual(got.sort(), ['star', 'start']);

  got.length = 0;
  bus.emit(signal('title_change'));
  assert.deepEqual(got, ['star'], '未订阅的 kind 只有 * 收到');
});

test('一个 handler 抛异常不影响其他 handler（同步与异步）', async () => {
  const bus = new Bus();
  const got: string[] = [];
  bus.on('*', () => { throw new Error('同步炸'); });
  bus.on('*', () => { got.push('ok'); });
  bus.on('*', async () => { throw new Error('异步炸'); });
  bus.on('*', () => { got.push('ok2'); });

  bus.emit(signal());
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(got, ['ok', 'ok2']);
});
