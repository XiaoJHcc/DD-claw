/**
 * 控制面板 v1：同进程 node:http，零框架零依赖，只绑 127.0.0.1。
 * 只读写 DB（业务进程每轮查库，改库即生效）；启动失败不影响主流程（装配处兜底）。
 * 扫码登录路由仅在装配处注入 auth dep 时挂载；cookie 值不出现在任何响应/日志里。
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { makeLogger } from '../logger.js';
import type { Db } from '../core/db.js';
import type { Streamer, StreamerInput } from '../core/streamers.js';
import {
  HttpError, checkCategoryConditions, checkChannelShape, parseCategoryPatch, parseChannelPatch,
  parseNewCategory, parseNewChannel, parseNewRule, parseRulePatch,
  parseStreamerPatch, parseUid, readJsonBody, sendJson,
} from './http-util.js';
import { PANEL_PAGE } from './page.js';
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
import { deriveRoutes, isLlmEnabled, setLlmEnabled, type LlmRouter } from '../analysis/providers.js';
import { isListenEnabled, listenSetting, setListen, type ListenFeature } from '../core/listen.js';
import {
  getRuntimeConfig, saveRuntimeConfig, NUM_SPECS, BOOL_SPECS, type RuntimeConfig,
} from '../core/runtime-config.js';
import { isPushEnabled, setPushEnabled } from '../core/push.js';
import type { NapcatConfig, ProbeResult } from '../notify/napcat.js';
import { getNapcatAlertQq } from '../notify/napcat.js';

const log = makeLogger('panel');

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
    /** 平台登录态（联动开关默认值用）：bili=动态、weibo=微博 */
    login: () => { bili: boolean; weibo: boolean };
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
  /** 关键帧缓存目录（/api/snapshot 按鼠标时间点取最近帧）；不注入则 /api/snapshot 一律 404 */
  snapshots?: {
    dir: string;
  };
  /**
   * NapCat 托管（面板 NapCat 卡片）；不注入则 /api/napcat* 一律 404。
   * 配置事实来源是 settings 表（唯一信源，config.json 仅首次启动种子导入），
   * 保存在装配处闭包里热生效。
   */
  napcat?: {
    /** 生效配置与来源标注（panel/config） */
    effective: () => NapcatConfig;
    source: () => { enabled: 'panel' | 'config'; dir: 'panel' | 'config'; uin: 'panel' | 'config' };
    save: (patch: { enabled?: boolean; dir?: string; uin?: string; alertQq?: string }) => void;
    /** 实时状态：发现的端点 + 三态探测 + 计划任务是否已建 */
    state: () => Promise<{ endpoint: string | null; probe: ProbeResult | null; taskRegistered: boolean }>;
    /** 手动拉起；失败抛中文错（如计划任务未创建） */
    launch: () => Promise<void>;
    /** 一次性创建「最高权限」计划任务（主机弹一次 UAC） */
    setupTask: () => Promise<void>;
  };
}

export function createPanelServer(deps: PanelDeps): http.Server {
  // 微博扫码会话：generate 存 qrid，poll 凭它查状态（单人面板，无需多会话）
  const weiboSession = { qrid: null as string | null };
  return http.createServer((req, res) => {
    handle(deps, weiboSession, req, res).catch((e: unknown) => {
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

  if (method === 'GET' && path === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PANEL_PAGE);
    return;
  }
  if (method === 'GET' && path === '/api/status') {
    sendJson(res, 200, deps.status());
    return;
  }
  // ---- 监听功能开关（listen dep 存在才挂）：动态（B站）/ 微博 ----
  if (deps.listen && method === 'GET' && path === '/api/listen') {
    sendJson(res, 200, listenInfo(deps));
    return;
  }
  const lm = path.match(/^\/api\/listen\/(dynamic|weibo)$/);
  if (deps.listen && lm && method === 'PUT') {
    sendJson(res, 200, putListen(deps, lm[1] as ListenFeature, await readJsonBody(req)));
    return;
  }

  // ---- NapCat 托管（napcat dep 存在才挂）：配置（settings 覆盖 > config）+ 状态 + 手动操作 ----
  if (deps.napcat && method === 'GET' && path === '/api/napcat') {
    const st = await deps.napcat.state();
    sendJson(res, 200, { ...deps.napcat.effective(), alertQq: getNapcatAlertQq(db), source: deps.napcat.source(), ...st });
    return;
  }
  if (deps.napcat && method === 'PUT' && path === '/api/napcat') {
    const b = (await readJsonBody(req)) as Record<string, unknown>;
    const patch: { enabled?: boolean; dir?: string; uin?: string; alertQq?: string } = {};
    if (b.enabled !== undefined) {
      if (typeof b.enabled !== 'boolean') throw new HttpError(400, 'enabled 必须是布尔值');
      patch.enabled = b.enabled;
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
    deps.napcat.save(patch);
    sendJson(res, 200, { ok: true, ...deps.napcat.effective(), alertQq: getNapcatAlertQq(db) });
    return;
  }
  // ---- 高级设置（运行时参数；settings 唯一信源，无 dep 也挂载，onChanged 缺省则只落库） ----
  if (method === 'GET' && path === '/api/advanced') {
    sendJson(res, 200, getRuntimeConfig(db));
    return;
  }
  if (method === 'PUT' && path === '/api/advanced') {
    const b = (await readJsonBody(req)) as Record<string, unknown>;
    const patch: Record<string, number | boolean> = {};
    for (const s of NUM_SPECS) {
      const v = b[s.field];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < s.min || v > s.max) {
        throw new HttpError(400, `${s.label}必须是 ${s.min}~${s.max} 的整数`);
      }
      patch[s.field] = v;
    }
    for (const s of BOOL_SPECS) {
      const v = b[s.field];
      if (v === undefined) continue;
      if (typeof v !== 'boolean') throw new HttpError(400, `${s.label}必须是布尔值`);
      patch[s.field] = v;
    }
    if (Object.keys(patch).length === 0) throw new HttpError(400, '没有可保存的字段');
    saveRuntimeConfig(db, patch as Partial<RuntimeConfig>);
    deps.advanced?.onChanged();
    sendJson(res, 200, { ok: true, ...getRuntimeConfig(db) });
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
    // 路径安全：库里的 path resolve 后必须落在注入的缓存目录内（防库被写脏后路径穿越）
    const root = resolve(deps.snapshots.dir);
    const file = resolve(row.path);
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

  if (deps.napcat && method === 'POST' && path === '/api/napcat/launch') {
    try {
      await deps.napcat.launch();
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    sendJson(res, 200, { ok: true });
    return;
  }
  if (deps.napcat && method === 'POST' && path === '/api/napcat/setup') {
    try {
      await deps.napcat.setupTask();
    } catch (e) {
      throw new HttpError(500, (e as Error).message);
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

  throw new HttpError(404, '未知路由');
}

// ---- 时间表（/api/schedule）----
// 日界固定北京时间（UTC+8）凌晨 6 点，与主机时区无关；仅用于归属：
// 6 点后开播算当天，6 点前开播算前一天，跨 6 点的场次整体按开播日归属。

const DAY_SEC = 86400;

/** 日串 YYYY-MM-DD → 该日界日的起点 ts（当天北京时间 06:00）。格式/合法性错误 → 400 */
function scheduleDayStart(day: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new HttpError(400, '日期必须是 YYYY-MM-DD 格式');
  const ms = Date.parse(day + 'T06:00:00+08:00');
  if (Number.isNaN(ms)) throw new HttpError(400, `不是合法日期: ${day}`);
  return Math.floor(ms / 1000);
}

/** ts → 日界日串（scheduleDayStart 的逆运算：06:00 前归前一天）。换算 = ts+2h 的 UTC 日期 */
function scheduleDayKey(tsSec: number): string {
  return new Date((tsSec + 7200) * 1000).toISOString().slice(0, 10);
}

/** 北京时间今天（from/to 缺省值基准） */
function beijingToday(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 日串加减天数（按 UTC 正午换算，避开时区/夏令时坑） */
function addDays(day: string, n: number): string {
  return new Date(Date.parse(day + 'T12:00:00Z') + n * DAY_SEC * 1000).toISOString().slice(0, 10);
}

function scheduleInfo(db: Db, from: string | null, to: string | null): unknown {
  const today = beijingToday();
  const fromTs = scheduleDayStart(from ?? addDays(today, -7));
  const toTs = scheduleDayStart(to ?? addDays(today, 1));
  if (fromTs > toTs) throw new HttpError(400, 'from 不能晚于 to');
  if ((toTs - fromTs) / DAY_SEC > 62) throw new HttpError(400, '查询跨度不能超过 62 天');

  // 归属天 = first_seen 的日界日；查询范围 = [from 日界, to 日界 + 1 天)
  const entries = db.listTimeline(fromTs, toTs + DAY_SEC);
  const byDay = new Map<string, unknown[]>();
  for (const e of entries) {
    const k = scheduleDayKey(e.startTs);
    const list = byDay.get(k) ?? [];
    list.push({
      kind: 'live', // kind 预留：schedule（预告）后续加入
      roomId: e.roomId, liveTime: e.liveTime, uid: e.uid, name: e.name, face: e.face,
      startTs: e.startTs, endTs: e.endTs, keyframe: e.keyframe, cover: e.cover,
      segments: e.segments, verdicts: e.verdicts,
    });
    byDay.set(k, list);
  }
  // 无场次的日期也返回空 entries（前端连续渲染）
  const days: Array<{ date: string; entries: unknown[] }> = [];
  for (let d = fromTs; d <= toTs; d += DAY_SEC) {
    const date = scheduleDayKey(d);
    days.push({ date, entries: byDay.get(date) ?? [] });
  }
  return { days };
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

/** 规则引用存在性校验：分类 / 渠道 / 主播（监听名单内）都必须存在。 */
function checkRuleRefs(db: Db, r: { categoryId: number | null; uids: string[]; channels: number[] }): void {
  if (r.categoryId !== null && !db.listCategories().some((c) => c.id === r.categoryId)) {
    throw new HttpError(400, '分类不存在');
  }
  const channelIds = new Set(db.listPushChannels().map((c) => c.id));
  for (const id of r.channels) {
    if (!channelIds.has(id)) throw new HttpError(400, `渠道不存在: ${id}`);
  }
  const streamerUids = new Set(db.listStreamers().map((s) => s.uid));
  for (const uid of r.uids) {
    if (!streamerUids.has(uid)) throw new HttpError(400, `主播不在监听名单: ${uid}`);
  }
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

/** 候选池一键加入监听；已有条目不碰来源，仅 watch=0 时重新打开。新行默认 notify=1、analyze=0。uname/face 从 follows 预填。 */
function watchStreamer(db: Db, uid: string): unknown {
  const existing = db.getStreamer(uid);
  if (existing?.watch) throw new HttpError(409, '该主播已在监听名单');
  if (existing) {
    db.upsertStreamer({ uid, watch: true });
  } else {
    const follow = db.listFollows(true).find((f) => f.uid === uid);
    db.upsertStreamer({ uid, uname: follow?.uname, face: follow?.face ?? null, watch: true, source: 'follows' });
  }
  return { streamer: db.getStreamer(uid) };
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

// ---- 监听功能开关（面板「监听」卡片）----
function listenInfo(deps: PanelDeps): unknown {
  const login = deps.listen!.login();
  const row = (feature: ListenFeature, loggedIn: boolean) => ({
    feature,
    setting: listenSetting(deps.db, feature),
    enabled: isListenEnabled(deps.db, feature, loggedIn),
  });
  return {
    biliLoggedIn: login.bili,
    weiboLoggedIn: login.weibo,
    platforms: deps.status().platforms,
    rows: {
      dynamic: row('dynamic', login.bili),
      weibo: row('weibo', login.weibo),
    },
  };
}

function putListen(deps: PanelDeps, feature: ListenFeature, body: unknown): unknown {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.enabled !== 'boolean') throw new HttpError(400, 'enabled 必须是布尔值');
  const login = deps.listen!.login();
  const loggedIn = feature === 'dynamic' ? login.bili : login.weibo;
  const enabled = setListen(deps.db, feature, b.enabled, loggedIn);
  deps.listen!.onChanged();
  return { feature, enabled, setting: listenSetting(deps.db, feature) };
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
