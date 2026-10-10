/**
 * 控制面板 v1：同进程 node:http，零框架零依赖，只绑 127.0.0.1。
 * 只读写 DB（业务进程每轮查库，改库即生效）；启动失败不影响主流程（装配处兜底）。
 * 扫码登录路由仅在装配处注入 auth dep 时挂载；cookie 值不出现在任何响应/日志里。
 */
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { makeLogger } from '../logger.js';
import type { Db } from '../core/db.js';
import { splitCsvText } from '../core/csv.js';
import { HttpError, parseUid, readJsonBody, sendJson, type XTestRequest } from './http-util.js';
import { scheduleInfo } from './schedule.js';
import { handleMcp } from '../mcp/handler.js';
import { toolDefByName } from '../mcp/tools.js';
import { PANEL_TOOL_CTX, runToolTracked, type ToolFailure, type ToolResult } from '../mcp/run-tool.js';
import { WEBUI_ASSETS } from './webui-assets.gen.js';
import { cookieHeader, fetchSelf, loadCookies, saveCookies, type SelfInfo } from '../sources/bili/auth.js';
import { generateQrcode, pollQrcode } from '../sources/bili/qrcode.js';
import type { WeiboResolver } from '../sources/weibo/resolve.js';
import { isValidWeiboUid, normalizeWeiboNick, normalizeWeiboUid } from '../core/weibo-accounts.js';
import {
  exchangeCookies as exchangeWeiboCookies, generateQrcode as generateWeiboQrcode,
  pollQrcode as pollWeiboQrcode,
} from '../sources/weibo/qrcode.js';
import {
  fetchWeiboSelf, loadWeiboCookies, saveWeiboCookies, weiboCookieHeader, type WeiboSelfInfo,
} from '../sources/weibo/auth.js';
import type { LlmProviderConfig } from '../config/schema.js';
import { deriveRoutes, getChatProvider, isLlmEnabled, type FetchLike, type LlmRouter } from '../analysis/providers.js';
import { isListenEnabled, listenReadyFor, listenSetting, type ListenFeature } from '../core/listen.js';
import {
  getRuntimeConfig,
} from '../core/runtime-config.js';
import { isPushEnabled } from '../core/push.js';
import type { XConfig } from '../core/x-config.js';
import type { NapcatConfig, ProbeResult } from '../notify/napcat.js';
import { getNapcatAlertQq } from '../notify/napcat.js';
import type { UndoResult, UndoStore } from '../core/undo.js';
import { adminScope } from '../core/undo.js';
import { undoChangeInfo, undoToolTitle } from './undo-view.js';
import type { ChatStore } from '../core/chat-store.js';
import { getChatWriteMode } from '../agent/system-prompt.js';
import { chatBlockedReason, runAgentTurn } from '../agent/loop.js';
import { toolCallView, type ToolCallView } from '../agent/tool-view.js';
import type { ToolCall } from '../analysis/providers.js';

const log = makeLogger('panel');

/** X 账号存在性校验结果：`kind` 决定面板怎么处理（not-found 拒绝 / link 照收并提示）；
 *  name 是 og:title 抠出的显示名——面板添加账号时顺手种进 nickname（平台事实不收手填） */
export interface XAccountVerify {
  checked: boolean;
  ok: boolean;
  kind: 'ok' | 'not-found' | 'link';
  message: string;
  name?: string | null;
}

export interface PlatformStatus {
  key: 'bili' | 'weibo';
  name: string;
  state: 'ok' | 'expired' | 'imported' | 'none' | 'reserved';
  mid?: string | null;
}

/** 系统状态：由装配处（index.ts）注入回调，面板只展示 */
export interface PanelStatus {
  /** 进程启动时间（秒级时间戳），前端算 uptime */
  startedAt: number;
  notifiers: string[];
  watchedCount: number;
  liveCount: number;
  platforms: PlatformStatus[];
}

export interface PanelDeps {
  db: Db;
  status: () => PanelStatus;
  /** 微博昵称→UID 解析器；不注入时 PUT 带 weiboNick 一律 400 */
  weiboResolver?: WeiboResolver;
  /** 扫码登录支持；不注入则 /api/auth/bili/* 一律 404 */
  auth?: {
    cookiePath: string;
    /** 新 cookie 落盘后的热重启回调（参数是拼好的 Cookie 头，绝不进日志） */
    onCookiesSaved: (cookieHeader: string) => void;
    /** 注入点供测试；缺省用真实 passport 客户端 */
    qrcode?: { generateQrcode: typeof generateQrcode; pollQrcode: typeof pollQrcode };
    /** 注入点供测试；confirmed 后用新 cookie 查一次 nav 拿 mid */
    selfFetcher?: (cookie: string) => Promise<SelfInfo>;
  };
  /** 微博扫码登录支持；不注入则 /api/auth/weibo/* 一律 404 */
  weiboAuth?: {
    cookiePath: string;
    /** 新 cookie 落盘后的热重启回调（参数是拼好的 Cookie 头，绝不进日志） */
    onCookiesSaved: (cookieHeader: string) => void;
    /** 注入点供测试；缺省用真实 passport v2 客户端 */
    qrcode?: {
      generateQrcode: typeof generateWeiboQrcode;
      pollQrcode: typeof pollWeiboQrcode;
      exchangeCookies: typeof exchangeWeiboCookies;
    };
    /** 注入点供测试；confirmed 后用新 cookie 查一次登录态拿 uid */
    selfFetcher?: (cookie: string) => Promise<WeiboSelfInfo>;
  };
  /**
   * LLM provider 展示与 key 管理；不注入则 /api/llm* 一律 404。
   * key 在本机面板明文回显/编辑（用户决策 2026-08-06，只绑 127.0.0.1）；key 不进日志。
   */
  llm?: {
    /** 注入后 GET /api/llm 带运行状态；PUT key 后 router.refreshKeys() 热更新 */
    router?: LlmRouter;
    /** provider 名单管理（settings 表是唯一信源）；不注入则 providers CRUD 404 */
    store?: {
      list(): LlmProviderConfig[];
      save(providers: LlmProviderConfig[]): void;
    };
    /** store.save 后调用：装配处重建 router，名单改动热生效 */
    onProvidersChanged?: () => void;
  };
  /**
   * 监听功能开关（面板「监听」卡片）；不注入则 /api/listen* 一律 404。
   * 动态需 B站登录、微博需微博登录，未登录默认关、登录成功自动开、手动设置为准。
   */
  listen?: {
    /** 运行前提（联动开关默认值用）：bili=动态、weibo=微博、twitter=代理已配置（X 无登录态） */
    login: () => { bili: boolean; weibo: boolean; twitter: boolean };
    /** 面板改开关后回调：装配处热启停对应源 */
    onChanged: () => void;
  };
  /**
   * 高级设置（运行时参数，settings 唯一信源）：保存后回调装配处做热生效
   *（重启间隔变化的源 / 重建 llm router / 热切换通知通道）。不注入则保存不触发热生效。
   */
  advanced?: {
    onChanged: () => void;
  };
  /**
   * X / 推特（独立分页，/api/x*）：连接设置 + 连通性测试。
   * 状态快照由装配处持有（P0 尚无源，先只记「上次测试结果」，绝不在 GET 里打网络）；
   * 不注入则 /api/x* 一律 404。X 与开播那套设置完全分开，互不影响。
   */
  x?: {
    /** 当前配置 + 状态快照 */
    info: () => unknown;
    /** 保存连接设置（已校验）；返回最新配置 */
    save: (patch: Partial<XConfig>) => unknown;
    /** 连通性测试；允许传入尚未保存的覆盖值（先测后存） */
    test: (req: XTestRequest) => Promise<unknown>;
    /**
     * X 账号存在性校验（走免登录探测）。链路不通时也如实返回 kind='link'——
     * 由路由决定「账号不存在」拒绝、「链路不通」照收并回报。
     */
    verify: (screenName: string) => Promise<XAccountVerify>;
    /** 保存后回调：装配处热生效 */
    onChanged: () => void;
    /** 添加账号后的即时首拉钩子（不等下个轮询周期、不在全量轮里排队）；不注入则跳过 */
    kickAccount?: (screenName: string) => Promise<void>;
  };
  /**
   * 微博（图文分页的第二个来源）：源运行状态快照 + 独立名单的增删改。
   * 与 X 的分工差异：微博的连接前提是**登录态**（没有代理/实例那套设置，间隔走 /api/advanced），
   * 所以这里只有状态快照 + 账号 CRUD。不注入则 /api/weibo* 一律 404。
   */
  weibo?: {
    /** 当前配置 + 运行状态快照（GET 只读，绝不打网络） */
    info: () => unknown;
    /** 名单/账号变化后回调：装配处热重启源（新增账号要立刻抓） */
    onChanged: () => void;
    /** 添加账号后的即时首拉钩子（不等下个轮询周期、不在全量轮里排队）；不注入则跳过 */
    kickAccount?: (uid: string) => Promise<void>;
  };
  /** 微博头像本地缓存目录（/api/weibo-avatar 按文件名读）；不注入则一律 404 */
  weiboAvatars?: {
    dir: string;
  };
  /** B站动态账号头像本地缓存目录（/api/bili-avatar 按文件名读）；不注入则一律 404 */
  biliAvatars?: {
    dir: string;
  };
  /** 微博帖子图本地缓存目录（/api/weibo-image 按 URL md5 落盘反代）；不注入则不落盘、纯反代 */
  weiboImages?: {
    dir: string;
    /** 反代 fetch 注入点（测试用）；缺省用全局 fetch */
    fetchImpl?: FetchLike;
  };
  /** 动态源即时首拉钩子：添加 B站动态账号后调用（不等下个轮询周期）；不注入则跳过 */
  biliFeed?: {
    kickAccount: (uid: string) => Promise<void>;
  };
  /** 关键帧缓存目录（/api/snapshot 按鼠标时间点取最近帧）；不注入则 /api/snapshot 一律 404 */
  snapshots?: {
    dir: string;
  };
  /** X 头像本地缓存目录（/api/x-avatar 按文件名读）；不注入则 /api/x-avatar 一律 404 */
  xAvatars?: {
    dir: string;
  };
  /** 测试推送（假消息走完整推送链路）；不注入则 POST /api/push/test 一律 404 */
  testPush?: () => Promise<{ total: number; succeeded: number }>;
  /** 写操作快照与撤销（P0 地基，core/undo.ts）；历史查询端点消费它 */
  undo?: UndoStore;
  /**
   * 撤销执行入口（P0 判据 6）：撤该栈顶（缺省 = admin 全局栈）并**触发热生效回调**。
   * 映射在装配根（回调闭包都在 index.ts），本层只转发——故撤销与面板手写等价：
   * 撤 runtime config → reconcileRuntime、撤 listen → reconcileListen、撤 provider/key → 重建 router、
   * 撤渠道 → 重建通知通道。不注入则 POST /api/undo 一律 404。
   */
  undoLast?: (scope?: string) => UndoResult;
  /** agent 会话存储（core/chat-store.ts）：面板单会话（scope = adminScope），/api/chat* 消费 */
  chat?: ChatStore;
  /**
   * OneBot 11 事件接收（P3 NapCat 直连）：`POST /onebot` 的唯一消费者。
   * 事件形状校验、触发判定、限流、渠道映射、回执全在 `src/qqbot/`；路由只做 JSON 解析与响应。
   * 不注入则 `/onebot` 404（面板没在跑 / `qqbot_enabled` 关时本入口本来就不装配）。
   */
  qqbot?: {
    handleEvent: (event: unknown) => Promise<{ action: string; reason?: string }>;
  };
  /**
   * 头像代理 fetch 注入点（测试用）；缺省用全局 fetch。/api/avatar 恒挂载，
   * 按 uid 反代主播头像以规避 B站图床无 CORS 导致的画布污染（颜色条取平均色用）。
   */
  avatar?: { fetchImpl?: FetchLike };
  /**
   * NapCat 托管（面板 NapCat 卡片）；不注入则 /api/napcat* 一律 404。
   * 配置事实来源是 settings 表（唯一信源，config.json 仅首次启动种子导入），
   * 保存在装配处闭包里热生效。
   */
  napcat?: {
    /** 生效配置（dir 已解析默认值） */
    effective: () => NapcatConfig;
    /** 运行平台（前端据它区分 Windows 计划任务 / macOS open 拉起） */
    platform: NodeJS.Platform;
    source: () => {
      enabled: 'panel' | 'config';
      autorestart: 'panel' | 'config';
      dir: 'panel' | 'config' | 'default';
      uin: 'panel' | 'config';
    };
    /** 保存配置；「失活自动拉起」开 = 建拉起任务（失败抛中文错不落开关）、关 = 移除任务 */
    save: (patch: {
      enabled?: boolean;
      autorestart?: boolean;
      dir?: string;
      uin?: string;
      alertQq?: string;
    }) => Promise<void>;
    /**
     * 实时状态：发现的端点 + 三态探测 + 拉起能力是否就绪。
     * configReady = NapCat 自己是否跑通过（<dir>/config 存在 = 至少成功启动过一次；
     * false 时前端禁用拉起/自动拉起并提示先手动跑通，不承诺做不到的事）
     */
    state: () => Promise<{ endpoint: string | null; probe: ProbeResult | null; taskRegistered: boolean; configReady: boolean }>;
    /** 手动拉起（双平台）；失败抛中文错 */
    launch: () => Promise<void>;
  };
}

export function createPanelServer(deps: PanelDeps): http.Server {
  // 微博扫码会话：generate 存 qrid，poll 凭它查状态（单人面板，无需多会话）
  const weiboSession = { qrid: null as string | null };
  return http.createServer((req, res) => {
    handle(deps, weiboSession, req, res).catch((e: unknown) => {
      // MCP 走 SDK 自己写响应，出错时可能已写出部分响应，此时只记日志
      if (res.headersSent) {
        log.error('面板请求处理失败（响应已发出）', e);
        return;
      }
      if (e instanceof HttpError) {
        sendJson(res, e.status, { error: e.message });
      } else {
        log.error('面板请求处理失败', e);
        sendJson(res, 500, { error: '服务器内部错误' });
      }
    });
  });
}

// ---- REST 写路由收敛出口（P0 判据 3：面板写一律经 runTool 进注册表，路由层只做状态码/形状映射）----
// 收敛纪律：① 挂载门（dep 不注入则 404）不变；② 响应形状/状态码/错误文案逐字不变（判据 5），
// 201 vs 200、`{id}` vs `{ok:true}`、webui 的键名（provider/value）差异都在这一层映射；
// ③ 业务校验全在注册表 handler（与 MCP 同一份），路由层不再重复。

/** body 必须是 JSON 对象（与 http-util asObject 同一句文案） */
function asBodyObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, '请求体必须是 JSON 对象');
  }
  return body as Record<string, unknown>;
}

interface CallToolOpts {
  /** 路径参数（uid/id/name/feature），并入 args；body 里出现同名单元按未知字段拒（老 parse 口径） */
  pathArgs?: Record<string, unknown>;
  /** 成功状态码（缺省 200；POST 建资源的老契约是 201） */
  status?: number;
  /**
   * 老路由的 parse 函数带 rejectUnknownKeys 的传 true：按工具 schema 键拒绝未知字段。
   * （runTool 的 zod 层对未知键是**剥离**而非拒绝——剥离适合 LLM 入口，面板要尽早暴露拼写错误）
   */
  rejectUnknown?: boolean;
  /** 响应形状映射（缺省透传工具结果；缺结果时回 {ok:true}） */
  map?: (data: Record<string, unknown>) => unknown;
}

/** 调注册表工具（经 runToolTracked：zod 校验 + 审计 + 写快照），不做响应映射 */
async function runPanelTool(
  deps: PanelDeps,
  name: string,
  body: Record<string, unknown>,
  opts: CallToolOpts = {},
): Promise<ToolResult> {
  const def = toolDefByName(name);
  if (!def) throw new Error(`注册表缺少工具: ${name}`); // 装配错误，走 500
  if (opts.rejectUnknown) {
    const allowed = new Set(Object.keys(def.schema));
    for (const k of Object.keys(body)) {
      if (!allowed.has(k) || (opts.pathArgs !== undefined && k in opts.pathArgs)) {
        throw new HttpError(400, `未知字段: ${k}`);
      }
    }
  }
  return runToolTracked(deps, def, { ...body, ...opts.pathArgs }, PANEL_TOOL_CTX, 'panel');
}

/** 失败侧转 HTTP：HttpError 状态透传；无状态码的内部错误走老 500 口径（细节进日志不进响应） */
function throwToolFailure(r: ToolFailure): never {
  if (r.status !== undefined) throw new HttpError(r.status, r.error);
  throw new Error(r.error);
}

/** 收敛后的写路由统一出口：发响应并返回发出的 payload（路由层后续编排如 kickAccount 用） */
async function callTool(
  deps: PanelDeps,
  res: http.ServerResponse,
  name: string,
  body: Record<string, unknown>,
  opts: CallToolOpts = {},
): Promise<unknown> {
  const r = await runPanelTool(deps, name, body, opts);
  if (!r.ok) throwToolFailure(r);
  const payload = opts.map ? opts.map(r.data as Record<string, unknown>) : (r.data ?? { ok: true });
  sendJson(res, opts.status ?? 200, payload);
  return payload;
}

async function handle(
  deps: PanelDeps,
  weiboSession: { qrid: string | null },
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const { db } = deps;
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  // 对话端点共用（也让下面对 deps.chat 的窄化不受中间的函数调用影响）
  const chat = deps.chat;

  // ---- 静态资产（构建期内嵌快照，运行时绝不读磁盘）：纯 map 查键，无路径拼接 ----
  // 命中则直接返回对应 content-type + no-store；未命中（含 /api/* 与穿越尝试）自然落到下面的 API/404。
  const asset = WEBUI_ASSETS[path];
  if (method === 'GET' && asset) {
    res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
    res.end(asset.body);
    return;
  }
  if (method === 'GET' && path === '/api/status') {
    sendJson(res, 200, deps.status());
    return;
  }
  // ---- 监听功能开关（listen dep 存在才挂）：动态（B站）/ 微博 / 推特（X 独立分页）----
  if (deps.listen && method === 'GET' && path === '/api/listen') {
    sendJson(res, 200, listenInfo(deps));
    return;
  }
  const lm = path.match(/^\/api\/listen\/(dynamic|weibo|twitter)$/);
  if (deps.listen && lm && method === 'PUT') {
    await callTool(deps, res, 'set_listen', asBodyObject(await readJsonBody(req)), {
      pathArgs: { feature: lm[1]! },
    });
    return;
  }

  // ---- NapCat 托管（napcat dep 存在才挂）：配置（settings 覆盖 > config）+ 状态 + 手动操作 ----
  if (deps.napcat && method === 'GET' && path === '/api/napcat') {
    const st = await deps.napcat.state();
    sendJson(res, 200, { ...deps.napcat.effective(), platform: deps.napcat.platform, alertQq: getNapcatAlertQq(db), source: deps.napcat.source(), ...st });
    return;
  }
  if (deps.napcat && method === 'PUT' && path === '/api/napcat') {
    const b = (await readJsonBody(req)) as Record<string, unknown>;
    const patch: { enabled?: boolean; autorestart?: boolean; dir?: string; uin?: string; alertQq?: string } = {};
    if (b.enabled !== undefined) {
      if (typeof b.enabled !== 'boolean') throw new HttpError(400, 'enabled 必须是布尔值');
      patch.enabled = b.enabled;
    }
    if (b.autorestart !== undefined) {
      if (typeof b.autorestart !== 'boolean') throw new HttpError(400, 'autorestart 必须是布尔值');
      patch.autorestart = b.autorestart;
    }
    if (b.dir !== undefined) {
      if (typeof b.dir !== 'string') throw new HttpError(400, '路径必须是字符串');
      patch.dir = b.dir.trim();
    }
    if (b.uin !== undefined) {
      if (typeof b.uin !== 'string') throw new HttpError(400, 'QQ号必须是字符串');
      const uin = b.uin.trim();
      if (uin !== '' && !/^\d+$/.test(uin)) throw new HttpError(400, 'QQ号必须是纯数字');
      patch.uin = uin;
    }
    if (b.alertQq !== undefined) {
      if (typeof b.alertQq !== 'string') throw new HttpError(400, '告警 QQ 必须是字符串');
      const alertQq = b.alertQq.trim();
      if (alertQq !== '' && !/^\d+$/.test(alertQq)) throw new HttpError(400, '告警 QQ 必须是纯数字');
      patch.alertQq = alertQq;
    }
    try {
      await deps.napcat.save(patch);
    } catch (e) {
      // 自动拉起建任务失败（UAC 被拒 / 未填路径）等业务错，统一 400 透传
      throw new HttpError(400, (e as Error).message);
    }
    sendJson(res, 200, { ok: true, ...deps.napcat.effective(), alertQq: getNapcatAlertQq(db) });
    return;
  }
  // ---- 高级设置（运行时参数；settings 唯一信源，无 dep 也挂载，onChanged 缺省则只落库） ----
  if (method === 'GET' && path === '/api/advanced') {
    sendJson(res, 200, getRuntimeConfig(db));
    return;
  }
  if (method === 'PUT' && path === '/api/advanced') {
    await callTool(deps, res, 'update_runtime_config', asBodyObject(await readJsonBody(req)));
    return;
  }

  // ---- X / 推特（独立分页；x dep 存在才挂）----
  // GET 只回快照不打网络：面板会周期轮询这张卡片，探测必须由「测试」按钮显式触发。
  if (deps.x && method === 'GET' && path === '/api/x') {
    sendJson(res, 200, deps.x.info());
    return;
  }
  if (deps.x && method === 'PUT' && path === '/api/x') {
    await callTool(deps, res, 'update_x_config', asBodyObject(await readJsonBody(req)), { rejectUnknown: true });
    return;
  }
  if (deps.x && method === 'POST' && path === '/api/x/test') {
    await callTool(deps, res, 'test_x_connection', asBodyObject(await readJsonBody(req)), { rejectUnknown: true });
    return;
  }

  // ---- X 关注账号（独立名单：不要求对应 B站主播，biliUid 只是可选关联）----
  if (deps.x && method === 'GET' && path === '/api/x/accounts') {
    sendJson(res, 200, { accounts: xAccountList(db) });
    return;
  }
  if (deps.x && method === 'POST' && path === '/api/x/accounts') {
    // 存在性校验与昵称种入已并入 upsert_x_account（与面板同语义）；verify 结果随响应回报
    const payload = (await callTool(deps, res, 'upsert_x_account', asBodyObject(await readJsonBody(req)), {
      rejectUnknown: true,
      map: (d) => ({ account: xAccountInfo(db, Number(d.id)), verify: d.verify }),
    })) as { account: { screenName: string } };
    // 即时首拉：fire-and-forget，失败只进日志（源内有自己的失败纪律），不挡响应
    if (deps.x.kickAccount) void deps.x.kickAccount(payload.account.screenName).catch(() => {});
    return;
  }
  const xa = path.match(/^\/api\/x\/accounts\/(\d+)$/);
  if (deps.x && xa && method === 'PUT') {
    await callTool(deps, res, 'upsert_x_account', asBodyObject(await readJsonBody(req)), {
      pathArgs: { id: Number(xa[1]) },
      rejectUnknown: true,
      map: (d) => ({ account: xAccountInfo(db, Number(d.id)) }),
    });
    return;
  }
  if (deps.x && xa && method === 'DELETE') {
    await callTool(deps, res, 'delete_x_account', {}, { pathArgs: { id: Number(xa[1]) } });
    return;
  }

  // ---- 微博独立名单（图文分页第二个来源：不要求对应 B站主播，biliUid 只是可选关联）----
  if (deps.weibo && method === 'GET' && path === '/api/weibo') {
    sendJson(res, 200, deps.weibo.info());
    return;
  }
  // 昵称 ↔ uid 即时互查（添加浮窗「填一个解析另一个」用；与新建时补 uid 同一条匿名解析链）
  if (deps.weibo && method === 'GET' && path === '/api/weibo/resolve') {
    if (!deps.weiboResolver) throw new HttpError(400, '微博解析不可用');
    const nick = normalizeWeiboNick(url.searchParams.get('nick') ?? '');
    const uidRaw = (url.searchParams.get('uid') ?? '').trim();
    try {
      if (nick) {
        const uid = await deps.weiboResolver.resolveUid(nick);
        if (!uid) throw new HttpError(404, `微博上找不到这个昵称：${nick}`);
        sendJson(res, 200, { uid, nickname: nick });
        return;
      }
      if (uidRaw) {
        const uid = normalizeWeiboUid(uidRaw);
        if (!isValidWeiboUid(uid)) throw new HttpError(400, '微博 uid 必须是数字');
        const nickname = await deps.weiboResolver.resolveNick(uid);
        if (!nickname) throw new HttpError(404, `微博上找不到这个 uid：${uid}`);
        sendJson(res, 200, { uid, nickname });
        return;
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, `微博解析失败：${e instanceof Error ? e.message : String(e)}`);
    }
    throw new HttpError(400, 'nick 与 uid 至少给一个');
  }
  if (deps.weibo && method === 'GET' && path === '/api/weibo/accounts') {
    sendJson(res, 200, { accounts: weiboAccountList(db) });
    return;
  }
  if (deps.weibo && method === 'POST' && path === '/api/weibo/accounts') {
    // 只填昵称时走匿名访客解析链补 uid（与主播详情填「微博昵称」同一条链）——已并入 upsert_weibo_account
    const payload = (await callTool(deps, res, 'upsert_weibo_account', asBodyObject(await readJsonBody(req)), {
      rejectUnknown: true,
      map: (d) => ({ account: weiboAccountInfo(db, Number(d.id)) }),
    })) as { account: { uid: string } };
    // 即时首拉：fire-and-forget，失败只进日志（源内有自己的失败纪律），不挡响应
    if (deps.weibo.kickAccount) void deps.weibo.kickAccount(payload.account.uid).catch(() => {});
    return;
  }
  const wa = path.match(/^\/api\/weibo\/accounts\/(\d+)$/);
  if (deps.weibo && wa && method === 'PUT') {
    await callTool(deps, res, 'upsert_weibo_account', asBodyObject(await readJsonBody(req)), {
      pathArgs: { id: Number(wa[1]) },
      rejectUnknown: true,
      map: (d) => ({ account: weiboAccountInfo(db, Number(d.id)) }),
    });
    return;
  }
  if (deps.weibo && wa && method === 'DELETE') {
    await callTool(deps, res, 'delete_weibo_account', {}, { pathArgs: { id: Number(wa[1]) } });
    return;
  }

  // ---- B站动态账号名单（图文分页第三个来源：纯 DB CRUD 恒挂载，无 dep 门）----
  // 只管推送选用（ruleIds）；抓取轮询对象由动态源每轮自并监听主播 ∪ bili_accounts，
  // 名单变化下一轮自动生效；添加后额外经 biliFeed.kickAccount 即时首拉（不等下个周期）。
  if (method === 'GET' && path === '/api/bili/accounts') {
    sendJson(res, 200, { accounts: biliAccountList(db) });
    return;
  }
  if (method === 'POST' && path === '/api/bili/accounts') {
    const payload = (await callTool(deps, res, 'upsert_bili_account', asBodyObject(await readJsonBody(req)), {
      rejectUnknown: true,
      map: (d) => ({ account: biliAccountInfo(db, Number(d.id)) }),
    })) as { account: { uid: string } };
    // 即时首拉：fire-and-forget，失败只进日志（源内有自己的失败纪律），不挡响应
    if (deps.biliFeed) void deps.biliFeed.kickAccount(payload.account.uid).catch(() => {});
    return;
  }
  const ba = path.match(/^\/api\/bili\/accounts\/(\d+)$/);
  if (ba && method === 'PUT') {
    await callTool(deps, res, 'upsert_bili_account', asBodyObject(await readJsonBody(req)), {
      pathArgs: { id: Number(ba[1]) },
      rejectUnknown: true,
      map: (d) => ({ account: biliAccountInfo(db, Number(d.id)) }),
    });
    return;
  }
  if (ba && method === 'DELETE') {
    await callTool(deps, res, 'delete_bili_account', {}, { pathArgs: { id: Number(ba[1]) } });
    return;
  }

  // ---- 缓存关键帧（snapshots dep 存在才挂）：取距 ts 最近的一帧，hover 缩略图用 ----
  if (method === 'GET' && path === '/api/snapshot') {
    if (!deps.snapshots) throw new HttpError(404, '未装配关键帧缓存目录');
    const room = url.searchParams.get('room') ?? '';
    const lt = Number(url.searchParams.get('lt'));
    const ts = Number(url.searchParams.get('ts'));
    if (!/^\d+$/.test(room) || !Number.isInteger(lt) || !Number.isInteger(ts) || lt <= 0 || ts <= 0) {
      throw new HttpError(400, 'room/lt/ts 必须是正整数');
    }
    const row = deps.db.nearestSnapshot(room, lt, ts);
    if (!row) throw new HttpError(404, '该场次没有缓存关键帧');
    // 路径安全：库里的 path resolve 后必须落在注入的缓存目录内（防库被写脏后路径穿越）。
    // path 是相对 keyframe 目录的相对路径，分隔符恒为正斜杠（keyframe.ts 落盘形式）。
    // 历史库残留反斜杠相对/绝对路径，/ 归一化后统一按相对解析（反斜杠是 Windows join 产物，
    // macOS 下是普通字符；残留绝对路径经归一化后天然不落在受信目录内 → 404，由迁移命令收敛）。
    const root = resolve(deps.snapshots.dir);
    const file = resolve(root, row.path.replace(/\\/g, '/'));
    if (file !== root && !file.startsWith(root + sep)) throw new HttpError(404, '缓存文件不在受信目录内');
    let data: Buffer;
    try {
      data = readFileSync(file);
    } catch {
      throw new HttpError(404, '缓存文件读不到');
    }
    res.writeHead(200, {
      // nearest 会随新帧落地而变化，禁缓存
      'content-type': file.endsWith('.png') ? 'image/png' : 'image/jpeg',
      'cache-control': 'no-store',
    });
    res.end(data);
    return;
  }

  // ---- 头像代理（恒挂载）：按 uid 反代主播头像，规避 B站图床无 CORS 的画布污染 ----
  if (method === 'GET' && path === '/api/avatar') {
    await sendAvatar(deps, url, res);
    return;
  }

  // ---- X 头像本地缓存（xAvatars dep 存在才挂）：按文件名读 cache/x-avatars ----
  if (method === 'GET' && path === '/api/x-avatar') {
    if (!deps.xAvatars) throw new HttpError(404, '未装配 X 头像缓存目录');
    const name = url.searchParams.get('file') ?? '';
    // 文件名就是 md5+扩展名（avatar.ts 落盘形式），白名单校验天然防路径穿越
    if (!/^[a-f0-9]{32}\.(jpg|png)$/.test(name)) throw new HttpError(400, 'file 参数不对');
    let data: Buffer;
    try {
      data = readFileSync(join(deps.xAvatars.dir, name));
    } catch {
      throw new HttpError(404, '头像缓存不存在');
    }
    res.writeHead(200, {
      'content-type': name.endsWith('.png') ? 'image/png' : 'image/jpeg',
      // 文件名随内容变（md5），长缓存安全
      'cache-control': 'max-age=86400',
    });
    res.end(data);
    return;
  }

  // ---- 微博头像本地缓存（weiboAvatars dep 存在才挂）：按文件名读 cache/weibo-avatars ----
  if (method === 'GET' && path === '/api/weibo-avatar') {
    if (!deps.weiboAvatars) throw new HttpError(404, '未装配微博头像缓存目录');
    const name = url.searchParams.get('file') ?? '';
    // 文件名就是 md5+扩展名（weibo/avatar.ts 落盘形式），白名单校验天然防路径穿越
    if (!/^[a-f0-9]{32}\.(jpg|png)$/.test(name)) throw new HttpError(400, 'file 参数不对');
    let data: Buffer;
    try {
      data = readFileSync(join(deps.weiboAvatars.dir, name));
    } catch {
      throw new HttpError(404, '头像缓存不存在');
    }
    res.writeHead(200, {
      'content-type': name.endsWith('.png') ? 'image/png' : 'image/jpeg',
      'cache-control': 'max-age=86400',
    });
    res.end(data);
    return;
  }

  // ---- 微博帖子图反代（恒挂载）：sinaimg 对 no-referrer 也 403（2026-09-20 实测），
  // 浏览器热链不出，必须服务端带 weibo Referer 拉；weiboImages dep 存在时按 URL md5 落盘缓存 ----
  if (method === 'GET' && path === '/api/weibo-image') {
    await sendWeiboImage(deps, url, res);
    return;
  }

  // ---- B站动态账号头像本地缓存（biliAvatars dep 存在才挂）：按文件名读 cache/bili-avatars ----
  if (method === 'GET' && path === '/api/bili-avatar') {
    if (!deps.biliAvatars) throw new HttpError(404, '未装配 B站头像缓存目录');
    const name = url.searchParams.get('file') ?? '';
    // 文件名就是 md5+扩展名（bili/avatar.ts 落盘形式），白名单校验天然防路径穿越
    if (!/^[a-f0-9]{32}\.(jpg|png)$/.test(name)) throw new HttpError(400, 'file 参数不对');
    let data: Buffer;
    try {
      data = readFileSync(join(deps.biliAvatars.dir, name));
    } catch {
      throw new HttpError(404, '头像缓存不存在');
    }
    res.writeHead(200, {
      'content-type': name.endsWith('.png') ? 'image/png' : 'image/jpeg',
      'cache-control': 'max-age=86400',
    });
    res.end(data);
    return;
  }

  if (deps.napcat && method === 'POST' && path === '/api/napcat/launch') {
    try {
      await deps.napcat.launch();
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === 'GET' && path === '/api/streamers') {
    sendJson(res, 200, { streamers: enrichedStreamers(db) });
    return;
  }
  if (method === 'GET' && path === '/api/follows') {
    const watching = new Map(db.listStreamers().map((s) => [s.uid, s.watch]));
    const follows = db.listFollows(true).map((f) => ({
      uid: f.uid,
      uname: f.uname,
      face: f.face,
      watched: watching.get(f.uid) === true,
    }));
    sendJson(res, 200, { follows });
    return;
  }
  if (method === 'GET' && path === '/api/channels') {
    sendJson(res, 200, { channels: db.listPushChannels() });
    return;
  }
  if (method === 'POST' && path === '/api/channels') {
    await callTool(deps, res, 'upsert_channel', asBodyObject(await readJsonBody(req)), {
      status: 201, rejectUnknown: true,
    });
    return;
  }
  // 渠道拖拽排序：ids 是现有渠道的全排列（在 :id 通配之前匹配）
  if (method === 'PUT' && path === '/api/channels/order') {
    await callTool(deps, res, 'reorder_channels', asBodyObject(await readJsonBody(req)));
    return;
  }
  // 推送总开关（面板推送卡右上角；settings.push_enabled，缺省开）
  if (method === 'GET' && path === '/api/push') {
    sendJson(res, 200, { enabled: isPushEnabled(db) });
    return;
  }
  if (method === 'PUT' && path === '/api/push/enabled') {
    await callTool(deps, res, 'set_push_enabled', asBodyObject(await readJsonBody(req)));
    return;
  }
  // 测试推送：假消息走完整链路（面板「推送设置」弹窗里触发）
  if (deps.testPush && method === 'POST' && path === '/api/push/test') {
    await callTool(deps, res, 'test_push', {});
    return;
  }
  // ---- 时间表（过往直播统计；GET-only，无 dep）----
  if (method === 'GET' && path === '/api/schedule') {
    sendJson(res, 200, scheduleInfo(db, url.searchParams.get('from'), url.searchParams.get('to')));
    return;
  }
  // ---- LLM provider 与 key 管理（llm dep 存在才挂；key 本机面板明文回显/编辑）----
  if (deps.llm && method === 'GET' && path === '/api/llm') {
    sendJson(res, 200, llmInfo(deps));
    return;
  }
  if (deps.llm && method === 'PUT' && path === '/api/llm/keys') {
    const body = asBodyObject(await readJsonBody(req));
    // REST 入参键是 provider/value（webui 契约），工具参数是 name/value；响应补 key 状态回显
    await callTool(deps, res, 'set_llm_key', { name: body.provider, value: body.value }, {
      map: (d) => {
        const provider = (deps.llm?.store?.list() ?? []).find((p) => p.name === d.provider);
        return {
          ...d,
          key: provider ? llmKeySource(db, provider) : { source: 'unset', count: 0, value: null },
        };
      },
    });
    return;
  }
  if (deps.llm && method === 'PUT' && path === '/api/llm/enabled') {
    await callTool(deps, res, 'set_llm_enabled', asBodyObject(await readJsonBody(req)));
    return;
  }
  if (deps.llm?.store && method === 'POST' && path === '/api/llm/providers') {
    const body = asBodyObject(await readJsonBody(req));
    // 裁决（P0 收敛）：REST 保持「重名 400」（webui 契约）；工具 upsert_llm_provider 保持按名 upsert（MCP 契约）
    if (typeof body.name === 'string' && deps.llm.store.list().some((p) => p.name === body.name)) {
      throw new HttpError(400, `provider name 重复: ${body.name}`);
    }
    await callTool(deps, res, 'upsert_llm_provider', body, { status: 201 });
    return;
  }
  // 排序路由必须在 :name 通配之前匹配，否则 'order' 会被当成 provider 名
  if (deps.llm?.store && method === 'PUT' && path === '/api/llm/providers/order') {
    await callTool(deps, res, 'reorder_llm_providers', asBodyObject(await readJsonBody(req)));
    return;
  }
  const lpt = path.match(/^\/api\/llm\/providers\/([^/]+)\/test$/);
  if (deps.llm?.router && lpt && method === 'POST') {
    const r = await runPanelTool(deps, 'test_llm_provider', {}, { pathArgs: { name: decodeURIComponent(lpt[1]!) } });
    if (r.ok) {
      sendJson(res, 200, r.data);
      return;
    }
    // ping 失败的老契约形状：502 { ok:false, error }（不是 4xx 业务错；key 只在请求头，不进错误信息）
    if (r.status === 502) {
      sendJson(res, 502, { ok: false, error: r.error });
      return;
    }
    throwToolFailure(r);
  }
  const lpm = path.match(/^\/api\/llm\/providers\/([^/]+)$/);
  if (deps.llm?.store && lpm) {
    const name = decodeURIComponent(lpm[1]!);
    if (method === 'PUT') {
      // 404 预检（与 POST 重名同属一个裁决）：REST 按存在性区分 404/400，工具是按名 upsert
      if (!deps.llm.store.list().some((p) => p.name === name)) throw new HttpError(404, 'provider 不存在');
      await callTool(deps, res, 'upsert_llm_provider', asBodyObject(await readJsonBody(req)), { pathArgs: { name } });
      return;
    }
    if (method === 'DELETE') {
      await callTool(deps, res, 'delete_llm_provider', {}, { pathArgs: { name } });
      return;
    }
  }
  // ---- 分类规则（全局定义：LLM 提示词 + 确定性条件，归类结果入 verdicts）----
  if (method === 'GET' && path === '/api/categories') {
    sendJson(res, 200, { categories: db.listCategories() });
    return;
  }
  if (method === 'POST' && path === '/api/categories') {
    await callTool(deps, res, 'upsert_category', asBodyObject(await readJsonBody(req)), {
      status: 201, rejectUnknown: true,
    });
    return;
  }
  // 分类拖拽排序：ids 是现有分类的全排列（在 :id 通配之前匹配）
  if (method === 'PUT' && path === '/api/categories/order') {
    await callTool(deps, res, 'reorder_categories', asBodyObject(await readJsonBody(req)));
    return;
  }

  // ---- 推送规则 v2（全局：分类引用 + 生效主播集合 + 渠道）----
  if (method === 'GET' && path === '/api/rules') {
    const uidParam = url.searchParams.get('uid');
    const uid = uidParam === null ? null : parseUid(uidParam);
    const rules = db.listPushRules();
    // ?uid= 语义：对该主播生效的规则（uids 空 = 全部主播，含未来新增）
    sendJson(res, 200, {
      rules: uid === null ? rules : rules.filter((r) => r.uids.length === 0 || r.uids.includes(uid)),
    });
    return;
  }
  if (method === 'POST' && path === '/api/rules') {
    await callTool(deps, res, 'upsert_push_rule', asBodyObject(await readJsonBody(req)), {
      status: 201, rejectUnknown: true,
    });
    return;
  }
  // 规则拖拽排序：ids 是全部规则的全排列（在 :id 通配之前匹配）
  if (method === 'PUT' && path === '/api/rules/order') {
    await callTool(deps, res, 'reorder_push_rules', asBodyObject(await readJsonBody(req)));
    return;
  }

  // ---- 图文帖规则（X/推特；与推送规则平行的一张表，渠道共用设置页那份）----
  if (method === 'GET' && path === '/api/post-rules') {
    sendJson(res, 200, { rules: db.listPostRules() });
    return;
  }
  if (method === 'POST' && path === '/api/post-rules') {
    await callTool(deps, res, 'upsert_post_rule', asBodyObject(await readJsonBody(req)), {
      status: 201, rejectUnknown: true,
    });
    return;
  }
  // 拖拽排序（在 :id 通配之前匹配）
  if (method === 'PUT' && path === '/api/post-rules/order') {
    await callTool(deps, res, 'reorder_post_rules', asBodyObject(await readJsonBody(req)));
    return;
  }

  // ---- 扫码登录（auth dep 存在才挂）----
  if (deps.auth && method === 'POST' && path === '/api/auth/bili/qrcode') {
    const qr = deps.auth.qrcode ?? { generateQrcode, pollQrcode };
    sendJson(res, 200, await qr.generateQrcode());
    return;
  }
  if (deps.auth && method === 'GET' && path === '/api/auth/bili/qrcode/poll') {
    sendJson(res, 200, await pollQrcodeRoute(deps, url.searchParams.get('key')));
    return;
  }

  // ---- 微博扫码登录（weiboAuth dep 存在才挂）----
  if (deps.weiboAuth && method === 'POST' && path === '/api/auth/weibo/qrcode') {
    const qr = deps.weiboAuth.qrcode
      ?? { generateQrcode: generateWeiboQrcode, pollQrcode: pollWeiboQrcode, exchangeCookies: exchangeWeiboCookies };
    const info = await qr.generateQrcode();
    weiboSession.qrid = info.qrid;
    // image 是 png 直链，前端 <img src> 直接显示（不走内嵌二维码库）
    sendJson(res, 200, { image: info.image });
    return;
  }
  if (deps.weiboAuth && method === 'GET' && path === '/api/auth/weibo/qrcode/poll') {
    sendJson(res, 200, await pollWeiboQrcodeRoute(deps, weiboSession));
    return;
  }

  const sm = path.match(/^\/api\/streamers\/([^/]+?)(\/watch)?$/);
  if (sm) {
    const uid = parseUid(sm[1]);
    if (sm[2] && method === 'POST') {
      await callTool(deps, res, 'watch_streamer', {}, { pathArgs: { uid } });
      return;
    }
    if (!sm[2] && method === 'PUT') {
      await callTool(deps, res, 'set_streamer', asBodyObject(await readJsonBody(req)), {
        pathArgs: { uid },
        rejectUnknown: true,
      });
      return;
    }
  }

  const chm = path.match(/^\/api\/channels\/([^/]+)$/);
  if (chm) {
    const id = Number(parseUid(chm[1], 'id'));
    if (method === 'PUT') {
      // 联动校验（toast 改 onebot 必须补目标号）在工具 handler 里对合并后形状做
      await callTool(deps, res, 'upsert_channel', asBodyObject(await readJsonBody(req)), {
        pathArgs: { id }, rejectUnknown: true,
      });
      return;
    }
    if (method === 'DELETE') {
      await callTool(deps, res, 'delete_channel', {}, { pathArgs: { id } });
      return;
    }
  }

  const cam = path.match(/^\/api\/categories\/([^/]+)$/);
  if (cam) {
    const id = Number(parseUid(cam[1], 'id'));
    if (method === 'PUT') {
      // 条件校验（如把唯一的条件清空 → 400）在工具 handler 里对合并后形状做
      await callTool(deps, res, 'upsert_category', asBodyObject(await readJsonBody(req)), {
        pathArgs: { id }, rejectUnknown: true,
      });
      return;
    }
    if (method === 'DELETE') {
      // 级联停用引用它的推送规则（规则保留可恢复）+ 删除，已事务化（见 delete_category 工具）
      await callTool(deps, res, 'delete_category', {}, { pathArgs: { id } });
      return;
    }
  }

  const rm = path.match(/^\/api\/rules\/([^/]+)$/);
  if (rm) {
    const id = Number(parseUid(rm[1], 'id'));
    if (method === 'PUT') {
      // 存在性校验在工具 handler 里对合并后形状做（只改 uids 时 categoryId/channels 沿用旧值）
      await callTool(deps, res, 'upsert_push_rule', asBodyObject(await readJsonBody(req)), {
        pathArgs: { id }, rejectUnknown: true,
      });
      return;
    }
    if (method === 'DELETE') {
      await callTool(deps, res, 'delete_push_rule', {}, { pathArgs: { id } });
      return;
    }
  }

  const prm = path.match(/^\/api\/post-rules\/([^/]+)$/);
  if (prm) {
    const id = Number(parseUid(prm[1], 'id'));
    if (method === 'PUT') {
      // 校验（渠道引用 / 死规则 / LLM 判定须带标准）在工具 handler 里对合并后形状做
      await callTool(deps, res, 'upsert_post_rule', asBodyObject(await readJsonBody(req)), {
        pathArgs: { id },
        rejectUnknown: true,
        // 老契约：PUT 回 { ok: true }（工具返回 { id }，MCP 契约不动）
        map: () => ({ ok: true }),
      });
      return;
    }
    if (method === 'DELETE') {
      // 连带清扫三份账号名单里选用了这条规则的 ruleIds（与 webui mock 同构）——在工具 handler 里
      await callTool(deps, res, 'delete_post_rule', {}, { pathArgs: { id } });
      return;
    }
  }

  // ---- WebUI Agent 对话（P1：agent loop + 写模式 / 模型选择；chat dep 存在才挂，缺 dep = 404）----
  // 面板是**单会话**：scope = adminScope()，与撤销栈同一套 scope 字符串。五个端点的响应形状
  // 是 webui 契约（逐字冻结，demo mock 同构）：history 回 {messages,mode,usage,provider}，
  // 发消息回 {ok,reply,usage,provider}。「写前询问 / 自动修改」只写在系统提示里
  // （agent/loop.ts **不硬拦**写工具），故路由层不干预 loop 的工具调用；
  // PUT /api/chat/{mode,provider} 都是普通配置写（进注册表 → 可撤销，工具不在 agent 工具面）。
  if (chat && method === 'GET' && path === '/api/chat/history') {
    sendJson(res, 200, {
      messages: chatHistoryMessages(chat),
      mode: getChatWriteMode(db),
      usage: chat.usage(adminScope()),
      // 当前选定模型（'' = 自动路由）；每条 assistant 消息另有自己的 provider（谁答的）
      provider: getChatProvider(db),
    });
    return;
  }
  if (chat && method === 'POST' && path === '/api/chat') {
    const body = asBodyObject(await readJsonBody(req));
    if (typeof body.message !== 'string' || body.message.trim() === '') {
      throw new HttpError(400, 'message 必须是非空字符串');
    }
    // LLM 未启用 / 无可用 provider = 400（指引去设置页修）；调用彻底失败由 loop 抛 502
    const blocked = chatBlockedReason(deps);
    if (blocked !== null) throw new HttpError(400, blocked);
    const turn = await runAgentTurn(deps, body.message);
    sendJson(res, 200, {
      ok: true,
      reply: turn.reply,
      usage: chat.usage(adminScope()),
      provider: turn.provider,
      // 本轮工具调用明细（面板渲染工具行；历史回放由 /api/chat/history 的 calls 重建，同一形状）
      calls: turn.calls,
    });
    return;
  }
  if (chat && method === 'POST' && path === '/api/chat/reset') {
    // 重置上下文：清空消息、保留会话行（core/chat-store.ts）。非配置写，不入撤销栈
    chat.reset(adminScope());
    sendJson(res, 200, { ok: true });
    return;
  }
  if (chat && method === 'PUT' && path === '/api/chat/mode') {
    // 经注册表：写模式是配置写，要与面板其余开关一样进快照/变更历史（工具在 agent 工具面之外）
    await callTool(deps, res, 'set_chat_mode', asBodyObject(await readJsonBody(req)));
    return;
  }
  if (chat && method === 'PUT' && path === '/api/chat/provider') {
    // 同上：模型选择也是配置写（进快照/变更历史，可撤销）；工具同样不在 agent 工具面
    await callTool(deps, res, 'set_chat_provider', asBodyObject(await readJsonBody(req)));
    return;
  }

  // ---- 变更历史与撤销（P0 判据 1/2/6；undo dep 存在才挂）----
  // 这两个路由是**唯一不经注册表**的写面：它本身就是撤销执行器——撤销的写是把已记录的前像写回去，
  // 再进快照会把自己变成下一条可撤销记录（工具 undo_last_change 也不带快照，见 mcp/run-tool.ts）。
  if (deps.undo && method === 'GET' && path === '/api/undo/history') {
    sendJson(res, 200, { changes: deps.undo.history().map(undoChangeInfo) });
    return;
  }
  if (deps.undoLast && method === 'POST' && path === '/api/undo') {
    // body 一律忽略：撤销的语义是「撤这个栈的栈顶」，没有任何可选参数（不提 scope = admin 全局栈）
    const r = deps.undoLast();
    if (!r.ok) {
      if (r.reason === 'empty') throw new HttpError(404, '没有可撤销的变更');
      throw new HttpError(409, '该设置已被其他入口修改，无法撤销本次');
    }
    // 中文操作名与「需重填」提示都由后端给（与 /api/undo/history 逐条字段同源，见 panel/undo-view.ts）。
    // **主形状是 change 里的那份**（与历史端点的 title/undoNote 对称）；顶层再放一份同样的值，
    // 是为了让「读 res.title / res.refill」与「读 res.change.title / res.change.refill」两种写法都成立
    // （UI 与本接口并行开发，不做猜谜）。refill 只在隐私例外（LLM key）撤销时出现。
    const payload = {
      ok: true,
      change: {
        id: r.id,
        tool: r.tool ?? null,
        title: undoToolTitle(r.tool),
        ...(r.refill === undefined ? {} : { refill: r.refill }),
      },
      title: undoToolTitle(r.tool),
      ...(r.refill === undefined ? {} : { refill: r.refill }),
    };
    sendJson(res, 200, payload);
    return;
  }

  // ---- OneBot 11 事件接收（NapCat 直连，P3；qqbot dep 存在才挂）----
  // **刻意不挂在 /api/* 下**：它不是主人能力面（人点鼠标的地方），而是 QQ 消息入口——
  // NapCat 的 onebot11 `network.httpClients` 上报地址指向这里（见 src/qqbot/napcat-post.ts）。
  // 恒 200 + JSON 摘要：NapCat 侧对非 2xx 只会记错/重试，而「这条消息没被处理」是正常业务结果；
  // 响应里没有 reply/delete 等字段，不会触发 OneBot 的「快速操作」（不会意外替他回一句）。
  if (deps.qqbot && method === 'POST' && path === '/onebot') {
    const r = await deps.qqbot.handleEvent(await readJsonBody(req));
    sendJson(res, 200, r.reason === undefined ? { ok: true, action: r.action } : { ok: true, action: r.action, reason: r.reason });
    return;
  }

  // ---- MCP 端点（Bearer token 鉴权；工具面按角色过滤，见 src/mcp/）----
  if (path === '/mcp') {
    await handleMcp(deps, req, res);
    return;
  }

  throw new HttpError(404, '未知路由');
}

/**
 * 对话记录 → history 端点形状（webui 契约）：只给 user / assistant 的**有正文**消息
 * ——`tool` 结果与「只调工具、没说话」的轮次对用户没有意义；`at` 秒级（库里毫秒）。
 * `provider`（谁答的）每条都给：assistant 是落库的实际回答者，user 行恒为 null（前端不必分支取值）。
 */
/**
 * 会话历史 → 面板聊天视图的读法。与 loop 的历史回放同口径：assistant 的 toolCalls 与
 * tool 结果按 call id 配对，配不上的（进程半截挂掉）双方都丢；空壳轮次（无文本无配对
 * 调用）不显示。工具调用经 `toolCallView` 出展示形状（与 `POST /api/chat` 的 calls 同一信源）。
 * `id` = chat_messages.id：前端进行中轮询靠它做增量去重。
 */
function chatHistoryMessages(chat: ChatStore): Array<{
  id: number; role: string; content: string; at: number; provider: string | null; calls?: ToolCallView[];
}> {
  const msgs = chat.messages(adminScope());
  const toolById = new Map<string, string>();
  for (const m of msgs) {
    if (m.role === 'tool' && m.toolCallId !== null) toolById.set(m.toolCallId, m.content);
  }
  const out: Array<{
    id: number; role: string; content: string; at: number; provider: string | null; calls?: ToolCallView[];
  }> = [];
  for (const m of msgs) {
    if (m.role === 'user') {
      if (m.content.trim() === '') continue;
      out.push({ id: m.id, role: 'user', content: m.content, at: Math.floor(m.createdAt / 1000), provider: null });
      continue;
    }
    if (m.role !== 'assistant') continue;   // tool 行已配进 calls；孤儿 tool 结果丢弃
    const calls = ((m.toolCalls ?? []) as ToolCall[])
      .filter((c) => toolById.has(c.id))
      .map((c) => toolCallView(c, toolById.get(c.id)!));
    if (m.content.trim() === '' && calls.length === 0) continue;   // 空壳轮次
    out.push({
      id: m.id,
      role: 'assistant',
      content: m.content,
      at: Math.floor(m.createdAt / 1000),
      provider: m.provider,
      ...(calls.length > 0 ? { calls } : {}),
    });
  }
  return out;
}

// ---- 头像代理（/api/avatar）----
// B站图床（hdslb.com）不返回 CORS 头，前端 <img> 直接跨域读像素必然画布污染，
// 头像平均色只能同源反代。B站图床要 UA + Referer，否则 403（同 image-cache 口径）。
const AVATAR_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Referer: 'https://live.bilibili.com/',
};
const AVATAR_CACHE_MAX = 200;
const avatarCache = new Map<string, { buf: Buffer; type: string }>();

/** 域名白名单：只反代 B站系图床，防库被写脏后变成开放 SSRF 代理 */
function isBiliImageHost(host: string): boolean {
  return host === 'hdslb.com' || host.endsWith('.hdslb.com') ||
    host === 'bilibili.com' || host.endsWith('.bilibili.com');
}

async function sendAvatar(deps: PanelDeps, url: URL, res: http.ServerResponse): Promise<void> {
  const uid = url.searchParams.get('uid') ?? '';
  if (!/^\d+$/.test(uid)) throw new HttpError(400, 'uid 必须是纯数字');
  const face = deps.db.getStreamer(uid)?.face;
  if (!face) throw new HttpError(404, '该主播没有头像');
  let host: string;
  try {
    const u = new URL(face);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('bad scheme');
    host = u.hostname;
  } catch {
    throw new HttpError(400, '头像地址非法');
  }
  if (!isBiliImageHost(host)) throw new HttpError(400, '头像地址不在白名单内');
  let entry = avatarCache.get(face);
  if (!entry) {
    const fetchImpl = deps.avatar?.fetchImpl ?? fetch;
    let resp: Response;
    try {
      resp = await fetchImpl(face, { headers: AVATAR_HEADERS, signal: AbortSignal.timeout(8000) });
    } catch {
      throw new HttpError(502, '头像拉取失败');
    }
    if (!resp.ok) throw new HttpError(502, '头像拉取失败');
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0) throw new HttpError(502, '头像为空');
    const ct = (resp.headers.get('content-type') ?? '').toLowerCase();
    const type = ct.includes('png') ? 'image/png' : ct.includes('webp') ? 'image/webp'
      : ct.includes('gif') ? 'image/gif' : 'image/jpeg';
    if (avatarCache.size >= AVATAR_CACHE_MAX) {
      const oldest = avatarCache.keys().next().value;
      if (oldest !== undefined) avatarCache.delete(oldest);
    }
    entry = { buf, type };
    avatarCache.set(face, entry);
  }
  res.writeHead(200, {
    'content-type': entry.type,
    // 头像可能随时变更（主播换头像），浏览器不缓存；服务端 avatarCache 已按 face 去重，
    // 换头像 = 新 face URL → 新拉取，未换则内存直出，成本可控
    'cache-control': 'private, no-cache',
  });
  res.end(entry.buf);
}

/** 微博图床防盗链要求 Referer: weibo.com（no-referrer 也 403，2026-09-20 实测 wx1/orj960） */
const WEIBO_IMAGE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Referer: 'https://weibo.com/',
};
const WEIBO_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * 微博帖子图反代：sinaimg 防盗链让浏览器热链不出（带外站 Referer 或 no-referrer 都 403），
 * 只能服务端带 weibo Referer 拉。weiboImages.dir 存在时按 URL md5 落盘（签名 URL 会过期，
 * 但落盘后同一 URL 永远有本地副本；新 URL 自然重新拉）。host 白名单防开放 SSRF。
 */
async function sendWeiboImage(deps: PanelDeps, url: URL, res: http.ServerResponse): Promise<void> {
  const raw = url.searchParams.get('url') ?? '';
  let host: string;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('bad scheme');
    host = u.hostname;
  } catch {
    throw new HttpError(400, 'url 参数非法');
  }
  if (host !== 'sinaimg.cn' && !host.endsWith('.sinaimg.cn')) {
    throw new HttpError(400, 'url 不在微博图床白名单内');
  }
  const dir = deps.weiboImages?.dir;
  const ext = raw.toLowerCase().includes('.png') ? 'png' : raw.toLowerCase().includes('.webp') ? 'webp' : 'jpg';
  const name = createHash('md5').update(raw).digest('hex') + '.' + ext;
  if (dir) {
    try {
      const data = readFileSync(join(dir, name));
      res.writeHead(200, {
        'content-type': ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg',
        'cache-control': 'max-age=86400',
      });
      res.end(data);
      return;
    } catch { /* 未缓存，往下拉取 */ }
  }
  let resp: Response;
  try {
    const fetchImpl = deps.weiboImages?.fetchImpl ?? fetch;
    resp = await fetchImpl(raw, { headers: WEIBO_IMAGE_HEADERS, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new HttpError(502, '微博图片拉取失败');
  }
  if (!resp.ok) throw new HttpError(502, `微博图片拉取失败（HTTP ${resp.status}）`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length === 0 || buf.length > WEIBO_IMAGE_MAX_BYTES) throw new HttpError(502, '微博图片为空或过大');
  if (dir) {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), buf);
    } catch { /* 落盘失败照样透传 */ }
  }
  const ct = (resp.headers.get('content-type') ?? '').toLowerCase();
  res.writeHead(200, {
    'content-type': ct.includes('png') ? 'image/png' : ct.includes('webp') ? 'image/webp'
      : ct.includes('gif') ? 'image/gif' : 'image/jpeg',
    'cache-control': 'max-age=86400',
  });
  res.end(buf);
}

/** 名单 + face + 实况（room_state）+ 生效规则名标签 + 最近动态（posts，含关联微博账号的微博）。一次请求内每表只查一次。 */
function enrichedStreamers(db: Db): unknown[] {
  const streamers = db.listStreamers();
  const roomStates = db.listRoomStatesFull();
  // 每个 uid 的生效规则名（listPushRules 已按全局 sort 排序，含 disabled；
  // uids 空 = 对全部主播生效，含未来新增）
  const allRules = db.listPushRules();
  // 一次分组查询：每个 uid 最近 5 条（B站动态 + 关联微博账号的微博，按 pub_ts 混排），raw 不下发
  const recentPosts = db.listRecentPostsMixed(streamers.map((s) => s.uid), 5);
  return streamers.map((s) => {
    const rs = roomStates.get(s.uid);
    return {
      ...s,
      face: s.face,
      live: rs
        ? {
            isLive: rs.isLive, title: rs.title, liveTime: rs.liveTime,
            roomId: s.roomId ?? rs.roomId,
            areaName: rs.areaName, parentAreaName: rs.parentAreaName,
            keyframe: rs.keyframe, cover: rs.cover, online: rs.online,
            lastLiveAt: rs.lastLiveAt, polledAt: rs.polledAt,
          }
        : null,
      rules: {
        names: allRules
          .filter((r) => r.uids.length === 0 || r.uids.includes(s.uid))
          .map((r) => r.name),
      },
      posts: (recentPosts.get(s.uid) ?? []).map((p) => ({
        platform: p.platform, type: p.type, text: p.text,
        pics: p.pics, pubTs: p.pubTs, url: p.url,
      })),
    };
  });
}

/** 轮询扫码状态；confirmed 时落盘 + 热重启回调 + 用新 cookie 查 mid。cookie 值不出现在响应里。 */
async function pollQrcodeRoute(deps: PanelDeps, key: string | null): Promise<unknown> {
  const auth = deps.auth!;
  if (!key) throw new HttpError(400, '缺少 key 参数');
  const qr = auth.qrcode ?? { generateQrcode, pollQrcode };
  const result = await qr.pollQrcode(key);
  if (result.status !== 'confirmed') return { status: result.status };

  const cookies = result.cookies ?? {};
  saveCookies(auth.cookiePath, cookies);
  const merged = loadCookies(auth.cookiePath) ?? cookies;
  auth.onCookiesSaved(cookieHeader(merged));

  let mid: string | null = null;
  try {
    const self = await (auth.selfFetcher ?? fetchSelf)(cookieHeader(merged));
    mid = self.mid;
  } catch (e) {
    log.error('扫码登录成功但 nav 查询失败（mid 暂缺，下轮心跳会补上）', e);
  }
  return { status: 'confirmed', mid };
}

/**
 * 轮询微博扫码状态；confirmed 时换票 → saveWeiboCookies 落盘 → 热重启回调 →
 * 用新 cookie 查一次登录态拿 uid。cookie 值不出现在响应/日志里。
 */
async function pollWeiboQrcodeRoute(
  deps: PanelDeps,
  session: { qrid: string | null },
): Promise<unknown> {
  const auth = deps.weiboAuth!;
  if (!session.qrid) throw new HttpError(400, '请先生成二维码');
  const qr = auth.qrcode
    ?? { generateQrcode: generateWeiboQrcode, pollQrcode: pollWeiboQrcode, exchangeCookies: exchangeWeiboCookies };
  const result = await qr.pollQrcode(session.qrid);
  if (result.status !== 'confirmed') {
    if (result.status === 'expired') session.qrid = null;
    return { status: result.status };
  }
  session.qrid = null;
  if (!result.loginUrl) throw new HttpError(500, '扫码确认响应缺少登录跳转地址');

  const cookies = await qr.exchangeCookies(result.loginUrl);
  saveWeiboCookies(auth.cookiePath, cookies);
  const merged = loadWeiboCookies(auth.cookiePath) ?? cookies;
  auth.onCookiesSaved(weiboCookieHeader(merged));

  let uid: string | null = null;
  try {
    const self = await (auth.selfFetcher ?? fetchWeiboSelf)(weiboCookieHeader(merged));
    uid = self.uid;
  } catch (e) {
    log.error('微博扫码登录成功但登录态查询失败（uid 暂缺，下轮心跳会补上）', e);
  }
  return { status: 'confirmed', uid };
}

// ---- 监听功能开关（面板「监听」卡片 / X 分页的「监听」卡）----
function listenInfo(deps: PanelDeps): unknown {
  const login = deps.listen!.login();
  const row = (feature: ListenFeature) => ({
    feature,
    setting: listenSetting(deps.db, feature),
    enabled: isListenEnabled(deps.db, feature, listenReadyFor(feature, login)),
  });
  return {
    biliLoggedIn: login.bili,
    weiboLoggedIn: login.weibo,
    /** X 没有登录态：这里是「代理已配置」 */
    xProxyConfigured: login.twitter,
    platforms: deps.status().platforms,
    rows: {
      dynamic: row('dynamic'),
      weibo: row('weibo'),
      twitter: row('twitter'),
    },
  };
}

// ---- X 关注账号（独立名单）辅助 ----

/** 名单行的面板视图：附关联主播展示名（简称优先，同 streamers.alias 约定）+ 最近 3 条推文（卡片动态段）。
 *  biliFace 是头像兜底：X 链路还没抓到头像时，卡片先用关联主播的 B站头像。 */
function xAccountView(db: Db, a: ReturnType<Db['listXAccounts']>[number]): unknown {
  const bili = a.biliUid ? db.getStreamer(a.biliUid) : undefined;
  const posts = db
    .searchPosts({ platform: 'twitter', uid: a.screenName, limit: 3 })
    .map(({ raw: _raw, ...p }) => p);
  return {
    ...a,
    biliName: bili ? (bili.alias || bili.uname || a.biliUid) : null,
    biliFace: bili?.face ?? null,
    posts,
  };
}

function xAccountList(db: Db): unknown[] {
  return db.listXAccounts().map((a) => xAccountView(db, a));
}

function xAccountInfo(db: Db, id: number): unknown {
  const a = db.getXAccount(id);
  if (!a) throw new HttpError(404, 'X 账号不存在');
  return xAccountView(db, a);
}

// ---- 微博关注账号（独立名单）辅助 ----

/**
 * 名单行的面板视图：附关联主播展示名（简称优先，同 streamers.alias 约定）+ 最近 3 条微博（卡片动态段）。
 * biliFace 是头像兜底：微博链路还没抓到头像时，卡片先用关联主播的 B站头像。
 */
function weiboAccountView(db: Db, a: ReturnType<Db['listWeiboAccounts']>[number]): unknown {
  const bili = a.biliUid ? db.getStreamer(a.biliUid) : undefined;
  const posts = db
    .searchPosts({ platform: 'weibo', uid: a.uid, limit: 3 })
    .map(({ raw: _raw, ...p }) => p);
  return {
    ...a,
    biliName: bili ? (bili.alias || bili.uname || a.biliUid) : null,
    biliFace: bili?.face ?? null,
    posts,
  };
}

function weiboAccountList(db: Db): unknown[] {
  return db.listWeiboAccounts().map((a) => weiboAccountView(db, a));
}

function weiboAccountInfo(db: Db, id: number): unknown {
  const a = db.getWeiboAccount(id);
  if (!a) throw new HttpError(404, '微博账号不存在');
  return weiboAccountView(db, a);
}

// ---- B站动态账号（独立名单）辅助 ----

/**
 * 名单行的面板视图：附最近 3 条动态（卡片帖子段；raw 不下发）。
 * 账号本身就是主播（uid 即身份锚点），不像 x/weibo 那样需要 biliUid 关联与头像兜底。
 */
function biliAccountView(db: Db, a: ReturnType<Db['listBiliAccounts']>[number]): unknown {
  const posts = db
    .searchPosts({ platform: 'bili_dynamic', uid: a.uid, limit: 3 })
    .map(({ raw: _raw, ...p }) => p);
  return { ...a, posts };
}

function biliAccountList(db: Db): unknown[] {
  return db.listBiliAccounts().map((a) => biliAccountView(db, a));
}

function biliAccountInfo(db: Db, id: number): unknown {
  const a = db.getBiliAccount(id);
  if (!a) throw new HttpError(404, 'B站动态账号不存在');
  return biliAccountView(db, a);
}

// ---- LLM key 管理（settings 表 llm_key:<providerName>；本机面板，值可回显/编辑）----

/** key 来源、池子大小与值本身：panel = 面板填写；unset = 未设置（key 唯一来源是 settings） */
function llmKeySource(
  db: Db,
  p: LlmProviderConfig,
): { source: 'panel' | 'unset'; count: number; value: string | null } {
  const panel = db.getSetting(`llm_key:${p.name}`);
  if (panel && panel.trim()) {
    const v = panel.trim();
    return { source: 'panel', count: splitCsvText(v).length, value: v };
  }
  return { source: 'unset', count: 0, value: null };
}

function llmInfo(deps: PanelDeps): unknown {
  const list = deps.llm!.store?.list() ?? [];
  const routes = deriveRoutes(list);
  const described = new Map((deps.llm!.router?.describe() ?? []).map((s) => [s.name, s]));
  return {
    enabled: isLlmEnabled(deps.db),
    // agent 会话选定的 provider（'' = 自动路由）：选择器只需读这一处就能预选，
    // 与 /api/chat/history 的 provider 同一个 settings 键
    chatProvider: getChatProvider(deps.db),
    providers: list.map((p) => ({
      name: p.name,
      baseURL: p.baseURL,
      model: p.model,
      vision: p.vision,
      enabled: p.enabled,
      structuredOutput: p.structuredOutput,
      api: p.api,
      routes: (['text', 'vision'] as const).filter((r) => routes[r].includes(p.name)),
      status: described.get(p.name)?.status ?? null,
      // 此刻能不能真的用（启用 + 有 key + 未熔断）：Agent 模型选择器只让挑能用的，
      // 与 loop 的 chatBlockedReason 同一判据（ProviderStatus.ready）
      ready: described.get(p.name)?.ready ?? false,
      key: llmKeySource(deps.db, p),
    })),
  };
}

