import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from './db.js';
import {
  isPushEnabled, liveVerdictSubjectId, postVerdictSubjectId, setPushEnabled, splitPushRuleChannel,
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
    postTypes: [], requireQuote: false, requireMedia: false, appliesTo: 'live',
    condMode: 'and', primary: false, enabled: true,
    ...over,
  };
}

function rule(over: Partial<NewPushRule> = {}): NewPushRule {
  return {
    name: '', subjectKind: 'live', categoryId: null, scope: [], channels: [1, 2],
    messageTemplate: '{liver} 开播了', llmTranslate: false, enabled: true,
    ...over,
  };
}

function verdict(over: Partial<NewVerdict> = {}): NewVerdict {
  return {
    subjectType: 'live', subjectId: 'r1:1785310737', uid: '1',
    categoryId: 1, ruleId: 0, categoryName: '歌回',
    source: 'rule', confidence: null, evidence: '关键词「歌回」', effective: true,
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

test('分类主分类标记：缺省 false、可勾选、补丁未提供保留原值', (t) => {
  const db = memDb(t);
  const plain = db.upsertCategory(category());
  assert.equal(db.listCategories().find((x) => x.id === plain)!.primary, false, '缺省不进主分类组');

  const primary = db.upsertCategory(category({ name: '歌回', primary: true }));
  assert.equal(db.listCategories().find((x) => x.id === primary)!.primary, true);
  db.upsertCategory({ id: primary, keywords: ['歌'] });
  assert.equal(db.listCategories().find((x) => x.id === primary)!.primary, true, '未提供的字段保留原值');

  db.upsertCategory({ id: primary, primary: false });
  assert.equal(db.listCategories().find((x) => x.id === primary)!.primary, false);
});

test('分类名称：不传自动补「分类 N」，传了存自定义名', (t) => {  const db = memDb(t);
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

// ---- push_rules（统一规则：subject_kind × 分类引用 × scope × 渠道）----

test('push_rules CRUD：JSON 数组字段往返 / categoryId 可空 / disabled 不进 enabled 列表', (t) => {
  const db = memDb(t);
  const id = db.upsertPushRule(rule({ categoryId: 3, scope: ['1', '2'] }));
  assert.ok(id > 0);
  db.upsertPushRule(rule({ enabled: false }));

  const enabled = db.listEnabledPushRules();
  assert.equal(enabled.length, 1, 'disabled 不进 enabled 列表');
  assert.equal(enabled[0]!.categoryId, 3);
  assert.equal(enabled[0]!.subjectKind, 'live');
  assert.deepEqual(enabled[0]!.scope, ['1', '2'], 'JSON 数组字段正确解析');
  assert.deepEqual(enabled[0]!.channels, [1, 2]);
  assert.equal(enabled[0]!.messageTemplate, '{liver} 开播了');
  assert.equal(enabled[0]!.llmTranslate, false);
  assert.equal(db.listPushRules().length, 2, 'listPushRules 含 disabled');

  db.upsertPushRule({ id, categoryId: null, scope: [], channels: [3], messageTemplate: null });
  const r = db.listPushRules().find((x) => x.id === id)!;
  assert.equal(r.categoryId, null, 'categoryId 可置空（任意内容）');
  assert.deepEqual(r.scope, [], 'scope 可置空（全部生效）');
  assert.deepEqual(r.channels, [3]);
  assert.equal(r.messageTemplate, null, 'messageTemplate 可置空（用内置默认模板）');

  assert.equal(db.deletePushRule(id), true);
  assert.equal(db.deletePushRule(id), false);
});

test('subject_kind / llm_translate 往返（图文规则同表）', (t) => {
  const db = memDb(t);
  const id = db.upsertPushRule(rule({
    subjectKind: 'post', scope: ['twitter:aaa', 'weibo:123', 'bili:456'],
    llmTranslate: true, messageTemplate: null,
  }));
  const r = db.listPushRules().find((x) => x.id === id)!;
  assert.equal(r.subjectKind, 'post');
  assert.deepEqual(r.scope, ['twitter:aaa', 'weibo:123', 'bili:456']);
  assert.equal(r.llmTranslate, true);
  // 部分更新保留未传字段
  db.upsertPushRule({ id, enabled: false });
  const r2 = db.listPushRules().find((x) => x.id === id)!;
  assert.equal(r2.llmTranslate, true, '未传字段保留原值');
  assert.equal(r2.subjectKind, 'post');
  assert.deepEqual(r2.scope, ['twitter:aaa', 'weibo:123', 'bili:456']);
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
  const c = db.upsertPushRule(rule({ name: 'c', scope: ['9'] }));
  db.reorderPushRules([c, b, a]);
  assert.deepEqual(db.listEnabledPushRules().map((x) => x.name), ['c', 'b', 'a'], '全局排序，不按主播分组');
  const d = db.upsertPushRule(rule({ name: 'd' }));
  assert.deepEqual(db.listEnabledPushRules().map((x) => x.name), ['c', 'b', 'a', 'd'], '新规则排末尾');
});

// ---- 渠道拆分（copy-on-write，docs/plan/agent-access.md「多渠道规则」）----

test('splitPushRuleChannel：多渠道规则拆出只含本渠道的一条（createdBy=mcp），原规则保留其余渠道', (t) => {
  const db = memDb(t);
  const a = db.upsertPushChannel(channel({ name: 'A群' }));
  const b = db.upsertPushChannel(channel({ name: 'B群' }));
  const id = db.upsertPushRule(rule({
    name: '双群规则', scope: ['1'], channels: [a, b], messageTemplate: '{liver} 来了', createdBy: null,
  }));

  const { id: splitId, split } = splitPushRuleChannel(db, db.listPushRules().find((x) => x.id === id)!, a);
  assert.equal(split, true);
  assert.notEqual(splitId, id, '拆出来的是一条新规则');

  const original = db.listPushRules().find((x) => x.id === id)!;
  assert.deepEqual(original.channels, [b], '原规则保留其余渠道');
  assert.equal(original.createdBy, null, '原规则 createdBy 原样（不沿用 admin 之外的值，也不被标成 mcp 规则）');
  assert.equal(original.name, '双群规则', '内容一行不动');
  assert.equal(original.messageTemplate, '{liver} 来了');

  const copy = db.listPushRules().find((x) => x.id === splitId)!;
  assert.deepEqual(copy.channels, [a], '拆出的一条只含本渠道');
  assert.equal(copy.createdBy, 'mcp', '拆出的副本显式打 mcp 标记');
  assert.deepEqual(copy.scope, ['1']);
  assert.equal(copy.messageTemplate, '{liver} 来了');
  assert.equal(db.listPushRules().length, 2);
});

test('splitPushRuleChannel：单渠道就地不拆；本渠道不在规则里则拒绝且不留半成品', (t) => {
  const db = memDb(t);
  const a = db.upsertPushChannel(channel({ name: 'A群' }));
  const b = db.upsertPushChannel(channel({ name: 'B群' }));

  const single = db.upsertPushRule(rule({ channels: [a] }));
  const inplace = splitPushRuleChannel(db, db.listPushRules().find((x) => x.id === single)!, a);
  assert.deepEqual(inplace, { id: single, split: false }, '只剩本渠道 → 返回原 id 就地操作');
  assert.equal(db.listPushRules().length, 1);

  const other = db.upsertPushRule(rule({ channels: [b] }));
  assert.throws(
    () => splitPushRuleChannel(db, db.listPushRules().find((x) => x.id === other)!, a),
    /不含渠道/,
    '调用方须先做渠道归属校验（能力层不允许拿别渠道的规则来拆）',
  );
  assert.equal(db.listPushRules().length, 2, '拒绝时不留半成品');
  assert.deepEqual(db.listPushRules().find((x) => x.id === other)!.channels, [b], '原规则一行不动');
});

// ---- verdicts ----

test('verdicts：插入 / UNIQUE(主体, 分类, 规则, 来源) 去重 / 按主体查询', (t) => {
  const db = memDb(t);
  assert.equal(liveVerdictSubjectId('r1', 1_785_310_737), 'r1:1785310737', 'live 身份键 = room_id:live_time');
  assert.equal(postVerdictSubjectId('twitter', '9001'), 'twitter:9001', 'post 身份键 = platform:item_id');
  db.insertVerdict(verdict());
  db.insertVerdict(verdict({ categoryId: 2, categoryName: '游戏', source: 'llm', confidence: 0.9, evidence: '在打 APEX' }));
  db.insertVerdict(verdict({ evidence: '重复插入' }));

  const list = db.listVerdicts('live', 'r1:1785310737');
  assert.equal(list.length, 2, '同主体同分类同 rule_id 重复插入被 IGNORE');
  assert.equal(list[0]!.categoryName, '歌回');
  assert.equal(list[0]!.subjectType, 'live');
  assert.equal(list[0]!.subjectId, 'r1:1785310737');
  assert.equal(list[0]!.ruleId, 0);
  assert.equal(list[0]!.pass, true, 'pass 缺省 true');
  assert.equal(list[0]!.source, 'rule');
  assert.equal(list[0]!.confidence, null, 'rule 路径置信度为 null');
  assert.equal(list[0]!.evidence, '关键词「歌回」', '首插生效，重复插入不覆盖');
  assert.equal(list[0]!.effective, true, 'effective 落库并可读回');
  assert.equal(list[1]!.categoryName, '游戏');
  assert.equal(list[1]!.source, 'llm');
  assert.equal(list[1]!.confidence, 0.9);

  // 唯一键含来源：同一分类的确定性行与模型行各自留痕，生效标记区分
  db.insertVerdict(verdict({ source: 'llm', evidence: '模型也判属于', effective: false }));
  db.insertVerdict(verdict({ source: 'llm', evidence: '重复', effective: false }));
  const mixed = db.listVerdicts('live', 'r1:1785310737').filter((v) => v.categoryId === 1);
  assert.deepEqual(
    mixed.map((v) => [v.source, v.effective, v.evidence]),
    [['rule', true, '关键词「歌回」'], ['llm', false, '模型也判属于']],
    '同分类多来源各一行，同来源重复插入被 IGNORE',
  );

  assert.equal(db.listVerdicts('live', 'r1:999').length, 0, '另一场直播互不影响');
});

test('verdicts：0 哨兵参与唯一键（同分类不同 rule_id 共存，同 rule_id 去重）', (t) => {
  const db = memDb(t);
  db.insertVerdict(verdict());
  db.insertVerdict(verdict({ ruleId: 5 }));
  db.insertVerdict(verdict({ ruleId: 5, evidence: '重复插入' }));

  const list = db.listVerdicts('live', 'r1:1785310737');
  assert.deepEqual(list.map((v) => v.ruleId), [0, 5], '哨兵 0 是真实值：与 rule_id=5 各占一行');
  assert.equal(list[1]!.evidence, '关键词「歌回」', '同 rule_id 重复插入不覆盖');
});

test('verdicts：subject_type 命名空间隔离（同 subject_id 字符串互不冲突）', (t) => {
  const db = memDb(t);
  db.insertVerdict(verdict());
  db.insertVerdict(verdict({
    subjectType: 'post', subjectId: 'r1:1785310737', ruleId: 7, categoryId: 0,
    categoryName: '图文规则', source: 'llm', confidence: 0.5, pass: false,
  }));

  assert.equal(db.listVerdicts('live', 'r1:1785310737').length, 1, 'live 行不受 post 行影响');
  const post = db.listVerdicts('post', 'r1:1785310737');
  assert.equal(post.length, 1);
  assert.equal(post[0]!.categoryId, 0, '规则级判定分类填 0 哨兵');
  assert.equal(post[0]!.ruleId, 7);
  assert.equal(post[0]!.pass, false, '判定不通过可落库');
});

// ---- settings ----

test('settings：未写为 null，写入可读，覆盖写生效', (t) => {
  const db = memDb(t);
  assert.equal(db.getSetting('default_template'), null);
  db.setSetting('default_template', '{liver} 开播了');
  assert.equal(db.getSetting('default_template'), '{liver} 开播了');
  db.setSetting('default_template', '{liver}来了');
  assert.equal(db.getSetting('default_template'), '{liver}来了');
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
