import { z } from 'zod';

/**
 * 只对 enabled 的目标校验 id 格式。
 * 禁用的目标允许留占位符，方便先把群配置写好再启用。
 */
export const targetSchema = z.object({
  type: z.enum(['private', 'group']),
  id: z.string(),
  enabled: z.boolean().default(true),
}).superRefine((t, ctx) => {
  if (!t.enabled) return;
  if (!/^\d{5,}$/.test(t.id)) {
    ctx.addIssue({
      code: 'custom',
      path: ['id'],
      message: `已启用的目标 id 必须是纯数字QQ号/群号，当前为 "${t.id}"（占位符请替换掉）`,
    });
  }
});

export const subscriptionSchema = z.object({
  uid: z.string().regex(/^\d+$/, 'uid 必须是纯数字'),
  alias: z.string().min(1),
  enabled: z.boolean().default(true),
  /** 历史遗留字段（off/silent/on），种子导入时兼容映射为 watch/notify 开关 */
  mode: z.enum(['off', 'silent', 'on']).optional(),
});

export const configSchema = z.object({
  pollIntervalSec: z.number().int().min(20, '轮询间隔不要低于 20 秒').max(3600).default(45),
  pollJitterSec: z.number().int().min(0).max(120).default(8),
  /** 首次运行时，已在直播的主播是否推送。默认关，避免启动即刷屏。 */
  notifyOnFirstRun: z.boolean().default(false),
  /**
   * 后续新增订阅时，该主播若正在直播是否推送。默认开 ——
   * 关掉意味着「新加的主播当时那场直播永远收不到通知」，
   * 这个失败模式比启动多一条通知更糟。
   */
  notifyOnNewSubscription: z.boolean().default(true),
  healthAlertAfterFailures: z.number().int().min(1).max(100).default(5),

  /** 关注列表同步（需 cookies.json）。间隔下限 300s，低频即可，降低风控压力 */
  follows: z.object({
    enabled: z.boolean().default(true),
    syncIntervalSec: z.number().int().min(300, '关注列表同步间隔不低于 300 秒').max(86400).default(1800),
  }).default({ enabled: true, syncIntervalSec: 1800 }),

  /** 空间动态轮询（需 cookies.json；无 cookie 时自动跳过）。下限 120s，预告一天就几条，低频即可 */
  dynamic: z.object({
    enabled: z.boolean().default(true),
    intervalSec: z.number().int().min(120, '动态轮询间隔不低于 120 秒').max(86400).default(300),
  }).default({ enabled: true, intervalSec: 300 }),

  /** 微博时间线轮询（需 weibo-cookies.json；无 cookie 时自动跳过）。下限 120s，单账号低频即可 */
  weibo: z.object({
    enabled: z.boolean().default(true),
    intervalSec: z.number().int().min(120, '微博轮询间隔不低于 120 秒').max(86400).default(300),
  }).default({ enabled: true, intervalSec: 300 }),

  /** 控制面板（localhost WebUI，只绑 127.0.0.1）：监听名单 / 候选池 / 推送规则与渠道管理 */
  panel: z.object({
    enabled: z.boolean().default(true),
    port: z.number().int().min(1).max(65535).default(8787),
  }).default({ enabled: true, port: 8787 }),

  /**
   * 历史种子来源：仅首次启动（streamers 表为空）时导入数据库，
   * 之后监听名单以 streamers 表为准，由面板管理。可整段省略。
   */
  subscriptions: z.array(subscriptionSchema).default([]),

  notify: z.object({
    onebot: z.object({
      enabled: z.boolean().default(true),
      targets: z.array(targetSchema).default([]),
    }).default({ enabled: true, targets: [] }),
    toast: z.object({
      enabled: z.boolean().default(true),
    }).default({ enabled: true }),
  }),
}).superRefine((cfg, ctx) => {
  if (cfg.notify.onebot.enabled && !cfg.notify.onebot.targets.some((t) => t.enabled)) {
    ctx.addIssue({
      code: 'custom',
      path: ['notify', 'onebot', 'targets'],
      message: 'onebot 已启用但没有任何 enabled 的推送目标',
    });
  }
  const dupUid = cfg.subscriptions.map((s) => s.uid)
    .find((u, i, a) => a.indexOf(u) !== i);
  if (dupUid) {
    ctx.addIssue({ code: 'custom', path: ['subscriptions'], message: `uid 重复: ${dupUid}` });
  }
});

export type AppConfig = z.infer<typeof configSchema>;
export type NotifyTarget = z.infer<typeof targetSchema>;
export type Subscription = z.infer<typeof subscriptionSchema>;
