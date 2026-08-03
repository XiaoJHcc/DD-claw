/**
 * 面板 HTTP 层工具：请求体解析（64KB 上限）、参数校验（400 + 中文错误）、JSON 响应。
 * 校验失败一律抛 HttpError，由 server 统一转成 { error } 响应。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  ClausePatch, NewClause, PushTargetRef, StreamerInput,
} from '../core/streamers.js';

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

// ---- preference_clauses ----

export const CLAUSE_SCENES = ['chatting', 'singing', 'gaming', 'show', 'other'] as const;
const CLAUSE_PRIORITIES = ['high', 'normal', 'low'] as const;
const CLAUSE_KEYS = [
  'uid', 'scenes', 'minConfidence', 'titleKeywords',
  'priority', 'messageTemplate', 'targets', 'enabled',
] as const;

function parseScenes(v: unknown): string[] {
  const arr = asStringArray(v, 'scenes');
  for (const s of arr) {
    if (!(CLAUSE_SCENES as readonly string[]).includes(s)) {
      throw new HttpError(400, `scenes 含未知值 "${s}"（可选：${CLAUSE_SCENES.join(' / ')}）`);
    }
  }
  return arr;
}

function parseMinConfidence(v: unknown): number | null {
  if (v === null) return null;
  if (typeof v !== 'number' || Number.isNaN(v) || v < 0 || v > 1) {
    throw new HttpError(400, 'minConfidence 必须是 0-1 的数字或 null');
  }
  return v;
}

function parseTemplate(v: unknown): string {
  if (typeof v !== 'string') throw new HttpError(400, 'messageTemplate 必须是字符串');
  return v;
}

/** targets: [{type:'group'|'private', id:'纯数字'}] 或 null（默认目标） */
function parseTargets(v: unknown): PushTargetRef[] | null {
  if (v === null) return null;
  if (!Array.isArray(v)) throw new HttpError(400, 'targets 必须是数组或 null');
  return v.map((t, i): PushTargetRef => {
    const o = asObject(t);
    const type = asEnum(o.type, `targets[${i}].type`, ['group', 'private'] as const);
    return { type, id: parseUid(o.id, `targets[${i}].id`) };
  });
}

/** POST /api/clauses 的新建体：uid 必填，其余缺省走默认值。 */
export function parseNewClause(body: unknown): NewClause {
  const o = asObject(body);
  rejectUnknownKeys(o, CLAUSE_KEYS);
  return {
    uid: parseUid(o.uid),
    scenes: o.scenes === undefined ? [] : parseScenes(o.scenes),
    minConfidence: o.minConfidence === undefined ? null : parseMinConfidence(o.minConfidence),
    titleKeywords: o.titleKeywords === undefined ? [] : asStringArray(o.titleKeywords, 'titleKeywords'),
    priority: o.priority === undefined ? 'normal' : asEnum(o.priority, 'priority', CLAUSE_PRIORITIES),
    messageTemplate: o.messageTemplate === undefined ? '' : parseTemplate(o.messageTemplate),
    targets: o.targets === undefined ? null : parseTargets(o.targets),
    enabled: o.enabled === undefined ? true : asBoolean(o.enabled, 'enabled'),
  };
}

/** PUT /api/clauses/:id 的部分更新体；至少一个字段。 */
export function parseClausePatch(body: unknown): ClausePatch {
  const o = asObject(body);
  rejectUnknownKeys(o, CLAUSE_KEYS);
  const p: ClausePatch = {};
  if ('uid' in o) p.uid = parseUid(o.uid);
  if ('scenes' in o) p.scenes = parseScenes(o.scenes);
  if ('minConfidence' in o) p.minConfidence = parseMinConfidence(o.minConfidence);
  if ('titleKeywords' in o) p.titleKeywords = asStringArray(o.titleKeywords, 'titleKeywords');
  if ('priority' in o) p.priority = asEnum(o.priority, 'priority', CLAUSE_PRIORITIES);
  if ('messageTemplate' in o) p.messageTemplate = parseTemplate(o.messageTemplate);
  if ('targets' in o) p.targets = parseTargets(o.targets);
  if ('enabled' in o) p.enabled = asBoolean(o.enabled, 'enabled');
  if (Object.keys(p).length === 0) throw new HttpError(400, '没有可更新的字段');
  return p;
}
