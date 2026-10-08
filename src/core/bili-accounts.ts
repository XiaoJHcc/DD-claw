/**
 * bili_accounts 表（B站动态独立账号名单）的行类型与「行 ↔ 对象」映射。
 *
 * B站动态的**抓取**名单仍是 streamers（动态源对监听主播每轮拉空间动态，见
 * sources/bili/dynamic.ts）；这份名单只管**推送**：post_rules 的生效范围从规则内嵌
 * account_ids 搬到账号侧 rule_ids 后，动态账号也需要自己的一份名单来挂规则——
 * 「这个账号的动态按哪些图文帖规则推」由这里的 rule_ids 决定，与 weibo_accounts 同构。
 *
 * 与 x/weibo 名单的差异（有意保留，不是不一致）：
 *  · 身份就是 B站 uid，账号本身就是主播——推送文案的关联主播（{liver}）直接按 uid
 *    反查 streamers，不需要 x/weibo 那样的可选 biliUid 关联列。
 *  · 没有增量游标列：动态的去重靠 posts 的 UNIQUE(platform, item_id)，增量判新旧
 *    由动态源自己管（首轮静默归档），名单只留 last_ok_at 做健康可视化。
 */
export interface BiliAccountRow {
  id: number;
  uid: string;
  uname: string | null;
  display_name: string | null;
  enabled: number;
  rule_ids: string;
  silent_next: number;
  last_ok_at: number | null;
  avatar: string | null;
  fetch_fail_since: number | null;
  fetch_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface BiliAccount {
  id: number;
  /** B站数字 uid，一切外键锚点（posts.uid 也是它） */
  uid: string;
  /** B站用户名——平台事实：抓取回写，输入面（面板 / MCP）不接受手填 */
  uname: string | null;
  /** 自定义显示名（卡片优先展示；留空 = 用 uname，同 x/weibo 的 displayName 语义） */
  displayName: string | null;
  enabled: boolean;
  /** 选用的图文帖规则（post_rules.id）；空 = 这个账号的动态一律不推 */
  ruleIds: number[];
  /** 主动关闭恢复位：重新启用（或图文开关重开，见 setListen）时置位，恢复轮询的
   *  首轮静默归档不补推（「主动关闭意图：显然不推」），源消费后清位 */
  silentNext: boolean;
  /** 最近一次成功抓取（健康可视化：面板按它区分「抓过」与「从没成功」） */
  lastOkAt: number | null;
  /** 本地头像缓存文件名；未抓到为 null */
  avatar: string | null;
  /** 账号级抓取故障起点（持续满阈值才落；null = 正常）。长期问题不推送，面板账号卡展示 */
  fetchFailSince: number | null;
  /** 账号级抓取故障的最近原因（与 fetchFailSince 同生同灭） */
  fetchError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface NewBiliAccount {
  uid: string;
  displayName: string | null;
  enabled: boolean;
}

export interface BiliAccountInput {
  id?: number;
  uid?: string;
  displayName?: string | null;
  enabled?: boolean;
  ruleIds?: number[];
}

/** 抓取成功后的回写（可选字段：只更新拿到的部分） */
export interface BiliAccountFetchTouch {
  /** 抓到的用户名（用户名会改；只有拿到非空值才回写） */
  uname?: string | null;
  lastOkAt?: number;
  /** 本地头像缓存文件名（已下载成功才传） */
  avatar?: string | null;
  /** 恢复位消费：源在恢复轮传 false 清位（置位只走重新启用/开关重开路径，抓取不置位） */
  silentNext?: boolean;
  /** 账号级抓取故障记账：对象 = 落故障（since = 连续失败起点），null = 清故障，undefined = 不动 */
  fetchFail?: { since: number; error: string } | null;
}

/** uid 归一化：去空白、从 space.bilibili.com/<uid>（含 /dynamic 等后缀）提取，只留数字 */
export function normalizeBiliUid(raw: string): string {
  const s = raw.trim();
  const fromUrl = /space\.bilibili\.com\/(\d+)/i.exec(s);
  if (fromUrl) return fromUrl[1]!;
  return s.replace(/\D+/g, '');
}

/** 形状校验：B站 uid 是数字串（只约束长度上界，老账号位数更短） */
export function isValidBiliUid(s: string): boolean {
  return /^\d{1,20}$/.test(s);
}

export function rowToBiliAccount(r: BiliAccountRow): BiliAccount {
  return {
    id: r.id,
    uid: r.uid,
    uname: r.uname,
    displayName: r.display_name,
    enabled: r.enabled === 1,
    ruleIds: JSON.parse(r.rule_ids) as number[],
    silentNext: r.silent_next === 1,
    lastOkAt: r.last_ok_at,
    avatar: r.avatar,
    fetchFailSince: r.fetch_fail_since ?? null,
    fetchError: r.fetch_error ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
