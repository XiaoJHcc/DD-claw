/**
 * 远程检索的装配契约：能力层（mcp/tools.ts）只认这四个函数，不关心 key、代理与端点。
 * 生产实现由装配根（index.ts）按 settings 现场解析凭据后注入；测试注入假实现。
 */
import type { WebSearchResult } from './web.js';
import type { BiliUserHit } from '../sources/bili/search.js';
import type { WeiboUserHit } from '../sources/weibo/search.js';
import type { XAccountCandidate } from '../sources/twitter/search.js';

export interface SearchStatus {
  /** 面板专填的搜索 key（与 LLM key 同口径：本机明文回显） */
  key: { source: 'panel' | 'unset'; count: number; value: string | null };
  /** 回退命中的供应商显示名；null = 用的是面板 key，或没有可用凭据 */
  providerName: string | null;
}

export interface SearchDeps {
  web(query: string, opts?: { count?: number }): Promise<WebSearchResult[]>;
  biliAccounts(keyword: string, limit?: number): Promise<BiliUserHit[]>;
  weiboAccounts(keyword: string, limit?: number): Promise<WeiboUserHit[]>;
  xAccounts(query: string, limit?: number): Promise<XAccountCandidate[]>;
  status(): SearchStatus;
}
