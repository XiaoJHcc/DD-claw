/**
 * push_channels / categories / push_rules / verdicts / settings 各表的行类型与
 * 「行 ↔ 对象」映射。类型与 JSON 字段的序列化集中在这里，同 streamers.ts 惯例；
 * 表结构见 db.ts SCHEMA 与 design.md。
 */
import type { Db } from './db.js';

// ---- push_channels：推送渠道（面板统一管理，主播规则只引用 id）----

export type ChannelNotifier = 'toast' | 'onebot';
export type ChannelTargetType = 'group' | 'private';

export interface PushChannelRow {
  id: number;
  name: string;
  notifier: ChannelNotifier;
  target_type: ChannelTargetType | null;
  target_id: string | null;
  enabled: number;
  /** 面板拖拽排序（展示顺序）；行对象不暴露，排序是列表内部实现 */
  sort: number;
  created_at: number;
  updated_at: number;
}

export interface PushChannel {
  id: number;
  /** 用户起的名，如「粉丝群」 */
  name: string;
  notifier: ChannelNotifier;
  /** toast 为 null */
  targetType: ChannelTargetType | null;
  /** QQ号/群号，toast 为 null */
  targetId: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type NewPushChannel = Omit<PushChannel, 'id' | 'createdAt' | 'updatedAt'>;
/** upsert 输入：带 id 且存在 = 改行（未提供字段保留原值）；否则建行（缺省取默认值） */
export type PushChannelInput = Partial<NewPushChannel> & { id?: number };

export function rowToChannel(r: PushChannelRow): PushChannel {
  return {
    id: r.id, name: r.name, notifier: r.notifier,
    targetType: r.target_type, targetId: r.target_id,
    enabled: r.enabled === 1,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// ---- settings：推送总开关 ----

export function isPushEnabled(db: Db): boolean {
  return db.getSetting('push_enabled') !== '0';
}

export function setPushEnabled(db: Db, enabled: boolean): void {
  db.setSetting('push_enabled', enabled ? '1' : '0');
}

// ---- categories：分类规则（全局定义，归类结果入 verdicts 表）----

export type CondMode = 'and' | 'or';

export interface CategoryRow {
  id: number;
  name: string;
  /** LLM 判定提示词；null = 纯确定性分类 */
  llm_prompt: string | null;
  keywords: string;
  areas: string;
  cond_mode: CondMode;
  enabled: number;
  /** 面板拖拽排序（展示顺序）；行对象不暴露 */
  sort: number;
  created_at: number;
  updated_at: number;
}

export interface Category {
  id: number;
  name: string;
  /** LLM 判定提示词；null = 无 LLM 判定，永远走确定性条件 */
  llmPrompt: string | null;
  /** 标题子串，任一命中（大小写不敏感）；空 = 该组不参与 */
  keywords: string[];
  /** 分区子串（areaName / parentAreaName 都匹配），任一命中；空 = 该组不参与 */
  areas: string[];
  /** 关键词组与分区组之间的关系（空组忽略；两组皆空 = 不命中） */
  condMode: CondMode;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type NewCategory = Omit<Category, 'id' | 'createdAt' | 'updatedAt'>;
/** upsert 输入：带 id 且存在 = 改行（未提供字段保留原值）；否则建行（缺省取默认值） */
export type CategoryInput = Partial<NewCategory> & { id?: number };

export function rowToCategory(r: CategoryRow): Category {
  return {
    id: r.id, name: r.name, llmPrompt: r.llm_prompt,
    keywords: JSON.parse(r.keywords) as string[],
    areas: JSON.parse(r.areas) as string[],
    condMode: r.cond_mode,
    enabled: r.enabled === 1,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// ---- push_rules v2：推送规则（全局；分类引用 + 生效主播集合，全部命中独立生效）----

export interface PushRuleRow {
  id: number;
  /** 规则名称（面板列表展示）；不传时补「规则 <id>」 */
  name: string;
  /** 引用 categories.id；NULL = 任意开播 */
  category_id: number | null;
  uids: string;
  channels: string;
  message_template: string | null;
  enabled: number;
  /** 创建来源：NULL = 面板/人工；'mcp' = MCP 群自助（gateway 只能动自己创建的） */
  created_by: string | null;
  /** 全局匹配优先级（面板拖拽排序）；行对象不暴露 */
  sort: number;
  created_at: number;
  updated_at: number;
}

export interface PushRule {
  id: number;
  /** 规则名称（面板列表展示） */
  name: string;
  /** null = 任意开播都命中；非空 = 该场直播须被判定属于此分类 */
  categoryId: number | null;
  /** 生效主播集合；空 = 全部主播（动态，含未来新增） */
  uids: string[];
  /** 引用 push_channels.id */
  channels: number[];
  /** null = 用内置默认模板（'{liver} 开播了'） */
  messageTemplate: string | null;
  enabled: boolean;
  /** 创建来源：null = 面板/人工；'mcp' = MCP 群自助（gateway 角色只能增删自己创建的规则） */
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export type NewPushRule = Omit<PushRule, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'> & {
  createdBy?: string | null;
};
export type PushRuleInput = Partial<NewPushRule> & { id?: number };

export function rowToRule(r: PushRuleRow): PushRule {
  return {
    id: r.id, name: r.name, categoryId: r.category_id,
    uids: JSON.parse(r.uids) as string[],
    channels: JSON.parse(r.channels) as number[],
    messageTemplate: r.message_template,
    enabled: r.enabled === 1,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/**
 * copy-on-write 拆分（docs/plan/agent-access.md「多渠道规则：copy-on-write 拆分」）：
 * 自助要动一条**多渠道**规则时先把它拆开——原规则保留其余渠道（`created_by` **原样不动**），
 * 另建一条只含 `channelId` 的规则（`created_by='mcp'`）；后续自助写只操作新拆出的这条。
 * 原规则本就只剩本渠道时**不拆**（返回原 id，就地操作）。
 *
 * 两侧的 `created_by` 都必须显式设定：`upsertPushRule` 不传 createdBy 时沿用原值（见 db.ts），
 * 沿用会把面板规则标成 mcp 规则——gateway 的越权面就是这么开出来的。
 * 拆出的副本与对原规则的改写在一个事务里（拆分与后续写同一事务的前提）。
 *
 * @returns `{ id, split }`：`id` = 后续写应操作的目标（拆出的一条 or 原规则），`split` = 是否真的拆了。
 */
export function splitPushRuleChannel(
  db: Db,
  rule: PushRule,
  channelId: number,
): { id: number; split: boolean } {
  if (!rule.channels.includes(channelId)) {
    throw new Error(`规则 #${rule.id} 不含渠道 #${channelId}，不能拆分（调用方须先做渠道归属校验）`);
  }
  if (rule.channels.length <= 1) return { id: rule.id, split: false };
  return {
    id: db.transaction(() => {
      db.upsertPushRule({
        id: rule.id,
        channels: rule.channels.filter((c) => c !== channelId),
        createdBy: rule.createdBy,
      });
      return db.upsertPushRule({
        name: rule.name,
        categoryId: rule.categoryId,
        uids: rule.uids,
        channels: [channelId],
        messageTemplate: rule.messageTemplate,
        enabled: rule.enabled,
        createdBy: 'mcp',
      });
    }),
    split: true,
  };
}

// ---- verdicts：每场直播的分类判定结果 ----

export interface VerdictRow {
  id: number;
  room_id: string;
  live_time: number;
  uid: string;
  category_id: number;
  /** 冗余存名，分类删除后历史仍可读 */
  category_name: string;
  source: 'llm' | 'rule';
  /** LLM 路径置信度，rule 路径为 NULL */
  confidence: number | null;
  /** LLM 证据 / 命中的关键词·分区说明 */
  evidence: string;
  created_at: number;
}

export interface Verdict {
  id: number;
  roomId: string;
  liveTime: number;
  uid: string;
  categoryId: number;
  categoryName: string;
  source: 'llm' | 'rule';
  confidence: number | null;
  evidence: string;
  createdAt: number;
}

export type NewVerdict = Omit<Verdict, 'id' | 'createdAt'>;
