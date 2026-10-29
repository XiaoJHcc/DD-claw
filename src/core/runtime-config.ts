/**
 * 运行时参数（settings 表唯一信源，面板按模块收纳：监听「抓取设置」/ LLM「高级」/
 * 推送渠道「推送设置」/ 直播分类「分类时机」，保存即热生效）。
 * 无 settings 记录时用规格表里的代码默认值——不存在任何文件侧来源。
 *
 * 消费路径：
 * - 各 source 的轮询间隔/告警阈值：index.ts 用 withRuntimeConfig 合并出生效 AppConfig
 *   传给 SourceContext；参数变化时 reconcile 重启对应 source 刷新。
 * - 冷启动推送开关：pipeline 每次处理信号经 isNotifyOnFirstRun 等 helper 直读 settings。
 * - 直播分类时机（哪些档在哪个时机参与、延迟/定时/LLM 冷却）：pipeline 每次判定经
 *   `getLiveJudgeSelection` / `getLiveClassifyTiming` 直读；定时器间隔由装配根的
 *   `LiveClassifyTriggers.reconfigure()` 重排。
 * - LLM 超时/熔断：createLlmRouter 重建时取 withRuntimeConfig 合并结果。
 * - 决策模型超时/熔断：createDecisionRouter 重建时直读本表；判定门槛（灰区/主分类）
 *   由判定档每次直读，改完即生效。
 */
import type { Db } from './db.js';
import type { AppConfig } from '../config/schema.js';

export interface RuntimeConfig {
  pollIntervalSec: number;
  pollJitterSec: number;
  healthAlertToastAfterSec: number;
  followsSyncIntervalSec: number;
  dynamicIntervalSec: number;
  weiboIntervalSec: number;
  llmRequestTimeoutMs: number;
  llmCircuitThreshold: number;
  llmCircuitCooldownMs: number;
  /** 决策模型的是非灰区与主分类门槛（settings 存整数百分数，消费时 /100） */
  decisionGrayLowPct: number;
  decisionGrayHighPct: number;
  decisionPrimaryMinPct: number;
  decisionRequestTimeoutMs: number;
  decisionCircuitThreshold: number;
  decisionCircuitCooldownMs: number;
  notifyOnFirstRun: boolean;
  notifyOnNewSubscription: boolean;
  keyframeIntervalSec: number;
  keyframeEnabled: boolean;
  backlogPushEnabled: boolean;
  backlogMaxAgeHours: number;
  backlogMaxPerAccount: number;
  /** 直播分类时机：同一 roomId 的两次 LLM 判定最短间隔（0 = 不设冷却） */
  liveClassifyLlmCooldownMin: number;
  /** 开播后 / 标题分区变更后的延迟重判间隔（两个延迟时机共用） */
  liveClassifyDelayMin: number;
  /** 直播中定时重判间隔 */
  liveClassifyPeriodicMin: number;
  // 五个分类时机各自选哪些判定档参与（规则=确定性条件 / 决策=决策模型 / LLM）。
  // 三档全关 = 该时机不判定（等于关闭），不会清空已有判定。
  liveClassifyStartRule: boolean;
  liveClassifyStartDecision: boolean;
  liveClassifyStartLlm: boolean;
  liveClassifyStartDelayRule: boolean;
  liveClassifyStartDelayDecision: boolean;
  liveClassifyStartDelayLlm: boolean;
  liveClassifyPeriodicRule: boolean;
  liveClassifyPeriodicDecision: boolean;
  liveClassifyPeriodicLlm: boolean;
  liveClassifyTitleChangeRule: boolean;
  liveClassifyTitleChangeDecision: boolean;
  liveClassifyTitleChangeLlm: boolean;
  liveClassifyTitleDelayRule: boolean;
  liveClassifyTitleDelayDecision: boolean;
  liveClassifyTitleDelayLlm: boolean;
}

interface NumSpec {
  key: string;
  field: keyof RuntimeConfig;
  label: string;
  def: number;
  min: number;
  max: number;
}

/** 数值参数：key = settings 键（API 校验复用本表的范围） */
export const NUM_SPECS: NumSpec[] = [
  { key: 'poll_interval_sec', field: 'pollIntervalSec', label: '直播轮询间隔', def: 45, min: 20, max: 3600 },
  { key: 'poll_jitter_sec', field: 'pollJitterSec', label: '轮询抖动', def: 8, min: 0, max: 120 },
  // 时间口径（2026-11 重构：轮数口径会随轮询间隔倒挂两级告警顺序）；旧轮数键
  // health_alert_after_failures 由 Db 构造时一次性删除（settings 只留这一个键）。
  // 语义：链路故障持续满它 → 本地 toast（QQ 级固定 600s，core/types.STREAK_QQ_ALERT_AFTER_SEC）；
  // 账号级故障持续满它 → 落库面板展示
  { key: 'health_alert_toast_after_sec', field: 'healthAlertToastAfterSec', label: '故障持续告警阈值（秒）', def: 180, min: 30, max: 3600 },
  { key: 'follows_sync_interval_sec', field: 'followsSyncIntervalSec', label: '关注列表同步间隔', def: 1800, min: 300, max: 86400 },
  { key: 'dynamic_interval_sec', field: 'dynamicIntervalSec', label: '动态轮询间隔', def: 300, min: 120, max: 86400 },
  { key: 'weibo_interval_sec', field: 'weiboIntervalSec', label: '微博轮询间隔', def: 300, min: 120, max: 86400 },
  { key: 'llm_request_timeout_ms', field: 'llmRequestTimeoutMs', label: 'LLM 请求超时', def: 60_000, min: 1000, max: 600_000 },
  { key: 'llm_circuit_threshold', field: 'llmCircuitThreshold', label: 'LLM 熔断阈值', def: 3, min: 1, max: 20 },
  { key: 'llm_circuit_cooldown_ms', field: 'llmCircuitCooldownMs', label: 'LLM 熔断冷却', def: 600_000, min: 10_000, max: 3_600_000 },
  // 决策模型判定档：阈值存整数百分数（settings 只认整数），消费时 /100 成 0–1 概率
  { key: 'decision_gray_low_pct', field: 'decisionGrayLowPct', label: '决策灰区下界（%）', def: 20, min: 0, max: 100 },
  { key: 'decision_gray_high_pct', field: 'decisionGrayHighPct', label: '决策灰区上界（%）', def: 80, min: 0, max: 100 },
  { key: 'decision_primary_min_pct', field: 'decisionPrimaryMinPct', label: '主分类定案门槛（%）', def: 60, min: 0, max: 100 },
  { key: 'decision_request_timeout_ms', field: 'decisionRequestTimeoutMs', label: '决策模型请求超时', def: 30_000, min: 1000, max: 600_000 },
  { key: 'decision_circuit_threshold', field: 'decisionCircuitThreshold', label: '决策模型熔断阈值', def: 3, min: 1, max: 20 },
  { key: 'decision_circuit_cooldown_ms', field: 'decisionCircuitCooldownMs', label: '决策模型熔断冷却', def: 600_000, min: 10_000, max: 3_600_000 },
  { key: 'keyframe_interval_sec', field: 'keyframeIntervalSec', label: '关键帧缓存间隔', def: 300, min: 60, max: 3600 },
  { key: 'backlog_max_age_hours', field: 'backlogMaxAgeHours', label: '补推时间限制（小时）', def: 6, min: 1, max: 168 },
  { key: 'backlog_max_per_account', field: 'backlogMaxPerAccount', label: '补推账号条数限制（1~50）', def: 3, min: 1, max: 50 },
  // 直播分类时机的时间口径（分钟）：冷却按 roomId 独立、跨时机跨场次生效；
  // 延迟同时服务「开播延迟后」与「变更延迟后」，定时服务直播中周期重判。
  { key: 'live_classify_llm_cooldown_min', field: 'liveClassifyLlmCooldownMin', label: 'LLM 冷却时间（分钟）', def: 5, min: 0, max: 1440 },
  { key: 'live_classify_delay_min', field: 'liveClassifyDelayMin', label: '延迟时间（分钟）', def: 5, min: 1, max: 120 },
  { key: 'live_classify_periodic_min', field: 'liveClassifyPeriodicMin', label: '定时时间（分钟）', def: 20, min: 1, max: 1440 },
];

interface BoolSpec {
  key: string;
  field: keyof RuntimeConfig;
  label: string;
  def: boolean;
}

export const BOOL_SPECS: BoolSpec[] = [
  { key: 'notify_on_first_run', field: 'notifyOnFirstRun', label: '启动时已在播也推送', def: false },
  { key: 'notify_on_new_subscription', field: 'notifyOnNewSubscription', label: '新增订阅在播即推送', def: true },
  { key: 'keyframe_enabled', field: 'keyframeEnabled', label: '关键帧缓存', def: true },
  { key: 'backlog_push_enabled', field: 'backlogPushEnabled', label: '补推未运行期间的图文', def: false },
  // 直播分类时机 × 判定档（默认：开播与变更只走规则+决策，延迟时机三档全开，定时全关=定时不定判）
  { key: 'live_classify_start_rule', field: 'liveClassifyStartRule', label: '开播时使用规则', def: true },
  { key: 'live_classify_start_decision', field: 'liveClassifyStartDecision', label: '开播时使用决策模型', def: true },
  { key: 'live_classify_start_llm', field: 'liveClassifyStartLlm', label: '开播时使用 LLM', def: false },
  { key: 'live_classify_start_delay_rule', field: 'liveClassifyStartDelayRule', label: '开播延迟后使用规则', def: true },
  { key: 'live_classify_start_delay_decision', field: 'liveClassifyStartDelayDecision', label: '开播延迟后使用决策模型', def: true },
  { key: 'live_classify_start_delay_llm', field: 'liveClassifyStartDelayLlm', label: '开播延迟后使用 LLM', def: true },
  { key: 'live_classify_periodic_rule', field: 'liveClassifyPeriodicRule', label: '直播中定时使用规则', def: false },
  { key: 'live_classify_periodic_decision', field: 'liveClassifyPeriodicDecision', label: '直播中定时使用决策模型', def: false },
  { key: 'live_classify_periodic_llm', field: 'liveClassifyPeriodicLlm', label: '直播中定时使用 LLM', def: false },
  { key: 'live_classify_title_change_rule', field: 'liveClassifyTitleChangeRule', label: '标题/分区变更时使用规则', def: true },
  { key: 'live_classify_title_change_decision', field: 'liveClassifyTitleChangeDecision', label: '标题/分区变更时使用决策模型', def: true },
  { key: 'live_classify_title_change_llm', field: 'liveClassifyTitleChangeLlm', label: '标题/分区变更时使用 LLM', def: false },
  { key: 'live_classify_title_delay_rule', field: 'liveClassifyTitleDelayRule', label: '变更延迟后使用规则', def: true },
  { key: 'live_classify_title_delay_decision', field: 'liveClassifyTitleDelayDecision', label: '变更延迟后使用决策模型', def: true },
  { key: 'live_classify_title_delay_llm', field: 'liveClassifyTitleDelayLlm', label: '变更延迟后使用 LLM', def: true },
];

export function getRuntimeConfig(db: Db): RuntimeConfig {
  const rc = {} as Record<keyof RuntimeConfig, number | boolean>;
  for (const s of NUM_SPECS) {
    const v = db.getSetting(s.key);
    const n = v === null ? NaN : Number(v);
    rc[s.field] = Number.isInteger(n) && n >= s.min && n <= s.max ? n : s.def;
  }
  for (const s of BOOL_SPECS) {
    const v = db.getSetting(s.key);
    rc[s.field] = v === '1' ? true : v === '0' ? false : s.def;
  }
  return rc as RuntimeConfig;
}

/** 保存（调用方先做校验，见面板 /api/advanced）。逐字段落 settings。 */
export function saveRuntimeConfig(db: Db, patch: Partial<RuntimeConfig>): void {
  for (const s of NUM_SPECS) {
    const v = patch[s.field];
    if (typeof v === 'number') db.setSetting(s.key, String(v));
  }
  for (const s of BOOL_SPECS) {
    const v = patch[s.field];
    if (typeof v === 'boolean') db.setSetting(s.key, v ? '1' : '0');
  }
}

/**
 * 该 settings 键是否属于运行时参数（NUM_SPECS / BOOL_SPECS 的键）。
 * 用途：撤销后的热生效映射——撤 runtime config 键要 reconcileRuntime（见 undo.ts undoEffects），
 * 键名单只有本文件一处信源，别处不要再抄一遍。
 */
export function isRuntimeConfigKey(key: string): boolean {
  return NUM_SPECS.some((s) => s.key === key) || BOOL_SPECS.some((s) => s.key === key);
}

/** 单键直读 helper：pipeline 处理信号时用（冷启动推送开关，热生效免重启） */
export function isNotifyOnFirstRun(db: Db): boolean {
  const v = db.getSetting('notify_on_first_run');
  return v === '1' ? true : v === '0' ? false : false;
}

export function isNotifyOnNewSubscription(db: Db): boolean {
  const v = db.getSetting('notify_on_new_subscription');
  return v === '1' ? true : v === '0' ? false : true;
}

/** 图文帖缺口轮的补推参数（三个图文源每轮直读，热生效免重启） */
export interface PostBacklogConfig {
  enabled: boolean;
  /** 只补最近这么多秒内发布的帖子 */
  maxAgeSec: number;
  /** 每账号最多补多少条（取时间窗内最新的） */
  maxPerAccount: number;
}

export function getPostBacklogConfig(db: Db): PostBacklogConfig {
  const rc = getRuntimeConfig(db);
  return {
    enabled: rc.backlogPushEnabled,
    maxAgeSec: rc.backlogMaxAgeHours * 3600,
    maxPerAccount: rc.backlogMaxPerAccount,
  };
}

// ---- 直播分类时机（五个时机 × 三档判定；pipeline / triggers 按信号直读）----

/** 直播场次进分类判定的时机：开播 / 开播延迟后 / 直播中定时 / 标题分区变更 / 变更延迟后 */
export type LiveClassifyTrigger = 'start' | 'startDelay' | 'periodic' | 'titleChange' | 'titleDelay';

/** 某个时机选哪些判定档参与（结构同 analysis 的 JudgeSelection，core 不反向依赖 analysis 类型） */
export interface LiveJudgeSelection {
  rule: boolean;
  decision: boolean;
  llm: boolean;
}

const LIVE_TRIGGER_KEY_PREFIX: Record<LiveClassifyTrigger, string> = {
  start: 'live_classify_start',
  startDelay: 'live_classify_start_delay',
  periodic: 'live_classify_periodic',
  titleChange: 'live_classify_title_change',
  titleDelay: 'live_classify_title_delay',
};

const boolSpecByKey = new Map(BOOL_SPECS.map((s) => [s.key, s]));
const numSpecByKey = new Map(NUM_SPECS.map((s) => [s.key, s]));

/** 单键读布尔（越界/脏值回落该规格的代码默认值）；只读需要的那几个键，不走整表合并 */
function readBoolKey(db: Db, key: string): boolean {
  const v = db.getSetting(key);
  return v === '1' ? true : v === '0' ? false : (boolSpecByKey.get(key)?.def ?? false);
}

/** 单键读整数（非法/越界回落该规格的代码默认值） */
function readNumKey(db: Db, key: string): number {
  const spec = numSpecByKey.get(key);
  const v = db.getSetting(key);
  const n = v === null ? NaN : Number(v);
  if (spec === undefined) return Number.isInteger(n) ? n : 0;
  return Number.isInteger(n) && n >= spec.min && n <= spec.max ? n : spec.def;
}

/**
 * 某时机参与哪些判定档。
 * 三档全 false = 该时机不判定（面板上等于关闭）：不跑判决链、不写判定与历史，
 * 已有判定保持不变——关闭一个时机不该把已归档的分类抹掉。
 */
export function getLiveJudgeSelection(db: Db, trigger: LiveClassifyTrigger): LiveJudgeSelection {
  const base = LIVE_TRIGGER_KEY_PREFIX[trigger];
  return {
    rule: readBoolKey(db, `${base}_rule`),
    decision: readBoolKey(db, `${base}_decision`),
    llm: readBoolKey(db, `${base}_llm`),
  };
}

/** 该时机的选择是否有任何一档参与（全关 = 时机关闭） */
export function isLiveJudgeSelectionActive(sel: LiveJudgeSelection): boolean {
  return sel.rule || sel.decision || sel.llm;
}

export interface LiveClassifyTiming {
  /** 开播后 / 标题分区变更后的延迟秒数（两个延迟时机共用） */
  delaySec: number;
  /** 直播中定时重判的周期秒数 */
  periodicSec: number;
  /** 同一 roomId 两次 LLM 判定的最短间隔（分钟；0 = 不设冷却） */
  llmCooldownMin: number;
}

export function getLiveClassifyTiming(db: Db): LiveClassifyTiming {
  return {
    delaySec: readNumKey(db, 'live_classify_delay_min') * 60,
    periodicSec: readNumKey(db, 'live_classify_periodic_min') * 60,
    llmCooldownMin: readNumKey(db, 'live_classify_llm_cooldown_min'),
  };
}

/**
 * 把生效运行时参数覆盖回 AppConfig：sources 的 ctx.config、createLlmRouter、
 * notifier 装配闸门都消费这个合并结果（config.json 原值只作种子，不再直读）。
 */
export function withRuntimeConfig(app: AppConfig, rc: RuntimeConfig): AppConfig {
  return {
    ...app,
    pollIntervalSec: rc.pollIntervalSec,
    pollJitterSec: rc.pollJitterSec,
    healthAlertToastAfterSec: rc.healthAlertToastAfterSec,
    notifyOnFirstRun: rc.notifyOnFirstRun,
    notifyOnNewSubscription: rc.notifyOnNewSubscription,
    follows: { syncIntervalSec: rc.followsSyncIntervalSec },
    dynamic: { intervalSec: rc.dynamicIntervalSec },
    weibo: { intervalSec: rc.weiboIntervalSec },
    keyframe: { enabled: rc.keyframeEnabled, intervalSec: rc.keyframeIntervalSec },
    llm: {
      ...app.llm,
      requestTimeoutMs: rc.llmRequestTimeoutMs,
      circuitThreshold: rc.llmCircuitThreshold,
      circuitCooldownMs: rc.llmCircuitCooldownMs,
    },
    decision: {
      ...app.decision,
      requestTimeoutMs: rc.decisionRequestTimeoutMs,
      circuitThreshold: rc.decisionCircuitThreshold,
      circuitCooldownMs: rc.decisionCircuitCooldownMs,
    },
  };
}
