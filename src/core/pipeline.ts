import { makeLogger } from '../logger.js';
import { toLiveEvent, type LiveEvent, type PushMessage, type Signal } from './types.js';
import { liveEventToMessage } from '../notify/message.js';
import { matchPushRule, renderTemplate } from '../analysis/matcher.js';
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

    // verdict 只来自分析队列（将来接 LLM Analyzer；NoopAnalyzer 恒 null）。
    // 无 LLM 时不做分类，推送走用户自定的透明条件规则（buildMessage）。
    const verdict = await queue.submit({ event, signal });
    const decision = await rule.decide({ ...event, verdict }, signal, verdict);

    if (!decision.shouldNotify) {
      log.debug(`不推送 [${signal.kind}] ${event.alias || event.uname}: ${decision.reason}`);
      return;
    }

    const msg = this.buildMessage({ ...event, verdict });
    if (!msg) return; // buildMessage 已记日志（规则不命中 / 规则未选渠道）

    log.info(`推送 [${signal.kind}] ${event.alias || event.uname} — ${decision.reason}`);
    const outcome = await dispatcher.broadcast(msg);

    // 只要有任一通道成功就标记，否则 Toast 成功而 QQ 失败会导致下轮重推
    if (outcome.anySuccess && signal.kind === 'live_start') {
      db.markNotified(event.roomId, event.liveTime);
    }
  }

  /**
   * 透明条件规则 → PushMessage；返回 null = 不推（命中规则未选渠道 / 全局默认未选渠道）。
   * - 主播只有条件规则：优先级第一条命中；命中规则的 channels 为空 = 用户明确不推
   * - 条件规则均不命中（含一条都没有）→ 全局默认：settings.default_channels
   *   （未设置 = 全部启用渠道的旧兜底行为；显式空数组 = 默认不推）+ 全局默认模板
   * - 模板：规则覆盖 > settings.default_template > 内置默认；正文/图片/跳转沿用默认形状
   */
  private buildMessage(event: LiveEvent): PushMessage | null {
    const { db } = this.deps;
    const base = liveEventToMessage(event);
    const rule = matchPushRule(db.listEnabledPushRules(event.uid), event);

    let channelIds: number[];
    let templateOverride: string | null = null;
    if (rule) {
      if (rule.channels.length === 0) {
        log.info(`不推送 ${event.alias || event.uname}: 命中规则 #${rule.id} 但未勾选渠道`);
        return null;
      }
      channelIds = rule.channels;
      templateOverride = rule.messageTemplate;
      log.info(`命中推送规则 #${rule.id}（${event.alias || event.uname}）`);
    } else {
      channelIds = this.defaultChannelIds();
      if (channelIds.length === 0) {
        log.info(`不推送 ${event.alias || event.uname}: 条件规则均不命中，且全局默认未选渠道`);
        return null;
      }
    }

    const tpl = templateOverride ?? db.getSetting('default_template') ?? '{alias} 开播了';
    const text = renderTemplate(tpl, event).trim();
    return { ...base, title: text || base.title, channels: channelIds.map(String) };
  }

  /**
   * 全局默认推送渠道：settings.default_channels（JSON id 数组）。
   * 未设置 = 全部启用渠道（旧兜底行为，面板里显示为全勾）；显式空数组 = 默认不推。
   */
  private defaultChannelIds(): number[] {
    const raw = this.deps.db.getSetting('default_channels');
    if (raw === null) {
      return this.deps.db.listPushChannels().filter((c) => c.enabled).map((c) => c.id);
    }
    try {
      const ids = JSON.parse(raw) as unknown;
      return Array.isArray(ids) ? ids.filter((x): x is number => typeof x === 'number') : [];
    } catch {
      log.warn(`settings.default_channels 不是合法 JSON，按默认不推处理: ${raw}`);
      return [];
    }
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
