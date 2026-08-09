import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from './db.js';
import {
  isPushEnabled, setPushEnabled,
  type NewCategory, type NewPushChannel, type NewPushRule, type NewVerdict,
} from './push.js';

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

function category(over: Partial<NewCategory> = {}): NewCategory {
  return {
    name: '歌回', llmPrompt: null, keywords: ['歌回'], areas: ['虚拟Singer'],
    condMode: 'and', enabled: true,
    ...over,
  };
}

function rule(over: Partial<NewPushRule> = {}): NewPushRule {
  return {
    name: '', categoryId: null, uids: [], channels: [1, 2],
    messageTemplate: '{alias} 开播了', enabled: true,
    ...over,
  };
}

function verdict(over: Partial<NewVerdict> = {}): NewVerdict {
  return {
    roomId: 'r1', liveTime: 1_785_310_737, uid: '1', categoryId: 1, categoryName: '歌回',
    source: 'rule', confidence: null, evidence: '关键词「歌回」',
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

// ---- categories ----

test('categories CRUD：JSON 数组字段往返 / 部分更新保留原值 / disabled 不进 enabled 列表', (t) => {
  const db = memDb(t);
  const id = db.upsertCategory(category());
  assert.ok(id > 0);
  db.upsertCategory(category({ name: '游戏', enabled: false }));

  const enabled = db.listEnabledCategories();
  assert.equal(enabled.length, 1, 'disabled 不进 enabled 列表');
  assert.deepEqual(enabled[0]!.keywords, ['歌回'], 'JSON 数组字段正确解析');
  assert.deepEqual(enabled[0]!.areas, ['虚拟Singer']);
  assert.equal(enabled[0]!.condMode, 'and');
  assert.equal(db.listCategories().length, 2, 'listCategories 含 disabled');

  db.upsertCategory({ id, llmPrompt: '判断是否在唱歌', condMode: 'or', enabled: false });
  const c = db.listCategories().find((x) => x.id === id)!;
  assert.equal(c.llmPrompt, '判断是否在唱歌', '提供的字段被更新');
  assert.equal(c.condMode, 'or');
  assert.equal(c.enabled, false);
  assert.equal(c.name, '歌回', '未提供的字段保留原值');
  assert.deepEqual(c.keywords, ['歌回']);

  assert.equal(db.deleteCategory(id), true);
  assert.equal(db.deleteCategory(id), false);
});

test('分类名称：不传自动补「分类 N」，传了存自定义名', (t) => {
  const db = memDb(t);
  const id = db.upsertCategory(category({ name: '' }));
  assert.equal(db.listCategories().find((x) => x.id === id)!.name, `分类 ${id}`);
  const id2 = db.upsertCategory(category({ name: '杂谈' }));
  assert.equal(db.listCategories().find((x) => x.id === id2)!.name, '杂谈');
});

test('分类拖拽排序：reorderCategories 重写顺序，新分类排末尾', (t) => {
  const db = memDb(t);
  const a = db.upsertCategory(category({ name: 'a' }));
  const b = db.upsertCategory(category({ name: 'b' }));
  db.reorderCategories([b, a]);
  assert.deepEqual(db.listCategories().map((x) => x.name), ['b', 'a']);
  const c = db.upsertCategory(category({ name: 'c' }));
  assert.deepEqual(db.listCategories().map((x) => x.name), ['b', 'a', 'c'], '新分类排末尾');
});

test('删除分类级联停用引用它的推送规则，返回受影响条数', (t) => {
  const db = memDb(t);
  const cat = db.upsertCategory(category());
  const other = db.upsertCategory(category({ name: '游戏' }));
  db.upsertPushRule(rule({ categoryId: cat }));
  db.upsertPushRule(rule({ categoryId: cat, enabled: false })); // 已停用不再计数
  db.upsertPushRule(rule({ categoryId: other }));
  db.upsertPushRule(rule()); // 任意开播，不受影响

  assert.equal(db.disablePushRulesByCategory(cat), 1, '只计新停用的规则（已停用的不重复计数）');
  const rules = db.listPushRules();
  assert.equal(rules.filter((r) => r.categoryId === cat && !r.enabled).length, 2, '规则保留可恢复');
  assert.equal(rules.find((r) => r.categoryId === other)!.enabled, true, '其他分类的规则不受影响');
  assert.equal(rules.find((r) => r.categoryId === null)!.enabled, true);
  assert.equal(db.disablePushRulesByCategory(cat), 0, '重复调用幂等（已全部停用）');

  assert.equal(db.deleteCategory(cat), true);
});

// ---- push_rules v2 ----

test('push_rules v2 CRUD：JSON 数组字段往返 / categoryId 可空 / disabled 不进 enabled 列表', (t) => {
  const db = memDb(t);
  const id = db.upsertPushRule(rule({ categoryId: 3, uids: ['1', '2'] }));
  assert.ok(id > 0);
  db.upsertPushRule(rule({ enabled: false }));

  const enabled = db.listEnabledPushRules();
  assert.equal(enabled.length, 1, 'disabled 不进 enabled 列表');
  assert.equal(enabled[0]!.categoryId, 3);
  assert.deepEqual(enabled[0]!.uids, ['1', '2'], 'JSON 数组字段正确解析');
  assert.deepEqual(enabled[0]!.channels, [1, 2]);
  assert.equal(enabled[0]!.messageTemplate, '{alias} 开播了');
  assert.equal(db.listPushRules().length, 2, 'listPushRules 含 disabled');

  db.upsertPushRule({ id, categoryId: null, uids: [], channels: [3], messageTemplate: null });
  const r = db.listPushRules().find((x) => x.id === id)!;
  assert.equal(r.categoryId, null, 'categoryId 可置空（任意开播）');
  assert.deepEqual(r.uids, [], 'uids 可置空（全部主播）');
  assert.deepEqual(r.channels, [3]);
  assert.equal(r.messageTemplate, null, 'messageTemplate 可置空（用内置默认模板）');

  assert.equal(db.deletePushRule(id), true);
  assert.equal(db.deletePushRule(id), false);
});

test('规则名称：不传自动补「规则 N」，传了存自定义名', (t) => {
  const db = memDb(t);
  const id = db.upsertPushRule(rule());
  assert.equal(db.listPushRules().find((x) => x.id === id)!.name, `规则 ${id}`);
  const id2 = db.upsertPushRule(rule({ name: '歌回专用' }));
  assert.equal(db.listPushRules().find((x) => x.id === id2)!.name, '歌回专用');
});

test('规则拖拽排序：reorderPushRules 全局重写匹配优先级，新规则排末尾', (t) => {
  const db = memDb(t);
  const a = db.upsertPushRule(rule({ name: 'a' }));
  const b = db.upsertPushRule(rule({ name: 'b' }));
  const c = db.upsertPushRule(rule({ name: 'c', uids: ['9'] }));
  db.reorderPushRules([c, b, a]);
  assert.deepEqual(db.listEnabledPushRules().map((x) => x.name), ['c', 'b', 'a'], '全局排序，不按主播分组');
  const d = db.upsertPushRule(rule({ name: 'd' }));
  assert.deepEqual(db.listEnabledPushRules().map((x) => x.name), ['c', 'b', 'a', 'd'], '新规则排末尾');
});

// ---- verdicts ----

test('verdicts：插入 / UNIQUE(room_id, live_time, category_id) 去重 / 按场查询', (t) => {
  const db = memDb(t);
  db.insertVerdict(verdict());
  db.insertVerdict(verdict({ categoryId: 2, categoryName: '游戏', source: 'llm', confidence: 0.9, evidence: '在打 APEX' }));
  db.insertVerdict(verdict({ evidence: '重复插入' }));

  const list = db.listVerdicts('r1', 1_785_310_737);
  assert.equal(list.length, 2, '同场同分类重复插入被 IGNORE');
  assert.equal(list[0]!.categoryName, '歌回');
  assert.equal(list[0]!.source, 'rule');
  assert.equal(list[0]!.confidence, null, 'rule 路径置信度为 null');
  assert.equal(list[0]!.evidence, '关键词「歌回」', '首插生效，重复插入不覆盖');
  assert.equal(list[1]!.categoryName, '游戏');
  assert.equal(list[1]!.source, 'llm');
  assert.equal(list[1]!.confidence, 0.9);

  assert.equal(db.listVerdicts('r1', 999).length, 0, '另一场直播互不影响');
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

test('推送总开关：缺省开，可开关，persist', (t) => {
  const db = memDb(t);
  assert.equal(isPushEnabled(db), true, '缺省开');
  setPushEnabled(db, false);
  assert.equal(isPushEnabled(db), false);
  assert.equal(db.getSetting('push_enabled'), '0');
  setPushEnabled(db, true);
  assert.equal(isPushEnabled(db), true);
});

test('渠道拖拽排序：reorderPushChannels 重写顺序，新渠道排末尾', (t) => {
  const db = memDb(t);
  const a = db.upsertPushChannel(channel({ name: 'a' }));
  const b = db.upsertPushChannel(channel({ name: 'b' }));
  db.reorderPushChannels([b, a]);
  assert.deepEqual(db.listPushChannels().map((x) => x.name), ['b', 'a']);
  const c = db.upsertPushChannel(channel({ name: 'c' }));
  assert.deepEqual(db.listPushChannels().map((x) => x.name), ['b', 'a', 'c'], '新渠道排末尾');
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
