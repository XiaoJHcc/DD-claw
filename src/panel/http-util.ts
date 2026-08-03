/**
 * 面板 HTTP 层工具：请求体解析（64KB 上限）、参数校验（400 + 中文错误）、JSON 响应。
 * 校验失败一律抛 HttpError，由 server 统一转成 { error } 响应。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { StreamerInput } from '../core/streamers.js';
import type { NewPushChannel, NewPushRule, PushChannelInput, PushRuleInput } from '../core/push.js';

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

// ---- push_rules ----

const RULE_KEYS = ['uid', 'keywords', 'areas', 'channels', 'messageTemplate', 'enabled'] as const;

function asIdArray(v: unknown, field: string): number[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'number' || !Number.isInteger(x) || x <= 0)) {
    throw new HttpError(400, `${field} 必须是正整数 id 数组`);
  }
  return v as number[];
}

function parseMessageTemplate(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') throw new HttpError(400, 'messageTemplate 必须是字符串或 null');
  return v === '' ? null : v; // 空串 = 用全局默认模板
}

function parseRuleFields(o: Record<string, unknown>, p: PushRuleInput): void {
  if ('keywords' in o) p.keywords = asStringArray(o.keywords, 'keywords');
  if ('areas' in o) p.areas = asStringArray(o.areas, 'areas');
  if ('channels' in o) p.channels = asIdArray(o.channels, 'channels');
  if ('messageTemplate' in o) p.messageTemplate = parseMessageTemplate(o.messageTemplate);
  if ('enabled' in o) p.enabled = asBoolean(o.enabled, 'enabled');
}

/** POST /api/rules 的新建体：uid 必填，其余缺省走默认值。 */
export function parseNewRule(body: unknown): NewPushRule {
  const o = asObject(body);
  rejectUnknownKeys(o, RULE_KEYS);
  const p: PushRuleInput = {};
  parseRuleFields(o, p);
  return {
    uid: parseUid(o.uid),
    keywords: p.keywords ?? [],
    areas: p.areas ?? [],
    channels: p.channels ?? [],
    messageTemplate: p.messageTemplate ?? null,
    enabled: p.enabled ?? true,
  };
}

/** PUT /api/rules/:id 的部分更新体；至少一个字段。 */
export function parseRulePatch(body: unknown): PushRuleInput {
  const o = asObject(body);
  rejectUnknownKeys(o, ['keywords', 'areas', 'channels', 'messageTemplate', 'enabled']);
  const p: PushRuleInput = {};
  parseRuleFields(o, p);
  if (Object.keys(p).length === 0) throw new HttpError(400, '没有可更新的字段');
  return p;
}

// ---- settings ----

/** PUT /api/push/template：{ template: string }（空串 = 清除，回到内置默认） */
export function parseTemplateBody(body: unknown): string {
  const o = asObject(body);
  rejectUnknownKeys(o, ['template']);
  if (typeof o.template !== 'string') throw new HttpError(400, 'template 必须是字符串');
  return o.template;
}
