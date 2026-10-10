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

test('全新库直接建出 v2 push_rules + categories + verdicts（身份键版）', (t) => {
  let db: Db | undefined;
  const path = join(tmpdir_(t, () => db?.close()), 'new.db');
  db = new Db(path);
  for (const table of ['categories', 'verdicts', 'push_rules']) {
    const cols = columns(path, table);
    assert.ok(cols.length > 0, `${table} 表应存在`);
  }
  assert.ok(!columns(path, 'push_rules').includes('uid'), '新库 push_rules 无 uid 列');
  const vcols = columns(path, 'verdicts');
  for (const col of ['subject_type', 'subject_id', 'rule_id', 'pass']) {
    assert.ok(vcols.includes(col), `verdicts 应有身份键列 ${col}`);
  }
  assert.ok(!vcols.includes('room_id') && !vcols.includes('live_time'), '新库 verdicts 无 room_id/live_time 列');
});

/** 手工建一个「旧身份键」的 verdicts 表：(room_id, live_time, category_id) 唯一 */
function makeOldVerdictsDb(path: string): void {
  const raw = new Database(path);
  raw.exec(`
    CREATE TABLE verdicts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id       TEXT    NOT NULL,
      live_time     INTEGER NOT NULL,
      uid           TEXT    NOT NULL,
      category_id   INTEGER NOT NULL,
      category_name TEXT    NOT NULL,
      source        TEXT    NOT NULL CHECK(source IN ('llm','rule')),
      confidence    REAL,
      evidence      TEXT    NOT NULL DEFAULT '',
      created_at    INTEGER NOT NULL,
      UNIQUE(room_id, live_time, category_id)
    );
    INSERT INTO verdicts (room_id, live_time, uid, category_id, category_name, source, confidence, evidence, created_at)
      VALUES ('80397', 1785310737, '1', 3, '歌回', 'llm', 0.9, '在唱歌', 1800000000),
             ('80397', 1785310737, '1', 4, '杂谈', 'rule', NULL, '关键词「杂谈」', 1800000001),
             ('80397', 99, '2', 3, '歌回', 'rule', NULL, '关键词「歌」', 1800000002);
  `);
  raw.close();
}

test('verdicts 身份键迁移：老行搬迁成 subject_type=live / subject_id=room_id:live_time，id 保留', (t) => {
  let db: Db | undefined;
  let raw: Database.Database | undefined;
  const path = join(tmpdir_(t, () => { db?.close(); raw?.close(); }), 'vmig.db');
  makeOldVerdictsDb(path);
  db = new Db(path);
  raw = new Database(path);

  const vcols = columns(path, 'verdicts');
  for (const col of ['subject_type', 'subject_id', 'rule_id', 'pass']) {
    assert.ok(vcols.includes(col), `重建后应有 ${col}`);
  }
  assert.ok(!vcols.includes('room_id') && !vcols.includes('live_time'), '重建后无 room_id/live_time 列');

  const rows = raw.prepare('SELECT * FROM verdicts ORDER BY id').all() as Array<{
    id: number; subject_type: string; subject_id: string; uid: string;
    category_id: number; rule_id: number; category_name: string;
    source: string; pass: number; confidence: number | null;
  }>;
  assert.equal(rows.length, 3, '三行老判定全部搬迁');
  assert.deepEqual(
    rows.map((r) => [r.id, r.subject_type, r.subject_id, r.category_id, r.rule_id, r.pass]),
    [
      [1, 'live', '80397:1785310737', 3, 0, 1],
      [2, 'live', '80397:1785310737', 4, 0, 1],
      [3, 'live', '80397:99', 3, 0, 1],
    ],
    'subject_id 拼 room_id:live_time；rule_id 取 0 哨兵、pass 取 1；id 原样保留',
  );
  assert.equal(rows[0]!.confidence, 0.9);
  assert.equal(rows[1]!.confidence, null, 'rule 路径 NULL 置信度原样保留');

  assert.equal(db.listVerdicts('live', '80397:1785310737').length, 2);
  assert.equal(db.listVerdicts('live', '80397:99').length, 1);
  // 迁移后的新键去重照常：同分类同哨兵 rule_id=0 重复插不进，换 rule_id 另占一行
  db.insertVerdict({
    subjectType: 'live', subjectId: '80397:1785310737', uid: '1',
    categoryId: 3, ruleId: 0, categoryName: '歌回', source: 'rule', evidence: '重复',
  });
  db.insertVerdict({
    subjectType: 'live', subjectId: '80397:1785310737', uid: '1',
    categoryId: 3, ruleId: 5, categoryName: '歌回', source: 'rule', evidence: '规则级',
  });
  assert.equal(db.listVerdicts('live', '80397:1785310737').length, 3);
});

test('verdicts 身份键迁移：幂等重跑不搬两次；空老表 / 无老表也安全', (t) => {
  let db: Db | undefined;
  const path = join(tmpdir_(t, () => db?.close()), 'vmig2.db');
  makeOldVerdictsDb(path);
  db = new Db(path);
  db.close();
  db = new Db(path); // 幂等重跑：room_id 列已消失，跳过

  assert.equal(db.listVerdicts('live', '80397:1785310737').length, 2, '重跑不搬两次');
  assert.equal(db.listVerdicts('live', '80397:99').length, 1);

  // 空老表：重建后仍是空表，后续插入正常
  db.close();
  const raw = new Database(path);
  raw.exec(`DROP TABLE verdicts; CREATE TABLE verdicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, live_time INTEGER NOT NULL,
    uid TEXT NOT NULL, category_id INTEGER NOT NULL, category_name TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('llm','rule')), confidence REAL,
    evidence TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
    UNIQUE(room_id, live_time, category_id))`);
  raw.close();
  db = new Db(path);
  assert.equal(db.listVerdicts('live', 'x:1').length, 0, '空老表迁移后仍为空');
  db.insertVerdict({
    subjectType: 'post', subjectId: 'twitter:1', uid: 'u',
    categoryId: 0, ruleId: 7, categoryName: '图文规则', source: 'decision', pass: false,
    confidence: 0.5, evidence: '决策模型判否',
  });
  assert.equal(db.listVerdicts('post', 'twitter:1').length, 1, '迁移后新键插入正常');
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
    subjectType: 'live', subjectId: 'r1:100', uid: '1', categoryId: 1, ruleId: 0,
    categoryName: '歌回', source: 'llm', confidence: 0.9, evidence: '在唱歌',
  });
  // pass=0（判定不通过）不进时间线
  db.insertVerdict({
    subjectType: 'live', subjectId: 'r1:100', uid: '1', categoryId: 2, ruleId: 0,
    categoryName: '游戏', source: 'llm', confidence: 0.3, evidence: '不像游戏', pass: false,
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

test('nearestSnapshot：取距 ts 最近一帧；无缓存 null', (t) => {
  const db = new Db(':memory:');
  t.after(() => db.close());

  assert.equal(db.nearestSnapshot('r1', 100, 5000), null, '空表 null');

  db.insertSnapshot({ roomId: 'r1', liveTime: 100, ts: 1000, path: '/kf/r1/100/1000.jpg', bytes: 10 });
  db.insertSnapshot({ roomId: 'r1', liveTime: 100, ts: 2000, path: '/kf/r1/100/2000.jpg', bytes: 10 });
  db.insertSnapshot({ roomId: 'r1', liveTime: 200, ts: 1500, path: '/kf/r1/200/1500.jpg', bytes: 10 }); // 另一场

  assert.equal(db.nearestSnapshot('r1', 100, 1100)!.path, '/kf/r1/100/1000.jpg', '靠近第一帧');
  assert.equal(db.nearestSnapshot('r1', 100, 1800)!.path, '/kf/r1/100/2000.jpg', '靠近第二帧');
  assert.equal(db.nearestSnapshot('r1', 200, 1400)!.path, '/kf/r1/200/1500.jpg', '按场次隔离');
  assert.equal(db.nearestSnapshot('rX', 100, 1100), null, '别的房间 null');
});

// ---- weibo_accounts：微博独立名单（含从 streamers.weibo_uid 的一次性数据搬家）----

const LEGACY_SCHEMA = `
  CREATE TABLE streamers (
    uid TEXT PRIMARY KEY, uname TEXT NOT NULL DEFAULT '', alias TEXT,
    room_id TEXT, weibo_uid TEXT, weibo_nick TEXT,
    watch INTEGER NOT NULL DEFAULT 1, analyze INTEGER NOT NULL DEFAULT 0,
    notify INTEGER NOT NULL DEFAULT 1, profile_note TEXT,
    source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('follows','manual')),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL, uid TEXT NOT NULL,
    item_id TEXT NOT NULL, type TEXT NOT NULL, text TEXT, pics TEXT NOT NULL DEFAULT '[]',
    pub_ts INTEGER NOT NULL, url TEXT, raw TEXT, created_at INTEGER NOT NULL,
    UNIQUE(platform, item_id)
  );
`;

test('微博迁移：weibo_uid 种入独立名单 + 历史微博帖归属由 B站 uid 改写成微博 uid', (t) => {
  let db: Db | undefined;
  const path = join(tmpdir_(t, () => db?.close()), 'legacy-weibo.db');
  const raw = new Database(path);
  raw.exec(LEGACY_SCHEMA);
  raw.exec(`
    INSERT INTO streamers (uid, uname, weibo_uid, weibo_nick, watch, created_at, updated_at)
      VALUES ('1', '阿梓', '2203177060', '阿梓从小就很可爱', 1, 1800000000, 1800000000);
    INSERT INTO streamers (uid, uname, weibo_uid, watch, created_at, updated_at)
      VALUES ('2', '没微博的', NULL, 1, 1800000000, 1800000000);
    INSERT INTO streamers (uid, uname, weibo_uid, watch, created_at, updated_at)
      VALUES ('3', '停用的', '991122', 0, 1800000000, 1800000000);
    INSERT INTO posts (platform, uid, item_id, type, text, pics, pub_ts, url, raw, created_at)
      VALUES ('weibo', '1', '5001', 'mblog', '今晚九点直播！', '[]', 1789549200, 'u', NULL, 1800000000);
    INSERT INTO posts (platform, uid, item_id, type, text, pics, pub_ts, url, raw, created_at)
      VALUES ('bili_dynamic', '1', 'd1', 'DYNAMIC_TYPE_WORD', 'B站动态', '[]', 1789549100, 'u', NULL, 1800000000);
  `);
  raw.close();

  db = new Db(path);
  const accs = db.listWeiboAccounts();
  assert.equal(accs.length, 2, '两个绑了微博的主播各得一行');
  const a1 = accs.find((a) => a.uid === '2203177060')!;
  assert.equal(a1.nickname, '阿梓从小就很可爱');
  assert.equal(a1.biliUid, '1', '关联回原主播');
  assert.equal(a1.enabled, true, 'watch=1 → 启用');
  assert.equal(accs.find((a) => a.uid === '991122')!.enabled, false, 'watch=0 → 停用（不再抓）');

  // 历史微博帖的 uid 改写成微博 uid；B站动态纹丝不动
  assert.equal(db.listRecentPosts(['2203177060'], 5).get('2203177060')!.length, 1);
  const biliOnly = db.listRecentPosts(['1'], 5).get('1')!;
  assert.equal(biliOnly.length, 1, 'B站 uid 下只剩动态');
  assert.equal(biliOnly[0]!.platform, 'bili_dynamic');

  // 幂等：再开一次不重复种、不再改写（闸门 + UNIQUE(uid) 双保险）
  db.close();
  db = new Db(path);
  assert.equal(db.listWeiboAccounts().length, 2);
  assert.equal(db.listRecentPosts(['2203177060'], 5).get('2203177060')!.length, 1);
});

test('dropLiveRcmdPosts：开播动态（LIVE_RCMD）一次性清理，其余动态不动，幂等', (t) => {
  let db: Db | undefined;
  const path = join(tmpdir_(t, () => db?.close()), 'live-rcmd.db');
  db = new Db(path);
  db.insertPosts([
    { platform: 'bili_dynamic', uid: '1', itemId: 'r1', type: 'DYNAMIC_TYPE_LIVE_RCMD', text: '开播', pics: [], pubTs: 100, url: null, raw: null },
    { platform: 'bili_dynamic', uid: '1', itemId: 'r2', type: 'DYNAMIC_TYPE_LIVE_RCMD', text: '又开播', pics: [], pubTs: 200, url: null, raw: null },
    { platform: 'bili_dynamic', uid: '1', itemId: 'w1', type: 'DYNAMIC_TYPE_WORD', text: '正常动态', pics: [], pubTs: 300, url: null, raw: null },
    { platform: 'bili_dynamic', uid: '1', itemId: 'f1', type: 'DYNAMIC_TYPE_FORWARD', text: '旧转发', pics: [], pubTs: 400, url: null, raw: null },
    { platform: 'weibo', uid: '2', itemId: 'm1', type: 'mblog', text: '微博不受影响', pics: [], pubTs: 500, url: null, raw: null },
  ]);
  // 拨回「未迁移」状态再重开，模拟带 LIVE_RCMD 存量的旧库（构造器里跑迁移）
  db.deleteSetting('migrated_drop_live_rcmd_posts_v1');
  db.close();

  db = new Db(path);
  const types = db.searchPosts({ platform: 'bili_dynamic', limit: 50 }).map((p) => p.type);
  assert.deepEqual([...new Set(types)].sort(), ['DYNAMIC_TYPE_FORWARD', 'DYNAMIC_TYPE_WORD'],
    'LIVE_RCMD 已清，WORD/FORWARD 保留');
  assert.equal(db.searchPosts({ platform: 'weibo' }).length, 1, '微博帖不受影响');
  db.close();

  db = new Db(path);
  assert.equal(db.searchPosts({ platform: 'bili_dynamic' }).length, 2, '再开一次不重复删（闸门幂等）');
});

test('weibo_accounts CRUD：uid 唯一、抓取回写只动传入字段、解关联保留行', (t) => {
  const db = new Db(':memory:');
  t.after(() => db.close());

  const id = db.upsertWeiboAccount({ uid: '2203177060', nickname: '渡瀬結月', biliUid: '1', enabled: true });
  assert.equal(db.getWeiboAccountByUid('2203177060')!.id, id);
  assert.equal(db.getWeiboAccount(id)!.nickname, '渡瀬結月');

  db.touchWeiboAccount(id, { lastPostId: '5001', lastPostAt: 1789549200, lastOkAt: 1800000000, avatar: 'a.jpg' });
  const after = db.getWeiboAccount(id)!;
  assert.equal(after.lastPostId, '5001');
  assert.equal(after.lastPostAt, 1789549200);
  assert.equal(after.lastOkAt, 1800000000);
  assert.equal(after.avatar, 'a.jpg');
  assert.equal(after.nickname, '渡瀬結月', 'touch 不碰没传的字段');

  // 空昵称不回写（抓到空值不该把好昵称擦掉）
  db.touchWeiboAccount(id, { nickname: null });
  assert.equal(db.getWeiboAccount(id)!.nickname, '渡瀬結月');

  db.upsertWeiboAccount({ id, enabled: false });
  assert.equal(db.getWeiboAccount(id)!.enabled, false);
  assert.equal(db.getWeiboAccount(id)!.uid, '2203177060', '未传 uid 保留原值');

  assert.equal(db.unlinkWeiboAccountsFromBili('1'), 1);
  assert.equal(db.getWeiboAccount(id)!.biliUid, null);
  assert.ok(db.getWeiboAccount(id), '解关联不删行（历史微博还在）');

  assert.equal(db.deleteWeiboAccount(id), true);
  assert.equal(db.deleteWeiboAccount(id), false);
});

test('listRecentPostsMixed：主播卡第三栏按「关联主播」反查混排微博与动态；未关联的不串台', (t) => {
  const db = new Db(':memory:');
  t.after(() => db.close());

  // 主播 1 关联微博 2203；微博 9999 未关联任何主播
  db.upsertWeiboAccount({ uid: '2203177060', nickname: '渡瀬結月', biliUid: '1', enabled: true });
  db.upsertWeiboAccount({ uid: '9999', nickname: '独立博主', biliUid: null, enabled: true });
  db.insertPosts([
    { platform: 'bili_dynamic', uid: '1', itemId: 'd1', type: 'WORD', text: '动态', pics: [], pubTs: 100, url: null, raw: null },
    { platform: 'weibo', uid: '2203177060', itemId: 'w1', type: 'mblog', text: '微博', pics: [], pubTs: 200, url: null, raw: null },
    { platform: 'weibo', uid: '9999', itemId: 'w2', type: 'mblog', text: '别人的微博', pics: [], pubTs: 300, url: null, raw: null },
  ]);

  const mixed = db.listRecentPostsMixed(['1'], 5).get('1')!;
  assert.deepEqual(mixed.map((p) => p.text), ['微博', '动态'], '按时间倒序混排，未关联的微博不进卡');
  assert.equal(mixed.length, 2);

  // perUid 截断在两路混合之后做
  assert.equal(db.listRecentPostsMixed(['1'], 1).get('1')!.length, 1);
  assert.equal(db.listRecentPostsMixed([], 5).size, 0, '空名单不查库');
});

// ---- 图文帖规则生效范围迁移：post_rules.account_ids → 账号侧 rule_ids ----

/** 迁移前的旧 schema：三张表都没有 rule_ids 列（post_rules 还带着 account_ids） */
const PRE_SCOPE_SCHEMA = `
  CREATE TABLE post_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL DEFAULT '',
    platform TEXT NOT NULL DEFAULT 'twitter', account_ids TEXT NOT NULL DEFAULT '[]',
    channels TEXT NOT NULL DEFAULT '[]', filters TEXT NOT NULL DEFAULT '{}',
    message_template TEXT, llm_judge INTEGER NOT NULL DEFAULT 0, judge_prompt TEXT,
    llm_translate INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE x_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, screen_name TEXT NOT NULL UNIQUE,
    nickname TEXT, display_name TEXT, bili_uid TEXT, enabled INTEGER NOT NULL DEFAULT 1,
    last_tweet_id TEXT, last_tweet_at INTEGER, last_ok_at INTEGER, avatar TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE weibo_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL UNIQUE,
    nickname TEXT, display_name TEXT, bili_uid TEXT, enabled INTEGER NOT NULL DEFAULT 1,
    last_post_id TEXT, last_post_at INTEGER, last_ok_at INTEGER, avatar TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
`;

test('规则生效范围迁移：account_ids 非空按名单搬、空 = 该平台全部账号；幂等', (t) => {
  let db: Db | undefined;
  const path = join(tmpdir_(t, () => db?.close()), 'scope.db');
  const raw = new Database(path);
  raw.exec(PRE_SCOPE_SCHEMA);
  raw.exec(`
    INSERT INTO x_accounts (screen_name, enabled, created_at, updated_at)
      VALUES ('aaa', 1, 0, 0), ('bbb', 1, 0, 0);
    INSERT INTO weibo_accounts (uid, enabled, created_at, updated_at) VALUES ('w1', 1, 0, 0);
    INSERT INTO post_rules (name, platform, account_ids, created_at, updated_at) VALUES
      ('r1', 'twitter', '[1]', 0, 0),
      ('r2', 'twitter', '[]', 0, 0),
      ('r3', 'weibo', '[1]', 0, 0),
      ('r4', 'bili_dynamic', '[]', 0, 0);
  `);
  raw.close();

  db = new Db(path);
  // 旧库在线补列
  assert.ok(columns(path, 'x_accounts').includes('rule_ids'));
  assert.ok(columns(path, 'weibo_accounts').includes('rule_ids'));
  const xs = db.listXAccounts();
  assert.deepEqual(xs.find((a) => a.screenName === 'aaa')!.ruleIds, [1, 2], '指定账号 1 + 空范围规则 2');
  assert.deepEqual(xs.find((a) => a.screenName === 'bbb')!.ruleIds, [2], '只中「全部账号」的规则 2');
  assert.deepEqual(db.listWeiboAccounts()[0]!.ruleIds, [3]);
  // bili_dynamic 无旧数据，不参与搬家（也没有 bili_accounts 行可写）
  assert.equal(db.listBiliAccounts().length, 0);

  // 幂等：重开不重复追加（闸门 + includes 去重双保险）
  db.close();
  db = new Db(path);
  assert.deepEqual(db.listXAccounts().find((a) => a.screenName === 'aaa')!.ruleIds, [1, 2]);
  assert.deepEqual(db.listWeiboAccounts()[0]!.ruleIds, [3]);
});

test('upsertPostRule 写入侧恒写空 account_ids、不写 platform（两列都是遗留列，保留不删）', (t) => {
  const db = new Db(':memory:');
  t.after(() => db.close());
  const raw = (db as unknown as { db: Database.Database }).db;

  const id = db.upsertPostRule({ channels: [1] });
  const row = raw.prepare('SELECT account_ids, platform FROM post_rules WHERE id = ?').get(id) as {
    account_ids: string; platform: string;
  };
  assert.equal(row.account_ids, '[]');
  assert.equal(row.platform, 'twitter', 'platform 列靠默认值占位，写入侧不再触碰');
  db.upsertPostRule({ id, name: '改名' });
  assert.equal(
    (raw.prepare('SELECT account_ids FROM post_rules WHERE id = ?').get(id) as { account_ids: string }).account_ids,
    '[]',
    '改行也恒写空',
  );
  assert.ok(!('accountIds' in db.listPostRules()[0]!), '规则对象不再有 accountIds');
  assert.ok(!('platform' in db.listPostRules()[0]!), '规则对象不再有 platform');
});

test('x/weibo 账号的 ruleIds：upsert 给了才更新，读出解析 JSON', (t) => {
  const db = new Db(':memory:');
  t.after(() => db.close());

  const xId = db.upsertXAccount({ screenName: 'aaa', ruleIds: [1, 2] });
  assert.deepEqual(db.getXAccount(xId)!.ruleIds, [1, 2]);
  db.upsertXAccount({ id: xId, displayName: '改名' });
  assert.deepEqual(db.getXAccount(xId)!.ruleIds, [1, 2], '未传 ruleIds 保留原值');
  db.upsertXAccount({ id: xId, ruleIds: [] });
  assert.deepEqual(db.getXAccount(xId)!.ruleIds, [], '显式传空 = 清空');

  const wId = db.upsertWeiboAccount({ uid: '2203177060' });
  assert.deepEqual(db.getWeiboAccount(wId)!.ruleIds, [], '默认空');
  db.upsertWeiboAccount({ id: wId, ruleIds: [3] });
  assert.deepEqual(db.getWeiboAccount(wId)!.ruleIds, [3]);
});

test('touchXAccount：昵称拿到非空才回写（X 的平台显示名，同 weibo nickname 纪律）', (t) => {
  const db = new Db(':memory:');
  t.after(() => db.close());

  const id = db.upsertXAccount({ screenName: 'watase_yuzuki', displayName: null, biliUid: null, enabled: true });
  db.touchXAccount(id, { lastOkAt: 1800000000, nickname: '渡瀬 結月' });
  assert.equal(db.getXAccount(id)!.nickname, '渡瀬 結月', '非空昵称回写');

  db.touchXAccount(id, { nickname: null });
  assert.equal(db.getXAccount(id)!.nickname, '渡瀬 結月', '空昵称不擦好名字');

  db.touchXAccount(id, { nickname: '改名了' });
  assert.equal(db.getXAccount(id)!.nickname, '改名了', '拿到新名就更新（昵称会改）');
});

// ---- bili_accounts：B站动态独立账号名单 ----

test('bili_accounts CRUD：uid 唯一、upsert 保留未传字段、touch 只动传入字段', (t) => {
  const db = new Db(':memory:');
  t.after(() => db.close());

  // uname 是平台事实（抓取回写）：upsert 输入面不收，测试里用 touch 模拟抓取种入
  const id = db.upsertBiliAccount({ uid: '80397', ruleIds: [1] });
  db.touchBiliAccount(id, { uname: '阿梓从小就很可爱' });
  assert.equal(db.getBiliAccountByUid('80397')!.id, id);
  assert.deepEqual(db.getBiliAccount(id)!.ruleIds, [1]);
  assert.equal(db.getBiliAccount(id)!.enabled, true, '默认启用');
  assert.equal(db.getBiliAccount(id)!.uname, '阿梓从小就很可爱', 'touch 能种入 uname');

  db.touchBiliAccount(id, { lastOkAt: 1800000000, avatar: 'a.jpg' });
  const after = db.getBiliAccount(id)!;
  assert.equal(after.lastOkAt, 1800000000);
  assert.equal(after.avatar, 'a.jpg');
  assert.equal(after.uname, '阿梓从小就很可爱', 'touch 不碰没传的字段');

  // 空用户名不回写（抓到空值不该把好名字擦掉）
  db.touchBiliAccount(id, { uname: null });
  assert.equal(db.getBiliAccount(id)!.uname, '阿梓从小就很可爱');

  db.upsertBiliAccount({ id, enabled: false, ruleIds: [1, 2] });
  const edited = db.getBiliAccount(id)!;
  assert.equal(edited.enabled, false);
  assert.deepEqual(edited.ruleIds, [1, 2]);
  assert.equal(edited.uid, '80397', '未传 uid 保留原值');

  assert.deepEqual(db.listBiliAccounts().map((a) => a.uid), ['80397']);
  assert.equal(db.listBiliAccounts(true).length, 0, 'onlyEnabled 过滤停用账号');

  assert.equal(db.deleteBiliAccount(id), true);
  assert.equal(db.deleteBiliAccount(id), false);
});


test('silent_next（主动关闭恢复位）：重新启用置位、编辑不停位、touch 清位、批量置位只动启用行', (t) => {
  const db = new Db(':memory:');
  t.after(() => db.close());

  const x = db.upsertXAccount({ screenName: 'a', displayName: null, biliUid: null, enabled: true });
  assert.equal(db.getXAccount(x)!.silentNext, false, '新账号新列默认 0');

  db.upsertXAccount({ id: x, enabled: false });
  assert.equal(db.getXAccount(x)!.silentNext, false, '停用本身不置位（置位在重新启用那一刻）');

  db.upsertXAccount({ id: x, enabled: true });
  assert.equal(db.getXAccount(x)!.silentNext, true, '重新启用 = 主动暂停结束 → 下轮静默');

  db.upsertXAccount({ id: x, displayName: '备注' });
  assert.equal(db.getXAccount(x)!.silentNext, true, '置位期间编辑别的字段不丢位');

  db.touchXAccount(x, { lastOkAt: 123, silentNext: false });
  assert.equal(db.getXAccount(x)!.silentNext, false, '源消费后清位');

  const w = db.upsertWeiboAccount({ uid: '100', nickname: null, biliUid: null, enabled: true });
  db.upsertWeiboAccount({ id: w, enabled: false });
  db.upsertWeiboAccount({ id: w, enabled: true });
  assert.equal(db.getWeiboAccount(w)!.silentNext, true, '微博同一语义');
  db.touchWeiboAccount(w, { lastOkAt: 1, silentNext: false });
  assert.equal(db.getWeiboAccount(w)!.silentNext, false);

  const b = db.upsertBiliAccount({ uid: '80397' });
  db.upsertBiliAccount({ id: b, enabled: false });
  db.upsertBiliAccount({ id: b, enabled: true });
  assert.equal(db.getBiliAccount(b)!.silentNext, true, 'B站名单同一语义');
  db.touchBiliAccount(b, { lastOkAt: 1, silentNext: false });
  assert.equal(db.getBiliAccount(b)!.silentNext, false);

  // 批量置位（图文开关手动重开用）：只动启用行
  db.upsertXAccount({ id: x, enabled: false });
  const x2 = db.upsertXAccount({ screenName: 'b', displayName: null, biliUid: null, enabled: true });
  db.markXAccountsSilentNext();
  assert.equal(db.getXAccount(x2)!.silentNext, true, '启用行置位');
  assert.equal(db.getXAccount(x)!.silentNext, false, '停用行不动');

  const w2 = db.upsertWeiboAccount({ uid: '200', nickname: null, biliUid: null, enabled: true });
  db.markWeiboAccountsSilentNext();
  assert.equal(db.getWeiboAccount(w2)!.silentNext, true);
  const b2 = db.upsertBiliAccount({ uid: '2' });
  db.markBiliAccountsSilentNext();
  assert.equal(db.getBiliAccount(b2)!.silentNext, true);
});
