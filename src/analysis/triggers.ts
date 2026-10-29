import { makeLogger } from '../logger.js';
import type { Bus } from '../core/bus.js';
import type { LiveStatus, Signal } from '../core/types.js';

const log = makeLogger('analysis/triggers');

/** 本层负责的延迟/定时时机（即时的开播与标题变更由 pipeline 直接处理，这里不再发一次） */
export type LiveDelayedTrigger = 'startDelay' | 'periodic' | 'titleDelay';

/** 计时器接口：单测注入假时钟，生产用 setTimeout */
export interface LiveTriggerTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const DEFAULT_TIMERS: LiveTriggerTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface LiveClassifyTriggersOptions {
  bus: Bus;
  /** 开播后 / 标题分区变更后的延迟（秒）——两个延迟时机共用同一个口径 */
  delaySec: () => number;
  /** 直播中定时重判的周期（秒） */
  periodicSec: () => number;
  timers?: LiveTriggerTimers;
  /** 当前时间（秒），测试注入 */
  now?: () => number;
}

interface SessionState {
  roomId: string;
  liveTime: number;
  uid: string;
  /** 最后一次观测到的快照：内部分类信号拿它当 status */
  status: LiveStatus;
  delayTimer?: unknown;
  titleTimer?: unknown;
  periodicTimer?: unknown;
}

const sessionKey = (roomId: string, liveTime: number): string => `${roomId}:${liveTime}`;

/**
 * 直播分类时机：跟踪在播场次，在「开播延迟后 / 直播中定时 / 变更延迟后」三个时机把
 * `live_reclassify` 信号发回总线，由 pipeline 与开播初判走同一条判定与推送路径。
 *
 * 语义边界：
 * - **只排定时，不判内容**：这里不认识分类、不调模型、不推送；分析仍只从 queue 进。
 * - **重启不补打**：periodic 从「本进程第一次看到这一场」起按周期触发，历史周期不补；
 *   startDelay 只为真正观测到开播的场次排（冷启动恢复的场次开播早已发生，不排）。
 * - **变更防抖**：连续 title_change 以最后一次为准重新计时，短时间内多次改标题只判一次。
 * - **一场一组计时器**：liveTime 变了才是新场；重复 live_start 只更新快照，不重置已有计时器。
 * - `live_end` 清该房间全部计时器；`stop()` 清全部（进程退出）。
 * - 延迟/周期都是运行参数，`reconfigure({ delay, periodic })` 只重排变化的那一项：
 *   周期从此刻按新周期重排，尚未触发的开播延迟按新值重排、正在等待的变更延迟重新计时。
 */
export class LiveClassifyTriggers {
  private readonly sessions = new Map<string, SessionState>();
  private readonly timers: LiveTriggerTimers;
  private readonly now: () => number;
  private attached = false;
  private stopped = false;

  constructor(private readonly opts: LiveClassifyTriggersOptions) {
    this.timers = opts.timers ?? DEFAULT_TIMERS;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** 开始跟踪信号（与 pipeline 并行的总线订阅者，两者互不依赖） */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.stopped = false;
    this.opts.bus.on('*', (s) => this.observe(s));
  }

  /**
   * 运行参数热更新：按变化的那一项重排计时器（缺省两项都重排，方便直接调用）。
   * - `periodic`：清掉已排出的周期计时器并按新周期重排（从此刻起算）
   * - `delay`：把**尚未触发**的开播延迟按新值重排；变更延迟属于防抖，正在等待的那次
   *   按新值重新计时（等价于把最后一次变更当作刚发生）。已经触发过的不补排。
   */
  reconfigure(which: { delay?: boolean; periodic?: boolean } = {}): void {
    const delay = which.delay ?? true;
    const periodic = which.periodic ?? true;
    for (const st of this.sessions.values()) {
      if (periodic) {
        this.clearPeriodic(st);
        this.schedulePeriodic(st);
      }
      if (delay) {
        if (st.delayTimer !== undefined) {
          this.timers.clear(st.delayTimer);
          st.delayTimer = undefined;
          this.scheduleDelay(st);
        }
        if (st.titleTimer !== undefined) {
          this.timers.clear(st.titleTimer);
          st.titleTimer = undefined;
          this.scheduleTitleDelay(st);
        }
      }
    }
  }

  /** 进程退出：清空全部计时器并停止响应后续信号 */
  stop(): void {
    this.stopped = true;
    for (const st of this.sessions.values()) this.clearAll(st);
    this.sessions.clear();
  }

  /** 当前跟踪的场次（测试与排障用） */
  tracked(): Array<{ roomId: string; liveTime: number }> {
    return [...this.sessions.values()].map((st) => ({ roomId: st.roomId, liveTime: st.liveTime }));
  }

  private observe(s: Signal): void {
    if (this.stopped) return;
    if (s.kind === 'live_start' && s.status?.isLive) return this.onLiveStart(s, s.status);
    if (s.kind === 'title_change' && s.status?.isLive) return this.onTitleChange(s, s.status);
    if (s.kind === 'live_end') return this.onLiveEnd(s);
  }

  private onLiveStart(s: Signal, status: LiveStatus): void {
    const key = sessionKey(status.roomId, status.liveTime);
    const existing = this.sessions.get(key);
    if (existing !== undefined) {
      // 同一场重复的 live_start：只更新快照，绝不重置已排好的计时器
      existing.status = status;
      return;
    }
    // 该房间的其它场次（漏了 live_end 的旧场）先清掉，只保留最新一场
    this.clearRoom(status.roomId, key);
    const st: SessionState = { roomId: status.roomId, liveTime: status.liveTime, uid: s.uid, status };
    this.sessions.set(key, st);
    // 冷启动恢复 / 新增订阅：开播早已发生，延迟时机没有意义（周期从观察到起算，照排）
    if (s.coldStart === undefined) this.scheduleDelay(st);
    this.schedulePeriodic(st);
  }

  private onTitleChange(s: Signal, status: LiveStatus): void {
    const st = this.sessions.get(sessionKey(status.roomId, status.liveTime));
    if (st === undefined) {
      // 本进程没有观测到这场开播（例如重启后才改标题）：不排延迟计时器
      log.debug(`忽略 title_change 的延迟重判（未跟踪的场次 ${status.roomId}:${status.liveTime}）`);
      return;
    }
    st.status = status;
    if (st.titleTimer !== undefined) this.timers.clear(st.titleTimer);
    st.titleTimer = undefined;
    this.scheduleTitleDelay(st);
  }

  private onLiveEnd(s: Signal): void {
    this.clearRoom(s.roomId);
  }

  private scheduleDelay(st: SessionState): void {
    if (st.delayTimer !== undefined) return;
    st.delayTimer = this.timers.set(() => {
      st.delayTimer = undefined;
      this.fire(st, 'startDelay');
    }, Math.max(1, this.opts.delaySec()) * 1000);
  }

  /** 变更延迟 = 防抖窗口：每次（或延迟参数变化时）都从此刻重新计时 */
  private scheduleTitleDelay(st: SessionState): void {
    st.titleTimer = this.timers.set(() => {
      st.titleTimer = undefined;
      this.fire(st, 'titleDelay');
    }, Math.max(1, this.opts.delaySec()) * 1000);
  }

  private schedulePeriodic(st: SessionState): void {
    st.periodicTimer = this.timers.set(() => {
      st.periodicTimer = undefined;
      if (this.fire(st, 'periodic')) this.schedulePeriodic(st);
    }, Math.max(1, this.opts.periodicSec()) * 1000);
  }

  private clearPeriodic(st: SessionState): void {
    if (st.periodicTimer !== undefined) {
      this.timers.clear(st.periodicTimer);
      st.periodicTimer = undefined;
    }
  }

  private clearAll(st: SessionState): void {
    for (const handle of [st.delayTimer, st.titleTimer, st.periodicTimer]) {
      if (handle !== undefined) this.timers.clear(handle);
    }
    st.delayTimer = undefined;
    st.titleTimer = undefined;
    st.periodicTimer = undefined;
  }

  /** 清该房间的计时器；exceptKey = 要保留的那一场（新场已登记时） */
  private clearRoom(roomId: string, exceptKey?: string): void {
    for (const [key, st] of this.sessions) {
      if (st.roomId !== roomId || key === exceptKey) continue;
      this.clearAll(st);
      this.sessions.delete(key);
    }
  }

  /** 发内部分类信号；返回 false = 该场已不在跟踪中（计时器到点时场次已结束） */
  private fire(st: SessionState, trigger: LiveDelayedTrigger): boolean {
    if (this.sessions.get(sessionKey(st.roomId, st.liveTime)) !== st) return false;
    this.opts.bus.emit({
      source: 'analysis/triggers',
      kind: 'live_reclassify',
      uid: st.uid,
      roomId: st.roomId,
      ts: this.now(),
      status: st.status,
      payload: { trigger },
    });
    return true;
  }
}
