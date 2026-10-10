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

/** 内容主体类型：分类 applies_to / 推送规则 subject_kind / verdicts subject_type 同域 */
export type SubjectKind = 'live' | 'post';

/** 帖子类型标签（分类 post_types 条件组的取值域；fromPostCandidate 折叠后的 type） */
export type PostType = 'original' | 'retweet';

export interface CategoryRow {
  id: number;
  name: string;
  /** LLM 判定提示词；null = 纯确定性分类 */
  llm_prompt: string | null;
  keywords: string;
  areas: string;
  /** 分类服务的内容类型（live=直播场次 / post=图文帖），UI 按此渲染可用算子 */
  applies_to: SubjectKind;
  /** JSON：'original'/'retweet' 子集，空 = 不限 */
  post_types: string;
  /** 必须是引用帖（仅 X 免登录回退路线产出 isQuote，其余平台永不命中） */
  require_quote: number;
  /** 必须带图 */
  require_media: number;
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
  /** 标题/正文子串，任一命中（大小写不敏感）；空 = 该组不参与 */
  keywords: string[];
  /** 分区子串（areaName / parentAreaName 都匹配），任一命中；空 = 该组不参与（仅 live） */
  areas: string[];
  /** 帖子类型集合（原创/转发任一命中）；空 = 不限（仅 post） */
  postTypes: PostType[];
  /** 必须是引用帖（仅 post；沿用旧 quote 语义——只有 X 免登录回退路线可能命中） */
  requireQuote: boolean;
  /** 必须带图（仅 post） */
  requireMedia: boolean;
  /** 分类服务的内容类型（live / post） */
  appliesTo: SubjectKind;
  /** 各条件组之间的关系（空组忽略；全部条件组皆空且无 LLM 提示词 = 死分类） */
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
    postTypes: JSON.parse(r.post_types) as PostType[],
    requireQuote: r.require_quote === 1,
    requireMedia: r.require_media === 1,
    appliesTo: r.applies_to,
    condMode: r.cond_mode,
    enabled: r.enabled === 1,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// ---- push_rules v2：推送规则（统一规则：分类引用 × 生效范围 × 渠道 × 推送词 × 附加动作）----
//
// subject_kind 区分内容形态（live=开播 / post=图文帖），字段完全一致；
// scope 是**主体引用列表**：live = 主播 uid；post = 账号引用（`twitter:screenName` /
// `weibo:uid` / `bili:uid`，见 postSubjectRef）。**空 = 全部生效**（D1，两形态统一）。

export interface PushRuleRow {
  id: number;
  /** 规则名称（面板列表展示）；不传时补「规则 <id>」 */
  name: string;
  subject_kind: SubjectKind;
  /** 引用 categories.id；NULL = 任意内容 */
  category_id: number | null;
  /** 生效范围 JSON 数组（live=uid / post=账号引用）；'[]' = 全部生效 */
  scope: string;
  channels: string;
  message_template: string | null;
  /** 附加动作：推送时附 LLM 译文（仅 X 内容运行时生效） */
  llm_translate: number;
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
  /** 规则服务的内容形态：live=开播 / post=图文帖 */
  subjectKind: SubjectKind;
  /** null = 任意内容都命中；非空 = 该内容须被判定属于此分类 */
  categoryId: number | null;
  /** 生效主体集合（live=uid / post=账号引用）；空 = 全部生效（动态，含未来新增） */
  scope: string[];
  /** 引用 push_channels.id */
  channels: number[];
  /** null = 用内置默认模板（live '{liver} 开播了' / post 「作者 发布新xx」） */
  messageTemplate: string | null;
  /** 附加动作：推送时附 LLM 译文（仅 X 内容运行时生效） */
  llmTranslate: boolean;
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

/**
 * 图文帖的规则 scope 引用（A.2 钉死的格式）：`twitter:screenName` / `weibo:uid` / `bili:uid`。
 * 注意平台名折叠：PostCandidate.platform 的 'bili_dynamic' 在引用里写作 'bili'。
 */
export function postSubjectRef(platform: string, key: string): string {
  const p = platform === 'bili_dynamic' ? 'bili' : platform;
  return `${p}:${key}`;
}

export function rowToRule(r: PushRuleRow): PushRule {
  return {
    id: r.id, name: r.name, subjectKind: r.subject_kind,
    categoryId: r.category_id,
    scope: JSON.parse(r.scope) as string[],
    channels: JSON.parse(r.channels) as number[],
    messageTemplate: r.message_template,
    llmTranslate: r.llm_translate === 1,
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
        subjectKind: rule.subjectKind,
        categoryId: rule.categoryId,
        scope: rule.scope,
        channels: [channelId],
        messageTemplate: rule.messageTemplate,
        llmTranslate: rule.llmTranslate,
        enabled: rule.enabled,
        createdBy: 'mcp',
      });
    }),
    split: true,
  };
}

// ---- verdicts：内容判定归档（直播场次与图文帖同表，身份键 = subject_type + subject_id）----

export type VerdictSubjectType = SubjectKind;

/** 直播场次的 subject_id（`room_id:live_time`）；图文帖用 `postVerdictSubjectId` */
export function liveVerdictSubjectId(roomId: string, liveTime: number): string {
  return `${roomId}:${liveTime}`;
}

/** 图文帖的 subject_id（`platform:item_id`，与 liveVerdictSubjectId 并列的身份键） */
export function postVerdictSubjectId(platform: string, itemId: string): string {
  return `${platform}:${itemId}`;
}

export interface VerdictRow {
  id: number;
  subject_type: VerdictSubjectType;
  /** live = `room_id:live_time`；post = `platform:item_id` */
  subject_id: string;
  uid: string;
  /** 分类引用；0 = 不适用哨兵（规则级判定只填 rule_id） */
  category_id: number;
  /** 图文规则级判定引用（P1b）；0 = 不适用哨兵（分类级判定） */
  rule_id: number;
  /** 冗余存名，分类删除后历史仍可读 */
  category_name: string;
  source: 'llm' | 'rule' | 'decision';
  /** 1 = 判定通过（属于）；0 = 判定不通过（P1b 图文规则级判定用） */
  pass: number;
  /** LLM 路径置信度，rule 路径为 NULL */
  confidence: number | null;
  /** LLM 证据 / 命中的关键词·分区说明 */
  evidence: string;
  created_at: number;
}

export interface Verdict {
  id: number;
  subjectType: VerdictSubjectType;
  subjectId: string;
  uid: string;
  /** 0 = 不适用哨兵 */
  categoryId: number;
  /** 0 = 不适用哨兵 */
  ruleId: number;
  categoryName: string;
  source: 'llm' | 'rule' | 'decision';
  pass: boolean;
  confidence: number | null;
  evidence: string;
  createdAt: number;
}

/** 判定入参：pass 缺省 true（直播现存语义 = 只记「属于」） */
export type NewVerdict = Omit<Verdict, 'id' | 'createdAt' | 'pass'> & { pass?: boolean };

export function rowToVerdict(r: VerdictRow): Verdict {
  return {
    id: r.id, subjectType: r.subject_type, subjectId: r.subject_id, uid: r.uid,
    categoryId: r.category_id, ruleId: r.rule_id, categoryName: r.category_name,
    source: r.source, pass: r.pass === 1,
    confidence: r.confidence, evidence: r.evidence, createdAt: r.created_at,
  };
}
