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
