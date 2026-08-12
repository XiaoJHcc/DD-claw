import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from './db.js';

/** 内存库：每个测试独立，不需要清理临时文件 */
function memDb(t: import('node:test').TestContext): Db {
  const db = new Db(':memory:');
  t.after(() => db.close());
  return db;
}

// ---- streamers ----

test('seedStreamersIfEmpty：enabled/mode 兼容映射为 watch/notify，返回导入条数', (t) => {
  const db = memDb(t);
  const n = db.seedStreamersIfEmpty([
    { uid: '1', alias: '阿梓', enabled: true },
    { uid: '2', alias: '小可', enabled: false },
    { uid: '3', alias: '旧silent', enabled: true, mode: 'silent' },
  ]);
  assert.equal(n, 3);
  const s1 = db.getStreamer('1')!;
  assert.equal(s1.watch, true);
  assert.equal(s1.notify, true);
  assert.equal(s1.analyze, false);
  assert.equal(s1.alias, '阿梓');
  assert.equal(s1.source, 'manual');
  assert.equal(db.getStreamer('2')?.watch, false, 'enabled=false → watch=false');
  const s3 = db.getStreamer('3')!;
  assert.equal(s3.watch, true, '旧 mode=silent → 仍监听');
  assert.equal(s3.notify, false, '旧 mode=silent → notify=false');
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

test('listWatchedUids 只保留 watch=true 且纯数字 uid', (t) => {
  const db = memDb(t);
  db.upsertStreamer({ uid: '1', watch: true });
  db.upsertStreamer({ uid: '2', watch: true, notify: false });
  db.upsertStreamer({ uid: '3', watch: false });
  db.upsertStreamer({ uid: 'demo1001', watch: true });
  assert.deepEqual(db.listWatchedUids().sort(), ['1', '2'], '非数字 uid（演示数据）不进轮询');
});

test('upsertStreamer 部分更新保留原值，三开关可独立改写', (t) => {
  const db = memDb(t);
  db.upsertStreamer({ uid: '1', uname: '阿梓', alias: '梓宝', weiboUid: '123' });
  db.upsertStreamer({ uid: '1', uname: '阿梓从小就很可爱' });
  const s = db.getStreamer('1')!;
  assert.equal(s.uname, '阿梓从小就很可爱', '提供的字段被更新');
  assert.equal(s.alias, '梓宝', '未提供的字段保留原值');
  assert.equal(s.weiboUid, '123');

  db.upsertStreamer({ uid: '1', notify: false });
  const s2 = db.getStreamer('1')!;
  assert.equal(s2.notify, false);
  assert.equal(s2.watch, true, '其他开关不受影响');
  assert.equal(s2.analyze, false);

  db.upsertStreamer({ uid: '1', weiboNick: '阿梓从小就很可爱', weiboUid: '2203177060' });
  assert.equal(db.getStreamer('1')?.weiboNick, '阿梓从小就很可爱');
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
