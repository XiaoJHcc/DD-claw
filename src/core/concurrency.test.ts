import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapLimit } from './concurrency.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('保持结果顺序与输入一致', async () => {
  const r = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
    await sleep((6 - n) * 5); // 故意让后面的先完成
    return n * 10;
  });
  assert.deepEqual(r, [10, 20, 30, 40, 50]);
});

test('并发不超过 limit', async () => {
  let inFlight = 0;
  let peak = 0;
  await mapLimit(Array.from({ length: 10 }), 3, async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await sleep(10);
    inFlight--;
  });
  assert.ok(peak <= 3, `峰值 ${peak} 应不超过 3`);
  assert.ok(peak > 1, '应真的并发');
});

test('单个任务抛错不影响其他任务', async () => {
  const r = await mapLimit([1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error('boom');
    return n;
  });
  assert.deepEqual(r, [1, undefined, 3]);
});

test('空数组直接返回', async () => {
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
});

test('limit 大于数组长度时不会起多余 worker', async () => {
  let calls = 0;
  await mapLimit([1, 2], 99, async () => { calls++; });
  assert.equal(calls, 2);
});
