/**
 * 面板 HTTP 层工具：请求体解析（64KB 上限）、参数校验（400 + 中文错误）、JSON 响应。
 * 校验失败一律抛 HttpError，由 server 统一转成 { error } 响应。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Db } from '../core/db.js';
import type { StreamerInput } from '../core/streamers.js';
import type {
  CategoryInput, JudgeCondition, JudgeDirection, JudgeMode, NewCategory, NewPushChannel, NewPushRule,
  PushChannelInput, PushRuleInput,
} from '../core/push.js';
import { preciseConditions } from '../core/push.js';
import { NUM_SPECS, BOOL_SPECS, type RuntimeConfig } from '../core/runtime-config.js';
import {
  X_INTERVAL_MAX, X_INTERVAL_MIN, type XConfig,
} from '../core/x-config.js';
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
 * weiboNick 空字符串 = 清除；昵称→UID 的解析在注册表工具层做（set_streamer，需要注入 resolver）。
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

const CATEGORY_KEYS = [
  'name', 'llmPrompt', 'judgeMode', 'judgeConditions', 'keywords', 'areas', 'appliesTo', 'postTypes',
  'requireQuote', 'requireMedia', 'condMode', 'primary', 'enabled',
] as const;
const COND_MODES = ['and', 'or'] as const;
const SUBJECT_KINDS = ['live', 'post'] as const;
const POST_TYPES = ['original', 'retweet'] as const;
const JUDGE_MODES = ['simple', 'precise'] as const;
const JUDGE_DIRECTIONS = ['pass', 'reject'] as const;
const JUDGE_CONDITION_KEYS = ['id', 'direction', 'text', 'enabled'] as const;

/**
 * 精确条件数组校验（严格形状）：未知字段、非对象项、坏 direction / 非布尔 enabled、
 * 空白 text、分类内重复 id 一律 400。缺 id 的新条件在这里补 `randomUUID()`（前端不必自己造 id），
 * 已有 id 原样保留——它是逐条概率与审计对齐的锚点。
 */
function asJudgeConditions(v: unknown, field: string): JudgeCondition[] {
  if (!Array.isArray(v)) throw new HttpError(400, `${field} 必须是数组`);
  const out: JudgeCondition[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new HttpError(400, `${field} 的每一项必须是对象`);
    }
    const o = item as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (!(JUDGE_CONDITION_KEYS as readonly string[]).includes(k)) {
        throw new HttpError(400, `${field} 的条件含未知字段: ${k}`);
      }
    }
    if (o.id !== undefined && typeof o.id !== 'string') throw new HttpError(400, `${field} 的条件 id 必须是字符串`);
    const id = typeof o.id === 'string' && o.id.trim() !== '' ? o.id.trim() : randomUUID();
    if (seen.has(id)) throw new HttpError(400, `${field} 的条件 id 重复: ${id}`);
    seen.add(id);
    if (!(JUDGE_DIRECTIONS as readonly string[]).includes(String(o.direction))) {
      throw new HttpError(400, `${field} 的条件 direction 必须是 pass / reject`);
    }
    if (typeof o.text !== 'string') throw new HttpError(400, `${field} 的条件 text 必须是字符串`);
    const text = o.text.trim();
    if (text === '') throw new HttpError(400, `${field} 的条件 text 不能为空`);
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean') {
      throw new HttpError(400, `${field} 的条件 enabled 必须是布尔值`);
    }
    out.push({ id, direction: o.direction as JudgeDirection, text, enabled: o.enabled !== false });
  }
  return out;
}

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
  if ('judgeMode' in o) p.judgeMode = asEnum(o.judgeMode, 'judgeMode', JUDGE_MODES);
  // 两种模式的数据双份保留：切模式只改 judgeMode，judgeConditions / llmPrompt 都原样存着
  if ('judgeConditions' in o) p.judgeConditions = asJudgeConditions(o.judgeConditions, 'judgeConditions');
  if ('keywords' in o) p.keywords = asStringArray(o.keywords, 'keywords');
  if ('areas' in o) p.areas = asStringArray(o.areas, 'areas');
  if ('appliesTo' in o) p.appliesTo = asEnum(o.appliesTo, 'appliesTo', SUBJECT_KINDS);
  if ('postTypes' in o) {
    const arr = asStringArray(o.postTypes, 'postTypes');
    for (const t of arr) {
      if (!(POST_TYPES as readonly string[]).includes(t)) {
        throw new HttpError(400, 'postTypes 元素必须是 original / retweet');
      }
    }
    p.postTypes = arr as Array<'original' | 'retweet'>;
  }
  if ('requireQuote' in o) p.requireQuote = asBoolean(o.requireQuote, 'requireQuote');
  if ('requireMedia' in o) p.requireMedia = asBoolean(o.requireMedia, 'requireMedia');
  if ('condMode' in o) p.condMode = asEnum(o.condMode, 'condMode', COND_MODES);
  if ('primary' in o) p.primary = asBoolean(o.primary, 'primary');
  if ('enabled' in o) p.enabled = asBoolean(o.enabled, 'enabled');
}

/**
 * 分类条件可用性：所有确定性条件组皆空 **且** 没有模型判定口径 = 死分类
 *（确定性无从判定、模型也没有口径）。POST 对缺省合并后的形状调，PUT 对合并后形状调。
 *
 * 判定口径按模式取：simple = 判定描述非空；precise = 至少一条启用的正向条件。
 * 精确模式下 `llmPrompt` **不算口径**——它只是被保留下来供切回简单模式用，
 * 精确模式绝不回退它（否则分类会带着「一个能用的条件都没有」的状态进判决链）。
 * 「主分类」勾选不是条件（只决定它是否进主分类判定的候选集），不参与这里的最小配置校验。
 */
export function checkCategoryConditions(c: {
  appliesTo?: 'live' | 'post';
  judgeMode?: JudgeMode;
  llmPrompt?: string | null;
  judgeConditions?: JudgeCondition[];
  keywords?: string[]; areas?: string[];
  postTypes?: string[]; requireQuote?: boolean; requireMedia?: boolean;
}): void {
  if ((c.appliesTo ?? 'live') === 'live' && ((c.postTypes ?? []).length > 0 || c.requireQuote || c.requireMedia)) {
    throw new HttpError(400, '直播分类不能配置帖子类型、引用或带图条件');
  }
  if (c.appliesTo === 'post' && (c.areas ?? []).length > 0) {
    throw new HttpError(400, '图文分类不能配置直播分区条件');
  }
  const noCond = (c.keywords ?? []).length === 0
    && (c.areas ?? []).length === 0
    && (c.postTypes ?? []).length === 0
    && !c.requireQuote
    && !c.requireMedia;
  if (noCond) {
    if ((c.judgeMode ?? 'simple') === 'precise') {
      if (preciseConditions({ judgeConditions: c.judgeConditions ?? [] }).positives.length === 0) {
        throw new HttpError(400, '精确模式至少要有一条启用的通过条件（只有拒绝条件时无从判「属于」）');
      }
    } else if ((c.llmPrompt?.trim() ?? '') === '') {
      throw new HttpError(400, '至少配置判定描述或一组确定性条件（关键词/分区/帖子类型/引用/带图）');
    }
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
    judgeMode: p.judgeMode ?? 'simple',
    judgeConditions: p.judgeConditions ?? [],
    keywords: p.keywords ?? [],
    areas: p.areas ?? [],
    postTypes: p.postTypes ?? [],
    requireQuote: p.requireQuote ?? false,
    requireMedia: p.requireMedia ?? false,
    appliesTo: p.appliesTo ?? 'live',
    condMode: p.condMode ?? 'and',
    primary: p.primary ?? false,
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

// ---- push_rules：推送规则（统一规则：分类引用 × 生效范围 × 渠道 × 推送词 × 附加动作）----

const RULE_KEYS = [
  'name', 'subjectKind', 'categoryId', 'scope', 'channels', 'messageTemplate', 'llmTranslate', 'enabled',
] as const;

function asIdArray(v: unknown, field: string): number[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'number' || !Number.isInteger(x) || x <= 0)) {
    throw new HttpError(400, `${field} 必须是正整数 id 数组`);
  }
  return v as number[];
}

/** categoryId：正整数 id 或 null（null = 任意内容） */
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

/** 生效范围引用的宽松形状校验：元素 = 纯数字 uid（live）或 `twitter:账号`/`weibo:uid`/`bili:uid`（post）。
 *  归属语义（哪类引用合法）由 checkRuleRefs 按合并后的 subject_kind 权威校验——PATCH 只给 scope
 *  时 subjectKind 还在旧行上，解析层不能替它决定。 */
function asScopeArray(v: unknown, field = 'scope'): string[] {
  const arr = asStringArray(v, field);
  for (const ref of arr) {
    if (!/^\d+$/.test(ref) && !/^(twitter|weibo|bili):.+/.test(ref)) {
      throw new HttpError(400, `${field} 元素必须是纯数字 uid 或 \`twitter:账号\` / \`weibo:uid\` / \`bili:uid\` 形式`);
    }
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
  if ('subjectKind' in o) p.subjectKind = asEnum(o.subjectKind, 'subjectKind', SUBJECT_KINDS);
  if ('categoryId' in o) p.categoryId = asNullableId(o.categoryId, 'categoryId');
  if ('scope' in o) p.scope = asScopeArray(o.scope);
  if ('channels' in o) p.channels = asIdArray(o.channels, 'channels');
  if ('messageTemplate' in o) p.messageTemplate = parseMessageTemplate(o.messageTemplate);
  if ('llmTranslate' in o) p.llmTranslate = asBoolean(o.llmTranslate, 'llmTranslate');
  if ('enabled' in o) p.enabled = asBoolean(o.enabled, 'enabled');
}

/** POST /api/rules 的新建体：全部可省（缺省 = 任意内容 / 全部生效 / 无渠道 / 默认模板）。引用存在性校验在路由层。 */
export function parseNewRule(body: unknown): NewPushRule {
  const o = asObject(body);
  rejectUnknownKeys(o, RULE_KEYS);
  const p: PushRuleInput = {};
  parseRuleFields(o, p);
  return {
    name: p.name ?? '',
    subjectKind: p.subjectKind ?? 'live',
    categoryId: p.categoryId !== undefined ? p.categoryId : null,
    scope: p.scope ?? [],
    channels: p.channels ?? [],
    messageTemplate: p.messageTemplate ?? null,
    llmTranslate: p.llmTranslate ?? false,
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

/**
 * 规则引用存在性校验：分类 / 渠道 / 生效主体（scope）都必须存在。
 * scope 引用域随 subject_kind：live = 监听名单内的主播 uid；post = 图文账号引用
 * （`twitter:screenName` / `weibo:uid` / `bili:uid`，对应名单行必须在）。
 * 形状也在这一层按 kind 权威校验（解析层只做宽松形状检查，见 asScopeArray）。
 */
export function checkRuleRefs(
  db: Db,
  r: { subjectKind: 'live' | 'post'; categoryId: number | null; scope: string[]; channels: number[] },
): void {
  if (r.categoryId !== null) {
    const category = db.listCategories().find((c) => c.id === r.categoryId);
    if (!category) throw new HttpError(400, '分类不存在');
    if (category.appliesTo !== r.subjectKind) throw new HttpError(400, '分类与推送规则的内容类型不一致');
  }
  const channelIds = new Set(db.listPushChannels().map((c) => c.id));
  for (const id of r.channels) {
    if (!channelIds.has(id)) throw new HttpError(400, `渠道不存在: ${id}`);
  }
  if (r.subjectKind === 'live') {
    const streamerUids = new Set(db.listStreamers().map((s) => s.uid));
    for (const uid of r.scope) {
      if (!/^\d+$/.test(uid) || !streamerUids.has(uid)) throw new HttpError(400, `主播不在监听名单: ${uid}`);
    }
    return;
  }
  for (const ref of r.scope) {
    if (!checkPostSubjectRefExists(db, ref)) throw new HttpError(400, `账号引用不存在: ${ref}`);
  }
}

/** post 规则 scope 引用的账号行存在性（`twitter:screenName` / `weibo:uid` / `bili:uid`） */
function checkPostSubjectRefExists(db: Db, ref: string): boolean {
  const i = ref.indexOf(':');
  if (i <= 0) return false;
  const kind = ref.slice(0, i);
  const key = ref.slice(i + 1);
  if (!key) return false;
  if (kind === 'twitter') return Boolean(db.getXAccountByScreenName(key));
  if (kind === 'weibo') return Boolean(db.getWeiboAccountByUid(key));
  if (kind === 'bili') return Boolean(db.getBiliAccountByUid(key));
  return false;
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

// 身份（screenName）与平台昵称（nickname）都是平台事实：POST 只收身份——昵称由添加时的
// verify 顺手种入、抓取回写（见 sources/twitter/web.ts / feed.ts）；PUT 一律不可改
//（要换账号就删除重加，改了只会让 posts.uid 历史孤立）
const X_ACCOUNT_KEYS = ['screenName', 'biliUid', 'displayName', 'enabled'] as const;
const X_PATCH_KEYS = ['biliUid', 'displayName', 'enabled'] as const;

/** screen name 归一化 + 形状校验（`@abc` / `ABC` 都收，统一成小写） */
function asScreenName(v: unknown, field = 'screenName'): string {
  if (typeof v !== 'string') throw new HttpError(400, `${field} 必须是字符串`);
  const s = normalizeScreenName(v);
  if (!isValidScreenName(s)) {
    throw new HttpError(400, 'X 账号格式不对（字母 / 数字 / 下划线，1~15 位）');
  }
  return s;
}

/** POST /api/x/accounts：screenName 必填；biliUid / displayName 可选（存在性在路由层校验）；
 * enabled 缺省 true。昵称不收（平台事实：verify 种入 / 抓取回写） */
export function parseNewXAccount(body: unknown): {
  screenName: string; biliUid: string | null; displayName: string | null; enabled: boolean;
} {
  const o = asObject(body);
  rejectUnknownKeys(o, X_ACCOUNT_KEYS);
  if (!('screenName' in o)) throw new HttpError(400, 'screenName 必填');
  const out: { screenName: string; biliUid: string | null; displayName: string | null; enabled: boolean } = {
    screenName: asScreenName(o.screenName),
    biliUid: null,
    displayName: null,
    enabled: true,
  };
  if ('biliUid' in o && o.biliUid !== null) out.biliUid = parseUid(o.biliUid, 'biliUid');
  if ('displayName' in o) out.displayName = asNullableString(o.displayName, 'displayName');
  // enabled 必须被采纳：显式传 false 却被静默忽略会让人以为停用生效了
  if ('enabled' in o) out.enabled = asBoolean(o.enabled, 'enabled');
  return out;
}

/** PUT /api/x/accounts/:id 的部分更新体；至少一个字段。ID 与昵称是平台事实不可改
 *  （传入按未知字段 400；要换账号就删除后重新添加） */
export function parseXAccountPatch(body: unknown): {
  biliUid?: string | null; displayName?: string | null; enabled?: boolean;
} {
  const o = asObject(body);
  rejectUnknownKeys(o, X_PATCH_KEYS);
  const p: {
    biliUid?: string | null; displayName?: string | null; enabled?: boolean;
  } = {};
  if ('biliUid' in o) p.biliUid = o.biliUid === null ? null : parseUid(o.biliUid, 'biliUid');
  if ('displayName' in o) p.displayName = asNullableString(o.displayName, 'displayName');
  if ('enabled' in o) p.enabled = asBoolean(o.enabled, 'enabled');
  if (Object.keys(p).length === 0) throw new HttpError(400, '没有可更新的字段');
  return p;
}

// ---- 微博关注账号（独立名单，biliUid 仅可选关联；与 X 账号同一套语义）----
// POST 的 nickname 是解析键（只填昵称 → 走匿名解析链补 uid），存下的即平台解析结果；
// PUT 起 uid 与昵称都锁定——平台事实，抓取每轮回写（要换账号就删除重加）
const WEIBO_ACCOUNT_KEYS = ['uid', 'nickname', 'displayName', 'biliUid', 'enabled'] as const;
const WEIBO_PATCH_KEYS = ['displayName', 'biliUid', 'enabled'] as const;

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
} {
  const o = asObject(body);
  rejectUnknownKeys(o, WEIBO_ACCOUNT_KEYS);
  if (!('uid' in o) && !('nickname' in o)) throw new HttpError(400, 'uid 与昵称至少填一个');
  const out: {
    uid: string | null; nickname: string | null; displayName: string | null; biliUid: string | null; enabled: boolean;
  } = { uid: null, nickname: null, displayName: null, biliUid: null, enabled: true };
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
  return out;
}

/** PUT /api/weibo/accounts/:id 的部分更新体；至少一个字段。uid 与昵称是平台事实不可改
 *  （传入按未知字段 400；要换账号就删除后重新添加） */
export function parseWeiboAccountPatch(body: unknown): {
  displayName?: string | null; biliUid?: string | null; enabled?: boolean;
} {
  const o = asObject(body);
  rejectUnknownKeys(o, WEIBO_PATCH_KEYS);
  const p: {
    displayName?: string | null; biliUid?: string | null; enabled?: boolean;
  } = {};
  if ('displayName' in o) p.displayName = asNullableString(o.displayName, 'displayName');
  if ('biliUid' in o) p.biliUid = o.biliUid === null ? null : parseUid(o.biliUid, 'biliUid');
  if ('enabled' in o) p.enabled = asBoolean(o.enabled, 'enabled');
  if (Object.keys(p).length === 0) throw new HttpError(400, '没有可更新的字段');
  return p;
}

// ---- B站动态账号（独立名单：只管推送选用，抓取轮询对象由动态源自并监听主播）----
// uid 是身份锚点（新建必填、PUT 不可改）；uname 是平台事实（抓取回写），输入面一概不收
// ——要换账号就删除后重新添加，改了只会让 posts.uid 历史孤立
const BILI_ACCOUNT_KEYS = ['uid', 'displayName', 'enabled'] as const;
const BILI_ACCOUNT_PATCH_KEYS = ['displayName', 'enabled'] as const;

/** uid 归一化 + 形状校验（收 `7706705` / `space.bilibili.com/7706705` 链接形态） */
function asBiliUid(v: unknown, field = 'uid'): string {
  if (typeof v !== 'string') throw new HttpError(400, `${field} 必须是字符串`);
  const s = normalizeBiliUid(v);
  if (!isValidBiliUid(s)) throw new HttpError(400, 'uid 必须是数字（可粘贴 space.bilibili.com/<uid> 链接）');
  return s;
}

/**
 * POST /api/bili/accounts：uid 必填（账号本身就是主播，身份锚点唯一）；
 * displayName / enabled 可选。uname 不收（平台事实，抓取回写）。不做存在性
 * 校验——动态源首轮抓到才回写 uname，硬加校验等于把添加流程挂在 feed/space 的可用性上
 * （与微博名单同一条纪律，见 docs/boundaries.md）。
 */
export function parseNewBiliAccount(body: unknown): {
  uid: string; displayName: string | null; enabled: boolean;
} {
  const o = asObject(body);
  rejectUnknownKeys(o, BILI_ACCOUNT_KEYS);
  if (!('uid' in o)) throw new HttpError(400, 'uid 必填');
  const out: { uid: string; displayName: string | null; enabled: boolean } = {
    uid: asBiliUid(o.uid),
    displayName: null,
    enabled: true,
  };
  if ('displayName' in o) out.displayName = asNullableString(o.displayName, 'displayName');
  if ('enabled' in o) out.enabled = asBoolean(o.enabled, 'enabled');
  return out;
}

/** PUT /api/bili/accounts/:id 的部分更新体；uid 是身份锚点不可改、uname 是平台事实不可改
 *  （传入按未知字段 400）；至少一个字段 */
export function parseBiliAccountPatch(body: unknown): {
  displayName?: string | null; enabled?: boolean;
} {
  const o = asObject(body);
  rejectUnknownKeys(o, BILI_ACCOUNT_PATCH_KEYS);
  const p: { displayName?: string | null; enabled?: boolean } = {};
  if ('displayName' in o) p.displayName = asNullableString(o.displayName, 'displayName');
  if ('enabled' in o) p.enabled = asBoolean(o.enabled, 'enabled');
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
