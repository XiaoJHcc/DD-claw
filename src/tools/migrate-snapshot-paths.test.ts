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

test('migrateSnapshotPaths：绝对路径（盘符/正斜杠）与反斜杠相对都归一为正斜杠相对，规范行不动', (t) => {
  const dir = tmpdir_(t);
  const dbPath = join(dir, 'mig.db');
  makeDb(dbPath, [
    ['80397', 1000, 100, 'D:\\DD-claw\\data\\cache\\keyframes\\80397\\1000\\100.jpg'], // 盘符反斜杠绝对
    ['80397', 1000, 200, 'D:/DD-claw/data/cache/keyframes/80397/1000/200.png'],        // 盘符正斜杠绝对
    ['80397', 1000, 300, '80397\\1000\\300.jpg'],                                        // Windows join 产出的反斜杠相对
    ['80397', 1001, 400, '80397/1001/400.jpg'],                                          // 规范正斜杠相对
  ]);

  const db = new Database(dbPath);
  const changed = migrateSnapshotPaths(db);
  const rows = db.prepare('SELECT path FROM snapshots ORDER BY ts').all() as Array<{ path: string }>;
  db.close();

  assert.equal(changed, 3, '三种非规范形态被改写');
  assert.deepEqual(rows.map((r) => r.path), [
    '80397/1000/100.jpg',
    '80397/1000/200.png',
    '80397/1000/300.jpg',
    '80397/1001/400.jpg', // 规范相对路径原样保留
  ], '分隔符恒为正斜杠，扩展名保留，相对路径不动');
});

test('migrateSnapshotPaths：幂等——已归一后再跑，changed 为 0', (t) => {
  const dir = tmpdir_(t);
  const dbPath = join(dir, 'mig.db');
  makeDb(dbPath, [
    ['80397', 1000, 100, 'D:\\DD-claw\\kf\\80397\\1000\\100.jpg'],
    ['80397', 1000, 101, '80397\\1000\\101.jpg'],
  ]);

  const db = new Database(dbPath);
  const first = migrateSnapshotPaths(db);
  const second = migrateSnapshotPaths(db);
  const rows = db.prepare('SELECT path FROM snapshots ORDER BY ts').all() as Array<{ path: string }>;
  db.close();

  assert.equal(first, 2);
  assert.equal(second, 0, '已归一化，重复跑不改写');
  assert.equal(rows[0]!.path, '80397/1000/100.jpg');
  assert.equal(rows[1]!.path, '80397/1000/101.jpg');
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
