import type { LiveEvent, PushMessage } from '../core/types.js';

/**
 * LiveEvent → 推送层通用载荷。notify 各通道只认识 PushMessage。
 * 文案沿用 M1：who 开播了 / 标题（不用 emoji：QQ iOS 气泡渲染器会把增补平面
 * emoji 拆成两个方框）；分区 · 开播时间放 attribution（toast 的小灰字行，
 * onebot 拼进正文第三行）；头像进 icon（刚开播还没有关键帧，用头像保证通知有图）。
 */
export function liveEventToMessage(e: LiveEvent): PushMessage {
  const who = e.alias || e.uname;
  const area = e.parentAreaName && e.areaName
    ? `${e.parentAreaName} / ${e.areaName}`
    : e.areaName || e.parentAreaName || '未知分区';
  const when = e.liveTime > 0
    ? new Date(e.liveTime * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : '';
  return {
    title: `${who} 开播了`,
    body: e.title,
    image: e.keyframe || undefined,
    icon: e.face || undefined,
    attribution: area + (when ? `  ·  ${when} 开播` : ''),
    url: e.roomUrl,
    priority: 'normal',
    ref: { roomId: e.roomId, liveTime: e.liveTime },
  };
}
