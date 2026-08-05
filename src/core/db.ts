import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { makeLogger } from '../logger.js';
import type { PrevState } from './state.js';
import {
  rowToFollow, rowToStreamer,
  type Follow, type FollowRow, type Streamer, type StreamerInput, type StreamerRow,
} from './streamers.js';
import {
  rowToChannel, rowToRule,
  type NewPushChannel, type NewPushRule, type PushChannel, type PushChannelInput,
  type PushChannelRow, type PushRule, type PushRuleInput, type PushRuleRow,
} from './push.js';
import {
  rowToPost,
  type NewPost, type Post, type PostRow,
} from './posts.js';

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
CREATE TABLE IF NOT EXISTS streamers (
  uid          TEXT    PRIMARY KEY,
  uname        TEXT    NOT NULL DEFAULT '',
  alias        TEXT,
  room_id      TEXT,
  weibo_uid    TEXT,
  weibo_nick   TEXT,
  watch        INTEGER NOT NULL DEFAULT 1,
  analyze      INTEGER NOT NULL DEFAULT 0,
  notify       INTEGER NOT NULL DEFAULT 1,
  profile_note TEXT,
  source       TEXT    NOT NULL DEFAULT 'manual' CHECK(source IN ('follows','manual')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS follows (
  uid         TEXT    PRIMARY KEY,
  uname       TEXT    NOT NULL DEFAULT '',
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  is_followed INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS push_channels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  notifier    TEXT    NOT NULL CHECK(notifier IN ('toast','onebot')),
  target_type TEXT    CHECK(target_type IN ('group','private')),
  target_id   TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS push_rules (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  uid              TEXT    NOT NULL,
  keywords         TEXT    NOT NULL DEFAULT '[]',
  areas            TEXT    NOT NULL DEFAULT '[]',
  channels         TEXT    NOT NULL DEFAULT '[]',
  message_template TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_rules_uid ON push_rules (uid);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  platform   TEXT    NOT NULL,
  uid        TEXT    NOT NULL,
  item_id    TEXT    NOT NULL,
  type       TEXT    NOT NULL,
  text       TEXT,
  pics       TEXT    NOT NULL DEFAULT '[]',
  pub_ts     INTEGER NOT NULL,
  url        TEXT,
  raw        TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(platform, item_id)
);
CREATE INDEX IF NOT EXISTS idx_posts_uid_ts ON posts (uid, pub_ts);
`;

const now = () => Math.floor(Date.now() / 1000);

/** 面板实况展示用的完整 room_state 行（PrevState 展示字段 + 下播锚点/轮询时间） */
export interface RoomStateFull {
  roomId: string;
  isLive: boolean;
  liveTime: number;
  title: string;
  areaName: string;
  parentAreaName: string;
  keyframe: string;
  cover: string;
  online: number;
  /** 最后一次观测到在播的时间（下播时长锚点）；从未见过开播为 null */
  lastLiveAt: number | null;
  /** 本轮状态落库时间 */
  polledAt: number;
}

export class Db {
  private readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    // 存量库迁移：room_state 展示字段（last_live_at = 最后一次观测到在播的时间，下播时长锚点）
    for (const ddl of ['area_name TEXT', 'parent_area_name TEXT', 'keyframe TEXT',
      'cover TEXT', 'online INTEGER', 'last_live_at INTEGER']) {
      this.ensureColumn('room_state', ddl.split(' ')[0]!, ddl);
    }
    this.ensureColumn('streamers', 'face', 'face TEXT');
    this.ensureColumn('follows', 'face', 'face TEXT');
    // streamers 三开关（watch/analyze/notify）替代旧 mode 列
    this.ensureColumn('streamers', 'watch', 'watch INTEGER NOT NULL DEFAULT 1');
    this.ensureColumn('streamers', 'notify', 'notify INTEGER NOT NULL DEFAULT 1');
    this.ensureColumn('streamers', 'weibo_nick', 'weibo_nick TEXT');
    this.migrateStreamerMode();
    this.migratePreferenceClauses();
    this.migratePerStreamerDefaultRules();
    log.info(`数据库就绪: ${path}`);
  }

  /** 缺列则 ALTER TABLE 补上（旧库在线迁移；新列一律可空或带默认值，不动旧数据） */
  private ensureColumn(table: string, column: string, ddl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  }

  /**
   * 旧 mode 列（off/silent/on）迁移为 watch/notify 开关后删除：
   * off → watch=0；silent → notify=0。对新库（无 mode 列）幂等。
   * 前置：watch/notify 列已由 ensureColumn 补好（默认 1）。
   */
  private migrateStreamerMode(): void {
    const cols = this.db.prepare('PRAGMA table_info(streamers)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'mode')) return;
    this.db.exec(`
      UPDATE streamers SET watch = 0 WHERE mode = 'off';
      UPDATE streamers SET notify = 0 WHERE mode = 'silent';
      ALTER TABLE streamers DROP COLUMN mode;
    `);
    log.info('streamers 表 mode 列已迁移为 watch/notify 开关并删除');
  }

  /**
   * preference_clauses（旧场景子句）已废弃：推送规则改用 push_rules 透明条件模型，
   * 旧数据无法映射，直接 DROP。对新库幂等。
   */
  private migratePreferenceClauses(): void {
    const row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='preference_clauses'")
      .get();
    if (!row) return;
    this.db.exec('DROP TABLE preference_clauses');
    log.info('preference_clauses 表已废弃并删除（推送规则改用 push_rules 表）');
  }

  /**
   * 每主播的「默认推送」（空条件规则）已改为全局默认推送（settings.default_channels /
   * default_template，推送卡片统一配置）：删除存量空条件规则，主播只留条件规则。
   * 对新库幂等。
   */
  private migratePerStreamerDefaultRules(): void {
    const { changes } = this.db
      .prepare("DELETE FROM push_rules WHERE keywords = '[]' AND areas = '[]'")
      .run();
    if (changes > 0) {
      log.info(`已删除 ${changes} 条每主播「默认推送」空条件规则（默认推送改为全局设置）`);
    }
  }

  loadRoomStates(): Map<string, PrevState> {
    const rows = this.db
      .prepare(`SELECT uid, room_id, is_live, live_time, title,
                area_name, parent_area_name, keyframe, cover, online FROM room_state`)
      .all() as Array<{
        uid: string; room_id: string; is_live: number; live_time: number; title: string | null;
        area_name: string | null; parent_area_name: string | null;
        keyframe: string | null; cover: string | null; online: number | null;
      }>;
    const m = new Map<string, PrevState>();
    for (const r of rows) {
      m.set(r.uid, {
        roomId: r.room_id,
        isLive: r.is_live === 1,
        liveTime: r.live_time,
        title: r.title ?? '',
        areaName: r.area_name ?? '',
        parentAreaName: r.parent_area_name ?? '',
        keyframe: r.keyframe ?? '',
        cover: r.cover ?? '',
        online: r.online ?? 0,
        face: '', // 头像以 streamers.face 为准，room_state 不存
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
    // last_live_at = 最后一次观测到在播的时间戳：在播时写入，下播后保留旧值
    // （是「下播时长」的锚点），故冲突更新时用 CASE 而不是无条件覆盖
    this.db
      .prepare(
        `INSERT INTO room_state
           (uid, room_id, is_live, live_time, title,
            area_name, parent_area_name, keyframe, cover, online, last_live_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN ? ELSE NULL END, ?)
         ON CONFLICT(uid) DO UPDATE SET
           room_id=excluded.room_id, is_live=excluded.is_live,
           live_time=excluded.live_time, title=excluded.title,
           area_name=excluded.area_name, parent_area_name=excluded.parent_area_name,
           keyframe=excluded.keyframe, cover=excluded.cover, online=excluded.online,
           last_live_at = CASE WHEN excluded.is_live=1
             THEN excluded.last_live_at ELSE room_state.last_live_at END,
           updated_at=excluded.updated_at`,
      )
      .run(uid, s.roomId, s.isLive ? 1 : 0, s.liveTime, s.title,
        s.areaName, s.parentAreaName, s.keyframe, s.cover, s.online,
        s.isLive ? 1 : 0, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000));
  }

  /** 当前在播房间数（面板状态展示用） */
  countLiveRooms(): number {
    const { c } = this.db
      .prepare('SELECT COUNT(*) AS c FROM room_state WHERE is_live=1')
      .get() as { c: number };
    return c;
  }

  /** 面板实况展示用：loadRoomStates 之外的 last_live_at / updated_at 也读出 */
  listRoomStatesFull(): Map<string, RoomStateFull> {
    const rows = this.db
      .prepare(`SELECT uid, room_id, is_live, live_time, title,
                area_name, parent_area_name, keyframe, cover, online,
                last_live_at, updated_at FROM room_state`)
      .all() as Array<{
        uid: string; room_id: string; is_live: number; live_time: number; title: string | null;
        area_name: string | null; parent_area_name: string | null;
        keyframe: string | null; cover: string | null; online: number | null;
        last_live_at: number | null; updated_at: number;
      }>;
    const m = new Map<string, RoomStateFull>();
    for (const r of rows) {
      m.set(r.uid, {
        roomId: r.room_id,
        isLive: r.is_live === 1,
        liveTime: r.live_time,
        title: r.title ?? '',
        areaName: r.area_name ?? '',
        parentAreaName: r.parent_area_name ?? '',
        keyframe: r.keyframe ?? '',
        cover: r.cover ?? '',
        online: r.online ?? 0,
        lastLiveAt: r.last_live_at,
        polledAt: r.updated_at,
      });
    }
    return m;
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

  // ---- streamers：监听名单（事实来源）----

  /** 监听中的 uid（watch=1）。live-status source 的名单来源。 */
  listWatchedUids(): string[] {
    const rows = this.db
      .prepare('SELECT uid FROM streamers WHERE watch = 1')
      .all() as Array<{ uid: string }>;
    return rows.map((r) => r.uid);
  }

  /**
   * 仅当 streamers 为空时，把 config.json 的 subscriptions 种子导入。
   * 返回导入条数（非空时返回 0，幂等）。
   * 旧 mode 字段兼容映射：'off'→watch:false，'silent'→notify:false；
   * 无 mode 时按 enabled 推导（false→watch:false）。
   */
  seedStreamersIfEmpty(
    subs: Array<{ uid: string; alias: string; enabled: boolean; mode?: 'off' | 'silent' | 'on' }>,
  ): number {
    const { c } = this.db.prepare('SELECT COUNT(*) AS c FROM streamers').get() as { c: number };
    if (c > 0 || subs.length === 0) return 0;
    const tx = this.db.transaction(() => {
      for (const s of subs) {
        const mode = s.mode ?? (s.enabled ? 'on' : 'off');
        this.upsertStreamer({
          uid: s.uid, alias: s.alias, source: 'manual',
          watch: mode !== 'off', notify: mode !== 'silent',
        });
      }
    });
    tx();
    return subs.length;
  }

  listStreamers(): Streamer[] {
    const rows = this.db.prepare('SELECT * FROM streamers ORDER BY created_at, uid').all() as StreamerRow[];
    return rows.map(rowToStreamer);
  }

  getStreamer(uid: string): Streamer | undefined {
    const row = this.db.prepare('SELECT * FROM streamers WHERE uid = ?').get(uid) as StreamerRow | undefined;
    return row ? rowToStreamer(row) : undefined;
  }

  /** 新建或更新；未提供的字段在建行时取默认值、改行时保留原值。 */
  upsertStreamer(input: StreamerInput): void {
    const prev = this.getStreamer(input.uid);
    const s: Streamer = {
      uid: input.uid,
      uname: input.uname ?? prev?.uname ?? '',
      alias: input.alias !== undefined ? input.alias : prev?.alias ?? null,
      roomId: input.roomId !== undefined ? input.roomId : prev?.roomId ?? null,
      weiboUid: input.weiboUid !== undefined ? input.weiboUid : prev?.weiboUid ?? null,
      weiboNick: input.weiboNick !== undefined ? input.weiboNick : prev?.weiboNick ?? null,
      watch: input.watch ?? prev?.watch ?? true,
      analyze: input.analyze ?? prev?.analyze ?? false,
      notify: input.notify ?? prev?.notify ?? true,
      profileNote: input.profileNote !== undefined ? input.profileNote : prev?.profileNote ?? null,
      face: input.face !== undefined ? input.face : prev?.face ?? null,
      source: input.source ?? prev?.source ?? 'manual',
      createdAt: prev?.createdAt ?? now(),
      updatedAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO streamers
           (uid, uname, alias, room_id, weibo_uid, weibo_nick, watch, analyze, notify,
            profile_note, face, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(uid) DO UPDATE SET
           uname=excluded.uname, alias=excluded.alias, room_id=excluded.room_id,
           weibo_uid=excluded.weibo_uid, weibo_nick=excluded.weibo_nick,
           watch=excluded.watch, analyze=excluded.analyze, notify=excluded.notify,
           profile_note=excluded.profile_note, face=excluded.face,
           source=excluded.source, updated_at=excluded.updated_at`,
      )
      .run(s.uid, s.uname, s.alias, s.roomId, s.weiboUid, s.weiboNick,
        s.watch ? 1 : 0, s.analyze ? 1 : 0, s.notify ? 1 : 0,
        s.profileNote, s.face, s.source, s.createdAt, s.updatedAt);
  }

  // ---- follows：关注列表候选池 ----

  /** 关注列表出现的 uid 入库；已存在的刷新 uname / last_seen / is_followed。face 只进不退（空不覆盖）。 */
  upsertFollows(follows: Array<{ uid: string; uname: string; face?: string }>): void {
    if (follows.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO follows (uid, uname, face, first_seen, last_seen, is_followed)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(uid) DO UPDATE SET
         uname=excluded.uname, face=COALESCE(excluded.face, follows.face),
         last_seen=excluded.last_seen, is_followed=1`,
    );
    const tx = this.db.transaction((rows: Array<{ uid: string; uname: string; face?: string }>) => {
      for (const f of rows) stmt.run(f.uid, f.uname, f.face || null, now(), now());
    });
    tx(follows);
  }

  /** 一次同步完成：seen 里的标 is_followed=1 + last_seen=ts，其余标取关。返回取关条数。 */
  markFollowsSynced(seenUids: string[], ts: number): number {
    const tx = this.db.transaction(() => {
      const seen = this.db.prepare('UPDATE follows SET is_followed = 1, last_seen = ? WHERE uid = ?');
      for (const uid of seenUids) seen.run(ts, uid);
      if (seenUids.length === 0) {
        return this.db.prepare('UPDATE follows SET is_followed = 0').run().changes;
      }
      const ph = seenUids.map(() => '?').join(',');
      return this.db
        .prepare(`UPDATE follows SET is_followed = 0 WHERE uid NOT IN (${ph})`)
        .run(...seenUids).changes;
    });
    return tx();
  }

  listFollows(onlyFollowed = false): Follow[] {
    const sql = 'SELECT * FROM follows' + (onlyFollowed ? ' WHERE is_followed = 1' : '') + ' ORDER BY uid';
    return (this.db.prepare(sql).all() as FollowRow[]).map(rowToFollow);
  }

  // ---- push_channels：推送渠道（事实来源；config 的 notify 目标仅为首次种子）----

  listPushChannels(): PushChannel[] {
    const rows = this.db.prepare('SELECT * FROM push_channels ORDER BY id').all() as PushChannelRow[];
    return rows.map(rowToChannel);
  }

  private getPushChannel(id: number): PushChannel | undefined {
    const row = this.db.prepare('SELECT * FROM push_channels WHERE id = ?').get(id) as PushChannelRow | undefined;
    return row ? rowToChannel(row) : undefined;
  }

  /** 带 id 且存在 = 改行（未提供字段保留原值）；否则建行。返回渠道 id。 */
  upsertPushChannel(input: PushChannelInput): number {
    const prev = input.id !== undefined ? this.getPushChannel(input.id) : undefined;
    const c: NewPushChannel = {
      name: input.name ?? prev?.name ?? '',
      notifier: input.notifier ?? prev?.notifier ?? 'toast',
      targetType: input.targetType !== undefined ? input.targetType : prev?.targetType ?? null,
      targetId: input.targetId !== undefined ? input.targetId : prev?.targetId ?? null,
      enabled: input.enabled ?? prev?.enabled ?? true,
    };
    if (prev) {
      this.db
        .prepare(
          `UPDATE push_channels SET name=?, notifier=?, target_type=?, target_id=?, enabled=?, updated_at=?
           WHERE id=?`,
        )
        .run(c.name, c.notifier, c.targetType, c.targetId, c.enabled ? 1 : 0, now(), prev.id);
      return prev.id;
    }
    const t = now();
    const info = this.db
      .prepare(
        `INSERT INTO push_channels (name, notifier, target_type, target_id, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(c.name, c.notifier, c.targetType, c.targetId, c.enabled ? 1 : 0, t, t);
    return Number(info.lastInsertRowid);
  }

  deletePushChannel(id: number): boolean {
    return this.db.prepare('DELETE FROM push_channels WHERE id = ?').run(id).changes > 0;
  }

  /**
   * 仅当 push_channels 为空时，把 config 的 notify 目标种子导入（onebot targets + toast）。
   * 返回导入条数（非空时返回 0，幂等）。之后渠道以表为准，由面板管理。
   */
  seedPushChannelsIfEmpty(seeds: NewPushChannel[]): number {
    const { c } = this.db.prepare('SELECT COUNT(*) AS c FROM push_channels').get() as { c: number };
    if (c > 0 || seeds.length === 0) return 0;
    const tx = this.db.transaction(() => {
      for (const s of seeds) this.upsertPushChannel(s);
    });
    tx();
    return seeds.length;
  }

  // ---- push_rules：透明条件规则 ----

  /** 面板用：全量规则（含 disabled），id 升序。matcher 消费请用 listEnabledPushRules。 */
  listPushRules(): PushRule[] {
    const rows = this.db.prepare('SELECT * FROM push_rules ORDER BY id').all() as PushRuleRow[];
    return rows.map(rowToRule);
  }

  /** 某主播的启用规则，id 升序（= 匹配优先级：第一条命中生效）。 */
  listEnabledPushRules(uid: string): PushRule[] {
    const rows = this.db
      .prepare('SELECT * FROM push_rules WHERE enabled = 1 AND uid = ? ORDER BY id')
      .all(uid) as PushRuleRow[];
    return rows.map(rowToRule);
  }

  private getPushRule(id: number): PushRule | undefined {
    const row = this.db.prepare('SELECT * FROM push_rules WHERE id = ?').get(id) as PushRuleRow | undefined;
    return row ? rowToRule(row) : undefined;
  }

  /** 带 id 且存在 = 改行（未提供字段保留原值）；否则建行（uid 必填）。返回规则 id。 */
  upsertPushRule(input: PushRuleInput): number {
    const prev = input.id !== undefined ? this.getPushRule(input.id) : undefined;
    const uid = input.uid ?? prev?.uid;
    if (!uid) throw new Error('新建 push_rule 必须提供 uid');
    const r: NewPushRule = {
      uid,
      keywords: input.keywords ?? prev?.keywords ?? [],
      areas: input.areas ?? prev?.areas ?? [],
      channels: input.channels ?? prev?.channels ?? [],
      messageTemplate: input.messageTemplate !== undefined
        ? input.messageTemplate : prev?.messageTemplate ?? null,
      enabled: input.enabled ?? prev?.enabled ?? true,
    };
    if (prev) {
      this.db
        .prepare(
          `UPDATE push_rules SET uid=?, keywords=?, areas=?, channels=?, message_template=?, enabled=?, updated_at=?
           WHERE id=?`,
        )
        .run(r.uid, JSON.stringify(r.keywords), JSON.stringify(r.areas), JSON.stringify(r.channels),
          r.messageTemplate, r.enabled ? 1 : 0, now(), prev.id);
      return prev.id;
    }
    const t = now();
    const info = this.db
      .prepare(
        `INSERT INTO push_rules (uid, keywords, areas, channels, message_template, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.uid, JSON.stringify(r.keywords), JSON.stringify(r.areas), JSON.stringify(r.channels),
        r.messageTemplate, r.enabled ? 1 : 0, t, t);
    return Number(info.lastInsertRowid);
  }

  deletePushRule(id: number): boolean {
    return this.db.prepare('DELETE FROM push_rules WHERE id = ?').run(id).changes > 0;
  }

  // ---- posts：动态/微博时间线归档 ----

  /**
   * INSERT OR IGNORE 批量归档（单事务）。返回新插入行在入参中的下标 ——
   * 已存在的 (platform, item_id) 静默跳过，下标即「哪些是本轮新帖」的判断依据。
   */
  insertPosts(posts: NewPost[]): number[] {
    if (posts.length === 0) return [];
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO posts
         (platform, uid, item_id, type, text, pics, pub_ts, url, raw, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const inserted: number[] = [];
    const t = now();
    const tx = this.db.transaction((rows: NewPost[]) => {
      rows.forEach((p, i) => {
        const info = stmt.run(p.platform, p.uid, p.itemId, p.type, p.text,
          JSON.stringify(p.pics), p.pubTs, p.url, p.raw, t);
        if (info.changes > 0) inserted.push(i);
      });
    });
    tx(posts);
    return inserted;
  }

  /**
   * 面板 enrich 用：一批 uid 各取最近 perUid 条，一次 IN 查询后 JS 分组截取，
   * 返回 uid → 该 uid 的最近动态（pub_ts 倒序）。无动态的 uid 不在返回里。
   */
  listRecentPosts(uids: string[], perUid: number): Map<string, Post[]> {
    const out = new Map<string, Post[]>();
    if (uids.length === 0 || perUid <= 0) return out;
    const ph = uids.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM posts WHERE uid IN (${ph}) ORDER BY pub_ts DESC, id DESC`)
      .all(...uids) as PostRow[];
    for (const r of rows) {
      const list = out.get(r.uid);
      if (list) {
        if (list.length < perUid) list.push(rowToPost(r));
      } else {
        out.set(r.uid, [rowToPost(r)]);
      }
    }
    return out;
  }

  // ---- settings：kv（目前只有 default_template）----

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, value);
  }

  close(): void {
    this.db.close();
  }
}
