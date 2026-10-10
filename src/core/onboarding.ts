/**
 * 发布后首次启动的默认值种入（LLM provider + 分类规则 + 推送规则 + 一个开箱即用的
 * 「系统通知」渠道）。默认值唯一信源 = webui/demo/defaults.json（手工维护的展示案例，
 * 与 demo mock 同一份），构建期由 scripts/build-webui.mjs 生成 onboarding-defaults.gen.ts。
 *
 * 纪律：
 * - settings `onboarding_seeded` 一次性闸门——只在有史以来第一次启动时种，
 *   用户之后清空/删除默认值不会复活（区别于 ensureColumn 的 schema 迁移，这是数据种入）。
 * - 各项独立判空/判未设：用户已自建渠道则不种渠道，规则渠道引用重映射到其首个渠道；
 *   已配过 llm_providers 则不种默认 provider（key 不种，面板自行填写）。
 */
import type { Db } from './db.js';
import { saveLlmProviders } from '../analysis/providers.js';
import {
  ONBOARDING_CATEGORIES,
  ONBOARDING_LLM_PROVIDERS,
  ONBOARDING_RULES,
} from './onboarding-defaults.gen.js';

const SEEDED_KEY = 'onboarding_seeded';
const LLM_PROVIDERS_SETTING = 'llm_providers';

/** 首启种入默认值；已种过（settings 标记）直接返回 */
export function seedOnboardingDefaults(db: Db): void {
  if (db.getSetting(SEEDED_KEY)) return;

  // 渠道：空表才种「系统通知」（toast 恒装配，开箱即用）；已有渠道则用其首条作规则映射目标
  let channelId = db.listPushChannels()[0]?.id ?? null;
  if (channelId === null) {
    channelId = db.upsertPushChannel({
      name: '系统通知', notifier: 'toast', targetType: null, targetId: null, enabled: true,
    });
  }

  // LLM provider：从未配置过才种默认名单（只种名单字段，key 由用户在面板填写）
  if (db.getSetting(LLM_PROVIDERS_SETTING) === null && ONBOARDING_LLM_PROVIDERS.length > 0) {
    saveLlmProviders(db, ONBOARDING_LLM_PROVIDERS);
  }

  if (db.listCategories().length === 0) {
    for (const c of ONBOARDING_CATEGORIES) {
      db.upsertCategory({
        name: c.name, llmPrompt: c.llmPrompt, keywords: c.keywords, areas: c.areas,
        condMode: c.condMode, enabled: true,
      });
    }
  }

  if (db.listPushRules().length === 0 && ONBOARDING_RULES.length > 0) {
    const catIdByName = new Map(db.listCategories().map((c) => [c.name, c.id]));
    for (const r of ONBOARDING_RULES) {
      db.upsertPushRule({
        name: r.name,
        subjectKind: 'live',
        categoryId: r.category !== null ? (catIdByName.get(r.category) ?? null) : null,
        scope: [],
        channels: channelId !== null ? [channelId] : [],
        messageTemplate: r.messageTemplate,
        enabled: true,
      });
    }
  }

  db.setSetting(SEEDED_KEY, '1');
}
