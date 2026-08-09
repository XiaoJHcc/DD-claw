import type { Classification } from '../analysis/types.js';
import type { LiveEvent, Signal } from '../core/types.js';

export interface NotifyDecision {
  shouldNotify: boolean;
  /** 无论推还是不推都要给理由，便于排查「为什么没收到通知」 */
  reason: string;
}

export interface DecisionRule {
  readonly name: string;
  /** classifications 可为空数组（未判定/无分类）。规则不得假设它非空。 */
  decide(event: LiveEvent, signal: Signal, classifications: Classification[]): Promise<NotifyDecision>;
}
