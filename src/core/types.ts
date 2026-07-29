import type { RoomStatus } from '../sources/bili/types.js';
// 仅类型导入，编译期擦除，不构成运行时循环依赖
import type { SceneVerdict } from '../analysis/types.js';

export type SignalKind = 'live_start' | 'live_end' | 'title_change';

export interface Signal {
  source: 'live-status';
  kind: SignalKind;
  uid: string;
  roomId: string;
  ts: number;
  /** live_start / title_change 时为当前状态；live_end 时为下播前的最后已知状态 */
  status: RoomStatus;
  /** title_change 专用 */
  previousTitle?: string;
}

/** 推送用的事件载荷。analysis 层接上后 verdict 会被填充。 */
export interface LiveEvent {
  platform: 'bilibili';
  uid: string;
  roomId: string;
  uname: string;
  alias: string;
  title: string;
  areaName: string;
  parentAreaName: string;
  keyframe: string;
  cover: string;
  roomUrl: string;
  liveTime: number;
  /** M1 恒为 null；M2 接上 Analyzer 后填入判定结果。类型必须允许两者。 */
  verdict: SceneVerdict | null;
}

export function toLiveEvent(status: RoomStatus, alias: string): LiveEvent {
  return {
    platform: 'bilibili',
    uid: status.uid,
    roomId: status.roomId,
    uname: status.uname,
    alias,
    title: status.title,
    areaName: status.areaName,
    parentAreaName: status.parentAreaName,
    keyframe: status.keyframe,
    cover: status.cover,
    roomUrl: `https://live.bilibili.com/${status.roomId}`,
    liveTime: status.liveTime,
    verdict: null,
  };
}
