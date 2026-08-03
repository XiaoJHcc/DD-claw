import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from './db.js';

/** 临时目录；afterClose 先跑（关连接）再删目录，避免 Windows 文件锁 EBUSY */
function tmpdir_(t: import('node:test').TestContext, afterClose: () => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'ddclaw-'));
  t.after(() => {
    afterClose();
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** 手工建一个「旧 schema」库：room_state / streamers / follows 均不含新列 */
function makeOldDb(path: string): void {
  const raw = new Database(path);
  raw.exec(`
    CREATE TABLE room_state (
      uid TEXT PRIMARY KEY, room_id TEXT NOT NULL, is_live INTEGER NOT NULL,
      live_time INTEGER NOT NULL, title TEXT, updated_at INTEGER NOT NULL
    );
    CREATE TABLE streamers (
      uid TEXT PRIMARY KEY, uname TEXT NOT NULL DEFAULT '', alias TEXT,
      room_id TEXT, weibo_uid TEXT,
      mode TEXT NOT NULL DEFAULT 'on' CHECK(mode IN ('off','silent','on')),
      analyze INTEGER NOT NULL DEFAULT 0, profile_note TEXT,
      source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('follows','manual')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE follows (
      uid TEXT PRIMARY KEY, uname TEXT NOT NULL DEFAULT '',
      first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
      is_followed INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO room_state VALUES ('1', '80397', 1, 1785310737, '旧标题', 1800000000);
    INSERT INTO streamers (uid, uname, mode, source, created_at, updated_at)
      VALUES ('1', '旧主播', 'on', 'manual', 1800000000, 1800000000);
    INSERT INTO follows VALUES ('1', '旧关注', 1800000000, 1800000000, 1);
  `);
  raw.close();
}

function columns(path: string, table: string): string[] {
  const raw = new Database(path, { readonly: true });
  const cols = (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((c) => c.name);
  raw.close();
  return cols;
}

test('旧库迁移：新列补齐，旧数据原样保留', (t) => {
  let db: Db | undefined;
  const path = join(tmpdir_(t, () => db?.close()), 'old.db');
  makeOldDb(path);

  db = new Db(path);

  for (const col of ['area_name', 'parent_area_name', 'keyframe', 'cover', 'online', 'last_live_at']) {
    assert.ok(columns(path, 'room_state').includes(col), `room_state 应补列 ${col}`);
  }
  for (const col of ['face', 'watch', 'notify', 'weibo_nick']) {
    assert.ok(columns(path, 'streamers').includes(col), `streamers 应补列 ${col}`);
  }
  assert.ok(!columns(path, 'streamers').includes('mode'), 'streamers 旧 mode 列应被删除');
  assert.ok(columns(path, 'follows').includes('face'), 'follows 应补列 face');

  // 旧数据还在，新列读出为缺省值
  const state = db.loadRoomStates().get('1');
  assert.equal(state?.title, '旧标题');
  assert.equal(state?.isLive, true);
  assert.equal(state?.areaName, '');
  assert.equal(state?.online, 0);
  const st = db.getStreamer('1')!;
  assert.equal(st.uname, '旧主播');
  assert.equal(st.face, null);
  assert.equal(st.watch, true, '旧 mode=on → watch=1');
  assert.equal(st.notify, true);
  assert.equal(st.weiboNick, null);
  assert.equal(db.listFollows().find((f) => f.uid === '1')?.uname, '旧关注');
});

test('旧 mode 列迁移：off→watch=0，silent→notify=0，mode 列删除且幂等', (t) => {
  let db: Db | undefined;
  const path = join(tmpdir_(t, () => db?.close()), 'mig.db');
  const raw = new Database(path);
  raw.exec(`
    CREATE TABLE streamers (
      uid TEXT PRIMARY KEY, uname TEXT NOT NULL DEFAULT '', alias TEXT,
      room_id TEXT, weibo_uid TEXT,
      mode TEXT NOT NULL DEFAULT 'on' CHECK(mode IN ('off','silent','on')),
      analyze INTEGER NOT NULL DEFAULT 0, profile_note TEXT,
      source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('follows','manual')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO streamers (uid, uname, mode, analyze, created_at, updated_at) VALUES
      ('1', 'A', 'on', 1, 1800000000, 1800000000),
      ('2', 'B', 'off', 0, 1800000000, 1800000000),
      ('3', 'C', 'silent', 0, 1800000000, 1800000000);
  `);
  raw.close();

  db = new Db(path);

  assert.ok(!columns(path, 'streamers').includes('mode'), 'mode 列应被删除');
  const s1 = db.getStreamer('1')!;
  assert.deepEqual([s1.watch, s1.notify, s1.analyze], [true, true, true], 'on → 全开，analyze 保留');
  const s2 = db.getStreamer('2')!;
  assert.deepEqual([s2.watch, s2.notify], [false, true], 'off → watch=0');
  const s3 = db.getStreamer('3')!;
  assert.deepEqual([s3.watch, s3.notify], [true, false], 'silent → notify=0');

  // 幂等：再开一次（无 mode 列）不报错、数据不变
  db.close();
  db = new Db(path);
  assert.deepEqual(
    [db.getStreamer('2')!.watch, db.getStreamer('3')!.notify],
    [false, false],
    '二次打开不重复迁移',
  );
});

test('saveRoomState / loadRoomStates 新字段往返一致', (t) => {
  let db: Db | undefined;
  const path = join(tmpdir_(t, () => db?.close()), 'old.db');
  makeOldDb(path);
  db = new Db(path);

  db.saveRoomState('1', {
    roomId: '80397', isLive: true, liveTime: 1_785_310_737, title: '新标题',
    areaName: '无畏契约', parentAreaName: '网游', keyframe: 'k.jpg',
    cover: 'c.jpg', online: 1234, face: '',
  });
  const s = db.loadRoomStates().get('1')!;
  assert.equal(s.areaName, '无畏契约');
  assert.equal(s.parentAreaName, '网游');
  assert.equal(s.keyframe, 'k.jpg');
  assert.equal(s.cover, 'c.jpg');
  assert.equal(s.online, 1234);
  assert.equal(s.title, '新标题', '旧行被更新而不是丢失');
});

test('last_live_at：在播时刷新，下播后保留（下播时长锚点）', async (t) => {
  let db: Db | undefined;
  let raw: Database.Database | undefined;
  const path = join(tmpdir_(t, () => { db?.close(); raw?.close(); }), 'old.db');
  makeOldDb(path);
  db = new Db(path);
  raw = new Database(path);
  const lastLiveAt = () =>
    (raw!.prepare('SELECT last_live_at FROM room_state WHERE uid = ?').get('1') as { last_live_at: number | null }).last_live_at;

  const base = {
    roomId: '80397', liveTime: 1_785_310_737, title: 't',
    areaName: '', parentAreaName: '', keyframe: '', cover: '', online: 0, face: '',
  };

  db.saveRoomState('1', { ...base, isLive: true });
  const t1 = lastLiveAt();
  assert.ok(t1 !== null && t1 > 0, '在播时写入当前时间');
  assert.equal(db.countLiveRooms(), 1);

  await new Promise((r) => setTimeout(r, 1100)); // 秒级时间戳，跨一秒才能区分
  db.saveRoomState('1', { ...base, isLive: true });
  const t2 = lastLiveAt();
  assert.ok(t2 !== null && t2 > t1!, '仍在播：last_live_at 刷新');

  db.saveRoomState('1', { ...base, isLive: false, liveTime: 0 });
  assert.equal(lastLiveAt(), t2, '下播后保留旧值');
  assert.equal(db.countLiveRooms(), 0);
});

test('countLiveRooms 统计在播房间数', (t) => {
  let db: Db | undefined;
  db = new Db(join(tmpdir_(t, () => db?.close()), 'new.db'));
  const base = {
    roomId: 'r', liveTime: 1, title: '', areaName: '', parentAreaName: '',
    keyframe: '', cover: '', online: 0, face: '',
  };
  assert.equal(db.countLiveRooms(), 0);
  db.saveRoomState('1', { ...base, isLive: true });
  db.saveRoomState('2', { ...base, isLive: false, liveTime: 0 });
  db.saveRoomState('3', { ...base, isLive: true });
  assert.equal(db.countLiveRooms(), 2);
});
