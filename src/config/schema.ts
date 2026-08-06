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

/**
 * LLM provider：OpenAI 兼容端点。key 不放 config，放 .env，
 * keyEnvs 列环境变量名（多 key 池轮询）；空数组 = 无鉴权（本地 LM Studio 等）。
 * keyEnvs 非空但一个变量都没填 → 运行时按「缺 key」跳过该 provider，不算配置错误
 *（先接线后填 key 是合法状态）。
 */
export const llmProviderSchema = z.object({
  name: z.string().min(1),
  baseURL: z.url('baseURL 必须是合法 URL'),
  model: z.string().min(1),
  /** 是否可接含图任务（vision 路由候选） */
  vision: z.boolean().default(false),
  keyEnvs: z.array(z.string().min(1)).default([]),
  enabled: z.boolean().default(true),
  /**
   * 结构化输出能力：schema = response_format json_schema（约束最强）；
   * object = json_object（只保证是 JSON）；none = 不带 response_format
   *（本地小模型/不支持的端点用，解析时剥代码围栏兜底）
   */
  structuredOutput: z.enum(['schema', 'object', 'none']).default('schema'),
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
   * LLM 接入：provider 名单与总开关的事实来源都在 settings 表（面板管理），
   * 这里仅提供默认值/首次种子。路由不用配：由 provider 列表自动推导
   *（顺序 = 优先级，vision 路由只含多模态）。
   * 未启用或名单为空时分析链路整体降级（Noop 行为），不影响推送。
   */
  llm: z.object({
    /** 默认开关；面板 LLM 卡片的总开关（settings.llm_enabled）覆盖它 */
    enabled: z.boolean().default(false),
    requestTimeoutMs: z.number().int().min(1000).max(600_000).default(60_000),
    /** 连续失败多少次打开熔断 */
    circuitThreshold: z.number().int().min(1).max(20).default(3),
    /** 熔断冷却时长（撞已知耗尽的 key 没有意义） */
    circuitCooldownMs: z.number().int().min(10_000).max(3_600_000).default(600_000),
    providers: z.array(llmProviderSchema).default([]),
  }).default({
    enabled: false, requestTimeoutMs: 60_000, circuitThreshold: 3,
    circuitCooldownMs: 600_000, providers: [],
  }),

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
  const dupProvider = cfg.llm.providers.map((p) => p.name)
    .find((n, i, a) => a.indexOf(n) !== i);
  if (dupProvider) {
    ctx.addIssue({ code: 'custom', path: ['llm', 'providers'], message: `provider name 重复: ${dupProvider}` });
  }
});

export type AppConfig = z.infer<typeof configSchema>;
export type NotifyTarget = z.infer<typeof targetSchema>;
export type Subscription = z.infer<typeof subscriptionSchema>;
export type LlmProviderConfig = z.infer<typeof llmProviderSchema>;
