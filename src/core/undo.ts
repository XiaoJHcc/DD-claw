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
 * ③ 唯一隐私例外 = 模型 key（`settings` 的 `llm_key:<provider>` 与 `decision_key:<provider>`）：
 *    **不落明文**，撤销 = 清空并要求重填。
 *
 * 撤销语义：栈式逆序（只撤最近一次、可连续撤、不跳序）、**每来源渠道一条独立栈**（面板 admin 另有全局栈）、
 * 逐行比对「后像 == 当前值」不等则**中止且一行都不动**（宁中止不丢写）、历史全量保留（只标记 undone，不删记录）。
 *
 * 另外两条（切片 C 裁决）：
 * - **「配置 + 归档」混合表按列过滤**（`DEFAULT_IGNORE_COLUMNS`）：轮询源回写的游标/心跳/头像列既不算差分、
 *   也不参与比对与还原——面板 / agent 对这些行的配置写因此可撤销，且不会被轮询写频繁打断。
 * - **撤销本身不进快照**：撤销是把已记录的前像写回去（写工具带 `track: false`），再记一笔会把自己变成
 *   下一条可撤销记录。它的痕迹在历史里由 `undone_at` 承载。
 *
 * 集成状态：**已接线**（切片 A 装配建表 + 切片 B 写路径落记录 + 切片 C 撤销执行器）：`Db.raw` 暴露句柄，
 * 装配根实例化并挂 `PanelDeps`；写工具经 `runToolTracked` → `track()` 落变更记录（REST 与 /mcp 两个入口同走）；
 * 撤销经 `PanelDeps.undoLast`（装配根注入 = `undo(scope)` + 热生效回调）与注册表工具 `undo_last_change`。
 *
 * **热生效回调不进本层**：`undo()` 只回「实际还原了哪些表 / 哪些 settings 键」，由 `undoEffects()`
 * 把受影响面**分类**成装配根认识的标签，回调闭包本身只写在 index.ts。理由见「撤销语义」最后一条。
 */
import type Database from 'better-sqlite3';
import { isRuntimeConfigKey } from './runtime-config.js';

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
  // ---- 以下三项仅 ok=true 时给出，供入口层做响应形状与热生效（撤销执行器不持有回调）----
  /** 产生这次变更的工具名（响应文案 / agent 回话用） */
  tool?: string;
  /** 实际被还原的表（去重，按记录里行出现顺序） */
  tables?: string[];
  /** 实际被还原的 settings 键（表里只有它一个 kv 面；键名决定该触发哪个热生效回调） */
  settingKeys?: string[];
}

export type RedactPredicate = (table: string, column: string, row: Row) => boolean;

/**
 * 参与快照的配置表。四张「配置 + 归档」混合表（`streamers` + 三张图文账号名单）都在内：
 * 面板 / agent 改配置列（watch/alias/profile_note…），轮询或关注同步同时回写**同一行**的
 * 平台事实列——按列过滤（见 DEFAULT_IGNORE_COLUMNS）把后者排除掉后，混合表与纯配置表同待遇。
 * `streamers` 的口径变更（2026-09-21）：原计划「整表排除」，P1 真机冒烟暴露缺口——agent 用
 * `set_streamer` 改别名后撤不掉（差分恒空 = 不落记录）。逐列核对写者后确认它的轮询列与配置列
 * 同样可分（轮询只写 uname/face/room_id/updated_at），故改为纳入 + 按列过滤。
 * 归档表（room_state/posts/verdicts/live_segments）一律不进来——计划明确「不把轮询数据回滚」。
 * `post_rules` 已随 P2（统一计划附录 A.3）DROP——老变更记录里它的行只作历史展示，撤销不到。
 */
export const DEFAULT_CONFIG_TABLES: readonly string[] = [
  'settings', 'push_rules', 'categories', 'push_channels',
  'streamers', 'x_accounts', 'weibo_accounts', 'bili_accounts',
];

/**
 * 「配置 + 归档」混合表的每表忽略列（切片 C 裁决；切片 B 记的已知限制在此解除）。
 *
 * 这些列由轮询源经 `touch*` 回写，不是人的配置意图：游标（`last_tweet_id` / `last_post_id` 等）、
 * 心跳（last_ok_at）、头像文件名（avatar，抓取下载后回写）、恢复位（silent_next，源消费时清位）、
 * 平台昵称（nickname / uname：平台事实，抓取回写，输入面本就不收或只在新建时种入）、
 * 以及随每次写变化的 updated_at。忽略掉以后：
 * ① 轮询回写不再落进 track() 的差分窗口被捎带（不会再凭空产生一条变更记录）；
 * ② 撤销比对照旧只看配置列——游标前进不会把一次配置写变成「已被其他入口修改」；
 * ③ 撤销还原不写这些列（计划要求「不把轮询数据回滚」）。
 * 差分 / 比对 / 还原三处都按本表过滤，故「忽略」在各处口径一致。
 *
 * 逐列依据 = 「谁写这一列」（以代码实际为准，改源前重新核对）：
 * - `x_accounts` ← `touchXAccount`（TwitterFeedSource）：游标 / 心跳 / 头像 / 昵称 / 恢复位。
 * - `weibo_accounts` ← `touchWeiboAccount`（WeiboFeedSource）：同上（昵称只在新建时种入）。
 * - `bili_accounts` ← `touchBiliAccount`（DynamicSource）：uname 同 weibo 的 nickname，平台事实。
 * - `streamers` ← 两条**轮询/同步**回写路径，与面板 / agent 的配置写（alias / watch / analyze /
 *   notify / weiboNick→weiboUID / profileNote）在同一行上：
 *   `uname` / `room_id` ← `LiveStatusSource.pollOnce` 的「为空才补」回填（uname 是平台事实，
 *   room_id 是匿名可得通道拿到的房间号，输入面都不收）；`face` ← 同一条回填 **以及**
 *   `FollowsSource.syncOnce` 的关注列表头像回填（face 为空的条目）；`updated_at` ← 两者每次
 *   `upsertStreamer` 都会重写（`Db.upsertStreamer` 的 ON CONFLICT 子句无条件写它）。
 *   其余列不忽略：`weibo_nick` / `weibo_uid` 只由配置写（`set_streamer` / 面板 PUT）落库，
 *   `source` / `created_at` 只在新建行时定（之后任何 upsert 都原样带回），都属人的配置意图。
 */
export const DEFAULT_IGNORE_COLUMNS: Record<string, readonly string[]> = {
  // touchXAccount 所写列
  x_accounts: ['last_tweet_id', 'last_tweet_at', 'last_ok_at', 'nickname', 'avatar', 'silent_next', 'updated_at'],
  // touchWeiboAccount 所写列（昵称只在新建时种入，之后由抓取回写）
  weibo_accounts: ['last_post_id', 'last_post_at', 'last_ok_at', 'nickname', 'avatar', 'silent_next', 'updated_at'],
  // touchBiliAccount 所写列（uname 同 weibo nickname：平台事实）
  bili_accounts: ['uname', 'last_ok_at', 'avatar', 'silent_next', 'updated_at'],
  // live-status 回填 + 关注同步头像回填所写列（见上方逐列依据）
  streamers: ['uname', 'face', 'room_id', 'updated_at'],
};

/**
 * 该 settings 键是否属于隐私例外（LLM key / 决策模型 key）。**键即判据**：
 * `redactSecretSettings` 与入口层的「撤销后需重填」提示都从这三个函数出发，
 * 两处口径不会漂移（`llm_key:<provider>` / `decision_key:<provider>` 一行一个键）。
 */
export function isLlmKeySetting(key: unknown): boolean {
  return typeof key === 'string' && key.startsWith('llm_key:');
}

export function isDecisionKeySetting(key: unknown): boolean {
  return typeof key === 'string' && key.startsWith('decision_key:');
}

export function isSecretKeySetting(key: unknown): boolean {
  return isLlmKeySetting(key) || isDecisionKeySetting(key);
}

/** 隐私例外（两条独立通道的 key 都不落明文） */
export const redactSecretSettings: RedactPredicate = (table, column, row) =>
  table === 'settings' && column === 'value' && isSecretKeySetting(row.key);

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
  /** 每表忽略列（差分 / 比对 / 还原三处一致过滤）；缺省 DEFAULT_IGNORE_COLUMNS */
  ignoreColumns?: Record<string, readonly string[]>;
  /** 时钟（测试可注入） */
  now?: () => number;
  /** 隐私例外判定；缺省 redactSecretSettings */
  redact?: RedactPredicate;
}

export class UndoStore {
  private readonly tables: readonly string[];
  private readonly now: () => number;
  private readonly redact: RedactPredicate;
  /** 每表忽略列（见 DEFAULT_IGNORE_COLUMNS 与 compareColumns） */
  private readonly ignore: Map<string, ReadonlySet<string>>;
  private readonly meta = new Map<string, TableMeta>();
  /** track() 的内部串行队列：所有走 track 的写调用排队执行，差分窗口互不交错 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: Database.Database, opts: UndoStoreOptions = {}) {
    this.tables = opts.tables ?? DEFAULT_CONFIG_TABLES;
    if (this.tables.includes(TABLE)) throw new Error(`${TABLE} 不能作为快照表（记录自身不该被记录）`);
    this.now = opts.now ?? (() => Date.now());
    this.redact = opts.redact ?? redactSecretSettings;
    this.ignore = new Map(
      Object.entries(opts.ignoreColumns ?? DEFAULT_IGNORE_COLUMNS).map(([t, cols]) => [t, new Set(cols)]),
    );
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

  /**
   * 异步段版 capture（写工具的 handler 内含 await 时走这里，见 run-tool.ts runToolTracked）：
   * 进 fn 前取前像，fn 成功后同步做「后像 → 差分 → 落记录」。
   *
   * 与 capture() 的差别与取舍（REST 收敛切片拍板）：
   * - 前像读取**不在**事务里（better-sqlite3 事务不能跨 await，handler 的异步校验/探测在前）。
   *   改用内部队列把所有走 track 的写调用**串行化**，保证差分窗口不被另一个写工具交错污染。
   * - 「写 → 后像差分 → 落记录」三步在 fn resolve 后是连续同步代码，单线程下实际原子。
   *   残留窗口 = insertRecord 自身失败（磁盘级故障）：此时写已提交而记录没落——方向上是
   *   「写了却撤不掉」，但仅在存储层故障时发生，且错误会抛给调用方（人知道出事了）。
   * - 差分窗口污染（切片 B 的已知限制，**切片 C 已解除**）：不走 track 的写（轮询源回写，如
   *   TwitterFeedSource.touchXAccount 写 x_accounts 的游标/头像列）仍可能在窗口内实插，但混合表
   *   的轮询列已被 `DEFAULT_IGNORE_COLUMNS` 排除在差分与比对之外，故既不会凭空产生记录，
   *   也不会让撤销无故中止。
   */
  async track<T>(meta: ChangeMeta, fn: () => Promise<T>): Promise<{ value: T; changeId: number | null }> {
    const run = async (): Promise<{ value: T; changeId: number | null }> => {
      const before = this.snapshot();
      const value = await fn();
      const after = this.snapshot();
      const rows = this.diff(before, after);
      return { value, changeId: rows.length > 0 ? this.insertRecord(meta, rows) : null };
    };
    const p = this.queue.then(run, run);
    this.queue = p.then(() => undefined, () => undefined);
    return p;
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
   * 撤销该栈顶。逐行比对后像与当前值（**只看非忽略列**，见 DEFAULT_IGNORE_COLUMNS），
   * 不等则中止且一行都不改；隐私行只比对存在性，撤销动作一律是清空该行
   * （值本来就没落库），并在结果里给出 refill 提示。
   * 成功时附带「实际还原了哪些表 / 哪些 settings 键」，供入口层触发热生效回调。
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
        if (!rowEq(cur, img.after, this.compareColumns(img.table))) {
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
      const tables = changeTables(rec);
      const settingKeys = changeSettingKeys(rec);
      const base = { ok: true as const, id: rec.id, applied, tables, settingKeys };
      const withTool = rec.tool === undefined ? base : { ...base, tool: rec.tool };
      return refill.length > 0 ? { ...withTool, refill } : withTool;
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

  /**
   * 参与差分 / 比对 / 还原的列 = 该表全部列 − 该表忽略列（见 DEFAULT_IGNORE_COLUMNS）。
   * 三处走同一个函数，故「忽略」不会出现口径不一致（例如比对看不见、还原却写回）。
   */
  private compareColumns(table: string): readonly string[] {
    const ignore = this.ignore.get(table);
    const cols = this.columnsOf(table);
    return ignore === undefined ? cols : cols.filter((c) => !ignore.has(c));
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
      const columns = this.compareColumns(table);
      const b = before.get(table) ?? new Map<string, Row>();
      const a = after.get(table) ?? new Map<string, Row>();
      for (const key of new Set([...b.keys(), ...a.keys()])) {
        const rb = b.get(key) ?? null;
        const ra = a.get(key) ?? null;
        // 只有忽略列变化不算一次配置写（轮询回写不进记录）
        if (rowEq(rb, ra, columns)) continue;
        const vals = JSON.parse(key) as unknown[];
        const pk: Row = {};
        meta.pk.forEach((c, i) => { pk[c] = vals[i] ?? null; });
        const redacted = this.isRedacted(table, rb, ra, columns);
        out.push({
          table,
          pk,
          // 前像/后像保留整行（含忽略列）：撤销一次「删除」要按前像整行重插，缺列会丢数据
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

  /**
   * 还原一行：按前像写回**非忽略列**（忽略列不动——游标/心跳/头像是轮询数据，
   * 撤销配置写不该把它们回滚；这也让撤销与比对的可比列集合完全一致）。
   */
  private updateRow(table: string, pk: Row, before: Row): void {
    const meta = this.ensureMeta(table)!;
    const ignore = this.ignore.get(table);
    const cols = Object.keys(before)
      .filter((c) => !meta.pk.includes(c) && !(ignore?.has(c) ?? false));
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

// ---- 变更记录的用户面视图与热生效分类（入口层用；本层不持有任何回调）----

/** 记录里受影响的表（去重，按行出现顺序——面板按它排「改了哪些面」） */
export function changeTables(rec: ChangeRecord): string[] {
  return [...new Set(rec.rows.map((r) => r.table))];
}

/** 记录里被改的 settings 键（表里只有 settings 是 kv；键名决定该触发哪个热生效回调） */
export function changeSettingKeys(rec: ChangeRecord): string[] {
  const keys = rec.rows
    .filter((r) => r.table === 'settings' && typeof r.pk.key === 'string')
    .map((r) => r.pk.key as string);
  return [...new Set(keys)];
}

/**
 * 撤销后该触发哪些热生效动作——**纯分类**，与装配根的回调一一对应（判据 6：撤销与面板手写等价）：
 * - `runtime`   → `reconcileRuntime`（settings 的运行参数键：NUM_SPECS / BOOL_SPECS）
 * - `listen`    → `reconcileListen`（`listen_*` 开关；三张图文账号名单同路——它们的「源名单」
 *                  变化在装配处也是走同一个启停入口）
 * - `llm`       → 重建 llm router（`settings.llm_providers` / `llm_key:*`；撤 key = 清空 + 重填提示）
 * - `notifiers` → `rebuildNotifiers`（`push_channels` 行；`napcat_*` 配置同面板保存后的重装配口径）
 *
 * 决策模型管理面（`decision_providers` / `decision_key:*`）目前没有运行期缓存：名单与 key 都由
 * 判定接入层按需直读 settings，故撤销后不需要热生效回调（接入出缓存时在此加 `decision`）。
 *
 * 混合表里唯一**不需要**回调的是 `streamers`：监听名单（含 watch 开关）由 live-status 与动态源
 * **每轮直读 `listWatchedUids()`**，撤销一次别名 / watch 改动下一轮即生效，不需要重启任何源。
 * 图文账号名单不同——微博 / X 的源在构造时快照名单，故要经 `reconcileListen` 就地重启。
 */
export type UndoEffect = 'runtime' | 'listen' | 'llm' | 'notifiers';

const FEED_TABLES = new Set(['x_accounts', 'weibo_accounts', 'bili_accounts']);

export function undoEffects(r: Pick<UndoResult, 'tables' | 'settingKeys'>): UndoEffect[] {
  const out = new Set<UndoEffect>();
  for (const key of r.settingKeys ?? []) {
    if (key.startsWith('listen_')) out.add('listen');
    else if (key === 'llm_providers' || key.startsWith('llm_key:')) out.add('llm');
    else if (key.startsWith('napcat_')) out.add('notifiers');
    else if (isRuntimeConfigKey(key)) out.add('runtime');
  }
  for (const table of r.tables ?? []) {
    if (FEED_TABLES.has(table)) out.add('listen');
    // 渠道行本身由 dispatcher 逐条读表，理论上无需回调；撤销按「撤了什么就重跑什么」做一次
    // 装配级重同步（幂等、与 NapCat 配置撤销同路），避免装配态与库态不一致留暗坑
    else if (table === 'push_channels') out.add('notifiers');
  }
  return [...out];
}
