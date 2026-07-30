import type { PushMessage } from '../core/types.js';

export interface NotifyResult {
  ok: boolean;
  error?: string;
  /** 网络类失败可重试；配置错、目标不存在这类不重试 */
  retryable?: boolean;
  /** 用于 notify_log，区分同一通道的多个目标 */
  target?: string;
}

export interface Notifier {
  readonly name: string;
  readonly capabilities: {
    /** 能否带图。不能带图的通道由 dispatcher 裁剪 payload */
    image: boolean;
    clickThrough: boolean;
  };
  send(msg: PushMessage): Promise<NotifyResult[]>;
  /** 监听自身失效时的告警通道。Toast 靠它在 NapCat 挂掉时通知用户 */
  alert?(title: string, body: string): Promise<void>;
}
