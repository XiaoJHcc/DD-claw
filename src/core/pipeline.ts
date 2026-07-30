import { makeLogger } from '../logger.js';
import { toLiveEvent, type Signal } from './types.js';
import { liveEventToMessage } from '../notify/message.js';
import type { Bus } from './bus.js';
import type { Db } from './db.js';
import type { AppConfig } from '../config/schema.js';
import type { AnalysisQueue } from '../analysis/queue.js';
import type { DecisionRule } from '../rules/types.js';
import type { NotifyDispatcher } from '../notify/dispatcher.js';

const log = makeLogger('core/pipeline');

/** 同时处理多少个信号的推送。够覆盖同时开播的常见规模，又不至于打爆 NapCat。 */
const NOTIFY_CONCURRENCY = 4;

export interface PipelineDeps {
  bus: Bus;
  db: Db;
  config: AppConfig;
  queue: AnalysisQueue;
  rule: DecisionRule;
  dispatcher: NotifyDispatcher;
}

interface HealthAlertPayload {
  failures: number;
  subscriptions: number;
  lastError: string;
}

/**
 * 信号编排的唯一装配点：bus → 冷启动抑制 → 分析队列 → 规则护栏 → 推送。
 * source 只产信号，所有政策判断都在这里及之后的层。
 */
export class Pipeline {
  private active = 0;
  private readonly pending: Signal[] = [];
  private readonly idleWaiters: Array<() => void> = [];

  constructor(private readonly deps: PipelineDeps) {}

  attach(): void {
    this.deps.bus.on('*', (s) => this.enqueue(s));
  }

  /** 等待当前排队与在飞的信号全部处理完（测试用）。 */
  whenIdle(): Promise<void> {
    if (this.active === 0 && this.pending.length === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private enqueue(s: Signal): void {
    this.pending.push(s);
    this.drain();
  }

  private drain(): void {
    while (this.active < NOTIFY_CONCURRENCY && this.pending.length > 0) {
      const s = this.pending.shift()!;
      this.active++;
      void this.handle(s)
        .catch((e) => log.error(`处理信号 [${s.kind}] 异常`, e))
        .finally(() => {
          this.active--;
          this.drain();
          if (this.active === 0 && this.pending.length === 0) {
            for (const r of this.idleWaiters.splice(0)) r();
          }
        });
    }
  }

  private aliasOf(uid: string): string {
    return this.deps.config.subscriptions.find((s) => s.uid === uid)?.alias ?? '';
  }

  private async handle(signal: Signal): Promise<void> {
    if (signal.kind === 'health_alert') return this.handleHealthAlert(signal);
    if (!signal.status) {
      log.debug(`忽略无状态的信号 [${signal.kind}]（${signal.source}）`);
      return;
    }

    const { db, config, queue, rule, dispatcher } = this.deps;
    const event = toLiveEvent(signal.status, this.aliasOf(signal.uid));

    if (signal.kind === 'live_start') {
      db.recordSession({
        roomId: event.roomId, liveTime: event.liveTime, uid: event.uid,
        uname: event.uname, title: event.title, areaName: event.areaName,
      });
    }

    // 冷启动抑制（政策在这层，diffRoom 只如实产信号、source 只打标记）：
    // 跳过通知，但上面 live_start 的 recordSession 照做。
    if (signal.coldStart === 'first_run' && !config.notifyOnFirstRun) {
      log.debug(`不推送 [${signal.kind}] ${event.alias || event.uname}: 首次运行已在播，按配置不推送`);
      return;
    }
    if (signal.coldStart === 'new_subscription' && !config.notifyOnNewSubscription) {
      log.debug(`不推送 [${signal.kind}] ${event.alias || event.uname}: 新增订阅正在直播，按配置不推送`);
      return;
    }

    const verdict = await queue.submit({ event, signal });
    const decision = await rule.decide({ ...event, verdict }, signal, verdict);

    if (!decision.shouldNotify) {
      log.debug(`不推送 [${signal.kind}] ${event.alias || event.uname}: ${decision.reason}`);
      return;
    }

    log.info(`推送 [${signal.kind}] ${event.alias || event.uname} — ${decision.reason}`);
    const outcome = await dispatcher.broadcast(liveEventToMessage({ ...event, verdict }));

    // 只要有任一通道成功就标记，否则 Toast 成功而 QQ 失败会导致下轮重推
    if (outcome.anySuccess && signal.kind === 'live_start') {
      db.markNotified(event.roomId, event.liveTime);
    }
  }

  private async handleHealthAlert(signal: Signal): Promise<void> {
    const p = signal.payload as HealthAlertPayload | undefined;
    await this.deps.dispatcher.alertAll(
      'DD-claw 监听异常',
      `连续 ${p?.failures ?? 0} 次拉取B站接口失败。\n` +
      `这是批量接口，**全部 ${p?.subscriptions ?? 0} 个订阅都收不到开播通知**。\n` +
      `最后错误: ${p?.lastError ?? '(未知)'}`,
    );
  }
}
