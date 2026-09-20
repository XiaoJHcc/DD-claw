/**
 * 面板 HTTP 层工具：请求体解析（64KB 上限）、参数校验（400 + 中文错误）、JSON 响应。
 * 校验失败一律抛 HttpError，由 server 统一转成 { error } 响应。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../core/db.js';
import type { StreamerInput } from '../core/streamers.js';
import type {
  CategoryInput, NewCategory, NewPushChannel, NewPushRule, PushChannelInput, PushRuleInput,
} from '../core/push.js';
import { NUM_SPECS, BOOL_SPECS, type RuntimeConfig } from '../core/runtime-config.js';
import {
  X_INTERVAL_MAX, X_INTERVAL_MIN, type XConfig,
} from '../core/x-config.js';
import {
  defaultPostFilters, filtersAreUsable, judgeIsUsable,
  type NewPostRule, type PostFilters, type PostRuleInput,
} from '../core/post-rules.js';
import { isValidScreenName, normalizeScreenName } from '../core/x-accounts.js';
import { isValidWeiboUid, normalizeWeiboNick, normalizeWeiboUid } from '../core/weibo-accounts.js';
import { isValidBiliUid, normalizeBiliUid } from '../core/bili-accounts.js';
import { describeTunnelError, parseInstanceList, parseProxyUrl } from '../core/proxy.js';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const MAX_BODY_BYTES = 64 * 1024;

/** 解析 JSON 请求体；空体按 {} 处理，超 64KB 或坏 JSON 抛 400。 */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(400, '请求体超过 64KB 上限');
    chunks.push(buf);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// ---- 通用校验小工具 ----

function asObject(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new HttpError(400, '请求体必须是 JSON 对象');
  }
  return v as Record<string, unknown>;
}

function asNullableString(v: unknown, field: string): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') throw new HttpError(400, `${field} 必须是字符串或 null`);
  return v;
}

function asBoolean(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') throw new HttpError(400, `${field} 必须是布尔值`);
  return v;
}

function asEnum<T extends string>(v: unknown, field: string, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    throw new HttpError(400, `${field} 必须是 ${allowed.join(' / ')} 之一`);
  }
  return v as T;
}

function asStringArray(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new HttpError(400, `${field} 必须是字符串数组`);
  }
  return v as string[];
}

/** 拒绝未知字段，尽早暴露调用方的拼写错误 */
function rejectUnknownKeys(o: Record<string, unknown>, allowed: readonly string[]): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) throw new HttpError(400, `未知字段: ${k}`);
  }
}

export function parseUid(v: unknown, field = 'uid'): string {
  if (typeof v !== 'string' || !/^\d+$/.test(v)) {
    throw new HttpError(400, `${field} 必须是纯数字字符串`);
  }
  return v;
}

// ---- streamers ----

/**
 * PUT /api/streamers/:uid 的部分更新体（uid 由路由提供）；至少一个可更新字段。
 * weiboNick 空字符串 = 清除；昵称→UID 的解析在路由层做（需要注入 resolver）。
 */
export function parseStreamerPatch(body: unknown): Partial<StreamerInput> {
  const o = asObject(body);
  rejectUnknownKeys(o, ['alias', 'watch', 'analyze', 'notify', 'weiboNick', 'profileNote']);
  const patch: Partial<StreamerInput> = {};
  if ('alias' in o) patch.alias = asNullableString(o.alias, 'alias');
  if ('watch' in o) patch.watch = asBoolean(o.watch, 'watch');
  if ('analyze' in o) patch.analyze = asBoolean(o.analyze, 'analyze');
  if ('notify' in o) patch.notify = asBoolean(o.notify, 'notify');
  if ('weiboNick' in o) {
    const v = asNullableString(o.weiboNick, 'weiboNick');
    patch.weiboNick = v === '' ? null : v; // 空串 = 清除
  }
  if ('profileNote' in o) patch.profileNote = asNullableString(o.profileNote, 'profileNote');
  if (Object.keys(patch).length === 0) throw new HttpError(400, '没有可更新的字段');
  return patch;
}

// ---- push_channels ----

const CHANNEL_NOTIFIERS = ['toast', 'onebot'] as const;
const CHANNEL_TARGET_TYPES = ['group', 'private'] as const;

function parseChannelFields(o: Record<string, unknown>, patch: PushChannelInput): void {
  if ('name' in o) {
    const name = o.name;
    if (typeof name !== 'string' || name.trim() === '') throw new HttpError(400, 'name 必须是非空字符串');
    patch.name = name.trim();
  }
  if ('notifier' in o) patch.notifier = asEnum(o.notifier, 'notifier', CHANNEL_NOTIFIERS);
  if ('targetType' in o) {
    const v = o.targetType;
    patch.targetType = v === null ? null : asEnum(v, 'targetType', CHANNEL_TARGET_TYPES);
  }
  if ('targetId' in o) {
    const v = o.targetId;
    patch.targetId = v === null ? null : parseUid(v, 'targetId');
  }
  if ('enabled' in o) patch.enabled = asBoolean(o.enabled, 'enabled');
}

/** 渠道字段间的联动校验：onebot 必填纯数字 targetId，toast 不带目标。PUT 路由对合并后的形状复用。 */
export function checkChannelShape(c: { notifier?: string; targetType?: string | null; targetId?: string | null }): void {
  if (c.notifier === 'onebot') {
    if (c.targetType == null) throw new HttpError(400, 'QQ 渠道必须选择 targetType（group / private）');
    if (c.targetId == null) throw new HttpError(400, 'QQ 渠道必须填写 targetId（纯数字QQ号/群号）');
  }
  if (c.notifier === 'toast' && (c.targetType != null || c.targetId != null)) {
    throw new HttpError(400, '系统通知渠道没有目标号，targetType / targetId 必须留空');
  }
}

/** POST /api/channels 的新建体：name + notifier 必填。 */
export function parseNewChannel(body: unknown): NewPushChannel {
  const o = asObject(body);
  rejectUnknownKeys(o, ['name', 'notifier', 'targetType', 'targetId', 'enabled']);
  const patch: PushChannelInput = {};
  if (!('name' in o)) throw new HttpError(400, 'name 必填');
  if (!('notifier' in o)) throw new HttpError(400, 'notifier 必填');
  parseChannelFields(o, patch);
  checkChannelShape({ notifier: patch.notifier, targetType: patch.targetType ?? null, targetId: patch.targetId ?? null });
  return {
    name: patch.name!,
    notifier: patch.notifier!,
    targetType: patch.targetType ?? null,
    targetId: patch.targetId ?? null,
    enabled: patch.enabled ?? true,
  };
}

/** PUT /api/channels/:id 的部分更新体；至少一个字段。 */
export function parseChannelPatch(body: unknown): PushChannelInput {
  const o = asObject(body);
  rejectUnknownKeys(o, ['name', 'notifier', 'targetType', 'targetId', 'enabled']);
  const patch: PushChannelInput = {};
  parseChannelFields(o, patch);
  if (Object.keys(patch).length === 0) throw new HttpError(400, '没有可更新的字段');
  return patch;
}

// ---- categories：分类规则 ----

const CATEGORY_KEYS = ['name', 'llmPrompt', 'keywords', 'areas', 'condMode', 'enabled'] as const;
const COND_MODES = ['and', 'or'] as const;

function parseCategoryFields(o: Record<string, unknown>, p: CategoryInput): void {
  if ('name' in o) {
    if (typeof o.name !== 'string') throw new HttpError(400, 'name 必须是字符串');
    const name = o.name.trim();
    if (!name) throw new HttpError(400, '分类名称不能为空');
    p.name = name;
  }
  if ('llmPrompt' in o) {
    const v = asNullableString(o.llmPrompt, 'llmPrompt');
    p.llmPrompt = v === '' ? null : v; // 空串 = 不用 LLM（纯确定性分类）
  }
  if ('keywords' in o) p.keywords = asStringArray(o.keywords, 'keywords');
  if ('areas' in o) p.areas = asStringArray(o.areas, 'areas');
  if ('condMode' in o) p.condMode = asEnum(o.condMode, 'condMode', COND_MODES);
  if ('enabled' in o) p.enabled = asBoolean(o.enabled, 'enabled');
}

/** LLM 提示词 / 关键词 / 分区至少一项非空。POST 对缺省合并后的形状调，PUT 对合并后形状调。 */
export function checkCategoryConditions(c: {
  llmPrompt?: string | null; keywords?: string[]; areas?: string[];
}): void {
  const prompt = c.llmPrompt?.trim() ?? '';
  if (!prompt && (c.keywords ?? []).length === 0 && (c.areas ?? []).length === 0) {
    throw new HttpError(400, '至少配置 LLM 提示词或关键词/分区条件');
  }
}

/** POST /api/categories 的新建体：全部可省（name 空由 Db 补「分类 N」），但条件至少一项。 */
export function parseNewCategory(body: unknown): NewCategory {
  const o = asObject(body);
  rejectUnknownKeys(o, CATEGORY_KEYS);
  const p: CategoryInput = {};
  parseCategoryFields(o, p);
  const c: NewCategory = {
    name: p.name ?? '',
    llmPrompt: p.llmPrompt !== undefined ? p.llmPrompt : null,
    keywords: p.keywords ?? [],
    areas: p.areas ?? [],
    condMode: p.condMode ?? 'and',
    enabled: p.enabled ?? true,
  };
  checkCategoryConditions(c);
  return c;
}

/** PUT /api/categories/:id 的部分更新体；至少一个字段。条件校验在路由层对合并后形状做。 */
export function parseCategoryPatch(body: unknown): CategoryInput {
  const o = asObject(body);
  rejectUnknownKeys(o, CATEGORY_KEYS);
  const p: CategoryInput = {};
  parseCategoryFields(o, p);
  if (Object.keys(p).length === 0) throw new HttpError(400, '没有可更新的字段');
  return p;
}

// ---- push_rules v2：推送规则（全局；分类引用 + 生效主播集合）----

const RULE_KEYS = ['name', 'categoryId', 'uids', 'channels', 'messageTemplate', 'enabled'] as const;

function asIdArray(v: unknown, field: string): number[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'number' || !Number.isInteger(x) || x <= 0)) {
    throw new HttpError(400, `${field} 必须是正整数 id 数组`);
  }
  return v as number[];
}

/** categoryId：正整数 id 或 null（null = 任意开播） */
function asNullableId(v: unknown, field: string): number | null {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new HttpError(400, `${field} 必须是正整数 id 或 null`);
  }
  return v;
}

function asUidArray(v: unknown, field: string): string[] {
  const arr = asStringArray(v, field);
  for (const u of arr) {
    if (!/^\d+$/.test(u)) throw new HttpError(400, `${field} 元素必须是纯数字 uid`);
  }
  return arr;
}

function parseMessageTemplate(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') throw new HttpError(400, 'messageTemplate 必须是字符串或 null');
  return v === '' ? null : v; // 空串 = 用内置默认模板
}

function parseRuleFields(o: Record<string, unknown>, p: PushRuleInput): void {
  if ('name' in o) {
    if (typeof o.name !== 'string') throw new HttpError(400, 'name 必须是字符串');
    const name = o.name.trim();
    if (!name) throw new HttpError(400, '规则名称不能为空');
    p.name = name;
  }
  if ('categoryId' in o) p.categoryId = asNullableId(o.categoryId, 'categoryId');
  if ('uids' in o) p.uids = asUidArray(o.uids, 'uids');
  if ('channels' in o) p.channels = asIdArray(o.channels, 'channels');
  if ('messageTemplate' in o) p.messageTemplate = parseMessageTemplate(o.messageTemplate);
  if ('enabled' in o) p.enabled = asBoolean(o.enabled, 'enabled');
}

/** POST /api/rules 的新建体：全部可省（缺省 = 任意开播 / 全部主播 / 无渠道 / 默认模板）。引用存在性校验在路由层。 */
export function parseNewRule(body: unknown): NewPushRule {
  const o = asObject(body);
  rejectUnknownKeys(o, RULE_KEYS);
  const p: PushRuleInput = {};
  parseRuleFields(o, p);
  return {
    name: p.name ?? '',
    categoryId: p.categoryId !== undefined ? p.categoryId : null,
    uids: p.uids ?? [],
    channels: p.channels ?? [],
    messageTemplate: p.messageTemplate ?? null,
    enabled: p.enabled ?? true,
  };
}

/** PUT /api/rules/:id 的部分更新体；至少一个字段。 */
export function parseRulePatch(body: unknown): PushRuleInput {
  const o = asObject(body);
  rejectUnknownKeys(o, RULE_KEYS);
  const p: PushRuleInput = {};
  parseRuleFields(o, p);
  if (Object.keys(p).length === 0) throw new HttpError(400, '没有可更新的字段');
  return p;
}

// ---- 跨表共用逻辑（面板路由与 MCP 工具复用）----

/** 规则引用存在性校验：分类 / 渠道 / 主播（监听名单内）都必须存在。 */
export function checkRuleRefs(db: Db, r: { categoryId: number | null; uids: string[]; channels: number[] }): void {
  if (r.categoryId !== null && !db.listCategories().some((c) => c.id === r.categoryId)) {
    throw new HttpError(400, '分类不存在');
  }
  const channelIds = new Set(db.listPushChannels().map((c) => c.id));
  for (const id of r.channels) {
    if (!channelIds.has(id)) throw new HttpError(400, `渠道不存在: ${id}`);
  }
  const streamerUids = new Set(db.listStreamers().map((s) => s.uid));
  for (const uid of r.uids) {
    if (!streamerUids.has(uid)) throw new HttpError(400, `主播不在监听名单: ${uid}`);
  }
}

/** 候选池一键加入监听；已有条目不碰来源，仅 watch=0 时重新打开。新行默认 notify=1、analyze=0。uname/face 从 follows 预填。 */
export function watchStreamer(db: Db, uid: string): unknown {
  const existing = db.getStreamer(uid);
  if (existing?.watch) throw new HttpError(409, '该主播已在监听名单');
  if (existing) {
    db.upsertStreamer({ uid, watch: true });
  } else {
    const follow = db.listFollows(true).find((f) => f.uid === uid);
    db.upsertStreamer({ uid, uname: follow?.uname, face: follow?.face ?? null, watch: true, source: 'follows' });
  }
  return { streamer: db.getStreamer(uid) };
}

/**
 * 高级设置（/api/advanced 与 MCP update_runtime_config 共用）：
 * 按 NUM_SPECS/BOOL_SPECS 规格表逐字段校验范围，空 patch 抛 400。
 */
export function parseRuntimePatch(body: unknown): Partial<RuntimeConfig> {
  const b = asObject(body);
  const patch: Record<string, number | boolean> = {};
  for (const s of NUM_SPECS) {
    const v = b[s.field];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < s.min || v > s.max) {
      throw new HttpError(400, `${s.label}必须是 ${s.min}~${s.max} 的整数`);
    }
    patch[s.field] = v;
  }
  for (const s of BOOL_SPECS) {
    const v = b[s.field];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') throw new HttpError(400, `${s.label}必须是布尔值`);
    patch[s.field] = v;
  }
  if (Object.keys(patch).length === 0) throw new HttpError(400, '没有可保存的字段');
  return patch as Partial<RuntimeConfig>;
}

// ---- X / 推特（独立分页，/api/x*；与开播那套设置完全分开）----

const X_KEYS = ['proxyUrl', 'instances', 'intervalSec', 'fallbackHtml'] as const;
const X_TEST_TARGETS = ['all', 'proxy', 'instances', 'web'] as const;

/** 实例 host 形状：host 或 host:port（不含协议，协议在 /api/x 保存时就该被剥掉） */
const INSTANCE_HOST_RE = /^[a-z0-9][a-z0-9.-]*(:\d{1,5})?$/i;

/**
 * PUT /api/x 的部分更新体：代理地址（空串 = 不用代理）、实例列表、轮询间隔、回退开关。
 * 代理地址在此就做一次形状校验——配置错误必须当场报，不能等到轮询时才炸。
 */
export function parseXPatch(body: unknown): Partial<XConfig> {
  const o = asObject(body);
  rejectUnknownKeys(o, X_KEYS);
  const p: Partial<XConfig> = {};
  if ('proxyUrl' in o) {
    const v = o.proxyUrl;
    if (typeof v !== 'string') throw new HttpError(400, 'proxyUrl 必须是字符串');
    const s = v.trim();
    if (s) {
      try {
        parseProxyUrl(s);
      } catch (e) {
        throw new HttpError(400, describeTunnelError(e));
      }
    }
    p.proxyUrl = s;
  }
  if ('instances' in o) {
    const raw = typeof o.instances === 'string'
      ? [o.instances]
      : asStringArray(o.instances, 'instances');
    const list = raw.flatMap((x) => parseInstanceList(x));
    for (const h of list) {
      if (!INSTANCE_HOST_RE.test(h)) throw new HttpError(400, `实例格式不对（应为 host 或 host:port）: ${h}`);
    }
    p.instances = list;
  }
  if ('intervalSec' in o) {
    const v = o.intervalSec;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < X_INTERVAL_MIN || v > X_INTERVAL_MAX) {
      throw new HttpError(400, `推特抓取间隔必须是 ${X_INTERVAL_MIN}~${X_INTERVAL_MAX} 的整数`);
    }
    p.intervalSec = v;
  }
  if ('fallbackHtml' in o) p.fallbackHtml = asBoolean(o.fallbackHtml, 'fallbackHtml');
  if (Object.keys(p).length === 0) throw new HttpError(400, '没有可保存的字段');
  return p;
}

export interface XTestRequest {
  target: 'all' | 'proxy' | 'instances' | 'web';
  /** 覆盖值：允许「先测后存」——测试用的可以是还没保存的输入框内容 */
  proxyUrl?: string;
  instances?: string;
  screenName?: string;
}

/** POST /api/x/test 的请求体：target 缺省 all；三个覆盖值都可省（省则用已保存配置） */
export function parseXTestRequest(body: unknown): XTestRequest {
  const o = asObject(body);
  rejectUnknownKeys(o, ['target', 'proxyUrl', 'instances', 'screenName']);
  const req: XTestRequest = {
    target: 'target' in o ? asEnum(o.target, 'target', X_TEST_TARGETS) : 'all',
  };
  if ('proxyUrl' in o) {
    if (typeof o.proxyUrl !== 'string') throw new HttpError(400, 'proxyUrl 必须是字符串');
    req.proxyUrl = o.proxyUrl.trim();
  }
  if ('instances' in o) {
    if (typeof o.instances !== 'string') throw new HttpError(400, 'instances 必须是字符串');
    req.instances = o.instances;
  }
  if ('screenName' in o) {
    if (typeof o.screenName !== 'string') throw new HttpError(400, 'screenName 必须是字符串');
    req.screenName = o.screenName.trim();
  }
  return req;
}

// ---- X 关注账号（独立名单，不挂 B站主播；biliUid 仅可选关联）----

const X_ACCOUNT_KEYS = ['screenName', 'nickname', 'biliUid', 'displayName', 'enabled', 'ruleIds'] as const;

/** screen name 归一化 + 形状校验（`@abc` / `ABC` 都收，统一成小写） */
function asScreenName(v: unknown, field = 'screenName'): string {
  if (typeof v !== 'string') throw new HttpError(400, `${field} 必须是字符串`);
  const s = normalizeScreenName(v);
  if (!isValidScreenName(s)) {
    throw new HttpError(400, 'X 账号格式不对（字母 / 数字 / 下划线，1~15 位）');
  }
  return s;
}

/** POST /api/x/accounts：screenName 必填；nickname / biliUid / displayName 可选（存在性在路由层校验）；enabled 缺省 true；ruleIds 缺省 []（平台一致性在路由层校验） */
export function parseNewXAccount(body: unknown): {
  screenName: string; nickname: string | null; displayName: string | null; biliUid: string | null; enabled: boolean;
  ruleIds: number[];
} {
  const o = asObject(body);
  rejectUnknownKeys(o, X_ACCOUNT_KEYS);
  if (!('screenName' in o)) throw new HttpError(400, 'screenName 必填');
  const out: { screenName: string; nickname: string | null; displayName: string | null; biliUid: string | null; enabled: boolean; ruleIds: number[] } = {
    screenName: asScreenName(o.screenName),
    nickname: null,
    displayName: null,
    biliUid: null,
    enabled: true,
    ruleIds: [],
  };
  if ('nickname' in o) out.nickname = asNullableString(o.nickname, 'nickname');
  if ('biliUid' in o && o.biliUid !== null) out.biliUid = parseUid(o.biliUid, 'biliUid');
  if ('displayName' in o) out.displayName = asNullableString(o.displayName, 'displayName');
  // enabled 必须被采纳：显式传 false 却被静默忽略会让人以为停用生效了
  if ('enabled' in o) out.enabled = asBoolean(o.enabled, 'enabled');
  if ('ruleIds' in o) out.ruleIds = asIdArray(o.ruleIds, 'ruleIds');
  return out;
}

/** PUT /api/x/accounts/:id 的部分更新体；至少一个字段 */
export function parseXAccountPatch(body: unknown): {
  screenName?: string; nickname?: string | null; biliUid?: string | null; displayName?: string | null; enabled?: boolean;
  ruleIds?: number[];
} {
  const o = asObject(body);
  rejectUnknownKeys(o, X_ACCOUNT_KEYS);
  const p: {
    screenName?: string; nickname?: string | null; biliUid?: string | null; displayName?: string | null; enabled?: boolean;
    ruleIds?: number[];
  } = {};
  if ('screenName' in o) p.screenName = asScreenName(o.screenName);
  if ('nickname' in o) p.nickname = asNullableString(o.nickname, 'nickname');
  if ('biliUid' in o) p.biliUid = o.biliUid === null ? null : parseUid(o.biliUid, 'biliUid');
  if ('displayName' in o) p.displayName = asNullableString(o.displayName, 'displayName');
  if ('enabled' in o) p.enabled = asBoolean(o.enabled, 'enabled');
  if ('ruleIds' in o) p.ruleIds = asIdArray(o.ruleIds, 'ruleIds');
  if (Object.keys(p).length === 0) throw new HttpError(400, '没有可更新的字段');
  return p;
}

// ---- 图文帖规则（平台无关，X / 微博 / B站动态账号都可选用；与推送规则平行的一张表）----
// 规则只定义「筛选 + 渠道 + 推送词」，生效范围在账号侧（x/weibo/bili_accounts 行的 ruleIds），
// 规则本身不带账号集合（account_ids 列是旧设计遗留，见 core/post-rules.ts 头注释）。

const POST_RULE_KEYS = [
  'name', 'channels', 'filters', 'messageTemplate',
  'llmJudge', 'judgePrompt', 'llmTranslate', 'enabled',
] as const;
const POST_FILTER_KEYS = ['original', 'retweet', 'quote', 'media', 'keywords'] as const;

/** filters 只认已知字段；非法类型一律 400（配置错误当场报，别等推送时才发现规则是死的） */
function parsePostFiltersField(v: unknown): Partial<PostFilters> {
  const o = asObject(v);
  rejectUnknownKeys(o, POST_FILTER_KEYS);
  const f: Partial<PostFilters> = {};
  for (const k of ['original', 'retweet', 'quote', 'media'] as const) {
    if (k in o) f[k] = asBoolean(o[k], `filters.${k}`);
  }
  if ('keywords' in o) {
    const arr = asStringArray(o.keywords, 'filters.keywords');
    f.keywords = arr.map((s) => s.trim()).filter(Boolean);
  }
  return f;
}

function parsePostRuleFields(o: Record<string, unknown>, p: PostRuleInput): void {
  if ('name' in o) {
    if (typeof o.name !== 'string') throw new HttpError(400, 'name 必须是字符串');
    const name = o.name.trim();
    if (!name) throw new HttpError(400, '规则名称不能为空');
    p.name = name;
  }
  // platform 已退役（规则平台无关）：不在 POST_RULE_KEYS 里，传入会被当未知字段 400
  if ('channels' in o) p.channels = asIdArray(o.channels, 'channels');
  if ('filters' in o) p.filters = parsePostFiltersField(o.filters);
  if ('messageTemplate' in o) p.messageTemplate = parseMessageTemplate(o.messageTemplate);
  if ('llmJudge' in o) p.llmJudge = asBoolean(o.llmJudge, 'llmJudge');
  if ('judgePrompt' in o) p.judgePrompt = asNullableString(o.judgePrompt, 'judgePrompt');
  if ('llmTranslate' in o) p.llmTranslate = asBoolean(o.llmTranslate, 'llmTranslate');
  if ('enabled' in o) p.enabled = asBoolean(o.enabled, 'enabled');
}

/** 「原创/转发都不勾」= 永不命中的死规则，拒绝保存（quote 不再按平台拒：非 X 帖永不命中是语义，见 core/post-rules.ts） */
export function checkPostFiltersUsable(f: PostFilters): void {
  if (!filtersAreUsable(f)) {
    throw new HttpError(400, '「原创」与「转发」至少要勾一个，否则这条规则永远不会命中');
  }
}

/** 开了 LLM 判定却没填判定标准 = 让模型自由发挥，拒绝保存（口径必须由人填） */
export function checkPostJudgeUsable(llmJudge: boolean, judgePrompt: string | null): void {
  if (!judgeIsUsable(llmJudge, judgePrompt)) {
    throw new HttpError(400, '开启「LLM 判定」必须填判定提示词');
  }
}

/** POST /api/post-rules：缺省照默认值（规则平台无关，无 platform 入参） */
export function parseNewPostRule(body: unknown): NewPostRule {
  const o = asObject(body);
  rejectUnknownKeys(o, POST_RULE_KEYS);
  const p: PostRuleInput = {};
  parsePostRuleFields(o, p);
  const filters: PostFilters = { ...defaultPostFilters(), ...(p.filters ?? {}) };
  checkPostFiltersUsable(filters);
  const llmJudge = p.llmJudge ?? false;
  const judgePrompt = p.judgePrompt ?? null;
  checkPostJudgeUsable(llmJudge, judgePrompt);
  return {
    name: p.name ?? '',
    channels: p.channels ?? [],
    filters,
    messageTemplate: p.messageTemplate ?? null,
    llmJudge,
    judgePrompt,
    llmTranslate: p.llmTranslate ?? false,
    enabled: p.enabled ?? true,
  };
}

/** PUT /api/post-rules/:id 的部分更新体；至少一个字段。合并后是否可用由路由层判 */
export function parsePostRulePatch(body: unknown): PostRuleInput {
  const o = asObject(body);
  rejectUnknownKeys(o, POST_RULE_KEYS);
  const p: PostRuleInput = {};
  parsePostRuleFields(o, p);
  if (Object.keys(p).length === 0) throw new HttpError(400, '没有可更新的字段');
  return p;
}

/**
 * 图文帖规则引用存在性校验：只剩渠道（共用 push_channels）。
 * 生效范围在账号侧 ruleIds（见 checkAccountRuleIds），规则本身不带账号集合。
 */
export function checkPostRuleRefs(db: Db, r: { channels: number[] }): void {
  const channelIds = new Set(db.listPushChannels().map((c) => c.id));
  for (const id of r.channels) {
    if (!channelIds.has(id)) throw new HttpError(400, `渠道不存在: ${id}`);
  }
}

/**
 * 账号侧 ruleIds 校验：规则必须存在。
 * 规则平台无关，任何平台的账号都可选任何规则，不做平台匹配。
 */
export function checkAccountRuleIds(db: Db, ruleIds: number[]): void {
  const rules = db.listPostRules();
  for (const id of ruleIds) {
    if (!rules.some((r) => r.id === id)) {
      throw new HttpError(400, `图文帖规则不存在: ${id}`);
    }
  }
}

/**
 * 删除图文帖规则并清扫三份账号名单里的选用关系（账号 ruleIds 不残留已删规则的 id）。
 * 面板 DELETE /api/post-rules/:id 与 MCP delete_post_rule 共用（与 webui mock 同构）。
 */
export function deletePostRuleSweepingRefs(db: Db, id: number): boolean {
  if (!db.deletePostRule(id)) return false;
  for (const a of db.listXAccounts()) {
    if (a.ruleIds.includes(id)) db.upsertXAccount({ id: a.id, ruleIds: a.ruleIds.filter((x) => x !== id) });
  }
  for (const a of db.listWeiboAccounts()) {
    if (a.ruleIds.includes(id)) db.upsertWeiboAccount({ id: a.id, ruleIds: a.ruleIds.filter((x) => x !== id) });
  }
  for (const a of db.listBiliAccounts()) {
    if (a.ruleIds.includes(id)) db.upsertBiliAccount({ id: a.id, ruleIds: a.ruleIds.filter((x) => x !== id) });
  }
  return true;
}

// ---- 微博关注账号（独立名单，biliUid 仅可选关联；与 X 账号同一套语义）----
const WEIBO_ACCOUNT_KEYS = ['uid', 'nickname', 'displayName', 'biliUid', 'enabled', 'ruleIds'] as const;

/** uid 归一化 + 形状校验（收 `2203177060` / `u/2203177060` / `weibo.com/u/2203177060`） */
function asWeiboUid(v: unknown, field = 'uid'): string {
  if (typeof v !== 'string') throw new HttpError(400, `${field} 必须是字符串`);
  const s = normalizeWeiboUid(v);
  if (!isValidWeiboUid(s)) throw new HttpError(400, '微博 uid 必须是数字（可从 weibo.com/u/<uid> 复制）');
  return s;
}

/**
 * POST /api/weibo/accounts：uid 与 nickname 至少给一个（route 层用 nickname 走解析链补出 uid）；
 * biliUid / enabled 可选。**不做「给 uid 就验证存在」**：微博没有像 X 的 tweet-result 那样
 * 便宜的匿名存在性接口，硬加等于把添加流程挂在一个未实测的端点上（见 docs/boundaries.md）。
 */
export function parseNewWeiboAccount(body: unknown): {
  uid: string | null; nickname: string | null; displayName: string | null; biliUid: string | null; enabled: boolean;
  ruleIds: number[];
} {
  const o = asObject(body);
  rejectUnknownKeys(o, WEIBO_ACCOUNT_KEYS);
  if (!('uid' in o) && !('nickname' in o)) throw new HttpError(400, 'uid 与昵称至少填一个');
  const out: {
    uid: string | null; nickname: string | null; displayName: string | null; biliUid: string | null; enabled: boolean;
    ruleIds: number[];
  } = { uid: null, nickname: null, displayName: null, biliUid: null, enabled: true, ruleIds: [] };
  if ('uid' in o && o.uid !== null && o.uid !== '') out.uid = asWeiboUid(o.uid);
  if ('nickname' in o) {
    const nick = asNullableString(o.nickname, 'nickname');
    const norm = nick ? normalizeWeiboNick(nick) : '';
    out.nickname = norm || null;
  }
  if (!out.uid && !out.nickname) throw new HttpError(400, 'uid 与昵称至少填一个');
  if ('displayName' in o) out.displayName = asNullableString(o.displayName, 'displayName');
  if ('biliUid' in o && o.biliUid !== null) out.biliUid = parseUid(o.biliUid, 'biliUid');
  if ('enabled' in o) out.enabled = asBoolean(o.enabled, 'enabled');
  if ('ruleIds' in o) out.ruleIds = asIdArray(o.ruleIds, 'ruleIds');
  return out;
}

/** PUT /api/weibo/accounts/:id 的部分更新体；至少一个字段 */
export function parseWeiboAccountPatch(body: unknown): {
  uid?: string; nickname?: string | null; displayName?: string | null; biliUid?: string | null; enabled?: boolean;
  ruleIds?: number[];
} {
  const o = asObject(body);
  rejectUnknownKeys(o, WEIBO_ACCOUNT_KEYS);
  const p: {
    uid?: string; nickname?: string | null; displayName?: string | null; biliUid?: string | null; enabled?: boolean;
    ruleIds?: number[];
  } = {};
  if ('uid' in o) p.uid = asWeiboUid(o.uid);
  if ('nickname' in o) {
    const nick = asNullableString(o.nickname, 'nickname');
    p.nickname = nick === null ? null : normalizeWeiboNick(nick) || null;
  }
  if ('displayName' in o) p.displayName = asNullableString(o.displayName, 'displayName');
  if ('biliUid' in o) p.biliUid = o.biliUid === null ? null : parseUid(o.biliUid, 'biliUid');
  if ('enabled' in o) p.enabled = asBoolean(o.enabled, 'enabled');
  if ('ruleIds' in o) p.ruleIds = asIdArray(o.ruleIds, 'ruleIds');
  if (Object.keys(p).length === 0) throw new HttpError(400, '没有可更新的字段');
  return p;
}

// ---- B站动态账号（独立名单：只管推送选用，抓取轮询对象由动态源自并监听主播）----
const BILI_ACCOUNT_KEYS = ['uid', 'uname', 'displayName', 'enabled', 'ruleIds'] as const;
const BILI_ACCOUNT_PATCH_KEYS = ['uname', 'displayName', 'enabled', 'ruleIds'] as const;

/** uid 归一化 + 形状校验（收 `7706705` / `space.bilibili.com/7706705` 链接形态） */
function asBiliUid(v: unknown, field = 'uid'): string {
  if (typeof v !== 'string') throw new HttpError(400, `${field} 必须是字符串`);
  const s = normalizeBiliUid(v);
  if (!isValidBiliUid(s)) throw new HttpError(400, 'uid 必须是数字（可粘贴 space.bilibili.com/<uid> 链接）');
  return s;
}

/**
 * POST /api/bili/accounts：uid 必填（账号本身就是主播，身份锚点唯一）；
 * uname / displayName / enabled / ruleIds 可选。不做存在性校验——动态源首轮抓到才回写 uname，
 * 硬加校验等于把添加流程挂在 feed/space 的可用性上（与微博名单同一条纪律，见 docs/boundaries.md）。
 */
export function parseNewBiliAccount(body: unknown): {
  uid: string; uname: string | null; displayName: string | null; enabled: boolean; ruleIds: number[];
} {
  const o = asObject(body);
  rejectUnknownKeys(o, BILI_ACCOUNT_KEYS);
  if (!('uid' in o)) throw new HttpError(400, 'uid 必填');
  const out: { uid: string; uname: string | null; displayName: string | null; enabled: boolean; ruleIds: number[] } = {
    uid: asBiliUid(o.uid),
    uname: null,
    displayName: null,
    enabled: true,
    ruleIds: [],
  };
  if ('uname' in o) out.uname = asNullableString(o.uname, 'uname');
  if ('displayName' in o) out.displayName = asNullableString(o.displayName, 'displayName');
  if ('enabled' in o) out.enabled = asBoolean(o.enabled, 'enabled');
  if ('ruleIds' in o) out.ruleIds = asIdArray(o.ruleIds, 'ruleIds');
  return out;
}

/** PUT /api/bili/accounts/:id 的部分更新体；uid 是身份锚点不可改；至少一个字段 */
export function parseBiliAccountPatch(body: unknown): {
  uname?: string | null; displayName?: string | null; enabled?: boolean; ruleIds?: number[];
} {
  const o = asObject(body);
  rejectUnknownKeys(o, BILI_ACCOUNT_PATCH_KEYS);
  const p: { uname?: string | null; displayName?: string | null; enabled?: boolean; ruleIds?: number[] } = {};
  if ('uname' in o) p.uname = asNullableString(o.uname, 'uname');
  if ('displayName' in o) p.displayName = asNullableString(o.displayName, 'displayName');
  if ('enabled' in o) p.enabled = asBoolean(o.enabled, 'enabled');
  if ('ruleIds' in o) p.ruleIds = asIdArray(o.ruleIds, 'ruleIds');
  if (Object.keys(p).length === 0) throw new HttpError(400, '没有可更新的字段');
  return p;
}

/**
 * 主播详情里改「微博昵称」时同步维护**微博独立名单**（面板 PUT /api/streamers 与 MCP set_streamer 共用）：
 *  · 填了昵称并解析出 uid → 名单里没有就建一行、有关联就更新昵称与关联；
 *  · 清空昵称 → 解除关联（账号行保留，已归档的微博不删——它可能还在图文页独立使用）；
 *  · 没动这个字段 → 什么都不做（图文页里手动关联的关系不该被主播详情的一次无关保存冲掉）。
 *
 * 为什么两处都能改：主播详情的入口对「这个主播的微博」最自然，图文页的入口对「独立博主」最自然；
 * 它们维护的是同一份事实（weibo_accounts），不是两份配置。
 */
export function syncStreamerWeiboLink(db: Db, uid: string, patch: Partial<StreamerInput>): void {
  if (patch.weiboNick === undefined) return;
  if (patch.weiboNick === null || patch.weiboNick === '') {
    db.unlinkWeiboAccountsFromBili(uid);
    return;
  }
  if (!patch.weiboUid) return;
  const prev = db.getWeiboAccountByUid(patch.weiboUid);
  db.upsertWeiboAccount({
    ...(prev ? { id: prev.id } : { uid: patch.weiboUid }),
    nickname: patch.weiboNick,
    biliUid: uid,
  });
}
