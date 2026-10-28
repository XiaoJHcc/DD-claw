/**
 * push_channels / categories / push_rules / verdicts / primary_verdicts / settings 各表的行类型与
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

// ---- 判定模式：简单（一句判定描述）/ 精确（逐条原子条件）----
//
// 两套数据**永远双份保留**：`judgeMode` 只决定模型判定读哪一份，切换模式绝不清空另一份
// （切回简单模式时旧判定描述还在，反之亦然）。确定性条件组（keywords/areas/…）与模式无关。

/** 分类的模型判定口径：simple = `llmPrompt` 一句定义；precise = 逐条原子条件 */
export type JudgeMode = 'simple' | 'precise';

/** 精确条件的方向：pass = 正向（任一成立即可支持），reject = 负向（任一成立即否决） */
export type JudgeDirection = 'pass' | 'reject';

/**
 * 一条原子判定条件（只服务模型判定；确定性条件组是另一套，两者互不影响）。
 * `id` 在分类内稳定——试判逐条概率与审计按它对齐，改动顺序不影响已有条件；
 * 数组顺序即展示顺序。
 */
export interface JudgeCondition {
  id: string;
  direction: JudgeDirection;
  text: string;
  enabled: boolean;
}

/** 内容主体类型：分类 applies_to / 推送规则 subject_kind / verdicts subject_type 同域 */
export type SubjectKind = 'live' | 'post';

/** 帖子类型标签（分类 post_types 条件组的取值域；fromPostCandidate 折叠后的 type） */
export type PostType = 'original' | 'retweet';

export interface CategoryRow {
  id: number;
  name: string;
  /** 简单模式的判定提示词；precise 模式下保留但不参与判定 */
  llm_prompt: string | null;
  /** 模型判定口径：simple 读 llm_prompt / precise 读 judge_conditions */
  judge_mode: JudgeMode;
  /** JSON：精确模式的条件数组（正负向、启用态、稳定 id）；两模式共存，切换不清空 */
  judge_conditions: string;
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
  /** 是否属于主分类组（单选展示用：时间表等取「最像的一个」） */
  is_primary: number;
  enabled: number;
  /** 面板拖拽排序（展示顺序）；行对象不暴露 */
  sort: number;
  created_at: number;
  updated_at: number;
}

export interface Category {
  id: number;
  name: string;
  /** 简单模式的判定提示词；precise 模式下保留但不参与判定 */
  llmPrompt: string | null;
  /** 模型判定口径：simple = 只用 llmPrompt；precise = 只用 judgeConditions（precise 下不读 llmPrompt） */
  judgeMode: JudgeMode;
  /** 精确模式的原子条件（含停用项，数组顺序即展示顺序）；simple 模式下同样保留，切模式不丢 */
  judgeConditions: JudgeCondition[];
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
  /** 各条件组之间的关系（空组忽略；全部条件组皆空且无当前模式判定口径 = 死分类） */
  condMode: CondMode;
  /** 属于主分类组：主分类判定的候选集（时间表等展示用的单选分类，不参与确定性条件） */
  primary: boolean;
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
    judgeMode: r.judge_mode === 'precise' ? 'precise' : 'simple',
    judgeConditions: parseJudgeConditions(r.judge_conditions),
    keywords: JSON.parse(r.keywords) as string[],
    areas: JSON.parse(r.areas) as string[],
    postTypes: JSON.parse(r.post_types) as PostType[],
    requireQuote: r.require_quote === 1,
    requireMedia: r.require_media === 1,
    appliesTo: r.applies_to,
    condMode: r.cond_mode,
    primary: r.is_primary === 1,
    enabled: r.enabled === 1,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/**
 * `judge_conditions` 列的读取口径：坏 JSON / 坏项一律丢弃——一条脏数据不该让整张分类列表读不出来。
 * `enabled` 缺失按启用读（输入层总是显式落布尔，缺失只可能是手工改库或更早的中间态）。
 */
export function parseJudgeConditions(raw: string | null | undefined): JudgeCondition[] {
  if (typeof raw !== 'string' || raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: JudgeCondition[] = [];
  for (const v of parsed) {
    if (typeof v !== 'object' || v === null) continue;
    const o = v as Record<string, unknown>;
    if (typeof o.id !== 'string' || o.id === '') continue;
    if (o.direction !== 'pass' && o.direction !== 'reject') continue;
    if (typeof o.text !== 'string') continue;
    out.push({ id: o.id, direction: o.direction, text: o.text, enabled: o.enabled !== false });
  }
  return out;
}

/** 参与判定的精确条件：停用与空白文本不参与（数组顺序 = 展示顺序） */
export function activeJudgeConditions(c: Pick<Category, 'judgeConditions'>): JudgeCondition[] {
  return c.judgeConditions.filter((x) => x.enabled && x.text.trim() !== '');
}

/** 精确条件的正负分组：判定语义是 `(P1 OR P2 …) AND NOT (N1 OR N2 …)`，负向集合可空 */
export function preciseConditions(c: Pick<Category, 'judgeConditions'>): {
  positives: JudgeCondition[];
  negatives: JudgeCondition[];
} {
  const active = activeJudgeConditions(c);
  return {
    positives: active.filter((x) => x.direction === 'pass'),
    negatives: active.filter((x) => x.direction === 'reject'),
  };
}

/** 精确条件的落库序列化（唯一口径：db.ts 的 upsert 与行映射共用，字段顺序由类型决定） */
export function serializeJudgeConditions(list: JudgeCondition[]): string {
  return JSON.stringify(list);
}

/**
 * 该分类有没有交给模型判定的口径（决定它进不进 LLM / 决策档）：
 * - simple：`llmPrompt` 非空
 * - precise：至少一条**启用的正向条件**（只有负向不构成口径——「什么都不成立」不是分类标准）
 *
 * 精确模式**绝不回退** `llmPrompt`：那是简单模式的数据，只是与精确条件一起被保留下来而已。
 * 无口径的分类按既有「无模型条件」路径走：只由确定性条件判定，模型档不参与。
 */
export function hasJudgeBasis(c: Category): boolean {
  if (c.judgeMode === 'precise') return preciseConditions(c).positives.length > 0;
  return (c.llmPrompt ?? '').trim() !== '';
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

// ---- verdicts / primary_verdicts：内容判定归档（直播场次与图文帖同表，身份键 = subject_type + subject_id）----
//
// 两种判定各一张表：verdicts 存「属于 / 不属于每个分类」（推送规则只读生效行），
// primary_verdicts 存「最像主分类组里的哪一个」（时间表等展示只读生效行）。
// 判决链每档的结论都落库，`effective` 标记哪一行是最终生效结论。

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
  /** 规则级判定的规则引用（旧图文规则级判定遗留）；0 = 不适用哨兵（分类级判定） */
  rule_id: number;
  /** 冗余存名，分类删除后历史仍可读 */
  category_name: string;
  source: 'llm' | 'rule' | 'decision';
  /** 1 = 判定通过（属于）；0 = 判定不通过 */
  pass: number;
  /** 仅决策模型的 P(属于)；其余来源 NULL */
  confidence: number | null;
  /** 确定性命中说明 / LLM 理由 / 决策回答者 */
  evidence: string;
  /** 1 = 该分类本条为生效结论（每个主体每个分类恰一行；消费方只读这些行） */
  effective: number;
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
  effective: boolean;
  createdAt: number;
}

/** 判定入参：pass 缺省 true；effective 必填（调用方必须明确这一行是否为生效结论） */
export type NewVerdict = Omit<Verdict, 'id' | 'createdAt' | 'pass'> & { pass?: boolean };

export function rowToVerdict(r: VerdictRow): Verdict {
  return {
    id: r.id, subjectType: r.subject_type, subjectId: r.subject_id, uid: r.uid,
    categoryId: r.category_id, ruleId: r.rule_id, categoryName: r.category_name,
    source: r.source, pass: r.pass === 1,
    confidence: r.confidence, evidence: r.evidence, effective: r.effective === 1,
    createdAt: r.created_at,
  };
}

/**
 * 主分类判定（时间表等展示用的单选分类）：与是非判定互不约束，
 * 只回答「最像主分类组里的哪一个」。`categoryId = 0` = 「其他」。
 */
export interface PrimaryJudgement {
  source: 'llm' | 'rule' | 'decision';
  /** 0 = 「其他」（组内都不像） */
  categoryId: number;
  name: string;
  /** 各选项概率分布（仅决策模型有值） */
  distribution: Record<string, number> | null;
  evidence: string;
  /** 是否为本主体的生效主分类（每个主体至多一行） */
  effective: boolean;
}

export interface PrimaryVerdictRow {
  id: number;
  subject_type: VerdictSubjectType;
  subject_id: string;
  uid: string;
  /** 0 = 「其他」 */
  category_id: number;
  /** 冗余存名，分类删除后历史仍可读 */
  category_name: string;
  source: 'llm' | 'rule' | 'decision';
  /** JSON：选项 → 概率（仅决策模型） */
  distribution: string | null;
  evidence: string;
  effective: number;
  created_at: number;
}

export interface PrimaryVerdict extends PrimaryJudgement {
  id: number;
  subjectType: VerdictSubjectType;
  subjectId: string;
  uid: string;
  createdAt: number;
}

export type NewPrimaryVerdict = Omit<PrimaryVerdict, 'id' | 'createdAt'>;

export function rowToPrimaryVerdict(r: PrimaryVerdictRow): PrimaryVerdict {
  return {
    id: r.id, subjectType: r.subject_type, subjectId: r.subject_id, uid: r.uid,
    categoryId: r.category_id, name: r.category_name, source: r.source,
    distribution: r.distribution ? JSON.parse(r.distribution) as Record<string, number> : null,
    evidence: r.evidence, effective: r.effective === 1, createdAt: r.created_at,
  };
}
