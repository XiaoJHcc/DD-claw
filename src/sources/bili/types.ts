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

/** 归一化后的房间状态 */
export interface RoomStatus {
  uid: string;
  roomId: string;
  uname: string;
  title: string;
  /** 已把轮播(2)折叠为未开播语义，原始值见 rawLiveStatus */
  isLive: boolean;
  rawLiveStatus: number;
  /** 本场开播时间戳（秒）。未开播时为 0 */
  liveTime: number;
  areaName: string;
  parentAreaName: string;
  cover: string;
  keyframe: string;
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
  };
}
