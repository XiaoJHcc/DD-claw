import { biliRequest } from './client.js';
import { normalizeRoomStatus, type RawRoomStatus, type RoomStatus } from './types.js';
import { makeLogger } from '../../logger.js';

const log = makeLogger('bili/live-status');

const ENDPOINT = 'https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids';

/**
 * 单次请求携带的 uid 上限。B站对数组长度的实际上限未公开验证过，
 * 取一个保守值分片，避免订阅变多后整批被截断或拒绝。
 */
const CHUNK_SIZE = 50;

/**
 * 批量查询开播状态。一次请求覆盖全部订阅，匿名可用。
 *
 * 返回的 Map 以 uid 为 key。注意：**未开播的主播可能整个 key 都不存在**，
 * 所以不能假设请求 N 个就回 N 条 —— 缺失的 uid 由调用方按「未开播」处理，
 * 而不是当作拉取失败。
 */
export async function fetchLiveStatus(uids: string[]): Promise<Map<string, RoomStatus>> {
  const out = new Map<string, RoomStatus>();
  if (uids.length === 0) return out;

  for (let i = 0; i < uids.length; i += CHUNK_SIZE) {
    const chunk = uids.slice(i, i + CHUNK_SIZE);
    // 用 POST，避免订阅列表长了以后 uids[]=a&uids[]=b... 把 URL 撑爆
    const data = await biliRequest<Record<string, RawRoomStatus> | null>(ENDPOINT, {
      method: 'POST',
      body: { uids: chunk.map(Number) },
    });

    if (!data || typeof data !== 'object') {
      log.warn(`分片 ${i / CHUNK_SIZE + 1} 的 data 为空或非对象，该片视为全部未开播`);
      continue;
    }
    for (const [uid, raw] of Object.entries(data)) {
      if (!raw || typeof raw !== 'object') continue;
      out.set(uid, normalizeRoomStatus(raw));
    }
  }

  const missing = uids.filter((u) => !out.has(u));
  if (missing.length > 0) {
    log.debug(`返回中缺失 ${missing.length} 个 uid（按未开播处理）`, missing.join(','));
  }
  return out;
}
