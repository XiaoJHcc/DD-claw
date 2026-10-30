/**
 * 时间表（过往直播统计）查询：/api/schedule 与 MCP get_schedule 共用同一实现。
 * 日界固定北京时间（UTC+8）凌晨 6 点，与主机时区无关；仅用于归属：
 * 6 点后开播算当天，6 点前开播算前一天，跨 6 点的场次整体按开播日归属。
 */
import type { Db } from '../core/db.js';
import { getRuntimeConfig } from '../core/runtime-config.js';
import { HttpError } from './http-util.js';

const DAY_SEC = 86400;

/** 日串 YYYY-MM-DD → 该日界日的起点 ts（当天北京时间 06:00）。格式/合法性错误 → 400 */
function scheduleDayStart(day: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new HttpError(400, '日期必须是 YYYY-MM-DD 格式');
  const ms = Date.parse(day + 'T06:00:00+08:00');
  if (Number.isNaN(ms)) throw new HttpError(400, `不是合法日期: ${day}`);
  return Math.floor(ms / 1000);
}

/** ts → 日界日串（scheduleDayStart 的逆运算：06:00 前归前一天）。换算 = ts+2h 的 UTC 日期 */
function scheduleDayKey(tsSec: number): string {
  return new Date((tsSec + 7200) * 1000).toISOString().slice(0, 10);
}

/** 北京时间今天（from/to 缺省值基准） */
function beijingToday(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 日串加减天数（按 UTC 正午换算，避开时区/夏令时坑） */
function addDays(day: string, n: number): string {
  return new Date(Date.parse(day + 'T12:00:00Z') + n * DAY_SEC * 1000).toISOString().slice(0, 10);
}

export function scheduleInfo(db: Db, from: string | null, to: string | null): unknown {
  const today = beijingToday();
  const fromTs = scheduleDayStart(from ?? addDays(today, -7));
  const toTs = scheduleDayStart(to ?? addDays(today, 1));
  if (fromTs > toTs) throw new HttpError(400, 'from 不能晚于 to');
  if ((toTs - fromTs) / DAY_SEC > 62) throw new HttpError(400, '查询跨度不能超过 62 天');

  // 归属天 = 真实开播时间的日界日；查询范围 = [from 日界, to 日界 + 1 天)
  const pollSec = getRuntimeConfig(db).pollIntervalSec;
  const staleSec = Math.max(600, pollSec * 2 + 60);
  const entries = db.listTimeline(fromTs, toTs + DAY_SEC, staleSec);
  // 服务在线区间独立于场次返回：前端据此给停机时段画灰底（trackedFrom 之前没有记录，
  // 不画灰，避免把功能部署前的历史误标成离线）。行窗口可越过最后一天 06:00 最多约
  // 一个日界日（axis offEnd 上限），区间多取一天，滚回过去时末行右半段也能画出灰底。
  const service = db.listServiceRuns(fromTs, toTs + 2 * DAY_SEC);
  const byDay = new Map<string, unknown[]>();
  for (const e of entries) {
    const k = scheduleDayKey(e.startTs);
    const list = byDay.get(k) ?? [];
    list.push({
      kind: 'live', // kind 预留：schedule（预告）后续加入
      roomId: e.roomId, liveTime: e.liveTime, uid: e.uid, name: e.name, face: e.face,
      startTs: e.startTs, endTs: e.endTs, keyframe: e.keyframe, cover: e.cover,
      segments: e.segments, verdicts: e.verdicts, primary: e.primary,
      classificationRuns: e.classificationRuns,
    });
    byDay.set(k, list);
  }
  // 无场次的日期也返回空 entries（前端连续渲染）
  const days: Array<{ date: string; entries: unknown[] }> = [];
  for (let d = fromTs; d <= toTs; d += DAY_SEC) {
    const date = scheduleDayKey(d);
    days.push({ date, entries: byDay.get(date) ?? [] });
  }
  return { days, service };
}
