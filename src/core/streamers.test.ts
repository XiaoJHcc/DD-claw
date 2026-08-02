import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from './db.js';
import type { NewClause } from './streamers.js';

/** 内存库：每个测试独立，不需要清理临时文件 */
function memDb(t: import('node:test').TestContext): Db {
  const db = new Db(':memory:');
  t.after(() => db.close());
  return db;
}

function clause(over: Partial<NewClause> = {}): NewClause {
  return {
    uid: '1', scenes: ['singing'], minConfidence: 0.7, titleKeywords: ['歌回'],
    priority: 'high', messageTemplate: '{alias} 开歌回了', targets: null, enabled: true,
    ...over,
  };
}

// ---- streamers ----

test('seedStreamersIfEmpty：enabled→on / 否则 off，返回导入条数', (t) => {
  const db = memDb(t);
  const n = db.seedStreamersIfEmpty([
    { uid: '1', alias: '阿梓', enabled: true },
    { uid: '2', alias: '小可', enabled: false },
  ]);
  assert.equal(n, 2);
  assert.equal(db.getStreamer('1')?.mode, 'on');
  assert.equal(db.getStreamer('1')?.alias, '阿梓');
  assert.equal(db.getStreamer('1')?.source, 'manual');
  assert.equal(db.getStreamer('2')?.mode, 'off');
});

test('seedStreamersIfEmpty 幂等：表非空时第二次不重复导', (t) => {
  const db = memDb(t);
  db.seedStreamersIfEmpty([{ uid: '1', alias: '阿梓', enabled: true }]);
  const n = db.seedStreamersIfEmpty([
    { uid: '2', alias: '小可', enabled: true },
    { uid: '3', alias: '学妹', enabled: true },
  ]);
  assert.equal(n, 0, '非空时不得导入');
  assert.equal(db.listStreamers().length, 1, '表内容不变');
});

test('listWatchedUids 过滤 mode=off，保留 silent / on', (t) => {
  const db = memDb(t);
  db.upsertStreamer({ uid: '1', mode: 'on' });
  db.upsertStreamer({ uid: '2', mode: 'silent' });
  db.upsertStreamer({ uid: '3', mode: 'off' });
  assert.deepEqual(db.listWatchedUids().sort(), ['1', '2']);
});

test('upsertStreamer 部分更新保留原值，setStreamerMode 生效', (t) => {
  const db = memDb(t);
  db.upsertStreamer({ uid: '1', uname: '阿梓', alias: '梓宝', weiboUid: '123' });
  db.upsertStreamer({ uid: '1', uname: '阿梓从小就很可爱' });
  const s = db.getStreamer('1')!;
  assert.equal(s.uname, '阿梓从小就很可爱', '提供的字段被更新');
  assert.equal(s.alias, '梓宝', '未提供的字段保留原值');
  assert.equal(s.weiboUid, '123');

  assert.equal(db.setStreamerMode('1', 'off'), true);
  assert.equal(db.getStreamer('1')?.mode, 'off');
  assert.equal(db.setStreamerMode('不存在', 'off'), false);
});

test('upsertStreamer face：建行默认 null，改行未提供保留原值', (t) => {
  const db = memDb(t);
  db.upsertStreamer({ uid: '1', uname: 'A' });
  assert.equal(db.getStreamer('1')?.face, null, '未提供时建行默认 null');

  db.upsertStreamer({ uid: '1', face: 'https://i0.hdslb.com/f.jpg' });
  assert.equal(db.getStreamer('1')?.face, 'https://i0.hdslb.com/f.jpg');

  db.upsertStreamer({ uid: '1', uname: 'A2' });
  assert.equal(db.getStreamer('1')?.face, 'https://i0.hdslb.com/f.jpg', '未提供 face 时保留原值');
});

// ---- follows ----

test('upsertFollows + markFollowsSynced：不在 seen 里的标记取关', (t) => {
  const db = memDb(t);
  db.upsertFollows([{ uid: '1', uname: 'A' }, { uid: '2', uname: 'B' }]);
  db.upsertFollows([{ uid: '2', uname: 'B2' }, { uid: '3', uname: 'C' }]);

  const unfollowed = db.markFollowsSynced(['2', '3'], 1_800_000_000);
  assert.equal(unfollowed, 1, '只有 uid=1 被标记取关');

  const all = db.listFollows();
  assert.equal(all.length, 3);
  const byUid = new Map(all.map((f) => [f.uid, f]));
  assert.equal(byUid.get('1')?.isFollowed, false);
  assert.equal(byUid.get('2')?.isFollowed, true);
  assert.equal(byUid.get('2')?.uname, 'B2', 'uname 被刷新');
  assert.equal(byUid.get('2')?.lastSeen, 1_800_000_000, 'seen 的 lastSeen 更新到同步时间');
  assert.deepEqual(db.listFollows(true).map((f) => f.uid).sort(), ['2', '3']);
});

test('markFollowsSynced 空 seen = 全部取关', (t) => {
  const db = memDb(t);
  db.upsertFollows([{ uid: '1', uname: 'A' }, { uid: '2', uname: 'B' }]);
  assert.equal(db.markFollowsSynced([], 1_800_000_000), 2);
  assert.equal(db.listFollows(true).length, 0);
});

test('upsertFollows face：写入并可读，空值不覆盖已有头像（只进不退）', (t) => {
  const db = memDb(t);
  db.upsertFollows([{ uid: '1', uname: 'A' }]);
  assert.equal(db.listFollows().find((f) => f.uid === '1')?.face, null, '未提供时默认 null');

  db.upsertFollows([{ uid: '1', uname: 'A', face: 'https://i0.hdslb.com/f.jpg' }]);
  assert.equal(db.listFollows().find((f) => f.uid === '1')?.face, 'https://i0.hdslb.com/f.jpg');

  db.upsertFollows([{ uid: '1', uname: 'A' }]);
  assert.equal(db.listFollows().find((f) => f.uid === '1')?.face, 'https://i0.hdslb.com/f.jpg',
    '缺省 face 不覆盖已有值');

  db.upsertFollows([{ uid: '1', uname: 'A', face: '' }]);
  assert.equal(db.listFollows().find((f) => f.uid === '1')?.face, 'https://i0.hdslb.com/f.jpg',
    '空串 face 不覆盖已有值');
});

// ---- preference_clauses ----

test('clause CRUD：insert / list / update / disable / delete', (t) => {
  const db = memDb(t);
  const id = db.insertClause(clause());
  assert.ok(id > 0);

  db.insertClause(clause({ uid: '2', enabled: false }));

  let enabled = db.listEnabledClauses();
  assert.equal(enabled.length, 1, 'disabled 的不出现在 listEnabledClauses');
  assert.deepEqual(enabled[0]!.scenes, ['singing'], 'JSON 数组字段正确解析');
  assert.deepEqual(enabled[0]!.titleKeywords, ['歌回']);
  assert.equal(enabled[0]!.minConfidence, 0.7);
  assert.equal(enabled[0]!.targets, null);

  assert.equal(db.updateClause(id, { priority: 'low', targets: [{ type: 'group', id: '100' }] }), true);
  enabled = db.listEnabledClauses('1');
  assert.equal(enabled[0]!.priority, 'low');
  assert.deepEqual(enabled[0]!.targets, [{ type: 'group', id: '100' }]);
  assert.equal(enabled[0]!.messageTemplate, '{alias} 开歌回了', '未提供的字段保留原值');
  assert.equal(db.listEnabledClauses('其他uid').length, 0, 'uid 过滤生效');

  assert.equal(db.setClauseEnabled(id, false), true);
  assert.equal(db.listEnabledClauses().length, 0);

  assert.equal(db.deleteClause(id), true);
  assert.equal(db.deleteClause(id), false, '重复删除返回 false');
});
