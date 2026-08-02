import { makeLogger } from '../../logger.js';
import { BiliApiError } from './client.js';
import { fetchLiveStatus } from './live-status.js';
import { PeriodicTask } from '../../core/scheduler.js';
import { diffRoom, toPrevState, type PrevState } from '../../core/state.js';
import type { Signal } from '../../core/types.js';
import type { Source, SourceContext } from '../types.js';
import type { RoomStatus } from './types.js';

const log = makeLogger('bili/live-status-source');

/** 注入点：便于单测拉取失败、风控等路径，生产环境用真实实现 */
export type StatusFetcher = (uids: string[]) => Promise<Map<string, RoomStatus>>;

export interface LiveStatusSourceOpts {
  /** 只监听这些 uid（--force-uid 用），为空则读数据库 streamers 表 */
  forceUids?: string[];
  fetcher?: StatusFetcher;
}

/**
 * 批量轮询开播状态：fetcher 拉全量 → 逐 uid diffRoom → 批量写 room_state
 * （单事务）→ 把 Signal emit 上 bus。只产信号和归档，不做任何通知判断：
 * 冷启动只打 coldStart 标记，健康告警只发 health_alert 信号。
 */
export class LiveStatusSource implements Source {
  readonly name = 'bili/live-status';

  private ctx?: SourceContext;
  private task?: PeriodicTask;
  private prev = new Map<string, PrevState>();
  /** 见过的 uid（含未开播的）。用来区分「首次运行」与「新增订阅」。 */
  private known = new Set<string>();
  private consecutiveFailures = 0;
  private alerted = false;

  private readonly fetcher: StatusFetcher;

  constructor(private readonly opts: LiveStatusSourceOpts = {}) {
    this.fetcher = opts.fetcher ?? fetchLiveStatus;
  }

  /** 供测试断言健康计数 */
  get failureCount(): number {
    return this.consecutiveFailures;
  }

  private get uids(): string[] {
    const forced = this.opts.forceUids;
    if (forced && forced.length > 0) return forced;
    return this.ctx!.db.listWatchedUids();
  }

  start(ctx: SourceContext): void {
    this.bind(ctx);
    this.task = new PeriodicTask({
      name: this.name,
      intervalSec: ctx.config.pollIntervalSec,
      jitterSec: ctx.config.pollJitterSec,
      run: async () => { await this.pollOnce(); },
    });
    this.task.start();
  }

  stop(): void {
    this.task?.stop();
  }

  /** start 中除周期调度外的部分。测试可 bind 后直接驱动 pollOnce。 */
  bind(ctx: SourceContext): void {
    this.ctx = ctx;
    this.restore();
    log.info(
      `启动：${this.uids.length} 个订阅，间隔 ${ctx.config.pollIntervalSec}s` +
      `(+0~${ctx.config.pollJitterSec}s 抖动)，已恢复 ${this.prev.size} 条历史状态`,
    );
  }

  /** 从 DB 恢复基线。bind() 会调，测试也可单独调。 */
  restore(): void {
    this.prev = this.ctx!.db.loadRoomStates();
    this.known = new Set(this.prev.keys());
  }

  /** 拉取一轮：diff 产信号、批量落状态、emit 上总线。返回是否成功。 */
  async pollOnce(): Promise<boolean> {
    const ctx = this.ctx!;
    const uids = this.uids;
    let statuses: Map<string, RoomStatus>;
    try {
      statuses = await this.fetcher(uids);
      this.onPollSuccess();
    } catch (e) {
      // 关键：拉取失败绝不能当成下播 —— 保留旧状态，什么都不做
      const kind = e instanceof BiliApiError ? '业务层' : 'HTTP层';
      log.error(`${kind}拉取失败，保留上一次状态`, e);
      this.onPollFailure(e);
      return false;
    }

    // known 为空 = 首次运行。整轮统一判定（而不是逐 uid），否则首轮里
    // 排在后面的 uid 会被误判成「新增订阅」。
    const firstRun = this.known.size === 0;
    const signals: Signal[] = [];
    const stateWrites: Array<{ uid: string; state: PrevState }> = [];

    for (const uid of uids) {
      const curr = statuses.get(uid) ?? null;
      const prev = this.prev.get(uid);
      const sigs = diffRoom(uid, prev, curr);

      const cold: Signal['coldStart'] = firstRun ? 'first_run'
        : !this.known.has(uid) ? 'new_subscription'
        : undefined;
      if (cold) for (const s of sigs) s.coldStart = cold;

      if (curr) {
        const st = toPrevState(curr);
        this.prev.set(uid, st);
        stateWrites.push({ uid, state: st });
        // 头像回填（匿名可得通道）：streamers 里 face 为空且本轮拿到就补上，
        // 不碰其他字段（upsertStreamer 未提供的字段保留原值）
        if (curr.face) {
          const s = ctx.db.getStreamer(uid);
          if (s && !s.face) {
            ctx.db.upsertStreamer({ uid, face: curr.face, uname: curr.uname || undefined });
          }
        }
      } else if (prev?.isLive) {
        const off = { ...prev, isLive: false, liveTime: 0 };
        this.prev.set(uid, off);
        stateWrites.push({ uid, state: off });
      }
      // 首轮观测到的 uid 记进 known，之后它就不再算「新增订阅」
      this.known.add(uid);
      signals.push(...sigs);
    }

    // 批量落状态：单事务，避免订阅多了以后每轮 N 次 fsync
    ctx.db.saveRoomStates(stateWrites);
    for (const s of signals) ctx.bus.emit(s);
    return true;
  }

  private onPollSuccess(): void {
    if (this.consecutiveFailures > 0) {
      log.info(`拉取恢复正常（此前连续失败 ${this.consecutiveFailures} 次）`);
    }
    this.consecutiveFailures = 0;
    this.alerted = false;
  }

  private onPollFailure(err: unknown): void {
    this.consecutiveFailures++;
    const threshold = this.ctx!.config.healthAlertAfterFailures;
    if (this.consecutiveFailures >= threshold && !this.alerted) {
      this.alerted = true; // 同一轮故障只告警一次，恢复后才复位
      this.ctx!.bus.emit({
        source: this.name,
        kind: 'health_alert',
        uid: '',
        roomId: '',
        ts: Math.floor(Date.now() / 1000),
        payload: {
          failures: this.consecutiveFailures,
          subscriptions: this.uids.length,
          lastError: String(err),
        },
      });
    }
  }
}
