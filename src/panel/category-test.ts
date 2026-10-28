/**
 * 分类试判（面板 `GET /api/categories/samples` → `sample_category_records`，
 * `POST /api/categories/test` → `test_category`）。
 *
 * 两段式：先**抽样**（只回样本摘要），用户挑几条后再**试判**（把这些 `subjectId` 原样传回来复测）。
 * 用户在前端选中的必须是同一条历史内容，所以第二段可以用 `sampleIds` 精确锚定——否则重跑一次
 * 又会随机抽到别的样本，用户看到的结论和挑的那条对不上。
 *
 * 第一段（抽样）边界：只读库 + 投影摘要，**不下图、不调模型、不写库**；也不需要分类草稿
 * （只校验 `kind` + 过滤面），连图像缓存目录都不碰。抽样池**只收能带图的记录**
 * （live 有关键帧或封面、post 的 pics 非空）：列表要显示缩略图，抽到无图记录那一行只能空着。
 *
 * 第二段（试判）：拿**真实归档**的样本，把「确定性条件 / LLM / 决策模型」三档**各自独立**跑一遍：
 * 面板要看的是「这条还没保存的分类，落到历史内容上判得像不像」，所以样本必须是真的。
 *
 * 边界（不可破坏）：
 * - **不写库**：不落 verdicts / primary_verdicts / content_audit，也不建分类行——草稿只在内存里，
 *   合成 id 是负数（0 是「不适用 / 其他」哨兵，真实分类 id 是正整数，负数不会撞上）。
 * - **不推送**：不经规则匹配、不进 dispatcher。
 * - **三档互不降级**：rule 只吃确定性条件；llm / decision 各自直问自己的通道，
 *   任一档不可用只影响自己那一行（线上「模型不可用就回退确定性」的链式语义在这里刻意不成立——
 *   试跑要用来看每一档单独的结论）。
 * - **模型调用经共享 `AnalysisQueue.run()`**：与线上判定同一条并发闸门，绝不直调 provider；
 *   样本**逐条串行**，一次试跑不会同时占满队列。
 * - **图片与线上同口径**：live 取 keyframe || cover（一张）、post 取全部配图，先本地化到缓存目录
 *   再经 `prepareImageFiles` 规范化；X 图必须走代理隧道（`pbs.twimg.com` 直连不通）。
 *   失败的图逐张进 `skippedImages`。
 * - **回给调用方的图只有一个源图地址**：摘要的 `image`（列表缩略图用，就是 `pending[0]`）。
 *   其余图床 URL 与**全部** data URL 都不回——`skippedImages` 只有位序标签与原因。
 *   X 的 `image` 直连不通，面板经 `GET /api/category-sample-image`（同 dep 挂载）反代成字节。
 */
import { basename } from 'node:path';
import type { Db, SampledLiveSession } from '../core/db.js';
import { SAMPLE_LIMIT_MAX } from '../core/db.js';
import type { Post } from '../core/posts.js';
import type { Category, SubjectKind } from '../core/push.js';
import { hasJudgeBasis } from '../core/push.js';
import type { XAccount } from '../core/x-accounts.js';
import type { WeiboAccount } from '../core/weibo-accounts.js';
import type { BiliAccount } from '../core/bili-accounts.js';
import { POST_PLATFORMS, type PostPlatform } from '../core/post-rules.js';
import { toLiveEvent, type LiveStatus } from '../core/types.js';
import { mapLimit } from '../core/concurrency.js';
import { fromLiveEvent, fromPostCandidate, type ContentItem } from '../analysis/content.js';
import { decisionJudge, llmJudge, ruleConclusion, type JudgeContext } from '../analysis/classifier.js';
import type { DecisionRouter } from '../analysis/decision-router.js';
import type { LlmRouter } from '../analysis/providers.js';
import { prepareImageFiles, type PreparedImages } from '../analysis/image-prep.js';
import type { DecisionThresholds } from '../analysis/tasks/decide.js';
import type { ConditionResult } from '../analysis/types.js';
import type { PostCandidate } from '../analysis/matcher.js';
import { localizeImage, localizeImageViaProxy } from '../notify/image-cache.js';
import { HttpError, parseNewCategory } from './http-util.js';

/** 草稿分类的合成 id：0 是「不适用 / 其他」哨兵，真实分类 id 恒为正整数，负数两边都不撞 */
const DRAFT_CATEGORY_ID = -1;

/** 草稿没填名字时的展示名（只进 prompt 与证据文案，不落库） */
const DRAFT_CATEGORY_NAME = '草稿分类';

/** 三档的来源标识（响应里 `results` 按 rule / llm / decision 的相对顺序返回所选档） */
export type CategoryTestSource = 'rule' | 'llm' | 'decision';
const CATEGORY_TEST_SOURCES: readonly CategoryTestSource[] = ['rule', 'llm', 'decision'];

/**
 * 单档结论：
 * - `ok` 有结论（`pass` 非空）
 * - `unavailable` 该档不可用 / 失败（开关关、没配 provider、调用或解析失败），`reason` 是回调原因
 * - `skipped` 该档不适用（分类没有模型判定口径 → 两个模型档都不问）
 */
export type CategoryTestStatus = 'ok' | 'unavailable' | 'skipped';

export interface CategoryTestTier {
  source: CategoryTestSource;
  status: CategoryTestStatus;
  /** 该档结论：属于 = true；skipped / unavailable = null */
  pass: boolean | null;
  /** 仅决策档有 P(属于)（simple 分类）；精确模式不合成伪最终概率，恒 null */
  confidence: number | null;
  /** 是否定案：决策档灰区（或纯文本供应商没看图）有结论但不定案 */
  decided: boolean;
  evidence: string | null;
  /** skipped / unavailable 的原因（`ok` 时 null） */
  reason: string | null;
  /** 精确模式的逐条件概率（只有决策档、只有精确分类有；simple 分类不出现这个键） */
  conditionResults?: ConditionResult[];
}

/**
 * 样本摘要（**不含任何判定结果**）：抽样端点（`GET /api/categories/samples`）原样回它，
 * 复测请求把它拿到的 `subjectId` 原样传回来当锚点。字段与判定输入同形（`analysis/content.ts` 的
 * 投影），所以「抽到的摘要」与「复测时判定的内容」是同一份事实。
 */
export interface CategoryTestSampleSummary {
  subjectType: SubjectKind;
  /** 身份键（= verdicts.subject_id）：live=`roomId:liveTime` / post=`platform:itemId` */
  subjectId: string;
  uid: string;
  authorName: string;
  /**
   * 列表缩略图的**源图地址**：live = keyframe || cover，post = 第一张配图；没有图 = null。
   * X 图（`pbs.twimg.com`）浏览器直连不通，要经 `GET /api/category-sample-image?url=` 反代显示。
   */
  image: string | null;
  text: string;
  tags: Record<string, string>;
  url: string;
  ts: number;
}

export interface CategoryTestSample extends CategoryTestSampleSummary {
  /** 视觉输入张数（= 规范化后仍在的 data URL 数，与线上审计同一口径） */
  imageCount: number;
  /** 被拦下的图逐张带原因（下载失败 / 解码失败 / 超过张数上限…） */
  skippedImages: Array<{ ref: string; reason: string }>;
  /** 只含本次所选档，按 rule → llm → decision 的相对顺序排列 */
  results: CategoryTestTier[];
}

export interface CategoryTestResponse {
  samples: CategoryTestSample[];
}

/** 抽样响应：只有摘要，没有判定（抽样不下图、不调模型、不写库） */
export interface CategorySampleResponse {
  samples: CategoryTestSampleSummary[];
}

/** 请求过滤面（uid 的解释域随分类类型：live = 主播 uid，post = 账号标识） */
export interface CategoryTestFilter {
  uid?: string;
  /** 仅 post 生效（live 分类忽略——直播场次没有平台维度） */
  platform?: PostPlatform;
  fromTs?: number;
  toTs?: number;
  /** 样本条数（1~SAMPLE_LIMIT_MAX，缺省 10） */
  limit: number;
}

export interface CategoryTestRequest {
  /** 已校验、已补默认值的草稿；`id` 是合成负数（0 是哨兵），未落库 */
  category: Category;
  /** 草稿过滤面；给了 `sampleIds` 时被忽略（复测只认锚点，不重新随机） */
  filter: CategoryTestFilter;
  /** 本次要执行的判定档；请求缺省时由解析器补为全部三档 */
  sources: CategoryTestSource[];
  /**
   * 复测锚点（可选）：抽样端点给出的 `subjectId`，按给定顺序**逐条精确**加载，
   * 不重新随机、不套 filter。1~SAMPLE_LIMIT_MAX 条且不重复。
   */
  sampleIds?: string[];
}

/** 一张待送模型的远程图：`ref` 是回填 skippedImages 的稳定标签（不暴露图床 URL） */
export interface PendingImage {
  ref: string;
  url: string;
  /** X 图床必须走代理隧道，微博 / B站图床境内直连 */
  viaProxy: boolean;
}

/**
 * 图片加载注入点：缺省实现走「本地化 → prepareImageFiles」（与 pipeline 同一条口径）；
 * 测试注入它就不必联网，也不会碰 sharp 的解码路径。
 */
export type ImageLoader = (images: PendingImage[]) => Promise<PreparedImages>;

/** 分析队列的最小面（共享并发闸门）；`AnalysisQueue` 天然满足，测试可传直通实现 */
export interface AnalysisGate {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * X 图拉取注入点（`GET /api/category-sample-image` 用）：签名与 `localizeImageViaProxy` 一致，
 * 缺省就是它（经代理隧道下载并按图床 URL 落到 `imageCacheDir`）；测试注入它就不必真联网、也不需代理。
 * 返回本地文件路径，失败 null。
 */
export type XImageLocalizer = (url: string, cacheDir: string, proxyUrl: string) => Promise<string | null>;

/**
 * 试跑依赖面（装配根注入；全是 getter，面板改 provider / 开关 / 门槛后下一次试跑即生效）。
 * `db` 由调用方（注册表 handler）传入，故 `PanelDeps.categoryTest` 的类型是它的 Omit。
 */
export interface CategoryTestDeps {
  db: Db;
  /** 共享分析队列：模型调用一律从这里过（与线上判定同一条闸门） */
  queue: AnalysisGate;
  getRouter: () => LlmRouter | null;
  llmEnabled: () => boolean;
  getDecisionRouter: () => DecisionRouter | null;
  decisionEnabled: () => boolean;
  decisionThresholds: () => DecisionThresholds;
  /** 图片本地化缓存目录；缺省 = 不下图（与线上「没配缓存目录就不下图」同一条前提） */
  imageCacheDir?: string;
  /** X 代理地址 getter（面板改配置后下一次试跑即生效） */
  getProxyUrl: () => string;
  /** 图片加载注入点（测试用）；缺省走 image-cache + image-prep */
  imageLoader?: ImageLoader;
  /** X 图拉的注入点（测试用）；缺省 `localizeImageViaProxy`（代理隧道 + 缓存目录落盘） */
  localizeXImage?: XImageLocalizer;
}

/** 缺省图片加载：与 pipeline 逐字同口径（单图容错、失败记原因、X 走代理） */
export function createImageLoader(cacheDir: string | undefined, getProxyUrl: () => string): ImageLoader {
  return async (images) => {
    if (!cacheDir || images.length === 0) return { dataUrls: [], skipped: [] };
    const dir = cacheDir;
    const paths = await mapLimit(images, 3, (img) => (img.viaProxy
      ? localizeImageViaProxy(img.url, dir, getProxyUrl())
      : localizeImage(img.url, dir)));
    const skipped: Array<{ ref: string; reason: string }> = [];
    const local: Array<{ ref: string; path: string }> = [];
    paths.forEach((path, i) => {
      if (path) local.push({ ref: images[i]!.ref, path });
      else skipped.push({ ref: images[i]!.ref, reason: '下载失败' });
    });
    if (local.length === 0) return { dataUrls: [], skipped };
    const prepared = await prepareImageFiles(local.map((l) => l.path));
    // prepareImageFiles 的 ref 是本地文件名（md5 + 后缀），回填成稳定的位序标签
    const byFile = new Map(local.map((l) => [basename(l.path), l.ref]));
    return {
      dataUrls: prepared.dataUrls,
      skipped: [...skipped, ...prepared.skipped.map((s) => ({ ref: byFile.get(s.ref) ?? s.ref, reason: s.reason }))],
    };
  };
}

// ---- 请求解析 ----

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 草稿校验走 `parseNewCategory`（与新建分类同一套校验与缺省值：条件至少一项、直播/图文算子不许串用），
 * 再把合成 id 与时间戳补上——**不落库**，它只用于 prompt 与结论标注。
 */
export function buildDraftCategory(raw: unknown): Category {
  const c = parseNewCategory(raw ?? {});
  return {
    ...c,
    name: c.name || DRAFT_CATEGORY_NAME,
    id: DRAFT_CATEGORY_ID,
    createdAt: 0,
    updatedAt: 0,
  };
}

function optionalInt(v: unknown, field: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new HttpError(400, `${field} 必须是非负整数（秒级时间戳）`);
  }
  return v;
}

/** 过滤面校验：limit 钳进 1~SAMPLE_LIMIT_MAX，uid 在直播分类下必须是纯数字主播 uid */
export function parseCategoryTestFilter(raw: unknown, appliesTo: SubjectKind): CategoryTestFilter {
  const o = isRecord(raw) ? raw : {};
  const filter: CategoryTestFilter = { limit: 10 };
  if (o.uid !== undefined && o.uid !== null) {
    if (typeof o.uid !== 'string' || o.uid.trim() === '') {
      throw new HttpError(400, 'filter.uid 必须是非空字符串');
    }
    const uid = o.uid.trim();
    if (appliesTo === 'live' && !/^\d+$/.test(uid)) {
      throw new HttpError(400, '直播样本的 filter.uid 必须是纯数字主播 uid');
    }
    filter.uid = uid;
  }
  if (o.platform !== undefined && o.platform !== null) {
    if (typeof o.platform !== 'string' || !(POST_PLATFORMS as readonly string[]).includes(o.platform)) {
      throw new HttpError(400, `filter.platform 必须是 ${POST_PLATFORMS.join(' / ')} 之一`);
    }
    filter.platform = o.platform as PostPlatform;
  }
  const fromTs = optionalInt(o.fromTs, 'filter.fromTs');
  const toTs = optionalInt(o.toTs, 'filter.toTs');
  if (fromTs !== undefined) filter.fromTs = fromTs;
  if (toTs !== undefined) filter.toTs = toTs;
  if (fromTs !== undefined && toTs !== undefined && fromTs > toTs) {
    throw new HttpError(400, 'filter.fromTs 不能晚于 filter.toTs');
  }
  if (o.limit !== undefined && o.limit !== null) {
    if (typeof o.limit !== 'number' || !Number.isInteger(o.limit) || o.limit < 1 || o.limit > SAMPLE_LIMIT_MAX) {
      throw new HttpError(400, `filter.limit 必须是 1~${SAMPLE_LIMIT_MAX} 的整数`);
    }
    filter.limit = o.limit;
  }
  return filter;
}

function parseSources(raw: unknown): CategoryTestSource[] {
  if (raw === undefined || raw === null) return [...CATEGORY_TEST_SOURCES];
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > CATEGORY_TEST_SOURCES.length) {
    throw new HttpError(400, 'sources 必须是包含 1~3 项的数组');
  }
  for (const source of raw) {
    if (typeof source !== 'string' || !(CATEGORY_TEST_SOURCES as readonly string[]).includes(source)) {
      throw new HttpError(400, 'sources 的每一项必须是 rule / llm / decision 之一');
    }
  }
  if (new Set(raw).size !== raw.length) throw new HttpError(400, 'sources 不能重复');
  return CATEGORY_TEST_SOURCES.filter((source) => raw.includes(source));
}

/** 完整请求校验：`{ category, filter, sources?, sampleIds? }`（category 缺省 = 空草稿，由 parseNewCategory 判「至少一项条件」） */
export function parseCategoryTestRequest(body: unknown): CategoryTestRequest {
  const o = isRecord(body) ? body : {};
  for (const k of Object.keys(o)) {
    if (k !== 'category' && k !== 'filter' && k !== 'sources' && k !== 'sampleIds') {
      throw new HttpError(400, `未知字段: ${k}`);
    }
  }
  const category = buildDraftCategory(o.category);
  const sampleIds = parseSampleIds(o.sampleIds);
  return {
    category,
    filter: parseCategoryTestFilter(o.filter, category.appliesTo),
    sources: parseSources(o.sources),
    ...(sampleIds !== undefined ? { sampleIds } : {}),
  };
}

/**
 * 复测锚点校验：1~SAMPLE_LIMIT_MAX 条、非空、**不重复**（顺序即判定顺序，重复项没有意义，
 * 也不想替调用方猜它想跑几次）。缺省 = 没传 = 走原来的随机抽样。
 */
function parseSampleIds(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new HttpError(400, 'sampleIds 必须是字符串数组');
  if (raw.length < 1 || raw.length > SAMPLE_LIMIT_MAX) {
    throw new HttpError(400, `sampleIds 必须是 1~${SAMPLE_LIMIT_MAX} 条`);
  }
  const ids: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string' || v.trim() === '') throw new HttpError(400, 'sampleIds 的每一项必须是非空字符串');
    ids.push(v.trim());
  }
  if (new Set(ids).size !== ids.length) throw new HttpError(400, 'sampleIds 不能重复');
  return ids;
}

/**
 * 抽样请求校验：`{ kind, uid?, platform?, fromTs?, toTs?, limit? }`。
 * **只要 kind 与过滤面**——抽样不看分类草稿（还没有草稿也可能先看样本），与试判的 filter 同一套校验。
 */
export function parseCategorySampleRequest(body: unknown): { kind: SubjectKind; filter: CategoryTestFilter } {
  const o = isRecord(body) ? body : {};
  for (const k of Object.keys(o)) {
    if (k !== 'kind' && k !== 'uid' && k !== 'platform' && k !== 'fromTs' && k !== 'toTs' && k !== 'limit') {
      throw new HttpError(400, `未知字段: ${k}`);
    }
  }
  const kind = o.kind;
  if (kind !== 'live' && kind !== 'post') throw new HttpError(400, 'kind 必须是 live / post');
  return { kind, filter: parseCategoryTestFilter(o, kind) };
}

// ---- 样本 → 内容项（身份键 / 作者 / 标签与线上判定同形）----

/** 直播场次 → 内容项：alias 从 streamers 补（与 pipeline 一致，{liver} 与判定输入同口径） */
function liveSample(db: Db, row: SampledLiveSession): ContentItem {
  const status: LiveStatus = {
    uid: row.uid, roomId: row.roomId, uname: row.uname, title: row.title, isLive: true,
    liveTime: row.liveTime, areaName: row.areaName, parentAreaName: row.parentAreaName,
    cover: row.cover, keyframe: row.keyframe,
  };
  return fromLiveEvent(toLiveEvent(status, db.getStreamer(row.uid)?.alias ?? ''));
}

/** 直播样本要下的图：关键帧优先、缺则封面（与 pipeline liveImages 同一条选择） */
function liveImages(row: SampledLiveSession): PendingImage[] {
  const url = row.keyframe || row.cover;
  if (!url) return [];
  return [{ ref: row.keyframe ? 'keyframe' : 'cover', url, viaProxy: false }];
}

/**
 * X 帖的引用状态：只有免登录回退路线把 `isQuote` 写进了 posts.raw（RSS 路线给不了）。
 * 其余平台一律未知——matcher 的 quote 算子按 unknown 处理（不命中），与线上同语义。
 */
function quoteFromRaw(post: Post): boolean | undefined {
  if (post.platform !== 'twitter' || !post.raw) return undefined;
  try {
    const raw = JSON.parse(post.raw) as { isQuote?: unknown };
    return typeof raw.isQuote === 'boolean' ? raw.isQuote : undefined;
  } catch {
    return undefined;
  }
}

/** 图文帖 → 内容项：账号名单补展示名（与 pipeline 的同一条链），raw 补 X 的 isQuote */
function postSample(db: Db, row: Post): ContentItem {
  const platform = row.platform as PostPlatform;
  // 账号标识的解释域按平台不同：X = screen name（不含 @）/ 微博与B站动态 = 数字 uid
  const account = platform === 'twitter'
    ? db.getXAccountByScreenName(row.uid)
    : platform === 'weibo'
      ? db.getWeiboAccountByUid(row.uid)
      : db.getBiliAccountByUid(row.uid);
  // 展示名链与 pipeline 一致：自定义显示名 → 平台昵称 / 用户名（再缺省由渲染层回退标识本身）
  const platformName = platform === 'bili_dynamic'
    ? (account as BiliAccount | undefined)?.uname
    : (account as XAccount | WeiboAccount | undefined)?.nickname;
  const displayName = account === undefined ? null : (account.displayName ?? platformName ?? null);
  const isQuote = quoteFromRaw(row);
  const candidate: PostCandidate = {
    platform,
    itemId: row.itemId,
    accountId: account?.id ?? 0,
    screenName: row.uid,
    displayName,
    type: row.type,
    text: row.text,
    pics: row.pics,
    pubTs: row.pubTs,
    url: row.url,
    ...(isQuote !== undefined ? { isQuote } : {}),
  };
  return fromPostCandidate(candidate);
}

/** 图文样本要下的图：全部配图（X 走代理），失败的单张跳过不阻塞判定 */
function postImages(row: Post): PendingImage[] {
  return row.pics.map((url, i) => ({
    ref: `pic#${i + 1}`,
    url,
    viaProxy: row.platform === 'twitter',
  }));
}

/** 一条已定位的样本：判定输入 + 待下图 + 摘要（摘要从同一份输入投影，抽样与复测不会漂） */
interface ResolvedSample {
  item: ContentItem;
  pending: PendingImage[];
  summary: CategoryTestSampleSummary;
}

/**
 * 内容项 → 摘要：只留「这条内容是什么」，丢掉判定结果与图片字节。
 * `image` = 本次会送给模型的那张（`pending[0]`）：live 是 keyframe || cover、post 是首张配图，
 * 与线上图片口径同源；随机抽样的池子保证它非空，旧锚点没有图时才是 null。
 */
function summarize(item: ContentItem, pending: PendingImage[]): CategoryTestSampleSummary {
  return {
    subjectType: item.subjectType, subjectId: item.subjectId, uid: item.uid,
    authorName: item.authorName, image: pending[0]?.url ?? null,
    text: item.text, tags: item.tags, url: item.url, ts: item.ts,
  };
}

function resolvedOf(item: ContentItem, pending: PendingImage[]): ResolvedSample {
  return { item, pending, summary: summarize(item, pending) };
}

function liveResolved(db: Db, row: SampledLiveSession): ResolvedSample {
  return resolvedOf(liveSample(db, row), liveImages(row));
}

function postResolved(db: Db, row: Post): ResolvedSample {
  return resolvedOf(postSample(db, row), postImages(row));
}

// ---- 样本定位：随机抽样 / 按 subjectId 精确复读 ----

/**
 * 复测锚点 → 已定位样本。身份键与 verdicts.subject_id 同形（`platform:itemId` / `roomId:liveTime`），
 * 解析规则：第一段是已知图文平台 = 图文帖，第二段是纯数字 = 直播场次；两者都不是 = 非法。
 * 缺失、非法、跨类型一律 400——复测宁可整次失败，也不静默换一条样本让用户比对错东西。
 */
function resolveSample(db: Db, kind: SubjectKind, subjectId: string): ResolvedSample {
  const sep = subjectId.indexOf(':');
  const prefix = sep > 0 ? subjectId.slice(0, sep) : '';
  const rest = sep > 0 ? subjectId.slice(sep + 1) : '';
  if (prefix === '' || rest === '') {
    throw new HttpError(400, `sampleIds 非法: ${subjectId}（应为「平台:itemId」或「roomId:开播时间」）`);
  }
  const isPostRef = (POST_PLATFORMS as readonly string[]).includes(prefix);
  if (kind === 'live') {
    if (isPostRef) throw new HttpError(400, `sampleIds 跨类型: ${subjectId} 是图文帖，本条分类只判直播`);
    if (!/^\d+$/.test(rest)) {
      throw new HttpError(400, `sampleIds 非法: ${subjectId}（直播样本须为「roomId:开播时间戳」）`);
    }
    const row = db.getSampledLiveSession(prefix, Number(rest));
    if (!row) throw new HttpError(400, `样本不存在: ${subjectId}（可能已被清理）`);
    return liveResolved(db, row);
  }
  if (!isPostRef) {
    if (/^\d+$/.test(rest)) throw new HttpError(400, `sampleIds 跨类型: ${subjectId} 是直播场次，本条分类只判图文`);
    throw new HttpError(400, `sampleIds 非法: ${subjectId}（图文样本须为「平台:itemId」）`);
  }
  const row = db.getSampledPost(prefix, rest);
  if (!row) throw new HttpError(400, `样本不存在: ${subjectId}（可能已被清理）`);
  return postResolved(db, row);
}

/**
 * 定位本次要判的样本：
 * - 给了 `sampleIds` → 严格按给定顺序逐条精确加载，**忽略 filter**（不重新随机）；
 *   也不套抽样池的带图条件（旧锚点没有图也照读，`image` 回 null）。
 * - 没给 → 随机抽样：按分类类型 + filter 取样，limit 1~SAMPLE_LIMIT_MAX，
 *   且**只从能带图的记录里抽**（池子口径在 `Db.sample*`）。
 */
function resolveSamples(
  db: Db, kind: SubjectKind, filter: CategoryTestFilter, sampleIds: string[] | undefined,
): ResolvedSample[] {
  if (sampleIds !== undefined) return sampleIds.map((id) => resolveSample(db, kind, id));
  const query = {
    ...(filter.uid !== undefined ? { uid: filter.uid } : {}),
    ...(filter.fromTs !== undefined ? { fromTs: filter.fromTs } : {}),
    ...(filter.toTs !== undefined ? { toTs: filter.toTs } : {}),
    limit: filter.limit,
  };
  if (kind === 'live') return db.sampleLiveSessions(query).map((row) => liveResolved(db, row));
  return db.samplePosts({ ...query, ...(filter.platform ? { platform: filter.platform } : {}) })
    .map((row) => postResolved(db, row));
}

// ---- 三档判定（各自独立）----

/** 没有模型判定口径时的跳过原因（按模式给不同措辞：精确模式不是「没填描述」） */
function skipReason(cat: Category): string {
  return cat.judgeMode === 'precise'
    ? '精确模式没有启用的通过条件'
    : '未填写判定描述';
}

function skippedTier(source: CategoryTestSource, cat: Category): CategoryTestTier {
  return {
    source, status: 'skipped', pass: null, confidence: null, decided: false,
    evidence: null, reason: skipReason(cat),
  };
}

function unavailableTier(source: CategoryTestSource, reason: string | null, fallback: string): CategoryTestTier {
  return {
    source, status: 'unavailable', pass: null, confidence: null, decided: false,
    evidence: null, reason: reason ?? fallback,
  };
}

/** 确定性条件档：零成本、恒有结论（无条件组 = 判否 + 「无确定性条件」） */
function ruleTier(cat: Category, item: ContentItem): CategoryTestTier {
  const { result } = ruleConclusion(cat, item);
  return {
    source: 'rule', status: 'ok', pass: result.pass, confidence: result.confidence,
    decided: true, evidence: result.evidence, reason: null,
  };
}

/** LLM 档：只问 LLM（决策路由刻意置空——试跑要的是单档结论，不跑判决链） */
async function llmTier(
  deps: CategoryTestDeps, cat: Category, item: ContentItem,
): Promise<CategoryTestTier> {
  if (!hasJudgeBasis(cat)) return skippedTier('llm', cat);
  const box: { reason: string | null } = { reason: null };
  const jctx: JudgeContext = {
    getRouter: deps.getRouter,
    llmEnabled: deps.llmEnabled,
    getDecisionRouter: () => null,
    decisionEnabled: () => false,
    decisionThresholds: deps.decisionThresholds,
    onFallback: (reason) => { box.reason = reason; },
  };
  const out = await deps.queue.run(() => llmJudge.judge(item, { cats: [cat], primaryCats: null }, jctx));
  if (out === null) return unavailableTier('llm', box.reason, 'LLM 不可用');
  const row = out.results.find((r) => r.categoryId === cat.id);
  if (!row) return unavailableTier('llm', '模型没有返回这个分类的结论', 'LLM 不可用');
  return {
    source: 'llm', status: 'ok', pass: row.pass, confidence: row.confidence,
    decided: out.decided.has(cat.id), evidence: row.evidence, reason: null,
  };
}

/** 决策模型档：只问决策通道；灰区（或纯文本供应商没看图）有结论但 `decided=false` */
async function decisionTier(
  deps: CategoryTestDeps, cat: Category, item: ContentItem,
): Promise<CategoryTestTier> {
  if (!hasJudgeBasis(cat)) return skippedTier('decision', cat);
  const box: { reason: string | null } = { reason: null };
  const jctx: JudgeContext = {
    getRouter: () => null,
    llmEnabled: () => false,
    getDecisionRouter: deps.getDecisionRouter,
    decisionEnabled: deps.decisionEnabled,
    decisionThresholds: deps.decisionThresholds,
    onStageSkip: (_stage, reason) => { box.reason = reason; },
  };
  const out = await deps.queue.run(() => decisionJudge.judge(item, { cats: [cat], primaryCats: null }, jctx));
  if (out === null) return unavailableTier('decision', box.reason, '决策模型不可用');
  const row = out.results.find((r) => r.categoryId === cat.id);
  if (!row) return unavailableTier('decision', '决策模型没有返回这个分类的结论', '决策模型不可用');
  const conditions = out.conditionResults?.filter((c) => c.categoryId === cat.id);
  return {
    source: 'decision', status: 'ok', pass: row.pass, confidence: row.confidence,
    decided: out.decided.has(cat.id), evidence: row.evidence, reason: null,
    ...(conditions && conditions.length > 0 ? { conditionResults: conditions } : {}),
  };
}

// ---- 编排 ----

async function testSample(
  deps: CategoryTestDeps, draft: Category, loader: ImageLoader, resolved: ResolvedSample,
  sources: CategoryTestSource[],
): Promise<CategoryTestSample> {
  const prepared: PreparedImages = sources.includes('llm') || sources.includes('decision')
    ? await loader(resolved.pending)
    : { dataUrls: [], skipped: [] };
  const item: ContentItem = { ...resolved.item, imageUrls: prepared.dataUrls };
  const results: CategoryTestTier[] = [];
  if (sources.includes('rule')) results.push(ruleTier(draft, item));
  if (sources.includes('llm')) results.push(await llmTier(deps, draft, item));
  if (sources.includes('decision')) results.push(await decisionTier(deps, draft, item));
  return {
    ...resolved.summary,
    imageCount: item.imageUrls.length,
    skippedImages: prepared.skipped,
    results,
  };
}

/**
 * 抽样入口（注册表 handler 唯一调用点）：按 `kind` + 过滤面从归档里取样本，**只回摘要**。
 * 池子只收能带图的记录（见 `Db.sample*`），所以摘要的 `image` 恒非空——列表缩略图不会缺格。
 * 不下图、不调模型、不写库：本函数只经 `resolveSamples` 读库并投影摘要，
 * 连图片加载器都不看（复测要下什么图由试判流程自己决定）。
 */
export function sampleCategoryRecords(deps: CategoryTestDeps, body: unknown): CategorySampleResponse {
  const { kind, filter } = parseCategorySampleRequest(body);
  return { samples: resolveSamples(deps.db, kind, filter, undefined).map((r) => r.summary) };
}

/**
 * 试跑入口（注册表 handler 唯一调用点）：校验草稿 → 定位样本（随机抽样 / 按 `sampleIds` 精确复读）
 * → 逐条串行跑所选判定档 → 只回摘要。
 * 全程不写库、不推送：本模块没有任何写库或推送调用（唯一的副作用是图片缓存目录里的本地文件）。
 */
export async function runCategoryTest(
  deps: CategoryTestDeps, body: unknown,
): Promise<CategoryTestResponse> {
  const { category, filter, sources, sampleIds } = parseCategoryTestRequest(body);
  const loader = deps.imageLoader ?? createImageLoader(deps.imageCacheDir, deps.getProxyUrl);
  const samples: CategoryTestSample[] = [];
  for (const resolved of resolveSamples(deps.db, category.appliesTo, filter, sampleIds)) {
    samples.push(await testSample(deps, category, loader, resolved, sources));
  }
  return { samples };
}
