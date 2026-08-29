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
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../core/db.js';

export type McpRole = 'admin' | 'gateway';

export interface McpTokenEntry {
  name: string;
  role: McpRole;
  token: string;
}

/** 解析成功的调用方身份 */
export interface McpAuth {
  name: string;
  role: McpRole;
}

const SETTINGS_KEY = 'mcp_tokens';

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
 * Authorization 头 → 调用方身份。
 * 返回 'unconfigured' = 一个 token 都没配（503，提示先跑 mcp-token CLI，避免裸奔）；
 * 返回 null = 缺失/无效 token（401）。
 */
export function resolveMcpAuth(db: Db, authHeader: string | undefined): McpAuth | null | 'unconfigured' {
  const tokens = listMcpTokens(db);
  if (tokens.length === 0) return 'unconfigured';
  const m = authHeader?.match(/^Bearer\s+(\S+)$/i);
  if (!m) return null;
  const entry = tokens.find((t) => tokenEq(t.token, m[1]!));
  return entry ? { name: entry.name, role: entry.role } : null;
}
