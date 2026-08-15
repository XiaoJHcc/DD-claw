import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateSnapshotPaths } from './migrate-snapshot-paths.js';

function tmpdir_(t: import('node:test').TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'ddclaw-mig-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeDb(path: string, rows: Array<[string, number, number, string]>): void {
  const raw = new Database(path);
  raw.exec(`CREATE TABLE snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL, live_time INTEGER NOT NULL, ts INTEGER NOT NULL,
    path TEXT NOT NULL, bytes INTEGER NOT NULL
  );`);
  const stmt = raw.prepare('INSERT INTO snapshots (room_id, live_time, ts, path, bytes) VALUES (?, ?, ?, ?, 10)');
  for (const [room, lt, ts, p] of rows) stmt.run(room, lt, ts, p);
  raw.close();
}

test('migrateSnapshotPaths：旧绝对路径（盘符 + 正斜杠）改写为相对，相对行不动', (t) => {
  const dir = tmpdir_(t);
  const dbPath = join(dir, 'mig.db');
  makeDb(dbPath, [
    ['80397', 1000, 100, 'D:\\DD-claw\\data\\cache\\keyframes\\80397\\1000\\100.jpg'],
    ['80397', 1000, 200, 'D:/DD-claw/data/cache/keyframes/80397/1000/200.png'],
    ['80397', 1001, 300, '80397/1001/300.jpg'],
  ]);

  const db = new Database(dbPath);
  const changed = migrateSnapshotPaths(db);
  const rows = db.prepare('SELECT path FROM snapshots ORDER BY ts').all() as Array<{ path: string }>;
  db.close();

  assert.equal(changed, 2, '只有两条绝对路径被改写');
  assert.deepEqual(rows.map((r) => r.path), [
    join('80397', '1000', '100.jpg'),
    join('80397', '1000', '200.png'),
    '80397/1001/300.jpg', // 相对行原样保留
  ], '盘符/正斜杠绝对路径都转相对，扩展名保留，相对路径不动');
});

test('migrateSnapshotPaths：幂等——已相对化后再跑，changed 为 0', (t) => {
  const dir = tmpdir_(t);
  const dbPath = join(dir, 'mig.db');
  makeDb(dbPath, [['80397', 1000, 100, 'D:\\DD-claw\\kf\\80397\\1000\\100.jpg']]);

  const db = new Database(dbPath);
  const first = migrateSnapshotPaths(db);
  const second = migrateSnapshotPaths(db);
  const rows = db.prepare('SELECT path FROM snapshots').all() as Array<{ path: string }>;
  db.close();

  assert.equal(first, 1);
  assert.equal(second, 0, '已相对化，重复跑不改写');
  assert.equal(rows[0]!.path, join('80397', '1000', '100.jpg'));
});

test('migrateSnapshotPaths：空表 / 全相对 → changed 0，不抛', (t) => {
  const dir = tmpdir_(t);
  const emptyPath = join(dir, 'empty.db');
  makeDb(emptyPath, []);
  const empty = new Database(emptyPath);
  assert.equal(migrateSnapshotPaths(empty), 0, '空表 0');
  empty.close();

  const relPath = join(dir, 'rel.db');
  makeDb(relPath, [['80397', 1000, 100, '80397/1000/100.jpg']]);
  const rel = new Database(relPath);
  assert.equal(migrateSnapshotPaths(rel), 0, '全相对 0');
  rel.close();
});
