/**
 * x_accounts 表（X/推特独立关注名单）的行类型与「行 ↔ 对象」映射。
 *
 * X 是**独立于 B站的一条路径**：这份名单不复用 streamers / follows——X 账号本就不是
 * B站主播（日系声优类账号尤其如此）。`biliUid` 只是可选关联，仅用于展示与推送文案。
 *
 * 设计哲学同 posts/push：去重与增量都靠平台的稳定 id（`last_tweet_id` 是只往前推的游标），
 * 不用时间戳判新旧。
 */

export interface XAccountRow {
  id: number;
  screen_name: string;
  display_name: string | null;
  bili_uid: string | null;
  enabled: number;
  last_tweet_id: string | null;
  last_tweet_at: number | null;
  last_ok_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface XAccount {
  id: number;
  /** 归一化后的 screen name（去 @、小写） */
  screenName: string;
  /** 抓到就存（推文 user.name）；未抓到为 null */
  displayName: string | null;
  /** 可选关联主播（引用 streamers.uid；仅展示与文案用，不参与抓取） */
  biliUid: string | null;
  enabled: boolean;
  /** 增量游标：最近一次见到的推文 id（只往前推） */
  lastTweetId: string | null;
  lastTweetAt: number | null;
  /** 最近一次成功抓取（健康可视化：面板按它区分「抓过」与「从没成功」） */
  lastOkAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface NewXAccount {
  screenName: string;
  displayName: string | null;
  biliUid: string | null;
  enabled: boolean;
}

export interface XAccountInput {
  id?: number;
  screenName?: string;
  displayName?: string | null;
  biliUid?: string | null;
  enabled?: boolean;
}

/** 抓取成功后的回写（可选字段：只更新拿到的部分） */
export interface XAccountFetchTouch {
  lastTweetId?: string | null;
  lastTweetAt?: number | null;
  lastOkAt?: number;
}

/**
 * screen name 归一化：去 `@`、去空白、转小写。
 * X 的 screen name 大小写不敏感且唯一，统一小写可避免「同一账号加两遍」。
 */
export function normalizeScreenName(raw: string): string {
  return raw.trim().replace(/^@+/, '').toLowerCase();
}

/** 形状校验：X 的 screen name 只允许字母数字下划线，1~15 位 */
export function isValidScreenName(s: string): boolean {
  return /^[a-z0-9_]{1,15}$/.test(s);
}

export function rowToXAccount(r: XAccountRow): XAccount {
  return {
    id: r.id,
    screenName: r.screen_name,
    displayName: r.display_name,
    biliUid: r.bili_uid,
    enabled: r.enabled === 1,
    lastTweetId: r.last_tweet_id,
    lastTweetAt: r.last_tweet_at,
    lastOkAt: r.last_ok_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}