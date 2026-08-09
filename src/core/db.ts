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
  rowToCategory, rowToChannel, rowToRule,
  type Category, type CategoryInput, type CategoryRow, type NewCategory,
  type NewPushChannel, type NewPushRule, type NewVerdict,
  type PushChannel, type PushChannelInput, type PushChannelRow,
  type PushRule, type PushRuleInput, type PushRuleRow, type Verdict, type VerdictRow,
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
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  llm_prompt  TEXT,
  keywords    TEXT    NOT NULL DEFAULT '[]',
  areas       TEXT    NOT NULL DEFAULT '[]',
  cond_mode   TEXT    NOT NULL DEFAULT 'and' CHECK(cond_mode IN ('and','or')),
  enabled     INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS verdicts (
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
CREATE TABLE IF NOT EXISTS push_rules (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL DEFAULT '',
  category_id      INTEGER,
  uids             TEXT    NOT NULL DEFAULT '[]',
  channels         TEXT    NOT NULL DEFAULT '[]',
  message_template TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  sort             INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
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
    // push_channels 展示顺序（面板拖拽排序；旧库默认全 0 按 id 稳定）
    this.ensureColumn('push_channels', 'sort', 'sort INTEGER NOT NULL DEFAULT 0');
    this.migrateStreamerMode();
    this.migratePreferenceClauses();
    this.migratePushRulesV2();
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
   * push_rules v1（按主播、带 uid 列）与 v2（全局、category_id/uids 引用）结构无法映射，
   * 检出旧 uid 列即 DROP 重建为新结构（与 preference_clauses 同政策）。对新库幂等。
   */
  private migratePushRulesV2(): void {
    const cols = this.db.prepare('PRAGMA table_info(push_rules)').all() as Array<{ name: string }>;
    if (cols.length === 0 || !cols.some((c) => c.name === 'uid')) return;
    this.db.exec(`
      DROP TABLE push_rules;
      CREATE TABLE push_rules (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        name             TEXT    NOT NULL DEFAULT '',
        category_id      INTEGER,
        uids             TEXT    NOT NULL DEFAULT '[]',
        channels         TEXT    NOT NULL DEFAULT '[]',
        message_template TEXT,
        enabled          INTEGER NOT NULL DEFAULT 1,
        sort             INTEGER NOT NULL DEFAULT 0,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      );
    `);
    log.info('push_rules 旧结构（按主播）已删除并重建为 v2 全局结构，旧规则需重新配置');
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
    const rows = this.db.prepare('SELECT * FROM push_channels ORDER BY sort, id').all() as PushChannelRow[];
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
    // 新渠道排到列表末尾
    const { m } = this.db
      .prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS m FROM push_channels')
      .get() as { m: number };
    const info = this.db
      .prepare(
        `INSERT INTO push_channels (name, notifier, target_type, target_id, enabled, sort, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(c.name, c.notifier, c.targetType, c.targetId, c.enabled ? 1 : 0, m, t, t);
    return Number(info.lastInsertRowid);
  }

  /** 拖拽排序：ids 是现有渠道的全排列，按数组顺序重写 sort。调用方负责校验。 */
  reorderPushChannels(ids: number[]): void {
    const tx = this.db.transaction(() => {
      const stmt = this.db.prepare('UPDATE push_channels SET sort = ?, updated_at = ? WHERE id = ?');
      for (let i = 0; i < ids.length; i++) stmt.run(i, now(), ids[i]);
    });
    tx();
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

  // ---- categories：分类规则（全局；LLM 提示词 + 确定性条件，归类结果入 verdicts）----

  /** 面板用：全量分类（含 disabled），排序（sort, id）。判定消费请用 listEnabledCategories。 */
  listCategories(): Category[] {
    const rows = this.db.prepare('SELECT * FROM categories ORDER BY sort, id').all() as CategoryRow[];
    return rows.map(rowToCategory);
  }

  /** 启用的分类，sort 升序。RulesClassifier 每场 live_start 逐个判定。 */
  listEnabledCategories(): Category[] {
    const rows = this.db
      .prepare('SELECT * FROM categories WHERE enabled = 1 ORDER BY sort, id')
      .all() as CategoryRow[];
    return rows.map(rowToCategory);
  }

  private getCategory(id: number): Category | undefined {
    const row = this.db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as CategoryRow | undefined;
    return row ? rowToCategory(row) : undefined;
  }

  /** 带 id 且存在 = 改行（未提供字段保留原值）；否则建行（空名补「分类 N」，排到末尾）。返回分类 id。 */
  upsertCategory(input: CategoryInput): number {
    const prev = input.id !== undefined ? this.getCategory(input.id) : undefined;
    const c: NewCategory = {
      name: input.name !== undefined ? input.name : prev?.name ?? '',
      llmPrompt: input.llmPrompt !== undefined ? input.llmPrompt : prev?.llmPrompt ?? null,
      keywords: input.keywords ?? prev?.keywords ?? [],
      areas: input.areas ?? prev?.areas ?? [],
      condMode: input.condMode ?? prev?.condMode ?? 'and',
      enabled: input.enabled ?? prev?.enabled ?? true,
    };
    if (prev) {
      this.db
        .prepare(
          `UPDATE categories SET name=?, llm_prompt=?, keywords=?, areas=?, cond_mode=?, enabled=?, updated_at=?
           WHERE id=?`,
        )
        .run(c.name, c.llmPrompt, JSON.stringify(c.keywords), JSON.stringify(c.areas),
          c.condMode, c.enabled ? 1 : 0, now(), prev.id);
      return prev.id;
    }
    const t = now();
    // 新分类排到列表末尾
    const { m } = this.db
      .prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS m FROM categories')
      .get() as { m: number };
    const info = this.db
      .prepare(
        `INSERT INTO categories (name, llm_prompt, keywords, areas, cond_mode, enabled, sort, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(c.name, c.llmPrompt, JSON.stringify(c.keywords), JSON.stringify(c.areas),
        c.condMode, c.enabled ? 1 : 0, m, t, t);
    const id = Number(info.lastInsertRowid);
    if (!c.name) {
      this.db.prepare('UPDATE categories SET name = ?, updated_at = ? WHERE id = ?').run(`分类 ${id}`, t, id);
    }
    return id;
  }

  /** 拖拽排序：ids 是现有分类的全排列，按数组顺序重写 sort。调用方负责校验。 */
  reorderCategories(ids: number[]): void {
    const tx = this.db.transaction(() => {
      const stmt = this.db.prepare('UPDATE categories SET sort = ?, updated_at = ? WHERE id = ?');
      for (let i = 0; i < ids.length; i++) stmt.run(i, now(), ids[i]);
    });
    tx();
  }

  deleteCategory(id: number): boolean {
    return this.db.prepare('DELETE FROM categories WHERE id = ?').run(id).changes > 0;
  }

  /** 删除分类前的级联：停用引用它的推送规则（规则保留可恢复）。返回受影响条数供面板提示。 */
  disablePushRulesByCategory(categoryId: number): number {
    return this.db
      .prepare('UPDATE push_rules SET enabled = 0, updated_at = ? WHERE category_id = ? AND enabled = 1')
      .run(now(), categoryId).changes;
  }

  // ---- push_rules v2：推送规则（全局；分类引用 + 生效主播集合 + 渠道）----

  /** 面板用：全量规则（含 disabled），排序（sort, id）。matcher 消费请用 listEnabledPushRules。 */
  listPushRules(): PushRule[] {
    const rows = this.db.prepare('SELECT * FROM push_rules ORDER BY sort, id').all() as PushRuleRow[];
    return rows.map(rowToRule);
  }

  /** 全部启用规则，sort 升序（= 全局匹配优先级，全部命中独立生效）。 */
  listEnabledPushRules(): PushRule[] {
    const rows = this.db
      .prepare('SELECT * FROM push_rules WHERE enabled = 1 ORDER BY sort, id')
      .all() as PushRuleRow[];
    return rows.map(rowToRule);
  }

  private getPushRule(id: number): PushRule | undefined {
    const row = this.db.prepare('SELECT * FROM push_rules WHERE id = ?').get(id) as PushRuleRow | undefined;
    return row ? rowToRule(row) : undefined;
  }

  /** 带 id 且存在 = 改行（未提供字段保留原值）；否则建行（空名补「规则 N」，排到末尾）。返回规则 id。 */
  upsertPushRule(input: PushRuleInput): number {
    const prev = input.id !== undefined ? this.getPushRule(input.id) : undefined;
    const r: NewPushRule = {
      name: input.name !== undefined ? input.name : prev?.name ?? '',
      categoryId: input.categoryId !== undefined ? input.categoryId : prev?.categoryId ?? null,
      uids: input.uids ?? prev?.uids ?? [],
      channels: input.channels ?? prev?.channels ?? [],
      messageTemplate: input.messageTemplate !== undefined
        ? input.messageTemplate : prev?.messageTemplate ?? null,
      enabled: input.enabled ?? prev?.enabled ?? true,
    };
    if (prev) {
      this.db
        .prepare(
          `UPDATE push_rules SET name=?, category_id=?, uids=?, channels=?, message_template=?, enabled=?, updated_at=?
           WHERE id=?`,
        )
        .run(r.name, r.categoryId, JSON.stringify(r.uids), JSON.stringify(r.channels),
          r.messageTemplate, r.enabled ? 1 : 0, now(), prev.id);
      return prev.id;
    }
    const t = now();
    const { m } = this.db
      .prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS m FROM push_rules')
      .get() as { m: number };
    const info = this.db
      .prepare(
        `INSERT INTO push_rules (name, category_id, uids, channels, message_template, enabled, sort, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.name, r.categoryId, JSON.stringify(r.uids), JSON.stringify(r.channels),
        r.messageTemplate, r.enabled ? 1 : 0, m, t, t);
    const id = Number(info.lastInsertRowid);
    if (!r.name) {
      this.db.prepare('UPDATE push_rules SET name = ?, updated_at = ? WHERE id = ?').run(`规则 ${id}`, t, id);
    }
    return id;
  }

  /** 拖拽排序：ids 是全部规则的全排列，按数组顺序重写 sort。调用方负责校验。 */
  reorderPushRules(ids: number[]): void {
    const tx = this.db.transaction(() => {
      const stmt = this.db.prepare('UPDATE push_rules SET sort = ?, updated_at = ? WHERE id = ?');
      for (let i = 0; i < ids.length; i++) stmt.run(i, now(), ids[i]);
    });
    tx();
  }

  deletePushRule(id: number): boolean {
    return this.db.prepare('DELETE FROM push_rules WHERE id = ?').run(id).changes > 0;
  }

  // ---- verdicts：每场直播的分类判定结果（UNIQUE(room_id, live_time, category_id) 去重）----

  /** INSERT OR IGNORE：同一场同一分类重复判定静默跳过。 */
  insertVerdict(v: NewVerdict): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO verdicts
           (room_id, live_time, uid, category_id, category_name, source, confidence, evidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(v.roomId, v.liveTime, v.uid, v.categoryId, v.categoryName,
        v.source, v.confidence, v.evidence, now());
  }

  /** 一场直播的全部判定结果（面板/调试用）。 */
  listVerdicts(roomId: string, liveTime: number): Verdict[] {
    const rows = this.db
      .prepare('SELECT * FROM verdicts WHERE room_id = ? AND live_time = ? ORDER BY id')
      .all(roomId, liveTime) as VerdictRow[];
    return rows.map((r) => ({
      id: r.id, roomId: r.room_id, liveTime: r.live_time, uid: r.uid,
      categoryId: r.category_id, categoryName: r.category_name,
      source: r.source, confidence: r.confidence, evidence: r.evidence, createdAt: r.created_at,
    }));
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

  // ---- settings：kv（push_enabled / listen_* / llm_* / napcat_* 等）----

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, value);
  }

  deleteSetting(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  close(): void {
    this.db.close();
  }
}
