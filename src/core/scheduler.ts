import { makeLogger } from '../logger.js';

const log = makeLogger('core/scheduler');

export interface PeriodicTaskOpts {
  name: string;
  intervalSec: number;
  jitterSec?: number;
  run: () => Promise<void>;
}

/**
 * 通用周期任务器：立即跑第一轮，之后每次 await 完再 sleep
 * （自调度，不用 setInterval，天然不重叠）。
 * 编排逻辑都在 run 回调里，这里只管节奏。run 抛异常记日志后继续下一轮。
 */
export class PeriodicTask {
  private running = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly opts: PeriodicTaskOpts) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.opts.run();
      } catch (e) {
        log.error(`[${this.opts.name}] 周期任务异常`, e);
      }
      if (!this.running) break;
      await this.sleep();
    }
  }

  private sleep(): Promise<void> {
    const ms = this.opts.intervalSec * 1000 + Math.random() * (this.opts.jitterSec ?? 0) * 1000;
    return new Promise((r) => {
      this.timer = setTimeout(r, ms);
    });
  }
}
