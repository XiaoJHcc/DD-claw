import type { RoomStatus } from '../sources/bili/types.js';
import type { Signal } from './types.js';

/** 上一次已知状态。从 DB 恢复或由上一轮轮询产生。 */
export interface PrevState {
  roomId: string;
  isLive: boolean;
  liveTime: number;
  title: string;
}

export interface DiffOptions {
  /**
   * 无 prev（冷启动或新增订阅）且当前已在直播时，是否产出 live_start。
   * 「是首次运行还是新增订阅」的政策判断由调用方做，这里只接受结果，
   * 保持本函数是纯函数。
   */
  notifyOnColdStart: boolean;
  /** 事件时间戳，便于测试注入 */
  now?: number;
}

/**
 * 对比前后状态产出 Signal。纯函数，无 IO，可完整单测。
 *
 * 关键约定：
 * - curr 为 null 表示「本轮返回里没有这个 uid」→ 按未开播处理。
 *   注意这与「拉取失败」不同 —— 拉取失败时调用方根本不该调本函数。
 * - 一场直播的身份是 liveTime（服务端给的开播时间戳）。
 *   liveTime 变了就是新的一场，即使中间我们没观测到下播。
 */
export function diffRoom(
  uid: string,
  prev: PrevState | undefined,
  curr: RoomStatus | null,
  opts: DiffOptions,
): Signal[] {
  const ts = opts.now ?? Math.floor(Date.now() / 1000);
  const signals: Signal[] = [];

  // 本轮没有这个 uid 或未开播
  if (curr === null || !curr.isLive) {
    if (prev?.isLive) {
      signals.push({
        source: 'live-status',
        kind: 'live_end',
        uid,
        roomId: prev.roomId,
        ts,
        // 返回里缺该 uid 时没有 curr，用 prev 合成一个。uid 必须显式传入，
        // 否则 signal 无法自证属于谁（多主播下会串）。
        status: curr ?? synthesizeOffline(uid, prev),
      });
    }
    return signals;
  }

  // 无 prev：冷启动或新增订阅
  if (!prev) {
    if (opts.notifyOnColdStart) {
      signals.push({ source: 'live-status', kind: 'live_start', uid: curr.uid, roomId: curr.roomId, ts, status: curr });
    }
    return signals;
  }

  // 之前未开播 → 现在直播中
  if (!prev.isLive) {
    signals.push({ source: 'live-status', kind: 'live_start', uid: curr.uid, roomId: curr.roomId, ts, status: curr });
    return signals;
  }

  // 之前也在直播：liveTime 变了说明下播又开播（中间可能被我们漏观测）
  if (prev.liveTime !== curr.liveTime) {
    signals.push({ source: 'live-status', kind: 'live_end', uid: curr.uid, roomId: prev.roomId, ts, status: curr });
    signals.push({ source: 'live-status', kind: 'live_start', uid: curr.uid, roomId: curr.roomId, ts, status: curr });
    return signals;
  }

  // 同一场直播中，标题变了
  if (prev.title !== curr.title) {
    signals.push({
      source: 'live-status',
      kind: 'title_change',
      uid: curr.uid,
      roomId: curr.roomId,
      ts,
      status: curr,
      previousTitle: prev.title,
    });
  }
  return signals;
}

function synthesizeOffline(uid: string, prev: PrevState): RoomStatus {
  return {
    uid,
    roomId: prev.roomId,
    uname: '',
    title: prev.title,
    isLive: false,
    rawLiveStatus: 0,
    liveTime: 0,
    areaName: '',
    parentAreaName: '',
    cover: '',
    keyframe: '',
  };
}

export function toPrevState(s: RoomStatus): PrevState {
  return { roomId: s.roomId, isLive: s.isLive, liveTime: s.liveTime, title: s.title };
}
