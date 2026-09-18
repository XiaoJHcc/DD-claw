import { makeLogger } from '../logger.js';
import { toLiveEvent, type LiveEvent, type PushMessage, type Signal } from './types.js';
import { liveEventToMessage, postToMessage } from '../notify/message.js';
import {
  defaultPostTitle, matchPostRules, matchPushRules, postAuthorName, renderPostTemplate, renderTemplate,
  type PostCandidate,
} from '../analysis/matcher.js';
import { isPushEnabled } from './push.js';
import { getNapcatAlertQq } from '../notify/napcat.js';
import { localizeImage, localizeImageViaProxy } from '../notify/image-cache.js';
import { ruleNeedsLlm, type PostAnalysis, type PostAnalyzer } from '../analysis/post-analyzer.js';
import type { PostRule } from './post-rules.js';
import type { XAccount } from './x-accounts.js';
import type { WeiboAccount } from './weibo-accounts.js';
import { getXConfig } from './x-config.js';
import { isNotifyOnFirstRun, isNotifyOnNewSubscription } from './runtime-config.js';
import type { Bus } from './bus.js';
import type { Db } from './db.js';
import type { AppConfig } from '../config/schema.js';
import type { AnalysisQueue } from '../analysis/queue.js';
import type { DecisionRule } from '../rules/types.js';
import type { NotifyDispatcher } from '../notify/dispatcher.js';

const log = makeLogger('core/pipeline');

/** 同时处理多少个信号的推送。够覆盖同时开播的常见规模，又不至于打爆 NapCat。 */
const NOTIFY_CONCURRENCY = 4;

export interface PipelineDeps {
  bus: Bus;
  db: Db;
  config: AppConfig;
  queue: AnalysisQueue;
  rule: DecisionRule;
  dispatcher: NotifyDispatcher;
  /** 图片本地化缓存目录（X 图必须经代理下载成本地文件再推）；缺省 = 图文帖不带图 */
  imageCacheDir?: string;
  /** 图文帖 LLM 判定/翻译（规则级开关）；缺省 = 规则里的 LLM 开关一律当关 */
  postAnalyzer?: PostAnalyzer;
}

/** feed_post 的载荷形状（X 源与微博源同形，platform 决定账号解释域，见 handleFeedPost） */
interface FeedPostPayload {
  platform?: string;
  itemId?: string;
  type?: string;
  text?: string | null;
  pics?: string[];
  pubTs?: number;
  url?: string | null;
  isQuote?: boolean;
}

interface HealthAlertPayload {
  failures?: number;
  subscriptions?: number;
  lastError?: string;
  /** 'login_drop' = 运行中登录态意外失效（立即报 QQ）；'streak' = 连续拉取失败 */
  alertKind?: string;
  /** 连续失败持续满 STREAK_QQ_ALERT_AFTER_SEC 后的二次告警（报 QQ） */
  durationAlert?: boolean;
  /** 本轮连续失败已持续的秒数 */
  durationSec?: number;
  /** source 自定义的完整告警文案；缺省用 live-status 拉取失败的默认文案 */
  message?: string;
}

/**
 * 信号编排的唯一装配点：bus → 冷启动抑制 → 分析队列 → 规则护栏 → 推送。
 * source 只产信号，所有政策判断都在这里及之后的层。
 */
export class Pipeline {
  private active = 0;
  private readonly pending: Signal[] = [];
  private readonly idleWaiters: Array<() => void> = [];

  constructor(private readonly deps: PipelineDeps) {}

  attach(): void {
    this.deps.bus.on('*', (s) => this.enqueue(s));
  }

  /** 等待当前排队与在飞的信号全部处理完（测试用）。 */
  whenIdle(): Promise<void> {
    if (this.active === 0 && this.pending.length === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private enqueue(s: Signal): void {
    this.pending.push(s);
    this.drain();
  }

  private drain(): void {
    while (this.active < NOTIFY_CONCURRENCY && this.pending.length > 0) {
      const s = this.pending.shift()!;
      this.active++;
      void this.handle(s)
        .catch((e) => log.error(`处理信号 [${s.kind}] 异常`, e))
        .finally(() => {
          this.active--;
          this.drain();
          if (this.active === 0 && this.pending.length === 0) {
            for (const r of this.idleWaiters.splice(0)) r();
          }
        });
    }
  }

  private aliasOf(uid: string): string {
    return this.deps.db.getStreamer(uid)?.alias ?? '';
  }

  private async handle(signal: Signal): Promise<void> {
    if (signal.kind === 'health_alert') return this.handleHealthAlert(signal);
    // 图文帖（X/推特）：与开播完全平行的一条路径，不进 LLM、不看直播状态
    if (signal.kind === 'feed_post') return this.handleFeedPost(signal);
    if (!signal.status) {
      log.debug(`忽略无状态的信号 [${signal.kind}]（${signal.source}）`);
      return;
    }

    const { db, queue, rule, dispatcher } = this.deps;
    const event = toLiveEvent(signal.status, this.aliasOf(signal.uid));

    // 归档分派：在抑制检查之前（冷启动/静音场次照样归档），且在信号的同步前缀里
    // 按序执行——live_end 的 endSession 先于配对 live_start 的 recordSession，
    // 所以 endSession 按房间取最新一场关闭不会误关新场（见 db.endSession 注释）
    if (signal.kind === 'live_start') {
      db.recordSession({
        roomId: event.roomId, liveTime: event.liveTime, uid: event.uid,
        uname: event.uname, title: event.title, areaName: event.areaName,
        parentAreaName: event.parentAreaName, keyframe: event.keyframe, cover: event.cover,
      });
    } else if (signal.kind === 'live_end') {
      db.endSession(signal.roomId, signal.ts);
    } else if (signal.kind === 'title_change') {
      db.rotateSegment(event.roomId, event.liveTime, signal.ts, {
        title: event.title, areaName: event.areaName,
        parentAreaName: event.parentAreaName, keyframe: event.keyframe,
      });
    }

    // 冷启动抑制（政策在这层，diffRoom 只如实产信号、source 只打标记）：
    // 跳过通知，但上面 live_start 的 recordSession 等归档照做。
    // 开关读 settings（面板推送渠道卡「推送设置」，热生效）
    if (signal.coldStart === 'first_run' && !isNotifyOnFirstRun(db)) {
      log.debug(`不推送 [${signal.kind}] ${event.uname || event.alias}: 首次运行已在播，按配置不推送`);
      return;
    }
    // 重启恢复：上次下播、本次启动前开播的主播，无法得知真实开播时间，
    // 与 first_run 同属「启动时已在播」，共用 notifyOnFirstRun 这一个开关。
    if (signal.coldStart === 'restart_recovery' && !isNotifyOnFirstRun(db)) {
      log.debug(`不推送 [${signal.kind}] ${event.uname || event.alias}: 停机期间开播（启动时已在播），按配置不推送`);
      return;
    }
    if (signal.coldStart === 'new_subscription' && !isNotifyOnNewSubscription(db)) {
      log.debug(`不推送 [${signal.kind}] ${event.uname || event.alias}: 新增订阅正在直播，按配置不推送`);
      return;
    }

    // 推送总开关（面板推送卡右上角）：关 = 全局不推，追踪照常
    if (!isPushEnabled(db)) {
      log.debug(`不推送 [${signal.kind}] ${event.uname || event.alias}: 推送总开关已关`);
      return;
    }

    // 分类判定只在 live_start 做（live_end / title_change 不烧 LLM）；
    // 判定结果进规则匹配：推送规则按 categoryId 引用分类（buildMessage）
    const classifications = signal.kind === 'live_start' ? await queue.submit({ event, signal }) : [];
    const decision = await rule.decide({ ...event, classifications }, signal, classifications);

    if (!decision.shouldNotify) {
      log.debug(`不推送 [${signal.kind}] ${event.uname || event.alias}: ${decision.reason}`);
      return;
    }

    const msg = this.buildMessage({ ...event, classifications });
    if (!msg) return; // buildMessage 已记日志（规则不命中 / 规则未选渠道）

    log.info(`推送 [${signal.kind}] ${event.uname || event.alias} — ${decision.reason}`);
    const outcome = await dispatcher.broadcast(msg);

    // 只要有任一通道成功就标记，否则 Toast 成功而 QQ 失败会导致下轮重推
    if (outcome.anySuccess && signal.kind === 'live_start') {
      db.markNotified(event.roomId, event.liveTime);
    }
  }

  /**
   * 推送规则 → PushMessage；返回 null = 不推（命中集合渠道并集为空 / 无命中规则）。
   * - 命中集合非空：所有命中规则独立生效——渠道 = 各命中规则 channels 的并集（去重保序）；
   *   推送词 = sort 序首个非空 messageTemplate；并集为空 = 用户明确不推（记 log 不推）
   * - 无命中规则（含一条都没有）= 不推——「任意开播 × 全部主播」规则即旧全局默认的等价物，
   *   需要兜底推送的用户自建一条即可
   * - 模板：规则覆盖 > 内置默认 '{liver} 开播了'；正文/图片/跳转沿用默认形状
   */
  private buildMessage(event: LiveEvent): PushMessage | null {
    const { db } = this.deps;
    const base = liveEventToMessage(event);
    const hits = matchPushRules(
      db.listEnabledPushRules(), event,
      new Set(event.classifications.map((c) => c.categoryId)),
    );

    if (hits.length === 0) {
      log.info(`不推送 ${event.uname || event.alias}: 无命中规则`);
      return null;
    }
    const channelIds: number[] = [];
    let templateOverride: string | null = null;
    for (const r of hits) {
      for (const id of r.channels) {
        if (!channelIds.includes(id)) channelIds.push(id);
      }
      templateOverride ??= r.messageTemplate;
    }
    if (channelIds.length === 0) {
      log.info(`不推送 ${event.uname || event.alias}: 命中 ${hits.length} 条规则但都未勾选渠道`);
      return null;
    }
    log.info(`命中推送规则 ${hits.map((r) => `#${r.id}`).join('/')}（${event.uname || event.alias}）`);

    const tpl = templateOverride ?? '{liver} 开播了';
    const text = renderTemplate(tpl, event).trim();
    return { ...base, title: text || base.title, channels: channelIds.map(String) };
  }

  /**
   * 图文帖（feed_post）路径：机械筛选 → 图文帖规则 → 带图推送。与开播路径完全平行：
   *  · 不过决策规则（`DecisionRule` 是「每场直播推一次」那类防抖，帖子没有场次概念，
   *    去重由 posts 的 UNIQUE(platform,item_id) 兜住）；
   *  · 不过冷启动抑制（帖子不是「启动时已在播」那种状态，首轮由 source 静默归档挡住）；
   *  · 两个平台走同一条分支：账号在各自名单里查（X→x_accounts / 微博→weibo_accounts），
   *    规则按 `platform` 过滤（`matchPostRules`），所以一条微博永远不会被 X 规则匹配到。
   */
  private async handleFeedPost(signal: Signal): Promise<void> {
    const { db, dispatcher } = this.deps;
    const p = signal.payload as FeedPostPayload | undefined;
    const platform = p?.platform === 'weibo' ? 'weibo' : p?.platform === 'twitter' ? 'twitter' : null;
    if (!p || !platform) {
      log.debug(`忽略 feed_post（平台 ${p?.platform ?? '未知'}）：只支持 twitter / weibo`);
      return;
    }
    if (!isPushEnabled(db)) {
      log.debug(`不推送 feed_post ${signal.uid}: 推送总开关已关`);
      return;
    }
    // 账号解析：uid 的解释域按平台不同（X=screen name / 微博=数字 uid）
    const account = platform === 'twitter'
      ? db.getXAccountByScreenName(signal.uid)
      : db.getWeiboAccountByUid(signal.uid);
    if (!account) {
      log.warn(`feed_post 来自不在${platform === 'weibo' ? '微博' : 'X'}名单里的账号 ${signal.uid}，忽略`);
      return;
    }
    const bili = account.biliUid ? db.getStreamer(account.biliUid) : undefined;
    // 两个账号类型只在「标识字段叫什么名字」上不同：X 是 screen name / 微博是数字 uid（昵称只是展示名）
    const ident: { screenName: string; displayName: string | null } = platform === 'twitter'
      ? { screenName: (account as XAccount).screenName, displayName: (account as XAccount).displayName }
      : { screenName: (account as WeiboAccount).uid, displayName: (account as WeiboAccount).nickname };
    const post: PostCandidate = {
      platform,
      accountId: account.id,
      screenName: ident.screenName,
      displayName: ident.displayName,
      type: p.type ?? (platform === 'weibo' ? 'mblog' : 'tweet'),
      text: p.text ?? null,
      pics: p.pics ?? [],
      pubTs: p.pubTs ?? 0,
      url: p.url ?? null,
      ...(p.isQuote !== undefined ? { isQuote: p.isQuote } : {}),
      biliName: bili ? (bili.alias || bili.uname) : null,
    };
    const label = postAuthorName(post);

    const hits = matchPostRules(db.listEnabledPostRules(), post);
    if (hits.length === 0) {
      log.info(`不推送 ${label}: 无命中图文帖规则`);
      return;
    }

    // LLM 判定 / 翻译（规则级，默认关）：判定语义 = 「这条规则是否还贡献渠道」——
    // 开了判定且模型说不推的规则不贡献渠道（与「命中规则独立生效、渠道取并集」一致），
    // 没开判定的规则照常贡献。LLM 不可用/失败一律按机械筛选放行（post-analyzer 内部处理）。
    const contributing: PostRule[] = [];
    let translated: string | null = null;
    const analyzed = new Map<string, PostAnalysis>();
    for (const r of hits) {
      if (!ruleNeedsLlm(r) || !this.deps.postAnalyzer) {
        contributing.push(r);
        continue;
      }
      // 同（判定标准 + 是否翻译）只调一次 LLM：多数场景就一条这类规则
      const key = `${r.llmJudge ? 1 : 0}|${r.judgePrompt ?? ''}|${r.llmTranslate ? 1 : 0}`;
      let a = analyzed.get(key);
      if (!a) {
        a = await this.deps.queue.run(() => this.deps.postAnalyzer!.analyze(post, r));
        analyzed.set(key, a);
      }
      if (r.llmJudge && a.source === 'llm' && !a.pass) {
        log.info(
          `LLM 判定不推 ${label}（规则 #${r.id}）：${a.reason || '模型未给理由'}`,
        );
        continue;
      }
      contributing.push(r);
      if (r.llmTranslate && a.translation && !translated) translated = a.translation;
    }
    if (contributing.length === 0) {
      log.info(`不推送 ${label}: 命中 ${hits.length} 条规则，但都被 LLM 判定拦下`);
      return;
    }

    const channelIds: number[] = [];
    let templateOverride: string | null = null;
    for (const r of contributing) {
      for (const id of r.channels) {
        if (!channelIds.includes(id)) channelIds.push(id);
      }
      templateOverride ??= r.messageTemplate;
    }
    if (channelIds.length === 0) {
      log.info(`不推送 ${label}: 命中 ${hits.length} 条规则但都未勾选渠道`);
      return;
    }

    // 图片必须先落成本地文件再推（NapCat 与本进程同网络，远程 URL 交给它同样拉不到；
    // toast 的 Win32 限制也不支持远程图）。两条路线：
    //  · X 图床（pbs.twimg.com）墙内直连不通 → 走代理隧道下载；
    //  · 微博图床（sinaimg.cn）境内直连可达 → 普通 fetch，不给代理链路添无关流量。
    // 下载失败按无图发，不阻塞通知。
    let image: string | undefined;
    if (post.pics.length > 0 && this.deps.imageCacheDir) {
      image = (platform === 'twitter'
        ? await localizeImageViaProxy(post.pics[0]!, this.deps.imageCacheDir, getXConfig(db).proxyUrl)
        : await localizeImage(post.pics[0]!, this.deps.imageCacheDir)) ?? undefined;
    }

    const tpl = templateOverride ?? defaultPostTitle(post);
    const msg: PushMessage = {
      ...postToMessage({ post, title: renderPostTemplate(tpl, post), image, translation: translated }),
      channels: channelIds.map(String),
    };
    log.info(
      `推送 feed_post ${label} — 命中规则 ${contributing.map((r) => `#${r.id}`).join('/')}` +
      (translated ? '（含译文）' : ''),
    );
    await dispatcher.broadcast(msg);
  }

  private async handleHealthAlert(signal: Signal): Promise<void> {
    const p = signal.payload as HealthAlertPayload | undefined;
    // QQ 告警政策：登录掉线立即报；连续失败满 10 分钟的二次告警（durationAlert）才报
    // ——次数阈值的告警通常是网络波动，只发本机 toast。告警 QQ 留空 = 全不发。
    const toQq = p?.alertKind === 'login_drop' || p?.durationAlert === true;
    const qqTarget = toQq ? getNapcatAlertQq(this.deps.db) : '';
    await this.deps.dispatcher.alertAll(
      'DD-claw 监听异常',
      p?.message ??
        `连续 ${p?.failures ?? 0} 次拉取B站接口失败。\n` +
        `这是批量接口，**全部 ${p?.subscriptions ?? 0} 个订阅都收不到开播通知**。\n` +
        (p?.durationSec ? `已持续失败约 ${Math.round(p.durationSec / 60)} 分钟。\n` : '') +
        `最后错误: ${p?.lastError ?? '(未知)'}`,
      qqTarget || undefined,
    );
  }
}
