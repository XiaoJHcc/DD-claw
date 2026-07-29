import type { SceneVerdict } from '../analysis/types.js';
import type { LiveEvent, Signal } from '../core/types.js';

export interface NotifyDecision {
  shouldNotify: boolean;
  /** 无论推还是不推都要给理由，便于排查「为什么没收到通知」 */
  reason: string;
}

export interface DecisionRule {
  readonly name: string;
  /** verdict 可为 null（M1 就是 null）。规则不得假设它一定存在。 */
  decide(event: LiveEvent, signal: Signal, verdict: SceneVerdict | null): Promise<NotifyDecision>;
}
