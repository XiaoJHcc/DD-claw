/**
 * 运行时参数（settings 表唯一信源，面板按模块收纳：监听「抓取设置」/ LLM「高级」/
 * 推送渠道「推送设置」，保存即热生效）。
 * 无 settings 记录时用规格表里的代码默认值——不存在任何文件侧来源。
 *
 * 消费路径：
 * - 各 source 的轮询间隔/告警阈值：index.ts 用 withRuntimeConfig 合并出生效 AppConfig
 *   传给 SourceContext；参数变化时 reconcile 重启对应 source 刷新。
 * - 冷启动推送开关：pipeline 每次处理信号经 isNotifyOnFirstRun 等 helper 直读 settings。
 * - LLM 超时/熔断：createLlmRouter 重建时取 withRuntimeConfig 合并结果。
 */
import type { Db } from './db.js';
import type { AppConfig } from '../config/schema.js';

export interface RuntimeConfig {
  pollIntervalSec: number;
  pollJitterSec: number;
  healthAlertAfterFailures: number;
  followsSyncIntervalSec: number;
  dynamicIntervalSec: number;
  weiboIntervalSec: number;
  llmRequestTimeoutMs: number;
  llmCircuitThreshold: number;
  llmCircuitCooldownMs: number;
  notifyOnFirstRun: boolean;
  notifyOnNewSubscription: boolean;
  keyframeIntervalSec: number;
  keyframeEnabled: boolean;
  backlogPushEnabled: boolean;
  backlogMaxAgeHours: number;
  backlogMaxPerAccount: number;
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
  { key: 'health_alert_after_failures', field: 'healthAlertAfterFailures', label: '连续失败告警阈值', def: 5, min: 1, max: 100 },
  { key: 'follows_sync_interval_sec', field: 'followsSyncIntervalSec', label: '关注列表同步间隔', def: 1800, min: 300, max: 86400 },
  { key: 'dynamic_interval_sec', field: 'dynamicIntervalSec', label: '动态轮询间隔', def: 300, min: 120, max: 86400 },
  { key: 'weibo_interval_sec', field: 'weiboIntervalSec', label: '微博轮询间隔', def: 300, min: 120, max: 86400 },
  { key: 'llm_request_timeout_ms', field: 'llmRequestTimeoutMs', label: 'LLM 请求超时', def: 60_000, min: 1000, max: 600_000 },
  { key: 'llm_circuit_threshold', field: 'llmCircuitThreshold', label: 'LLM 熔断阈值', def: 3, min: 1, max: 20 },
  { key: 'llm_circuit_cooldown_ms', field: 'llmCircuitCooldownMs', label: 'LLM 熔断冷却', def: 600_000, min: 10_000, max: 3_600_000 },
  { key: 'keyframe_interval_sec', field: 'keyframeIntervalSec', label: '关键帧缓存间隔', def: 300, min: 60, max: 3600 },
  { key: 'backlog_max_age_hours', field: 'backlogMaxAgeHours', label: '补推时间限制（小时）', def: 6, min: 1, max: 168 },
  { key: 'backlog_max_per_account', field: 'backlogMaxPerAccount', label: '补推账号条数限制（1~50）', def: 3, min: 1, max: 50 },
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

/**
 * 把生效运行时参数覆盖回 AppConfig：sources 的 ctx.config、createLlmRouter、
 * notifier 装配闸门都消费这个合并结果（config.json 原值只作种子，不再直读）。
 */
export function withRuntimeConfig(app: AppConfig, rc: RuntimeConfig): AppConfig {
  return {
    ...app,
    pollIntervalSec: rc.pollIntervalSec,
    pollJitterSec: rc.pollJitterSec,
    healthAlertAfterFailures: rc.healthAlertAfterFailures,
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
  };
}
