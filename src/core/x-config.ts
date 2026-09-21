/**
 * X / 推特 的连接与轮询设置（settings 唯一信源，面板「X / 推特」分页的「连接」「监听」两张卡）。
 *
 * 为什么与 runtime-config 分开：那边是纯数值/布尔规格表（/api/advanced 一张数字表），
 * 这里是字符串（代理地址、实例列表）+ 自己的范围校验，走独立端点 `/api/x`。
 * X 是独立于 B站/微博的一条路径，它的设置不该混进开播那套面板。
 */
import type { Db } from './db.js';

export const X_PROXY_DEFAULT = 'http://127.0.0.1:7890';
/** 2026-09-16 实测可用的两个实例；实例会死，所以这是可编辑的默认值而非硬编码 */
export const X_INSTANCES_DEFAULT = ['nitter.jaydenha.uk', 'x.n0g.xyz'];
export const X_INTERVAL_DEFAULT = 300;
export const X_INTERVAL_MIN = 120;
export const X_INTERVAL_MAX = 86400;

export const X_PROXY_KEY = 'x_proxy_url';
export const X_INSTANCES_KEY = 'x_nitter_instances';
export const X_INTERVAL_KEY = 'x_interval_sec';
export const X_FALLBACK_KEY = 'x_fallback_html';

export interface XConfig {
  /** HTTP 代理（CONNECT）；空串 = 不使用代理（墙外部署） */
  proxyUrl: string;
  /** Nitter 实例 host 列表（主路线：RSS） */
  instances: string[];
  /** 轮询间隔（秒）；X 帖频率低，默认与微博同量级 */
  intervalSec: number;
  /** Nitter 全挂时是否回退到免登录 x.com HTML + syndication */
  fallbackHtml: boolean;
}

export function getXConfig(db: Db): XConfig {
  const proxy = db.getSetting(X_PROXY_KEY);
  const instances = db.getSetting(X_INSTANCES_KEY);
  const interval = db.getSetting(X_INTERVAL_KEY);
  const fallback = db.getSetting(X_FALLBACK_KEY);
  const n = interval === null ? NaN : Number(interval);
  return {
    proxyUrl: proxy === null ? X_PROXY_DEFAULT : proxy.trim(),
    instances:
      instances === null
        ? [...X_INSTANCES_DEFAULT]
        : instances.split(',').map((s) => s.trim()).filter(Boolean),
    intervalSec:
      Number.isInteger(n) && n >= X_INTERVAL_MIN && n <= X_INTERVAL_MAX ? n : X_INTERVAL_DEFAULT,
    // 只有显式 '0' 才算关闭：缺省与非法库存值（手改过 settings）都按默认「开」处理
    fallbackHtml: fallback !== '0',
  };
}

/** 逐字段落 settings；缺省字段不动。调用方（面板 / MCP）先做形状校验。 */
export function saveXConfig(db: Db, patch: Partial<XConfig>): void {
  if (patch.proxyUrl !== undefined) db.setSetting(X_PROXY_KEY, patch.proxyUrl.trim());
  if (patch.instances !== undefined) db.setSetting(X_INSTANCES_KEY, patch.instances.join(','));
  if (patch.intervalSec !== undefined) db.setSetting(X_INTERVAL_KEY, String(patch.intervalSec));
  if (patch.fallbackHtml !== undefined) db.setSetting(X_FALLBACK_KEY, patch.fallbackHtml ? '1' : '0');
}

// ---- 探测状态快照（面板「连接」「监听」两张卡显示的那份）----
// 由装配处持有并更新：`GET /api/x` 只读它，绝不在读取路径上打网络。

export interface XStatus {
  proxy: { ok: boolean; message: string; checkedAt: number | null };
  instances: { host: string; ok: boolean; message: string }[];
  web: { ok: boolean; message: string; checkedAt: number | null };
  /** X 源的运行状态（sources/twitter/feed.ts 每轮回写） */
  feed: XFeedSnapshot;
  updatedAt: number | null;
}

/** X 源运行状态：面板「监听」卡显示的就是它 */
export interface XFeedSnapshot {
  running: boolean;
  lastRunAt: number | null;
  lastOkAt: number | null;
  /** 最近一轮生效的路线：nitter（主）/ web（回退） */
  via: 'nitter' | 'web' | null;
  /** 走 Nitter 时命中的实例 */
  host: string | null;
  /** 本轮轮询账号数 / 其中成功的 */
  accounts: number;
  okAccounts: number;
  lastError: string | null;
}

export function emptyXFeedSnapshot(): XFeedSnapshot {
  return {
    running: false,
    lastRunAt: null,
    lastOkAt: null,
    via: null,
    host: null,
    accounts: 0,
    okAccounts: 0,
    lastError: null,
  };
}

export function emptyXStatus(): XStatus {
  return {
    proxy: { ok: false, message: '尚未测试', checkedAt: null },
    instances: [],
    web: { ok: false, message: '尚未测试', checkedAt: null },
    feed: emptyXFeedSnapshot(),
    updatedAt: null,
  };
}

/**
 * 这次探测的输入是否就是**已保存**的配置。
 *
 * 只有「是」才该更新卡片上的状态快照——否则用户在弹窗里试了一个还没保存的坏代理，
 * 卡片会拿这个未保存值的失败结论配着已保存的地址显示（同一个红点误导两种含义）。
 * 未保存值的探测结果只落在弹窗里就地展示，不污染卡片。
 */
export function isSavedConfigTest(
  input: { proxyUrl?: string; instances?: string },
  cfg: XConfig,
): boolean {
  const proxySame = input.proxyUrl === undefined || input.proxyUrl.trim() === cfg.proxyUrl.trim();
  const instSame = input.instances === undefined
    || input.instances.split(',').map((s) => s.trim()).filter(Boolean).join(',') === cfg.instances.join(',');
  return proxySame && instSame;
}

/**
 * 配置变更后让**相关**旧结论失效。不这么做的话，用户把代理地址改对再保存，
 * 卡片会配着正确的地址继续显示上一轮的红点与失败原因——旧结论冒充现状。
 * 只失效受影响的部分：代理/回退变了动代理与免登录，实例名单变了动实例；
 * 轮询间隔不影响任何连通性结论，不该把状态清掉。
 */
export function invalidateXStatus(status: XStatus, prev: XConfig, next: XConfig): XStatus {
  let out = status;
  if (next.proxyUrl !== prev.proxyUrl || next.fallbackHtml !== prev.fallbackHtml) {
    const stale = { ok: false, message: '配置已改，请重新测试', checkedAt: null };
    out = { ...out, proxy: { ...stale }, web: { ...stale } };
  }
  if (next.instances.join(',') !== prev.instances.join(',')) {
    out = { ...out, instances: [] };
  }
  return out;
}