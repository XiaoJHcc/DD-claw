/**
 * gateway 写操作限流：每**渠道**滑动窗口 20 次 / 10 分钟（同一渠道的多条令牌共桶）。
 * 进程内内存实现即可——防的是群友 prompt injection 诱导 LLM 刷写接口，不是精确配额。
 */
import type { McpAuth } from './auth.js';

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit = 20,
    private readonly windowMs = 10 * 60 * 1000,
  ) {}

  /** true = 放行；false = 超限 */
  allow(key: string, nowMs = Date.now()): boolean {
    const cutoff = nowMs - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return false;
    }
    list.push(nowMs);
    this.hits.set(key, list);
    return true;
  }

  /** 测试用：清空计数 */
  reset(): void {
    this.hits.clear();
  }
}

/**
 * 写限流的分桶键 = **调用域渠道**（plan「渠道隔离」第 6 条：按渠道分桶，一个吵的群不拖累别的渠道；
 * 同一渠道的多条令牌共桶——改令牌不改桶）。无 scope 的调用域（admin / 面板，本就不经过 gateway
 * 自助工具）回落按令牌名，与改造前的口径一致。
 */
export function writeLimitBucket(ctx: McpAuth): string {
  const ch = ctx.scope.channelId;
  return typeof ch === 'number' ? `ch:${ch}` : `token:${ctx.name}`;
}

/** 全局单例（跨请求生效）；测试通过 resetMcpWriteLimiter 隔离 */
export const mcpWriteLimiter = new RateLimiter();

export function resetMcpWriteLimiter(): void {
  mcpWriteLimiter.reset();
}
