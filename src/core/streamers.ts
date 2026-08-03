/**
 * streamers / follows / preference_clauses 三表的行类型与「行 ↔ 对象」映射。
 * 类型与 JSON 字段的序列化集中在这里，避免 db.ts 膨胀；
 * 表结构见 design.md §6（Streamer / PreferenceClause）。
 */

export type StreamerSource = 'follows' | 'manual';
export type Priority = 'high' | 'normal' | 'low';

export interface PushTargetRef {
  type: 'group' | 'private';
  id: string;
}

// ---- streamers：监听名单（事实来源；config.json 的 subscriptions 仅为种子）----

export interface StreamerRow {
  uid: string;
  uname: string;
  alias: string | null;
  room_id: string | null;
  weibo_uid: string | null;
  weibo_nick: string | null;
  watch: number;
  analyze: number;
  notify: number;
  profile_note: string | null;
  face: string | null;
  source: StreamerSource;
  created_at: number;
  updated_at: number;
}

export interface Streamer {
  uid: string;
  uname: string;
  alias: string | null;
  roomId: string | null;
  weiboUid: string | null;
  /** 微博昵称（面板直填，保存时解析为 weiboUid） */
  weiboNick: string | null;
  /** 监听：抓取开播状态/动态（watch=1 && notify=0 = 旧 silent 语义） */
  watch: boolean;
  /** LLM 分析开关（功能未接入，先存设置） */
  analyze: boolean;
  /** 推送开关：false = 只记录不打扰 */
  notify: boolean;
  profileNote: string | null;
  face: string | null;
  source: StreamerSource;
  createdAt: number;
  updatedAt: number;
}

/** upsert 输入：uid 必填，其余缺省 = 建行时用默认值、改行时保留原值 */
export type StreamerInput = Partial<Omit<Streamer, 'uid' | 'createdAt' | 'updatedAt'>> & { uid: string };

export function rowToStreamer(r: StreamerRow): Streamer {
  return {
    uid: r.uid, uname: r.uname, alias: r.alias,
    roomId: r.room_id, weiboUid: r.weibo_uid, weiboNick: r.weibo_nick ?? null,
    watch: r.watch === 1, analyze: r.analyze === 1, notify: r.notify === 1,
    profileNote: r.profile_note, face: r.face ?? null, source: r.source,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// ---- follows：关注列表候选池 ----

export interface FollowRow {
  uid: string;
  uname: string;
  face: string | null;
  first_seen: number;
  last_seen: number;
  is_followed: number;
}

export interface Follow {
  uid: string;
  uname: string;
  face: string | null;
  firstSeen: number;
  lastSeen: number;
  isFollowed: boolean;
}

export function rowToFollow(r: FollowRow): Follow {
  return {
    uid: r.uid, uname: r.uname, face: r.face ?? null,
    firstSeen: r.first_seen, lastSeen: r.last_seen,
    isFollowed: r.is_followed === 1,
  };
}

// ---- preference_clauses：结构化偏好子句（面板直填，matcher 消费）----

export interface ClauseRow {
  id: number;
  uid: string;
  scenes: string | null;
  min_confidence: number | null;
  title_keywords: string | null;
  priority: Priority;
  message_template: string;
  targets: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface PreferenceClause {
  id: number;
  uid: string;
  scenes: string[];
  minConfidence: number | null;
  titleKeywords: string[];
  priority: Priority;
  messageTemplate: string;
  /** null = 默认目标 */
  targets: PushTargetRef[] | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type NewClause = Omit<PreferenceClause, 'id' | 'createdAt' | 'updatedAt'>;
export type ClausePatch = Partial<NewClause>;

export function rowToClause(r: ClauseRow): PreferenceClause {
  return {
    id: r.id, uid: r.uid,
    scenes: r.scenes ? (JSON.parse(r.scenes) as string[]) : [],
    minConfidence: r.min_confidence,
    titleKeywords: r.title_keywords ? (JSON.parse(r.title_keywords) as string[]) : [],
    priority: r.priority,
    messageTemplate: r.message_template,
    targets: r.targets ? (JSON.parse(r.targets) as PushTargetRef[]) : null,
    enabled: r.enabled === 1,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** 对象字段 → 行字段（写库用；JSON 数组序列化为字符串） */
export function clauseToRow(c: NewClause): Omit<ClauseRow, 'id' | 'created_at' | 'updated_at'> {
  return {
    uid: c.uid,
    scenes: JSON.stringify(c.scenes),
    min_confidence: c.minConfidence,
    title_keywords: JSON.stringify(c.titleKeywords),
    priority: c.priority,
    message_template: c.messageTemplate,
    targets: c.targets ? JSON.stringify(c.targets) : null,
    enabled: c.enabled ? 1 : 0,
  };
}
