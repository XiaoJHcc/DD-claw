import { makeLogger } from '../logger.js';
import { toLiveEvent, type LiveEvent, type PushMessage, type Signal } from './types.js';
import { liveEventToMessage } from '../notify/message.js';
import { matchPushRules, renderTemplate } from '../analysis/matcher.js';
import { isPushEnabled } from './push.js';
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
  failures?: number;
  subscriptions?: number;
  lastError?: string;
  /** source 自定义的完整告警文案；缺省用 live-status 拉取失败的默认文案 */
  message?: string;
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
    return this.deps.db.getStreamer(uid)?.alias ?? '';
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
    // 重启恢复：上次下播、本次启动前开播的主播，无法得知真实开播时间，
    // 与 first_run 同属「启动时已在播」，共用 notifyOnFirstRun 这一个开关。
    if (signal.coldStart === 'restart_recovery' && !config.notifyOnFirstRun) {
      log.debug(`不推送 [${signal.kind}] ${event.alias || event.uname}: 停机期间开播（启动时已在播），按配置不推送`);
      return;
    }
    if (signal.coldStart === 'new_subscription' && !config.notifyOnNewSubscription) {
      log.debug(`不推送 [${signal.kind}] ${event.alias || event.uname}: 新增订阅正在直播，按配置不推送`);
      return;
    }

    // notify=false：追踪照常（recordSession 已在上面做），但不产生推送。
    // watch=1 && notify=0 = 旧 mode='silent' 语义；位置在冷启动抑制之后。
    if (db.getStreamer(signal.uid)?.notify === false) {
      log.debug(`不推送 [${signal.kind}] ${event.alias || event.uname}: notify=off（仅抑制推送，追踪照常）`);
      return;
    }

    // 推送总开关（面板推送卡右上角）：关 = 全局不推，追踪照常
    if (!isPushEnabled(db)) {
      log.debug(`不推送 [${signal.kind}] ${event.alias || event.uname}: 推送总开关已关`);
      return;
    }

    // 分类判定只在 live_start 做（live_end / title_change 不烧 LLM）；
    // 判定结果进规则匹配：推送规则按 categoryId 引用分类（buildMessage）
    const classifications = signal.kind === 'live_start' ? await queue.submit({ event, signal }) : [];
    const decision = await rule.decide({ ...event, classifications }, signal, classifications);

    if (!decision.shouldNotify) {
      log.debug(`不推送 [${signal.kind}] ${event.alias || event.uname}: ${decision.reason}`);
      return;
    }

    const msg = this.buildMessage({ ...event, classifications });
    if (!msg) return; // buildMessage 已记日志（规则不命中 / 规则未选渠道）

    log.info(`推送 [${signal.kind}] ${event.alias || event.uname} — ${decision.reason}`);
    const outcome = await dispatcher.broadcast(msg);

    // 只要有任一通道成功就标记，否则 Toast 成功而 QQ 失败会导致下轮重推
    if (outcome.anySuccess && signal.kind === 'live_start') {
      db.markNotified(event.roomId, event.liveTime);
    }
  }

  /**
   * 推送规则 → PushMessage；返回 null = 不推（命中集合渠道并集为空 / 无命中规则）。
   * - 命中集合非空：所有命中规则独立生效——渠道 = 各命中规则 channels 的并集（去重保序）；
   *   推送词 = sort 序首个非空 messageTemplate；并集为空 = 用户明确不推（记 log 不推）
   * - 无命中规则（含一条都没有）= 不推——「任意开播 × 全部主播」规则即旧全局默认的等价物，
   *   需要兜底推送的用户自建一条即可
   * - 模板：规则覆盖 > 内置默认 '{alias} 开播了'；正文/图片/跳转沿用默认形状
   */
  private buildMessage(event: LiveEvent): PushMessage | null {
    const { db } = this.deps;
    const base = liveEventToMessage(event);
    const hits = matchPushRules(
      db.listEnabledPushRules(), event,
      new Set(event.classifications.map((c) => c.categoryId)),
    );

    if (hits.length === 0) {
      log.info(`不推送 ${event.alias || event.uname}: 无命中规则`);
      return null;
    }
    const channelIds: number[] = [];
    let templateOverride: string | null = null;
    for (const r of hits) {
      for (const id of r.channels) {
        if (!channelIds.includes(id)) channelIds.push(id);
      }
      templateOverride ??= r.messageTemplate;
    }
    if (channelIds.length === 0) {
      log.info(`不推送 ${event.alias || event.uname}: 命中 ${hits.length} 条规则但都未勾选渠道`);
      return null;
    }
    log.info(`命中推送规则 ${hits.map((r) => `#${r.id}`).join('/')}（${event.alias || event.uname}）`);

    const tpl = templateOverride ?? '{alias} 开播了';
    const text = renderTemplate(tpl, event).trim();
    return { ...base, title: text || base.title, channels: channelIds.map(String) };
  }

  private async handleHealthAlert(signal: Signal): Promise<void> {
    const p = signal.payload as HealthAlertPayload | undefined;
    await this.deps.dispatcher.alertAll(
      'DD-claw 监听异常',
      p?.message ??
        `连续 ${p?.failures ?? 0} 次拉取B站接口失败。\n` +
        `这是批量接口，**全部 ${p?.subscriptions ?? 0} 个订阅都收不到开播通知**。\n` +
        `最后错误: ${p?.lastError ?? '(未知)'}`,
    );
  }
}
