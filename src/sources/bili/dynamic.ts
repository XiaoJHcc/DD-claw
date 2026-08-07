import { makeLogger } from '../../logger.js';
import { PeriodicTask } from '../../core/scheduler.js';
import { mapLimit } from '../../core/concurrency.js';
import type { Signal } from '../../core/types.js';
import type { NewPost } from '../../core/posts.js';
import type { Source, SourceContext } from '../types.js';
import { BiliApiError, biliRequest, type BiliRequestFn } from './client.js';
import { fetchSelf, type SelfInfo } from './auth.js';
import { dmQueryParams } from './dm.js';

const log = makeLogger('bili/dynamic');

const FEED_SPACE_URL = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space';
/** 实测配方（2026-08-03）：全量 cookie + dm 三参 + Referer，无需 WBI 签名 */
const FEATURES = 'itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote';

/** 注入点：便于单测风控/网络异常路径，生产环境用真实实现。返回原始 items */
export type DynamicFetcher = (cookie: string, uid: string) => Promise<unknown[]>;
export type DynamicSelfFetcher = (cookie: string) => Promise<SelfInfo>;

export interface DynamicSourceOpts {
  /** 完整 Cookie 头（cookieHeader 的产物），绝不进日志 */
  cookie: string;
  fetcher?: DynamicFetcher;
  selfFetcher?: DynamicSelfFetcher;
  /** 每轮心跳拿到 self 后上报一次（无论 isLogin 真假），供面板展示登录态 */
  onLoginState?: (s: SelfInfo) => void;
}

interface FeedSpaceData {
  items?: unknown[];
}

/**
 * 拉某个 uid 的空间动态列表（原始 items，解析在 parseDynamicItem）。
 * HTTP 错 / 非 JSON（412 风控页）/ code != 0（含 -352）都抛错，由上层计入失败。
 */
export async function fetchDynamics(
  cookie: string, uid: string, req: BiliRequestFn = biliRequest,
): Promise<unknown[]> {
  const url = FEED_SPACE_URL +
    '?offset=&host_mid=' + encodeURIComponent(uid) +
    '&platform=web&features=' + encodeURIComponent(FEATURES) +
    '&' + dmQueryParams();
  const data = await req<FeedSpaceData>(url, {
    cookie,
    referer: `https://space.bilibili.com/${uid}/`,
  });
  return Array.isArray(data?.items) ? data.items : [];
}

// ---- 解析（RSSHub getDes/getImgs 字段路径的子集，类型用宽松 any 走防御式取值）----

const dig = (o: any, ...path: string[]): any =>
  path.reduce((acc, k) => (acc == null ? undefined : acc[k]), o);

function picsOf(dyn: any): string[] {
  const major = dig(dyn, 'modules', 'module_dynamic', 'major');
  if (!major) return [];
  if (Array.isArray(major.opus?.pics)) {
    return major.opus.pics.map((p: any) => p?.url).filter(Boolean);
  }
  if (Array.isArray(major.draw?.items)) {
    return major.draw.items.map((p: any) => p?.src).filter(Boolean);
  }
  if (major.type === 'MAJOR_TYPE_LIVE_RCMD') {
    const info = livePlayInfo(major);
    return info?.cover ? [info.cover] : [];
  }
  if (major.archive?.cover) return [major.archive.cover];
  return [];
}

/** live_rcmd.content 是需要二次 JSON.parse 的字符串，内含 live_play_info */
function livePlayInfo(major: any): any {
  try {
    const content = JSON.parse(String(major?.live_rcmd?.content ?? '{}'));
    return content?.live_play_info ?? null;
  } catch {
    return null;
  }
}

function textOf(dyn: any): string | null {
  const md = dig(dyn, 'modules', 'module_dynamic');
  const desc = md?.desc?.text;
  if (typeof desc === 'string' && desc) return desc;
  const opus = md?.major?.opus?.summary?.text;
  if (typeof opus === 'string' && opus) return opus;
  const major = md?.major;
  if (major?.type === 'MAJOR_TYPE_LIVE_RCMD') {
    const info = livePlayInfo(major);
    if (info?.title) return String(info.title);
  }
  const archive = major?.archive;
  if (archive?.title) {
    // AV 投稿：标题 + 简介截断，够卡片展示
    const d = typeof archive.desc === 'string' ? archive.desc.slice(0, 100) : '';
    return d ? `${archive.title}\n${d}` : String(archive.title);
  }
  return null;
}

/**
 * 原始 item → Post；无法识别（缺 id_str 等）返回 null 跳过。
 * 转发（DYNAMIC_TYPE_FORWARD）拼「//转发自 @原作者: 原摘要」，图取原动态的。
 */
export function parseDynamicItem(item: unknown, uid: string): NewPost | null {
  const it = item as any;
  const idStr = it?.id_str;
  if (!idStr || typeof it?.type !== 'string') return null;
  const pubTs = Number(dig(it, 'modules', 'module_author', 'pub_ts')) || 0;

  let text = textOf(it);
  let pics = picsOf(it);

  if (it.type === 'DYNAMIC_TYPE_FORWARD' && it.orig) {
    const origAuthor = dig(it.orig, 'modules', 'module_author', 'name');
    const origText = textOf(it.orig) ?? dig(it.orig, 'modules', 'module_dynamic', 'desc', 'text');
    const summary = origAuthor
      ? `//转发自 @${origAuthor}${origText ? ': ' + origText : ''}`
      : (origText ? `//转发：${origText}` : '');
    text = text ? `${text}\n${summary}` : (summary || null);
    if (pics.length === 0) pics = picsOf(it.orig);
  }

  return {
    platform: 'bili_dynamic',
    uid,
    itemId: String(idStr),
    type: it.type,
    text,
    pics,
    pubTs,
    url: `https://t.bilibili.com/${idStr}`,
    raw: JSON.stringify(item),
  };
}

/**
 * 空间动态轮询：listWatchedUids → mapLimit(2) 逐个拉 feed/space → 归档 posts
 * （INSERT OR IGNORE，去重只靠 (platform, item_id) UNIQUE）→ 新帖 emit feed_post。
 *
 * 登录态心跳折进轮询周期（模子同 FollowsSource / WeiboFeedSource）：每轮先 fetchSelf，
 * 失效发一次 health_alert 并跳过本轮，恢复复位；每轮 onLoginState 上报面板
 * （follows.enabled=false 时这是 B站登录态唯一的心跳来源）。
 * 冷启动政策：每个 uid 首轮只归档不发信号（政策同 live-status 的 first_run）。
 * 失败纪律：拉取失败绝不当成「没动态」——本轮跳过、旧数据不动；
 * 同一 uid 连续失败到阈值发一次 health_alert，恢复复位（live-status 模式）。
 * 无 cookie 不启动（装配处判断），扫码登录后随 follows 热重启。
 */
export class DynamicSource implements Source {
  readonly name = 'bili/dynamic';

  private ctx?: SourceContext;
  private task?: PeriodicTask;
  /** 已成功跑过一轮的 uid（首轮静默归档，不发信号） */
  private polled = new Set<string>();
  private failures = new Map<string, number>();
  private alerted = new Set<string>();
  /** 同一轮登录失效只告警一次，恢复后才复位（同 FollowsSource） */
  private loginAlerted = false;

  private readonly cookie: string;
  private readonly fetcher: DynamicFetcher;
  private readonly selfFetcher: DynamicSelfFetcher;
  private readonly onLoginState?: (s: SelfInfo) => void;

  constructor(opts: DynamicSourceOpts) {
    this.cookie = opts.cookie;
    this.fetcher = opts.fetcher ?? fetchDynamics;
    this.selfFetcher = opts.selfFetcher ?? fetchSelf;
    this.onLoginState = opts.onLoginState;
  }

  start(ctx: SourceContext): void {
    this.bind(ctx);
    this.task = new PeriodicTask({
      name: this.name,
      intervalSec: ctx.config.dynamic.intervalSec,
      jitterSec: ctx.config.pollJitterSec,
      run: async () => { await this.pollOnce(); },
    });
    this.task.start();
  }

  stop(): void {
    this.task?.stop();
  }

  /** start 中除周期调度外的部分。测试可 bind 后直接驱动 pollOnce。 */
  bind(ctx: SourceContext): void {
    this.ctx = ctx;
    log.info(`启动：空间动态轮询，间隔 ${ctx.config.dynamic.intervalSec}s`);
  }

  /** 拉一轮：先心跳查登录态，有效才逐 uid 归档 + 新帖发信号。单 uid 失败不影响其他 uid。 */
  async pollOnce(): Promise<void> {
    const ctx = this.ctx!;

    let self: SelfInfo;
    try {
      self = await this.selfFetcher(this.cookie);
    } catch (e) {
      // 心跳本身网络失败 ≠ cookie 失效，不告警，只跳过本轮（同 FollowsSource）
      log.error('登录态查询失败，跳过本轮抓取', e);
      return;
    }
    this.onLoginState?.(self);

    if (!self.isLogin) {
      if (!this.loginAlerted) {
        this.loginAlerted = true;
        ctx.bus.emit({
          source: this.name,
          kind: 'health_alert',
          uid: '',
          roomId: '',
          ts: Math.floor(Date.now() / 1000),
          payload: {
            message: 'B站 cookie 已失效或未登录（isLogin=false），空间动态抓取已暂停。\n' +
              '请在面板重新扫码登录，或更新 cookies.json；匿名开播监听不受影响。',
          },
        });
      }
      log.warn('cookie 失效或未登录，跳过本轮抓取');
      return;
    }
    if (this.loginAlerted) {
      this.loginAlerted = false;
      log.info('登录态已恢复，继续抓取');
    }

    const uids = ctx.db.listWatchedUids();
    await mapLimit(uids, 2, async (uid) => {
      await this.pollUid(uid);
    });
  }

  private async pollUid(uid: string): Promise<void> {
    const ctx = this.ctx!;
    let items: unknown[];
    try {
      items = await this.fetcher(this.cookie, uid);
    } catch (e) {
      // 关键：拉取失败绝不当成「没动态」—— 保留旧数据，什么都不写
      const kind = e instanceof BiliApiError ? '业务层' : 'HTTP层';
      log.error(`${kind}拉取失败 uid=${uid}，保留旧数据`, e);
      this.onFailure(uid, e);
      return;
    }
    this.onSuccess(uid);

    const posts = items
      .map((it) => parseDynamicItem(it, uid))
      .filter((p): p is NewPost => p !== null);
    const inserted = ctx.db.insertPosts(posts);
    const firstRound = !this.polled.has(uid);
    this.polled.add(uid);

    if (firstRound) {
      log.info(`uid=${uid} 首轮归档 ${inserted.length} 条动态（静默，不发信号）`);
      return;
    }
    for (const i of inserted) {
      const p = posts[i]!;
      const sig: Signal = {
        source: this.name,
        kind: 'feed_post',
        uid,
        roomId: '',
        ts: Math.floor(Date.now() / 1000),
        payload: {
          platform: p.platform, itemId: p.itemId, type: p.type,
          text: p.text, pics: p.pics, pubTs: p.pubTs, url: p.url,
        },
      };
      ctx.bus.emit(sig);
    }
    if (inserted.length > 0) log.info(`uid=${uid} 新动态 ${inserted.length} 条`);
  }

  private onSuccess(uid: string): void {
    const n = this.failures.get(uid) ?? 0;
    if (n > 0) log.info(`uid=${uid} 动态拉取恢复正常（此前连续失败 ${n} 次）`);
    this.failures.delete(uid);
    this.alerted.delete(uid);
  }

  private onFailure(uid: string, err: unknown): void {
    const n = (this.failures.get(uid) ?? 0) + 1;
    this.failures.set(uid, n);
    const threshold = this.ctx!.config.healthAlertAfterFailures;
    if (n >= threshold && !this.alerted.has(uid)) {
      this.alerted.add(uid); // 同一轮故障只告警一次，恢复后才复位
      this.ctx!.bus.emit({
        source: this.name,
        kind: 'health_alert',
        uid,
        roomId: '',
        ts: Math.floor(Date.now() / 1000),
        payload: {
          message: `B站动态拉取连续失败 ${n} 次（uid=${uid}），动态源已暂停该对象本轮。\n` +
            `多为风控（412/-352）或 cookie 失效，恢复后自动继续。`,
          failures: n,
          lastError: String(err),
        },
      });
    }
  }
}
