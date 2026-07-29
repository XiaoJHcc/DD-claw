import type { LiveEvent } from '../core/types.js';

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
  send(event: LiveEvent): Promise<NotifyResult[]>;
  /** 监听自身失效时的告警通道。Toast 靠它在 NapCat 挂掉时通知用户 */
  alert?(title: string, body: string): Promise<void>;
}

export function formatEventText(e: LiveEvent): string {
  const who = e.alias || e.uname;
  const area = e.parentAreaName && e.areaName
    ? `${e.parentAreaName} / ${e.areaName}`
    : e.areaName || e.parentAreaName || '未知分区';
  const when = e.liveTime > 0
    ? new Date(e.liveTime * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : '';
  return [
    `🔴 ${who} 开播了`,
    e.title,
    area + (when ? `  ·  ${when} 开播` : ''),
  ].join('\n');
}
