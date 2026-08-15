import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeLogger } from '../../logger.js';
import { mapLimit } from '../../core/concurrency.js';
import type { Db } from '../../core/db.js';

const log = makeLogger('media/keyframe');

/** B站图床要 UA + Referer，否则 403（同 notify/image-cache） */
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Referer: 'https://live.bilibili.com/',
};
/** 单帧体积上限（防御，超出放弃——正常关键帧只有几百 KB） */
const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 8000;

/** 一轮轮询里在播场次的关键帧信息（live-status source 现成数据） */
export interface LiveKeyframe {
  roomId: string;
  liveTime: number;
  keyframe: string;
}

export interface KeyframeCacheOpts {
  /** 落盘根目录：<dir>/<roomId>/<liveTime>/<ts>.jpg */
  dir: string;
  /** 同一场直播两帧的最小间隔（失败也记尝试时间，不做每轮重试轰炸） */
  intervalMs: number;
  fetchImpl?: typeof fetch;
  /** 毫秒时钟（测试注入） */
  now?: () => number;
  concurrency?: number;
}

/**
 * 在播直播间关键帧定时本地缓存：每 interval 对在播房间落地一帧 + snapshots 表一行，
 * 积累判定素材（供后续人工/LLM 对照分类正确性）。暂不清理，体积用户已接受。
 *
 * consider() 同步返回、内部异步执行，绝不阻塞轮询循环；任何失败仅 log.debug，
 * 不影响任何其他流程。内容按 md5 去重（B站关键帧刷新慢于缓存间隔时避免重复文件；
 * URL 是否随内容变不确定，所以按内容哈希判，不按 URL）。
 */
export class KeyframeCache {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly concurrency: number;
  /** (roomId:liveTime) → 上次尝试时间（ms；失败也记） */
  private readonly lastAttempt = new Map<string, number>();
  /** (roomId:liveTime) → 上一帧内容 md5（内容去重） */
  private readonly lastHash = new Map<string, string>();
  /** 在飞任务链：consider 把每轮下载接在链尾；测试用 drain() 排空 */
  private pending: Promise<unknown> = Promise.resolve();
  /** 总开关（settings 唯一信源，configure 热生效）；false 时 consider 直接 no-op */
  private enabled = true;

  constructor(private readonly db: Db, private readonly opts: KeyframeCacheOpts) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
    this.concurrency = opts.concurrency ?? 2;
  }

  /**
   * 热更新开关/间隔（面板监听卡「抓取设置」保存回调）。关闭只是 consider no-op——
   * 去重/间隔记忆保留，重新开启时按既有记忆继续，不炸量补帧。
   */
  configure(o: { enabled: boolean; intervalMs: number }): void {
    this.enabled = o.enabled;
    this.opts.intervalMs = o.intervalMs;
  }

  /** 每轮轮询调用：筛出到期的在播场次，异步下载落盘。同步返回，绝不 await。 */
  consider(live: LiveKeyframe[]): void {
    if (!this.enabled) return;
    const t = this.now();
    const due: LiveKeyframe[] = [];
    const seen = new Set<string>();
    for (const e of live) {
      const key = `${e.roomId}:${e.liveTime}`;
      seen.add(key);
      if (!e.keyframe) continue;
      const last = this.lastAttempt.get(key);
      if (last !== undefined && t - last < this.opts.intervalMs) continue;
      this.lastAttempt.set(key, t); // 先记尝试时间：失败也不在 interval 内重试
      due.push(e);
    }
    // 已下播的场次清出内存表（跨场次无限积累会缓慢涨内存；同一场短暂掉线
    // 又回来的代价只是多存一帧，可接受）
    for (const key of this.lastAttempt.keys()) {
      if (!seen.has(key)) { this.lastAttempt.delete(key); this.lastHash.delete(key); }
    }
    if (due.length === 0) return;
    this.pending = this.pending.then(() =>
      mapLimit(due, this.concurrency, (e) => this.capture(e)),
    );
  }

  /** 测试用：等待已派发的下载全部完成。生产代码不得调用（consider 语义是不阻塞）。 */
  async drain(): Promise<void> {
    await this.pending;
  }

  private async capture(e: LiveKeyframe): Promise<void> {
    const key = `${e.roomId}:${e.liveTime}`;
    try {
      const res = await this.fetchImpl(e.keyframe, {
        headers: HEADERS,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        log.debug(`关键帧下载 HTTP ${res.status}（${e.roomId}/${e.liveTime}），本轮放弃`);
        return;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_BYTES) {
        log.debug(`关键帧体积异常（${buf.length}B，${e.roomId}/${e.liveTime}），本轮放弃`);
        return;
      }
      const hash = createHash('md5').update(buf).digest('hex');
      if (this.lastHash.get(key) === hash) return; // 内容没变，直接丢弃不写盘
      const ext = (res.headers.get('content-type') ?? '').includes('png') ? '.png' : '.jpg';
      const ts = Math.floor(this.now() / 1000);
      // 库内 path 存相对 <dir> 的路径（换机/移动目录后仍可解析），落盘拼绝对路径
      const rel = join(e.roomId, String(e.liveTime), ts + ext);
      const file = join(this.opts.dir, rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, buf);
      this.lastHash.set(key, hash);
      this.db.insertSnapshot({ roomId: e.roomId, liveTime: e.liveTime, ts, path: rel, bytes: buf.length });
    } catch (err) {
      log.debug(`关键帧缓存失败（${e.roomId}/${e.liveTime}）: ${(err as Error).message}`);
    }
  }
}
