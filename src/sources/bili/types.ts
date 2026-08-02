/** live_status: 0 未开播 / 1 直播中 / 2 轮播中（轮播视为未开播） */
export type LiveStatusCode = 0 | 1 | 2;

/** get_status_info_by_uids 返回的单条原始数据（只声明我们用到的字段） */
export interface RawRoomStatus {
  uid: number;
  room_id: number;
  title: string;
  live_status: number;
  live_time: number;
  area_v2_name?: string;
  area_v2_parent_name?: string;
  uname: string;
  face?: string;
  cover_from_user?: string;
  keyframe?: string;
  online?: number;
}

export interface BiliApiEnvelope<T> {
  code: number;
  message?: string;
  msg?: string;
  data: T;
}

import type { LiveStatus } from '../../core/types.js';

/** 归一化后的房间状态：core 的 LiveStatus + bili 特有的原始状态码 */
export interface RoomStatus extends LiveStatus {
  /** 已把轮播(2)折叠为未开播语义（isLive），原始值在此 */
  rawLiveStatus: number;
}

export function normalizeRoomStatus(raw: RawRoomStatus): RoomStatus {
  return {
    uid: String(raw.uid),
    roomId: String(raw.room_id),
    uname: raw.uname ?? '',
    title: raw.title ?? '',
    isLive: raw.live_status === 1,
    rawLiveStatus: raw.live_status,
    liveTime: raw.live_status === 1 ? (raw.live_time ?? 0) : 0,
    areaName: raw.area_v2_name ?? '',
    parentAreaName: raw.area_v2_parent_name ?? '',
    cover: raw.cover_from_user ?? '',
    keyframe: raw.keyframe ?? '',
    face: raw.face ?? '',
    online: raw.online ?? 0,
  };
}
