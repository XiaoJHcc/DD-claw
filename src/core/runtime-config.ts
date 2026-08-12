/**
 * 运行时参数（settings 表唯一信源，面板「高级设置」卡管理，保存即热生效）。
 * config.json 的同名字段仅首次启动种子（seedRuntimeConfigIfUnset），之后改 config 不再生效。
 *
 * 消费路径：
 * - 各 source 的轮询间隔/告警阈值：index.ts 用 withRuntimeConfig 合并出生效 AppConfig
 *   传给 SourceContext；参数变化时 reconcile 重启对应 source 刷新。
 * - 冷启动推送开关：pipeline 每次处理信号经 isNotifyOnFirstRun 等 helper 直读 settings。
 * - LLM 超时/熔断：createLlmRouter 重建时取 withRuntimeConfig 合并结果。
 * - 通道级开关：index.ts 装配 notifiers 的闸门，热切换重建 notifier。
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
  notifierOnebotEnabled: boolean;
  notifierToastEnabled: boolean;
}

interface NumSpec {
  key: string;
  field: keyof RuntimeConfig;
  label: string;
  def: number;
  min: number;
  max: number;
  seed: (app: AppConfig) => number;
}

/** 数值参数：key = settings 键，范围与 config schema 口径一致（API 校验复用本表） */
export const NUM_SPECS: NumSpec[] = [
  { key: 'poll_interval_sec', field: 'pollIntervalSec', label: '直播轮询间隔', def: 45, min: 20, max: 3600, seed: (a) => a.pollIntervalSec },
  { key: 'poll_jitter_sec', field: 'pollJitterSec', label: '轮询抖动', def: 8, min: 0, max: 120, seed: (a) => a.pollJitterSec },
  { key: 'health_alert_after_failures', field: 'healthAlertAfterFailures', label: '连续失败告警阈值', def: 5, min: 1, max: 100, seed: (a) => a.healthAlertAfterFailures },
  { key: 'follows_sync_interval_sec', field: 'followsSyncIntervalSec', label: '关注列表同步间隔', def: 1800, min: 300, max: 86400, seed: (a) => a.follows.syncIntervalSec },
  { key: 'dynamic_interval_sec', field: 'dynamicIntervalSec', label: '动态轮询间隔', def: 300, min: 120, max: 86400, seed: (a) => a.dynamic.intervalSec },
  { key: 'weibo_interval_sec', field: 'weiboIntervalSec', label: '微博轮询间隔', def: 300, min: 120, max: 86400, seed: (a) => a.weibo.intervalSec },
  { key: 'llm_request_timeout_ms', field: 'llmRequestTimeoutMs', label: 'LLM 请求超时', def: 60_000, min: 1000, max: 600_000, seed: (a) => a.llm.requestTimeoutMs },
  { key: 'llm_circuit_threshold', field: 'llmCircuitThreshold', label: 'LLM 熔断阈值', def: 3, min: 1, max: 20, seed: (a) => a.llm.circuitThreshold },
  { key: 'llm_circuit_cooldown_ms', field: 'llmCircuitCooldownMs', label: 'LLM 熔断冷却', def: 600_000, min: 10_000, max: 3_600_000, seed: (a) => a.llm.circuitCooldownMs },
];

interface BoolSpec {
  key: string;
  field: keyof RuntimeConfig;
  label: string;
  def: boolean;
  seed: (app: AppConfig) => boolean;
}

export const BOOL_SPECS: BoolSpec[] = [
  { key: 'notify_on_first_run', field: 'notifyOnFirstRun', label: '启动时已在播也推送', def: false, seed: (a) => a.notifyOnFirstRun },
  { key: 'notify_on_new_subscription', field: 'notifyOnNewSubscription', label: '新增订阅在播即推送', def: true, seed: (a) => a.notifyOnNewSubscription },
  { key: 'notifier_onebot_enabled', field: 'notifierOnebotEnabled', label: 'QQ 通道', def: true, seed: (a) => a.notify.onebot.enabled },
  { key: 'notifier_toast_enabled', field: 'notifierToastEnabled', label: '系统通知通道', def: true, seed: (a) => a.notify.toast.enabled },
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

/** 首次启动种子：settings 键不存在时才从 config.json 导入（之后 settings 是唯一信源） */
export function seedRuntimeConfigIfUnset(db: Db, app: AppConfig): void {
  for (const s of NUM_SPECS) {
    if (db.getSetting(s.key) === null) db.setSetting(s.key, String(s.seed(app)));
  }
  for (const s of BOOL_SPECS) {
    if (db.getSetting(s.key) === null) db.setSetting(s.key, s.seed(app) ? '1' : '0');
  }
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
    llm: {
      ...app.llm,
      requestTimeoutMs: rc.llmRequestTimeoutMs,
      circuitThreshold: rc.llmCircuitThreshold,
      circuitCooldownMs: rc.llmCircuitCooldownMs,
    },
    notify: {
      onebot: { ...app.notify.onebot, enabled: rc.notifierOnebotEnabled },
      toast: { enabled: rc.notifierToastEnabled },
    },
  };
}
