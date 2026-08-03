/**
 * streamers / follows 两表的行类型与「行 ↔ 对象」映射。
 * 类型与 JSON 字段的序列化集中在这里，避免 db.ts 膨胀；
 * 表结构见 design.md §6。推送相关的表见 push.ts。
 */

export type StreamerSource = 'follows' | 'manual';

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
