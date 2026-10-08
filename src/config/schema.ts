import { z } from 'zod';

/**
 * 配置体系（无对外发布、无历史包袱版）：
 * - config.json 唯一活配置是 panel 段（面板自举，面板改不了自己），文件可整个不存在；
 * - 其余一切运行参数的事实来源是 settings 表/库表（控制面板管理，
 *   见 core/runtime-config.ts、notify/napcat.ts、analysis/providers.ts）；
 * - AppConfig 是代码内常量默认值（defaultAppConfig），供 withRuntimeConfig 叠加
 *   settings 后给 sources/router/装配消费——不再有「从文件读运行参数」的路径。
 */

/** LLM provider：OpenAI 兼容端点。名单存 settings 表（面板 LLM 卡片管理），本 schema 供面板 CRUD 校验。 */
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

export type LlmProviderConfig = z.infer<typeof llmProviderSchema>;

/** config.json 只校验 panel 段；其余顶层字段无视（zod 非 strict，未知键剥离） */
export const configSchema = z.object({
  panel: z.object({
    enabled: z.boolean().default(true),
    port: z.number().int().min(1).max(65535).default(8787),
  }).default({ enabled: true, port: 8787 }),
});

/**
 * 运行配置全集。除 panel 来自 config.json 外全部是代码默认值；
 * 生效值 = withRuntimeConfig(app, getRuntimeConfig(db))（settings 覆盖）。
 */
export interface AppConfig {
  pollIntervalSec: number;
  pollJitterSec: number;
  notifyOnFirstRun: boolean;
  notifyOnNewSubscription: boolean;
  /** 健康告警的本地 toast 阈值（秒）：故障持续满它才报第一级；QQ 级固定 STREAK_QQ_ALERT_AFTER_SEC */
  healthAlertToastAfterSec: number;
  follows: { syncIntervalSec: number };
  dynamic: { intervalSec: number };
  weibo: { intervalSec: number };
  /** 在播关键帧定时本地缓存（media/keyframe.ts）；此处只是底形，生效值一律 = RuntimeConfig 叠加（settings 唯一信源，面板监听卡「抓取设置」，configure 热生效） */
  keyframe: { enabled: boolean; intervalSec: number };
  panel: { enabled: boolean; port: number };
  llm: {
    requestTimeoutMs: number;
    circuitThreshold: number;
    circuitCooldownMs: number;
  };
}

/** 代码内默认值（settings 无覆盖时的底） */
export function defaultAppConfig(): AppConfig {
  return {
    pollIntervalSec: 45,
    pollJitterSec: 8,
    notifyOnFirstRun: false,
    notifyOnNewSubscription: true,
    healthAlertToastAfterSec: 180,
    follows: { syncIntervalSec: 1800 },
    dynamic: { intervalSec: 300 },
    weibo: { intervalSec: 300 },
    keyframe: { enabled: true, intervalSec: 300 },
    panel: { enabled: true, port: 8787 },
    llm: {
      requestTimeoutMs: 60_000,
      circuitThreshold: 3,
      circuitCooldownMs: 600_000,
    },
  };
}
