/**
 * 时间表演示数据种子：直接写 data/dd-claw.db（better-sqlite3，不 import src）。
 * 幂等：先删（uid LIKE 'demo%' / name LIKE '演示%'）后插，重跑即重置。
 * 用法：node scripts/seed-timeline.mjs
 */
import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dbPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'dd-claw.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

const DAY = 86400;
/** 北京日界：日串 → 当天 06:00（UTC+8）的 ts */
const dayStart = (day) => Math.floor(Date.parse(day + 'T06:00:00+08:00') / 1000);
const now = () => Math.floor(Date.now() / 1000);
/** 北京今天（日串） */
const bjToday = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const addDays = (day, n) =>
  new Date(Date.parse(day + 'T12:00:00Z') + n * DAY * 1000).toISOString().slice(0, 10);

// ---- 幂等：先清演示数据 ----
const cleanup = db.transaction(() => {
  db.prepare(`DELETE FROM streamers WHERE uid LIKE 'demo%'`).run();
  db.prepare(`DELETE FROM live_sessions WHERE uid LIKE 'demo%'`).run();
  db.prepare(`DELETE FROM live_segments WHERE room_id LIKE 'demo%'`).run();
  db.prepare(`DELETE FROM verdicts WHERE uid LIKE 'demo%'`).run();
  db.prepare(`DELETE FROM categories WHERE name LIKE '演示%'`).run();
});

// ---- 写入 ----
const seed = db.transaction(() => {
  const t = now();

  const streamers = [
    { uid: 'demo1001', uname: '演示·阿梓', roomId: 'demo-r1' },
    { uid: 'demo1002', uname: '演示·七海', roomId: 'demo-r2' },
    { uid: 'demo1003', uname: '演示·小可', roomId: 'demo-r3' },
  ];
  const insStreamer = db.prepare(
    `INSERT INTO streamers (uid, uname, alias, room_id, watch, analyze, notify, source, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 1, 1, 1, 'manual', ?, ?)`,
  );
  for (const s of streamers) insStreamer.run(s.uid, s.uname, s.roomId, t, t);

  const { m } = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS m FROM categories').get();
  const insCategory = db.prepare(
    `INSERT INTO categories (name, llm_prompt, keywords, areas, cond_mode, enabled, sort, created_at, updated_at)
     VALUES (?, NULL, ?, '[]', 'and', 1, ?, ?, ?)`,
  );
  const catSong = Number(insCategory.run('演示·歌回', '["歌"]', m, t, t).lastInsertRowid);
  const catChat = Number(insCategory.run('演示·杂谈', '["杂谈"]', m + 1, t, t).lastInsertRowid);

  const insSession = db.prepare(
    `INSERT INTO live_sessions
       (room_id, live_time, uid, uname, title, area_name, keyframe, cover, first_seen, notified_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
  );
  const insSegment = db.prepare(
    `INSERT INTO live_segments
       (room_id, live_time, start_ts, end_ts, title, area_name, parent_area_name, keyframe, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  );
  const insVerdict = db.prepare(
    `INSERT OR IGNORE INTO verdicts
       (subject_type, subject_id, uid, category_id, rule_id, category_name, source, pass, confidence, evidence, created_at)
     VALUES ('live', ?, ?, ?, 0, ?, ?, 1, ?, ?, ?)`,
  );

  const today = bjToday();
  const d0 = dayStart(addDays(today, -2)); // 前天日界
  const d1 = dayStart(addDays(today, -1)); // 昨天日界
  const d2 = dayStart(today);              // 今天日界
  // 今天的场次锚定当前时间并夹进今天日界窗口（凌晨运行时滑进窗口内即可）
  const clampToday = (ts) => Math.min(Math.max(ts, d2 + 600), d2 + DAY - 600);

  let liveTime = 9_000_001;
  /** 一场：segments = [[startOffsetSec, endOffsetSec|null, title, areaName, parentArea], ...]，start 为绝对 ts */
  function addSession(uid, roomId, title, area, parent, start, end, segs, verdict) {
    insSession.run(roomId, liveTime, uid, streamers.find((s) => s.uid === uid).uname,
      title, area, start, start, end);
    for (const [s0, e0, st, sa, sp] of segs) insSegment.run(roomId, liveTime, s0, e0, st, sa, sp, t);
    if (verdict) {
      insVerdict.run(roomId + ':' + liveTime, uid,
        verdict.source === 'llm' ? catSong : catChat,
        verdict.source === 'llm' ? '演示·歌回' : '演示·杂谈',
        verdict.source, verdict.confidence, verdict.evidence, t);
    }
    liveTime++;
  }

  // 前天下午：杂谈（rule 判定）
  addSession('demo1001', 'demo-r1', '下午杂谈', '虚拟主播', '虚拟主播', d0 + 8 * 3600, d0 + 11 * 3600, [
    [d0 + 8 * 3600, d0 + 11 * 3600, '下午杂谈', '虚拟主播', '虚拟主播'],
  ], { source: 'rule', confidence: null, evidence: '命中关键词「杂谈」' });

  // 前天跨午夜：歌回带一次标题变更（llm 判定）
  addSession('demo1002', 'demo-r2', '深夜歌回', '虚拟Singer', '虚拟主播', d0 + 16 * 3600, d0 + 86400 + 1.5 * 3600, [
    [d0 + 16 * 3600, d0 + 17.5 * 3600, '深夜歌回', '虚拟Singer', '虚拟主播'],
    [d0 + 17.5 * 3600, d0 + 86400 + 1.5 * 3600, '继续唱到半夜', '虚拟Singer', '虚拟主播'],
  ], { source: 'llm', confidence: 0.92, evidence: '画面显示主播持麦演唱，弹幕大量打 call' });

  // 昨天凌晨跨 6 点：通宵场（今天 03:00 开播、08:00 下播，跨今天 06:00 日界，归昨天）
  addSession('demo1003', 'demo-r3', '通宵打块', '网游', '电子竞技', d2 - 3 * 3600, d2 + 2 * 3600, [
    [d2 - 3 * 3600, d2 + 2 * 3600, '通宵打块', '网游', '电子竞技'],
  ], null);

  // 昨天晚间：歌回 → 聊天（两段，llm 判定歌回）
  addSession('demo1001', 'demo-r1', '晚间歌回', '虚拟Singer', '虚拟主播', d1 + 14 * 3600, d1 + 16.5 * 3600, [
    [d1 + 14 * 3600, d1 + 15 * 3600, '晚间歌回', '虚拟Singer', '虚拟主播'],
    [d1 + 15 * 3600, d1 + 16.5 * 3600, '唱完聊天', '虚拟主播', '虚拟主播'],
  ], { source: 'llm', confidence: 0.87, evidence: '前半场以歌曲演唱为主，后半场转为杂谈' });

  // 今天午间：杂谈（rule 判定）
  const s5a = clampToday(now() - 5 * 3600);
  addSession('demo1002', 'demo-r2', '午间杂谈', '虚拟主播', '虚拟主播', s5a, s5a + 1.5 * 3600, [
    [s5a, s5a + 1.5 * 3600, '午间杂谈', '虚拟主播', '虚拟主播'],
  ], { source: 'rule', confidence: null, evidence: '命中关键词「杂谈」' });

  // 今天：在播场（进行中，end_ts NULL，last_seen = 现在），带一次内容变更
  const s6a = clampToday(now() - 5400);
  const s6mid = Math.min(s6a + 2700, now() - 60);
  addSession('demo1001', 'demo-r1', '夜间直播', '虚拟主播', '虚拟主播', s6a, null, [
    [s6a, s6mid, '夜间直播', '虚拟主播', '虚拟主播'],
    [s6mid, null, '游戏时间', '网游', '电子竞技'],
  ], null);
});

cleanup();
seed();

const { c } = db.prepare(`SELECT COUNT(*) AS c FROM live_sessions WHERE uid LIKE 'demo%'`).get();
const { c: segCount } = db.prepare(`SELECT COUNT(*) AS c FROM live_segments WHERE room_id LIKE 'demo%'`).get();
console.log(`已写入演示数据：3 个主播 / 2 个分类 / ${c} 场直播 / ${segCount} 个 segments（含跨午夜、跨 6 点、在播场）`);
console.log('清除方法：重跑 node scripts/seed-timeline.mjs（先清后插，幂等），或手动 DELETE：');
console.log(`  DELETE FROM streamers WHERE uid LIKE 'demo%';`);
console.log(`  DELETE FROM live_sessions WHERE uid LIKE 'demo%';`);
console.log(`  DELETE FROM live_segments WHERE room_id LIKE 'demo%';`);
console.log(`  DELETE FROM verdicts WHERE uid LIKE 'demo%';`);
console.log(`  DELETE FROM categories WHERE name LIKE '演示%';`);
db.close();
