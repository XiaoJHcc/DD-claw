import type { LiveStatus, Signal } from './types.js';

/** 上一次已知状态。从 DB 恢复或由上一轮轮询产生。 */
export interface PrevState {
  roomId: string;
  isLive: boolean;
  liveTime: number;
  title: string;
  // 以下为展示用字段：随状态持久化供面板展示实况，diffRoom 不读，
  // diff 仍只看 roomId / isLive / liveTime / title
  areaName: string;
  parentAreaName: string;
  keyframe: string;
  cover: string;
  online: number;
  face: string;
}

export interface DiffOptions {
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
 * - 无 prev（冷启动/新增订阅）且在播也如实产 live_start —— 本函数不做
 *   任何政策判断，「首次运行不刷屏/新增订阅要通知」由 source 打 coldStart
 *   标记、pipeline 按配置抑制。
 */
export function diffRoom(
  uid: string,
  prev: PrevState | undefined,
  curr: LiveStatus | null,
  opts: DiffOptions = {},
): Signal[] {
  const ts = opts.now ?? Math.floor(Date.now() / 1000);
  const signals: Signal[] = [];

  // 本轮没有这个 uid 或未开播
  if (curr === null || !curr.isLive) {
    if (prev?.isLive) {
      signals.push({
        source: 'bili/live-status',
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

  // 无 prev：冷启动或新增订阅，如实产 live_start（是否通知由 pipeline 决定）
  if (!prev) {
    signals.push({ source: 'bili/live-status', kind: 'live_start', uid: curr.uid, roomId: curr.roomId, ts, status: curr });
    return signals;
  }

  // 之前未开播 → 现在直播中
  if (!prev.isLive) {
    signals.push({ source: 'bili/live-status', kind: 'live_start', uid: curr.uid, roomId: curr.roomId, ts, status: curr });
    return signals;
  }

  // 之前也在直播：liveTime 变了说明下播又开播（中间可能被我们漏观测）
  if (prev.liveTime !== curr.liveTime) {
    signals.push({ source: 'bili/live-status', kind: 'live_end', uid: curr.uid, roomId: prev.roomId, ts, status: curr });
    signals.push({ source: 'bili/live-status', kind: 'live_start', uid: curr.uid, roomId: curr.roomId, ts, status: curr });
    return signals;
  }

  // 同一场直播中，标题变了
  if (prev.title !== curr.title) {
    signals.push({
      source: 'bili/live-status',
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

function synthesizeOffline(uid: string, prev: PrevState): LiveStatus {
  return {
    uid,
    roomId: prev.roomId,
    uname: '',
    title: prev.title,
    isLive: false,
    liveTime: 0,
    areaName: '',
    parentAreaName: '',
    cover: '',
    keyframe: '',
  };
}

export function toPrevState(s: LiveStatus): PrevState {
  return {
    roomId: s.roomId, isLive: s.isLive, liveTime: s.liveTime, title: s.title,
    areaName: s.areaName ?? '', parentAreaName: s.parentAreaName ?? '',
    keyframe: s.keyframe ?? '', cover: s.cover ?? '',
    online: s.online ?? 0, face: s.face ?? '',
  };
}
