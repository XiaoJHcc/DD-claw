/**
 * 控制面板 v0：同进程 node:http，零框架零依赖，只绑 127.0.0.1。
 * 只读写 DB（业务进程每轮查库，改库即生效）；启动失败不影响主流程（装配处兜底）。
 */
import http from 'node:http';
import { makeLogger } from '../logger.js';
import type { Db } from '../core/db.js';
import {
  HttpError, parseClausePatch, parseNewClause, parseStreamerPatch, parseUid,
  readJsonBody, sendJson,
} from './http-util.js';
import { PANEL_PAGE } from './page.js';

const log = makeLogger('panel');

/** 系统状态：由装配处（index.ts）注入回调，面板只展示 */
export interface PanelStatus {
  cookieImported: boolean;
  followsEnabled: boolean;
  notifiers: string[];
  watchedCount: number;
  /** 进程启动时间（秒级时间戳），前端算 uptime */
  startedAt: number;
}

export interface PanelDeps {
  db: Db;
  status: () => PanelStatus;
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
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;

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
    sendJson(res, 200, { streamers: db.listStreamers() });
    return;
  }
  if (method === 'GET' && path === '/api/follows') {
    const modes = new Map(db.listStreamers().map((s) => [s.uid, s.mode]));
    const follows = db.listFollows(true).map((f) => ({
      uid: f.uid,
      uname: f.uname,
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

/** 候选池一键加入监听；已有条目不碰来源，仅 mode=off 时重新打开。 */
function watchStreamer(db: Db, uid: string): unknown {
  const existing = db.getStreamer(uid);
  if (existing && existing.mode !== 'off') throw new HttpError(409, '该主播已在监听名单');
  if (existing) {
    db.upsertStreamer({ uid, mode: 'on' });
  } else {
    const uname = db.listFollows(true).find((f) => f.uid === uid)?.uname;
    db.upsertStreamer({ uid, uname, mode: 'on', source: 'follows' });
  }
  return { streamer: db.getStreamer(uid) };
}
