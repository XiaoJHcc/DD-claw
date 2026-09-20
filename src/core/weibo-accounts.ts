/**
 * weibo_accounts 表（微博独立关注名单）的行类型与「行 ↔ 对象」映射。
 *
 * 微博曾是**主播的附属数据源**（绑 `streamers.weibo_uid`，只为 M3 预告与主播卡第三栏混排）。
 * 2026-09 起与 X 同构：微博也是一条**独立的图文来源**——独立名单、独立规则、独立推送。
 * `biliUid` 只是可选关联（展示、推送文案、主播卡第三栏混排），不参与抓取。
 *
 * 与 x_accounts 的差异（有意保留，不是不一致）：
 *  · 身份是数字 uid 而不是 screen name（`https://weibo.com/u/<uid>`），昵称可改、uid 不可改，
 *    所以增量游标与 posts.uid 一律用 uid，昵称只是展示字段（抓到就回写）。
 *  · 抓取需要登录态（全站共用一份 weibo-cookies），X 没有登录态。
 */
export interface WeiboAccountRow {
  id: number;
  uid: string;
  nickname: string | null;
  display_name: string | null;
  bili_uid: string | null;
  enabled: number;
  rule_ids: string;
  last_post_id: string | null;
  last_post_at: number | null;
  last_ok_at: number | null;
  avatar: string | null;
  created_at: number;
  updated_at: number;
}

export interface WeiboAccount {
  id: number;
  /** 微博数字 uid（`weibo.com/u/<uid>`），一切外键锚点 */
  uid: string;
  /** 微博昵称（抓到时回写；也可人填） */
  nickname: string | null;
  /** 自定义显示名（卡片优先展示；留空 = 用昵称，同 X 的 displayName 语义） */
  displayName: string | null;
  /** 可选关联主播（引用 streamers.uid；仅展示、文案与主播卡第三栏混排用） */
  biliUid: string | null;
  enabled: boolean;
  /** 选用的图文帖规则（post_rules.id）；空 = 这个账号的帖子一律不推 */
  ruleIds: number[];
  /** 增量游标：最近一次见到的微博 idstr（只往前推） */
  lastPostId: string | null;
  lastPostAt: number | null;
  /** 最近一次成功抓取（健康可视化：面板按它区分「抓过」与「从没成功」） */
  lastOkAt: number | null;
  /** 本地头像缓存文件名（cache/weibo-avatars 下，md5 命名）；未抓到为 null */
  avatar: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface NewWeiboAccount {
  uid: string;
  nickname: string | null;
  biliUid: string | null;
  enabled: boolean;
}

export interface WeiboAccountInput {
  id?: number;
  uid?: string;
  nickname?: string | null;
  displayName?: string | null;
  biliUid?: string | null;
  enabled?: boolean;
  ruleIds?: number[];
}

/** 抓取成功后的回写（可选字段：只更新拿到的部分） */
export interface WeiboAccountFetchTouch {
  lastPostId?: string | null;
  lastPostAt?: number | null;
  lastOkAt?: number;
  /** 抓到的昵称（昵称会改；只有拿到非空值才回写） */
  nickname?: string | null;
  /** 本地头像缓存文件名（已下载成功才传） */
  avatar?: string | null;
}

/** uid 归一化：去空白、去 `u/` 前缀与 URL 残留，只留数字 */
export function normalizeWeiboUid(raw: string): string {
  const s = raw.trim();
  const fromUrl = /weibo\.com\/(?:u\/)?(\d+)/i.exec(s);
  if (fromUrl) return fromUrl[1]!;
  return s.replace(/^u\//i, '').replace(/\D+/g, '');
}

/** 昵称归一化：去空白、剥开头的 @（微博的 @ 只是提及语法，昵称本身不含 @；用户常会习惯性打上） */
export function normalizeWeiboNick(raw: string): string {
  return raw.trim().replace(/^@+/, '');
}

/** 形状校验：微博 uid 是数字串（截图里是 10 位，但老账号有更短的，故只约束长度上界） */
export function isValidWeiboUid(s: string): boolean {
  return /^\d{1,20}$/.test(s);
}

export function rowToWeiboAccount(r: WeiboAccountRow): WeiboAccount {
  return {
    id: r.id,
    uid: r.uid,
    nickname: r.nickname,
    displayName: r.display_name,
    biliUid: r.bili_uid,
    enabled: r.enabled === 1,
    ruleIds: JSON.parse(r.rule_ids) as number[],
    lastPostId: r.last_post_id,
    lastPostAt: r.last_post_at,
    lastOkAt: r.last_ok_at,
    avatar: r.avatar,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---- 源运行状态快照（装配处持有；面板当前不展示，GET /api/weibo 只读它）----
// 为什么放在这里而不是 sources：与 X 同构——`XFeedSnapshot` 住在 core/x-config.ts，
// 装配处持有快照、面板只读；sources/panel 谁都不该依赖对方的类型。

/** 微博源运行状态（抓不到 vs 没新帖必须可区分；失败轮的 lastError 带账号） */
export interface WeiboFeedSnapshot {
  running: boolean;
  lastRunAt: number | null;
  /** 最近一次有账号抓成功（比手动探测更真的可用证据） */
  lastOkAt: number | null;
  /** 本轮轮询账号数 / 其中成功的 */
  accounts: number;
  okAccounts: number;
  lastError: string | null;
}

export function emptyWeiboFeedSnapshot(): WeiboFeedSnapshot {
  return {
    running: false,
    lastRunAt: null,
    lastOkAt: null,
    accounts: 0,
    okAccounts: 0,
    lastError: null,
  };
}
