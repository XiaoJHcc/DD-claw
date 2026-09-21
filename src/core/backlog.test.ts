/**
 * 图文补推挑选纯函数（core/backlog.ts）单测：轮次判定优先级、时间窗、条数上限、正序输出。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickBacklogPush, roundKind } from './backlog.js';

test('roundKind：resume 优先于一切；gap=本实例首轮；normal=其余', () => {
  assert.equal(roundKind(true, true), 'resume', 'flag 在就轮不到缺口判定');
  assert.equal(roundKind(true, false), 'resume');
  assert.equal(roundKind(false, true), 'gap');
  assert.equal(roundKind(false, false), 'normal');
});

test('pickBacklogPush：没有新帖 / 全在窗外 → 空（一律静默）', () => {
  const now = 1_800_000_000;
  const posts = [{ pubTs: now - 100 }, { pubTs: now - 50 }];
  assert.deepEqual(pickBacklogPush(posts, [], { maxAgeSec: 3600, maxPerAccount: 10 }, now), []);
  assert.deepEqual(
    pickBacklogPush(posts, [0, 1], { maxAgeSec: 25, maxPerAccount: 10 }, now),
    [],
    '两条都在 25s 窗外 → 全静默',
  );
});

test('pickBacklogPush：窗内取最新 N 条，按发布时间正序返回；pubTs 未知按窗外', () => {
  const now = 1_800_000_000;
  const posts = [
    { pubTs: now - 300 },  // 0 窗内最旧
    { pubTs: now - 200 },  // 1 窗内
    { pubTs: now - 100 },  // 2 窗内最新
    { pubTs: now - 7200 }, // 3 窗外（2h 前，窗 1h）
    { pubTs: 0 },          // 4 时间未知 → 按窗外（只归档不补推）
  ];
  assert.deepEqual(
    pickBacklogPush(posts, [0, 1, 2, 3, 4], { maxAgeSec: 3600, maxPerAccount: 10 }, now),
    [0, 1, 2],
    '窗外与未知时间的剔除，其余时间正序',
  );
  assert.deepEqual(
    pickBacklogPush(posts, [0, 1, 2], { maxAgeSec: 3600, maxPerAccount: 2 }, now),
    [1, 2],
    '条数上限取最新 2 条（丢最旧的 0），仍是时间正序',
  );
});
