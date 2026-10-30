import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { makeLogger } from '../logger.js';
import type { PrevState } from './state.js';
import type { AnalysisAudit, ContentAudit, PushAudit } from './content-audit.js';
import {
  rowToFollow, rowToStreamer,
  type Follow, type FollowRow, type Streamer, type StreamerInput, type StreamerRow,
} from './streamers.js';
import {
  rowToCategory, rowToChannel, rowToPrimaryVerdict, rowToRule, rowToVerdict, serializeJudgeConditions,
  type Category, type CategoryInput, type CategoryRow, type NewCategory,
  type NewPrimaryVerdict, type NewPushChannel, type NewPushRule, type NewVerdict,
  type PrimaryVerdict, type PrimaryVerdictRow,
  type PushChannel, type PushChannelInput, type PushChannelRow,
  type PushRule, type PushRuleInput, type PushRuleRow,
  type Verdict, type VerdictRow, type VerdictSubjectType,
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
  parseFilters,
} from './post-rules.js';

const log = makeLogger('core/db');

/**
 * verdicts 建表 DDL（SCHEMA 首建与两次重建迁移共用，表名参数化防多处漂移）。
 * 身份键 = (subject_type, subject_id)：live = `room_id:live_time`、post = `platform:item_id`；
 * category_id / rule_id 的 0 是「不适用」哨兵（不用 NULL——SQLite UNIQUE 对 NULL 不去重）。
 * 唯一键带 source：同一分类的确定性结论与模型结论各自留痕，`effective` 标出生效的那一条。
 */
const verdictsDdl = (name: string) => `
CREATE TABLE IF NOT EXISTS ${name} (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_type  TEXT    NOT NULL CHECK(subject_type IN ('live','post')),
  subject_id    TEXT    NOT NULL,
  uid           TEXT    NOT NULL,
  category_id   INTEGER NOT NULL DEFAULT 0,
  rule_id       INTEGER NOT NULL DEFAULT 0,
  category_name TEXT    NOT NULL,
  source        TEXT    NOT NULL CHECK(source IN ('llm','rule','decision')),
  pass          INTEGER NOT NULL DEFAULT 1,
  confidence    REAL,
  evidence      TEXT    NOT NULL DEFAULT '',
  effective     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  UNIQUE(subject_type, subject_id, category_id, rule_id, source)
)`;

/**
 * primary_verdicts 建表 DDL：主分类判定（单选）。
 * UNIQUE(subject_type, subject_id, source) —— 同一主体的每个来源至多一条，`effective` 标出展示用的那一条；
 * category_id 的 0 = 「其他」（主分类组里都不像）。
 */
const primaryVerdictsDdl = `
CREATE TABLE IF NOT EXISTS primary_verdicts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_type  TEXT    NOT NULL CHECK(subject_type IN ('live','post')),
  subject_id    TEXT    NOT NULL,
  uid           TEXT    NOT NULL,
  category_id   INTEGER NOT NULL DEFAULT 0,
  category_name TEXT    NOT NULL DEFAULT '',
  source        TEXT    NOT NULL CHECK(source IN ('llm','rule','decision')),
  distribution  TEXT,
  evidence      TEXT    NOT NULL DEFAULT '',
  effective     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  UNIQUE(subject_type, subject_id, source)
)`;

/**
 * push_rules 建表 DDL（SCHEMA 首建与 uids→scope 形态迁移重建共用，表名参数化防两处漂移）。
 * scope 语义：live = 主播 uid 列表 / post = 账号引用（`twitter:screenName`/`weibo:uid`/`bili:uid`）；空 = 全部生效。
 */
const pushRulesDdl = (name: string) => `
CREATE TABLE IF NOT EXISTS ${name} (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL DEFAULT '',
  subject_kind     TEXT    NOT NULL DEFAULT 'live' CHECK(subject_kind IN ('live','post')),
  category_id      INTEGER,
  scope            TEXT    NOT NULL DEFAULT '[]',
  channels         TEXT    NOT NULL DEFAULT '[]',
  message_template TEXT,
  llm_translate    INTEGER NOT NULL DEFAULT 0,
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_by       TEXT,
  sort             INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
)`;

// 三张账号名单的建表 DDL（SCHEMA 首建与 rule_ids 列删除重建共用）。列集 = SCHEMA 基列
// + ensureColumn 在线补列（silent_next / fetch_fail_* / avatar / nickname / display_name），
// 重建迁移要拷全部列，缺一列就是丢数据。
const xAccountsDdl = (name: string) => `
CREATE TABLE IF NOT EXISTS ${name} (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  screen_name      TEXT    NOT NULL UNIQUE,
  nickname         TEXT,
  display_name     TEXT,
  bili_uid         TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  last_tweet_id    TEXT,
  last_tweet_at    INTEGER,
  last_ok_at       INTEGER,
  avatar           TEXT,
  silent_next      INTEGER NOT NULL DEFAULT 0,
  fetch_fail_since INTEGER,
  fetch_error      TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
)`;

const weiboAccountsDdl = (name: string) => `
CREATE TABLE IF NOT EXISTS ${name} (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  uid              TEXT    NOT NULL UNIQUE,
  nickname         TEXT,
  display_name     TEXT,
  bili_uid         TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  last_post_id     TEXT,
  last_post_at     INTEGER,
  last_ok_at       INTEGER,
  avatar           TEXT,
  silent_next      INTEGER NOT NULL DEFAULT 0,
  fetch_fail_since INTEGER,
  fetch_error      TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
)`;

const biliAccountsDdl = (name: string) => `
CREATE TABLE IF NOT EXISTS ${name} (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  uid              TEXT    NOT NULL UNIQUE,
  uname            TEXT,
  display_name     TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  last_ok_at       INTEGER,
  avatar           TEXT,
  silent_next      INTEGER NOT NULL DEFAULT 0,
  fetch_fail_since INTEGER,
  fetch_error      TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
)`;

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
CREATE TABLE IF NOT EXISTS service_runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at         INTEGER NOT NULL,
  last_heartbeat_at  INTEGER NOT NULL,
  stopped_at         INTEGER,
  stop_kind          TEXT
);
CREATE INDEX IF NOT EXISTS idx_service_runs_started ON service_runs (started_at);
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
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  llm_prompt    TEXT,
  judge_mode    TEXT    NOT NULL DEFAULT 'simple' CHECK(judge_mode IN ('simple','precise')),
  judge_conditions TEXT NOT NULL DEFAULT '[]',
  keywords      TEXT    NOT NULL DEFAULT '[]',
  areas         TEXT    NOT NULL DEFAULT '[]',
  applies_to    TEXT    NOT NULL DEFAULT 'live' CHECK(applies_to IN ('live','post')),
  post_types    TEXT    NOT NULL DEFAULT '[]',
  require_quote INTEGER NOT NULL DEFAULT 0,
  require_media INTEGER NOT NULL DEFAULT 0,
  cond_mode     TEXT    NOT NULL DEFAULT 'and' CHECK(cond_mode IN ('and','or')),
  is_primary    INTEGER NOT NULL DEFAULT 0,
  enabled       INTEGER NOT NULL DEFAULT 1,
  sort          INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
${verdictsDdl('verdicts')};
${primaryVerdictsDdl};
${pushRulesDdl('push_rules')};
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
${xAccountsDdl('x_accounts')};
${weiboAccountsDdl('weibo_accounts')};
${biliAccountsDdl('bili_accounts')};
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
CREATE TABLE IF NOT EXISTS live_classification_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id      TEXT    NOT NULL,
  live_time    INTEGER NOT NULL,
  trigger_kind TEXT    NOT NULL,
  ts           INTEGER NOT NULL,
  verdicts     TEXT    NOT NULL DEFAULT '[]',
  primary_verdict TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_classification_runs_session
  ON live_classification_runs (room_id, live_time, ts);
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

/** listTimeline 在播判定：last_seen 超过该秒数未刷新 = 已下播（崩溃/停机错过 live_end 的兜底）。
 *  轮询间隔可配到 1 小时，scheduleInfo 会按「2 × 轮询间隔 + 60s」放宽，这里只是下限。 */
const TIMELINE_LIVE_STALE_S = 600;

/** live_time 的合理回溯上限：超过这个年龄只能是脏数据（legacy/异常时钟），起点回退 first_seen。
 *  B站单场直播不可能持续一周；真实长播/停机续播都远低于这个上限。 */
const LIVE_START_MAX_AGE_S = 7 * 86400;

/** 服务心跳的宽限：最后一次心跳超过该秒数仍未更新，在线区间就收在最后一次心跳上。 */
const SERVICE_HEARTBEAT_GRACE_S = 90;

/** 时间轴查询返回的服务在线区间（秒级闭开区间语义，前端只用来画离线灰底） */
export interface ServiceRunInterval {
  startTs: number;
  endTs: number;
}

/** 服务在线记录：online = 查询范围内的在线区间；trackedFrom = 最早一条在线记录的起点 */
export interface ServiceRuns {
  online: ServiceRunInterval[];
  trackedFrom: number | null;
}

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
  /** 真实开播时间（live_time；异常时回退 first_seen） */
  startTs: number;
  /** null = 仍在播；停机期间结束的场次 = 最后一次在线观测 last_seen（不是发现时刻） */
  endTs: number | null;
  keyframe: string | null;
  cover: string | null;
  segments: TimelineSegment[];
  /** 最新一轮的生效且属于的分类结论（判否与未生效行不进时间线） */
  verdicts: Array<{
    categoryName: string;
    source: 'llm' | 'rule' | 'decision';
    confidence: number | null;
    evidence: string;
  }>;
  /** 最新一轮的生效主分类（「其他」或无生效行 = null） */
  primary: { categoryName: string; source: 'llm' | 'rule' | 'decision' } | null;
  /** 历次分类判定（按 ts 升序，含开播初判）；空数组 = 该场还没有历史记录，
   *  前端按旧口径回退 verdicts / primary */
  classificationRuns: LiveClassificationRun[];
}

/** 直播分类时机的历史口径：与 runtime-config 的 LiveClassifyTrigger 同一组值 */
export type LiveClassifyRunTrigger = 'start' | 'startDelay' | 'periodic' | 'titleChange' | 'titleDelay';

/** 一轮判定的历史结论：只收生效且属于的分类（空数组 = 从该时刻起未分类） */
export interface LiveClassificationRunVerdict {
  categoryId: number;
  categoryName: string;
  source: 'llm' | 'rule' | 'decision';
  confidence: number | null;
  evidence: string;
}

/** 一轮判定（一次分类时机到点后的完整结果） */
export interface LiveClassificationRun {
  triggerKind: LiveClassifyRunTrigger;
  /** 判定完成时间（刻意不用触发时间：否则时间表会在结论出现前就展示它） */
  ts: number;
  verdicts: LiveClassificationRunVerdict[];
  /** 生效主分类；categoryId=0 = 「其他」 */
  primary: { categoryId: number; categoryName: string; source: 'llm' | 'rule' | 'decision' } | null;
}

interface LiveClassificationRunRow {
  room_id: string;
  live_time: number;
  trigger_kind: LiveClassifyRunTrigger;
  ts: number;
  verdicts: string;
  primary_verdict: string | null;
}

/**
 * 随机样本渲染用的直播场次行（分类草稿试跑）：live_sessions 的展示字段
 * + 首段（`start_ts` 最小那一段）的 parent_area_name——场次行本身不存父分区。
 */
export interface SampledLiveSession {
  roomId: string;
  liveTime: number;
  uid: string;
  uname: string;
  title: string;
  areaName: string;
  parentAreaName: string;
  keyframe: string;
  cover: string;
}

/** 随机样本查询（两个 sample* 共用）：全部可选；`limit` 由 Db 钳进 1~SAMPLE_LIMIT_MAX */
export interface SampleQuery {
  /** live = 主播 uid；post = 账号标识（X screen name / 微博与B站数字 uid） */
  uid?: string;
  /** 仅 post：平台（bili_dynamic / weibo / twitter） */
  platform?: string;
  fromTs?: number;
  toTs?: number;
  limit?: number;
}

/** 分类草稿试跑一次最多看多少条样本（面板请求上限，Db 兜底钳制也用它） */
export const SAMPLE_LIMIT_MAX = 20;

/** 样本条数：缺省 10（面板默认），钳进 1~SAMPLE_LIMIT_MAX */
function sampleLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(SAMPLE_LIMIT_MAX, Math.floor(limit ?? 10)));
}

/**
 * 直播样本的投影 SQL：随机抽样与精确读取**共用这一段 SELECT**（复测时拿到的样本与抽样时
 * 逐字段同形，不靠两处手抄对齐）。父分区不在 live_sessions 行上，按 `start_ts` 取**首段**补出来
 * （与时间表首段口径一致）。
 */
const SAMPLED_LIVE_SQL = `SELECT ls.room_id, ls.live_time, ls.uid, ls.uname, ls.title,
         ls.area_name, ls.keyframe, ls.cover,
         (SELECT seg.parent_area_name FROM live_segments seg
           WHERE seg.room_id = ls.room_id AND seg.live_time = ls.live_time
           ORDER BY seg.start_ts, seg.id LIMIT 1) AS parent_area_name
    FROM live_sessions ls`;

interface SampledLiveRow {
  room_id: string;
  live_time: number;
  uid: string;
  uname: string | null;
  title: string | null;
  area_name: string | null;
  parent_area_name: string | null;
  keyframe: string | null;
  cover: string | null;
}

/** 直播样本池条件：关键帧 / 封面至少有一个（空串与 NULL 都算没有） */
const SAMPLED_LIVE_HAS_IMAGE = "(COALESCE(ls.keyframe, '') <> '' OR COALESCE(ls.cover, '') <> '')";

/**
 * 图文样本池条件：pics 是**非空 JSON 数组**。用 SQLite 的 JSON 函数而不是 LIKE 猜：
 * `pics` 是 TEXT，`'[]'` / `'[ ]'` / `'{}'` / 历史脏值都得判对。`json_array_length` 对非数组回 0、
 * 对坏 JSON 直接报错，所以先过 `json_valid`（CASE 而非 AND，避免求值顺序把坏 JSON 送进 json 函数）。
 */
const SAMPLED_POST_HAS_IMAGE = 'CASE WHEN json_valid(pics) THEN json_array_length(pics) ELSE 0 END > 0';

/** 投影行 → 样本（空值读成空串：渲染层只做拼接，不再逐处判 null） */
function rowToSampledLive(r: SampledLiveRow): SampledLiveSession {
  return {
    roomId: r.room_id, liveTime: r.live_time, uid: r.uid,
    uname: r.uname ?? '', title: r.title ?? '', areaName: r.area_name ?? '',
    parentAreaName: r.parent_area_name ?? '',
    keyframe: r.keyframe ?? '', cover: r.cover ?? '',
  };
}

export class Db {
  private readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.db.exec(`CREATE TABLE IF NOT EXISTS content_audit (
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      analysis TEXT,
      push TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (subject_type, subject_id)
    )`);
    // 存量库迁移：room_state 展示字段（last_live_at = 最后一次观测到在播的时间，下播时长锚点）
    for (const ddl of ['area_name TEXT', 'parent_area_name TEXT', 'keyframe TEXT',
      'cover TEXT', 'online INTEGER', 'last_live_at INTEGER']) {
      this.ensureColumn('room_state', ddl.split(' ')[0]!, ddl);
    }
    this.ensureColumn('streamers', 'face', 'face TEXT');
    this.ensureColumn('follows', 'face', 'face TEXT');
    // live_sessions 时间轴字段：last_seen = 最后一次在线观测到在播；end_seen = 在线期间
    // 观测到的下播；closed_at = 判定该场结束的时刻（停机期间结束则 end_seen 为空）。
    // keyframe/cover 开场快照 + 在播刷新，供时间表 hover 缩略图
    this.ensureColumn('live_sessions', 'last_seen', 'last_seen INTEGER');
    this.ensureColumn('live_sessions', 'end_seen', 'end_seen INTEGER');
    this.ensureColumn('live_sessions', 'closed_at', 'closed_at INTEGER');
    this.ensureColumn('live_sessions', 'keyframe', 'keyframe TEXT');
    this.ensureColumn('live_sessions', 'cover', 'cover TEXT');
    // streamers 三开关（watch/analyze/notify）替代旧 mode 列
    this.ensureColumn('streamers', 'watch', 'watch INTEGER NOT NULL DEFAULT 1');
    this.ensureColumn('streamers', 'notify', 'notify INTEGER NOT NULL DEFAULT 1');
    this.ensureColumn('streamers', 'weibo_nick', 'weibo_nick TEXT');
    // push_channels 展示顺序（面板拖拽排序；旧库默认全 0 按 id 稳定）
    this.ensureColumn('push_channels', 'sort', 'sort INTEGER NOT NULL DEFAULT 0');
    // push_rules 创建来源（MCP 群自助规则标记 'mcp'，权限隔离用；面板/人工规则为 NULL）。
    // 旧库（uids 列）随后由 migratePushRuleScopeShape 整表重建成本形状，这里只是防中间态缺列
    this.ensureColumn('push_rules', 'created_by', 'created_by TEXT');
    // categories 吸收图文 filters/judgePrompt（A.1）：适用内容类型 + 帖子类型/引用/带图条件组。
    // 旧库在线补列（SQLite ALTER 加不了 CHECK，取值由输入层校验）；旧数据全是直播分类，默认即正确
    this.ensureColumn('categories', 'applies_to', "applies_to TEXT NOT NULL DEFAULT 'live'");
    this.ensureColumn('categories', 'post_types', "post_types TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn('categories', 'require_quote', 'require_quote INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('categories', 'require_media', 'require_media INTEGER NOT NULL DEFAULT 0');
    // 分类「主分类」勾选（主分类判定的候选集；旧库在线补列，默认 0 = 不进主分类组）
    this.ensureColumn('categories', 'is_primary', 'is_primary INTEGER NOT NULL DEFAULT 0');
    // 分类判定模式（simple = 一句判定描述 / precise = 逐条原子条件）。
    // 旧库在线补列 + 默认值 = 存量分类一律 simple，行为与升级前逐字一致（llm_prompt 不动）
    this.ensureColumn('categories', 'judge_mode', "judge_mode TEXT NOT NULL DEFAULT 'simple'");
    this.ensureColumn('categories', 'judge_conditions', "judge_conditions TEXT NOT NULL DEFAULT '[]'");
    // x_accounts 头像（抓取时顺手抠 X 头像 → 代理下载到 cache/x-avatars，存文件名；旧库在线补列）
    this.ensureColumn('x_accounts', 'avatar', 'avatar TEXT');
    // x_accounts 昵称（X 的 display name，与自定义显示名 display_name 分开；旧库的
    // display_name 全是人手填的自定义名——抓取从不写它——留在原列语义不变）
    this.ensureColumn('x_accounts', 'nickname', 'nickname TEXT');
    // weibo_accounts 自定义显示名（卡片优先展示；留空 = 用昵称，同 x_accounts.display_name 语义）
    this.ensureColumn('weibo_accounts', 'display_name', 'display_name TEXT');
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
    // 旧库残留的 post_rules 表（A.3 搬家在下面）：搬家要读 llm_judge/platform 等列，
    // 老库可能没有——只在表还在时补列（表已 DROP 的库这里整段跳过）
    if (this.tableExists('post_rules')) {
      this.ensureColumn('post_rules', 'llm_judge', 'llm_judge INTEGER NOT NULL DEFAULT 0');
      this.ensureColumn('post_rules', 'judge_prompt', 'judge_prompt TEXT');
      this.ensureColumn('post_rules', 'llm_translate', 'llm_translate INTEGER NOT NULL DEFAULT 0');
      this.ensureColumn('post_rules', 'platform', "platform TEXT NOT NULL DEFAULT 'twitter'");
    }
    // 健康告警阈值 2026-11 从轮数口径改为时间口径（秒）：旧键一次性删除
    // （settings 只留 health_alert_toast_after_sec 一个键；旧值是轮数，语义不通不可继承）
    this.db.prepare("DELETE FROM settings WHERE key = 'health_alert_after_failures'").run();
    // weibo_accounts 本身由 SCHEMA 的 CREATE TABLE IF NOT EXISTS 建出；这里只做数据搬家。
    // 迁移次序有依赖（都幂等，详见各方法注释）：
    //   weibo 名单种入 → post_rules 生效范围搬账号侧（老中途库）→ LIVE_RCMD 清理
    //   → verdicts 身份键（→ 老形状的中间态）→ verdicts 判据列（唯一键 + effective）
    //   → push_rules uids→scope 重建 → post_rules 搬家成分类+规则
    //   → 账号表 rule_ids 列删除（须在搬家之后——搬家要反查 rule_ids）
    this.migrateWeiboAccounts();
    this.migratePostRuleScopes();
    this.dropLiveRcmdPosts();
    this.migrateVerdictsSubjectKeys();
    this.migrateVerdictsEffective();
    this.migratePushRuleScopeShape();
    this.migratePostRulesToCategories();
    this.migrateAccountRuleIdsDrop();
    this.migrateProviderIds();
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

  private migrateProviderIds(): void {
    const gate = 'migrated_provider_ids_v1';
    if (this.getSetting(gate)) return;
    this.transaction(() => {
      const migrateList = (setting: string, keyPrefix: string): Array<Record<string, unknown>> => {
        const raw = this.getSetting(setting);
        if (raw === null) return [];
        const providers = JSON.parse(raw) as Array<Record<string, unknown>>;
        const ids = new Set<string>();
        for (const p of providers) {
          let id = typeof p.id === 'string' && p.id ? p.id : randomUUID();
          while (ids.has(id)) id = randomUUID();
          ids.add(id);
          const name = typeof p.name === 'string' ? p.name : '';
          const oldKey = `${keyPrefix}:${name}`;
          const newKey = `${keyPrefix}:${id}`;
          const key = this.getSetting(oldKey);
          if (oldKey !== newKey && key !== null && this.getSetting(newKey) === null) {
            this.setSetting(newKey, key);
          }
          if (oldKey !== newKey) this.deleteSetting(oldKey);
          p.id = id;
        }
        this.setSetting(setting, JSON.stringify(providers));
        return providers;
      };
      const llmProviders = migrateList('llm_providers', 'llm_key');
      migrateList('decision_providers', 'decision_key');
      const selected = this.getSetting('chat_provider');
      const selectedProvider = llmProviders.find((p) => p.name === selected);
      if (selectedProvider) this.setSetting('chat_provider', selectedProvider.id as string);
      this.setSetting(gate, '1');
    });
  }

  /** 缺列则 ALTER TABLE 补上（旧库在线迁移；新列一律可空或带默认值，不动旧数据） */
  private ensureColumn(table: string, column: string, ddl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  }

  private tableExists(table: string): boolean {
    return this.db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table) !== undefined;
  }

  private columnExists(table: string, column: string): boolean {
    return (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .some((c) => c.name === column);
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
   *
   * 这是**更早一轮**的中途迁移（2026-09 图文规则重构）：post_rules 表已被 A.3 搬家 DROP、
   * 账号 rule_ids 列已被 A.2 删除——两者任一不存在即视为本轮早已完成/无需做，直接落闸跳过。
   */
  private migratePostRuleScopes(): void {
    if (this.getSetting(POST_RULE_SCOPE_MIGRATION_KEY)) return;
    if (!this.tableExists('post_rules')) {
      this.setSetting(POST_RULE_SCOPE_MIGRATION_KEY, '1');
      return;
    }
    // 中转列：本轮要把 account_ids 写进账号侧 rule_ids，极老的库可能还没有该列——
    // 临时补上（后面的 migratePostRulesToCategories 从这里反查，migrateAccountRuleIdsDrop 会删掉）
    for (const t of ['x_accounts', 'weibo_accounts']) {
      this.ensureColumn(t, 'rule_ids', "rule_ids TEXT NOT NULL DEFAULT '[]'");
    }
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

  /**
   * verdicts 身份键通用化：`(room_id, live_time)` → `(subject_type, subject_id)`，
   * 为图文判定归档铺路。SQLite 改不了约束，走「建新表 + 拷数据 + 改名」重建：
   * 老行一律搬成 subject_type='live'、subject_id = `room_id || ':' || live_time`，
   * rule_id 取 0 哨兵、pass 取 1（老语义只记「属于」）；id 原样保留（排序/历史引用不变）。
   *
   * 幂等靠列存在性检测而不是 settings 闸门：重建后 room_id 列消失，重跑是空操作；
   * 备份还原回旧 schema 的库也能再次迁移。老库无 verdicts 表时 SCHEMA 已按新结构建出，
   * 这里直接跳过；整段重建在一个事务里，崩溃不落半成品。
   */
  private migrateVerdictsSubjectKeys(): void {
    const cols = this.db.prepare('PRAGMA table_info(verdicts)').all() as Array<{ name: string }>;
    if (cols.length === 0 || !cols.some((c) => c.name === 'room_id')) return;
    const tx = this.db.transaction(() => {
      this.db.exec(`DROP TABLE IF EXISTS verdicts_v2; ${verdictsDdl('verdicts_v2')}`);
      const moved = this.db
        .prepare(
          `INSERT OR IGNORE INTO verdicts_v2
             (id, subject_type, subject_id, uid, category_id, rule_id,
              category_name, source, pass, confidence, evidence, effective, created_at)
           SELECT id, 'live', room_id || ':' || live_time, uid, category_id, 0,
              category_name, source, 1, confidence, evidence, 1, created_at
             FROM verdicts`,
        )
        .run();
      this.db.exec('DROP TABLE verdicts; ALTER TABLE verdicts_v2 RENAME TO verdicts;');
      return moved.changes;
    });
    const moved = tx();
    log.info(`verdicts 身份键迁移：${moved} 行老判定搬迁为 subject_type='live'`);
  }

  /**
   * verdicts 判据列重建：唯一键补上 `source` + 新增 `effective`（逐档落库后，同一分类的确定性结论
   * 与模型结论各占一行，生效结论由 effective 标出）。SQLite 改不了约束，走「建新表 + 拷全列 + 改名」：
   * 老行一律 effective=1——单档时代的每一行都是当时的生效结论；id 原样保留。
   *
   * 幂等靠列存在性检测而不是 settings 闸门（重建后 effective 列就在，重跑是空操作）。
   * **必须排在 migrateVerdictsSubjectKeys 之后**：老身份键库先搬成 subject_type 形状，
   * 那一轮已按新 DDL 建表并写 effective=1，这里随列检测跳过。
   */
  private migrateVerdictsEffective(): void {
    if (!this.tableExists('verdicts') || this.columnExists('verdicts', 'effective')) return;
    const tx = this.db.transaction(() => {
      this.db.exec(`DROP TABLE IF EXISTS verdicts_v3; ${verdictsDdl('verdicts_v3')}`);
      const moved = this.db
        .prepare(
          `INSERT OR IGNORE INTO verdicts_v3
             (id, subject_type, subject_id, uid, category_id, rule_id,
              category_name, source, pass, confidence, evidence, effective, created_at)
           SELECT id, subject_type, subject_id, uid, category_id, rule_id,
              category_name, source, pass, confidence, evidence, 1, created_at
             FROM verdicts`,
        )
        .run();
      this.db.exec('DROP TABLE verdicts; ALTER TABLE verdicts_v3 RENAME TO verdicts;');
      return moved.changes;
    });
    const moved = tx();
    log.info(`verdicts 判据列迁移：${moved} 行判定补 effective=1（唯一键加 source）`);
  }

  /**
   * push_rules 形态迁移（A.2）：`uids` 列更名泛化为 `scope` + 新增 `subject_kind`/`llm_translate`。
   * SQLite 改不了列名语义与约束，走「建新表 + 拷数据 + 改名」重建（同 verdicts 身份键迁移的打法）：
   * 老行一律搬成 subject_kind='live'、scope=原 uids、llm_translate=0；id/sort/created_by 原样保留。
   *
   * 幂等靠列存在性检测而不是 settings 闸门：重建后 uids 列消失，重跑是空操作。
   * **必须先于 migratePostRulesToCategories**（A.3 要往新形状的 push_rules 里写图文规则）。
   */
  private migratePushRuleScopeShape(): void {
    if (!this.columnExists('push_rules', 'uids')) return;
    const tx = this.db.transaction(() => {
      this.db.exec(`DROP TABLE IF EXISTS push_rules_v2; ${pushRulesDdl('push_rules_v2')}`);
      const moved = this.db
        .prepare(
          `INSERT INTO push_rules_v2
             (id, name, subject_kind, category_id, scope, channels, message_template,
              llm_translate, enabled, created_by, sort, created_at, updated_at)
           SELECT id, name, 'live', category_id, uids, channels, message_template,
              0, enabled, created_by, sort, created_at, updated_at
             FROM push_rules`,
        )
        .run();
      this.db.exec('DROP TABLE push_rules; ALTER TABLE push_rules_v2 RENAME TO push_rules;');
      return moved.changes;
    });
    const moved = tx();
    log.info(`push_rules 形态迁移：${moved} 行规则的 uids 搬为 scope（subject_kind='live'）`);
  }

  /**
   * post_rules 一次性搬家（A.3，D2 拍板；启动期内部迁移、不进撤销栈）：
   * 每条 post_rule（含停用）→ 一条分类（filters/judgePrompt 上移进条件组/LLM 提示词）
   * + 一条引用该分类的 push_rule（subject_kind='post'）。
   *
   *  · 分类：applies_to='post'；name=规则名；llm_prompt =（llmJudge 且 judgePrompt 非空）? judgePrompt : null；
   *    keywords=filters.keywords；post_types 由 filters.original/retweet 勾选集合映射；
   *    require_quote=filters.quote；require_media=filters.media；cond_mode='and'（旧 filters 各条件就是 AND）；
   *    enabled/sort 随规则。
   *  · 规则：category_id=新分类 id；scope=三账号表 rule_ids 反查出的选用账号引用
   *    （`twitter:screenName`/`weibo:uid`/`bili:uid`）；channels/message_template 原样；
   *    llm_translate=llmTranslate；sort 接现有全局序追加。
   *  · **行为保持闸**：原语义「账号 rule_ids 空 = 该账号不推」，一条 post_rule 没有任何账号选用
   *    = 永不生效；搬家后 scope 空按新语义 = 全部生效会翻转行为——故无账号选用的规则一律
   *    enabled=0 落地并在迁移日志注明。
   *
   * 幂等：post_rules 表不存在即跳过；搬完 DROP TABLE post_rules（遗留列 platform/account_ids 一并消失）。
   */
  private migratePostRulesToCategories(): void {
    if (!this.tableExists('post_rules')) return;
    const rules = this.db
      .prepare('SELECT * FROM post_rules ORDER BY sort, id')
      .all() as Array<Record<string, unknown>>;
    // 账号引用反查表：post_rules id → 选用了它的账号引用列表（三平台一起扫）
    const refByRule = new Map<number, string[]>();
    const accountTables: Array<{ table: string; ref: (row: Record<string, unknown>) => string }> = [
      { table: 'x_accounts', ref: (a) => `twitter:${String(a.screen_name)}` },
      { table: 'weibo_accounts', ref: (a) => `weibo:${String(a.uid)}` },
      { table: 'bili_accounts', ref: (a) => `bili:${String(a.uid)}` },
    ];
    for (const { table, ref } of accountTables) {
      if (!this.columnExists(table, 'rule_ids')) continue;
      for (const a of this.db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>) {
        let ids: number[];
        try {
          ids = JSON.parse(String(a.rule_ids ?? '[]')) as number[];
        } catch {
          ids = [];
        }
        for (const id of ids) {
          const list = refByRule.get(id) ?? [];
          list.push(ref(a));
          refByRule.set(id, list);
        }
      }
    }

    let migrated = 0;
    let disabled = 0;
    const tx = this.db.transaction(() => {
      const { m } = this.db
        .prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS m FROM push_rules')
        .get() as { m: number };
      let nextSort = m;
      for (const r of rules) {
        const id = Number(r.id);
        const filters = parseFilters(r.filters == null ? null : String(r.filters));
        const llmJudge = Number(r.llm_judge ?? 0) === 1;
        const judgePrompt = r.judge_prompt == null ? null : String(r.judge_prompt);
        const postTypes: string[] = [];
        if (filters.original) postTypes.push('original');
        if (filters.retweet) postTypes.push('retweet');
        const t = Number(r.created_at ?? now());
        const categoryId = Number(this.db
          .prepare(
            `INSERT INTO categories (name, llm_prompt, keywords, areas, post_types,
               require_quote, require_media, applies_to, cond_mode, enabled, sort, created_at, updated_at)
             VALUES (?, ?, ?, '[]', ?, ?, ?, 'post', 'and', ?, ?, ?, ?)`,
          )
          .run(
            String(r.name ?? ''), llmJudge && judgePrompt ? judgePrompt : null,
            JSON.stringify(filters.keywords), JSON.stringify(postTypes),
            filters.quote ? 1 : 0, filters.media ? 1 : 0,
            Number(r.enabled ?? 1), Number(r.sort ?? 0), t, Number(r.updated_at ?? t),
          ).lastInsertRowid);
        const scope = refByRule.get(id) ?? [];
        // 行为保持闸：无账号选用 = 原语义永不生效 → enabled=0（scope 空在新语义 = 全部生效）
        const enabled = scope.length > 0 ? Number(r.enabled ?? 1) : 0;
        if (scope.length === 0) disabled++;
        this.db
          .prepare(
            `INSERT INTO push_rules (name, subject_kind, category_id, scope, channels,
               message_template, llm_translate, enabled, created_by, sort, created_at, updated_at)
             VALUES (?, 'post', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
          )
          .run(
            String(r.name ?? ''), categoryId, JSON.stringify(scope),
            String(r.channels ?? '[]'), r.message_template == null ? null : String(r.message_template),
            Number(r.llm_translate ?? 0), enabled, nextSort++, t, Number(r.updated_at ?? t),
          );
        migrated++;
      }
      this.db.exec('DROP TABLE post_rules');
    });
    tx();
    log.info(
      `图文规则搬家：${migrated} 条 post_rule → 分类 + 推送规则（subject_kind='post'）；`
      + (disabled > 0 ? `其中 ${disabled} 条无账号选用，按行为保持闸 enabled=0 落地` : '全部有账号选用'),
    );
  }

  /**
   * 账号名单的 rule_ids 列删除（A.2）：生效范围已统一到规则侧 scope（A.3 搬家反查过 rule_ids，
   * 故本迁移必须在搬家之后）。走「建新表 + 拷其余列 + 改名」重建（SQLite 删不了列）。
   * 幂等靠列存在性检测：列没了重跑是空操作。
   */
  private migrateAccountRuleIdsDrop(): void {
    const tables: Array<{ table: string; ddl: (name: string) => string; columns: string[] }> = [
      {
        table: 'x_accounts', ddl: xAccountsDdl,
        columns: ['id', 'screen_name', 'nickname', 'display_name', 'bili_uid', 'enabled',
          'last_tweet_id', 'last_tweet_at', 'last_ok_at', 'avatar', 'silent_next',
          'fetch_fail_since', 'fetch_error', 'created_at', 'updated_at'],
      },
      {
        table: 'weibo_accounts', ddl: weiboAccountsDdl,
        columns: ['id', 'uid', 'nickname', 'display_name', 'bili_uid', 'enabled',
          'last_post_id', 'last_post_at', 'last_ok_at', 'avatar', 'silent_next',
          'fetch_fail_since', 'fetch_error', 'created_at', 'updated_at'],
      },
      {
        table: 'bili_accounts', ddl: biliAccountsDdl,
        columns: ['id', 'uid', 'uname', 'display_name', 'enabled',
          'last_ok_at', 'avatar', 'silent_next', 'fetch_fail_since', 'fetch_error',
          'created_at', 'updated_at'],
      },
    ];
    for (const { table, ddl, columns } of tables) {
      if (!this.columnExists(table, 'rule_ids')) continue;
      // 极老的库可能缺个别 ensureColumn 都没覆盖到的列：只搬两边都有的列，缺的列由新表默认值兜住
      const cols = columns.filter((c) => this.columnExists(table, c));
      const tmp = `${table}_v2`;
      const tx = this.db.transaction(() => {
        this.db.exec(`DROP TABLE IF EXISTS ${tmp}; ${ddl(tmp)}`);
        const moved = this.db
          .prepare(`INSERT INTO ${tmp} (${cols.join(', ')}) SELECT ${cols.join(', ')} FROM ${table}`)
          .run();
        this.db.exec(`DROP TABLE ${table}; ALTER TABLE ${tmp} RENAME TO ${table};`);
        return moved.changes;
      });
      log.info(`账号名单迁移：${table} 删除 rule_ids 列（${tx()} 行搬迁）`);
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

  /**
   * 记录一场直播（开场快照含 keyframe/cover）并插入首个 segment。
   * 首段起点用平台给的真实开播 `liveTime`（不再用观测时刻）：服务停机期间开播的场次，
   * 时间条也从事实上播时间开始。重复 live_start 保留原行/首段；若该场此前被标结束
   * （停机后同场续播 / 状态抖动后同一 live_time 再次出现），这里把它恢复为在播。
   */
  recordSession(p: {
    roomId: string; liveTime: number; uid: string;
    uname: string; title: string; areaName: string; parentAreaName: string;
    keyframe?: string; cover?: string;
  }): void {
    const t = now();
    const start = p.liveTime > 0 && p.liveTime <= t && t - p.liveTime <= LIVE_START_MAX_AGE_S
      ? p.liveTime : t;
    const info = this.db
      .prepare(
        `INSERT INTO live_sessions
           (room_id, live_time, uid, uname, title, area_name, keyframe, cover,
            first_seen, last_seen, notified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(room_id, live_time) DO NOTHING`,
      )
      .run(p.roomId, p.liveTime, p.uid, p.uname, p.title, p.areaName,
        p.keyframe ?? null, p.cover ?? null, t, t);
    if (info.changes > 0) {
      this.insertSessionSegment(p, start, t);
      return;
    }
    // 同一 live_time 再次开播：此前若是「未观测到结束」的关闭，开口段仍在，续上即可；
    // 若是观测到下播后关闭，旧段已收尾，这里补开一段（不覆盖历史）。
    const existing = this.db
      .prepare('SELECT closed_at FROM live_sessions WHERE room_id = ? AND live_time = ?')
      .get(p.roomId, p.liveTime) as { closed_at: number | null } | undefined;
    if (existing?.closed_at == null) return;
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE live_sessions SET closed_at = NULL, end_seen = NULL,
             last_seen = MAX(COALESCE(last_seen, 0), ?)
           WHERE room_id = ? AND live_time = ?`,
        )
        .run(t, p.roomId, p.liveTime);
      const open = this.db
        .prepare('SELECT 1 FROM live_segments WHERE room_id = ? AND live_time = ? AND end_ts IS NULL')
        .get(p.roomId, p.liveTime);
      if (!open) this.insertSessionSegment(p, t, t);
    });
  }

  /** 插一场直播的 segment（recordSession 的首段与同场续播段共用）。 */
  private insertSessionSegment(
    p: { roomId: string; liveTime: number; title: string; areaName: string; parentAreaName: string; keyframe?: string },
    startTs: number, createdAt: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO live_segments
           (room_id, live_time, start_ts, end_ts, title, area_name, parent_area_name, keyframe, created_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      )
      .run(p.roomId, p.liveTime, startTs, p.title, p.areaName, p.parentAreaName,
        p.keyframe ?? null, createdAt);
  }

  /** 在播场次的存活打点（live-status source 每轮随 saveRoomStates 调）：刷 last_seen + 非空 keyframe 覆盖。
   *  已关闭的场次不再打点；同场续播由 recordSession 的恢复路径处理。 */
  touchLiveSessions(entries: Array<{ roomId: string; liveTime: number; keyframe?: string }>): void {
    if (entries.length === 0) return;
    const stmt = this.db.prepare(
      `UPDATE live_sessions SET last_seen = ?,
         keyframe = CASE WHEN ? != '' THEN ? ELSE keyframe END
       WHERE room_id = ? AND live_time = ? AND closed_at IS NULL`,
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
   * live_end 归档：关闭该房间 first_seen 最新且仍开口的一场。
   * 不带 liveTime：live_end 信号里它不可靠（下播合成状态 liveTime=0；下播又开播的成对信号里
   * 带的是新一场的 liveTime），而 pipeline 在信号的同步前缀里按序归档（endSession 先于配对
   * live_start 的 recordSession 执行），所以此刻该房间最新一场就是要结束的那场。
   *
   * `observed=false` 表示这是停机 / 重启后才发现的下播：`endTs` 是「发现」时刻，不是真实
   * 下播时刻。此时只记 closed_at，不写 end_seen，也不把 last_seen 推后——时间轴画到
   * 最后一次在线观测为止，数据里不伪造下播时间。
   */
  endSession(roomId: string, endTs: number, observed = true): void {
    const s = this.db
      .prepare(
        `SELECT live_time FROM live_sessions
         WHERE room_id = ? AND closed_at IS NULL
         ORDER BY first_seen DESC LIMIT 1`,
      )
      .get(roomId) as { live_time: number } | undefined;
    if (!s) return;
    if (observed) {
      this.db
        .prepare(
          `UPDATE live_sessions SET
             last_seen = MAX(COALESCE(last_seen, 0), ?),
             end_seen = MAX(COALESCE(end_seen, 0), ?),
             closed_at = MAX(COALESCE(closed_at, 0), ?)
           WHERE room_id = ? AND live_time = ?`,
        )
        .run(endTs, endTs, endTs, roomId, s.live_time);
      this.db
        .prepare('UPDATE live_segments SET end_ts = ? WHERE room_id = ? AND live_time = ? AND end_ts IS NULL')
        .run(endTs, roomId, s.live_time);
      return;
    }
    this.db
      .prepare(
        `UPDATE live_sessions SET closed_at = MAX(COALESCE(closed_at, 0), ?)
         WHERE room_id = ? AND live_time = ?`,
      )
      .run(endTs, roomId, s.live_time);
  }

  // ---- 服务在线区间：心跳记录，供时间表区分「服务在跑但我们没看到」与「服务没跑」----

  /**
   * 进程启动：把上一进程遗留的开口 run 以最后心跳封口（崩溃/强杀时没有优雅停机），
   * 再插入本次 run。上一进程若正常停机，stopped_at 已写好，这里不会改动。
   */
  beginServiceRun(at: number = now()): void {
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE service_runs SET stopped_at = last_heartbeat_at, stop_kind = 'unclean'
           WHERE stopped_at IS NULL`,
        )
        .run();
      this.db
        .prepare('INSERT INTO service_runs (started_at, last_heartbeat_at) VALUES (?, ?)')
        .run(at, at);
    });
  }

  /** 进程存活心跳（周期定时器 + 每轮轮询成功都可调）：只推进当前开口 run。 */
  heartbeatServiceRun(at: number = now()): void {
    this.db
      .prepare(
        `UPDATE service_runs SET last_heartbeat_at = MAX(last_heartbeat_at, ?)
         WHERE id = (SELECT id FROM service_runs WHERE stopped_at IS NULL ORDER BY id DESC LIMIT 1)`,
      )
      .run(at);
  }

  /** 正常停机：把当前开口 run 收在 at；stopKind 只用于诊断（unclean = 下次启动补封）。 */
  endServiceRun(at: number = now(), stopKind = 'shutdown'): void {
    this.db
      .prepare(
        `UPDATE service_runs SET
           stopped_at = MAX(COALESCE(stopped_at, 0), ?), stop_kind = ?
         WHERE stopped_at IS NULL`,
      )
      .run(at, stopKind);
  }

  /**
   * 时间轴用的服务在线区间：查询范围内的 run（秒级半开区间），与最早一条在线记录的起点。
   * 未封口的 run 若心跳还新鲜，按「在线到现在」返回；心跳停了就以最后心跳封口——
   * 进程卡死或崩溃后，前端不会把未知时段画成在线。`trackedFrom` 之前的年代没有记录，
   * 前端不对那段画灰底，避免把部署前的历史误标成离线。
   */
  listServiceRuns(fromTs: number, toTs: number, nowTs: number = now()): ServiceRuns {
    const tracked = this.db
      .prepare('SELECT MIN(started_at) AS started_at FROM service_runs')
      .get() as { started_at: number | null };
    const rows = this.db
      .prepare(
        `SELECT started_at, last_heartbeat_at, stopped_at FROM service_runs
         WHERE started_at < ? AND COALESCE(stopped_at, last_heartbeat_at, started_at) > ?
         ORDER BY started_at, id`,
      )
      .all(toTs, fromTs) as Array<{
        started_at: number; last_heartbeat_at: number; stopped_at: number | null;
      }>;
    const online: ServiceRunInterval[] = [];
    for (const r of rows) {
      const end = r.stopped_at
        ?? (nowTs - r.last_heartbeat_at <= SERVICE_HEARTBEAT_GRACE_S ? nowTs : r.last_heartbeat_at);
      const startTs = Math.max(r.started_at, fromTs);
      const endTs = Math.min(end, toTs);
      if (endTs <= startTs) continue;
      const last = online.at(-1);
      if (last && startTs <= last.endTs) last.endTs = Math.max(last.endTs, endTs);
      else online.push({ startTs, endTs });
    }
    return { online, trackedFrom: tracked.started_at };
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
   * 时间轴组装（/api/schedule）：真实开播时间落在 [fromTs, toTs) 的场次 + 其 segments +
   * verdicts + 主分类 + 主播信息（alias/uname/face）。四表各查一次（join 场次过滤），JS 按
   * (room_id, live_time) 归并，无 N+1。
   *
   * 起点 = `live_time`（平台给的真实开播；异常时钟回退 first_seen），不再用首次观测时间。
   * 终点：在播 = null；已下播 = 在线期间观测到的 end_seen，否则最后一次在线观测 last_seen；
   * 停机期间结束的场次没有 end_seen，绝不拿「发现时刻」伪造下播时间。legacy 无打点场次
   * 退到 first_seen（零长，前端不画）。
   *
   * `staleSec` 是「最后一次打点多旧仍算在播」的窗口：调用方按实际轮询间隔放宽，
   * 避免轮询间隔 >10 分钟时把在播场误判成已下播。
   */
  listTimeline(fromTs: number, toTs: number, staleSec = TIMELINE_LIVE_STALE_S): TimelineEntry[] {
    const nowTs = now();
    // 真实开播时间：live_time 是平台事实，但时钟回拨/异常时可能晚于首次观测，取较早者。
    const sessionStart = (p: string) =>
      `(CASE WHEN ${p}live_time > 0 AND ${p}live_time <= ${p}first_seen` +
      ` AND ${p}first_seen - ${p}live_time <= ${LIVE_START_MAX_AGE_S}` +
      ` THEN ${p}live_time ELSE ${p}first_seen END)`;
    const startExpr = sessionStart('');
    const joinStartExpr = sessionStart('ls.');
    const sessions = this.db
      .prepare(
        `SELECT *, ${startExpr} AS start_ts FROM live_sessions
         WHERE ${startExpr} >= ? AND ${startExpr} < ?
         ORDER BY start_ts, first_seen`,
      )
      .all(fromTs, toTs) as Array<{
        room_id: string; live_time: number; uid: string; uname: string | null;
        title: string | null; area_name: string | null; parent_area_name?: string | null;
        keyframe: string | null; cover: string | null;
        first_seen: number; last_seen: number | null;
        end_seen: number | null; closed_at: number | null; start_ts: number;
      }>;
    if (sessions.length === 0) return [];
    const segRows = this.db
      .prepare(
        `SELECT s.* FROM live_segments s
         JOIN live_sessions ls ON ls.room_id = s.room_id AND ls.live_time = s.live_time
         WHERE ${joinStartExpr} >= ? AND ${joinStartExpr} < ?
         ORDER BY s.start_ts, s.id`,
      )
      .all(fromTs, toTs) as LiveSegmentRow[];
    // verdicts 身份键 = (subject_type, subject_id)：live 行以 `room_id:live_time` 对场次；
    // 只取生效行（effective=1）且 pass=1——这里展示的是「属于哪些分类」，每分类恰一行
    const verdictRows = this.db
      .prepare(
        `SELECT v.subject_id, v.category_name, v.source, v.confidence, v.evidence
         FROM verdicts v
         JOIN live_sessions ls
           ON v.subject_type = 'live' AND v.subject_id = ls.room_id || ':' || ls.live_time
         WHERE ${joinStartExpr} >= ? AND ${joinStartExpr} < ? AND v.effective = 1 AND v.pass = 1
         ORDER BY v.id`,
      )
      .all(fromTs, toTs) as Array<{
        subject_id: string; category_name: string;
        source: 'llm' | 'rule' | 'decision'; confidence: number | null; evidence: string;
      }>;
    // 主分类：同一轮 join 取生效行（category_id=0「其他」不进展示）
    const primaryRows = this.db
      .prepare(
        `SELECT p.subject_id, p.category_id, p.category_name, p.source
         FROM primary_verdicts p
         JOIN live_sessions ls
           ON p.subject_type = 'live' AND p.subject_id = ls.room_id || ':' || ls.live_time
         WHERE ${joinStartExpr} >= ? AND ${joinStartExpr} < ? AND p.effective = 1
         ORDER BY p.id`,
      )
      .all(fromTs, toTs) as Array<{
        subject_id: string; category_id: number; category_name: string;
        source: 'llm' | 'rule' | 'decision';
      }>;
    // 历次分类判定（多次时机的留痕）：一次 join 取全窗口，JS 按场次归并
    const runRows = this.db
      .prepare(
        `SELECT r.room_id, r.live_time, r.trigger_kind, r.ts, r.verdicts, r.primary_verdict
         FROM live_classification_runs r
         JOIN live_sessions ls ON ls.room_id = r.room_id AND ls.live_time = r.live_time
         WHERE ${joinStartExpr} >= ? AND ${joinStartExpr} < ?
         ORDER BY r.ts, r.id`,
      )
      .all(fromTs, toTs) as LiveClassificationRunRow[];
    const streamerByUid = new Map(this.listStreamers().map((s) => [s.uid, s]));
    // 每房间最新状态：last_live_at 是「最后一次确认在播」，下播后保留。它不随场次归档，
    // 只对「该房间最近一场」有意义，用作未观测下播终点的兜底收口（见下方 endTs 计算）。
    const roomStateByRoom = new Map<string, RoomStateFull>();
    for (const rs of this.listRoomStatesFull().values()) roomStateByRoom.set(rs.roomId, rs);

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
      const k = v.subject_id;
      const list = verdictsBySession.get(k) ?? [];
      list.push({
        categoryName: v.category_name, source: v.source,
        confidence: v.confidence, evidence: v.evidence,
      });
      verdictsBySession.set(k, list);
    }
    const primaryBySession = new Map<string, NonNullable<TimelineEntry['primary']>>();
    for (const p of primaryRows) {
      if (p.category_id === 0) continue; // 「其他」= 没有组内主分类，前端不展示
      primaryBySession.set(p.subject_id, { categoryName: p.category_name, source: p.source });
    }
    const runsBySession = new Map<string, LiveClassificationRun[]>();
    for (const r of runRows) {
      const k = key(r.room_id, r.live_time);
      const list = runsBySession.get(k) ?? [];
      list.push({
        triggerKind: r.trigger_kind,
        ts: r.ts,
        verdicts: JSON.parse(r.verdicts) as LiveClassificationRunVerdict[],
        primary: r.primary_verdict ? JSON.parse(r.primary_verdict) as LiveClassificationRun['primary'] : null,
      });
      runsBySession.set(k, list);
    }

    return sessions.map((s) => {
      const st = streamerByUid.get(s.uid);
      const startTs = s.start_ts;
      // 在播 = 未被标结束 + 最后一次在线观测仍在鲜度窗口内。closed_at 已写但 end_seen 为空，
      // 说明是停机期间结束的：终点取 last_seen（最后一次确认在播），不取发现时刻。
      const isLive = s.closed_at == null && s.end_seen == null
        && s.last_seen != null && nowTs - s.last_seen <= staleSec;
      let endTs: number | null = isLive ? null : (s.end_seen ?? s.last_seen ?? s.first_seen);
      // 未观测到下播（end_seen 为空）时，room_state.last_live_at 是旧版重启写坏 last_seen
      // 之前最后一次确认在播的时间。只允许往早收口，不往晚延伸；房间已有更新场次时它更晚，
      // 自然不生效。观测到下播的 end_seen 永远优先，不受影响。
      const lastLiveAt = roomStateByRoom.get(s.room_id)?.lastLiveAt ?? null;
      if (endTs != null && s.end_seen == null && lastLiveAt != null
        && lastLiveAt > 0 && lastLiveAt < endTs) {
        endTs = lastLiveAt;
      }
      let segments = segsBySession.get(key(s.room_id, s.live_time));
      if (!segments || segments.length === 0) {
        // 旧场次（segments 表建立前归档的）没有段：回退为单段，标题/分区取开场快照
        segments = [{
          startTs, endTs,
          title: s.title ?? '', areaName: s.area_name ?? '', parentAreaName: '',
        }];
      } else {
        // 旧数据首段从观测时刻开始：场次起点回推到真实开播，时间条才不缺口
        if (startTs < segments[0]!.startTs) {
          segments[0] = { ...segments[0]!, startTs };
        }
        if (!isLive && endTs != null) {
          // 已下播：开口段收在场次终点；旧数据已收尾的段也钳到 effective end
          segments = segments.map((g) => {
            const segEnd = g.endTs == null ? endTs : Math.min(g.endTs, endTs);
            return segEnd === g.endTs ? g : { ...g, endTs: segEnd };
          });
        }
      }
      return {
        roomId: s.room_id, liveTime: s.live_time, uid: s.uid,
        name: st ? (st.alias || st.uname) : (s.uname ?? ''),
        uname: st?.uname ?? s.uname ?? '',
        face: st?.face ?? null,
        startTs, endTs,
        keyframe: s.keyframe, cover: s.cover,
        segments,
        verdicts: verdictsBySession.get(key(s.room_id, s.live_time)) ?? [],
        primary: primaryBySession.get(key(s.room_id, s.live_time)) ?? null,
        classificationRuns: runsBySession.get(key(s.room_id, s.live_time)) ?? [],
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

  // ---- categories：分类规则（全局；判定描述 + 确定性条件，归类结果入 verdicts）----

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
      // 判定模式与精确条件各存一份、互不覆盖：切模式只写 judge_mode，另一模式的数据原样留着
      judgeMode: input.judgeMode ?? prev?.judgeMode ?? 'simple',
      judgeConditions: input.judgeConditions ?? prev?.judgeConditions ?? [],
      keywords: input.keywords ?? prev?.keywords ?? [],
      areas: input.areas ?? prev?.areas ?? [],
      postTypes: input.postTypes ?? prev?.postTypes ?? [],
      requireQuote: input.requireQuote ?? prev?.requireQuote ?? false,
      requireMedia: input.requireMedia ?? prev?.requireMedia ?? false,
      appliesTo: input.appliesTo ?? prev?.appliesTo ?? 'live',
      condMode: input.condMode ?? prev?.condMode ?? 'and',
      primary: input.primary ?? prev?.primary ?? false,
      enabled: input.enabled ?? prev?.enabled ?? true,
    };
    if (prev) {
      this.db
        .prepare(
          `UPDATE categories SET name=?, llm_prompt=?, judge_mode=?, judge_conditions=?, keywords=?, areas=?, post_types=?,
             require_quote=?, require_media=?, applies_to=?, cond_mode=?, is_primary=?, enabled=?, updated_at=?
           WHERE id=?`,
        )
        .run(c.name, c.llmPrompt, c.judgeMode, serializeJudgeConditions(c.judgeConditions),
          JSON.stringify(c.keywords), JSON.stringify(c.areas),
          JSON.stringify(c.postTypes), c.requireQuote ? 1 : 0, c.requireMedia ? 1 : 0,
          c.appliesTo, c.condMode, c.primary ? 1 : 0, c.enabled ? 1 : 0, now(), prev.id);
      return prev.id;
    }
    const t = now();
    // 新分类排到列表末尾
    const { m } = this.db
      .prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS m FROM categories')
      .get() as { m: number };
    const info = this.db
      .prepare(
        `INSERT INTO categories (name, llm_prompt, judge_mode, judge_conditions, keywords, areas, post_types,
           require_quote, require_media, applies_to, cond_mode, is_primary, enabled, sort, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(c.name, c.llmPrompt, c.judgeMode, serializeJudgeConditions(c.judgeConditions),
        JSON.stringify(c.keywords), JSON.stringify(c.areas),
        JSON.stringify(c.postTypes), c.requireQuote ? 1 : 0, c.requireMedia ? 1 : 0,
        c.appliesTo, c.condMode, c.primary ? 1 : 0, c.enabled ? 1 : 0, m, t, t);
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
      subjectKind: input.subjectKind ?? prev?.subjectKind ?? 'live',
      categoryId: input.categoryId !== undefined ? input.categoryId : prev?.categoryId ?? null,
      scope: input.scope ?? prev?.scope ?? [],
      channels: input.channels ?? prev?.channels ?? [],
      messageTemplate: input.messageTemplate !== undefined
        ? input.messageTemplate : prev?.messageTemplate ?? null,
      llmTranslate: input.llmTranslate ?? prev?.llmTranslate ?? false,
      enabled: input.enabled ?? prev?.enabled ?? true,
      createdBy: input.createdBy !== undefined ? input.createdBy : prev?.createdBy ?? null,
    };
    if (prev) {
      this.db
        .prepare(
          `UPDATE push_rules SET name=?, subject_kind=?, category_id=?, scope=?, channels=?,
             message_template=?, llm_translate=?, enabled=?, created_by=?, updated_at=?
           WHERE id=?`,
        )
        .run(r.name, r.subjectKind, r.categoryId, JSON.stringify(r.scope), JSON.stringify(r.channels),
          r.messageTemplate, r.llmTranslate ? 1 : 0, r.enabled ? 1 : 0, r.createdBy ?? null, now(), prev.id);
      return prev.id;
    }
    const t = now();
    const { m } = this.db
      .prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS m FROM push_rules')
      .get() as { m: number };
    const info = this.db
      .prepare(
        `INSERT INTO push_rules (name, subject_kind, category_id, scope, channels,
           message_template, llm_translate, enabled, created_by, sort, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.name, r.subjectKind, r.categoryId, JSON.stringify(r.scope), JSON.stringify(r.channels),
        r.messageTemplate, r.llmTranslate ? 1 : 0, r.enabled ? 1 : 0, r.createdBy ?? null, m, t, t);
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

  // ---- verdicts：内容判定归档（UNIQUE(subject_type, subject_id, category_id, rule_id, source) 去重）----

  /** INSERT OR IGNORE：同一主体同一分类/规则同一来源重复判定静默跳过（0 哨兵参与唯一键）。 */
  insertVerdict(v: NewVerdict): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO verdicts
           (subject_type, subject_id, uid, category_id, rule_id,
            category_name, source, pass, confidence, evidence, effective, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(v.subjectType, v.subjectId, v.uid, v.categoryId, v.ruleId,
        v.categoryName, v.source, v.pass === false ? 0 : 1,
        v.confidence, v.evidence, v.effective ? 1 : 0, now());
  }

  /** 一个主体（直播场次 / 图文帖）的全部判定结果，含未生效行（面板/审计回看用）。 */
  listVerdicts(subjectType: VerdictSubjectType, subjectId: string): Verdict[] {
    const rows = this.db
      .prepare('SELECT * FROM verdicts WHERE subject_type = ? AND subject_id = ? ORDER BY id')
      .all(subjectType, subjectId) as VerdictRow[];
    return rows.map(rowToVerdict);
  }

  // ---- primary_verdicts：主分类判定归档（UNIQUE(subject_type, subject_id, source) 去重）----

  /** INSERT OR IGNORE：同一主体同一来源的主分类只留首次判定。 */
  insertPrimaryVerdict(v: NewPrimaryVerdict): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO primary_verdicts
           (subject_type, subject_id, uid, category_id, category_name, source,
            distribution, evidence, effective, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(v.subjectType, v.subjectId, v.uid, v.categoryId, v.name, v.source,
        v.distribution === null ? null : JSON.stringify(v.distribution),
        v.evidence, v.effective ? 1 : 0, now());
  }

  /** 一个主体的全部主分类判定行（含未生效行；展示方只读 effective=1 的那条）。 */
  listPrimaryVerdicts(subjectType: VerdictSubjectType, subjectId: string): PrimaryVerdict[] {
    const rows = this.db
      .prepare('SELECT * FROM primary_verdicts WHERE subject_type = ? AND subject_id = ? ORDER BY id')
      .all(subjectType, subjectId) as PrimaryVerdictRow[];
    return rows.map(rowToPrimaryVerdict);
  }

  /**
   * 一轮判定替换该主体的当前判定（事务内先删后插）。
   * 同一主体会被多次判定（直播的开播 / 延迟 / 定时 / 变更时机），当前结论必须跟着最新一轮走，
   * 所以不能用 INSERT OR IGNORE 留在第一次；历史另存 `live_classification_runs`。
   */
  replaceSubjectVerdicts(
    subjectType: VerdictSubjectType,
    subjectId: string,
    verdicts: NewVerdict[],
    primaries: NewPrimaryVerdict[],
  ): void {
    const delVerdicts = this.db.prepare('DELETE FROM verdicts WHERE subject_type = ? AND subject_id = ?');
    const delPrimaries = this.db.prepare('DELETE FROM primary_verdicts WHERE subject_type = ? AND subject_id = ?');
    const tx = this.db.transaction(() => {
      delVerdicts.run(subjectType, subjectId);
      delPrimaries.run(subjectType, subjectId);
      for (const v of verdicts) this.insertVerdict(v);
      for (const p of primaries) this.insertPrimaryVerdict(p);
    });
    tx();
  }

  // ---- live_classification_runs：直播多时机判定的历史留痕（只增不改，不参与去重）----

  /** 记一轮判定结果：verdicts = 本轮生效且属于的分类（可为空 = 从该时刻起未分类） */
  insertLiveClassificationRun(p: {
    roomId: string; liveTime: number; triggerKind: LiveClassifyRunTrigger;
    ts: number; verdicts: LiveClassificationRunVerdict[];
    primary: LiveClassificationRun['primary'];
  }): void {
    this.db
      .prepare(
        `INSERT INTO live_classification_runs
           (room_id, live_time, trigger_kind, ts, verdicts, primary_verdict, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.roomId, p.liveTime, p.triggerKind, p.ts, JSON.stringify(p.verdicts),
        p.primary === null ? null : JSON.stringify(p.primary), now());
  }

  /** 一场直播的历次判定（按 ts 升序；旧场次没有历史 = 空数组） */
  listLiveClassificationRuns(roomId: string, liveTime: number): LiveClassificationRun[] {
    const rows = this.db
      .prepare(
        `SELECT room_id, live_time, trigger_kind, ts, verdicts, primary_verdict
         FROM live_classification_runs
         WHERE room_id = ? AND live_time = ?
         ORDER BY ts, id`,
      )
      .all(roomId, liveTime) as LiveClassificationRunRow[];
    return rows.map((r) => ({
      triggerKind: r.trigger_kind,
      ts: r.ts,
      verdicts: JSON.parse(r.verdicts) as LiveClassificationRunVerdict[],
      primary: r.primary_verdict ? JSON.parse(r.primary_verdict) as LiveClassificationRun['primary'] : null,
    }));
  }

  recordContentAudit(subjectType: VerdictSubjectType, subjectId: string, section: 'analysis', value: AnalysisAudit): void;
  recordContentAudit(subjectType: VerdictSubjectType, subjectId: string, section: 'push', value: PushAudit): void;
  recordContentAudit(subjectType: VerdictSubjectType, subjectId: string, section: 'analysis' | 'push', value: AnalysisAudit | PushAudit): void {
    this.db.prepare(`INSERT INTO content_audit (subject_type, subject_id, ${section}, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(subject_type, subject_id)
      DO UPDATE SET ${section}=excluded.${section}, updated_at=excluded.updated_at`)
      .run(subjectType, subjectId, JSON.stringify(value), now());
  }

  getContentAudit(subjectType: VerdictSubjectType, subjectId: string): ContentAudit | null {
    const row = this.db.prepare('SELECT * FROM content_audit WHERE subject_type=? AND subject_id=?')
      .get(subjectType, subjectId) as { analysis: string | null; push: string | null; updated_at: number } | undefined;
    if (!row) return null;
    return { subjectType, subjectId, analysis: row.analysis ? JSON.parse(row.analysis) as AnalysisAudit : null,
      push: row.push ? JSON.parse(row.push) as PushAudit : null, updatedAt: row.updated_at };
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

  // ---- 分类试判的样本（只读）：RANDOM() 抽样 + 按样本身份精确复读 ----
  //
  // 随机抽样的池子**只收能带图的记录**：试判列表要显示缩略图，抽到无图记录那一行就只能空着。
  // 精确复读（getSampled*) 不受此限——旧锚点（当年抽中时还没图，或图后来被清理）照样能复测。

  /**
   * 随机抽直播场次（分类试判）。过滤面：主播 uid + 场次开播时间 [fromTs, toTs]，
   * 并且只抽**有关键帧或封面**的场次（池子口径见本节注释）。
   * 父分区不在 live_sessions 行上，按 `start_ts` 取**首段**补出来（与时间表首段口径一致）。
   */
  sampleLiveSessions(q: SampleQuery = {}): SampledLiveSession[] {
    const where: string[] = [SAMPLED_LIVE_HAS_IMAGE];
    const args: Array<string | number> = [];
    if (q.uid) { where.push('ls.uid = ?'); args.push(q.uid); }
    if (q.fromTs !== undefined) { where.push('ls.live_time >= ?'); args.push(q.fromTs); }
    if (q.toTs !== undefined) { where.push('ls.live_time <= ?'); args.push(q.toTs); }
    const rows = this.db
      .prepare(
        `${SAMPLED_LIVE_SQL}
           WHERE ${where.join(' AND ')}
          ORDER BY RANDOM() LIMIT ?`,
      )
      .all(...args, sampleLimit(q.limit)) as SampledLiveRow[];
    return rows.map(rowToSampledLive);
  }

  /**
   * 精确读一场直播样本（复测用）：身份 = `(room_id, live_time)`，投影与 `sampleLiveSessions` 同一段 SQL。
   * **不套抽样池的带图条件**（旧锚点照样可读，没有图就回空串）。
   * 行不存在回 `null`——调用方据此拒绝整次复测，绝不静默换一条样本。
   */
  getSampledLiveSession(roomId: string, liveTime: number): SampledLiveSession | null {
    const row = this.db
      .prepare(`${SAMPLED_LIVE_SQL} WHERE ls.room_id = ? AND ls.live_time = ?`)
      .get(roomId, liveTime) as SampledLiveRow | undefined;
    return row ? rowToSampledLive(row) : null;
  }

  /**
   * 随机抽图文帖（分类试判）：uid / platform / 发布时间 [fromTs, toTs] 过滤，
   * 并且只抽**pics 非空**的帖子（池子口径见本节注释）。
   * `ORDER BY RANDOM()` 取样，limit 钳 1~SAMPLE_LIMIT_MAX。走 rowToPost（pics 解成数组、raw 原样）。
   */
  samplePosts(q: SampleQuery = {}): Post[] {
    const where: string[] = [SAMPLED_POST_HAS_IMAGE];
    const args: Array<string | number> = [];
    if (q.uid) { where.push('uid = ?'); args.push(q.uid); }
    if (q.platform) { where.push('platform = ?'); args.push(q.platform); }
    if (q.fromTs !== undefined) { where.push('pub_ts >= ?'); args.push(q.fromTs); }
    if (q.toTs !== undefined) { where.push('pub_ts <= ?'); args.push(q.toTs); }
    const rows = this.db
      .prepare(`SELECT * FROM posts WHERE ${where.join(' AND ')}
                ORDER BY RANDOM() LIMIT ?`)
      .all(...args, sampleLimit(q.limit)) as PostRow[];
    return rows.map(rowToPost);
  }

  /**
   * 精确读一条图文样本（复测用）：身份 = `(platform, item_id)`（posts 的唯一键），
   * 投影走 `rowToPost`，与 `samplePosts` 同形；**不要求 pics 非空**（旧锚点照读）。行不存在回 `null`。
   */
  getSampledPost(platform: string, itemId: string): Post | null {
    const row = this.db
      .prepare('SELECT * FROM posts WHERE platform = ? AND item_id = ?')
      .get(platform, itemId) as PostRow | undefined;
    return row ? rowToPost(row) : null;
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
          `UPDATE x_accounts SET screen_name=?, nickname=?, display_name=?, bili_uid=?, enabled=?, silent_next=?, updated_at=? WHERE id=?`,
        )
        .run(
          screenName,
          input.nickname !== undefined ? input.nickname : prev.nickname,
          input.displayName !== undefined ? input.displayName : prev.displayName,
          input.biliUid !== undefined ? input.biliUid : prev.biliUid,
          (input.enabled ?? prev.enabled) ? 1 : 0,
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
           (screen_name, nickname, display_name, bili_uid, enabled, last_tweet_id, last_tweet_at, last_ok_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        screenName,
        input.nickname ?? null,
        input.displayName ?? null,
        input.biliUid ?? null,
        (input.enabled ?? true) ? 1 : 0,
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
        .prepare('UPDATE weibo_accounts SET uid=?, nickname=?, display_name=?, bili_uid=?, enabled=?, silent_next=?, updated_at=? WHERE id=?')
        .run(
          uid,
          input.nickname !== undefined ? input.nickname : prev.nickname,
          input.displayName !== undefined ? input.displayName : prev.displayName,
          input.biliUid !== undefined ? input.biliUid : prev.biliUid,
          (input.enabled ?? prev.enabled) ? 1 : 0,
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
           (uid, nickname, display_name, bili_uid, enabled, last_post_id, last_post_at, last_ok_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
      )
      .run(uid, input.nickname ?? null, input.displayName ?? null, input.biliUid ?? null,
        (input.enabled ?? true) ? 1 : 0, t, t);
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
        .prepare('UPDATE bili_accounts SET uid=?, display_name=?, enabled=?, silent_next=?, updated_at=? WHERE id=?')
        .run(
          uid,
          input.displayName !== undefined ? input.displayName : prev.displayName,
          (input.enabled ?? prev.enabled) ? 1 : 0,
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
           (uid, display_name, enabled, last_ok_at, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?)`,
      )
      .run(uid, input.displayName ?? null,
        (input.enabled ?? true) ? 1 : 0, t, t);
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
