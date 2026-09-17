/**
 * 撤销引擎测试：差分快照、逆操作、冲突中止、按渠道分栈、隐私例外、同事务与回滚。
 * 表结构照抄 src/core/db.ts 的真实 DDL 形状（settings 以 key 为主键、其余以 id 自增为主键）。
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { adminScope, channelScope, UndoStore } from './undo.js';

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
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL DEFAULT '', category_id INTEGER,
    uids TEXT NOT NULL DEFAULT '[]', channels TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE archive_posts (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT);
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
    .prepare(`INSERT INTO push_rules (name, uids, channels, enabled, sort, created_at, updated_at) VALUES (?, '[]', '[]', 1, ?, ?, ?)`)
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
  assert.deepEqual(r, { ok: true, id: rec.id, applied: 1 });
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

test('非隐私 settings 正常还原（隐私判定只认 llm_key: 前缀）', (t) => {
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
  const { db, store } = setup(t); // 测试库里没有 post_rules / x_accounts
  const { changeId } = store.capture(META, () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('a', 'b')`).run();
  });
  assert.ok(changeId);
  assert.equal(store.peek(adminScope())!.rows.length, 1);
});
