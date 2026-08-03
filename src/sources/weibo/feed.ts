/**
 * 微博时间线源：轮询「watch=1 且绑定了 weiboUid」的主播的 myblog 列表 →
 * posts 表归档（UNIQUE(platform,item_id) 去重）→ 新帖 emit feed_post。
 * 模子同 bili/dynamic.ts；登录态心跳折进同步周期（模子同 FollowsSource）。
 *
 * posts.uid 存的是监听名单里的（B站）uid —— 面板 enrich 按它分组混排第三栏；
 * 微博 uid 只用于拉取与拼 url。
 *
 * 失败纪律：HTTP 错 / 响应结构异常（跳登录页）→ 跳过本轮保留旧数据；
 * 单 uid 连续失败到阈值发一次 health_alert，恢复复位。
 * cookie 值绝不进日志。
 */
import { makeLogger } from '../../logger.js';
import { PeriodicTask } from '../../core/scheduler.js';
import { mapLimit } from '../../core/concurrency.js';
import type { Signal } from '../../core/types.js';
import type { NewPost } from '../../core/posts.js';
import type { Source, SourceContext } from '../types.js';
import { fetchWeiboSelf, type WeiboSelfInfo } from './auth.js';
import type { FetchImpl } from './qrcode.js';

const log = makeLogger('weibo/feed');

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MYMBLOG_URL = 'https://weibo.com/ajax/statuses/mymblog';
const LONGTEXT_URL = 'https://weibo.com/ajax/statuses/longtext';
const TIMEOUT_MS = 15_000;

/** 注入点：便于单测风控/网络异常路径，生产环境用真实实现 */
export type MblogFetcher = (cookie: string, weiboUid: string) => Promise<unknown[]>;
export type LongTextFetcher = (cookie: string, mblogid: string) => Promise<string | null>;
export type WeiboSelfFetcher = (cookie: string) => Promise<WeiboSelfInfo>;

export interface WeiboFeedSourceOpts {
  /** 完整 Cookie 头（weiboCookieHeader 的产物），绝不进日志 */
  cookie: string;
  fetcher?: MblogFetcher;
  longTextFetcher?: LongTextFetcher;
  selfFetcher?: WeiboSelfFetcher;
  /** 每轮心跳拿到登录态后上报一次（无论真假），供面板展示 */
  onLoginState?: (s: WeiboSelfInfo) => void;
}

/**
 * 拉某个微博 uid 的时间线第一页（原始 list，解析在 parseMblog）。
 * HTTP 错 / 非 JSON（登录页）/ 结构异常都抛错，由上层计入失败。
 */
export async function fetchMymblog(
  cookie: string, weiboUid: string, fetchImpl: FetchImpl = fetch,
): Promise<unknown[]> {
  let res: Response;
  try {
    res = await fetchImpl(
      `${MYMBLOG_URL}?uid=${encodeURIComponent(weiboUid)}&page=1&feature=0`,
      {
        headers: {
          'User-Agent': DESKTOP_UA,
          Accept: 'application/json',
          Cookie: cookie,
          Referer: `https://weibo.com/u/${weiboUid}`,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
  } catch (e) {
    const err = e as Error;
    throw new Error(
      err.name === 'TimeoutError' || err.name === 'AbortError'
        ? `微博请求超时 (${TIMEOUT_MS}ms)`
        : `微博网络错误: ${err.message}`,
    );
  }
  if (!res.ok) throw new Error(`微博 mymblog HTTP ${res.status} ${res.statusText}`);
  let json: { ok?: number; data?: { list?: unknown[] } };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    throw new Error('微博 mymblog 响应不是合法 JSON（可能跳到了登录页）');
  }
  // 未登录/被风控时常见 ok != 1 或 data 缺失，都算结构异常，本轮跳过
  if (json.ok !== undefined && json.ok !== 1) {
    throw new Error(`微博 mymblog 返回 ok=${json.ok}（未登录或被风控）`);
  }
  if (!json.data || !Array.isArray(json.data.list)) {
    throw new Error('微博 mymblog 响应缺少 data.list（可能跳到了登录页）');
  }
  return json.data.list;
}

/** 长文补全：失败返回 null（用截断文本兜底，不算错误） */
export async function fetchLongText(
  cookie: string, mblogid: string, fetchImpl: FetchImpl = fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(`${LONGTEXT_URL}?id=${encodeURIComponent(mblogid)}`, {
      headers: { 'User-Agent': DESKTOP_UA, Cookie: cookie, Referer: 'https://weibo.com/' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { longTextContent?: string } };
    return typeof json?.data?.longTextContent === 'string' && json.data.longTextContent
      ? json.data.longTextContent
      : null;
  } catch {
    return null;
  }
}

// ---- 解析（字段路径按 2026-08-03 实测响应；类型用宽松 any 走防御式取值）----

function picsOf(m: any): string[] {
  if (!Array.isArray(m?.pics)) return [];
  return m.pics.map((p: any) => p?.large?.url ?? p?.url).filter(Boolean);
}

/** created_at 是 "Mon Aug 03 21:15:00 +0800 2026" 格式，Date.parse 可直接解析 */
function parseCreatedAt(s: unknown): number {
  const t = Date.parse(String(s ?? ''));
  return Number.isNaN(t) ? 0 : Math.floor(t / 1000);
}

/**
 * 原始 mblog → Post；缺 idstr 返回 null 跳过。
 * 转发（有 retweeted_status）拼「//转发自 @原作者: 原文」，图取原微博的；
 * 原微博已删时 retweeted_status 只剩残桩，防御式取值不炸。
 */
export function parseMblog(
  item: unknown, uid: string, weiboUid: string, longText?: string | null,
): NewPost | null {
  const it = item as any;
  const idstr = it?.idstr;
  if (!idstr) return null;
  const mblogid = it?.mblogid ?? idstr;
  const isRetweet = Boolean(it?.retweeted_status);

  let text: string | null = longText
    || (typeof it?.text_raw === 'string' && it.text_raw ? it.text_raw : null);
  let pics = picsOf(it);

  if (isRetweet) {
    const orig = it.retweeted_status;
    const origUser = orig?.user?.screen_name;
    const origText = typeof orig?.text_raw === 'string' && orig.text_raw ? orig.text_raw : null;
    const summary = origUser
      ? `//转发自 @${origUser}${origText ? ': ' + origText : ''}`
      : (origText ? `//转发：${origText}` : '');
    // 原微博已删只剩残桩时 summary 为空，不拼尾巴
    text = text ? (summary ? `${text}\n${summary}` : text) : (summary || null);
    if (pics.length === 0) pics = picsOf(orig);
  }

  return {
    platform: 'weibo',
    uid,
    itemId: String(idstr),
    type: isRetweet ? 'retweet' : 'mblog',
    text,
    pics,
    pubTs: parseCreatedAt(it?.created_at),
    url: `https://weibo.com/${weiboUid}/${mblogid}`,
    raw: JSON.stringify(item),
  };
}

/**
 * 微博时间线轮询：listStreamers → watch=1 且 weiboUid 非空 → mapLimit(2) 逐个拉
 * mymblog → 归档 posts → 新帖 emit feed_post。
 *
 * 登录态心跳折进同步周期：每轮 fetchWeiboSelf，失效发一次 health_alert 并
 * 跳过整轮抓取，恢复复位；每轮 onLoginState 上报面板（驱动微博平台状态点）。
 * 冷启动政策：每个 uid 首轮只归档不发信号（同 dynamic 的 first round）。
 */
export class WeiboFeedSource implements Source {
  readonly name = 'weibo/feed';

  private ctx?: SourceContext;
  private task?: PeriodicTask;
  /** 已成功跑过一轮的 uid（首轮静默归档，不发信号） */
  private polled = new Set<string>();
  private failures = new Map<string, number>();
  private uidAlerted = new Set<string>();
  /** 同一轮登录失效只告警一次，恢复后才复位（同 FollowsSource） */
  private loginAlerted = false;

  private readonly cookie: string;
  private readonly fetcher: MblogFetcher;
  private readonly longTextFetcher: LongTextFetcher;
  private readonly selfFetcher: WeiboSelfFetcher;
  private readonly onLoginState?: (s: WeiboSelfInfo) => void;

  constructor(opts: WeiboFeedSourceOpts) {
    this.cookie = opts.cookie;
    this.fetcher = opts.fetcher ?? fetchMymblog;
    this.longTextFetcher = opts.longTextFetcher ?? fetchLongText;
    this.selfFetcher = opts.selfFetcher ?? fetchWeiboSelf;
    this.onLoginState = opts.onLoginState;
  }

  start(ctx: SourceContext): void {
    this.bind(ctx);
    this.task = new PeriodicTask({
      name: this.name,
      intervalSec: ctx.config.weibo.intervalSec,
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
    log.info(`启动：微博时间线轮询，间隔 ${ctx.config.weibo.intervalSec}s`);
  }

  /** 拉一轮：先心跳查登录态，有效才逐 uid 归档 + 新帖发信号。 */
  async pollOnce(): Promise<void> {
    const ctx = this.ctx!;

    let self: WeiboSelfInfo;
    try {
      self = await this.selfFetcher(this.cookie);
    } catch (e) {
      // 心跳本身网络失败 ≠ cookie 失效，不告警，只跳过本轮（同 FollowsSource）
      log.error('微博登录态查询失败，跳过本轮抓取', e);
      return;
    }
    this.onLoginState?.(self);

    if (!self.loggedIn) {
      if (!this.loginAlerted) {
        this.loginAlerted = true;
        ctx.bus.emit({
          source: this.name,
          kind: 'health_alert',
          uid: '',
          roomId: '',
          ts: Math.floor(Date.now() / 1000),
          payload: {
            message: '微博登录态失效（X-Log-Uid 缺失），微博时间线已暂停。\n' +
              '请在面板重新扫码登录，或更新 weibo-cookies.json；其他功能不受影响。',
          },
        });
      }
      log.warn('微博登录态失效，跳过本轮抓取');
      return;
    }
    if (this.loginAlerted) {
      this.loginAlerted = false;
      log.info('微博登录态已恢复，继续抓取');
    }

    const targets = ctx.db.listStreamers().filter((s) => s.watch && s.weiboUid);
    await mapLimit(targets, 2, async (s) => {
      await this.pollStreamer(s.uid, s.weiboUid!);
    });
  }

  private async pollStreamer(uid: string, weiboUid: string): Promise<void> {
    const ctx = this.ctx!;
    let items: unknown[];
    try {
      items = await this.fetcher(this.cookie, weiboUid);
    } catch (e) {
      // 关键：拉取失败绝不当成「没微博」—— 保留旧数据，什么都不写
      log.error(`微博时间线拉取失败 uid=${uid}（微博 ${weiboUid}），保留旧数据`, e);
      this.onFailure(uid, e);
      return;
    }
    this.onSuccess(uid);

    const posts: NewPost[] = [];
    for (const item of items) {
      const it = item as any;
      // isLongText 长文补全；失败用截断文本兜底，不算错误
      let longText: string | null = null;
      if (it?.isLongText && it?.mblogid) {
        try {
          longText = await this.longTextFetcher(this.cookie, String(it.mblogid));
        } catch {
          longText = null; // 真实实现本身不抛，这里防注入实现/意外
        }
      }
      const p = parseMblog(item, uid, weiboUid, longText);
      if (p) posts.push(p);
    }
    const inserted = ctx.db.insertPosts(posts);
    const firstRound = !this.polled.has(uid);
    this.polled.add(uid);

    if (firstRound) {
      log.info(`uid=${uid} 首轮归档 ${inserted.length} 条微博（静默，不发信号）`);
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
    if (inserted.length > 0) log.info(`uid=${uid} 新微博 ${inserted.length} 条`);
  }

  private onSuccess(uid: string): void {
    const n = this.failures.get(uid) ?? 0;
    if (n > 0) log.info(`uid=${uid} 微博时间线拉取恢复正常（此前连续失败 ${n} 次）`);
    this.failures.delete(uid);
    this.uidAlerted.delete(uid);
  }

  private onFailure(uid: string, err: unknown): void {
    const n = (this.failures.get(uid) ?? 0) + 1;
    this.failures.set(uid, n);
    const threshold = this.ctx!.config.healthAlertAfterFailures;
    if (n >= threshold && !this.uidAlerted.has(uid)) {
      this.uidAlerted.add(uid); // 同一轮故障只告警一次，恢复后才复位
      this.ctx!.bus.emit({
        source: this.name,
        kind: 'health_alert',
        uid,
        roomId: '',
        ts: Math.floor(Date.now() / 1000),
        payload: {
          message: `微博时间线拉取连续失败 ${n} 次（uid=${uid}），该对象本轮已暂停。\n` +
            '多为登录态失效或被风控，恢复后自动继续。',
          failures: n,
          lastError: String(err),
        },
      });
    }
  }
}
