import type { DecisionRule, NotifyDecision } from './types.js';
import type { LiveEvent, Signal } from '../core/types.js';

/** 只需要 Db 的这一小部分，方便单测传假对象 */
export interface SessionStore {
  hasNotified(roomId: string, liveTime: number): boolean;
}

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
    return { shouldNotify: true, reason: '本场首次开播' };
  }
}
