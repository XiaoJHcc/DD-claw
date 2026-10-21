/**
 * 撤销引擎测试：差分快照、逆操作、冲突中止、按渠道分栈、隐私例外、同事务与回滚。
 * 表结构照抄 src/core/db.ts 的真实 DDL 形状（settings 以 key 为主键、其余以 id 自增为主键）。
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import {
  adminScope, channelScope, DEFAULT_CONFIG_TABLES, DEFAULT_IGNORE_COLUMNS, undoEffects, UndoStore,
} from './undo.js';

const DDL = `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE push_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, notifier TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    keywords TEXT NOT NULL DEFAULT '[]', sort INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE push_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL DEFAULT '',
    subject_kind TEXT NOT NULL DEFAULT 'live', category_id INTEGER,
    scope TEXT NOT NULL DEFAULT '[]', channels TEXT NOT NULL DEFAULT '[]',
    llm_translate INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE archive_posts (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT);
  -- streamers：配置 + 归档混合表（列名与 core/db.ts 逐字一致，face 由 ensureColumn 补）
  CREATE TABLE streamers (
    uid TEXT PRIMARY KEY, uname TEXT NOT NULL DEFAULT '', alias TEXT, room_id TEXT,
    weibo_uid TEXT, weibo_nick TEXT, watch INTEGER NOT NULL DEFAULT 1,
    analyze INTEGER NOT NULL DEFAULT 0, notify INTEGER NOT NULL DEFAULT 1, profile_note TEXT,
    face TEXT, source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('follows','manual')),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  -- 三张「配置 + 归档」混合表（列名照抄 core/db.ts，silent_next 由 ensureColumn 补；
  -- P2 起 rule_ids 列已删——生效范围在规则侧 scope）
  CREATE TABLE x_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, screen_name TEXT NOT NULL UNIQUE, nickname TEXT,
    display_name TEXT, bili_uid TEXT, enabled INTEGER NOT NULL DEFAULT 1,
    last_tweet_id TEXT, last_tweet_at INTEGER, last_ok_at INTEGER, avatar TEXT,
    silent_next INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE weibo_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL UNIQUE, nickname TEXT,
    display_name TEXT, bili_uid TEXT, enabled INTEGER NOT NULL DEFAULT 1,
    last_post_id TEXT, last_post_at INTEGER, last_ok_at INTEGER, avatar TEXT,
    silent_next INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE bili_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL UNIQUE, uname TEXT,
    display_name TEXT, enabled INTEGER NOT NULL DEFAULT 1,
    last_ok_at INTEGER, avatar TEXT,
    silent_next INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
`;

function setup(t: TestContext, opts: ConstructorParameters<typeof UndoStore>[1] = {}) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(DDL);
  let clock = 1_000;
  const store = new UndoStore(db, { now: () => (clock += 1), ...opts });
  store.migrate();
  return { db, store, tick: () => (clock += 1) };
}

const META = { scope: adminScope(), actor: 'panel', entry: 'panel' };

function seedRule(db: Database.Database, name: string, sort: number, at = 100): number {
  const info = db
    .prepare(`INSERT INTO push_rules (name, scope, channels, enabled, sort, created_at, updated_at) VALUES (?, '[]', '[]', 1, ?, ?, ?)`)
    .run(name, sort, at, at);
  return Number(info.lastInsertRowid);
}

test('migrate 幂等；capture 无净变化时不产生记录', (t) => {
  const { db, store } = setup(t);
  store.migrate(); // 再跑一次不抛

  const r = store.capture(META, () => {
    db.prepare(`UPDATE push_rules SET name = 'x' WHERE id = 999`).run(); // 命中 0 行
    return 'ok';
  });
  assert.equal(r.value, 'ok');
  assert.equal(r.changeId, null);
  assert.deepEqual(store.history(), []);
});

test('插入 → 撤销按 id 删除该行', (t) => {
  const { db, store } = setup(t);
  const { changeId } = store.capture(META, () => seedRule(db, '新规则', 3));
  assert.ok(changeId);

  const rec = store.peek(adminScope())!;
  assert.equal(rec.rows.length, 1);
  assert.equal(rec.rows[0]!.before, null);
  assert.equal(rec.rows[0]!.after!.name, '新规则');

  const r = store.undo(adminScope());
  // 记录无工具名（capture 直接调）时结果不带 tool 键；tables/settingKeys 是入口层用的受影响面
  assert.deepEqual(r, { ok: true, id: rec.id, applied: 1, tables: ['push_rules'], settingKeys: [] });
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM push_rules`).get() as { n: number }).n, 0);
});

test('删除 → 撤销按原 id / sort / 时间戳整行重插', (t) => {
  const { db, store } = setup(t);
  const id = seedRule(db, '要删的', 7, 555);

  store.capture(META, () => db.prepare(`DELETE FROM push_rules WHERE id = ?`).run(id));
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM push_rules`).get() as { n: number }).n, 0);

  const r = store.undo(adminScope());
  assert.equal(r.ok, true);
  const row = db.prepare(`SELECT * FROM push_rules WHERE id = ?`).get(id) as Record<string, unknown>;
  assert.equal(row.id, id, '原 id 必须还原');
  assert.equal(row.name, '要删的');
  assert.equal(row.sort, 7);
  assert.equal(row.created_at, 555);
  assert.equal(row.updated_at, 555);
});

test('改字段 → 撤销还原前像（含整行其它列）', (t) => {
  const { db, store } = setup(t);
  const id = seedRule(db, '原名', 1);

  store.capture(META, () => {
    db.prepare(`UPDATE push_rules SET name = '改名', enabled = 0, updated_at = 999 WHERE id = ?`).run(id);
  });
  const r = store.undo(adminScope());
  assert.equal(r.ok, true);

  const row = db.prepare(`SELECT * FROM push_rules WHERE id = ?`).get(id) as Record<string, unknown>;
  assert.equal(row.name, '原名');
  assert.equal(row.enabled, 1);
  assert.equal(row.updated_at, 100);
});

test('settings 删除式写：撤销把 key 重新插回（区分「key 不存在」与「值=X」）', (t) => {
  const { db, store } = setup(t);
  db.prepare(`INSERT INTO settings (key, value) VALUES ('listen_dynamic', 'auto')`).run();

  store.capture(META, () => db.prepare(`DELETE FROM settings WHERE key = 'listen_dynamic'`).run());
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM settings`).get() as { n: number }).n, 0);

  const r = store.undo(adminScope());
  assert.equal(r.ok, true);
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'listen_dynamic'`).get() as { value: string } | undefined;
  assert.equal(row?.value, 'auto', '删除式写的撤销必须重插 key 与值');
});

test('settings 新增：撤销把 key 删掉', (t) => {
  const { db, store } = setup(t);
  store.capture(META, () => db.prepare(`INSERT INTO settings (key, value) VALUES ('push_enabled', '0')`).run());
  assert.equal(store.undo(adminScope()).ok, true);
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'push_enabled'`).get();
  assert.equal(row, undefined);
});

test('排序拖拽整表重写：一条记录含 N 行，撤销全部还原', (t) => {
  const { db, store } = setup(t);
  const a = seedRule(db, 'A', 0);
  const b = seedRule(db, 'B', 1);
  const c = seedRule(db, 'C', 2);

  const { changeId } = store.capture(
    { ...META, tool: 'reorder_push_rules' },
    () => {
      const up = db.prepare(`UPDATE push_rules SET sort = ? WHERE id = ?`);
      up.run(2, a); up.run(0, b); up.run(1, c);
    },
  );
  assert.ok(changeId);
  assert.equal(store.peek(adminScope())!.rows.length, 3);

  assert.equal(store.undo(adminScope()).applied, 3);
  const sorts = db.prepare(`SELECT id, sort FROM push_rules ORDER BY id`).all() as Array<{ id: number; sort: number }>;
  assert.deepEqual(sorts, [{ id: a, sort: 0 }, { id: b, sort: 1 }, { id: c, sort: 2 }]);
});

test('级联：停用引用规则的 N 行 + 删除分类 1 行，同一 capture 里一起还原', (t) => {
  const { db, store } = setup(t);
  const cid = Number(db.prepare(`INSERT INTO categories (name, sort, created_at, updated_at) VALUES ('游戏', 0, 1, 1)`).run().lastInsertRowid);
  const r1 = seedRule(db, 'R1', 0);
  const r2 = seedRule(db, 'R2', 1);
  db.prepare(`UPDATE push_rules SET category_id = ?`).run(cid);

  store.capture(META, () => {
    // 现状代码是两条独立语句（非原子）——capture 把它们包进同一事务
    db.prepare(`UPDATE push_rules SET enabled = 0 WHERE category_id = ?`).run(cid);
    db.prepare(`DELETE FROM categories WHERE id = ?`).run(cid);
  });
  assert.equal(store.peek(adminScope())!.rows.length, 3, '2 行停用 + 1 行删除');

  assert.equal(store.undo(adminScope()).applied, 3);
  const rules = db.prepare(`SELECT id, enabled FROM push_rules ORDER BY id`).all() as Array<{ id: number; enabled: number }>;
  assert.deepEqual(rules, [{ id: r1, enabled: 1 }, { id: r2, enabled: 1 }]);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM categories`).get() as { n: number }).n, 1);
});

test('冲突：后像 ≠ 当前值 → 中止，且一行都不动（宁中止不丢写）', (t) => {
  const { db, store } = setup(t);
  const a = seedRule(db, 'A', 0);
  const b = seedRule(db, 'B', 1);
  store.capture(META, () => {
    const up = db.prepare(`UPDATE push_rules SET sort = ? WHERE id = ?`);
    up.run(10, a); up.run(20, b);
  });

  // 第三方（另一入口）改了其中一行
  db.prepare(`UPDATE push_rules SET sort = 99 WHERE id = ?`).run(a);

  const r = store.undo(adminScope());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'conflict');
  assert.match(r.detail!, new RegExp(`push_rules \\(id=${a}\\)`));

  const rows = db.prepare(`SELECT id, sort FROM push_rules ORDER BY id`).all() as Array<{ id: number; sort: number }>;
  assert.deepEqual(rows, [{ id: a, sort: 99 }, { id: b, sort: 20 }], '冲突时 b 不能被回退');

  const rec = store.peek(adminScope())!;
  assert.equal(rec.id > 0, true);
  assert.equal(rec.undoneAt, null, '冲突中止不得把记录标记为已撤销');
});

test('栈式逆序：连续撤销按「最近一次」往回走', (t) => {
  const { db, store } = setup(t);
  const a = seedRule(db, 'A', 0);
  store.capture(META, () => db.prepare(`UPDATE push_rules SET name = '第一改' WHERE id = ?`).run(a));
  const secondId = store.capture(META, () => db.prepare(`UPDATE push_rules SET name = '第二改' WHERE id = ?`).run(a)).changeId!;

  assert.equal(store.peek(adminScope())!.id, secondId);
  assert.equal(store.undo(adminScope()).ok, true);
  assert.equal((db.prepare(`SELECT name FROM push_rules WHERE id = ?`).get(a) as { name: string }).name, '第一改');
  assert.equal(store.undo(adminScope()).ok, true);
  assert.equal((db.prepare(`SELECT name FROM push_rules WHERE id = ?`).get(a) as { name: string }).name, 'A');
  assert.deepEqual(store.undo(adminScope()), { ok: false, reason: 'empty' });
});

test('每来源渠道一条独立栈：撤 ch:7 不动 admin 的栈顶', (t) => {
  const { db, store } = setup(t);
  const a = seedRule(db, 'A', 0);
  db.prepare(`INSERT INTO settings (key, value) VALUES ('push_enabled', '1')`).run();

  const adminRec = store.capture(META, () => db.prepare(`UPDATE settings SET value = '0' WHERE key = 'push_enabled'`).run()).changeId!;
  const chRec = store.capture({ scope: channelScope(7), actor: 'gw1', entry: 'mcp' }, () => db.prepare(`UPDATE push_rules SET name = '群改' WHERE id = ?`).run(a)).changeId!;

  assert.equal(store.peek(channelScope(7))!.id, chRec);
  assert.equal(store.peek(adminScope())!.id, adminRec);

  assert.equal(store.undo(channelScope(7)).id, chRec);
  assert.equal((db.prepare(`SELECT name FROM push_rules WHERE id = ?`).get(a) as { name: string }).name, 'A');
  assert.equal((db.prepare(`SELECT value FROM settings WHERE key='push_enabled'`).get() as { value: string }).value, '0', 'admin 的写不该被渠道撤销带走');
  assert.equal(store.peek(adminScope())!.id, adminRec);
});

test('历史全量保留：撤销后记录仍在，带 undoneAt', (t) => {
  const { db, store } = setup(t);
  seedRule(db, 'A', 0);
  const id = store.capture(META, () => db.prepare(`DELETE FROM push_rules`).run()).changeId!;
  store.undo(adminScope());

  const hist = store.history();
  assert.equal(hist.length, 1);
  assert.equal(hist[0]!.id, id);
  assert.ok(hist[0]!.undoneAt !== null);
  assert.equal(store.history({ scope: channelScope(7) }).length, 0);
});

test('隐私例外：llm key 不落明文，撤销 = 清空并要求重填', (t) => {
  const { db, store } = setup(t);
  db.prepare(`INSERT INTO settings (key, value) VALUES ('llm_key:p', 'sk-old')`).run();

  store.capture(META, () => db.prepare(`UPDATE settings SET value = 'sk-new' WHERE key = 'llm_key:p'`).run());
  const rec = store.peek(adminScope())!;
  const dumped = JSON.stringify(rec.rows);
  assert.ok(!dumped.includes('sk-old') && !dumped.includes('sk-new'), '快照不得落明文');
  assert.equal(rec.rows[0]!.redacted, true);

  const r = store.undo(adminScope());
  assert.equal(r.ok, true);
  assert.deepEqual(r.refill, ['settings.(key=llm_key:p)']);
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'llm_key:p'`).get();
  assert.equal(row, undefined, '撤销 = 清空该 key');
});

test('隐私例外：新增 key 的撤销也只做清空（值没落库）', (t) => {
  const { db, store } = setup(t);
  store.capture(META, () => db.prepare(`INSERT INTO settings (key, value) VALUES ('llm_key:q', 'sk-fresh')`).run());
  const r = store.undo(adminScope());
  assert.equal(r.ok, true);
  assert.deepEqual(r.refill, ['settings.(key=llm_key:q)']);
  assert.equal(db.prepare(`SELECT value FROM settings WHERE key = 'llm_key:q'`).get(), undefined);
});

test('隐私例外：决策模型 key 同样不落明文，撤销 = 清空并要求重填', (t) => {
  const { db, store } = setup(t);
  db.prepare(`INSERT INTO settings (key, value) VALUES ('decision_key:jev', 'sk-dec-old')`).run();
  store.capture(META, () => db.prepare(`UPDATE settings SET value = 'sk-dec-new' WHERE key = 'decision_key:jev'`).run());
  const rec = store.peek(adminScope())!;
  const dumped = JSON.stringify(rec.rows);
  assert.ok(!dumped.includes('sk-dec-old') && !dumped.includes('sk-dec-new'), '快照不得落明文');
  assert.equal(rec.rows[0]!.redacted, true);

  const r = store.undo(adminScope());
  assert.equal(r.ok, true);
  assert.deepEqual(r.refill, ['settings.(key=decision_key:jev)']);
  assert.equal(db.prepare(`SELECT value FROM settings WHERE key = 'decision_key:jev'`).get(), undefined, '撤销 = 清空该 key');
});

test('非隐私 settings 正常还原（隐私判定只认模型 key 前缀）', (t) => {
  const { db, store } = setup(t);
  db.prepare(`INSERT INTO settings (key, value) VALUES ('push_enabled', '1')`).run();
  store.capture(META, () => db.prepare(`UPDATE settings SET value = '0' WHERE key = 'push_enabled'`).run());
  const rec = store.peek(adminScope())!;
  assert.equal(rec.rows[0]!.redacted, undefined);
  assert.equal(store.undo(adminScope()).ok, true);
  assert.equal((db.prepare(`SELECT value FROM settings WHERE key='push_enabled'`).get() as { value: string }).value, '1');
});

test('归档表不参与撤销（表列表外的写不进记录）', (t) => {
  const { db, store } = setup(t);
  const r = store.capture(META, () => db.prepare(`INSERT INTO archive_posts (body) VALUES ('轮询数据')`).run());
  assert.equal(r.changeId, null);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM archive_posts`).get() as { n: number }).n, 1);
});

test('capture 内抛错：写入与记录一起回滚', (t) => {
  const { db, store } = setup(t);
  assert.throws(() => {
    store.capture(META, () => {
      seedRule(db, '半途而废', 0);
      throw new Error('写一半炸了');
    });
  }, /写一半炸了/);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM push_rules`).get() as { n: number }).n, 0, '写入必须回滚');
  assert.deepEqual(store.history(), [], '不得留下记录');
});

test('写路径内部自己开事务（模拟 Db.upsertXxx）：嵌套 savepoint 不破坏捕获', (t) => {
  const { db, store } = setup(t);
  seedRule(db, '原', 0);
  const inner = db.transaction((name: string) => {
    db.prepare(`UPDATE push_rules SET name = ? WHERE id = 1`).run(name);
  });

  const { changeId } = store.capture(META, () => inner('嵌套改'));
  assert.ok(changeId, '嵌套事务下的写也要被捕获');
  assert.equal(store.undo(adminScope()).ok, true);
  assert.equal((db.prepare(`SELECT name FROM push_rules WHERE id = 1`).get() as { name: string }).name, '原');
});

test('未建的表（尚未升级的库）被跳过，不影响其它表', (t) => {
  const { db, store } = setup(t, { tables: [...DEFAULT_CONFIG_TABLES, 'post_rules'] }); // 测试库里没有 post_rules
  const { changeId } = store.capture(META, () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('a', 'b')`).run();
  });
  assert.ok(changeId);
  assert.equal(store.peek(adminScope())!.rows.length, 1);
});

// ---- track()：异步段版记录点（runToolTracked 走这里；handler 内含 await）----

test('track：异步写落记录，前后像与 capture 同形状', async (t) => {
  const { db, store } = setup(t);
  const r = await store.track(META, async () => {
    await Promise.resolve(); // 模拟 handler 里的异步校验
    seedRule(db, '异步规则', 0);
    return 'done';
  });
  assert.equal(r.value, 'done');
  assert.ok(r.changeId);
  const rec = store.peek(adminScope())!;
  assert.equal(rec.rows.length, 1);
  assert.equal(rec.rows[0]!.table, 'push_rules');
  assert.equal(rec.rows[0]!.beforeExists, false);
  assert.equal(rec.rows[0]!.afterExists, true);
  // 撤销可用：与 capture 产的记录同一份 undo 逻辑
  assert.equal(store.undo(adminScope()).ok, true);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM push_rules`).get() as { n: number }).n, 0);
});

test('track：fn 失败（runTool 的 ToolFailure 形态是 resolve，但真抛也算）不落记录；无净变化不落记录', async (t) => {
  const { db, store } = setup(t);
  await assert.rejects(
    store.track(META, async () => { throw new Error('校验失败'); }),
    /校验失败/,
  );
  const r = await store.track(META, async () => {
    db.prepare(`UPDATE push_rules SET name = 'x' WHERE id = 999`).run(); // 命中 0 行
  });
  assert.equal(r.changeId, null);
  assert.deepEqual(store.history(), [], '失败与无变化都不留记录');
});

test('track：并发写调用串行化，差分互不污染', async (t) => {
  const { db, store } = setup(t);
  // A 在写之前让出事件轮回合；若没串行化，B 的写会落进 A 的差分窗口
  const a = store.track({ ...META, note: 'A' }, async () => {
    await new Promise((r) => setTimeout(r, 20));
    seedRule(db, '规则A', 0);
  });
  const b = store.track({ ...META, note: 'B' }, async () => {
    seedRule(db, '规则B', 0);
  });
  const [ra, rb] = await Promise.all([a, b]);
  assert.ok(ra.changeId && rb.changeId);
  const history = store.history();
  assert.equal(history.length, 2);
  const recB = history.find((h) => h.id === rb.changeId)!;
  assert.deepEqual(recB.rows.map((r) => (r.after as { name: string }).name), ['规则B'], 'B 的记录只含 B 的写');
  const recA = history.find((h) => h.id === ra.changeId)!;
  assert.deepEqual(recA.rows.map((r) => (r.after as { name: string }).name), ['规则A'], 'A 的记录只含 A 的写');
});
// ---- 混和表按列过滤（切片 C 裁决：x_accounts / weibo_accounts / bili_accounts；streamers 同口径见下）----

/** 三张混合表的形状：配置列（面板 / agent 能改）与轮询列（touch* 回写的游标 / 心跳） */
const ACCOUNT_SHAPES = [
  { table: 'x_accounts', keyCol: 'screen_name', keyVal: 'someone', cursorCol: 'last_tweet_id' },
  { table: 'weibo_accounts', keyCol: 'uid', keyVal: '2203177060', cursorCol: 'last_post_id' },
  { table: 'bili_accounts', keyCol: 'uid', keyVal: '7706705', cursorCol: 'last_ok_at' },
];

function seedAccount(db: Database.Database, s: (typeof ACCOUNT_SHAPES)[number]): number {
  const info = db
    .prepare(
      `INSERT INTO ${s.table} (${s.keyCol}, display_name, enabled, ${s.cursorCol}, last_ok_at, created_at, updated_at)
       VALUES (?, NULL, 1, 500, 500, 500, 500)`,
    )
    .run(s.keyVal);
  return Number(info.lastInsertRowid);
}

/** 轮询回写一行（模拟 touch*：游标 / 心跳 / 时间戳一起写） */
function pollTouch(db: Database.Database, s: (typeof ACCOUNT_SHAPES)[number], id: number, at: number): void {
  const set = s.cursorCol === 'last_ok_at' ? 'last_ok_at = ?' : `${s.cursorCol} = ?, last_ok_at = ?`;
  const args = s.cursorCol === 'last_ok_at' ? [at] : [`tw-${at}`, at];
  db.prepare(`UPDATE ${s.table} SET ${set}, updated_at = ? WHERE id = ?`).run(...args, at, id);
}

test('混合表列过滤：轮询回写不落记录、不污染撤销，撤销也不回滚游标', (t) => {
  const { db, store } = setup(t);
  assert.ok(
    DEFAULT_CONFIG_TABLES.includes('x_accounts')
    && DEFAULT_CONFIG_TABLES.includes('weibo_accounts')
    && DEFAULT_CONFIG_TABLES.includes('bili_accounts'),
    '三张图文名单都是「配置 + 归档」混合表：纳入快照 + 按列过滤',
  );
  assert.ok(DEFAULT_CONFIG_TABLES.includes('streamers'), 'streamers 按列过滤后也已纳入快照（2026-09-21）');

  for (const s of ACCOUNT_SHAPES) {
    const id = seedAccount(db, s);

    // ① 只有轮询列变化 → 不算一次配置写（切片 B 的「差分窗口被轮询写捎带」在此解除）
    pollTouch(db, s, id, 600);
    const only = store.capture(META, () => pollTouch(db, s, id, 700));
    assert.equal(only.changeId, null, `${s.table}: 轮询回写不落变更记录`);

    // ② 配置写（停用 + 改显示名）+ 同一窗口里的轮询回写 → 记录只记这一行
    const { changeId } = store.capture({ ...META, tool: 'upsert_account' }, () => {
      db.prepare(`UPDATE ${s.table} SET enabled = 0, display_name = '改名' WHERE id = ?`).run(id);
      pollTouch(db, s, id, 800);
    });
    assert.ok(changeId, `${s.table}: 配置写要落记录`);
    const rec = store.peek(adminScope())!;
    assert.equal(rec.rows.length, 1, `${s.table}: 轮询列不额外产生行`);
    assert.deepEqual(rec.rows[0]!.pk, { id });

    // ③ 撤销前游标又前进（撤销时当前值已与后像不同）→ 比对只看配置列，仍然撤得掉
    pollTouch(db, s, id, 900);
    const u = store.undo(adminScope());
    assert.equal(u.ok, true, `${s.table}: 游标前进不该让撤销中止`);
    assert.deepEqual(u.tables, [s.table]);
    const row = db.prepare(`SELECT * FROM ${s.table} WHERE id = ?`).get(id) as Record<string, unknown>;
    assert.equal(row.enabled, 1, `${s.table}: 配置列还原`);
    assert.equal(row.display_name, null, `${s.table}: 配置列还原`);
    assert.equal(row.last_ok_at, 900, `${s.table}: 游标列保持撤销前的值（不把轮询数据回滚）`);
    assert.equal(row.updated_at, 900, `${s.table}: updated_at 同属轮询列`);
  }
});

test('列过滤不削弱冲突检测：配置列被第三方改过仍然中止且一行不动', (t) => {
  const { db, store } = setup(t);
  const s = ACCOUNT_SHAPES[0]!;
  const id = seedAccount(db, s);

  store.capture(META, () => {
    db.prepare(`UPDATE ${s.table} SET enabled = 0 WHERE id = ?`).run(id);
    pollTouch(db, s, id, 800);
  });
  // 第三方（另一个入口）把配置列改成别的值：后像 ≠ 当前值 → 中止
  db.prepare(`UPDATE ${s.table} SET enabled = 1, display_name = '别人改的' WHERE id = ?`).run(id);

  const r = store.undo(adminScope());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'conflict');
  assert.match(r.detail!, new RegExp(`${s.table} \\(id=${id}\\)`));
  const row = db.prepare(`SELECT * FROM ${s.table} WHERE id = ?`).get(id) as Record<string, unknown>;
  assert.equal(row.display_name, '别人改的', '冲突中止时第三方写的值必须原样留着');
});

// ---- streamers 纳入快照（2026-09-21：从「整表不纳入」改为按列过滤；P1 真机冒烟的缺口）----

/** 建一张 streamers 行（照抄 Db.upsertStreamer 的建行形状：配置列取建行默认、平台事实列空） */
function seedStreamer(db: Database.Database, uid: string, at = 500, patch: Record<string, unknown> = {}): void {
  const cols: Record<string, unknown> = {
    uname: '', alias: null, room_id: null, weibo_uid: null, weibo_nick: null,
    watch: 1, analyze: 0, notify: 1, profile_note: null, face: null,
    source: 'manual', created_at: at, updated_at: at, ...patch,
  };
  const names = Object.keys(cols);
  db.prepare(
    `INSERT INTO streamers (uid, ${names.join(', ')}) VALUES (?, ${names.map(() => '?').join(', ')})`,
  ).run(uid, ...names.map((c) => cols[c]));
}

/**
 * 轮询回填（模拟 `LiveStatusSource.pollOnce` 的「为空才补」：`uname` / `face` / `room_id`
 * 一起写回，`updated_at` 每次 upsert 都重写）。`FollowsSource.syncOnce` 的头像回填是它的子集
 * （只写 face + updated_at），故同一个夹具够用。
 */
function pollFillStreamer(
  db: Database.Database, uid: string, at: number,
  v: { uname?: string; face?: string; roomId?: string } = {},
): void {
  db.prepare(
    `UPDATE streamers SET uname = COALESCE(?, uname), face = COALESCE(face, ?),
       room_id = COALESCE(room_id, ?), updated_at = ? WHERE uid = ?`,
  ).run(v.uname ?? '平台名', v.face ?? 'f.jpg', v.roomId ?? '80397', at, uid);
}

test('streamers 按列过滤：轮询回填不落记录、不阻断撤销，撤销也不回滚轮询列', (t) => {
  const { db, store } = setup(t);
  assert.ok(DEFAULT_CONFIG_TABLES.includes('streamers'), 'streamers 在快照表里');
  assert.deepEqual(
    DEFAULT_IGNORE_COLUMNS.streamers, ['uname', 'face', 'room_id', 'updated_at'],
    '忽略列 = 轮询与关注同步回写的列（配置列 watch/alias/analyze/notify/weibo_nick/weibo_uid/profile_note 都参与差分与还原）',
  );
  seedStreamer(db, '1001');

  // ① 只有轮询列变化 → 不算一次配置写（原「差分恒空」是缺口，现在是「轮询列不算」）
  const only = store.capture(META, () => pollFillStreamer(db, '1001', 600));
  assert.equal(only.changeId, null, '轮询回填不落变更记录');

  // ② 配置写（别名 + 关通知）与同一窗口里的关注同步头像回填 → 记录只记这一行
  const { changeId } = store.capture({ ...META, tool: 'set_streamer' }, () => {
    db.prepare(`UPDATE streamers SET alias = '梓宝', notify = 0, updated_at = 700 WHERE uid = '1001'`).run();
    // FollowsSource.syncOnce 的头像回填（face 为空的条目）：只在同一行上写 face + updated_at
    db.prepare(`UPDATE streamers SET face = 'f2.jpg', updated_at = 700 WHERE uid = '1001'`).run();
  });
  assert.ok(changeId, 'agent/面板改别名要落记录（P1 冒烟缺口：以前撤不掉）');
  const rec = store.peek(adminScope())!;
  assert.equal(rec.rows.length, 1, '轮询列不额外产生行');
  assert.deepEqual(rec.rows[0]!.pk, { uid: '1001' });
  assert.equal(rec.rows[0]!.table, 'streamers');

  // ③ 撤销前轮询又前进（当前值已与后像不同）→ 比对只看配置列，仍然撤得掉
  pollFillStreamer(db, '1001', 900, { uname: '改过的平台名' });
  const u = store.undo(adminScope());
  assert.equal(u.ok, true, '轮询列前进不该让撤销中止');
  assert.deepEqual(u.tables, ['streamers']);
  const row = db.prepare(`SELECT * FROM streamers WHERE uid = '1001'`).get() as Record<string, unknown>;
  assert.equal(row.alias, null, '配置列还原');
  assert.equal(row.notify, 1, '配置列还原');
  assert.equal(row.uname, '改过的平台名', '平台事实列保持撤销前的值（不把轮询数据回滚）');
  assert.equal(row.face, 'f2.jpg', '头像同属轮询列');
  assert.equal(row.room_id, '80397', '房间号同属轮询列');
  assert.equal(row.updated_at, 900, 'updated_at 同属轮询列');
});

test('列过滤不削弱 streamers 的冲突检测：配置列被第三方改过仍然中止', (t) => {
  const { db, store } = setup(t);
  seedStreamer(db, '1002');

  store.capture(META, () => {
    db.prepare(`UPDATE streamers SET alias = '第一次改' WHERE uid = '1002'`).run();
    pollFillStreamer(db, '1002', 700);
  });
  // 第三方（另一个入口）把配置列改成别的值：后像 ≠ 当前值 → 中止
  db.prepare(`UPDATE streamers SET alias = '别人改的' WHERE uid = '1002'`).run();

  const r = store.undo(adminScope());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'conflict');
  assert.match(r.detail!, /streamers \(uid=1002\)/);
  assert.equal(
    (db.prepare(`SELECT alias FROM streamers WHERE uid = '1002'`).get() as { alias: string }).alias,
    '别人改的', '冲突中止时第三方写的值必须原样留着',
  );
});

test('watch_streamer 两种形状的撤销：不在名单→插行（撤销删行）、已在名单→更新（撤销按列还原）', (t) => {
  const { db, store } = setup(t);

  // 形状 A：uid 不在 streamers（只可能在关注候选池里）→ 建行；撤销 = 整行删除
  const a = store.capture({ ...META, tool: 'watch_streamer' }, () => seedStreamer(db, '2001', 800, { source: 'follows' }));
  assert.ok(a.changeId);
  assert.equal(store.peek(adminScope())!.rows[0]!.beforeExists, false, '前像不存在 = 插行');
  assert.equal(store.undo(adminScope()).ok, true);
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM streamers WHERE uid = '2001'`).get() as { n: number }).n, 0,
    '撤销新建 = 行没了',
  );

  // 形状 B：已在名单但 watch=0（unwatch 过）→ upsertStreamer 的 ON CONFLICT 走更新同一行；撤销 = 只还原配置列
  seedStreamer(db, '2002', 800, { watch: 0, alias: '别删我', profile_note: '备注', weibo_nick: '她的微博', weibo_uid: '2203177060' });
  pollFillStreamer(db, '2002', 850); // 轮询先回填过一轮：撤销不该把它回滚
  const b = store.capture({ ...META, tool: 'watch_streamer' }, () =>
    db.prepare(`UPDATE streamers SET watch = 1, updated_at = 900 WHERE uid = '2002'`).run());
  assert.ok(b.changeId);
  assert.equal(store.peek(adminScope())!.rows[0]!.beforeExists, true, '前像存在 = 更新已存在行');

  const u = store.undo(adminScope());
  assert.equal(u.ok, true);
  const row = db.prepare(`SELECT * FROM streamers WHERE uid = '2002'`).get() as Record<string, unknown>;
  assert.equal(row.watch, 0, 'watch 还原');
  assert.equal(row.alias, '别删我', '别名原样保留（同一行的其它配置列不动）');
  assert.equal(row.profile_note, '备注');
  assert.equal(row.weibo_nick, '她的微博');
  assert.equal(row.weibo_uid, '2203177060');
  assert.equal(row.uname, '平台名', '轮询列不还原');
  assert.equal(row.updated_at, 900, 'updated_at 不还原');
});

test('撤销删除：streamers 按前像整行重插（忽略列随前像回来，同三张账号名单口径）', (t) => {
  const { db, store } = setup(t);
  // 生产路径里暂无「删 streamers 行」的写（下监听 = watch=0 保留条目）——这里钉住 store 层的形状，
  // 与 accounts 表口径一致：insertRow 按前像整行重插，不做忽略列过滤
  seedStreamer(db, '3001', 700, { source: 'follows' });
  pollFillStreamer(db, '3001', 750);

  store.capture(META, () => db.prepare(`DELETE FROM streamers WHERE uid = '3001'`).run());
  const u = store.undo(adminScope());
  assert.equal(u.ok, true);
  const row = db.prepare(`SELECT * FROM streamers WHERE uid = '3001'`).get() as Record<string, unknown>;
  assert.equal(row.uname, '平台名', '前像整行重插：平台事实列也随前像回来');
  assert.equal(row.face, 'f.jpg');
  assert.equal(row.room_id, '80397');
  assert.equal(row.updated_at, 750);
  assert.equal(row.created_at, 700, '建行时间与来源照抄前像');
  assert.equal(row.source, 'follows');
});

test('撤销结果带 tables / settingKeys / tool（入口层据此触发热生效）', (t) => {
  const { db, store } = setup(t);
  db.prepare(`INSERT INTO settings (key, value) VALUES ('listen_weibo', '1')`).run();
  store.capture({ ...META, tool: 'set_listen' }, () =>
    db.prepare(`UPDATE settings SET value = '0' WHERE key = 'listen_weibo'`).run());

  const u = store.undo(adminScope());
  assert.equal(u.ok, true);
  assert.equal(u.tool, 'set_listen');
  assert.deepEqual(u.tables, ['settings']);
  assert.deepEqual(u.settingKeys, ['listen_weibo']);
  assert.deepEqual(undoEffects(u), ['listen']);

  // 隐私例外（LLM key）也在 settingKeys 里点名（主键没打码，值才打码）
  db.prepare(`INSERT INTO settings (key, value) VALUES ('llm_key:p', 'sk-a')`).run();
  store.capture(META, () => db.prepare(`UPDATE settings SET value = 'sk-b' WHERE key = 'llm_key:p'`).run());
  const u2 = store.undo(adminScope());
  assert.deepEqual(u2.settingKeys, ['llm_key:p']);
  assert.deepEqual(u2.refill, ['settings.(key=llm_key:p)']);
  assert.deepEqual(undoEffects(u2), ['llm'], '撤 key = 清空 + 重填提示，且要重建 router');

  // 空栈/中止不带这些字段（入口层据此只做错误映射）
  assert.deepEqual(store.undo(adminScope()), { ok: false, reason: 'empty' });
});

test('undoEffects：受影响表 / settings 键 → 热生效标签（P0 判据 6 的映射表）', () => {
  // settings 键：运行参数 → reconcileRuntime；listen_* → reconcileListen；llm_* → 重建 router；
  // napcat_* → 重装配通道；其余（推送总开关等由 pipeline 逐条读表）无回调
  assert.deepEqual(undoEffects({ settingKeys: ['poll_interval_sec'] }), ['runtime']);
  assert.deepEqual(undoEffects({ settingKeys: ['notify_on_first_run'] }), ['runtime']);
  assert.deepEqual(undoEffects({ settingKeys: ['listen_dynamic'] }), ['listen']);
  assert.deepEqual(undoEffects({ settingKeys: ['llm_providers'] }), ['llm']);
  assert.deepEqual(undoEffects({ settingKeys: ['llm_key:p1'] }), ['llm']);
  // 决策模型管理面暂无运行期缓存（名单与 key 按需直读 settings），撤销后不需要热生效回调
  assert.deepEqual(undoEffects({ settingKeys: ['decision_providers'] }), []);
  assert.deepEqual(undoEffects({ settingKeys: ['decision_key:jev'] }), []);
  assert.deepEqual(undoEffects({ settingKeys: ['napcat_enabled'] }), ['notifiers']);
  assert.deepEqual(undoEffects({ settingKeys: ['push_enabled'] }), []);
  // 表：三张图文名单 = 源名单变化 → 同一个启停入口；渠道行 → 装配级重同步；其余无回调
  assert.deepEqual(undoEffects({ tables: ['x_accounts'] }), ['listen']);
  assert.deepEqual(undoEffects({ tables: ['weibo_accounts', 'bili_accounts'] }), ['listen']);
  assert.deepEqual(undoEffects({ tables: ['push_channels'] }), ['notifiers']);
  assert.deepEqual(
    undoEffects({ tables: ['streamers'] }), [],
    '监听名单（含 watch）由 live-status / 动态源每轮直读 DB，撤销无需重启任何源',
  );
  assert.deepEqual(undoEffects({ tables: ['settings', 'push_rules', 'categories', 'post_rules'] }), []);
  // 一条记录跨面时全部给出，顺序稳定（settings 键在前）
  assert.deepEqual(
    undoEffects({ tables: ['settings', 'x_accounts'], settingKeys: ['listen_weibo', 'llm_key:a'] }),
    ['listen', 'llm'],
  );
  assert.deepEqual(undoEffects({}), []);
});