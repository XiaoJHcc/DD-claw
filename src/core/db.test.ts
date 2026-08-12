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

/** 手工建一个「旧 schema」库：room_state / streamers / follows 均不含后加的展示列 */
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
      watch INTEGER NOT NULL DEFAULT 1, analyze INTEGER NOT NULL DEFAULT 0,
      notify INTEGER NOT NULL DEFAULT 1, profile_note TEXT,
      source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('follows','manual')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE follows (
      uid TEXT PRIMARY KEY, uname TEXT NOT NULL DEFAULT '',
      first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
      is_followed INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO room_state VALUES ('1', '80397', 1, 1785310737, '旧标题', 1800000000);
    INSERT INTO streamers (uid, uname, source, created_at, updated_at)
      VALUES ('1', '旧主播', 'manual', 1800000000, 1800000000);
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
  assert.equal(st.watch, true);
  assert.equal(st.notify, true);
  assert.equal(st.weiboNick, null);
  assert.equal(db.listFollows().find((f) => f.uid === '1')?.uname, '旧关注');
});

test('全新库直接建出 v2 push_rules + categories + verdicts', (t) => {
  let db: Db | undefined;
  const path = join(tmpdir_(t, () => db?.close()), 'new.db');
  db = new Db(path);
  for (const table of ['categories', 'verdicts', 'push_rules']) {
    const cols = columns(path, table);
    assert.ok(cols.length > 0, `${table} 表应存在`);
  }
  assert.ok(!columns(path, 'push_rules').includes('uid'), '新库 push_rules 无 uid 列');
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

// ---- 时间轴：live_sessions 新列 + live_segments + listTimeline ----

function session(over: Partial<Parameters<Db['recordSession']>[0]> = {}): Parameters<Db['recordSession']>[0] {
  return {
    roomId: 'r1', liveTime: 100, uid: '1', uname: '主播1', title: '打游戏',
    areaName: '网游', parentAreaName: '电子竞技', keyframe: 'k1.jpg', cover: 'c1.jpg',
    ...over,
  };
}

test('live_sessions 新列迁移幂等，live_segments 建表', (t) => {
  let db: Db | undefined;
  const path = join(tmpdir_(t, () => db?.close()), 'tl.db');
  db = new Db(path);
  for (const col of ['last_seen', 'keyframe', 'cover']) {
    assert.ok(columns(path, 'live_sessions').includes(col), `live_sessions 应补列 ${col}`);
  }
  assert.ok(columns(path, 'live_segments').length > 0, 'live_segments 应存在');
  db.close();
  db = new Db(path);
  assert.ok(columns(path, 'live_segments').length > 0, '二次打开幂等不报错');
});

test('recordSession 写开场快照并插首段；重复 recordSession 不重复开段', (t) => {
  let db: Db | undefined;
  let raw: Database.Database | undefined;
  const path = join(tmpdir_(t, () => { db?.close(); raw?.close(); }), 'tl.db');
  db = new Db(path);
  raw = new Database(path);
  const segs = () => raw!
    .prepare('SELECT * FROM live_segments WHERE room_id = ? ORDER BY start_ts, id')
    .all('r1') as Array<{ title: string; end_ts: number | null }>;

  db.recordSession(session());
  const s = raw
    .prepare('SELECT keyframe, cover, last_seen FROM live_sessions WHERE room_id = ?')
    .get('r1') as { keyframe: string; cover: string; last_seen: number | null };
  assert.equal(s.keyframe, 'k1.jpg', '开场快照入库');
  assert.equal(s.cover, 'c1.jpg');
  assert.equal(s.last_seen, null, '未打点前 last_seen 为空');
  assert.equal(segs().length, 1, '首个 segment');
  assert.equal(segs()[0]!.title, '打游戏');
  assert.equal(segs()[0]!.end_ts, null, '首段开口（进行中）');

  db.recordSession(session({ keyframe: undefined, cover: undefined }));
  assert.equal(segs().length, 1, '冲突无操作不重复开段');
});

test('touchLiveSessions：刷 last_seen；非空 keyframe 覆盖、空 keyframe 保留', (t) => {
  let db: Db | undefined;
  let raw: Database.Database | undefined;
  const path = join(tmpdir_(t, () => { db?.close(); raw?.close(); }), 'tl.db');
  db = new Db(path);
  raw = new Database(path);
  const row = () => raw!
    .prepare('SELECT last_seen, keyframe FROM live_sessions WHERE room_id = ?')
    .get('r1') as { last_seen: number | null; keyframe: string };

  db.recordSession(session());
  db.touchLiveSessions([{ roomId: 'r1', liveTime: 100, keyframe: 'k2.jpg' }]);
  assert.ok(row().last_seen !== null && row().last_seen! > 0, 'last_seen 刷新');
  assert.equal(row().keyframe, 'k2.jpg', '非空 keyframe 覆盖');

  db.touchLiveSessions([{ roomId: 'r1', liveTime: 100, keyframe: '' }]);
  assert.equal(row().keyframe, 'k2.jpg', '空 keyframe 不覆盖');
  db.touchLiveSessions([]);
});

test('endSession：关闭该房间最新一场（last_seen 取大、开口段收尾），未知房间无操作', (t) => {
  let db: Db | undefined;
  let raw: Database.Database | undefined;
  const path = join(tmpdir_(t, () => { db?.close(); raw?.close(); }), 'tl.db');
  db = new Db(path);
  raw = new Database(path);

  db.recordSession(session({ liveTime: 100 }));
  // 把第一场的时间回溯到小值，保证「最新一场」区分得开（recordSession 用秒级 now）
  raw.prepare('UPDATE live_sessions SET first_seen = 1000 WHERE live_time = 100').run();
  db.recordSession(session({ liveTime: 200, title: '第二场' }));

  db.endSession('r1', 9_999_999_999);
  const s100 = raw.prepare('SELECT last_seen FROM live_sessions WHERE live_time = 100').get() as { last_seen: number | null };
  assert.equal(s100.last_seen, null, '旧场次不被误关');
  const s200 = raw.prepare('SELECT last_seen FROM live_sessions WHERE live_time = 200').get() as { last_seen: number | null };
  assert.equal(s200.last_seen, 9_999_999_999, '最新一场被关闭');
  const open = raw
    .prepare('SELECT COUNT(*) AS c FROM live_segments WHERE live_time = 200 AND end_ts IS NULL')
    .get() as { c: number };
  assert.equal(open.c, 0, '开口段已收尾');

  db.endSession('r1', 1);
  const again = raw.prepare('SELECT last_seen FROM live_sessions WHERE live_time = 200').get() as { last_seen: number };
  assert.equal(again.last_seen, 9_999_999_999, 'last_seen 取大不回退');

  db.endSession('no-such-room', 123); // 无场次房间：静默无操作
});

test('rotateSegment：关闭开口段并开新段；场次不存在则不动', (t) => {
  let db: Db | undefined;
  let raw: Database.Database | undefined;
  const path = join(tmpdir_(t, () => { db?.close(); raw?.close(); }), 'tl.db');
  db = new Db(path);
  raw = new Database(path);

  db.recordSession(session());
  db.rotateSegment('r1', 100, 5000, {
    title: '唱歌', areaName: '虚拟Singer', parentAreaName: '虚拟主播', keyframe: 'k2.jpg',
  });
  const segs = raw
    .prepare('SELECT * FROM live_segments WHERE room_id = ? ORDER BY id')
    .all('r1') as Array<{ start_ts: number; end_ts: number | null; title: string; keyframe: string | null }>;
  assert.equal(segs.length, 2);
  assert.equal(segs[0]!.end_ts, 5000, '旧段以 ts 收尾');
  assert.deepEqual(
    [segs[1]!.start_ts, segs[1]!.end_ts, segs[1]!.title, segs[1]!.keyframe],
    [5000, null, '唱歌', 'k2.jpg'],
    '新段从 ts 开始、开口',
  );

  db.rotateSegment('r1', 999, 6000, { title: 'x', areaName: '', parentAreaName: '' });
  const orphan = raw.prepare('SELECT COUNT(*) AS c FROM live_segments WHERE live_time = 999').get() as { c: number };
  assert.equal(orphan.c, 0, '场次不存在不开孤儿段');
});

test('listTimeline：场次 + 段 + verdicts + 主播信息归并；旧场次无段回退单段', (t) => {
  let db: Db | undefined;
  let raw: Database.Database | undefined;
  const path = join(tmpdir_(t, () => { db?.close(); raw?.close(); }), 'tl.db');
  db = new Db(path);
  raw = new Database(path);
  db.upsertStreamer({ uid: '1', uname: '主播1', alias: '阿梓', face: 'f.jpg' });

  // 新场次：两段 + 一条分类判定
  db.recordSession(session());
  raw.prepare('UPDATE live_sessions SET first_seen = 1000, last_seen = 9000 WHERE live_time = 100').run();
  raw.prepare('UPDATE live_segments SET start_ts = 1000 WHERE live_time = 100').run();
  db.rotateSegment('r1', 100, 5000, { title: '唱歌', areaName: '虚拟Singer', parentAreaName: '虚拟主播' });
  db.insertVerdict({
    roomId: 'r1', liveTime: 100, uid: '1', categoryId: 1, categoryName: '歌回',
    source: 'llm', confidence: 0.9, evidence: '在唱歌',
  });
  // 旧场次：手工插入，无 segment（模拟 segments 表建立前归档的场次）
  raw.prepare(
    `INSERT INTO live_sessions (room_id, live_time, uid, uname, title, area_name, first_seen, notified_at, last_seen)
     VALUES ('r2', 50, '2', '主播2', '旧场', '网游', 2000, NULL, 8000)`,
  ).run();

  const entries = db.listTimeline(0, 2_000_000_000);
  assert.equal(entries.length, 2);
  const e1 = entries.find((e) => e.roomId === 'r1')!;
  assert.equal(e1.name, '阿梓', 'alias 优先于 uname');
  assert.equal(e1.face, 'f.jpg');
  assert.deepEqual([e1.startTs, e1.endTs], [1000, 9000]);
  assert.deepEqual([e1.keyframe, e1.cover], ['k1.jpg', 'c1.jpg']);
  assert.deepEqual(
    e1.segments.map((s) => [s.startTs, s.endTs, s.title, s.areaName]),
    [[1000, 5000, '打游戏', '网游'], [5000, 9000, '唱歌', '虚拟Singer']],
    '两段按 startTs 归并；last_seen 过鲜度窗口 = 已下播，开口段兜底关闭到场次终点',
  );
  assert.deepEqual(
    e1.verdicts.map((v) => [v.categoryName, v.source, v.confidence]),
    [['歌回', 'llm', 0.9]],
  );
  const e2 = entries.find((e) => e.roomId === 'r2')!;
  assert.equal(e2.name, '主播2', '不在监听名单用 uname');
  assert.deepEqual(
    e2.segments,
    [{ startTs: 2000, endTs: 8000, title: '旧场', areaName: '网游', parentAreaName: '' }],
    '无段旧场次回退为单段 [first_seen, last_seen]',
  );

  assert.equal(db.listTimeline(10000, 20000).length, 0, '范围外不返回');
});

test('listTimeline 在播判定：last_seen 新鲜 = endTs null（在播）；无打点 legacy 场 = 零长终点', (t) => {
  let db: Db | undefined;
  let raw: Database.Database | undefined;
  const path = join(tmpdir_(t, () => { db?.close(); raw?.close(); }), 'tl-live.db');
  db = new Db(path);
  raw = new Database(path);
  const nowS = Math.floor(Date.now() / 1000);

  // 在播场：last_seen 刚打点 → endTs null，开口段保持开口
  raw.prepare(
    `INSERT INTO live_sessions (room_id, live_time, uid, uname, title, area_name, first_seen, notified_at, last_seen)
     VALUES ('rl', 1, '1', '主播1', '在播', '网游', ?, NULL, ?)`,
  ).run(nowS - 3600, nowS - 10);
  raw.prepare(
    `INSERT INTO live_segments (room_id, live_time, start_ts, end_ts, title, created_at)
     VALUES ('rl', 1, ?, NULL, '在播', 1)`,
  ).run(nowS - 3600);
  // legacy 场：last_seen NULL → endTs = first_seen（零长，前端不画）
  raw.prepare(
    `INSERT INTO live_sessions (room_id, live_time, uid, uname, title, area_name, first_seen, notified_at, last_seen)
     VALUES ('ro', 2, '2', '主播2', '旧场', '网游', ?, NULL, NULL)`,
  ).run(nowS - 7200);

  const entries = db.listTimeline(0, nowS + 100);
  const live = entries.find((e) => e.roomId === 'rl')!;
  assert.equal(live.endTs, null, 'last_seen 新鲜 = 在播');
  assert.equal(live.segments[0]!.endTs, null, '在播场开口段保持开口');
  const legacy = entries.find((e) => e.roomId === 'ro')!;
  assert.equal(legacy.endTs, legacy.startTs, '无打点 legacy 场终点 = first_seen（零长）');
});
