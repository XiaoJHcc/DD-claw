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
import {
  normalizeScreenName, rowToXAccount,
  type XAccount, type XAccountFetchTouch, type XAccountInput, type XAccountRow,
} from './x-accounts.js';
import {
  rowToWeiboAccount,
  type WeiboAccount, type WeiboAccountFetchTouch, type WeiboAccountInput, type WeiboAccountRow,
} from './weibo-accounts.js';
import {
  rowToBiliAccount,
  type BiliAccount, type BiliAccountFetchTouch, type BiliAccountInput, type BiliAccountRow,
} from './bili-accounts.js';
import {
  defaultPostFilters, rowToPostRule,
  type NewPostRule, type PostFilters, type PostRule, type PostRuleInput, type PostRuleRow,
} from './post-rules.js';

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
CREATE TABLE IF NOT EXISTS x_accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  screen_name   TEXT    NOT NULL UNIQUE,
  nickname      TEXT,
  display_name  TEXT,
  bili_uid      TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  rule_ids      TEXT    NOT NULL DEFAULT '[]',
  last_tweet_id TEXT,
  last_tweet_at INTEGER,
  last_ok_at    INTEGER,
  avatar        TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS post_rules (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL DEFAULT '',
  platform         TEXT    NOT NULL DEFAULT 'twitter',
  account_ids      TEXT    NOT NULL DEFAULT '[]',
  channels         TEXT    NOT NULL DEFAULT '[]',
  filters          TEXT    NOT NULL DEFAULT '{}',
  message_template TEXT,
  llm_judge        INTEGER NOT NULL DEFAULT 0,
  judge_prompt     TEXT,
  llm_translate    INTEGER NOT NULL DEFAULT 0,
  enabled          INTEGER NOT NULL DEFAULT 1,
  sort             INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS weibo_accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  uid           TEXT    NOT NULL UNIQUE,
  nickname      TEXT,
  display_name  TEXT,
  bili_uid      TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  rule_ids      TEXT    NOT NULL DEFAULT '[]',
  last_post_id  TEXT,
  last_post_at  INTEGER,
  last_ok_at    INTEGER,
  avatar        TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bili_accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  uid           TEXT    NOT NULL UNIQUE,
  uname         TEXT,
  display_name  TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  rule_ids      TEXT    NOT NULL DEFAULT '[]',
  last_ok_at    INTEGER,
  avatar        TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS live_segments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id         TEXT    NOT NULL,
  live_time       INTEGER NOT NULL,
  start_ts        INTEGER NOT NULL,
  end_ts          INTEGER,
  title           TEXT    NOT NULL DEFAULT '',
  area_name       TEXT,
  parent_area_name TEXT,
  keyframe        TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_segments_room ON live_segments (room_id, live_time);
CREATE TABLE IF NOT EXISTS snapshots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id    TEXT    NOT NULL,
  live_time  INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  path       TEXT    NOT NULL,
  bytes      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_room ON snapshots (room_id, live_time, ts);
`;

const now = () => Math.floor(Date.now() / 1000);

/** 微博独立名单迁移的一次性闸门（见 Db.migrateWeiboAccounts） */
const WEIBO_MIGRATION_KEY = 'migrated_weibo_accounts_v1';

/** post_rules 生效范围搬家（account_ids → 账号侧 rule_ids）的一次性闸门（见 Db.migratePostRuleScopes） */
const POST_RULE_SCOPE_MIGRATION_KEY = 'migrated_post_rule_scopes_v1';

/** 开播动态（LIVE_RCMD）彻底舍弃、清理旧库残留行的一次性闸门（见 Db.dropLiveRcmdPosts） */
const LIVE_RCMD_DROP_KEY = 'migrated_drop_live_rcmd_posts_v1';

/** listTimeline 在播判定：last_seen 超过该秒数未刷新 = 已下播（崩溃/停机错过 live_end 的兜底） */
const TIMELINE_LIVE_STALE_S = 600;

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

/** live_segments 行类型（时间表：一场直播按内容变更切分的连续时间段） */
export interface LiveSegmentRow {
  id: number;
  room_id: string;
  live_time: number;
  start_ts: number;
  /** NULL = 进行中 */
  end_ts: number | null;
  title: string;
  area_name: string | null;
  parent_area_name: string | null;
  keyframe: string | null;
  created_at: number;
}

/** 时间轴（/api/schedule）组装的段形状 */
export interface TimelineSegment {
  startTs: number;
  endTs: number | null;
  title: string;
  areaName: string;
  parentAreaName: string;
}

/** 时间轴条目：场次 + 段 + 分类判定 + 主播信息 */
export interface TimelineEntry {
  roomId: string;
  liveTime: number;
  uid: string;
  /** 简称优先（alias ?? uname）：空间受限的时间表横条用；要原名用 uname 字段 */
  name: string;
  /** 原名（hover 弹层等空间充足处用） */
  uname: string;
  face: string | null;
  startTs: number;
  /** null = 仍在播（或从未观测到下播） */
  endTs: number | null;
  keyframe: string | null;
  cover: string | null;
  segments: TimelineSegment[];
  verdicts: Array<{
    categoryName: string;
    source: 'llm' | 'rule' | 'decision';
    confidence: number | null;
    evidence: string;
  }>;
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
    // live_sessions 时间轴字段（last_seen = 在播期间每轮刷新，近似下播时间锚点；
    // keyframe/cover 开场快照 + 在播刷新，供时间表 hover 缩略图）
    this.ensureColumn('live_sessions', 'last_seen', 'last_seen INTEGER');
    this.ensureColumn('live_sessions', 'keyframe', 'keyframe TEXT');
    this.ensureColumn('live_sessions', 'cover', 'cover TEXT');
    // streamers 三开关（watch/analyze/notify）替代旧 mode 列
    this.ensureColumn('streamers', 'watch', 'watch INTEGER NOT NULL DEFAULT 1');
    this.ensureColumn('streamers', 'notify', 'notify INTEGER NOT NULL DEFAULT 1');
    this.ensureColumn('streamers', 'weibo_nick', 'weibo_nick TEXT');
    // push_channels 展示顺序（面板拖拽排序；旧库默认全 0 按 id 稳定）
    this.ensureColumn('push_channels', 'sort', 'sort INTEGER NOT NULL DEFAULT 0');
    // push_rules 创建来源（MCP 群自助规则标记 'mcp'，权限隔离用；面板/人工规则为 NULL）
    this.ensureColumn('push_rules', 'created_by', 'created_by TEXT');
    // post_rules 的 LLM 字段（P3）：判定 / 判定标准 / 翻译；旧库在线补列，默认关
    this.ensureColumn('post_rules', 'llm_judge', 'llm_judge INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('post_rules', 'judge_prompt', 'judge_prompt TEXT');
    this.ensureColumn('post_rules', 'llm_translate', 'llm_translate INTEGER NOT NULL DEFAULT 0');
    // x_accounts 头像（抓取时顺手抠 X 头像 → 代理下载到 cache/x-avatars，存文件名；旧库在线补列）
    this.ensureColumn('x_accounts', 'avatar', 'avatar TEXT');
    // x_accounts 昵称（X 的 display name，与自定义显示名 display_name 分开；旧库的
    // display_name 全是人手填的自定义名——抓取从不写它——留在原列语义不变）
    this.ensureColumn('x_accounts', 'nickname', 'nickname TEXT');
    // post_rules.platform（微博图文来源接入）：旧库只有 X 规则，默认 'twitter' 即正确
    this.ensureColumn('post_rules', 'platform', "platform TEXT NOT NULL DEFAULT 'twitter'");
    // weibo_accounts 自定义显示名（卡片优先展示；留空 = 用昵称，同 x_accounts.display_name 语义）
    this.ensureColumn('weibo_accounts', 'display_name', 'display_name TEXT');
    // 账号侧 rule_ids：图文帖规则的生效范围从 post_rules.account_ids 搬到账号选用规则
    // （规则只定义筛选+渠道+推送词）；旧库在线补列，默认空 = 不选用任何规则
    this.ensureColumn('x_accounts', 'rule_ids', "rule_ids TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn('weibo_accounts', 'rule_ids', "rule_ids TEXT NOT NULL DEFAULT '[]'");
    // 主动关闭恢复位（图文补推语义见 core/backlog.ts）：重新启用/图文开关重开时置位，
    // 恢复轮询的首轮静默归档不补推；旧库在线补列，默认 0 = 没有待消费的静默轮
    this.ensureColumn('x_accounts', 'silent_next', 'silent_next INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('weibo_accounts', 'silent_next', 'silent_next INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('bili_accounts', 'silent_next', 'silent_next INTEGER NOT NULL DEFAULT 0');
    // 账号级抓取故障（长期问题，不推送、面板账号卡展示）：持续满阈值才落，
    // 成功即清；旧库在线补列，默认 NULL = 正常
    for (const t of ['x_accounts', 'weibo_accounts', 'bili_accounts']) {
      this.ensureColumn(t, 'fetch_fail_since', 'fetch_fail_since INTEGER');
      this.ensureColumn(t, 'fetch_error', 'fetch_error TEXT');
    }
    // 健康告警阈值 2026-11 从轮数口径改为时间口径（秒）：旧键一次性删除
    // （settings 只留 health_alert_toast_after_sec 一个键；旧值是轮数，语义不通不可继承）
    this.db.prepare("DELETE FROM settings WHERE key = 'health_alert_after_failures'").run();
    // weibo_accounts 本身由 SCHEMA 的 CREATE TABLE IF NOT EXISTS 建出；这里只做数据搬家
    this.migrateWeiboAccounts();
    this.migratePostRuleScopes();
    this.dropLiveRcmdPosts();
    log.info(`数据库就绪: ${path}`);
  }

  /** better-sqlite3 原始句柄：只供装配层挂同库存储（UndoStore 撤销 / ChatStore 会话），业务代码不得直用 */
  get raw(): Database.Database {
    return this.db;
  }

  /** 同步 SQL 段的事务包装（级联写原子化用；回调必须是同步代码，不得跨 await） */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** 缺列则 ALTER TABLE 补上（旧库在线迁移；新列一律可空或带默认值，不动旧数据） */
  private ensureColumn(table: string, column: string, ddl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  }

  /**
   * 微博从「主播附属数据源」迁到「独立名单」的一次性数据搬家（settings 闸门，只跑一次）：
   *  ① `streamers.weibo_uid` → `weibo_accounts`（昵称、可选关联主播、启用态照抄 watch）；
   *  ② 旧微博帖的 `posts.uid` 曾是**B站 uid**（面板第三栏按它分组混排）→ 改写成微博 uid，
   *     与 X/推特同语义（帖子归属 = 被抓账号自身的 id）。主播卡第三栏改由「关联主播」反查混排
   *     （见 listRecentPostsMixed），所以这次改写对面板是透明的。
   *
   * 幂等靠闸门而不是条件判断：改写后 `posts.uid` 已是微博 uid，
   * 与 `weibo_accounts.bili_uid` 不再相等，重跑是空操作——但闸门让「只跑一次」这件事显式可读。
   */
  private migrateWeiboAccounts(): void {
    if (this.getSetting(WEIBO_MIGRATION_KEY)) return;
    const t = now();
    const seeded = this.db
      .prepare(
        `INSERT OR IGNORE INTO weibo_accounts
           (uid, nickname, bili_uid, enabled, created_at, updated_at)
         SELECT weibo_uid, weibo_nick, uid, watch, ?, ?
           FROM streamers
          WHERE weibo_uid IS NOT NULL AND TRIM(weibo_uid) <> ''`,
      )
      .run(t, t);
    const remapped = this.db
      .prepare(
        `UPDATE posts SET uid = (SELECT w.uid FROM weibo_accounts w WHERE w.bili_uid = posts.uid)
          WHERE platform = 'weibo'
            AND EXISTS (SELECT 1 FROM weibo_accounts w WHERE w.bili_uid = posts.uid)`,
      )
      .run();
    this.setSetting(WEIBO_MIGRATION_KEY, '1');
    if (seeded.changes > 0 || remapped.changes > 0) {
      log.info(
        `微博独立名单迁移：种入 ${seeded.changes} 个账号，改写 ${remapped.changes} 条历史微博的归属 uid`,
      );
    }
  }

  /**
   * 图文帖规则生效范围搬家（settings 闸门，只跑一次）：post_rules.account_ids（规则内嵌
   * 账号集合）→ 账号名单行的 rule_ids（账号选用规则）。
   *  · account_ids 非空 → 把规则 id 追加到对应平台这些账号的 rule_ids（去重）；
   *  · account_ids 为空（旧语义 = 该平台全部账号）→ 追加到该平台全部现有账号。
   * bili_dynamic 无旧数据（该平台与本次改造一起引入），跳过。
   * account_ids 列保留不删，但写入侧恒 '[]'（见 upsertPostRule）。
   */
  private migratePostRuleScopes(): void {
    if (this.getSetting(POST_RULE_SCOPE_MIGRATION_KEY)) return;
    const rules = this.db
      .prepare('SELECT id, platform, account_ids FROM post_rules')
      .all() as Array<{ id: number; platform: string; account_ids: string }>;
    let moved = 0;
    for (const r of rules) {
      const table = r.platform === 'weibo' ? 'weibo_accounts'
        : r.platform === 'twitter' ? 'x_accounts'
        : null;
      if (!table) continue;
      let scope: number[];
      try {
        scope = JSON.parse(r.account_ids) as number[];
      } catch {
        scope = []; // 坏 JSON 按旧语义「全部账号」处理，不丢规则
      }
      const accounts = this.db
        .prepare(`SELECT id, rule_ids FROM ${table}`)
        .all() as Array<{ id: number; rule_ids: string }>;
      const update = this.db.prepare(`UPDATE ${table} SET rule_ids = ?, updated_at = ? WHERE id = ?`);
      for (const a of accounts) {
        if (scope.length > 0 && !scope.includes(a.id)) continue;
        let ruleIds: number[];
        try {
          ruleIds = JSON.parse(a.rule_ids) as number[];
        } catch {
          ruleIds = [];
        }
        if (ruleIds.includes(r.id)) continue;
        ruleIds.push(r.id);
        update.run(JSON.stringify(ruleIds), now(), a.id);
        moved++;
      }
    }
    this.setSetting(POST_RULE_SCOPE_MIGRATION_KEY, '1');
    if (moved > 0) {
      log.info(`图文帖规则生效范围迁移：${moved} 个账号行的 rule_ids 已写入`);
    }
  }

  /**
   * 开播动态（DYNAMIC_TYPE_LIVE_RCMD）彻底舍弃（2026-09-20 用户决策）：它是 B站自动生成的
   * 噪音，开播信息由 live-status 源负责，图文规则也不该把它当「原创帖」推。source 已不再
   * 入库，这里一次性清掉旧库的残留行（settings 闸门；删除不碰 raw 归档哲学——这些行没有
   * 任何消费者，主播卡展示层此前就是过滤掉它们的）。
   */
  private dropLiveRcmdPosts(): void {
    if (this.getSetting(LIVE_RCMD_DROP_KEY)) return;
    const r = this.db
      .prepare(`DELETE FROM posts WHERE platform = 'bili_dynamic' AND type = 'DYNAMIC_TYPE_LIVE_RCMD'`)
      .run();
    this.setSetting(LIVE_RCMD_DROP_KEY, '1');
    if (r.changes > 0) {
      log.info(`开播动态舍弃迁移：清理 ${r.changes} 条 LIVE_RCMD 历史动态`);
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

  /** 记录一场直播（开场快照含 keyframe/cover）并插入首个 segment。已存在则不动（保留原 notified_at/首段）。 */
  recordSession(p: {
    roomId: string; liveTime: number; uid: string;
    uname: string; title: string; areaName: string; parentAreaName: string;
    keyframe?: string; cover?: string;
  }): void {
    const t = now();
    const info = this.db
      .prepare(
        `INSERT INTO live_sessions
           (room_id, live_time, uid, uname, title, area_name, keyframe, cover, first_seen, notified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(room_id, live_time) DO NOTHING`,
      )
      .run(p.roomId, p.liveTime, p.uid, p.uname, p.title, p.areaName,
        p.keyframe ?? null, p.cover ?? null, t);
    // 仅新场次插首段（重复 live_start 是冲突无操作，不能重复开段）
    if (info.changes > 0) {
      this.db
        .prepare(
          `INSERT INTO live_segments
             (room_id, live_time, start_ts, end_ts, title, area_name, parent_area_name, keyframe, created_at)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        )
        .run(p.roomId, p.liveTime, t, p.title, p.areaName, p.parentAreaName,
          p.keyframe ?? null, t);
    }
  }

  /** 在播场次的存活打点（live-status source 每轮随 saveRoomStates 调）：刷 last_seen + 非空 keyframe 覆盖。 */
  touchLiveSessions(entries: Array<{ roomId: string; liveTime: number; keyframe?: string }>): void {
    if (entries.length === 0) return;
    const stmt = this.db.prepare(
      `UPDATE live_sessions SET last_seen = ?,
         keyframe = CASE WHEN ? != '' THEN ? ELSE keyframe END
       WHERE room_id = ? AND live_time = ?`,
    );
    const t = now();
    const tx = this.db.transaction((rows: Array<{ roomId: string; liveTime: number; keyframe?: string }>) => {
      for (const e of rows) stmt.run(t, e.keyframe ?? '', e.keyframe ?? null, e.roomId, e.liveTime);
    });
    tx(entries);
  }

  /**
   * 关键帧缓存落盘一行（sources/media/keyframe.ts 每 interval 一帧）。
   * (room_id, live_time) 是一场直播的身份；path 为本地文件路径，bytes 供体积统计。
   * 只写不查：素材先积累，检索后续做。
   */
  insertSnapshot(p: { roomId: string; liveTime: number; ts: number; path: string; bytes: number }): void {
    this.db
      .prepare('INSERT INTO snapshots (room_id, live_time, ts, path, bytes) VALUES (?, ?, ?, ?, ?)')
      .run(p.roomId, p.liveTime, p.ts, p.path, p.bytes);
  }

  /** 一场直播里距 ts 最近的一帧缓存关键帧（面板 hover 缩略图用）；无缓存返回 null */
  nearestSnapshot(roomId: string, liveTime: number, ts: number): { path: string } | null {
    const row = this.db
      .prepare('SELECT path FROM snapshots WHERE room_id = ? AND live_time = ? ORDER BY ABS(ts - ?) LIMIT 1')
      .get(roomId, liveTime, ts) as { path: string } | undefined;
    return row ?? null;
  }

  /**
   * live_end 归档：关闭该房间 first_seen 最新的一场（last_seen 取大、开口 segment 以 endTs 收尾）。
   * 不带 liveTime：live_end 信号里它不可靠（下播合成状态 liveTime=0；下播又开播的成对信号里
   * 带的是新一场的 liveTime），而 pipeline 在信号的同步前缀里按序归档（endSession 先于配对
   * live_start 的 recordSession 执行），所以此刻该房间最新一场就是要结束的那场。
   */
  endSession(roomId: string, endTs: number): void {
    const s = this.db
      .prepare('SELECT live_time FROM live_sessions WHERE room_id = ? ORDER BY first_seen DESC LIMIT 1')
      .get(roomId) as { live_time: number } | undefined;
    if (!s) return;
    this.db
      .prepare('UPDATE live_sessions SET last_seen = MAX(COALESCE(last_seen, 0), ?) WHERE room_id = ? AND live_time = ?')
      .run(endTs, roomId, s.live_time);
    this.db
      .prepare('UPDATE live_segments SET end_ts = ? WHERE room_id = ? AND live_time = ? AND end_ts IS NULL')
      .run(endTs, roomId, s.live_time);
  }

  /** title_change 归档：关闭当前开口 segment（end_ts = ts）并以新内容开下一段。场次不存在则不动。 */
  rotateSegment(
    roomId: string, liveTime: number, ts: number,
    seg: { title: string; areaName: string; parentAreaName: string; keyframe?: string },
  ): void {
    const exists = this.db
      .prepare('SELECT 1 FROM live_sessions WHERE room_id = ? AND live_time = ?')
      .get(roomId, liveTime);
    if (!exists) return;
    const tx = this.db.transaction(() => {
      this.db
        .prepare('UPDATE live_segments SET end_ts = ? WHERE room_id = ? AND live_time = ? AND end_ts IS NULL')
        .run(ts, roomId, liveTime);
      this.db
        .prepare(
          `INSERT INTO live_segments
             (room_id, live_time, start_ts, end_ts, title, area_name, parent_area_name, keyframe, created_at)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        )
        .run(roomId, liveTime, ts, seg.title, seg.areaName, seg.parentAreaName,
          seg.keyframe ?? null, now());
    });
    tx();
  }

  /**
   * 时间轴组装（/api/schedule）：first_seen 落在 [fromTs, toTs) 的场次 + 其 segments +
   * verdicts + 主播信息（alias/uname/face）。三表各查一次（join 场次过滤），JS 按
   * (room_id, live_time) 归并，无 N+1。endTs 语义：在播（last_seen 鲜度窗口内）= null；
   * 已下播 = last_seen，兜底关闭开口段；legacy 无打点场次 = first_seen（零长，前端不画）。
   */
  listTimeline(fromTs: number, toTs: number): TimelineEntry[] {
    const nowTs = now();
    const sessions = this.db
      .prepare('SELECT * FROM live_sessions WHERE first_seen >= ? AND first_seen < ? ORDER BY first_seen')
      .all(fromTs, toTs) as Array<{
        room_id: string; live_time: number; uid: string; uname: string | null;
        title: string | null; area_name: string | null; parent_area_name?: string | null;
        keyframe: string | null; cover: string | null;
        first_seen: number; last_seen: number | null;
      }>;
    if (sessions.length === 0) return [];
    const segRows = this.db
      .prepare(
        `SELECT s.* FROM live_segments s
         JOIN live_sessions ls ON ls.room_id = s.room_id AND ls.live_time = s.live_time
         WHERE ls.first_seen >= ? AND ls.first_seen < ?
         ORDER BY s.start_ts, s.id`,
      )
      .all(fromTs, toTs) as LiveSegmentRow[];
    const verdictRows = this.db
      .prepare(
        `SELECT v.room_id, v.live_time, v.category_name, v.source, v.confidence, v.evidence
         FROM verdicts v
         JOIN live_sessions ls ON ls.room_id = v.room_id AND ls.live_time = v.live_time
         WHERE ls.first_seen >= ? AND ls.first_seen < ?
         ORDER BY v.id`,
      )
      .all(fromTs, toTs) as Array<{
        room_id: string; live_time: number; category_name: string;
        source: 'llm' | 'rule' | 'decision'; confidence: number | null; evidence: string;
      }>;
    const streamerByUid = new Map(this.listStreamers().map((s) => [s.uid, s]));

    const key = (roomId: string, liveTime: number) => `${roomId}:${liveTime}`;
    const segsBySession = new Map<string, TimelineSegment[]>();
    for (const r of segRows) {
      const k = key(r.room_id, r.live_time);
      const list = segsBySession.get(k) ?? [];
      list.push({
        startTs: r.start_ts, endTs: r.end_ts, title: r.title,
        areaName: r.area_name ?? '', parentAreaName: r.parent_area_name ?? '',
      });
      segsBySession.set(k, list);
    }
    const verdictsBySession = new Map<string, TimelineEntry['verdicts']>();
    for (const v of verdictRows) {
      const k = key(v.room_id, v.live_time);
      const list = verdictsBySession.get(k) ?? [];
      list.push({
        categoryName: v.category_name, source: v.source,
        confidence: v.confidence, evidence: v.evidence,
      });
      verdictsBySession.set(k, list);
    }

    return sessions.map((s) => {
      const st = streamerByUid.get(s.uid);
      // 在播判定：last_seen 在打点鲜度窗口内才算在播（endTs=null）；超时未刷新 = 已下播
      // （崩溃/停机错过 live_end 的兜底），legacy 无打点场次终点取 first_seen（零长不画）
      const isLive = s.last_seen != null && nowTs - s.last_seen <= TIMELINE_LIVE_STALE_S;
      const endTs = isLive ? null : (s.last_seen ?? s.first_seen);
      let segments = segsBySession.get(key(s.room_id, s.live_time));
      if (!segments || segments.length === 0) {
        // 旧场次（segments 表建立前归档的）没有段：回退为单段，标题/分区取开场快照
        segments = [{
          startTs: s.first_seen, endTs,
          title: s.title ?? '', areaName: s.area_name ?? '', parentAreaName: '',
        }];
      } else if (!isLive) {
        // 已下播：开口段以场次终点收尾（正常路径 endSession 已关，这里是兜底）
        segments = segments.map((g) => (g.endTs === null ? { ...g, endTs } : g));
      }
      return {
        roomId: s.room_id, liveTime: s.live_time, uid: s.uid,
        name: st ? (st.alias || st.uname) : (s.uname ?? ''),
        uname: st?.uname ?? s.uname ?? '',
        face: st?.face ?? null,
        startTs: s.first_seen, endTs,
        keyframe: s.keyframe, cover: s.cover,
        segments,
        verdicts: verdictsBySession.get(key(s.room_id, s.live_time)) ?? [],
      };
    });
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
    // 防御非数字 uid（如手工种入的演示数据）：B站接口只接受数字 uid，
    // 混入会导致批量接口 65530 route_exception、单 uid 拉取必败
    return rows.map((r) => r.uid).filter((uid) => /^\d+$/.test(uid));
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
      createdBy: input.createdBy !== undefined ? input.createdBy : prev?.createdBy ?? null,
    };
    if (prev) {
      this.db
        .prepare(
          `UPDATE push_rules SET name=?, category_id=?, uids=?, channels=?, message_template=?, enabled=?, created_by=?, updated_at=?
           WHERE id=?`,
        )
        .run(r.name, r.categoryId, JSON.stringify(r.uids), JSON.stringify(r.channels),
          r.messageTemplate, r.enabled ? 1 : 0, r.createdBy ?? null, now(), prev.id);
      return prev.id;
    }
    const t = now();
    const { m } = this.db
      .prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS m FROM push_rules')
      .get() as { m: number };
    const info = this.db
      .prepare(
        `INSERT INTO push_rules (name, category_id, uids, channels, message_template, enabled, created_by, sort, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.name, r.categoryId, JSON.stringify(r.uids), JSON.stringify(r.channels),
        r.messageTemplate, r.enabled ? 1 : 0, r.createdBy ?? null, m, t, t);
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

  // ---- post_rules：图文帖规则（X/推特链路，与 push_rules 平行）----

  /** 面板用：全量规则（含 disabled）。matcher 消费请用 listEnabledPostRules。 */
  listPostRules(): PostRule[] {
    const rows = this.db.prepare('SELECT * FROM post_rules ORDER BY sort, id').all() as PostRuleRow[];
    return rows.map(rowToPostRule);
  }

  /** 全部启用规则，sort 升序（全部命中独立生效，渠道取并集） */
  listEnabledPostRules(): PostRule[] {
    const rows = this.db
      .prepare('SELECT * FROM post_rules WHERE enabled = 1 ORDER BY sort, id')
      .all() as PostRuleRow[];
    return rows.map(rowToPostRule);
  }

  private getPostRule(id: number): PostRule | undefined {
    const row = this.db.prepare('SELECT * FROM post_rules WHERE id = ?').get(id) as PostRuleRow | undefined;
    return row ? rowToPostRule(row) : undefined;
  }

  /** 带 id 且存在 = 改行（未提供字段保留原值）；否则建行（空名补「图文帖规则 N」，排到末尾） */
  upsertPostRule(input: PostRuleInput): number {
    const prev = input.id !== undefined ? this.getPostRule(input.id) : undefined;
    const filters: PostFilters = {
      ...(prev?.filters ?? defaultPostFilters()),
      ...(input.filters ?? {}),
    };
    const r: NewPostRule = {
      name: input.name !== undefined ? input.name : prev?.name ?? '',
      channels: input.channels ?? prev?.channels ?? [],
      filters,
      messageTemplate: input.messageTemplate !== undefined
        ? input.messageTemplate : prev?.messageTemplate ?? null,
      llmJudge: input.llmJudge ?? prev?.llmJudge ?? false,
      judgePrompt: input.judgePrompt !== undefined ? input.judgePrompt : prev?.judgePrompt ?? null,
      llmTranslate: input.llmTranslate ?? prev?.llmTranslate ?? false,
      enabled: input.enabled ?? prev?.enabled ?? true,
    };
    // account_ids 是旧设计的遗留列（生效范围已搬到账号侧 rule_ids）：保留不删，写入侧恒 '[]'。
    // platform 列同理（规则已平台无关）：UPDATE 不触碰，INSERT 靠列默认值 'twitter' 占位。
    if (prev) {
      this.db
        .prepare(
          `UPDATE post_rules SET name=?, account_ids='[]', channels=?, filters=?, message_template=?,
             llm_judge=?, judge_prompt=?, llm_translate=?, enabled=?, updated_at=?
           WHERE id=?`,
        )
        .run(r.name, JSON.stringify(r.channels), JSON.stringify(r.filters),
          r.messageTemplate, r.llmJudge ? 1 : 0, r.judgePrompt, r.llmTranslate ? 1 : 0,
          r.enabled ? 1 : 0, now(), prev.id);
      return prev.id;
    }
    const t = now();
    const { m } = this.db
      .prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS m FROM post_rules')
      .get() as { m: number };
    const info = this.db
      .prepare(
        `INSERT INTO post_rules
           (name, account_ids, channels, filters, message_template,
            llm_judge, judge_prompt, llm_translate, enabled, sort, created_at, updated_at)
         VALUES (?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.name, JSON.stringify(r.channels), JSON.stringify(r.filters),
        r.messageTemplate, r.llmJudge ? 1 : 0, r.judgePrompt, r.llmTranslate ? 1 : 0,
        r.enabled ? 1 : 0, m, t, t);
    const id = Number(info.lastInsertRowid);
    if (!r.name) {
      this.db.prepare('UPDATE post_rules SET name = ?, updated_at = ? WHERE id = ?').run(`图文帖规则 ${id}`, t, id);
    }
    return id;
  }

  deletePostRule(id: number): boolean {
    return this.db.prepare('DELETE FROM post_rules WHERE id = ?').run(id).changes > 0;
  }

  /** 拖拽排序：ids 是全部规则的全排列，按数组顺序重写 sort */
  reorderPostRules(ids: number[]): void {
    const tx = this.db.transaction(() => {
      const stmt = this.db.prepare('UPDATE post_rules SET sort = ?, updated_at = ? WHERE id = ?');
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

  /**
   * 主播卡第三栏（混排）：每个主播各取最近 perUid 条 —— B站动态（`posts.uid` = 主播 uid）
   * + 该主播**关联微博账号**的微博（`posts.uid` = 微博 uid，`platform='weibo'`）。
   *
   * 微博成为独立来源后帖子归属改成了微博账号自身（同 X），"这条微博属于哪个主播"由
   * `weibo_accounts.bili_uid` 这条可选关联反查——所以主播卡第三栏的行为对用户没有变化，
   * 而未关联任何主播的微博账号（独立博主）不会串进主播卡。
   */
  listRecentPostsMixed(streamerUids: string[], perUid: number): Map<string, Post[]> {
    const out = new Map<string, Post[]>();
    if (streamerUids.length === 0 || perUid <= 0) return out;
    const ph = streamerUids.map(() => '?').join(',');
    const links = this.db
      .prepare(`SELECT uid, bili_uid FROM weibo_accounts WHERE bili_uid IN (${ph})`)
      .all(...streamerUids) as Array<{ uid: string; bili_uid: string }>;
    const weiboToBili = new Map(links.map((l) => [l.uid, l.bili_uid]));
    const uids = [...new Set([...streamerUids, ...links.map((l) => l.uid)])];
    const rows = this.db
      .prepare(
        `SELECT * FROM posts WHERE uid IN (${uids.map(() => '?').join(',')})
          ORDER BY pub_ts DESC, id DESC`,
      )
      .all(...uids) as PostRow[];
    for (const uid of streamerUids) out.set(uid, []);
    for (const r of rows) {
      const owners: string[] = [];
      // B站动态：uid 就是主播；微博：反查它关联的主播（防 uid 数字撞车，用 platform 卡死语义）
      if (r.platform !== 'weibo' && streamerUids.includes(r.uid)) owners.push(r.uid);
      const bili = weiboToBili.get(r.uid);
      if (bili && r.platform === 'weibo' && !owners.includes(bili)) owners.push(bili);
      for (const o of owners) {
        const list = out.get(o)!;
        if (list.length < perUid) list.push(rowToPost(r));
      }
    }
    return out;
  }

  /**
   * 归档检索（MCP search_posts 用）：uid / platform / 正文关键词（LIKE 子串，转义 %_\) 过滤，
   * 按 pub_ts 倒序，limit 钳 1~50。结果含 raw，调用方按需裁剪。
   */
  searchPosts(q: { uid?: string; platform?: string; keyword?: string; limit?: number }): Post[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (q.uid) { where.push('uid = ?'); args.push(q.uid); }
    if (q.platform) { where.push('platform = ?'); args.push(q.platform); }
    if (q.keyword) {
      where.push("text LIKE ? ESCAPE '\\'");
      args.push(`%${q.keyword.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    const limit = Math.max(1, Math.min(50, Math.floor(q.limit ?? 20)));
    const rows = this.db
      .prepare(`SELECT * FROM posts${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
                ORDER BY pub_ts DESC, id DESC LIMIT ?`)
      .all(...args, limit) as PostRow[];
    return rows.map(rowToPost);
  }

  // ---- x_accounts：X/推特独立关注名单（独立于 streamers/follows，见 core/x-accounts.ts）----

  /** 名单（enabled 升序无意义，按 screen_name 稳定排序方便面板对照） */
  listXAccounts(onlyEnabled = false): XAccount[] {
    const sql = 'SELECT * FROM x_accounts' + (onlyEnabled ? ' WHERE enabled = 1' : '') + ' ORDER BY screen_name';
    return (this.db.prepare(sql).all() as XAccountRow[]).map(rowToXAccount);
  }

  getXAccount(id: number): XAccount | undefined {
    const row = this.db.prepare('SELECT * FROM x_accounts WHERE id = ?').get(id) as XAccountRow | undefined;
    return row ? rowToXAccount(row) : undefined;
  }

  getXAccountByScreenName(screenName: string): XAccount | undefined {
    const row = this.db
      .prepare('SELECT * FROM x_accounts WHERE screen_name = ?')
      .get(normalizeScreenName(screenName)) as XAccountRow | undefined;
    return row ? rowToXAccount(row) : undefined;
  }

  /**
   * 带 id 且存在 = 改行（未提供字段保留原值）；否则按 screen_name 建行。
   * screen_name 撞 UNIQUE（同一账号加两遍）时抛错，由面板转成 409——不做静默合并，
   * 免得用户以为改动生效了其实改的是另一行。返回名单行 id。
   */
  upsertXAccount(input: XAccountInput): number {
    const prev = input.id !== undefined ? this.getXAccount(input.id) : undefined;
    const screenName = normalizeScreenName(input.screenName ?? prev?.screenName ?? '');
    if (prev) {
      // 重新启用 = 主动暂停结束：置恢复位，恢复轮询的首轮静默（停用期间的帖子不补推）
      const reEnabled = !prev.enabled && (input.enabled ?? prev.enabled);
      this.db
        .prepare(
          `UPDATE x_accounts SET screen_name=?, nickname=?, display_name=?, bili_uid=?, enabled=?, rule_ids=?, silent_next=?, updated_at=? WHERE id=?`,
        )
        .run(
          screenName,
          input.nickname !== undefined ? input.nickname : prev.nickname,
          input.displayName !== undefined ? input.displayName : prev.displayName,
          input.biliUid !== undefined ? input.biliUid : prev.biliUid,
          (input.enabled ?? prev.enabled) ? 1 : 0,
          JSON.stringify(input.ruleIds ?? prev.ruleIds),
          reEnabled || prev.silentNext ? 1 : 0,
          now(),
          prev.id,
        );
      return prev.id;
    }
    const t = now();
    const info = this.db
      .prepare(
        `INSERT INTO x_accounts
           (screen_name, nickname, display_name, bili_uid, enabled, rule_ids, last_tweet_id, last_tweet_at, last_ok_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        screenName,
        input.nickname ?? null,
        input.displayName ?? null,
        input.biliUid ?? null,
        (input.enabled ?? true) ? 1 : 0,
        JSON.stringify(input.ruleIds ?? []),
        t,
        t,
      );
    return Number(info.lastInsertRowid);
  }

  deleteXAccount(id: number): boolean {
    return this.db.prepare('DELETE FROM x_accounts WHERE id = ?').run(id).changes > 0;
  }

  /** 抓取回写：只更新传入的字段（游标只往前推由调用方保证；昵称拿到非空才写，不擦好名字） */
  touchXAccount(id: number, touch: XAccountFetchTouch): void {
    const sets: string[] = [];
    const args: Array<string | number | null> = [];
    if (touch.lastTweetId !== undefined) { sets.push('last_tweet_id = ?'); args.push(touch.lastTweetId); }
    if (touch.lastTweetAt !== undefined) { sets.push('last_tweet_at = ?'); args.push(touch.lastTweetAt); }
    if (touch.lastOkAt !== undefined) { sets.push('last_ok_at = ?'); args.push(touch.lastOkAt); }
    if (touch.nickname) { sets.push('nickname = ?'); args.push(touch.nickname); }
    if (touch.avatar !== undefined) { sets.push('avatar = ?'); args.push(touch.avatar); }
    if (touch.silentNext !== undefined) { sets.push('silent_next = ?'); args.push(touch.silentNext ? 1 : 0); }
    if (touch.fetchFail !== undefined) {
      sets.push('fetch_fail_since = ?', 'fetch_error = ?');
      args.push(touch.fetchFail ? touch.fetchFail.since : null, touch.fetchFail ? touch.fetchFail.error : null);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    args.push(now(), id);
    this.db.prepare(`UPDATE x_accounts SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }

  /** 图文开关手动关→手动开（setListen 调用）：全部启用账号进入「恢复轮静默」 */
  markXAccountsSilentNext(): void {
    this.db.prepare('UPDATE x_accounts SET silent_next = 1, updated_at = ? WHERE enabled = 1').run(now());
  }

  // ---- weibo_accounts：微博独立名单（独立于 streamers，见 core/weibo-accounts.ts）----

  /** 名单（按 uid 稳定排序，方便面板对照） */
  listWeiboAccounts(onlyEnabled = false): WeiboAccount[] {
    const sql = 'SELECT * FROM weibo_accounts' + (onlyEnabled ? ' WHERE enabled = 1' : '') + ' ORDER BY uid';
    return (this.db.prepare(sql).all() as WeiboAccountRow[]).map(rowToWeiboAccount);
  }

  getWeiboAccount(id: number): WeiboAccount | undefined {
    const row = this.db.prepare('SELECT * FROM weibo_accounts WHERE id = ?').get(id) as WeiboAccountRow | undefined;
    return row ? rowToWeiboAccount(row) : undefined;
  }

  getWeiboAccountByUid(uid: string): WeiboAccount | undefined {
    const row = this.db.prepare('SELECT * FROM weibo_accounts WHERE uid = ?').get(uid) as WeiboAccountRow | undefined;
    return row ? rowToWeiboAccount(row) : undefined;
  }

  /**
   * 带 id 且存在 = 改行（未提供字段保留原值）；否则按 uid 建行。
   * uid 撞 UNIQUE（同一账号加两遍）时抛错，由面板转成 409——不做静默合并。
   */
  upsertWeiboAccount(input: WeiboAccountInput): number {
    const prev = input.id !== undefined ? this.getWeiboAccount(input.id) : undefined;
    const uid = (input.uid ?? prev?.uid ?? '').trim();
    if (prev) {
      // 重新启用 = 主动暂停结束：置恢复位，恢复轮询的首轮静默（停用期间的帖子不补推）
      const reEnabled = !prev.enabled && (input.enabled ?? prev.enabled);
      this.db
        .prepare('UPDATE weibo_accounts SET uid=?, nickname=?, display_name=?, bili_uid=?, enabled=?, rule_ids=?, silent_next=?, updated_at=? WHERE id=?')
        .run(
          uid,
          input.nickname !== undefined ? input.nickname : prev.nickname,
          input.displayName !== undefined ? input.displayName : prev.displayName,
          input.biliUid !== undefined ? input.biliUid : prev.biliUid,
          (input.enabled ?? prev.enabled) ? 1 : 0,
          JSON.stringify(input.ruleIds ?? prev.ruleIds),
          reEnabled || prev.silentNext ? 1 : 0,
          now(),
          prev.id,
        );
      return prev.id;
    }
    const t = now();
    const info = this.db
      .prepare(
        `INSERT INTO weibo_accounts
           (uid, nickname, display_name, bili_uid, enabled, rule_ids, last_post_id, last_post_at, last_ok_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
      )
      .run(uid, input.nickname ?? null, input.displayName ?? null, input.biliUid ?? null,
        (input.enabled ?? true) ? 1 : 0, JSON.stringify(input.ruleIds ?? []), t, t);
    return Number(info.lastInsertRowid);
  }

  deleteWeiboAccount(id: number): boolean {
    return this.db.prepare('DELETE FROM weibo_accounts WHERE id = ?').run(id).changes > 0;
  }

  /** 抓取回写：只更新传入的字段（游标只往前推由调用方保证） */
  touchWeiboAccount(id: number, touch: WeiboAccountFetchTouch): void {
    const sets: string[] = [];
    const args: Array<string | number | null> = [];
    if (touch.lastPostId !== undefined) { sets.push('last_post_id = ?'); args.push(touch.lastPostId); }
    if (touch.lastPostAt !== undefined) { sets.push('last_post_at = ?'); args.push(touch.lastPostAt); }
    if (touch.lastOkAt !== undefined) { sets.push('last_ok_at = ?'); args.push(touch.lastOkAt); }
    if (touch.nickname) { sets.push('nickname = ?'); args.push(touch.nickname); }
    if (touch.avatar !== undefined) { sets.push('avatar = ?'); args.push(touch.avatar); }
    if (touch.silentNext !== undefined) { sets.push('silent_next = ?'); args.push(touch.silentNext ? 1 : 0); }
    if (touch.fetchFail !== undefined) {
      sets.push('fetch_fail_since = ?', 'fetch_error = ?');
      args.push(touch.fetchFail ? touch.fetchFail.since : null, touch.fetchFail ? touch.fetchFail.error : null);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    args.push(now(), id);
    this.db.prepare(`UPDATE weibo_accounts SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }

  /** 图文开关手动关→手动开（setListen 调用）：全部启用账号进入「恢复轮静默」 */
  markWeiboAccountsSilentNext(): void {
    this.db.prepare('UPDATE weibo_accounts SET silent_next = 1, updated_at = ? WHERE enabled = 1').run(now());
  }

  /** 解除某主播的微博关联（主播详情清空微博昵称时用）；账号行保留，历史微博不删 */
  unlinkWeiboAccountsFromBili(biliUid: string): number {
    return this.db
      .prepare('UPDATE weibo_accounts SET bili_uid = NULL, updated_at = ? WHERE bili_uid = ?')
      .run(now(), biliUid).changes;
  }

  // ---- bili_accounts：B站动态独立账号名单（独立于 streamers，见 core/bili-accounts.ts）----

  /** 名单（按 uid 稳定排序，方便面板对照） */
  listBiliAccounts(onlyEnabled = false): BiliAccount[] {
    const sql = 'SELECT * FROM bili_accounts' + (onlyEnabled ? ' WHERE enabled = 1' : '') + ' ORDER BY uid';
    return (this.db.prepare(sql).all() as BiliAccountRow[]).map(rowToBiliAccount);
  }

  getBiliAccount(id: number): BiliAccount | undefined {
    const row = this.db.prepare('SELECT * FROM bili_accounts WHERE id = ?').get(id) as BiliAccountRow | undefined;
    return row ? rowToBiliAccount(row) : undefined;
  }

  getBiliAccountByUid(uid: string): BiliAccount | undefined {
    const row = this.db.prepare('SELECT * FROM bili_accounts WHERE uid = ?').get(uid) as BiliAccountRow | undefined;
    return row ? rowToBiliAccount(row) : undefined;
  }

  /**
   * 带 id 且存在 = 改行（未提供字段保留原值）；否则按 uid 建行。
   * uid 撞 UNIQUE（同一账号加两遍）时抛错，由面板转成 409——不做静默合并。
   * uname 是平台事实（抓取经 touchBiliAccount 回写），输入面不收。
   */
  upsertBiliAccount(input: BiliAccountInput): number {
    const prev = input.id !== undefined ? this.getBiliAccount(input.id) : undefined;
    const uid = (input.uid ?? prev?.uid ?? '').trim();
    if (prev) {
      // 重新启用 = 主动暂停结束：置恢复位，恢复轮询的首轮静默（停用期间的帖子不补推）
      const reEnabled = !prev.enabled && (input.enabled ?? prev.enabled);
      this.db
        .prepare('UPDATE bili_accounts SET uid=?, display_name=?, enabled=?, rule_ids=?, silent_next=?, updated_at=? WHERE id=?')
        .run(
          uid,
          input.displayName !== undefined ? input.displayName : prev.displayName,
          (input.enabled ?? prev.enabled) ? 1 : 0,
          JSON.stringify(input.ruleIds ?? prev.ruleIds),
          reEnabled || prev.silentNext ? 1 : 0,
          now(),
          prev.id,
        );
      return prev.id;
    }
    const t = now();
    const info = this.db
      .prepare(
        `INSERT INTO bili_accounts
           (uid, display_name, enabled, rule_ids, last_ok_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(uid, input.displayName ?? null,
        (input.enabled ?? true) ? 1 : 0, JSON.stringify(input.ruleIds ?? []), t, t);
    return Number(info.lastInsertRowid);
  }

  deleteBiliAccount(id: number): boolean {
    return this.db.prepare('DELETE FROM bili_accounts WHERE id = ?').run(id).changes > 0;
  }

  /** 抓取回写：只更新传入的字段（uname 空值不回写——抓到空不该把好名字擦掉） */
  touchBiliAccount(id: number, touch: BiliAccountFetchTouch): void {
    const sets: string[] = [];
    const args: Array<string | number | null> = [];
    if (touch.uname) { sets.push('uname = ?'); args.push(touch.uname); }
    if (touch.lastOkAt !== undefined) { sets.push('last_ok_at = ?'); args.push(touch.lastOkAt); }
    if (touch.avatar !== undefined) { sets.push('avatar = ?'); args.push(touch.avatar); }
    if (touch.silentNext !== undefined) { sets.push('silent_next = ?'); args.push(touch.silentNext ? 1 : 0); }
    if (touch.fetchFail !== undefined) {
      sets.push('fetch_fail_since = ?', 'fetch_error = ?');
      args.push(touch.fetchFail ? touch.fetchFail.since : null, touch.fetchFail ? touch.fetchFail.error : null);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    args.push(now(), id);
    this.db.prepare(`UPDATE bili_accounts SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }

  /** 图文开关手动关→手动开（setListen 调用）：全部启用账号进入「恢复轮静默」 */
  markBiliAccountsSilentNext(): void {
    this.db.prepare('UPDATE bili_accounts SET silent_next = 1, updated_at = ? WHERE enabled = 1').run(now());
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
