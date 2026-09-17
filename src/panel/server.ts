/**
 * 控制面板 v1：同进程 node:http，零框架零依赖，只绑 127.0.0.1。
 * 只读写 DB（业务进程每轮查库，改库即生效）；启动失败不影响主流程（装配处兜底）。
 * 扫码登录路由仅在装配处注入 auth dep 时挂载；cookie 值不出现在任何响应/日志里。
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { makeLogger } from '../logger.js';
import type { Db } from '../core/db.js';
import type { Streamer, StreamerInput } from '../core/streamers.js';
import {
  HttpError, checkCategoryConditions, checkChannelShape, checkRuleRefs, parseCategoryPatch, parseChannelPatch,
  parseNewCategory, parseNewChannel, parseNewRule, parseNewXAccount, parsePostRulePatch, parseRulePatch, parseRuntimePatch,
  checkPostFiltersUsable, checkPostJudgeUsable, checkPostRuleRefs, parseNewPostRule,
  parseStreamerPatch, parseUid, parseXAccountPatch, parseXPatch, parseXTestRequest, readJsonBody, sendJson,
  watchStreamer, type XTestRequest,
} from './http-util.js';
import { scheduleInfo } from './schedule.js';
import { handleMcp } from '../mcp/handler.js';
import { WEBUI_ASSETS } from './webui-assets.gen.js';
import { cookieHeader, fetchSelf, loadCookies, saveCookies, type SelfInfo } from '../sources/bili/auth.js';
import { generateQrcode, pollQrcode } from '../sources/bili/qrcode.js';
import type { WeiboResolver } from '../sources/weibo/resolve.js';
import {
  exchangeCookies as exchangeWeiboCookies, generateQrcode as generateWeiboQrcode,
  pollQrcode as pollWeiboQrcode,
} from '../sources/weibo/qrcode.js';
import {
  fetchWeiboSelf, loadWeiboCookies, saveWeiboCookies, weiboCookieHeader, type WeiboSelfInfo,
} from '../sources/weibo/auth.js';
import { llmProviderSchema, type LlmProviderConfig } from '../config/schema.js';
import { deriveRoutes, isLlmEnabled, setLlmEnabled, type FetchLike, type LlmRouter } from '../analysis/providers.js';
import { isListenEnabled, listenReadyFor, listenSetting, setListen, type ListenFeature } from '../core/listen.js';
import {
  getRuntimeConfig, saveRuntimeConfig,
} from '../core/runtime-config.js';
import { isPushEnabled, setPushEnabled } from '../core/push.js';
import type { XConfig } from '../core/x-config.js';
import type { NapcatConfig, ProbeResult } from '../notify/napcat.js';
import { getNapcatAlertQq } from '../notify/napcat.js';

const log = makeLogger('panel');

/** X 账号存在性校验结果：`kind` 决定面板怎么处理（not-found 拒绝 / link 照收并提示） */
export interface XAccountVerify {
  checked: boolean;
  ok: boolean;
  kind: 'ok' | 'not-found' | 'link';
  message: string;
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
    /** 实时状态：发现的端点 + 三态探测 + 拉起能力是否就绪 */
    state: () => Promise<{ endpoint: string | null; probe: ProbeResult | null; taskRegistered: boolean }>;
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
    sendJson(res, 200, putListen(deps, lm[1] as ListenFeature, await readJsonBody(req)));
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
    const patch = parseRuntimePatch(await readJsonBody(req));
    saveRuntimeConfig(db, patch);
    deps.advanced?.onChanged();
    sendJson(res, 200, { ok: true, ...getRuntimeConfig(db) });
    return;
  }

  // ---- X / 推特（独立分页；x dep 存在才挂）----
  // GET 只回快照不打网络：面板会周期轮询这张卡片，探测必须由「测试」按钮显式触发。
  if (deps.x && method === 'GET' && path === '/api/x') {
    sendJson(res, 200, deps.x.info());
    return;
  }
  if (deps.x && method === 'PUT' && path === '/api/x') {
    const patch = parseXPatch(await readJsonBody(req));
    deps.x.save(patch);
    deps.x.onChanged();
    sendJson(res, 200, deps.x.info());
    return;
  }
  if (deps.x && method === 'POST' && path === '/api/x/test') {
    const testReq = parseXTestRequest(await readJsonBody(req));
    sendJson(res, 200, await deps.x.test(testReq));
    return;
  }

  // ---- X 关注账号（独立名单：不要求对应 B站主播，biliUid 只是可选关联）----
  if (deps.x && method === 'GET' && path === '/api/x/accounts') {
    sendJson(res, 200, { accounts: xAccountList(db) });
    return;
  }
  if (deps.x && method === 'POST' && path === '/api/x/accounts') {
    const input = parseNewXAccount(await readJsonBody(req));
    if (db.getXAccountByScreenName(input.screenName)) {
      throw new HttpError(409, `@${input.screenName} 已在名单里`);
    }
    checkXBiliUid(db, input.biliUid);
    // 存在性校验：能校验就校验。「账号不存在」是硬错误（多半敲错了）；
    // 链路原因（代理不通 / 限流）照收——不能因为代理没开就让人加不了账号，
    // 把原因回给面板显示即可（这是区分「我填错了」与「链路断了」的唯一手段）。
    const verify = await deps.x.verify(input.screenName);
    if (verify.checked && !verify.ok && verify.kind === 'not-found') {
      throw new HttpError(400, `X 账号不存在：@${input.screenName}`);
    }
    const id = db.upsertXAccount(input);
    deps.x.onChanged();
    sendJson(res, 200, { account: xAccountInfo(db, id), verify });
    return;
  }
  const xa = path.match(/^\/api\/x\/accounts\/(\d+)$/);
  if (deps.x && xa && method === 'PUT') {
    const id = Number(xa[1]);
    if (!db.getXAccount(id)) throw new HttpError(404, 'X 账号不存在');
    const patch = parseXAccountPatch(await readJsonBody(req));
    if (patch.screenName !== undefined) {
      const dup = db.getXAccountByScreenName(patch.screenName);
      if (dup && dup.id !== id) throw new HttpError(409, `@${patch.screenName} 已在名单里`);
    }
    if (patch.biliUid !== undefined) checkXBiliUid(db, patch.biliUid);
    db.upsertXAccount({ ...patch, id });
    deps.x.onChanged();
    sendJson(res, 200, { account: xAccountInfo(db, id) });
    return;
  }
  if (deps.x && xa && method === 'DELETE') {
    const id = Number(xa[1]);
    if (!db.deleteXAccount(id)) throw new HttpError(404, 'X 账号不存在');
    deps.x.onChanged();
    sendJson(res, 200, { ok: true });
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
    const id = db.upsertPushChannel(parseNewChannel(await readJsonBody(req)));
    sendJson(res, 201, { id });
    return;
  }
  // 渠道拖拽排序：ids 是现有渠道的全排列（在 :id 通配之前匹配）
  if (method === 'PUT' && path === '/api/channels/order') {
    sendJson(res, 200, putChannelOrder(db, await readJsonBody(req)));
    return;
  }
  // 推送总开关（面板推送卡右上角；settings.push_enabled，缺省开）
  if (method === 'GET' && path === '/api/push') {
    sendJson(res, 200, { enabled: isPushEnabled(db) });
    return;
  }
  if (method === 'PUT' && path === '/api/push/enabled') {
    const b = (await readJsonBody(req)) as Record<string, unknown>;
    if (typeof b.enabled !== 'boolean') throw new HttpError(400, 'enabled 必须是布尔值');
    setPushEnabled(db, b.enabled);
    sendJson(res, 200, { ok: true, enabled: b.enabled });
    return;
  }
  // 测试推送：假消息走完整链路（面板「推送设置」弹窗里触发）
  if (deps.testPush && method === 'POST' && path === '/api/push/test') {
    const r = await deps.testPush();
    sendJson(res, 200, { ok: true, ...r });
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
    sendJson(res, 200, putLlmKey(deps, await readJsonBody(req)));
    return;
  }
  if (deps.llm && method === 'PUT' && path === '/api/llm/enabled') {
    const b = (await readJsonBody(req)) as Record<string, unknown>;
    if (typeof b.enabled !== 'boolean') throw new HttpError(400, 'enabled 必须是布尔值');
    setLlmEnabled(deps.db, b.enabled);
    sendJson(res, 200, { ok: true, enabled: b.enabled });
    return;
  }
  if (deps.llm?.store && method === 'POST' && path === '/api/llm/providers') {
    sendJson(res, 201, putLlmProvider(deps, null, await readJsonBody(req)));
    return;
  }
  // 排序路由必须在 :name 通配之前匹配，否则 'order' 会被当成 provider 名
  if (deps.llm?.store && method === 'PUT' && path === '/api/llm/providers/order') {
    sendJson(res, 200, putLlmProviderOrder(deps, await readJsonBody(req)));
    return;
  }
  const lpt = path.match(/^\/api\/llm\/providers\/([^/]+)\/test$/);
  if (deps.llm?.router && lpt && method === 'POST') {
    const name = decodeURIComponent(lpt[1]!);
    const status = deps.llm.router.providerStatus(name);
    if (status === null) throw new HttpError(404, 'provider 不存在');
    if (status.startsWith('缺 key')) throw new HttpError(400, '缺 key，请先填写');
    try {
      const ms = await deps.llm.router.ping(name);
      sendJson(res, 200, { ok: true, ms });
    } catch (e) {
      // 错误信息只含 HTTP 状态/对端响应摘要，不含 key（key 只在请求头里）
      sendJson(res, 502, { ok: false, error: (e as Error).message });
    }
    return;
  }
  const lpm = path.match(/^\/api\/llm\/providers\/([^/]+)$/);
  if (deps.llm?.store && lpm) {
    const name = decodeURIComponent(lpm[1]!);
    if (method === 'PUT') {
      sendJson(res, 200, putLlmProvider(deps, name, await readJsonBody(req)));
      return;
    }
    if (method === 'DELETE') {
      const list = deps.llm.store.list();
      if (!list.some((p) => p.name === name)) throw new HttpError(404, 'provider 不存在');
      deps.llm.store.save(list.filter((p) => p.name !== name));
      deps.llm.onProvidersChanged?.();
      sendJson(res, 200, { ok: true });
      return;
    }
  }
  // ---- 分类规则（全局定义：LLM 提示词 + 确定性条件，归类结果入 verdicts）----
  if (method === 'GET' && path === '/api/categories') {
    sendJson(res, 200, { categories: db.listCategories() });
    return;
  }
  if (method === 'POST' && path === '/api/categories') {
    const id = db.upsertCategory(parseNewCategory(await readJsonBody(req)));
    sendJson(res, 201, { id });
    return;
  }
  // 分类拖拽排序：ids 是现有分类的全排列（在 :id 通配之前匹配）
  if (method === 'PUT' && path === '/api/categories/order') {
    sendJson(res, 200, putCategoryOrder(db, await readJsonBody(req)));
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
    const rule = parseNewRule(await readJsonBody(req));
    checkRuleRefs(db, rule);
    sendJson(res, 201, { id: db.upsertPushRule(rule) });
    return;
  }
  // 规则拖拽排序：ids 是全部规则的全排列（在 :id 通配之前匹配）
  if (method === 'PUT' && path === '/api/rules/order') {
    sendJson(res, 200, putRuleOrder(db, await readJsonBody(req)));
    return;
  }

  // ---- 图文帖规则（X/推特；与推送规则平行的一张表，渠道共用设置页那份）----
  if (method === 'GET' && path === '/api/post-rules') {
    sendJson(res, 200, { rules: db.listPostRules() });
    return;
  }
  if (method === 'POST' && path === '/api/post-rules') {
    const rule = parseNewPostRule(await readJsonBody(req));
    checkPostRuleRefs(db, rule);
    sendJson(res, 201, { id: db.upsertPostRule(rule) });
    return;
  }
  // 拖拽排序（在 :id 通配之前匹配）
  if (method === 'PUT' && path === '/api/post-rules/order') {
    sendJson(res, 200, putPostRuleOrder(db, await readJsonBody(req)));
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
      sendJson(res, 200, watchStreamer(db, uid));
      return;
    }
    if (!sm[2] && method === 'PUT') {
      const prev = db.getStreamer(uid);
      if (!prev) throw new HttpError(404, '该 uid 不在监听名单');
      const patch = parseStreamerPatch(await readJsonBody(req));
      await resolveWeiboNick(deps, prev, patch);
      db.upsertStreamer({ uid, ...patch });
      sendJson(res, 200, { streamer: db.getStreamer(uid) });
      return;
    }
  }

  const chm = path.match(/^\/api\/channels\/([^/]+)$/);
  if (chm) {
    const id = Number(parseUid(chm[1], 'id'));
    const prev = db.listPushChannels().find((c) => c.id === id);
    if (!prev) throw new HttpError(404, '渠道不存在');
    if (method === 'PUT') {
      const patch = parseChannelPatch(await readJsonBody(req));
      // 联动校验要对合并后的形状做（如 toast 改成 onebot 必须补目标号）
      checkChannelShape({
        notifier: patch.notifier ?? prev.notifier,
        targetType: patch.targetType !== undefined ? patch.targetType : prev.targetType,
        targetId: patch.targetId !== undefined ? patch.targetId : prev.targetId,
      });
      db.upsertPushChannel({ id, ...patch });
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === 'DELETE') {
      db.deletePushChannel(id);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  const cam = path.match(/^\/api\/categories\/([^/]+)$/);
  if (cam) {
    const id = Number(parseUid(cam[1], 'id'));
    const prev = db.listCategories().find((c) => c.id === id);
    if (!prev) throw new HttpError(404, '分类不存在');
    if (method === 'PUT') {
      const patch = parseCategoryPatch(await readJsonBody(req));
      // 条件校验要对合并后的形状做（如把唯一的条件清空 → 400）
      checkCategoryConditions({
        llmPrompt: patch.llmPrompt !== undefined ? patch.llmPrompt : prev.llmPrompt,
        keywords: patch.keywords ?? prev.keywords,
        areas: patch.areas ?? prev.areas,
      });
      db.upsertCategory({ id, ...patch });
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === 'DELETE') {
      // 级联：先停用引用它的推送规则（规则保留可恢复），条数返回给面板提示
      const disabledRules = db.disablePushRulesByCategory(id);
      db.deleteCategory(id);
      sendJson(res, 200, { ok: true, disabledRules });
      return;
    }
  }

  const rm = path.match(/^\/api\/rules\/([^/]+)$/);
  if (rm) {
    const id = Number(parseUid(rm[1], 'id'));
    if (method === 'PUT') {
      const patch = parseRulePatch(await readJsonBody(req));
      const prev = db.listPushRules().find((r) => r.id === id);
      if (!prev) throw new HttpError(404, '规则不存在');
      // 存在性校验要对合并后的形状做（如只改 uids 时 categoryId/channels 沿用旧值）
      checkRuleRefs(db, {
        categoryId: patch.categoryId !== undefined ? patch.categoryId : prev.categoryId,
        uids: patch.uids ?? prev.uids,
        channels: patch.channels ?? prev.channels,
      });
      db.upsertPushRule({ id, ...patch });
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === 'DELETE') {
      if (!db.deletePushRule(id)) throw new HttpError(404, '规则不存在');
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  const prm = path.match(/^\/api\/post-rules\/([^/]+)$/);
  if (prm) {
    const id = Number(parseUid(prm[1], 'id'));
    if (method === 'PUT') {
      const patch = parsePostRulePatch(await readJsonBody(req));
      const prev = db.listPostRules().find((r) => r.id === id);
      if (!prev) throw new HttpError(404, '图文帖规则不存在');
      // 校验要对「合并后」的形状做（只改 filters 时账号/渠道沿用旧值）
      checkPostRuleRefs(db, {
        accountIds: patch.accountIds ?? prev.accountIds,
        channels: patch.channels ?? prev.channels,
      });
      checkPostFiltersUsable({ ...prev.filters, ...(patch.filters ?? {}) });
      checkPostJudgeUsable(
        patch.llmJudge ?? prev.llmJudge,
        patch.judgePrompt !== undefined ? patch.judgePrompt : prev.judgePrompt,
      );
      db.upsertPostRule({ id, ...patch });
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === 'DELETE') {
      if (!db.deletePostRule(id)) throw new HttpError(404, '图文帖规则不存在');
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  // ---- MCP 端点（Bearer token 鉴权；工具面按角色过滤，见 src/mcp/）----
  if (path === '/mcp') {
    await handleMcp(deps, req, res);
    return;
  }

  throw new HttpError(404, '未知路由');
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

/** 渠道拖拽排序：ids 必须是现有渠道的全排列（长度一致/无重复/无增删）。 */
function putChannelOrder(db: Db, body: unknown): unknown {
  const ids = (body as Record<string, unknown> | null)?.ids;
  if (!Array.isArray(ids) || ids.some((n) => typeof n !== 'number' || !Number.isInteger(n) || n <= 0)) {
    throw new HttpError(400, 'ids 必须是正整数 id 数组');
  }
  const existing = new Set(db.listPushChannels().map((c) => c.id));
  if (ids.length !== existing.size || new Set(ids).size !== ids.length || ids.some((id) => !existing.has(id))) {
    throw new HttpError(400, 'ids 必须与现有渠道一一对应');
  }
  db.reorderPushChannels(ids);
  return { ok: true };
}

/** 分类拖拽排序：ids 必须是现有分类的全排列（长度一致/无重复/无增删）。 */
function putCategoryOrder(db: Db, body: unknown): unknown {
  const ids = (body as Record<string, unknown> | null)?.ids;
  if (!Array.isArray(ids) || ids.some((n) => typeof n !== 'number' || !Number.isInteger(n) || n <= 0)) {
    throw new HttpError(400, 'ids 必须是正整数 id 数组');
  }
  const existing = new Set(db.listCategories().map((c) => c.id));
  if (ids.length !== existing.size || new Set(ids).size !== ids.length || ids.some((id) => !existing.has(id))) {
    throw new HttpError(400, 'ids 必须与现有分类一一对应');
  }
  db.reorderCategories(ids);
  return { ok: true };
}

/** 规则拖拽排序：ids 必须是全部规则的全排列（长度一致/无重复/无增删）。 */
function putRuleOrder(db: Db, body: unknown): unknown {
  const ids = (body as Record<string, unknown> | null)?.ids;
  if (!Array.isArray(ids) || ids.some((n) => typeof n !== 'number' || !Number.isInteger(n) || n <= 0)) {
    throw new HttpError(400, 'ids 必须是正整数 id 数组');
  }
  const existing = new Set(db.listPushRules().map((r) => r.id));
  if (ids.length !== existing.size || new Set(ids).size !== ids.length || ids.some((id) => !existing.has(id))) {
    throw new HttpError(400, 'ids 必须与现有规则一一对应');
  }
  db.reorderPushRules(ids);
  return { ok: true };
}

function putPostRuleOrder(db: Db, body: unknown): unknown {
  const ids = (body as Record<string, unknown> | null)?.ids;
  if (!Array.isArray(ids) || ids.some((n) => typeof n !== 'number' || !Number.isInteger(n) || n <= 0)) {
    throw new HttpError(400, 'ids 必须是正整数 id 数组');
  }
  const existing = new Set(db.listPostRules().map((r) => r.id));
  if (ids.length !== existing.size || new Set(ids).size !== ids.length || ids.some((id) => !existing.has(id))) {
    throw new HttpError(400, 'ids 必须与现有图文帖规则一一对应');
  }
  db.reorderPostRules(ids);
  return { ok: true };
}

/** 名单 + face + 实况（room_state）+ 生效规则名标签 + 最近动态（posts）。一次请求内每表只查一次。 */
function enrichedStreamers(db: Db): unknown[] {
  const streamers = db.listStreamers();
  const roomStates = db.listRoomStatesFull();
  // 每个 uid 的生效规则名（listPushRules 已按全局 sort 排序，含 disabled；
  // uids 空 = 对全部主播生效，含未来新增）
  const allRules = db.listPushRules();
  // 一次分组查询：每个 uid 最近 5 条动态（跨平台按 pub_ts 混排），raw 不下发
  const recentPosts = db.listRecentPosts(streamers.map((s) => s.uid), 5);
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

/**
 * PUT 里的 weiboNick 处理：与库中现值不同才解析（改名后重新填一次即可）。
 * 解析到 UID → weibo_nick + weibo_uid 一起存；昵称不存在 / 网络错误 → 400；
 * 传空（null）→ 两个字段一起清空。与现值相同 → 不解析（weibo_uid 保持原值）。
 */
async function resolveWeiboNick(
  deps: PanelDeps,
  prev: Streamer,
  patch: Partial<StreamerInput>,
): Promise<void> {
  if (patch.weiboNick === undefined) return;
  if (patch.weiboNick === null || patch.weiboNick === '') {
    patch.weiboNick = null;
    patch.weiboUid = null;
    return;
  }
  if (patch.weiboNick === prev.weiboNick) return;
  if (!deps.weiboResolver) throw new HttpError(400, '微博解析不可用');
  let uid: string | null;
  try {
    uid = await deps.weiboResolver.resolveUid(patch.weiboNick);
  } catch (e) {
    throw new HttpError(400, `微博昵称解析失败：${e instanceof Error ? e.message : String(e)}`);
  }
  if (uid === null) throw new HttpError(400, '微博上找不到这个昵称');
  patch.weiboUid = uid;
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

function putListen(deps: PanelDeps, feature: ListenFeature, body: unknown): unknown {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.enabled !== 'boolean') throw new HttpError(400, 'enabled 必须是布尔值');
  const login = deps.listen!.login();
  const enabled = setListen(deps.db, feature, b.enabled, listenReadyFor(feature, login));
  deps.listen!.onChanged();
  return { feature, enabled, setting: listenSetting(deps.db, feature) };
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

/** 关联主播必须存在于监听名单（避免留下悬空引用） */
function checkXBiliUid(db: Db, uid: string | null): void {
  if (uid && !db.getStreamer(uid)) throw new HttpError(400, `关联主播不在监听名单: ${uid}`);
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
    return { source: 'panel', count: v.split(',').map((s) => s.trim()).filter(Boolean).length, value: v };
  }
  return { source: 'unset', count: 0, value: null };
}

function llmInfo(deps: PanelDeps): unknown {
  const list = deps.llm!.store?.list() ?? [];
  const routes = deriveRoutes(list);
  const statusByName = new Map((deps.llm!.router?.describe() ?? []).map((s) => [s.name, s.status]));
  return {
    enabled: isLlmEnabled(deps.db),
    providers: list.map((p) => ({
      name: p.name,
      baseURL: p.baseURL,
      model: p.model,
      vision: p.vision,
      enabled: p.enabled,
      structuredOutput: p.structuredOutput,
      api: p.api,
      routes: (['text', 'vision'] as const).filter((r) => routes[r].includes(p.name)),
      status: statusByName.get(p.name) ?? null,
      key: llmKeySource(deps.db, p),
    })),
  };
}

/**
 * 新增（name=null，POST）/ 更新（PUT）provider。body 经 llmProviderSchema 校验；
 * 名单落 settings 表后回调装配处重建 router，热生效。
 */
function putLlmProvider(deps: PanelDeps, name: string | null, body: unknown): unknown {
  const store = deps.llm!.store!;
  const list = store.list();
  const b = (body ?? {}) as Record<string, unknown>;

  let merged: unknown;
  if (name === null) {
    merged = b;
  } else {
    const prev = list.find((p) => p.name === name);
    if (!prev) throw new HttpError(404, 'provider 不存在');
    // 只允许这几个字段进 patch；name 是路径标识，不可改
    const patch: Record<string, unknown> = {};
    for (const k of ['baseURL', 'model', 'vision', 'keyEnvs', 'enabled', 'structuredOutput', 'api'] as const) {
      if (b[k] !== undefined) patch[k] = b[k];
    }
    merged = { ...prev, ...patch };
  }

  const parsed = llmProviderSchema.safeParse(merged);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `${i.path.length ? i.path.join('.') : '(根)'}: ${i.message}`).join('；');
    throw new HttpError(400, `provider 校验失败：${msg}`);
  }
  const provider = parsed.data;

  if (name === null) {
    if (list.some((p) => p.name === provider.name)) {
      throw new HttpError(400, `provider name 重复: ${provider.name}`);
    }
    store.save([...list, provider]);
  } else {
    store.save(list.map((p) => (p.name === name ? provider : p)));
  }
  // 表单可一并提交 key（弹窗编辑体验：一个表单存所有）；空串 = 清除面板填写
  if (typeof b.key === 'string') {
    deps.db.setSetting(`llm_key:${provider.name}`, b.key.trim());
  }
  deps.llm!.onProvidersChanged?.();
  return { ok: true, name: provider.name };
}

/** 排序：names 必须是现有名单的一个排列（长度一致、无重复、无增删），整体重排后落库 */
function putLlmProviderOrder(deps: PanelDeps, body: unknown): unknown {
  const store = deps.llm!.store!;
  const names = (body as Record<string, unknown> | null)?.names;
  if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) {
    throw new HttpError(400, 'names 必须是 provider name 数组');
  }
  if (new Set(names).size !== names.length) {
    throw new HttpError(400, 'names 有重复');
  }
  const list = store.list();
  const byName = new Map(list.map((p) => [p.name, p]));
  if (names.length !== list.length || names.some((n) => !byName.has(n as string))) {
    throw new HttpError(400, 'names 必须与现有 provider 名单一一对应');
  }
  store.save((names as string[]).map((n) => byName.get(n)!));
  deps.llm!.onProvidersChanged?.();
  return { ok: true };
}

/** 保存/清除 key：按 provider 存 settings 表；空 value = 清除已填 key */
function putLlmKey(deps: PanelDeps, body: unknown): unknown {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.provider === 'string' ? b.provider.trim() : '';
  const value = typeof b.value === 'string' ? b.value.trim() : '';
  const list = deps.llm!.store?.list() ?? [];
  const provider = list.find((p) => p.name === name);
  if (!provider) throw new HttpError(404, `provider 不存在: ${name}`);
  if (value && !/^[^\s,]+(\s*,\s*[^\s,]+)*$/.test(value)) {
    throw new HttpError(400, '多个 key 用英文逗号分隔，key 内不能有空格');
  }
  deps.db.setSetting(`llm_key:${name}`, value);
  deps.llm!.router?.refreshKeys();
  return { ok: true, provider: name, key: llmKeySource(deps.db, provider) };
}
