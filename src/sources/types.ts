import type { Bus } from '../core/bus.js';
import type { Db } from '../core/db.js';
import type { AppConfig } from '../config/schema.js';

export interface SourceContext {
  bus: Bus;
  db: Db;
  config: AppConfig;
}

/**
 * 数据源统一接口。source 只做两件事：原始数据/状态归档 + 把变更 Signal
 * emit 上 bus。不允许出现任何通知逻辑（冷启动抑制、去重、告警阈值都在
 * pipeline 及之后的层）。
 */
export interface Source {
  readonly name: string;
  start(ctx: SourceContext): void;
  stop(): void;
}
