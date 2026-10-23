import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from './db.js';
import { seedOnboardingDefaults } from './onboarding.js';
import { listLlmProviders } from '../analysis/providers.js';
import {
  ONBOARDING_CATEGORIES,
  ONBOARDING_LLM_PROVIDERS,
  ONBOARDING_RULES,
} from './onboarding-defaults.gen.js';

/** 内存库：每个测试独立，不需要清理临时文件 */
function memDb(t: import('node:test').TestContext): Db {
  const db = new Db(':memory:');
  t.after(() => db.close());
  return db;
}

test('首启：空库种入「系统通知」渠道 + 默认分类 + 默认规则（引用按名映射、渠道重映射）', async (t) => {
  const db = memDb(t);
  seedOnboardingDefaults(db);

  const channels = db.listPushChannels();
  assert.equal(channels.length, 1);
  assert.equal(channels[0]!.name, '系统通知');
  assert.equal(channels[0]!.notifier, 'toast');
  assert.equal(channels[0]!.targetId, null);

  const providers = listLlmProviders(db);
  assert.deepEqual(providers, ONBOARDING_LLM_PROVIDERS, '空库应种入默认 LLM provider 名单');

  const cats = db.listCategories();
  assert.equal(cats.length, ONBOARDING_CATEGORIES.length);
  assert.deepEqual(cats.map((c) => c.name), ONBOARDING_CATEGORIES.map((c) => c.name));
  assert.deepEqual(cats.map((c) => c.primary), ONBOARDING_CATEGORIES.map(() => false), '默认分类不进主分类组');

  const rules = db.listPushRules();
  assert.equal(rules.length, ONBOARDING_RULES.length);
  const catIdByName = new Map(cats.map((c) => [c.name, c.id]));
  for (let i = 0; i < ONBOARDING_RULES.length; i++) {
    const want = ONBOARDING_RULES[i]!;
    const got = rules[i]!;
    assert.equal(got.name, want.name);
    assert.equal(got.scope.length, 0, '默认规则恒为全部主播生效（scope 空 = 全部生效）');
    assert.deepEqual(got.channels, [channels[0]!.id], '规则渠道应重映射到种入的系统通知渠道');
    assert.equal(got.messageTemplate, want.messageTemplate);
    assert.equal(got.enabled, true);
    const wantCatId = want.category !== null ? (catIdByName.get(want.category) ?? null) : null;
    assert.equal(got.categoryId, wantCatId, `规则「${want.name}」分类引用应按名映射`);
  }
});

test('一次性闸门：再次调用不重复种入；用户清空默认值后不复活', async (t) => {
  const db = memDb(t);
  seedOnboardingDefaults(db);
  const firstIds = db.listPushRules().map((r) => r.id);

  seedOnboardingDefaults(db);
  assert.deepEqual(db.listPushRules().map((r) => r.id), firstIds, '重复调用不得产生新行');
  assert.equal(db.listPushChannels().length, 1);

  // 用户清空默认值 → 不复活（settings 闸门）
  for (const r of db.listPushRules()) db.deletePushRule(r.id);
  for (const c of db.listCategories()) db.deleteCategory(c.id);
  seedOnboardingDefaults(db);
  assert.equal(db.listPushRules().length, 0);
  assert.equal(db.listCategories().length, 0);
});

test('部分已配置：已有渠道不种渠道，规则渠道映射到现有首条；已有分类不种分类', async (t) => {
  const db = memDb(t);
  const myChanId = db.upsertPushChannel({
    name: '我的群', notifier: 'onebot', targetType: 'group', targetId: '123456', enabled: true,
  });
  db.upsertCategory({
    name: '游戏', llmPrompt: null, keywords: ['游戏'], areas: [], condMode: 'or', enabled: true,
  });
  seedOnboardingDefaults(db);

  const channels = db.listPushChannels();
  assert.equal(channels.length, 1, '已有渠道时不种「系统通知」');
  assert.equal(channels[0]!.id, myChanId);
  assert.deepEqual(
    db.listCategories().map((c) => c.name), ['游戏'],
    '已有分类时不种默认分类',
  );
  const rules = db.listPushRules();
  assert.equal(rules.length, ONBOARDING_RULES.length, '规则表为空仍种默认规则');
  for (const r of rules) {
    assert.deepEqual(r.channels, [myChanId], '规则渠道应映射到现有首条渠道');
    assert.equal(r.categoryId, null, '引用的分类名不在现有表中 → 落 null（任意开播）');
  }
  assert.deepEqual(listLlmProviders(db), ONBOARDING_LLM_PROVIDERS, 'llm_providers 未配置仍种默认名单');
});

test('LLM 名单已配置：不覆盖用户自己的 provider 名单', async (t) => {
  const db = memDb(t);
  db.setSetting('llm_providers', JSON.stringify([{
    name: 'mine', baseURL: 'http://127.0.0.1:1234/v1', model: 'm', vision: false,
    enabled: true, structuredOutput: 'schema', api: 'chat-completions',
  }]));
  seedOnboardingDefaults(db);
  const providers = listLlmProviders(db);
  assert.equal(providers.length, 1);
  assert.equal(providers[0]!.name, 'mine', '已配置的 llm_providers 不被默认值覆盖');
});
