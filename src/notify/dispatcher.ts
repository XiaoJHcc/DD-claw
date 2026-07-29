import { makeLogger } from '../logger.js';
import type { LiveEvent } from '../core/types.js';
import type { Db } from '../core/db.js';
import type { Notifier } from './types.js';

const log = makeLogger('notify/dispatcher');

export interface BroadcastOutcome {
  anySuccess: boolean;
  total: number;
  succeeded: number;
}

export class NotifyDispatcher {
  constructor(
    private readonly notifiers: Notifier[],
    private readonly db: Db,
    private readonly dryRun = false,
  ) {}

  get channels(): string[] {
    return this.notifiers.map((n) => n.name);
  }

  async broadcast(event: LiveEvent): Promise<BroadcastOutcome> {
    if (this.dryRun) {
      log.info(`[dry-run] 本应推送: ${event.alias || event.uname} / ${event.title} / ${event.roomUrl}`);
      return { anySuccess: true, total: 0, succeeded: 0 };
    }

    // 并行 fan-out：一个通道失败不能拖累其他通道
    const settled = await Promise.allSettled(this.notifiers.map((n) => n.send(event)));

    let total = 0;
    let succeeded = 0;

    settled.forEach((outcome, i) => {
      const channel = this.notifiers[i]!.name;
      if (outcome.status === 'rejected') {
        total++;
        log.error(`${channel} 抛出异常`, outcome.reason);
        this.db.logNotify({
          roomId: event.roomId, liveTime: event.liveTime, channel,
          ok: false, error: String(outcome.reason),
        });
        return;
      }
      for (const r of outcome.value) {
        total++;
        if (r.ok) succeeded++;
        else log.warn(`${channel}${r.target ? ` (${r.target})` : ''} 失败: ${r.error}`);
        this.db.logNotify({
          roomId: event.roomId, liveTime: event.liveTime, channel,
          target: r.target, ok: r.ok, error: r.error,
        });
      }
    });

    log.info(`推送完成 ${succeeded}/${total} 成功`);
    return { anySuccess: succeeded > 0, total, succeeded };
  }

  /** 监听自身出问题时的告警。逐通道尽力发，不抛异常。 */
  async alertAll(title: string, body: string): Promise<void> {
    await Promise.allSettled(
      this.notifiers.filter((n) => n.alert).map((n) => n.alert!(title, body)),
    );
  }
}
