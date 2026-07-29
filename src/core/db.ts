import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { makeLogger } from '../logger.js';
import type { PrevState } from './state.js';

const log = makeLogger('core/db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS live_sessions (
  room_id     TEXT    NOT NULL,
  live_time   INTEGER NOT NULL,
  uid         TEXT    NOT NULL,
  uname       TEXT,
  title       TEXT,
  area_name   TEXT,
  first_seen  INTEGER NOT NULL,
  notified_at INTEGER,
  PRIMARY KEY (room_id, live_time)
);
CREATE TABLE IF NOT EXISTS notify_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id   TEXT    NOT NULL,
  live_time INTEGER NOT NULL,
  channel   TEXT    NOT NULL,
  target    TEXT,
  ok        INTEGER NOT NULL,
  error     TEXT,
  ts        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notify_log_room ON notify_log (room_id, live_time);
CREATE TABLE IF NOT EXISTS room_state (
  uid         TEXT    PRIMARY KEY,
  room_id     TEXT    NOT NULL,
  is_live     INTEGER NOT NULL,
  live_time   INTEGER NOT NULL,
  title       TEXT,
  updated_at  INTEGER NOT NULL
);
`;

export class Db {
  private readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    log.info(`数据库就绪: ${path}`);
  }

  loadRoomStates(): Map<string, PrevState> {
    const rows = this.db
      .prepare('SELECT uid, room_id, is_live, live_time, title FROM room_state')
      .all() as Array<{ uid: string; room_id: string; is_live: number; live_time: number; title: string | null }>;
    const m = new Map<string, PrevState>();
    for (const r of rows) {
      m.set(r.uid, {
        roomId: r.room_id,
        isLive: r.is_live === 1,
        liveTime: r.live_time,
        title: r.title ?? '',
      });
    }
    return m;
  }

  /** 批量落状态，包在一个事务里 —— 订阅多了以后避免每轮 N 次 fsync。 */
  saveRoomStates(entries: Array<{ uid: string; state: PrevState }>): void {
    if (entries.length === 0) return;
    const tx = this.db.transaction((rows: Array<{ uid: string; state: PrevState }>) => {
      for (const r of rows) this.saveRoomState(r.uid, r.state);
    });
    tx(entries);
  }

  saveRoomState(uid: string, s: PrevState): void {
    this.db
      .prepare(
        `INSERT INTO room_state (uid, room_id, is_live, live_time, title, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(uid) DO UPDATE SET
           room_id=excluded.room_id, is_live=excluded.is_live,
           live_time=excluded.live_time, title=excluded.title,
           updated_at=excluded.updated_at`,
      )
      .run(uid, s.roomId, s.isLive ? 1 : 0, s.liveTime, s.title, Math.floor(Date.now() / 1000));
  }

  /** 记录一场直播。已存在则不动（保留原 notified_at）。 */
  recordSession(p: {
    roomId: string; liveTime: number; uid: string;
    uname: string; title: string; areaName: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO live_sessions
           (room_id, live_time, uid, uname, title, area_name, first_seen, notified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(room_id, live_time) DO NOTHING`,
      )
      .run(p.roomId, p.liveTime, p.uid, p.uname, p.title, p.areaName, Math.floor(Date.now() / 1000));
  }

  hasNotified(roomId: string, liveTime: number): boolean {
    const row = this.db
      .prepare('SELECT notified_at FROM live_sessions WHERE room_id = ? AND live_time = ?')
      .get(roomId, liveTime) as { notified_at: number | null } | undefined;
    return row?.notified_at != null;
  }

  markNotified(roomId: string, liveTime: number): void {
    this.db
      .prepare('UPDATE live_sessions SET notified_at = ? WHERE room_id = ? AND live_time = ?')
      .run(Math.floor(Date.now() / 1000), roomId, liveTime);
  }

  logNotify(p: {
    roomId: string; liveTime: number; channel: string;
    target?: string; ok: boolean; error?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO notify_log (room_id, live_time, channel, target, ok, error, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.roomId, p.liveTime, p.channel, p.target ?? null, p.ok ? 1 : 0,
        p.error ?? null, Math.floor(Date.now() / 1000));
  }

  close(): void {
    this.db.close();
  }
}
