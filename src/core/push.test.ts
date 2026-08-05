import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from './db.js';
import type { NewPushChannel, NewPushRule } from './push.js';

/** 内存库：每个测试独立，不需要清理临时文件 */
function memDb(t: import('node:test').TestContext): Db {
  const db = new Db(':memory:');
  t.after(() => db.close());
  return db;
}

function channel(over: Partial<NewPushChannel> = {}): NewPushChannel {
  return {
    name: '粉丝群', notifier: 'onebot', targetType: 'group', targetId: '123456', enabled: true,
    ...over,
  };
}

function rule(over: Partial<NewPushRule> = {}): NewPushRule {
  return {
    uid: '1', keywords: ['歌回'], areas: ['虚拟Singer'], channels: [1, 2],
    messageTemplate: '{alias} 开歌回了', enabled: true,
    ...over,
  };
}

// ---- push_channels ----

test('push_channels CRUD：建行 / 部分更新保留原值 / 删除', (t) => {
  const db = memDb(t);
  const id = db.upsertPushChannel(channel());
  assert.ok(id > 0);
  db.upsertPushChannel(channel({ name: '系统通知', notifier: 'toast', targetType: null, targetId: null }));

  const all = db.listPushChannels();
  assert.equal(all.length, 2);
  assert.deepEqual(
    all.map((c) => [c.name, c.notifier, c.targetType, c.targetId, c.enabled]),
    [['粉丝群', 'onebot', 'group', '123456', true], ['系统通知', 'toast', null, null, true]],
  );

  db.upsertPushChannel({ id, name: '亲友群', enabled: false });
  const c = db.listPushChannels().find((x) => x.id === id)!;
  assert.equal(c.name, '亲友群', '提供的字段被更新');
  assert.equal(c.enabled, false);
  assert.equal(c.targetId, '123456', '未提供的字段保留原值');
  assert.equal(c.notifier, 'onebot');

  assert.equal(db.deletePushChannel(id), true);
  assert.equal(db.deletePushChannel(id), false, '重复删除返回 false');
  assert.equal(db.listPushChannels().length, 1);
});

test('seedPushChannelsIfEmpty：onebot targets + toast → 渠道行，幂等', (t) => {
  const db = memDb(t);
  const n = db.seedPushChannelsIfEmpty([
    channel({ name: 'QQ群 111', targetId: '111' }),
    channel({ name: 'QQ私聊 222', targetType: 'private', targetId: '222' }),
    channel({ name: '系统通知', notifier: 'toast', targetType: null, targetId: null }),
  ]);
  assert.equal(n, 3);
  assert.deepEqual(
    db.listPushChannels().map((c) => [c.name, c.notifier]),
    [['QQ群 111', 'onebot'], ['QQ私聊 222', 'onebot'], ['系统通知', 'toast']],
  );

  assert.equal(db.seedPushChannelsIfEmpty([channel({ name: '再来一个' })]), 0, '非空时不得导入');
  assert.equal(db.listPushChannels().length, 3, '表内容不变');
});

// ---- push_rules ----

test('push_rules CRUD：JSON 数组字段往返 / uid 过滤 / disabled 不进 enabled 列表', (t) => {
  const db = memDb(t);
  const id = db.upsertPushRule(rule());
  assert.ok(id > 0);
  db.upsertPushRule(rule({ uid: '2', enabled: false }));

  const mine = db.listEnabledPushRules('1');
  assert.equal(mine.length, 1);
  assert.deepEqual(mine[0]!.keywords, ['歌回'], 'JSON 数组字段正确解析');
  assert.deepEqual(mine[0]!.areas, ['虚拟Singer']);
  assert.deepEqual(mine[0]!.channels, [1, 2]);
  assert.equal(mine[0]!.messageTemplate, '{alias} 开歌回了');
  assert.equal(db.listEnabledPushRules('2').length, 0, 'disabled 不进 enabled 列表');
  assert.equal(db.listPushRules().length, 2, 'listPushRules 含 disabled');

  db.upsertPushRule({ id, keywords: [], areas: [], channels: [3], messageTemplate: null });
  const r = db.listPushRules().find((x) => x.id === id)!;
  assert.deepEqual(r.keywords, [], '空条件规则（默认推送）可存');
  assert.deepEqual(r.channels, [3]);
  assert.equal(r.messageTemplate, null, 'messageTemplate 可置空（用全局默认模板）');
  assert.equal(r.uid, '1', '未提供的 uid 保留原值');

  assert.equal(db.deletePushRule(id), true);
  assert.equal(db.deletePushRule(id), false);
});

test('upsertPushRule 新建必须提供 uid', (t) => {
  const db = memDb(t);
  assert.throws(() => db.upsertPushRule({ keywords: ['x'] }), /uid/);
});

// ---- settings ----

test('settings：未写为 null，写入可读，覆盖写生效', (t) => {
  const db = memDb(t);
  assert.equal(db.getSetting('default_template'), null);
  db.setSetting('default_template', '{alias} 开播了');
  assert.equal(db.getSetting('default_template'), '{alias} 开播了');
  db.setSetting('default_template', '{alias}来了');
  assert.equal(db.getSetting('default_template'), '{alias}来了');
});

// ---- preference_clauses 迁移 ----

test('preference_clauses 表存在即 DROP，二次打开幂等', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ddclaw-push-'));
  const path = join(dir, 'mig.db');
  let db: Db | undefined;
  t.after(() => {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // 手工建一个带 preference_clauses 的旧库
  const raw = new Database(path);
  raw.exec(`
    CREATE TABLE preference_clauses (
      id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL, scenes TEXT,
      min_confidence REAL, title_keywords TEXT,
      priority TEXT NOT NULL DEFAULT 'normal', message_template TEXT NOT NULL DEFAULT '',
      targets TEXT, enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO preference_clauses (uid, created_at, updated_at) VALUES ('1', 1, 1);
  `);
  raw.close();

  const tableExists = () => {
    const r = new Database(path, { readonly: true });
    const row = r
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='preference_clauses'")
      .get();
    r.close();
    return row !== undefined;
  };

  db = new Db(path);
  assert.equal(tableExists(), false, 'preference_clauses 应被 DROP');

  db.close();
  db = new Db(path);
  assert.equal(tableExists(), false, '二次打开幂等不报错');
  assert.ok(db.listPushRules().length === 0 && db.listPushChannels().length === 0, '新表正常可用');
});
