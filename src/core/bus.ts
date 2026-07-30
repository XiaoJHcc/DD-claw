import { makeLogger } from '../logger.js';
import type { Signal, SignalKind } from './types.js';

const log = makeLogger('core/bus');

export type SignalHandler = (s: Signal) => void | Promise<void>;

/**
 * 类型化信号总线：抓取 → 编排的唯一通道。source 只 emit，pipeline 只 on，
 * 双方互不认识。emit 不 await handler；单个 handler 抛异常只记日志，
 * 不影响其他 handler。
 */
export class Bus {
  private readonly handlers = new Map<SignalKind | '*', Set<SignalHandler>>();

  on(kind: SignalKind | '*', fn: SignalHandler): void {
    let set = this.handlers.get(kind);
    if (!set) this.handlers.set(kind, (set = new Set()));
    set.add(fn);
  }

  emit(s: Signal): void {
    const targets = [
      ...(this.handlers.get(s.kind) ?? []),
      ...(this.handlers.get('*') ?? []),
    ];
    for (const fn of targets) {
      try {
        void Promise.resolve(fn(s)).catch((e) =>
          log.error(`handler 处理 [${s.kind}] 异常`, e));
      } catch (e) {
        log.error(`handler 处理 [${s.kind}] 异常`, e);
      }
    }
  }
}
