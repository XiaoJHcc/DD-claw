/**
 * 微博时间线源：轮询 weibo_accounts 里 enabled 的账号的 myblog 列表 →
 * posts 归档（UNIQUE(platform,item_id) 去重）→ 新帖 emit feed_post。
 * 模子同 twitter/feed.ts（X 是第一个独立图文来源，微博 2026-09 与它同构）。
 *
 * **与 X 的关键差异**：微博有登录态（全站共用一份 weibo-cookies），所以「心跳」是
 * `fetchWeiboSelf` 查登录态，而不是 X 那样的代理/实例可用性；登录态运行中失效要告警。
 *
 * `posts.uid` 存**微博账号自身的 uid**（与 twitter 存 screen name 同语义：帖子归属 =
 * 被抓账号自身）。「这条微博属于哪个 B站主播」由 `weibo_accounts.bili_uid` 这条可选关联
 * 反查（面板 enrich 走 `db.listRecentPostsMixed`），所以主播卡第三栏混排行为不变。
 *
 * 失败纪律：HTTP 错 / 响应结构异常（跳登录页）→ 跳过本轮保留旧数据；
 * 单账号连续失败到阈值发一次 health_alert，持续失败超阈值再报一次，恢复复位。
 * cookie 值绝不进日志。
 */
import { makeLogger } from '../../logger.js';
import { PeriodicTask } from '../../core/scheduler.js';
import { mapLimit } from '../../core/concurrency.js';
import type { Signal } from '../../core/types.js';
import { STREAK_QQ_ALERT_AFTER_SEC } from '../../core/types.js';
import type { NewPost } from '../../core/posts.js';
import { pickBacklogPush, roundKind } from '../../core/backlog.js';
import { getPostBacklogConfig } from '../../core/runtime-config.js';
import type { WeiboAccount } from '../../core/weibo-accounts.js';
import { emptyWeiboFeedSnapshot, type WeiboFeedSnapshot } from '../../core/weibo-accounts.js';
import type { Source, SourceContext } from '../types.js';
import { fetchWeiboSelf, type WeiboSelfInfo } from './auth.js';
import type { FetchImpl } from './qrcode.js';
import { cacheWeiboAvatar } from './avatar.js';

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
  /** 头像本地缓存目录（cache/weibo-avatars）；不注入则只抠 URL 不落盘 */
  avatarCacheDir?: string;
  /** 头像落盘注入点（单测用；默认 cacheWeiboAvatar 直连下载，微博图床无需代理） */
  avatarSaver?: (url: string, dir: string) => Promise<string | null>;
  /** 每轮回写运行状态快照（装配处持有；面板当前不展示它，但它是「抓不到 vs 没新帖」的可观测证据） */
  onStatus?: (s: WeiboFeedSnapshot) => void;
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
  // 老字段 pics 数组优先（部分响应形态仍有）；mymblog 实测（2026-09-20）图片在
  // pic_infos（按 pic_id 键控的对象，thumbnail/bmiddle/large 三档），顺序按 pic_ids（对象键序不保证）
  if (Array.isArray(m?.pics) && m.pics.length > 0) {
    return m.pics.map((p: any) => p?.large?.url ?? p?.url).filter(Boolean);
  }
  const infos = m?.pic_infos;
  if (!infos || typeof infos !== 'object') return [];
  const ids: string[] = Array.isArray(m?.pic_ids) && m.pic_ids.length > 0 ? m.pic_ids : Object.keys(infos);
  const out: string[] = [];
  for (const id of ids) {
    const info = (infos as Record<string, any>)[id];
    const url = info?.large?.url ?? info?.bmiddle?.url ?? info?.thumbnail?.url;
    if (typeof url === 'string' && url) out.push(url);
  }
  return out;
}

/** 头像（顺手抠，落盘在 feed 里做）：优先大图字段，缺省回退 profile_image_url */
export function avatarUrlOf(item: unknown): string | null {
  const u = (item as any)?.user;
  const url = u?.avatar_large ?? u?.avatar_hd ?? u?.profile_image_url;
  return typeof url === 'string' && url ? url : null;
}

/** 昵称（抓到就回写名单，昵称会改、uid 不会） */
export function nicknameOf(item: unknown): string | null {
  const n = (item as any)?.user?.screen_name;
  return typeof n === 'string' && n.trim() ? n.trim() : null;
}

/** created_at 是 "Mon Aug 03 21:15:00 +0800 2026" 格式，Date.parse 可直接解析 */
function parseCreatedAt(s: unknown): number {
  const t = Date.parse(String(s ?? ''));
  return Number.isNaN(t) ? 0 : Math.floor(t / 1000);
}

/**
 * 原始 mblog → Post；缺 idstr 返回 null 跳过。**归属 uid = 微博账号自身 uid**。
 * 转发（有 retweeted_status）拼「//转发自 @原作者: 原文」，图取原微博的；
 * 原微博已删时 retweeted_status 只剩残桩，防御式取值不炸。
 */
export function parseMblog(
  item: unknown, weiboUid: string, longText?: string | null,
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
    uid: weiboUid,
    itemId: String(idstr),
    type: isRetweet ? 'retweet' : 'mblog',
    text,
    pics,
    pubTs: parseCreatedAt(it?.created_at),
    url: `https://weibo.com/${weiboUid}/${mblogid}`,
    raw: JSON.stringify(item),
  };
}

/** 微博 idstr 是数字串，只往前推的游标按数值比较（与 X 的时间戳纪律同理） */
function newerId(a: string | null, b: string): string {
  if (!a) return b;
  try {
    return BigInt(b) > BigInt(a) ? b : a;
  } catch {
    return a;
  }
}

/**
 * 微博时间线轮询：listWeiboAccounts(true) → mapLimit(2) 逐个拉 mymblog →
 * 归档 posts → 新帖 emit feed_post。
 *
 * 登录态心跳折进同步周期：每轮 fetchWeiboSelf，运行中发现意外失效（本进程内此前
 * 成功登录过）才发一次 health_alert 并跳过整轮抓取，恢复复位；本来就没登录
 * （启动起从未成功）只记日志不告警；每轮 onLoginState 上报面板（驱动微博平台状态点）。
 * 轮次政策（core/backlog.ts）：缺口轮（首轮）默认只归档，补推开关开了才按时间窗+
 * 条数上限补推；主动关闭恢复轮（silent_next）一律静默。
 */
export class WeiboFeedSource implements Source {
  readonly name = 'weibo/feed';

  private ctx?: SourceContext;
  private task?: PeriodicTask;
  private status: WeiboFeedSnapshot = emptyWeiboFeedSnapshot();
  /** 已成功跑过一轮的账号 uid（本实例内不再算缺口轮；语义见 core/backlog.ts） */
  private polled = new Set<string>();
  private failures = new Map<string, number>();
  private uidAlerted = new Set<string>();
  /** 各 uid 本轮连续失败的起点（秒）。用于「持续失败超阈值再报一次」 */
  private firstFailTs = new Map<string, number>();
  /** 持续失败告警（durationAlert）每 uid 每轮故障只发一次，恢复后复位 */
  private durationAlerted = new Set<string>();
  /** 同一轮登录失效只告警一次，恢复后才复位（同 FollowsSource） */
  private loginAlerted = false;
  /** 本进程内是否成功登录过：没成功过 = 本来就没登录，只记日志不告警 */
  private hadOkLogin = false;

  private readonly cookie: string;
  private readonly fetcher: MblogFetcher;
  private readonly longTextFetcher: LongTextFetcher;
  private readonly selfFetcher: WeiboSelfFetcher;
  private readonly onLoginState?: (s: WeiboSelfInfo) => void;
  private readonly avatarCacheDir?: string;
  private readonly avatarSaver: (url: string, dir: string) => Promise<string | null>;
  private readonly onStatus?: (s: WeiboFeedSnapshot) => void;

  constructor(opts: WeiboFeedSourceOpts) {
    this.cookie = opts.cookie;
    this.fetcher = opts.fetcher ?? fetchMymblog;
    this.longTextFetcher = opts.longTextFetcher ?? fetchLongText;
    this.selfFetcher = opts.selfFetcher ?? fetchWeiboSelf;
    this.onLoginState = opts.onLoginState;
    this.avatarCacheDir = opts.avatarCacheDir;
    this.avatarSaver = opts.avatarSaver ?? cacheWeiboAvatar;
    this.onStatus = opts.onStatus;
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
    this.patchStatus({ running: false });
  }

  /** start 中除周期调度外的部分。测试可 bind 后直接驱动 pollOnce。 */
  bind(ctx: SourceContext): void {
    this.ctx = ctx;
    this.status = { ...this.status, running: true };
    this.onStatus?.(this.status);
    log.info(`启动：微博时间线轮询，间隔 ${ctx.config.weibo.intervalSec}s`);
  }

  /** 拉一轮：先心跳查登录态，有效才逐账号归档 + 新帖发信号。 */
  async pollOnce(): Promise<void> {
    const ctx = this.ctx!;

    let self: WeiboSelfInfo;
    try {
      self = await this.selfFetcher(this.cookie);
    } catch (e) {
      // 心跳本身网络失败 ≠ cookie 失效，不告警，只跳过本轮（同 FollowsSource）
      log.error('微博登录态查询失败，跳过本轮抓取', e);
      this.patchStatus({ lastRunAt: Math.floor(Date.now() / 1000), lastError: '登录态查询失败' });
      return;
    }
    this.onLoginState?.(self);

    if (!self.loggedIn) {
      if (this.hadOkLogin && !this.loginAlerted) {
        this.loginAlerted = true;
        ctx.bus.emit({
          source: this.name,
          kind: 'health_alert',
          uid: '',
          roomId: '',
          ts: Math.floor(Date.now() / 1000),
          payload: {
            alertKind: 'login_drop',
            message: '微博登录态运行中失效（X-Log-Uid 缺失），微博时间线已暂停。\n' +
              '请在面板重新扫码登录，或更新 weibo-cookies.json；其他功能不受影响。',
          },
        });
      }
      log.warn(this.hadOkLogin ? '微博登录态失效，跳过本轮抓取' : '微博未登录，跳过本轮抓取（不告警）');
      this.patchStatus({
        lastRunAt: Math.floor(Date.now() / 1000),
        accounts: 0,
        okAccounts: 0,
        lastError: this.hadOkLogin ? '微博登录态失效' : '微博未登录',
      });
      return;
    }
    this.hadOkLogin = true;
    if (this.loginAlerted) {
      this.loginAlerted = false;
      log.info('微博登录态已恢复，继续抓取');
    }

    const accounts = ctx.db.listWeiboAccounts(true);
    const nowSec = Math.floor(Date.now() / 1000);
    if (accounts.length === 0) {
      log.debug('微博名单为空，跳过本轮');
      this.patchStatus({ lastRunAt: nowSec, accounts: 0, okAccounts: 0, lastError: null });
      return;
    }

    let ok = 0;
    let lastError: string | null = null;
    await mapLimit(accounts, 2, async (a) => {
      const r = await this.pollAccount(a);
      if (r.ok) ok++;
      if (r.error) lastError = r.error;
    });
    this.patchStatus({
      lastRunAt: nowSec,
      accounts: accounts.length,
      okAccounts: ok,
      lastOkAt: ok > 0 ? nowSec : this.status.lastOkAt,
      lastError,
    });
  }

  /** 面板添加账号后的即时首拉（不等下个轮询周期、不在全量轮里排队；缺口轮语义同样生效） */
  async kickAccount(uid: string): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    const account = ctx.db.getWeiboAccountByUid(uid);
    if (!account) return;
    await this.pollAccount(account);
  }

  /** 单账号一轮：拉 → 归档 → 新帖发信号 → 游标/头像回写。失败不影响其他账号。 */
  private async pollAccount(
    account: WeiboAccount,
  ): Promise<{ ok: boolean; error?: string }> {
    const ctx = this.ctx!;
    const weiboUid = account.uid;
    let items: unknown[];
    try {
      items = await this.fetcher(this.cookie, weiboUid);
    } catch (e) {
      // 关键：拉取失败绝不当成「没微博」—— 保留旧数据，什么都不写
      const msg = e instanceof Error ? e.message : String(e);
      log.error(`微博时间线拉取失败（微博 ${weiboUid}），保留旧数据：${msg}`);
      this.onFailure(weiboUid, msg);
      return { ok: false, error: `微博 ${weiboUid}: ${msg}` };
    }
    this.onSuccess(weiboUid);

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
      const p = parseMblog(item, weiboUid, longText);
      if (p) posts.push(p);
    }
    const inserted = ctx.db.insertPosts(posts);
    const firstRound = !this.polled.has(weiboUid);
    this.polled.add(weiboUid);

    // 游标与昵称回写：游标只往前推；昵称抓到就更新（昵称会改，uid 不会）
    const newest = posts.reduce<string | null>((acc, p) => newerId(acc, p.itemId), account.lastPostId);
    const newestPost = posts.find((p) => p.itemId === newest) ?? null;
    const nowSec = Math.floor(Date.now() / 1000);
    ctx.db.touchWeiboAccount(account.id, {
      lastOkAt: nowSec,
      ...(newest ? { lastPostId: newest } : {}),
      ...(newestPost ? { lastPostAt: newestPost.pubTs } : {}),
      ...(nicknameOf(items[0]) ? { nickname: nicknameOf(items[0]) } : {}),
      // 恢复位消费：本轮按 resume 轮静默处理过了，顺手清位
      ...(account.silentNext ? { silentNext: false } : {}),
    });

    // 轮次语义（core/backlog.ts）：resume=主动关闭恢复，一律静默；gap=本实例首轮
    // （服务未运行期间 / 新加账号），默认静默、开了补推开关才按时间窗+条数上限补推；
    // normal=新帖全推
    const kind = roundKind(account.silentNext, firstRound);
    const backlog = kind === 'gap' ? getPostBacklogConfig(ctx.db) : null;
    const emitIdx = kind === 'resume' ? [] :
      kind === 'normal' ? inserted :
      backlog && backlog.enabled ? pickBacklogPush(posts, inserted, backlog, nowSec) : [];
    for (const i of emitIdx) {
      const p = posts[i]!;
      const sig: Signal = {
        source: this.name,
        kind: 'feed_post',
        uid: weiboUid,
        roomId: '',
        ts: nowSec,
        payload: {
          platform: p.platform, itemId: p.itemId, type: p.type,
          text: p.text, pics: p.pics, pubTs: p.pubTs, url: p.url,
        },
      };
      ctx.bus.emit(sig);
    }
    if (kind === 'resume') {
      log.info(`微博 ${weiboUid} 恢复轮静默归档 ${inserted.length} 条（主动关闭期间的内容不补推）`);
    } else if (kind === 'normal') {
      if (inserted.length > 0) log.info(`微博 ${weiboUid} 新帖 ${inserted.length} 条`);
    } else if (emitIdx.length === 0) {
      log.info(`微博 ${weiboUid} 首轮归档 ${inserted.length} 条（静默，不发信号）`);
    } else {
      log.info(`微博 ${weiboUid} 首轮补推 ${emitIdx.length} 条，上限外跳过 ${inserted.length - emitIdx.length} 条`);
    }

    // 头像最后做：下载慢也不能挡 feed_post 信号。已有本地头像不重复下载，失败静默下轮再试。
    if (!account.avatar && this.avatarCacheDir) {
      const url = avatarUrlOf(items[0]);
      if (url) {
        const avatar = await this.avatarSaver(url, this.avatarCacheDir);
        if (avatar) ctx.db.touchWeiboAccount(account.id, { avatar });
      }
    }
    return { ok: true };
  }

  private patchStatus(patch: Partial<WeiboFeedSnapshot>): void {
    this.status = { ...this.status, ...patch };
    this.onStatus?.(this.status);
  }

  private onSuccess(uid: string): void {
    const n = this.failures.get(uid) ?? 0;
    if (n > 0) log.info(`微博 ${uid} 时间线拉取恢复正常（此前连续失败 ${n} 次）`);
    this.failures.delete(uid);
    this.uidAlerted.delete(uid);
    this.firstFailTs.delete(uid);
    this.durationAlerted.delete(uid);
  }

  private onFailure(uid: string, err: string): void {
    const nowSec = Math.floor(Date.now() / 1000);
    const n = (this.failures.get(uid) ?? 0) + 1;
    if (n === 1) this.firstFailTs.set(uid, nowSec);
    this.failures.set(uid, n);
    const durationSec = nowSec - (this.firstFailTs.get(uid) ?? nowSec);
    const threshold = this.ctx!.config.healthAlertAfterFailures;
    if (n >= threshold && !this.uidAlerted.has(uid)) {
      this.uidAlerted.add(uid); // 同一轮故障只告警一次，恢复后才复位
      this.emitUidAlert(uid, n, durationSec, err, false);
    }
    // 持续失败超阈值再报一次（网络波动通常几分钟内恢复）——pipeline 据此路由到告警 QQ
    if (durationSec >= STREAK_QQ_ALERT_AFTER_SEC && !this.durationAlerted.has(uid)) {
      this.durationAlerted.add(uid);
      this.emitUidAlert(uid, n, durationSec, err, true);
    }
  }

  private emitUidAlert(uid: string, failures: number, durationSec: number, err: string, durationAlert: boolean): void {
    this.ctx!.bus.emit({
      source: this.name,
      kind: 'health_alert',
      uid,
      roomId: '',
      ts: Math.floor(Date.now() / 1000),
      payload: {
        alertKind: 'streak',
        message: `微博时间线拉取连续失败 ${failures} 次（微博 ${uid}），该账号本轮已暂停。\n` +
          '多为登录态失效或被风控，恢复后自动继续。' +
          (durationAlert ? `\n已持续失败约 ${Math.round(durationSec / 60)} 分钟。` : ''),
        failures,
        lastError: err,
        ...(durationAlert ? { durationAlert: true } : {}),
      },
    });
  }
}
