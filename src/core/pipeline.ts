import { makeLogger } from '../logger.js';
import { readFile } from 'node:fs/promises';
import { toLiveEvent, type LiveEvent, type PushMessage, type Signal } from './types.js';
import { liveEventToMessage, postToMessage } from '../notify/message.js';
import {
  aggregateRuleHits, defaultPostTitle, matchRules, postAuthorName,
  renderPostTemplate, renderTemplate,
  type PostCandidate,
} from '../analysis/matcher.js';
import { isPushEnabled, liveVerdictSubjectId, postVerdictSubjectId, postSubjectRef, type PushRule, type SubjectKind } from './push.js';
import { getNapcatAlertQq } from '../notify/napcat.js';
import { localizeImage, localizeImageViaProxy } from '../notify/image-cache.js';
import { createLimiter, mapLimit } from './concurrency.js';
import type { PushAudit } from './content-audit.js';
import type { BroadcastOutcome } from '../notify/dispatcher.js';
import type { PostAnalyzer } from '../analysis/post-analyzer.js';
import type { XAccount } from './x-accounts.js';
import type { WeiboAccount } from './weibo-accounts.js';
import type { BiliAccount } from './bili-accounts.js';
import { getXConfig } from './x-config.js';
import { isNotifyOnFirstRun, isNotifyOnNewSubscription } from './runtime-config.js';
import type { Bus } from './bus.js';
import type { Db } from './db.js';
import type { AppConfig } from '../config/schema.js';
import type { AnalysisQueue } from '../analysis/queue.js';
import type { AnalysisContext, Classification } from '../analysis/types.js';
import type { DecisionRule } from '../rules/types.js';
import type { NotifyDispatcher } from '../notify/dispatcher.js';
import { platformSupportsTranslate } from './post-rules.js';

const log = makeLogger('core/pipeline');

/** 同时处理多少个信号的推送。够覆盖同时开播的常见规模，又不至于打爆 NapCat。 */
const NOTIFY_CONCURRENCY = 4;

/**
 * 「推送等不等判定」规则级化（A.4）的判据：存在**引用了分类的启用规则**且其 scope 覆盖
 * 本内容（scope 空 = 全部生效）→ 推送要等判定结果；否则推送不排在 LLM 后面。
 */
function hasCoveringCategoryRule(
  rules: PushRule[],
  subjectKind: SubjectKind,
  subjectRef: string,
): boolean {
  return rules.some((r) =>
    r.subjectKind === subjectKind
    && r.categoryId !== null
    && (r.scope.length === 0 || r.scope.includes(subjectRef)));
}

export interface PipelineDeps {
  bus: Bus;
  db: Db;
  config: AppConfig;
  queue: AnalysisQueue;
  rule: DecisionRule;
  dispatcher: NotifyDispatcher;
  /** 图片本地化缓存目录（X 图必须经代理下载成本地文件再推）；缺省 = 图文帖不带图 */
  imageCacheDir?: string;
  /** 图文帖翻译（命中规则的 llmTranslate 附加动作）；缺省 = 不附译文 */
  postAnalyzer?: PostAnalyzer;
}

/** feed_post 的载荷形状（X / 微博 / B站动态三源同形，platform 决定账号解释域，见 handleFeedPost） */
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
  private readonly sendLimited = createLimiter(NOTIFY_CONCURRENCY);
  private readonly imageLimited = createLimiter(NOTIFY_CONCURRENCY * 3);
  private readonly sendingSessions = new Set<string>();
  private readonly handlingSessions = new Set<string>();

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
    if (s.kind === 'live_start' && s.status) {
      const session = liveVerdictSubjectId(s.roomId, s.status.liveTime);
      if (this.handlingSessions.has(session)) return;
      this.handlingSessions.add(session);
    }
    this.pending.push(s);
    this.drain();
  }

  private drain(): void {
    while (this.pending.length > 0) {
      const s = this.pending.shift()!;
      this.active++;
      void this.handle(s)
        .catch((e) => {
          log.error(`处理信号 [${s.kind}] 异常`, e);
          const subject = this.auditSubject(s);
          if (subject) {
            const previous = this.deps.db.getContentAudit(subject.kind, subject.id);
            this.auditPush(s, { status: 'failed', reason: String(e),
              rules: previous?.push?.rules ?? [], channels: previous?.push?.channels ?? [] });
          }
        })
        .finally(() => {
          if (s.kind === 'live_start' && s.status) this.handlingSessions.delete(liveVerdictSubjectId(s.roomId, s.status.liveTime));
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

  private auditSubject(signal: Signal): { kind: SubjectKind; id: string } | null {
    if (signal.kind === 'live_start' && signal.status) {
      return { kind: 'live', id: liveVerdictSubjectId(signal.roomId, signal.status.liveTime) };
    }
    const payload = signal.payload as FeedPostPayload | undefined;
    if (signal.kind === 'feed_post' && payload?.itemId && payload.platform) {
      return { kind: 'post', id: postVerdictSubjectId(payload.platform, payload.itemId) };
    }
    return null;
  }

  private auditPush(signal: Signal, audit: PushAudit): void {
    const subject = this.auditSubject(signal);
    if (subject) this.deps.db.recordContentAudit(subject.kind, subject.id, 'push', audit);
  }

  private analyze(context: AnalysisContext): Promise<Classification[]> {
    const subject = this.auditSubject(context.signal);
    if (subject) this.deps.db.recordContentAudit(subject.kind, subject.id, 'analysis', {
      status: 'pending', categories: [], results: [], imageCount: context.post?.imageDataUrls?.length,
    });
    return this.deps.queue.submit(context).catch((error: unknown) => {
      if (subject) {
        const previous = this.deps.db.getContentAudit(subject.kind, subject.id)?.analysis;
        this.deps.db.recordContentAudit(subject.kind, subject.id, 'analysis', {
          ...previous, status: 'failed', categories: previous?.categories ?? [], results: previous?.results ?? [], error: String(error),
        });
      }
      log.error('内容分析异常', error);
      return [];
    });
  }

  private auditRules(signal: Signal, kind: SubjectKind, ref: string, matched: Set<number>, rules: PushRule[]): PushAudit {
    const hits = matchRules(rules.filter((entry) => entry.enabled), { subjectType: kind }, matched, ref);
    const channelIds = new Set(hits.flatMap((entry) => entry.channels));
    const audit: PushAudit = { status: 'pending', reason: '等待渠道发送',
      rules: rules.filter((entry) => entry.subjectKind === kind).map((entry) => ({
        id: entry.id, name: entry.name, configuration: entry, matched: hits.includes(entry),
        reason: !entry.enabled ? '规则已停用'
          : entry.scope.length > 0 && !entry.scope.includes(ref) ? '内容不在生效范围'
          : entry.categoryId !== null && !matched.has(entry.categoryId) ? '未命中引用分类'
          : '规则命中',
      })),
      channels: this.deps.db.listPushChannels().filter((entry) => channelIds.has(entry.id))
        .map(({ id, name, enabled }) => ({ id, name, enabled })),
    };
    if (hits.length === 0 || channelIds.size === 0) {
      audit.status = 'skipped';
      audit.reason = hits.length === 0 ? '无命中规则' : '命中规则未选择渠道';
    }
    this.auditPush(signal, audit);
    return audit;
  }

  private auditOutcome(signal: Signal, audit: PushAudit, outcome: BroadcastOutcome, title: string): void {
    this.auditPush(signal, { ...audit, title, deliveries: outcome.deliveries,
      status: outcome.dryRun ? 'dry-run' : outcome.total === 0 ? 'skipped' : !outcome.anySuccess ? 'failed'
        : outcome.succeeded < outcome.total ? 'partial' : 'sent',
      reason: outcome.dryRun ? '演练模式，未实际发送'
        : outcome.total === 0 ? '没有启用的发送渠道'
        : `发送完成：${outcome.succeeded}/${outcome.total} 成功`,
    });
  }

  private async handle(signal: Signal): Promise<void> {
    if (signal.kind === 'health_alert') return this.handleHealthAlert(signal);
    // 图文帖（X / 微博 / B站动态）：与开播平行的分类与推送路径
    if (signal.kind === 'feed_post') return this.handleFeedPost(signal);
    if (!signal.status) {
      log.debug(`忽略无状态的信号 [${signal.kind}]（${signal.source}）`);
      return;
    }

    const { db, rule, dispatcher } = this.deps;
    const event = toLiveEvent(signal.status, this.aliasOf(signal.uid));
    this.auditPush(signal, { status: 'pending', reason: '等待处理', rules: [], channels: [] });

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
      this.auditPush(signal, { status: 'skipped', reason: '首次运行已在播，按恢复设置不推送', rules: [], channels: [] });
      log.debug(`不推送 [${signal.kind}] ${event.uname || event.alias}: 首次运行已在播，按配置不推送`);
      return;
    }
    // 重启恢复：上次下播、本次启动前开播的主播，无法得知真实开播时间，
    // 与 first_run 同属「启动时已在播」，共用 notifyOnFirstRun 这一个开关。
    if (signal.coldStart === 'restart_recovery' && !isNotifyOnFirstRun(db)) {
      this.auditPush(signal, { status: 'skipped', reason: '停机期间开播，按恢复设置不推送', rules: [], channels: [] });
      log.debug(`不推送 [${signal.kind}] ${event.uname || event.alias}: 停机期间开播（启动时已在播），按配置不推送`);
      return;
    }
    if (signal.coldStart === 'new_subscription' && !isNotifyOnNewSubscription(db)) {
      this.auditPush(signal, { status: 'skipped', reason: '新增订阅正在直播，按恢复设置不推送', rules: [], channels: [] });
      log.debug(`不推送 [${signal.kind}] ${event.uname || event.alias}: 新增订阅正在直播，按配置不推送`);
      return;
    }

    // 推送总开关（面板推送卡右上角）：关 = 全局不推，追踪照常
    if (!isPushEnabled(db)) {
      this.auditPush(signal, { status: 'skipped', reason: '推送总开关关闭', rules: [], channels: [] });
      log.debug(`不推送 [${signal.kind}] ${event.uname || event.alias}: 推送总开关已关`);
      return;
    }

    // 分类判定只在 live_start 做（live_end / title_change 不烧 LLM），每场单次：
    // 判定结果进规则匹配：推送规则按 categoryId 引用分类（buildMessage）。
    // **推送等不等判定（A.4 规则级化）**：仅当存在「引用了分类的启用规则且 scope 覆盖本主播」
    // 时推送才等判定；纯「任意内容」规则的推送不再排在 LLM 后面。判定本身照跑（时间线/verdicts
    // 的回看面不变），不等时先推后收——绝不产生双推（分类规则只在匹配那一刻生效一次）。
    const rules = db.listPushRules();
    const clsPromise = signal.kind === 'live_start'
      ? this.analyze({ event, signal })
      : Promise.resolve([] as Classification[]);
    const needsWait = hasCoveringCategoryRule(rules.filter((entry) => entry.enabled), 'live', event.uid);
    const classifications = needsWait ? await clsPromise : [];
    const decision = await rule.decide({ ...event, classifications }, signal, classifications);

    if (!decision.shouldNotify) {
      this.auditPush(signal, { status: 'skipped', reason: decision.reason, rules: [], channels: [] });
      if (!needsWait) await clsPromise;
      log.debug(`不推送 [${signal.kind}] ${event.uname || event.alias}: ${decision.reason}`);
      return;
    }

    const audit = this.auditRules(signal, 'live', event.uid, new Set(classifications.map((entry) => entry.categoryId)), rules);
    const msg = this.buildMessage({ ...event, classifications }, rules.filter((entry) => entry.enabled));
    if (!msg) {
      if (!needsWait) await clsPromise;
      return; // buildMessage 已记日志（规则不命中 / 规则未选渠道）
    }

    log.info(`推送 [${signal.kind}] ${event.uname || event.alias} — ${decision.reason}`);
    const sessionKey = liveVerdictSubjectId(event.roomId, event.liveTime);
    if (this.sendingSessions.has(sessionKey) || (signal.kind === 'live_start' && db.hasNotified(event.roomId, event.liveTime))) {
      if (!needsWait) await clsPromise;
      return;
    }
    this.sendingSessions.add(sessionKey);
    let outcome: BroadcastOutcome;
    try {
      outcome = await this.sendLimited(() => dispatcher.broadcast(msg));
      if (outcome.anySuccess && signal.kind === 'live_start') db.markNotified(event.roomId, event.liveTime);
    } finally {
      this.sendingSessions.delete(sessionKey);
    }
    this.auditOutcome(signal, audit, outcome, msg.title);
    // 不等判定的路径：推完再收判定（verdicts 落库收尾，whenIdle 覆盖到）
    if (!needsWait) await clsPromise;
  }

  /**
   * 推送规则 → PushMessage；返回 null = 不推（命中集合渠道并集为空 / 无命中规则）。
   * - 命中 = matchRules（两形态统一：分类引用 × scope）；所有命中规则独立生效，
   *   聚合（渠道并集 + 首个非空推送词）走 `aggregateRuleHits`；并集为空 = 用户明确不推（记 log 不推）
   * - 无命中规则（含一条都没有）= 不推——「任意内容 × 全部主播」规则即旧全局默认的等价物，
   *   需要兜底推送的用户自建一条即可
   * - 模板：规则覆盖 > 内置默认 '{liver} 开播了'；正文/图片/跳转沿用默认形状
   */
  private buildMessage(event: LiveEvent, rules: PushRule[]): PushMessage | null {
    const base = liveEventToMessage(event);
    const hits = matchRules(
      rules, { subjectType: 'live' },
      new Set(event.classifications.map((c) => c.categoryId)),
      event.uid,
    );

    if (hits.length === 0) {
      log.info(`不推送 ${event.uname || event.alias}: 无命中规则`);
      return null;
    }
    const agg = aggregateRuleHits(hits);
    if (!agg) {
      log.info(`不推送 ${event.uname || event.alias}: 命中 ${hits.length} 条规则但都未勾选渠道`);
      return null;
    }
    log.info(`命中推送规则 ${hits.map((r) => `#${r.id}`).join('/')}（${event.uname || event.alias}）`);

    const tpl = agg.template ?? '{liver} 开播了';
    const text = renderTemplate(tpl, event).trim();
    return { ...base, title: text || base.title, channels: agg.channels.map(String) };
  }

  /**
   * 图文帖（feed_post）路径：判定分类制（与 live_start 同走判决链）→ matchRules → 带图推送。
   * 与开播路径完全平行：
   *  · 不过决策规则（`OncePerSessionRule` 是「每场直播推一次」那类防抖，帖子没有场次概念，
   *    去重由 posts 的 UNIQUE(platform,item_id) 兜住）；
   *  · 不过冷启动抑制（帖子不是「启动时已在播」那种状态，首轮由 source 静默归档挡住）；
   *  · 三个平台走同一条分支：账号在各自名单里查（X→x_accounts / 微博→weibo_accounts /
   *    B站动态→bili_accounts），规则统一在 push_rules（subject_kind='post'）——命中 =
   *    分类判定 × 规则 scope（`matchRules`），平台差异只在文案措辞、quote 语义与翻译门控上体现。
   *  · 判定每帖单次（verdicts 落真实 categoryId、ruleId=0 哨兵；LLM 判否也落 pass=0 供
   *    「为什么没推」回看）；推送等不等判定与 live 同一条规则级判据（hasCoveringCategoryRule），
   *    不产生双推。
   */
  private async handleFeedPost(signal: Signal): Promise<void> {
    const { db, dispatcher } = this.deps;
    const p = signal.payload as FeedPostPayload | undefined;
    const platform = p?.platform === 'weibo' ? 'weibo'
      : p?.platform === 'twitter' ? 'twitter'
      : p?.platform === 'bili_dynamic' ? 'bili_dynamic'
      : null;
    if (!p || !platform) {
      log.debug(`忽略 feed_post（平台 ${p?.platform ?? '未知'}）：只支持 twitter / weibo / bili_dynamic`);
      return;
    }
    this.auditPush(signal, { status: 'pending', reason: '等待处理', rules: [], channels: [] });
    if (!isPushEnabled(db)) {
      this.auditPush(signal, { status: 'skipped', reason: '推送总开关关闭', rules: [], channels: [] });
      log.debug(`不推送 feed_post ${signal.uid}: 推送总开关已关`);
      return;
    }
    // 账号解析：uid 的解释域按平台不同（X=screen name / 微博与B站动态=数字 uid）
    const account = platform === 'twitter'
      ? db.getXAccountByScreenName(signal.uid)
      : platform === 'weibo'
        ? db.getWeiboAccountByUid(signal.uid)
        : db.getBiliAccountByUid(signal.uid);
    if (!account) {
      this.auditPush(signal, { status: 'skipped', reason: '账号已不在监听名单', rules: [], channels: [] });
      // 三条源的名单与抓取同源，正常不会走到这里（B站动态源只对名单内且开关开着的账号发
      // 信号）；留着当防御分支，X/微博查不到值得 warn
      if (platform === 'bili_dynamic') {
        log.debug(`忽略 feed_post：${signal.uid} 不在 bili_accounts 名单`);
      } else {
        log.warn(`feed_post 来自不在${platform === 'weibo' ? '微博' : 'X'}名单里的账号 ${signal.uid}，忽略`);
      }
      return;
    }
    // 关联主播（{liver}）：动态账号本身就是 B站 uid，直接按 uid 查；
    // X/微博账号走可选关联 biliUid
    const biliUid = platform === 'bili_dynamic'
      ? (account as BiliAccount).uid
      : (account as XAccount | WeiboAccount).biliUid;
    const bili = biliUid ? db.getStreamer(biliUid) : undefined;
    // 三个账号类型只在「标识字段叫什么名字」上不同：X 是 screen name / 微博与B站是数字 uid；
    // 展示名同一条链：自定义显示名 → 平台昵称/用户名（再缺省由渲染层回退标识本身）
    const ident: { screenName: string; displayName: string | null } = platform === 'twitter'
      ? { screenName: (account as XAccount).screenName, displayName: (account as XAccount).displayName ?? (account as XAccount).nickname }
      : platform === 'weibo'
        ? { screenName: (account as WeiboAccount).uid, displayName: (account as WeiboAccount).displayName ?? (account as WeiboAccount).nickname }
        : { screenName: (account as BiliAccount).uid, displayName: (account as BiliAccount).displayName ?? (account as BiliAccount).uname };
    const post: PostCandidate = {
      platform,
      itemId: p.itemId ?? '',
      accountId: account.id,
      screenName: ident.screenName,
      displayName: ident.displayName,
      // type 已在各 source 归一（B站 FORWARD → 'retweet'，见 sources/bili/dynamic.ts）；
      // 这里的平台缺省只是防御（信号不该缺 type）
      type: p.type ?? (platform === 'weibo' ? 'mblog' : platform === 'bili_dynamic' ? 'dynamic' : 'tweet'),
      text: p.text ?? null,
      pics: p.pics ?? [],
      pubTs: p.pubTs ?? 0,
      url: p.url ?? null,
      ...(p.isQuote !== undefined ? { isQuote: p.isQuote } : {}),
      biliName: bili ? (bili.alias || bili.uname) : null,
    };
    const label = postAuthorName(post);

    // 图片先落本地文件：推送要带图，分类判定也要看图（「只推自拍」这类标准只看文字判不出来）。
    // X 图床（pbs.twimg.com）墙内直连不通，NapCat / LLM provider 都拉不到远程 URL ——
    // 唯一可行形态是先经代理隧道下载到本地，推送发本地文件、LLM 发 base64 data URL。
    // 有图的帖全图都下，每张独立容错、失败的单张跳过；全部失败按无图走，不阻塞通知。
    // 微博图床（sinaimg.cn）与B站图床（hdslb.com）境内直连可达 → 普通 fetch，不给代理链路添无关流量。
    // （判定分类制后判定也吃配图，故本地化提到判定之前；条件与容错纪律不变）
    let images: string[] | undefined;
    let imageDataUrls: string[] | undefined;
    if (post.pics.length > 0 && this.deps.imageCacheDir) {
      const proxyUrl = getXConfig(db).proxyUrl;
      const downloaded = await mapLimit(post.pics, 3, (pic) => this.imageLimited(() =>
        platform === 'twitter'
          ? localizeImageViaProxy(pic, this.deps.imageCacheDir!, proxyUrl)
          : localizeImage(pic, this.deps.imageCacheDir!)));
      const ok = downloaded.filter((p): p is string => p != null);
      if (ok.length > 0) {
        images = ok;
        imageDataUrls = await toDataUrls(ok);
      }
    }

    // 判定（A.4 判定分类制）：对 applies_to='post' 的启用分类逐个判定（判决链，verdicts
    // 由分类器落）。推送等不等判定规则级化（与 live 同一条判据）：有引用分类的启用规则
    // 覆盖本账号才等；否则推送不排在 LLM 后面（判定照跑，收尾时 await，不产生双推）。
    const allRules = db.listPushRules();
    const rules = allRules.filter((entry) => entry.enabled);
    const subjectRef = postSubjectRef(platform, post.screenName);
    const needsWait = hasCoveringCategoryRule(rules, 'post', subjectRef);
    const clsPromise = this.analyze({ signal, post: { post, imageDataUrls } });
    const matched = needsWait
      ? new Set((await clsPromise).map((c) => c.categoryId))
      : new Set<number>();

    const hits = matchRules(rules, { subjectType: 'post' }, matched, subjectRef);
    const audit = this.auditRules(signal, 'post', subjectRef, matched, allRules);
    if ((images?.length ?? 0) < post.pics.length) {
      audit.imageWarning = `帖子有 ${post.pics.length} 张图片，本地化成功 ${images?.length ?? 0} 张；分类视觉输入 ${imageDataUrls?.length ?? 0} 张`;
      this.auditPush(signal, audit);
    }
    if (hits.length === 0) {
      if (!needsWait) await clsPromise;
      log.info(`不推送 ${label}: 无命中规则`);
      return;
    }

    const agg = aggregateRuleHits(hits);
    if (!agg) {
      if (!needsWait) await clsPromise;
      return;
    }

    // 翻译（规则附加动作，D3）：命中规则聚合后任一开 llm_translate 且平台支持时调一次生成；
    // 失败不挡推送（post-analyzer 内部降级为不附译文）
    let translated: string | null = null;
    if (this.deps.postAnalyzer && hits.some((r) => r.llmTranslate) && platformSupportsTranslate(platform)) {
      const t = await this.deps.queue.run(() => this.deps.postAnalyzer!.translate(post));
      translated = t.translation;
      if (t.source === 'fallback') audit.translationWarning = t.error ?? 'LLM 不可用或翻译失败，本次未附译文';
    }

    const tpl = agg.template ?? defaultPostTitle(post);
    const msg: PushMessage = {
      ...postToMessage({ post, title: renderPostTemplate(tpl, post), images, translation: translated }),
      channels: agg.channels.map(String),
    };
    log.info(
      `推送 feed_post ${label} — 命中规则 ${hits.map((r) => `#${r.id}`).join('/')}` +
      (translated ? '（含译文）' : ''),
    );
    const outcome = await this.sendLimited(() => dispatcher.broadcast(msg));
    this.auditOutcome(signal, audit, outcome, msg.title);
    if (!needsWait) await clsPromise;
  }

  private async handleHealthAlert(signal: Signal): Promise<void> {
    const p = signal.payload as HealthAlertPayload | undefined;
    // QQ 告警政策：登录掉线立即报；故障持续满 10 分钟的二次告警（durationAlert）才报
    // ——toast 阈值的告警通常是网络波动，只发本机 toast。告警 QQ 留空 = 全不发。
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

/** 一次喂给 vision 模型的配图上限（微博/B站动态最多 9 张，全带） */
const MAX_VISION_IMAGES = 9;

/** 本地图片 → base64 data URL（LLM provider 拉不到墙内/外的远程图床，只认随请求带过去的字节）；读失败的单张跳过 */
async function toDataUrls(paths: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of paths.slice(0, MAX_VISION_IMAGES)) {
    try {
      const buf = await readFile(p);
      const mime = p.endsWith('.png') ? 'image/png' : p.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      out.push(`data:${mime};base64,${buf.toString('base64')}`);
    } catch { /* 单张读失败跳过，剩下的照常带 */ }
  }
  return out;
}
