/**
 * 会话存储：agent 对话（面板单会话 / QQ 每个来源渠道各一份）持久到库。
 *
 * 关键口径（docs/plan/agent-access.md「渠道隔离」「统一会话与 UX 一致性」）：
 * - **会话键 = 来源渠道**，与撤销栈用同一套 scope 字符串（`adminScope()` = 面板单会话，
 *   `channelScope(id)` = 某个群/私聊）。不同群、不同私聊、面板之间上下文**完全独立**，互不可见。
 * - **上下文不做自动裁剪**：面板由 UI 提示用量；QQ 侧达阈值时由回复末尾主动提示 `/reset`
 *   （`usage().needsResetHint`，阈值 40 条消息 / 8k 字符，可配）。
 * - 「重置上下文」= 清空该会话的消息，**保留会话行**（id 不变，便于审计与 UI 复用）。
 *
 * 集成状态：**尚未接线**（新建文件、零冲突）。接线需要 `Db` 暴露原始句柄（同 `undo.ts` 的说明），
 * 并在 `Db` 的迁移段调一次 `migrate()`。
 */
import type Database from 'better-sqlite3';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatSession {
  id: number;
  scope: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  id: number;
  sessionId: number;
  role: ChatRole;
  content: string;
  /** assistant 消息携带的工具调用（原样 JSON；null = 无） */
  toolCalls: unknown[] | null;
  /** role='tool' 时对应哪次调用 */
  toolCallId: string | null;
  createdAt: number;
}

export interface NewMessage {
  role: ChatRole;
  content: string;
  toolCalls?: unknown[] | null;
  toolCallId?: string | null;
}

export interface ChatUsage {
  messages: number;
  chars: number;
  /** 是否该在回复末尾提示「上下文已较长，发送 /reset 可清空」 */
  needsResetHint: boolean;
}

export interface ChatStoreOptions {
  now?: () => number;
  /** 提示阈值（计划给的是 40 条消息 / 8k 字符） */
  resetHint?: { maxMessages: number; maxChars: number };
}

const SESSIONS = 'chat_sessions';
const MESSAGES = 'chat_messages';

export const DEFAULT_RESET_HINT = { maxMessages: 40, maxChars: 8_000 } as const;

export class ChatStore {
  private readonly now: () => number;
  private readonly hint: { maxMessages: number; maxChars: number };

  constructor(private readonly db: Database.Database, opts: ChatStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.hint = opts.resetHint ?? { ...DEFAULT_RESET_HINT };
  }

  /** 建表（幂等）。接线时在 `Db` 的迁移段调一次 */
  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${SESSIONS} (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        scope      TEXT    NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ${MESSAGES} (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id   INTEGER NOT NULL,
        role         TEXT    NOT NULL CHECK(role IN ('system','user','assistant','tool')),
        content      TEXT    NOT NULL DEFAULT '',
        tool_calls   TEXT,
        tool_call_id TEXT,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_session ON ${MESSAGES}(session_id, id);
    `);
  }

  /** 取（或首次创建）该来源渠道的会话 */
  session(scope: string): ChatSession {
    const found = this.find(scope);
    if (found) return found;
    const at = this.now();
    const info = this.db
      .prepare(`INSERT INTO ${SESSIONS} (scope, created_at, updated_at) VALUES (?, ?, ?)`)
      .run(scope, at, at);
    return { id: Number(info.lastInsertRowid), scope, createdAt: at, updatedAt: at };
  }

  /** 只查不建（`reset` / 只读展示用） */
  find(scope: string): ChatSession | null {
    const r = this.db.prepare(`SELECT * FROM ${SESSIONS} WHERE scope = ?`).get(scope) as Record<string, unknown> | undefined;
    return r === undefined ? null : toSession(r);
  }

  list(): ChatSession[] {
    const rows = this.db.prepare(`SELECT * FROM ${SESSIONS} ORDER BY id`).all() as Array<Record<string, unknown>>;
    return rows.map(toSession);
  }

  append(scope: string, msg: NewMessage): number {
    const s = this.session(scope);
    const at = this.now();
    const info = this.db
      .prepare(`INSERT INTO ${MESSAGES} (session_id, role, content, tool_calls, tool_call_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(
        s.id,
        msg.role,
        msg.content,
        msg.toolCalls === undefined || msg.toolCalls === null ? null : JSON.stringify(msg.toolCalls),
        msg.toolCallId ?? null,
        at,
      );
    this.db.prepare(`UPDATE ${SESSIONS} SET updated_at = ? WHERE id = ?`).run(at, s.id);
    return Number(info.lastInsertRowid);
  }

  /**
   * 该会话的全部消息，**按时间升序、不裁剪**。
   * `limit` 只用于「取最近 N 条展示」，取的是最近 N 条后仍按升序返回。
   */
  messages(scope: string, opts: { limit?: number } = {}): ChatMessage[] {
    const s = this.find(scope);
    if (!s) return [];
    if (opts.limit === undefined) {
      const rows = this.db.prepare(`SELECT * FROM ${MESSAGES} WHERE session_id = ? ORDER BY id`).all(s.id) as Array<Record<string, unknown>>;
      return rows.map((r) => toMessage(r, s.id));
    }
    const rows = this.db
      .prepare(`SELECT * FROM (SELECT * FROM ${MESSAGES} WHERE session_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id`)
      .all(s.id, opts.limit) as Array<Record<string, unknown>>;
    return rows.map((r) => toMessage(r, s.id));
  }

  /** 用量（面板提示用；QQ 侧据此在回复末尾附 /reset 提示） */
  usage(scope: string): ChatUsage {
    const s = this.find(scope);
    if (!s) return { messages: 0, chars: 0, needsResetHint: false };
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(content)), 0) AS chars FROM ${MESSAGES} WHERE session_id = ?`)
      .get(s.id) as { n: number; chars: number };
    return {
      messages: r.n,
      chars: r.chars,
      needsResetHint: r.n >= this.hint.maxMessages || r.chars >= this.hint.maxChars,
    };
  }

  /** 重置上下文：清空消息、保留会话行；返回清掉的消息数（会话不存在则 0，且不新建） */
  reset(scope: string): number {
    const s = this.find(scope);
    if (!s) return 0;
    const info = this.db.prepare(`DELETE FROM ${MESSAGES} WHERE session_id = ?`).run(s.id);
    this.db.prepare(`UPDATE ${SESSIONS} SET updated_at = ? WHERE id = ?`).run(this.now(), s.id);
    return Number(info.changes);
  }
}

function toSession(r: Record<string, unknown>): ChatSession {
  return {
    id: Number(r.id),
    scope: String(r.scope),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function toMessage(r: Record<string, unknown>, sessionId: number): ChatMessage {
  return {
    id: Number(r.id),
    sessionId,
    role: String(r.role) as ChatRole,
    content: String(r.content ?? ''),
    toolCalls: r.tool_calls === null || r.tool_calls === undefined ? null : (JSON.parse(String(r.tool_calls)) as unknown[]),
    toolCallId: r.tool_call_id === null || r.tool_call_id === undefined ? null : String(r.tool_call_id),
    createdAt: Number(r.created_at),
  };
}
