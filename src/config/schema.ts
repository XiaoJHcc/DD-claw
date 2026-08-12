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
  /**
   * 端点协议：chat-completions = /chat/completions（绝大多数 OpenAI 兼容端点）；
   * responses = /responses（OpenAI Responses API，如 OpenCode Go 的 gpt-5.6-luna）。
   * Anthropic /messages 协议不做（他家模型贵，MiniMax/Qwen 走各自官方 API）
   */
  api: z.enum(['chat-completions', 'responses']).default('chat-completions'),
});

export const configSchema = z.object({
  // —— 以下字段全部是遗留迁移来源（老版本 config 升级时一次性入库，
  //    库空/未配置才导；之后以 settings/库表为准，改 config 不再生效）。
  //    config.json 里唯一的活配置是末尾的 panel 段（面板自举） ——
  pollIntervalSec: z.number().int().min(20, '轮询间隔不要低于 20 秒').max(3600).default(45),
  pollJitterSec: z.number().int().min(0).max(120).default(8),
  /** 种子：启动时已在播是否推送（默认关，避免启动即刷屏） */
  notifyOnFirstRun: z.boolean().default(false),
  /** 种子：新增订阅时在播是否推送（默认开） */
  notifyOnNewSubscription: z.boolean().default(true),
  healthAlertAfterFailures: z.number().int().min(1).max(100).default(5),

  /** 种子：关注列表同步间隔（下限 300s，低频即可，降低风控压力）。有 cookie 即运行 */
  follows: z.object({
    syncIntervalSec: z.number().int().min(300, '关注列表同步间隔不低于 300 秒').max(86400).default(1800),
  }).default({ syncIntervalSec: 1800 }),

  /** 种子：空间动态轮询间隔（下限 120s）。启停由面板监听开关管，这里只有间隔 */
  dynamic: z.object({
    intervalSec: z.number().int().min(120, '动态轮询间隔不低于 120 秒').max(86400).default(300),
  }).default({ intervalSec: 300 }),

  /** 种子：微博时间线轮询间隔（下限 120s）。启停由面板监听开关管 */
  weibo: z.object({
    intervalSec: z.number().int().min(120, '微博轮询间隔不低于 120 秒').max(86400).default(300),
  }).default({ intervalSec: 300 }),

  /** 控制面板（localhost WebUI，只绑 127.0.0.1）：监听名单 / 候选池 / 推送规则与渠道管理 */
  panel: z.object({
    enabled: z.boolean().default(true),
    port: z.number().int().min(1).max(65535).default(8787),
  }).default({ enabled: true, port: 8787 }),

  /**
   * LLM 接入：provider 名单与总开关的事实来源都在 settings 表（面板管理），
   * providers 仅空库时种子导入。超时/熔断三参数同样是 settings 信源（高级设置卡），
   * 这里仅作首次种子。路由不用配：由 provider 列表自动推导。
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
      /** 种子：QQ 通道开关（settings notifier_onebot_enabled）。默认关，裸配置不装配 QQ */
      enabled: z.boolean().default(false),
      /** 种子：推送目标（push_channels 表为空时导入一次，之后面板管理） */
      targets: z.array(targetSchema).default([]),
    }).default({ enabled: false, targets: [] }),
    toast: z.object({
      /** 种子：系统通知通道开关（settings notifier_toast_enabled） */
      enabled: z.boolean().default(true),
    }).default({ enabled: true }),
  }).default({ onebot: { enabled: false, targets: [] }, toast: { enabled: true } }),

  /**
   * NapCat 托管（Windows）：仅首次启动种子（settings 表是唯一信源，之后改这里不生效）。
   * 配置后 onebot 端点只读跟随 NapCat 自己的 onebot11_<uin>.json
   *（端口/token 事实来源，.env NAPCAT_BASE_URL 降为兜底），
   * 看门狗周期探测，NapCat 不在线时经「最高权限」计划任务自动拉起 + 快速登录 uin。
   */
  napcat: z.object({
    enabled: z.boolean().default(false),
    /** NapCat 一键包目录（含 launcher.bat 与 config/） */
    dir: z.string().default(''),
    /** 快速登录的机器人 QQ 号（对应 config/onebot11_<uin>.json） */
    uin: z.string().default(''),
  }).default({ enabled: false, dir: '', uin: '' }),
});

export type AppConfig = z.infer<typeof configSchema>;
export type NotifyTarget = z.infer<typeof targetSchema>;
export type Subscription = z.infer<typeof subscriptionSchema>;
export type LlmProviderConfig = z.infer<typeof llmProviderSchema>;
