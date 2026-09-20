import { makeLogger } from '../../logger.js';
import { PeriodicTask } from '../../core/scheduler.js';
import { mapLimit } from '../../core/concurrency.js';
import type { Signal } from '../../core/types.js';
import { STREAK_QQ_ALERT_AFTER_SEC } from '../../core/types.js';
import type { NewPost } from '../../core/posts.js';
import type { BiliAccount } from '../../core/bili-accounts.js';
import type { Source, SourceContext } from '../types.js';
import { BiliApiError, biliRequest, type BiliRequestFn } from './client.js';
import { fetchSelf, type SelfInfo } from './auth.js';
import { dmQueryParams } from './dm.js';
import { cacheBiliAvatar } from './avatar.js';

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
  /** B站动态账号头像本地缓存目录（cache/bili-avatars）；不注入则只抠 URL 不落盘 */
  avatarDir?: string;
  /** 头像落盘注入点（单测用；默认 cacheBiliAvatar 直连下载，hdslb 图床无需代理） */
  avatarSaver?: (url: string, dir: string) => Promise<string | null>;
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
 * 空间动态轮询：轮询对象是 **listWatchedUids ∪ bili_accounts(enabled) 的 uid**（Set 去重）
 * → mapLimit(2) 逐个拉 feed/space → 归档 posts（INSERT OR IGNORE，去重只靠
 * (platform, item_id) UNIQUE）→ 新帖 emit feed_post。
 * 两边都归档；监听主播的动态信号会被 pipeline 丢弃（uid 不在 bili_accounts 名单内，
 * 只归档不推送），动态名单账号的信号才走图文规则推送。
 * 动态名单账号每次拉取成功还回写 uname / last_ok_at（摸到非空才写名，uid 不会变名会改）；
 * 头像（face URL）在注入了 avatarDir 且尚无本地头像时顺手落盘，成功回写 avatar 文件名
 * （下载慢不挡 feed_post 信号，失败静默下轮再试）。
 *
 * 登录态心跳折进轮询周期（模子同 FollowsSource / WeiboFeedSource）：每轮先 fetchSelf，
 * 运行中发现意外失效（本进程内此前成功登录过）才发一次 health_alert 并跳过本轮，
 * 恢复复位；本来就没登录（启动起从未成功）只记日志不告警；每轮 onLoginState 上报面板
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
  /** 各 uid 本轮连续失败的起点（秒）。用于「持续失败超阈值再报一次」 */
  private firstFailTs = new Map<string, number>();
  /** 持续失败告警（durationAlert）每 uid 每轮故障只发一次，恢复后复位 */
  private durationAlerted = new Set<string>();
  /** 同一轮登录失效只告警一次，恢复后才复位（同 FollowsSource） */
  private loginAlerted = false;
  /** 本进程内是否成功登录过：没成功过 = 本来就没登录，只记日志不告警 */
  private hadOkLogin = false;

  private readonly cookie: string;
  private readonly fetcher: DynamicFetcher;
  private readonly selfFetcher: DynamicSelfFetcher;
  private readonly onLoginState?: (s: SelfInfo) => void;
  private readonly avatarDir?: string;
  private readonly avatarSaver: (url: string, dir: string) => Promise<string | null>;

  constructor(opts: DynamicSourceOpts) {
    this.cookie = opts.cookie;
    this.fetcher = opts.fetcher ?? fetchDynamics;
    this.selfFetcher = opts.selfFetcher ?? fetchSelf;
    this.onLoginState = opts.onLoginState;
    this.avatarDir = opts.avatarDir;
    this.avatarSaver = opts.avatarSaver ?? cacheBiliAvatar;
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

  /** 面板添加动态账号后的即时首拉（不等下个轮询周期；首轮静默政策同样生效） */
  async kickAccount(uid: string): Promise<void> {
    if (!this.ctx) return;
    await this.pollUid(uid);
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
            message: 'B站 cookie 运行中失效（isLogin=false），空间动态抓取已暂停。\n' +
              '请在面板重新扫码登录，或更新 cookies.json；匿名开播监听不受影响。',
          },
        });
      }
      log.warn(this.hadOkLogin ? 'cookie 失效，跳过本轮抓取' : '未登录，跳过本轮抓取（不告警）');
      return;
    }
    this.hadOkLogin = true;
    if (this.loginAlerted) {
      this.loginAlerted = false;
      log.info('登录态已恢复，继续抓取');
    }

    // 轮询对象 = 监听主播 ∪ 动态名单启用账号：两边都归档，推送分流在 pipeline（名单外 uid 丢弃）
    const uids = [
      ...new Set([
        ...ctx.db.listWatchedUids(),
        ...ctx.db.listBiliAccounts(true).map((a) => a.uid),
      ]),
    ];
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

    // 动态名单账号回写（首轮也写）：uname 摸到非空才更新，lastOkAt 每次成功都推
    const account = ctx.db.getBiliAccountByUid(uid);
    const author = dig(items[0], 'modules', 'module_author');
    const uname = typeof author?.name === 'string' && author.name.trim()
      ? author.name.trim() : null;
    const face = typeof author?.face === 'string' && author.face ? author.face : null;
    if (account) {
      ctx.db.touchBiliAccount(account.id, {
        lastOkAt: Math.floor(Date.now() / 1000),
        ...(uname ? { uname } : {}),
      });
    }

    if (firstRound) {
      log.info(`uid=${uid} 首轮归档 ${inserted.length} 条动态（静默，不发信号）`);
      await this.maybeSaveAvatar(account, face);
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

    // 头像最后做：下载慢也不能挡 feed_post 信号。已有本地头像不重复下载，失败静默下轮再试。
    await this.maybeSaveAvatar(account, face);
  }

  /** 动态名单账号且尚无本地头像时，抠 face URL 落盘并回写文件名；未注入 avatarDir 则只抠不落 */
  private async maybeSaveAvatar(
    account: BiliAccount | undefined, face: string | null,
  ): Promise<void> {
    if (!account || account.avatar || !this.avatarDir || !face) return;
    const saved = await this.avatarSaver(face, this.avatarDir);
    if (saved) this.ctx!.db.touchBiliAccount(account.id, { avatar: saved });
  }

  private onSuccess(uid: string): void {
    const n = this.failures.get(uid) ?? 0;
    if (n > 0) log.info(`uid=${uid} 动态拉取恢复正常（此前连续失败 ${n} 次）`);
    this.failures.delete(uid);
    this.alerted.delete(uid);
    this.firstFailTs.delete(uid);
    this.durationAlerted.delete(uid);
  }

  private onFailure(uid: string, err: unknown): void {
    const nowSec = Math.floor(Date.now() / 1000);
    const n = (this.failures.get(uid) ?? 0) + 1;
    if (n === 1) this.firstFailTs.set(uid, nowSec);
    this.failures.set(uid, n);
    const durationSec = nowSec - (this.firstFailTs.get(uid) ?? nowSec);
    const threshold = this.ctx!.config.healthAlertAfterFailures;
    if (n >= threshold && !this.alerted.has(uid)) {
      this.alerted.add(uid); // 同一轮故障只告警一次，恢复后才复位
      this.emitUidAlert(uid, n, durationSec, err, false);
    }
    // 持续失败超阈值再报一次（网络波动通常几分钟内恢复）——pipeline 据此路由到告警 QQ
    if (durationSec >= STREAK_QQ_ALERT_AFTER_SEC && !this.durationAlerted.has(uid)) {
      this.durationAlerted.add(uid);
      this.emitUidAlert(uid, n, durationSec, err, true);
    }
  }

  private emitUidAlert(uid: string, failures: number, durationSec: number, err: unknown, durationAlert: boolean): void {
    this.ctx!.bus.emit({
      source: this.name,
      kind: 'health_alert',
      uid,
      roomId: '',
      ts: Math.floor(Date.now() / 1000),
      payload: {
        alertKind: 'streak',
        message: `B站动态拉取连续失败 ${failures} 次（uid=${uid}），动态源已暂停该对象本轮。\n` +
          `多为风控（412/-352）或 cookie 失效，恢复后自动继续。` +
          (durationAlert ? `\n已持续失败约 ${Math.round(durationSec / 60)} 分钟。` : ''),
        failures,
        lastError: String(err),
        ...(durationAlert ? { durationAlert: true } : {}),
      },
    });
  }
}
