/**
 * 网页检索的凭据解析：settings `search_key` 优先，缺省回退到「baseURL 指向 DeepSeek 的启用
 * LLM 供应商」的 key（DeepSeek Search API 与 chat 共用同一个平台 key，老用户零配置即可用）。
 *
 * 为什么不做成独立 provider 体系：Search 只在 `api.deepseek.com/v1/tools/search` 这一个端点，
 * 没有模型名、没有协议分支；需要的只有一个 key，不值得再长一套 CRUD。
 */
import type { Db } from '../core/db.js';
import { splitCsvText } from '../core/csv.js';
import { llmKeySetting } from '../analysis/providers.js';
import type { LlmProviderConfig } from '../config/schema.js';

export const SEARCH_KEY_SETTING = 'search_key';
/** X People 搜索（Apify）的 API token；缺失时 X 账号发现回退免凭据网页路线 */
export const APIFY_KEY_SETTING = 'apify_key';
/** DeepSeek Search API 端点（base URL 固定；供应商 baseURL 只用来判断 key 是否 DeepSeek 的） */
export const SEARCH_ENDPOINT = 'https://api.deepseek.com/v1/tools/search';
/** 回退判据：只有这把端点上的 key 能搜 */
export const SEARCH_KEY_HOST = 'api.deepseek.com';

export interface SearchCredentials {
  key: string;
  /** panel = 设置页里专填的搜索 key；provider = 复用 DeepSeek 供应商的 key */
  source: 'panel' | 'provider';
  /** source=provider 时命中的供应商显示名（面板展示用） */
  providerName?: string;
}

/** 设置页展示口径（与 LLM key 一致：本机面板明文回显供编辑） */
export interface KeySourceStatus {
  source: 'panel' | 'unset';
  count: number;
  value: string | null;
}

function settingSource(db: Db, key: string): KeySourceStatus {
  const raw = db.getSetting(key);
  if (raw && raw.trim()) {
    const v = raw.trim();
    return { source: 'panel', count: splitCsvText(v).length, value: v };
  }
  return { source: 'unset', count: 0, value: null };
}

export function searchKeySource(db: Db): KeySourceStatus {
  return settingSource(db, SEARCH_KEY_SETTING);
}

/** Apify token 的展示口径（与搜索 key 同形状） */
export function apifyKeySource(db: Db): KeySourceStatus {
  return settingSource(db, APIFY_KEY_SETTING);
}

/** 当前可用的 Apify token；没有返回 null（X 账号发现据此决定走 People 搜索还是网页兜底） */
export function resolveApifyKey(db: Db): string | null {
  return splitCsvText(db.getSetting(APIFY_KEY_SETTING) ?? '')[0] ?? null;
}

function isDeepSeekBase(baseURL: string): boolean {
  try {
    return new URL(baseURL).hostname === SEARCH_KEY_HOST;
  } catch {
    return false;
  }
}

/** 当前可用的搜索凭据；都没有返回 null（调用方给中文指引） */
export function resolveSearchCredentials(
  db: Db,
  providers: readonly LlmProviderConfig[],
): SearchCredentials | null {
  const own = splitCsvText(db.getSetting(SEARCH_KEY_SETTING) ?? '');
  if (own[0]) return { key: own[0], source: 'panel' };
  for (const p of providers) {
    if (!p.enabled || !isDeepSeekBase(p.baseURL)) continue;
    const keys = splitCsvText(db.getSetting(llmKeySetting(p.id)) ?? '');
    if (keys[0]) return { key: keys[0], source: 'provider', providerName: p.name };
  }
  return null;
}
