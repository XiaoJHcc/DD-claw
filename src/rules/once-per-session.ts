import type { DecisionRule, NotifyDecision } from './types.js';
import type { LiveEvent, Signal } from '../core/types.js';

/** 回溯链中的一场归档事实（重连判定只看这些）。 */
export interface PreviousSession {
  liveTime: number;
  title: string;
  firstSeen: number;
  endSeen: number | null;
  notifiedAt: number | null;
}

/** 只需要 Db 的这一小部分，方便单测传假对象 */
export interface SessionStore {
  hasNotified(roomId: string, liveTime: number): boolean;
  /** 本场之前最近的若干场，按 live_time 倒序（链式重连判定用） */
  recentSessionsBefore(roomId: string, liveTime: number, limit: number): PreviousSession[];
}

/** 回溯链的场次数上限：正常重连只有一两场，留足余量即可 */
const RECONNECT_CHAIN_LIMIT = 20;

/** 同一轮观测里衔接的时间容差（归档时刻与信号时刻可能跨秒） */
const SAME_POLL_TOLERANCE_SEC = 2;

/**
 * M1 规则：一场直播只推一次。
 *
 * 「无条件推送」不等于「不去重」—— 轮询 45 秒一次，真无条件推
 * 一场直播会产生几十条通知。去重依据是 (roomId, liveTime)，
 * liveTime 是服务端给的开播时间戳，所以：
 *   - 进程重启后不重推（DB 里还有记录）
 *   - 网络闪断不误报（liveTime 没变就是同一场）
 *   - 主播真的下播又开播会正常推（liveTime 变了）
 *
 * liveTime 变了不一定是新直播：B站会在推流重连时重发 live_time。若从上一场往前回溯，
 * 每一场都同标题、且上一场的 end_seen 与下一场的起点在同一轮观测里衔接（中间从未观测到
 * 下播），并最终回溯到某场「已推送」的记录，就按同一条直播的续播处理，不重复通知；
 * 场次归档仍按新 live_time 如实记录。链断在哪一场，就以哪一场为新直播照常推。
 *
 * M2 会在这里演进成「每次场景切换推一次 + 冷却窗口」，位置不变。
 */
export class OncePerSessionRule implements DecisionRule {
  readonly name = 'once-per-session';

  constructor(private readonly store: SessionStore) {}

  async decide(event: LiveEvent, signal: Signal): Promise<NotifyDecision> {
    if (signal.kind !== 'live_start') {
      return { shouldNotify: false, reason: `M1 只推开播，忽略 ${signal.kind}` };
    }
    if (event.liveTime <= 0) {
      return { shouldNotify: false, reason: 'liveTime 缺失，无法判定是否已推过，跳过以免重复' };
    }
    if (this.store.hasNotified(event.roomId, event.liveTime)) {
      return { shouldNotify: false, reason: `本场已推送过 (room=${event.roomId} liveTime=${event.liveTime})` };
    }
    const chain = this.store.recentSessionsBefore(
      event.roomId, event.liveTime, RECONNECT_CHAIN_LIMIT,
    );
    const origin = this.notifiedOriginOfChain(event, signal, chain);
    if (origin !== null) {
      return {
        shouldNotify: false,
        reason: `同场直播重连（liveTime ${origin.liveTime}→${event.liveTime}，标题未变且未观测到下播），不重复推`,
      };
    }
    return { shouldNotify: true, reason: '本场首次开播' };
  }

  /**
   * 从本场往前回溯：每一场都必须同标题、且 end_seen 与下一场的起点在同一轮观测里衔接。
   * 回到某场「已推送」的记录 = 同一条直播的重连；链断或先遇到未推送的起点 = 真新场。
   */
  private notifiedOriginOfChain(
    event: LiveEvent, signal: Signal, chain: PreviousSession[],
  ): PreviousSession | null {
    if (event.title === '') return null;
    let expectedEnd = signal.ts;
    for (const session of chain) {
      if (session.title !== event.title) return null;
      if (session.endSeen === null
        || Math.abs(session.endSeen - expectedEnd) > SAME_POLL_TOLERANCE_SEC) return null;
      if (session.notifiedAt != null) return session;
      // 这一场是上一次被抑制的重连：它的起点与再上一场的终点也是同一轮
      expectedEnd = session.firstSeen;
    }
    return null;
  }
}
