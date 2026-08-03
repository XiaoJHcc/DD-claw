import { makeLogger } from '../logger.js';
import type { PushMessage } from '../core/types.js';
import type { Db } from '../core/db.js';
import type { PushChannel } from '../core/push.js';
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

  /**
   * msg.channels 存在 → 渠道路由：查 push_channels 表，过滤「被选中且启用」，
   * 按 notifier 分组；onebot 组把选中渠道解析成 msg.targets，无选中渠道的
   * notifier 跳过。msg.channels 缺省（--test-notify、告警）→ 旧行为全通道发。
   */
  private route(msg: PushMessage): Array<{ notifier: Notifier; msg: PushMessage }> {
    if (!msg.channels) return this.notifiers.map((notifier) => ({ notifier, msg }));
    const wanted = new Set(msg.channels.map(Number));
    const selected = this.db.listPushChannels().filter((c) => wanted.has(c.id) && c.enabled);
    const byNotifier = new Map<string, PushChannel[]>();
    for (const c of selected) {
      const list = byNotifier.get(c.notifier) ?? [];
      list.push(c);
      byNotifier.set(c.notifier, list);
    }
    const jobs: Array<{ notifier: Notifier; msg: PushMessage }> = [];
    for (const notifier of this.notifiers) {
      const chs = byNotifier.get(notifier.name) ?? [];
      if (chs.length === 0) continue; // 该通道没有选中的启用渠道
      if (notifier.name === 'onebot') {
        const targets = chs
          .filter((c) => c.targetType !== null && c.targetId !== null)
          .map((c) => ({ type: c.targetType!, id: c.targetId! }));
        jobs.push({ notifier, msg: { ...msg, targets } });
      } else {
        jobs.push({ notifier, msg });
      }
    }
    return jobs;
  }

  async broadcast(msg: PushMessage): Promise<BroadcastOutcome> {
    if (this.dryRun) {
      log.info(`[dry-run] 本应推送: ${msg.title} / ${msg.body.split('\n')[0]} / ${msg.url ?? ''}`);
      return { anySuccess: true, total: 0, succeeded: 0 };
    }

    // notify_log 溯源用的直播场次；非直播类消息（如告警）没有，写空
    const ref = msg.ref ?? { roomId: '', liveTime: 0 };

    const jobs = this.route(msg);

    // 并行 fan-out：一个通道失败不能拖累其他通道
    const settled = await Promise.allSettled(jobs.map((j) => j.notifier.send(j.msg)));

    let total = 0;
    let succeeded = 0;

    settled.forEach((outcome, i) => {
      const channel = jobs[i]!.notifier.name;
      if (outcome.status === 'rejected') {
        total++;
        log.error(`${channel} 抛出异常`, outcome.reason);
        this.db.logNotify({
          roomId: ref.roomId, liveTime: ref.liveTime, channel,
          ok: false, error: String(outcome.reason),
        });
        return;
      }
      for (const r of outcome.value) {
        total++;
        if (r.ok) succeeded++;
        else log.warn(`${channel}${r.target ? ` (${r.target})` : ''} 失败: ${r.error}`);
        this.db.logNotify({
          roomId: ref.roomId, liveTime: ref.liveTime, channel,
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
