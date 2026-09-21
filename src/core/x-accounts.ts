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
  nickname: string | null;
  display_name: string | null;
  bili_uid: string | null;
  enabled: number;
  rule_ids: string;
  silent_next: number;
  last_tweet_id: string | null;
  last_tweet_at: number | null;
  last_ok_at: number | null;
  avatar: string | null;
  created_at: number;
  updated_at: number;
}

export interface XAccount {
  id: number;
  /** 归一化后的 screen name（去 @、小写）——X 的「ID」（@handle，唯一标识），不是昵称 */
  screenName: string;
  /** X 的昵称（平台 display name，user.name / og:title）——平台事实：添加时 verify 种入、
   *  抓取回写，输入面（面板 / MCP）不接受手填 */
  nickname: string | null;
  /** 自定义显示名（卡片优先展示；留空 = 用昵称，同 weibo_accounts.display_name 语义） */
  displayName: string | null;
  /** 可选关联主播（引用 streamers.uid；仅展示与文案用，不参与抓取） */
  biliUid: string | null;
  enabled: boolean;
  /** 选用的图文帖规则（post_rules.id）；空 = 这个账号的帖子一律不推 */
  ruleIds: number[];
  /** 主动关闭恢复位：重新启用（或图文开关重开，见 setListen）时置位，恢复轮询的
   *  首轮静默归档不补推（「主动关闭意图：显然不推」），源消费后清位 */
  silentNext: boolean;
  /** 增量游标：最近一次见到的推文 id（只往前推） */
  lastTweetId: string | null;
  lastTweetAt: number | null;
  /** 最近一次成功抓取（健康可视化：面板按它区分「抓过」与「从没成功」） */
  lastOkAt: number | null;
  /** 本地头像缓存文件名（cache/x-avatars 下，md5 命名）；未抓到为 null，前端回退关联主播头像 */
  avatar: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface NewXAccount {
  screenName: string;
  nickname: string | null;
  displayName: string | null;
  biliUid: string | null;
  enabled: boolean;
}

export interface XAccountInput {
  id?: number;
  screenName?: string;
  nickname?: string | null;
  displayName?: string | null;
  biliUid?: string | null;
  enabled?: boolean;
  ruleIds?: number[];
}

/** 抓取成功后的回写（可选字段：只更新拿到的部分） */
export interface XAccountFetchTouch {
  lastTweetId?: string | null;
  lastTweetAt?: number | null;
  lastOkAt?: number;
  /** 抓到的平台昵称（og:title / user.name；昵称会改，只有拿到非空才回写，同 weibo 纪律） */
  nickname?: string | null;
  /** 本地头像缓存文件名（已下载成功才传） */
  avatar?: string | null;
  /** 恢复位消费：源在恢复轮传 false 清位（置位只走重新启用/开关重开路径，抓取不置位） */
  silentNext?: boolean;
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
    nickname: r.nickname,
    displayName: r.display_name,
    biliUid: r.bili_uid,
    enabled: r.enabled === 1,
    ruleIds: JSON.parse(r.rule_ids) as number[],
    silentNext: r.silent_next === 1,
    lastTweetId: r.last_tweet_id,
    lastTweetAt: r.last_tweet_at,
    lastOkAt: r.last_ok_at,
    avatar: r.avatar,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}