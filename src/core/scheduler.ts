import { makeLogger } from '../logger.js';
import { fetchLiveStatus } from '../sources/bili/live-status.js';
import { BiliApiError } from '../sources/bili/client.js';
import { diffRoom, toPrevState, type PrevState } from './state.js';
import { toLiveEvent, type Signal } from './types.js';
import { mapLimit } from './concurrency.js';
import type { Db } from './db.js';
import type { AppConfig } from '../config/schema.js';
import type { Analyzer } from '../analysis/types.js';
import type { DecisionRule } from '../rules/types.js';
import type { NotifyDispatcher } from '../notify/dispatcher.js';
import type { RoomStatus } from '../sources/bili/types.js';

const log = makeLogger('scheduler');

/** 同时处理多少个主播的推送。够覆盖同时开播的常见规模，又不至于打爆 NapCat。 */
const NOTIFY_CONCURRENCY = 4;

/** 注入点：便于单测拉取失败、风控等路径，生产环境用真实实现 */
export type StatusFetcher = (uids: string[]) => Promise<Map<string, RoomStatus>>;

export interface SchedulerDeps {
  config: AppConfig;
  db: Db;
  analyzer: Analyzer;
  rule: DecisionRule;
  dispatcher: NotifyDispatcher;
  /** 只监听这些 uid（--force-uid 用），为空则用配置里的订阅 */
  forceUids?: string[];
  fetcher?: StatusFetcher;
}

export class Scheduler {
  private running = false;
  private prev = new Map<string, PrevState>();
  /** 见过的 uid（含未开播的）。用来区分「首次运行」与「新增订阅」。 */
  private known = new Set<string>();
  private consecutiveFailures = 0;
  private alerted = false;
  private timer: NodeJS.Timeout | undefined;

  private readonly fetcher: StatusFetcher;

  constructor(private readonly deps: SchedulerDeps) {
    this.fetcher = deps.fetcher ?? fetchLiveStatus;
  }

  /** 供测试断言健康计数 */
  get failureCount(): number {
    return this.consecutiveFailures;
  }

  private get uids(): string[] {
    const forced = this.deps.forceUids;
    if (forced && forced.length > 0) return forced;
    return this.deps.config.subscriptions.filter((s) => s.enabled).map((s) => s.uid);
  }

  private aliasOf(uid: string): string {
    return this.deps.config.subscriptions.find((s) => s.uid === uid)?.alias ?? '';
  }

  /** 从 DB 恢复基线。start() 会调，测试也可单独调。 */
  restore(): void {
    this.prev = this.deps.db.loadRoomStates();
    this.known = new Set(this.prev.keys());
  }

  async start(): Promise<void> {
    this.restore();
    this.running = true;
    log.info(
      `启动：${this.uids.length} 个订阅，间隔 ${this.deps.config.pollIntervalSec}s` +
      `(+0~${this.deps.config.pollJitterSec}s 抖动)，已恢复 ${this.prev.size} 条历史状态`,
    );
    while (this.running) {
      await this.pollOnce();
      if (!this.running) break;
      await this.sleep();
    }
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  private sleep(): Promise<void> {
    const { pollIntervalSec, pollJitterSec } = this.deps.config;
    const ms = pollIntervalSec * 1000 + Math.random() * pollJitterSec * 1000;
    return new Promise((r) => {
      this.timer = setTimeout(r, ms);
    });
  }

  /** 拉取一次并处理。返回是否成功（供 --probe 复用） */
  async pollOnce(): Promise<boolean> {
    const uids = this.uids;
    let statuses;
    try {
      statuses = await this.fetcher(uids);
      this.onPollSuccess();
    } catch (e) {
      // 关键：拉取失败绝不能当成下播 —— 保留旧状态，什么都不做
      const kind = e instanceof BiliApiError ? '业务层' : 'HTTP层';
      log.error(`${kind}拉取失败，保留上一次状态`, e);
      await this.onPollFailure(e);
      return false;
    }

    // 第一遍：算 diff 并落状态。同步、快，包在一个事务里避免 N 次 fsync。
    const pending: Array<{ uid: string; signals: Signal[] }> = [];
    const stateWrites: Array<{ uid: string; state: PrevState }> = [];

    for (const uid of uids) {
      const curr = statuses.get(uid) ?? null;
      const prev = this.prev.get(uid);
      const signals = diffRoom(uid, prev, curr, {
        notifyOnColdStart: this.shouldNotifyOnColdStart(uid),
      });

      if (curr) {
        const st = toPrevState(curr);
        this.prev.set(uid, st);
        stateWrites.push({ uid, state: st });
      } else if (prev?.isLive) {
        const off = { ...prev, isLive: false, liveTime: 0 };
        this.prev.set(uid, off);
        stateWrites.push({ uid, state: off });
      }
      // 首轮观测到的 uid 记进 known，之后它就不再算「新增订阅」
      this.known.add(uid);
      if (signals.length > 0) pending.push({ uid, signals });
    }

    this.deps.db.saveRoomStates(stateWrites);

    // 第二遍：并发处理 signal。多个主播同时开播时不再串行等待，
    // 但限制并发数以免瞬时打爆 NapCat。
    await mapLimit(pending, NOTIFY_CONCURRENCY, async ({ uid, signals }) => {
      for (const sig of signals) await this.handleSignal(sig, uid);
    });
    return true;
  }

  /**
   * 区分「首次运行」和「新增订阅」。
   *
   * 两者的 prev 都不存在，但语义完全不同：首次运行时全部订阅都没记录，
   * 推送会刷屏；而后续新加一个主播时，如果他正在直播，跳过就意味着
   * 这一场永远收不到通知（得等他下播再开播）。默认对新增订阅推送。
   */
  private shouldNotifyOnColdStart(uid: string): boolean {
    const isFirstRun = this.known.size === 0;
    if (isFirstRun) return this.deps.config.notifyOnFirstRun;
    if (!this.known.has(uid)) return this.deps.config.notifyOnNewSubscription;
    return this.deps.config.notifyOnFirstRun;
  }

  private async handleSignal(signal: Signal, uid: string): Promise<void> {
    const { db, analyzer, rule, dispatcher } = this.deps;
    const event = toLiveEvent(signal.status, this.aliasOf(uid));

    if (signal.kind === 'live_start') {
      db.recordSession({
        roomId: event.roomId, liveTime: event.liveTime, uid: event.uid,
        uname: event.uname, title: event.title, areaName: event.areaName,
      });
    }

    const verdict = await analyzer.analyze({ event, signal });
    const decision = await rule.decide({ ...event, verdict }, signal, verdict);

    if (!decision.shouldNotify) {
      log.debug(`不推送 [${signal.kind}] ${event.alias || event.uname}: ${decision.reason}`);
      return;
    }

    log.info(`推送 [${signal.kind}] ${event.alias || event.uname} — ${decision.reason}`);
    const outcome = await dispatcher.broadcast({ ...event, verdict });

    // 只要有任一通道成功就标记，否则 Toast 成功而 QQ 失败会导致下轮重推
    if (outcome.anySuccess && signal.kind === 'live_start') {
      db.markNotified(event.roomId, event.liveTime);
    }
  }

  private onPollSuccess(): void {
    if (this.consecutiveFailures > 0) {
      log.info(`拉取恢复正常（此前连续失败 ${this.consecutiveFailures} 次）`);
    }
    this.consecutiveFailures = 0;
    this.alerted = false;
  }

  private async onPollFailure(err: unknown): Promise<void> {
    this.consecutiveFailures++;
    const threshold = this.deps.config.healthAlertAfterFailures;
    if (this.consecutiveFailures >= threshold && !this.alerted) {
      this.alerted = true; // 只告警一次，避免刷屏
      const n = this.uids.length;
      await this.deps.dispatcher.alertAll(
        'DD-claw 监听异常',
        `连续 ${this.consecutiveFailures} 次拉取B站接口失败。\n` +
        `这是批量接口，**全部 ${n} 个订阅都收不到开播通知**。\n` +
        `最后错误: ${String(err)}`,
      );
    }
  }
}
