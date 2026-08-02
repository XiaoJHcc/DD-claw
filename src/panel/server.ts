/**
 * 控制面板 v1：同进程 node:http，零框架零依赖，只绑 127.0.0.1。
 * 只读写 DB（业务进程每轮查库，改库即生效）；启动失败不影响主流程（装配处兜底）。
 * 扫码登录路由仅在装配处注入 auth dep 时挂载；cookie 值不出现在任何响应/日志里。
 */
import http from 'node:http';
import { makeLogger } from '../logger.js';
import type { Db } from '../core/db.js';
import type { Priority } from '../core/streamers.js';
import {
  HttpError, parseClausePatch, parseNewClause, parseStreamerPatch, parseUid,
  readJsonBody, sendJson,
} from './http-util.js';
import { PANEL_PAGE } from './page.js';
import { cookieHeader, fetchSelf, loadCookies, saveCookies, type SelfInfo } from '../sources/bili/auth.js';
import { generateQrcode, pollQrcode } from '../sources/bili/qrcode.js';

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
  /** 扫码登录支持；不注入则 /api/auth/* 一律 404 */
  auth?: {
    cookiePath: string;
    /** 新 cookie 落盘后的热重启回调（参数是拼好的 Cookie 头，绝不进日志） */
    onCookiesSaved: (cookieHeader: string) => void;
    /** 注入点供测试；缺省用真实 passport 客户端 */
    qrcode?: { generateQrcode: typeof generateQrcode; pollQrcode: typeof pollQrcode };
    /** 注入点供测试；confirmed 后用新 cookie 查一次 nav 拿 mid */
    selfFetcher?: (cookie: string) => Promise<SelfInfo>;
  };
}

export function createPanelServer(deps: PanelDeps): http.Server {
  return http.createServer((req, res) => {
    handle(deps, req, res).catch((e: unknown) => {
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
  if (method === 'GET' && path === '/api/streamers') {
    sendJson(res, 200, { streamers: enrichedStreamers(db) });
    return;
  }
  if (method === 'GET' && path === '/api/follows') {
    const modes = new Map(db.listStreamers().map((s) => [s.uid, s.mode]));
    const follows = db.listFollows(true).map((f) => ({
      uid: f.uid,
      uname: f.uname,
      face: f.face,
      watched: (modes.get(f.uid) ?? 'off') !== 'off',
    }));
    sendJson(res, 200, { follows });
    return;
  }
  if (method === 'GET' && path === '/api/clauses') {
    sendJson(res, 200, { clauses: db.listClauses() });
    return;
  }
  if (method === 'POST' && path === '/api/clauses') {
    const id = db.insertClause(parseNewClause(await readJsonBody(req)));
    sendJson(res, 201, { id });
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

  const sm = path.match(/^\/api\/streamers\/([^/]+?)(\/watch)?$/);
  if (sm) {
    const uid = parseUid(sm[1]);
    if (sm[2] && method === 'POST') {
      sendJson(res, 200, watchStreamer(db, uid));
      return;
    }
    if (!sm[2] && method === 'PUT') {
      if (!db.getStreamer(uid)) throw new HttpError(404, '该 uid 不在监听名单');
      db.upsertStreamer({ uid, ...parseStreamerPatch(await readJsonBody(req)) });
      sendJson(res, 200, { streamer: db.getStreamer(uid) });
      return;
    }
  }

  const cm = path.match(/^\/api\/clauses\/([^/]+)$/);
  if (cm) {
    const id = Number(parseUid(cm[1], 'id'));
    if (method === 'PUT') {
      if (!db.updateClause(id, parseClausePatch(await readJsonBody(req)))) {
        throw new HttpError(404, '子句不存在');
      }
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === 'DELETE') {
      if (!db.deleteClause(id)) throw new HttpError(404, '子句不存在');
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  throw new HttpError(404, '未知路由');
}

const PRIORITY_RANK: Record<Priority, number> = { high: 3, normal: 2, low: 1 };

/** 名单 + face + 实况（room_state）+ 子句摘要。一次请求内三表各只查一次。 */
function enrichedStreamers(db: Db): unknown[] {
  const streamers = db.listStreamers();
  const roomStates = db.listRoomStatesFull();
  const clauseMap = new Map<string, { count: number; maxPriority: Priority | null }>();
  for (const c of db.listClauses()) {
    const agg = clauseMap.get(c.uid) ?? { count: 0, maxPriority: null };
    agg.count++;
    if (agg.maxPriority === null || PRIORITY_RANK[c.priority] > PRIORITY_RANK[agg.maxPriority]) {
      agg.maxPriority = c.priority;
    }
    clauseMap.set(c.uid, agg);
  }
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
      clauses: clauseMap.get(s.uid) ?? { count: 0, maxPriority: null },
    };
  });
}

/** 候选池一键加入监听；已有条目不碰来源，仅 mode=off 时重新打开。uname/face 从 follows 预填。 */
function watchStreamer(db: Db, uid: string): unknown {
  const existing = db.getStreamer(uid);
  if (existing && existing.mode !== 'off') throw new HttpError(409, '该主播已在监听名单');
  if (existing) {
    db.upsertStreamer({ uid, mode: 'on' });
  } else {
    const follow = db.listFollows(true).find((f) => f.uid === uid);
    db.upsertStreamer({ uid, uname: follow?.uname, face: follow?.face ?? null, mode: 'on', source: 'follows' });
  }
  return { streamer: db.getStreamer(uid) };
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
