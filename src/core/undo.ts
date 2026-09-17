/**
 * 写操作快照与撤销（P0 地基，产品目标 G4 的落地：docs/plan/agent-access.md「写操作快照与撤销」）。
 *
 * 实现取向：**表级前像快照 + 差分**，而不是让每条写路径自己声明「影响了哪些行」。
 * 计划里点名的五种形状（删分类级联停用 N 条规则 / 排序整表重写 sort / 新建 sort=MAX+1 /
 * settings 的删除式写 / provider 复合写两行 settings）在差分下**自动收敛为同一种记录**：
 * 差出来的就是「受影响行的前像（含级联影响）」，而且顺带拿到后像——撤销插入/删除才做得出来。
 * 代价是每次配置写要整表 SELECT 一遍；配置表只有几十到几百行、且**只在配置写路径调用**
 * （面板点一下 / 一次 MCP 工具调用），绝不进轮询循环——这个量级完全划算。
 *
 * 三条硬要求（计划原文）：
 * ① 覆盖所有配置写路径 → 用 `capture()` 把「读前像 → 写 → 读后像 → 落记录」包进**同一个事务**
 *    （better-sqlite3 的 `transaction()` 支持嵌套：写路径内部再开事务会退化成 savepoint，故可直接套在
 *    现有的 `Db.upsertXxx` 外面）；写抛错则事务回滚，写入与记录一起不落库。
 * ② 快照粒度 = 受影响行的前像 → 见上。
 * ③ 唯一隐私例外 = LLM key（`settings` 的 `llm_key:<provider>`）：**不落明文**，撤销 = 清空并要求重填。
 *
 * 撤销语义：栈式逆序（只撤最近一次、可连续撤、不跳序）、**每来源渠道一条独立栈**（面板 admin 另有全局栈）、
 * 逐行比对「后像 == 当前值」不等则**中止且一行都不动**（宁中止不丢写）、历史全量保留（只标记 undone，不删记录）。
 *
 * 集成状态：**尚未接线**（新建文件、零冲突）。接线需要 `Db` 暴露原始句柄与事务包装
 * （计划里的「`Db` 需先补一个公开 transaction 包装」，现 `src/core/db.ts:239` 是 `private readonly db`），
 * 然后把各写路径的**同步 SQL 段**套进 `capture()`；热生效回调（reconcileRuntime / reconcileListen / 重建 router）
 * 由撤销执行器在 `undo()` 成功后按「表 → 回调」映射触发（回调挂在 `PanelDeps` 闭包，属接线工作）。
 */
import type Database from 'better-sqlite3';

export type Row = Record<string, unknown>;

/** 一次写操作的归属信息（审计与「每渠道一条栈」都靠它） */
export interface ChangeMeta {
  /** 栈标识：'admin'（面板/本机全局）或 channelScope(id) */
  scope: string;
  /** 谁改的（令牌名 / 'panel' / 'agent'） */
  actor: string;
  /** 哪个入口（'panel' | 'mcp' | 'agent' | 'cli'） */
  entry: string;
  /** 工具名（有的话） */
  tool?: string;
  note?: string;
}

/** 受影响行的前像/后像；两者都为 null 的形态只出现在 redacted 行（值不落库） */
export interface RowImage {
  table: string;
  /** 主键列 → 值 */
  pk: Row;
  before: Row | null;
  after: Row | null;
  beforeExists: boolean;
  afterExists: boolean;
  /** 隐私例外：值未落库，只用存在性比对；撤销 = 清空该行并要求重填 */
  redacted?: boolean;
}

export interface ChangeRecord extends ChangeMeta {
  id: number;
  at: number;
  rows: RowImage[];
  undoneAt: number | null;
  undoneNote: string | null;
}

export interface UndoResult {
  ok: boolean;
  reason?: 'empty' | 'conflict';
  /** 撤销的变更记录 id */
  id?: number;
  /** 实际还原的行数 */
  applied?: number;
  /** 需重填的隐私字段（如 settings.llm_key:p1） */
  refill?: string[];
  /** reason='conflict' 时的定位信息 */
  detail?: string;
}

export type RedactPredicate = (table: string, column: string, row: Row) => boolean;

/**
 * 参与快照的配置表。`streamers` **暂不纳入**：它是配置与归档的混合体
 * （面板改 watch/alias，同时关注源会覆写 uname/face），纳入后撤销比对会被轮询写频繁打断、
 * 撤不掉反而更常见；收敛 streamers 的写路径时再裁决。归档表（room_state/posts/verdicts/live_segments）
 * 一律不进来——计划明确「不把轮询数据回滚」。
 */
export const DEFAULT_CONFIG_TABLES: readonly string[] = [
  'settings', 'push_rules', 'categories', 'push_channels', 'post_rules', 'x_accounts',
];

/** 隐私例外（计划里的唯一一条）：LLM key 不落明文 */
export const redactLlmKey: RedactPredicate = (table, column, row) =>
  table === 'settings' && column === 'value' &&
  typeof row.key === 'string' && row.key.startsWith('llm_key:');

export function adminScope(): string {
  return 'admin';
}

export function channelScope(channelId: number): string {
  return `ch:${channelId}`;
}

interface TableMeta {
  columns: string[];
  pk: string[];
}

const TABLE = 'undo_changes';

/** PRAGMA 不能绑定参数，故表名做标识符白名单校验后内插 */
function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`非法表名: ${name}`);
  return name;
}

function pkKey(values: readonly unknown[]): string {
  return JSON.stringify(values.map((v) => (v === undefined ? null : v)));
}

function norm(v: unknown): unknown {
  return v === undefined ? null : v;
}

function rowEq(a: Row | null, b: Row | null, columns: readonly string[]): boolean {
  if (a === null || b === null) return a === b;
  return JSON.stringify(columns.map((c) => [c, norm(a[c])])) === JSON.stringify(columns.map((c) => [c, norm(b[c])]));
}

export interface UndoStoreOptions {
  /** 参与快照的表；缺省 DEFAULT_CONFIG_TABLES */
  tables?: readonly string[];
  /** 时钟（测试可注入） */
  now?: () => number;
  /** 隐私例外判定；缺省 redactLlmKey */
  redact?: RedactPredicate;
}

export class UndoStore {
  private readonly tables: readonly string[];
  private readonly now: () => number;
  private readonly redact: RedactPredicate;
  private readonly meta = new Map<string, TableMeta>();

  constructor(private readonly db: Database.Database, opts: UndoStoreOptions = {}) {
    this.tables = opts.tables ?? DEFAULT_CONFIG_TABLES;
    if (this.tables.includes(TABLE)) throw new Error(`${TABLE} 不能作为快照表（记录自身不该被记录）`);
    this.now = opts.now ?? (() => Date.now());
    this.redact = opts.redact ?? redactLlmKey;
  }

  /** 建表（幂等）。接线时在 `Db` 的迁移段调一次 */
  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        scope         TEXT    NOT NULL,
        actor         TEXT    NOT NULL DEFAULT '',
        entry         TEXT    NOT NULL DEFAULT '',
        tool          TEXT,
        note          TEXT,
        at            INTEGER NOT NULL,
        rows          TEXT    NOT NULL,
        has_redacted  INTEGER NOT NULL DEFAULT 0,
        undone_at     INTEGER,
        undone_note   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_undo_scope ON ${TABLE}(scope, undone_at, id);
    `);
  }

  /**
   * 把一次配置写包进事务并记录差分。**写必须是同步 SQL 段**（better-sqlite3 事务不能跨 await）；
   * 异步校验（如 resolveWeiboNick）放在 capture 之前。返回写入返回值与变更记录 id（无净变化时为 null）。
   */
  capture<T>(meta: ChangeMeta, write: () => T): { value: T; changeId: number | null } {
    const run = this.db.transaction((): { value: T; changeId: number | null } => {
      const before = this.snapshot();
      const value = write();
      const after = this.snapshot();
      const rows = this.diff(before, after);
      return { value, changeId: rows.length > 0 ? this.insertRecord(meta, rows) : null };
    });
    return run();
  }

  /** 该栈顶（最近一次未撤销的变更） */
  peek(scope: string): ChangeRecord | null {
    const r = this.db
      .prepare(`SELECT * FROM ${TABLE} WHERE scope = ? AND undone_at IS NULL ORDER BY id DESC LIMIT 1`)
      .get(scope) as Record<string, unknown> | undefined;
    return r ? this.toRecord(r) : null;
  }

  /** 变更历史（含已撤销；历史全量保留） */
  history(opts: { scope?: string; limit?: number } = {}): ChangeRecord[] {
    const limit = opts.limit ?? 100;
    const rows = (opts.scope === undefined
      ? this.db.prepare(`SELECT * FROM ${TABLE} ORDER BY id DESC LIMIT ?`).all(limit)
      : this.db.prepare(`SELECT * FROM ${TABLE} WHERE scope = ? ORDER BY id DESC LIMIT ?`).all(opts.scope, limit)) as Array<Record<string, unknown>>;
    return rows.map((r) => this.toRecord(r));
  }

  /**
   * 撤销该栈顶。逐行比对后像与当前值，**不等则中止且一行都不改**；隐私行只比对存在性，
   * 撤销动作一律是清空该行（值本来就没落库），并在结果里给出 refill 提示。
   */
  undo(scope: string): UndoResult {
    const rec = this.peek(scope);
    if (!rec) return { ok: false, reason: 'empty' };

    const run = this.db.transaction((): UndoResult => {
      const images = [...rec.rows].reverse(); // 逆序：后发生的先还原
      for (const img of images) {
        const cur = this.readRow(img.table, img.pk);
        if (img.redacted) {
          if ((cur !== null) !== img.afterExists) {
            return { ok: false, reason: 'conflict', detail: `${img.table} ${pkLabel(img)} 已被其他入口修改` };
          }
          continue;
        }
        if (!rowEq(cur, img.after, this.columnsOf(img.table))) {
          return { ok: false, reason: 'conflict', detail: `${img.table} ${pkLabel(img)} 已被其他入口修改` };
        }
      }

      const refill: string[] = [];
      let applied = 0;
      for (const img of images) {
        if (img.redacted) {
          if (this.readRow(img.table, img.pk) !== null) {
            this.deleteRow(img.table, img.pk);
            applied++;
          }
          refill.push(`${img.table}.${pkLabel(img)}`);
          continue;
        }
        if (img.before === null) {
          this.deleteRow(img.table, img.pk);
          applied++;
        } else if (img.after === null) {
          this.insertRow(img.table, img.before);
          applied++;
        } else {
          this.updateRow(img.table, img.pk, img.before);
          applied++;
        }
      }

      this.db
        .prepare(`UPDATE ${TABLE} SET undone_at = ?, undone_note = ? WHERE id = ?`)
        .run(this.now(), refill.length > 0 ? `需重填: ${refill.join(', ')}` : null, rec.id);
      return refill.length > 0
        ? { ok: true, id: rec.id, applied, refill }
        : { ok: true, id: rec.id, applied };
    });
    return run();
  }

  // ---- 内部：快照与差分 ----

  private ensureMeta(table: string): TableMeta | null {
    const cached = this.meta.get(table);
    if (cached) return cached;
    const info = this.db.prepare(`PRAGMA table_info(${ident(table)})`).all() as Array<{ name: string; pk: number }>;
    if (info.length === 0) return null; // 表不存在（如尚未升级的库）→ 视为该配置面不存在
    const pk = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    if (pk.length === 0) return null; // 无主键 → 无法定位行，不参与撤销
    const meta: TableMeta = { columns: info.map((c) => c.name), pk };
    this.meta.set(table, meta);
    return meta;
  }

  private columnsOf(table: string): readonly string[] {
    return this.ensureMeta(table)?.columns ?? [];
  }

  private snapshot(): Map<string, Map<string, Row>> {
    const out = new Map<string, Map<string, Row>>();
    for (const table of this.tables) {
      const meta = this.ensureMeta(table);
      if (!meta) continue;
      const rows = this.db.prepare(`SELECT * FROM ${ident(table)}`).all() as Row[];
      const m = new Map<string, Row>();
      for (const r of rows) m.set(pkKey(meta.pk.map((c) => r[c])), r);
      out.set(table, m);
    }
    return out;
  }

  private diff(
    before: Map<string, Map<string, Row>>,
    after: Map<string, Map<string, Row>>,
  ): RowImage[] {
    const out: RowImage[] = [];
    for (const table of new Set([...before.keys(), ...after.keys()])) {
      const meta = this.ensureMeta(table);
      if (!meta) continue;
      const b = before.get(table) ?? new Map<string, Row>();
      const a = after.get(table) ?? new Map<string, Row>();
      for (const key of new Set([...b.keys(), ...a.keys()])) {
        const rb = b.get(key) ?? null;
        const ra = a.get(key) ?? null;
        if (rowEq(rb, ra, meta.columns)) continue;
        const vals = JSON.parse(key) as unknown[];
        const pk: Row = {};
        meta.pk.forEach((c, i) => { pk[c] = vals[i] ?? null; });
        const redacted = this.isRedacted(table, rb, ra, meta.columns);
        out.push({
          table,
          pk,
          before: redacted ? null : rb,
          after: redacted ? null : ra,
          beforeExists: rb !== null,
          afterExists: ra !== null,
          ...(redacted ? { redacted: true } : {}),
        });
      }
    }
    return out;
  }

  private isRedacted(table: string, rb: Row | null, ra: Row | null, columns: readonly string[]): boolean {
    const ref = rb ?? ra;
    if (ref === null) return false;
    const changed = rb === null || ra === null
      ? columns
      : columns.filter((c) => JSON.stringify(norm(rb[c])) !== JSON.stringify(norm(ra[c])));
    return changed.some((c) => this.redact(table, c, ref));
  }

  // ---- 内部：行操作 ----

  private readRow(table: string, pk: Row): Row | null {
    const meta = this.ensureMeta(table)!;
    const where = meta.pk.map((c) => `${ident(c)} = ?`).join(' AND ');
    const r = this.db.prepare(`SELECT * FROM ${ident(table)} WHERE ${where}`).get(...meta.pk.map((c) => pk[c] ?? null)) as Row | undefined;
    return r ?? null;
  }

  private deleteRow(table: string, pk: Row): void {
    const meta = this.ensureMeta(table)!;
    const where = meta.pk.map((c) => `${ident(c)} = ?`).join(' AND ');
    this.db.prepare(`DELETE FROM ${ident(table)} WHERE ${where}`).run(...meta.pk.map((c) => pk[c] ?? null));
  }

  /** 按前像整行重插（保留原主键、sort、时间戳——计划要求「按原 id 重插并还原」） */
  private insertRow(table: string, row: Row): void {
    const cols = Object.keys(row);
    const sql = `INSERT INTO ${ident(table)} (${cols.map(ident).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    this.db.prepare(sql).run(...cols.map((c) => norm(row[c])));
  }

  private updateRow(table: string, pk: Row, before: Row): void {
    const meta = this.ensureMeta(table)!;
    const cols = Object.keys(before).filter((c) => !meta.pk.includes(c));
    if (cols.length === 0) return;
    const where = meta.pk.map((c) => `${ident(c)} = ?`).join(' AND ');
    const sql = `UPDATE ${ident(table)} SET ${cols.map((c) => `${ident(c)} = ?`).join(', ')} WHERE ${where}`;
    this.db.prepare(sql).run(...cols.map((c) => norm(before[c])), ...meta.pk.map((c) => pk[c] ?? null));
  }

  // ---- 内部：记录读写 ----

  private insertRecord(meta: ChangeMeta, rows: RowImage[]): number {
    const info = this.db
      .prepare(`INSERT INTO ${TABLE} (scope, actor, entry, tool, note, at, rows, has_redacted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        meta.scope,
        meta.actor,
        meta.entry,
        meta.tool ?? null,
        meta.note ?? null,
        this.now(),
        JSON.stringify(rows),
        rows.some((r) => r.redacted) ? 1 : 0,
      );
    return Number(info.lastInsertRowid);
  }

  private toRecord(r: Record<string, unknown>): ChangeRecord {
    return {
      id: Number(r.id),
      scope: String(r.scope),
      actor: String(r.actor ?? ''),
      entry: String(r.entry ?? ''),
      ...(r.tool === null || r.tool === undefined ? {} : { tool: String(r.tool) }),
      ...(r.note === null || r.note === undefined ? {} : { note: String(r.note) }),
      at: Number(r.at),
      rows: JSON.parse(String(r.rows)) as RowImage[],
      undoneAt: r.undone_at === null || r.undone_at === undefined ? null : Number(r.undone_at),
      undoneNote: r.undone_note === null || r.undone_note === undefined ? null : String(r.undone_note),
    };
  }
}

/** 冲突提示里的行定位（供 UI / agent 文案用） */
export function pkLabel(img: RowImage): string {
  const parts = Object.entries(img.pk).map(([k, v]) => `${k}=${String(v)}`);
  return parts.length > 0 ? `(${parts.join(', ')})` : '(未知主键)';
}
