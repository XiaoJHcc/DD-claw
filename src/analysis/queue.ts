import type { Analyzer, AnalysisContext, SceneVerdict } from './types.js';

/**
 * 分析队列：所有 LLM 调用（当前接 NoopAnalyzer 占位）都从这里过，
 * 手写信号量限流。轮询循环/推送链路绝不直接调 Analyzer —— 高峰 30+
 * 同时在播时，通知照常即时发出，分析排队跟进。
 *
 * M2 预留扩展点（现在刻意不做）：
 * - 同房间触发合并：时间窗内同一房间的多个触发合成一次分析
 * - 结果缓存：信号无显著变化时复用上次 verdict
 * - 优先级排队：开播触发 > 直播中抽查
 */
export class AnalysisQueue {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly analyzer: Analyzer,
    private readonly concurrency = 2,
  ) {}

  submit(ctx: AnalysisContext): Promise<SceneVerdict | null> {
    return this.acquire().then(async () => {
      try {
        return await this.analyzer.analyze(ctx);
      } finally {
        this.release();
      }
    });
  }

  private acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release(): void {
    this.active--;
    this.waiting.shift()?.();
  }
}
