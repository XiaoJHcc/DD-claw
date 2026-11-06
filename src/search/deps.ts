/**
 * 远程检索的装配契约：能力层（mcp/tools.ts）只认这几个函数，不关心 key、代理与端点。
 * 生产实现由装配根（index.ts）按 settings 现场解析凭据后注入；测试注入假实现。
 */
import type { WebSearchResult } from './web.js';
import type { KeySourceStatus } from './config.js';
import type { BiliUserHit } from '../sources/bili/search.js';
import type { WeiboUserHit } from '../sources/weibo/search.js';
import type { XAccountCandidate } from '../sources/twitter/search.js';

/**
 * 账号搜索模式：
 * - `discover`（默认）：尽量找出账号——微博有登录态时走全站搜索，X 有 Apify token 时优先 People 搜索；
 * - `suggest`：只给快速候选建议（给输入框联想/快速确认用），不跑昂贵的多级发现。
 *
 * 两个模式都只返回「线索」，空数组 = 这次没找到，不表示账号不存在。
 */
export type AccountSearchMode = 'discover' | 'suggest';

export interface SearchStatus {
  /** 面板专填的搜索 key（与 LLM key 同口径：本机明文回显） */
  key: KeySourceStatus;
  /** 回退命中的供应商显示名；null = 用的是面板 key，或没有可用凭据 */
  providerName: string | null;
  /** Apify API token（X People 搜索用；同一口径：本机明文回显） */
  apifyKey: KeySourceStatus;
}

export interface SearchDeps {
  web(query: string, opts?: { count?: number }): Promise<WebSearchResult[]>;
  /** mode 缺省 discover；B站搜索没有模式区分，实现可忽略 */
  biliAccounts(keyword: string, limit?: number, mode?: AccountSearchMode): Promise<BiliUserHit[]>;
  weiboAccounts(keyword: string, limit?: number, mode?: AccountSearchMode): Promise<WeiboUserHit[]>;
  xAccounts(query: string, limit?: number, mode?: AccountSearchMode): Promise<XAccountCandidate[]>;
  status(): SearchStatus;
}
