/**
 * MCP 访问令牌：settings 表 `mcp_tokens`（JSON 数组 [{name, role, token}]）是唯一信源，
 * 由 `npm run mcp-token` CLI 管理（v1 不做面板卡片）。
 *
 * 角色模型（连接级身份是唯一可信来源——MCP 客户端（如 MaiBot）的工具参数由 LLM 生成，
 * 任何「发送者是谁」的字段都可被 prompt injection 伪造，故权限只看 token 角色）：
 * - admin   全量工具（Claude Code / 主人本机用）
 * - gateway 只读工具 + 群推送规则自助（MaiBot 用；admin 工具在该连接上不可见）
 *
 * token 只进 Authorization 头，绝不进日志/错误信息；比较走 sha256 后 timingSafeEqual。
 *
 * 鉴权口径（docs/plan/agent-access.md，2026-09-16 定）：`/mcp` **永远要令牌**——零令牌 503、
 * 缺失/无效 401，不设回环免 token；免 token 仅限 `/api/*`（面板与进程内 WebUI Agent，绑 127.0.0.1 即主人）。
 *
 * 调用域（scope）：渠道是 QQ 入口唯一可信的锚点，**由令牌绑定在服务端解析**，
 * 调用方声明什么渠道都无效（`channelId` 这类身份字段永不进工具 schema）。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../core/db.js';

export type McpRole = 'admin' | 'gateway';

/** 能力层调用域：身份只在这里出现，且由接入层解析后注入（能力层只读不推断） */
export interface ToolScope {
  /** 来源渠道（群/私聊映射出的 push_channels.id）；admin 令牌不带 = 全量无 scope */
  channelId?: number;
}

export interface McpTokenEntry {
  name: string;
  role: McpRole;
  token: string;
  /** gateway 令牌绑定的渠道（方案 A：一个来源渠道一条令牌）；admin 令牌不带 */
  channelId?: number;
}

/** 解析成功的调用方身份 + 调用域 */
export interface McpAuth {
  name: string;
  role: McpRole;
  scope: ToolScope;
}

const SETTINGS_KEY = 'mcp_tokens';

/**
 * 渠道 id 必须是正整数，非法值一律视为「未绑定」。
 * P2 的 gateway 写路径对「未绑定」必须**拒绝服务**，绝不回落默认渠道（否则越权）。
 */
export function readChannelId(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
}

/** 读 token 名单；坏 JSON / 形状非法的条目静默丢弃（面板时代 settings 由人/工具写，容错优先） */
export function listMcpTokens(db: Db): McpTokenEntry[] {
  const raw = db.getSetting(SETTINGS_KEY);
  if (!raw) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter(
    (e): e is McpTokenEntry =>
      typeof e === 'object' && e !== null &&
      typeof (e as McpTokenEntry).name === 'string' &&
      ((e as McpTokenEntry).role === 'admin' || (e as McpTokenEntry).role === 'gateway') &&
      typeof (e as McpTokenEntry).token === 'string',
  );
}

export function saveMcpTokens(db: Db, entries: McpTokenEntry[]): void {
  db.setSetting(SETTINGS_KEY, JSON.stringify(entries));
}

export function mintToken(): string {
  return `ddc_${randomBytes(24).toString('base64url')}`;
}

function tokenEq(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Authorization 头 → 调用方身份 + 调用域。
 * 返回 'unconfigured' = 一个 token 都没配（503，提示先跑 mcp-token CLI，避免裸奔）；
 * 返回 null = 缺失/无效 token（401）。
 */
export function resolveMcpAuth(db: Db, authHeader: string | undefined): McpAuth | null | 'unconfigured' {
  const tokens = listMcpTokens(db);
  if (tokens.length === 0) return 'unconfigured';
  const m = authHeader?.match(/^Bearer\s+(\S+)$/i);
  if (!m) return null;
  const entry = tokens.find((t) => tokenEq(t.token, m[1]!));
  if (!entry) return null;
  const channelId = readChannelId(entry.channelId);
  return { name: entry.name, role: entry.role, scope: channelId === undefined ? {} : { channelId } };
}
