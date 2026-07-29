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

  subscriptions: z.array(subscriptionSchema)
    .min(1, 'subscriptions 至少要有一项'),

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
