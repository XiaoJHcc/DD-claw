/**
 * X/推特时间线源：轮询 x_accounts 里 enabled 的账号 → posts 归档（UNIQUE(platform,item_id) 去重）
 * → 新帖 emit feed_post。模子 = sources/weibo/feed.ts，纪律逐条照抄。
 *
 * 两条路线（选哪条由 settings 决定，失败自动降级）：
 *   ① Nitter 实例 RSS（主）：唯一能区分原创/转发、带图、时间的免登录路线
 *   ② 免登录 x.com HTML + 单推接口（备）：零第三方依赖，但**看不到转发**
 *
 * 失败纪律（与"拉取失败绝不能当成下播"同源）：
 * - 拉取失败**绝不当成「没有新推文」**：保留旧数据、什么都不写，只记账告警；
 * - 单账号连续失败到阈值发一次 health_alert，持续失败超阈值再报一次，恢复复位；
 * - 「登录态心跳」在这里换成**代理/实例可用性心跳**（X 没有登录态）。
 *
 * 冷启动政策同 dynamic/weibo：每个账号首轮只归档不发信号。
 */
import { makeLogger } from '../../logger.js';
import { PeriodicTask } from '../../core/scheduler.js';
import { mapLimit } from '../../core/concurrency.js';
import type { Signal } from '../../core/types.js';
import { STREAK_QQ_ALERT_AFTER_SEC } from '../../core/types.js';
import type { NewPost } from '../../core/posts.js';
import { emptyXFeedSnapshot, type XFeedSnapshot } from '../../core/x-config.js';
import type { Source, SourceContext } from '../types.js';
import { fetchFromAnyInstance, type NitterFetchResult, type ParsedTweet } from './nitter.js';
import { fetchWebTimeline } from './web.js';

const log = makeLogger('twitter/feed');

export type TwitterRoute = 'nitter' | 'web';

/** 单账号一次拉取的结果（路线 + 数据），供注入点替换 */
export interface TimelineFetch {
  tweets: ParsedTweet[];
  via: TwitterRoute;
  host: string | null;
}

export interface TwitterFeedSourceOpts {
  proxyUrl: string;
  instances: string[];
  /** Nitter 全挂时是否回退到免登录 HTML（settings `x_fallback_html`） */
  fallbackHtml: boolean;
  intervalSec: number;
  jitterSec?: number;
  healthAlertAfterFailures?: number;
  /** 注入点（单测用；默认走真实网络） */
  rssFetcher?: (hosts: string[], screen: string) => Promise<NitterFetchResult>;
  webFetcher?: (screen: string, sinceId: string | null) => Promise<{ tweets: ParsedTweet[]; bytes: number; ms: number }>;
  onStatus?: (s: XFeedSnapshot) => void;
}

/** 推文 → posts 行。uid 用被轮询账号（转发也是它转的），原作者在 raw 里 */
export function tweetToPost(t: ParsedTweet, screenName: string, via: TwitterRoute, host: string | null): NewPost {
  return {
    platform: 'twitter',
    uid: screenName,
    itemId: t.id,
    type: t.isRetweet ? 'retweet' : 'tweet',
    text: t.text,
    pics: t.pics,
    pubTs: t.pubTs,
    url: t.url,
    raw: JSON.stringify({ ...t, via, host, polledAccount: screenName }),
  };
}

export class TwitterFeedSource implements Source {
  readonly name = 'twitter/feed';

  private ctx?: SourceContext;
  private task?: PeriodicTask;
  private status: XFeedSnapshot = emptyXFeedSnapshot();
  /** 已成功跑过一轮的账号（首轮静默归档，不发信号） */
  private polled = new Set<string>();
  private failures = new Map<string, number>();
  private uidAlerted = new Set<string>();
  private firstFailTs = new Map<string, number>();
  private durationAlerted = new Set<string>();

  private readonly opts: TwitterFeedSourceOpts;

  constructor(opts: TwitterFeedSourceOpts) {
    this.opts = opts;
  }

  start(ctx: SourceContext): void {
    this.bind(ctx);
    this.task = new PeriodicTask({
      name: this.name,
      intervalSec: this.opts.intervalSec,
      jitterSec: this.opts.jitterSec ?? ctx.config.pollJitterSec,
      run: async () => { await this.pollOnce(); },
    });
    this.task.start();
  }

  stop(): void {
    this.task?.stop();
    this.status = { ...this.status, running: false };
    this.opts.onStatus?.(this.status);
  }

  /** start 中除周期调度外的部分（测试可 bind 后直接驱动 pollOnce） */
  bind(ctx: SourceContext): void {
    this.ctx = ctx;
    this.status = { ...this.status, running: true };
    this.opts.onStatus?.(this.status);
    log.info(
      `启动：X 时间线轮询，间隔 ${this.opts.intervalSec}s，` +
      `实例 [${this.opts.instances.join(', ') || '无'}]，回退=${this.opts.fallbackHtml ? '开' : '关'}`,
    );
  }

  /** 一轮：逐账号拉时间线 → 归档 → 新帖发信号；单账号失败不影响其他账号 */
  async pollOnce(): Promise<void> {
    const ctx = this.ctx!;
    const accounts = ctx.db.listXAccounts(true);
    const nowSec = Math.floor(Date.now() / 1000);
    if (accounts.length === 0) {
      log.debug('X 名单为空，跳过本轮');
      this.patchStatus({ lastRunAt: nowSec, accounts: 0, okAccounts: 0 });
      return;
    }

    let ok = 0;
    let via: TwitterRoute | null = null;
    let host: string | null = null;
    let lastError: string | null = null;
    await mapLimit(accounts, 2, async (a) => {
      const r = await this.pollAccount(a.screenName, a.lastTweetId);
      if (r.ok) ok++;
      if (r.via) via = r.via;
      if (r.host) host = r.host;
      if (r.error) lastError = r.error;
    });

    this.patchStatus({
      lastRunAt: nowSec,
      accounts: accounts.length,
      okAccounts: ok,
      via,
      host,
      lastOkAt: ok > 0 ? nowSec : this.status.lastOkAt,
      lastError,
    });
  }

  private async pollAccount(
    screenName: string,
    sinceId: string | null,
  ): Promise<{ ok: boolean; via: TwitterRoute | null; host: string | null; error?: string }> {
    const ctx = this.ctx!;
    let fetched: TimelineFetch;
    try {
      fetched = await this.fetchTimeline(screenName, sinceId);
    } catch (e) {
      // 关键：拉取失败绝不当成「没有新推文」—— 保留旧数据，什么都不写
      const msg = e instanceof Error ? e.message : String(e);
      log.error(`X 时间线拉取失败 @${screenName}（保留旧数据）：${msg}`);
      this.onFailure(screenName, msg);
      return { ok: false, via: null, host: null, error: `@${screenName}: ${msg}` };
    }
    this.onSuccess(screenName);

    const posts = fetched.tweets.map((t) => tweetToPost(t, screenName, fetched.via, fetched.host));
    const inserted = ctx.db.insertPosts(posts);
    const firstRound = !this.polled.has(screenName);
    this.polled.add(screenName);

    // 游标只往前推（按数值比较，不用时间戳——时间戳会被置顶/编辑搅乱）
    const newest = fetched.tweets.reduce<ParsedTweet | null>(
      (acc, t) => (acc === null || BigInt(t.id) > BigInt(acc.id) ? t : acc),
      null,
    );
    const nowSec = Math.floor(Date.now() / 1000);
    ctx.db.touchXAccount(ctx.db.getXAccountByScreenName(screenName)!.id, {
      lastOkAt: nowSec,
      ...(newest ? { lastTweetId: newest.id, lastTweetAt: newest.pubTs } : {}),
    });

    if (firstRound) {
      log.info(`@${screenName} 首轮归档 ${inserted.length} 条（静默，不发信号）`);
      return { ok: true, via: fetched.via, host: fetched.host };
    }
    for (const i of inserted) {
      const p = posts[i]!;
      const src = fetched.tweets[i]; // posts 与 tweets 同序（posts 就是 tweets.map 出来的）
      const sig: Signal = {
        source: this.name,
        kind: 'feed_post',
        uid: screenName,
        roomId: '',
        ts: nowSec,
        payload: {
          platform: p.platform, itemId: p.itemId, type: p.type,
          text: p.text, pics: p.pics, pubTs: p.pubTs, url: p.url,
          // 引用只在免登录回退路线可知；RSS 帖缺省 = 未知（规则里的 quote 筛选据此不命中）
          ...(src?.isQuote !== undefined ? { isQuote: src.isQuote } : {}),
        },
      };
      ctx.bus.emit(sig);
    }
    if (inserted.length > 0) {
      log.info(`@${screenName} 新推文 ${inserted.length} 条（via ${fetched.via}${fetched.host ? ' ' + fetched.host : ''}）`);
    }
    return { ok: true, via: fetched.via, host: fetched.host };
  }

  /**
   * 主路线 Nitter RSS；失败且开了回退时走免登录 HTML。
   * 回退路线用 `sinceId` 只取增量详情，避免每次把最新十几条都换成单推请求。
   */
  private async fetchTimeline(screenName: string, sinceId: string | null): Promise<TimelineFetch> {
    const { proxyUrl, instances, fallbackHtml } = this.opts;
    let rssError: string | null = null;
    if (instances.length > 0) {
      try {
        const rss = this.opts.rssFetcher
          ? await this.opts.rssFetcher(instances, screenName)
          : await fetchFromAnyInstance(instances, screenName, proxyUrl);
        return { tweets: rss.tweets, via: 'nitter', host: rss.host };
      } catch (e) {
        rssError = e instanceof Error ? e.message : String(e);
      }
    }
    if (!fallbackHtml) {
      throw new Error(rssError ?? '没有可用路线（未配置实例且回退已关）');
    }
    try {
      const web = this.opts.webFetcher
        ? await this.opts.webFetcher(screenName, sinceId)
        : await fetchWebTimeline(screenName, proxyUrl, { sinceId });
      return { tweets: web.tweets, via: 'web', host: null };
    } catch (e) {
      const webError = e instanceof Error ? e.message : String(e);
      throw new Error(rssError ? `Nitter 失败（${rssError}）；回退也失败（${webError}）` : `回退路线失败（${webError}）`);
    }
  }

  private patchStatus(patch: Partial<XFeedSnapshot>): void {
    this.status = { ...this.status, ...patch };
    this.opts.onStatus?.(this.status);
  }

  private onSuccess(uid: string): void {
    const n = this.failures.get(uid) ?? 0;
    if (n > 0) log.info(`@${uid} X 时间线拉取恢复正常（此前连续失败 ${n} 次）`);
    this.failures.delete(uid);
    this.uidAlerted.delete(uid);
    this.firstFailTs.delete(uid);
    this.durationAlerted.delete(uid);
  }

  private onFailure(uid: string, err: string): void {
    const ctx = this.ctx!;
    const nowSec = Math.floor(Date.now() / 1000);
    const n = (this.failures.get(uid) ?? 0) + 1;
    if (n === 1) this.firstFailTs.set(uid, nowSec);
    this.failures.set(uid, n);
    const durationSec = nowSec - (this.firstFailTs.get(uid) ?? nowSec);
    const threshold = this.opts.healthAlertAfterFailures ?? ctx.config.healthAlertAfterFailures;
    if (n >= threshold && !this.uidAlerted.has(uid)) {
      this.uidAlerted.add(uid);
      this.emitAlert(uid, n, durationSec, err, false);
    }
    if (durationSec >= STREAK_QQ_ALERT_AFTER_SEC && !this.durationAlerted.has(uid)) {
      this.durationAlerted.add(uid);
      this.emitAlert(uid, n, durationSec, err, true);
    }
  }

  private emitAlert(uid: string, failures: number, durationSec: number, err: string, durationAlert: boolean): void {
    this.ctx!.bus.emit({
      source: this.name,
      kind: 'health_alert',
      uid,
      roomId: '',
      ts: Math.floor(Date.now() / 1000),
      payload: {
        alertKind: 'streak',
        message: `X 时间线拉取连续失败 ${failures} 次（@${uid}），该账号本轮已暂停。\n` +
          '多为代理不可用或 Nitter 实例全挂，恢复后自动继续；可在面板「X / 推特」页点「测试全部」看具体原因。' +
          (durationAlert ? `\n已持续失败约 ${Math.round(durationSec / 60)} 分钟。` : ''),
        failures,
        lastError: err,
        ...(durationAlert ? { durationAlert: true } : {}),
      },
    });
  }
}