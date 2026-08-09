import type { AnalysisContext, Classification, Classifier } from './types.js';

/**
 * 分析队列：所有分类判定（内部含 LLM 调用）都从这里过，
 * 手写信号量限流。轮询循环/推送链路绝不直接调 Classifier —— 高峰 30+
 * 同时在播时，通知照常即时发出，分析排队跟进。
 *
 * 预留扩展点（现在刻意不做）：
 * - 同房间触发合并：时间窗内同一房间的多个触发合成一次分析
 * - 结果缓存：信号无显著变化时复用上次判定
 * - 优先级排队：开播触发 > 直播中抽查
 */
export class AnalysisQueue {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly classifier: Classifier,
    private readonly concurrency = 2,
  ) {}

  submit(ctx: AnalysisContext): Promise<Classification[]> {
    return this.acquire().then(async () => {
      try {
        return await this.classifier.classify(ctx);
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
