import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../core/db.js';
import { createPanelServer, type PanelDeps, type PanelStatus } from './server.js';
import type { NewClause } from '../core/streamers.js';

interface Fixture {
  db: Db;
  base: string;
}

/** 真实 http.Server 绑临时端口 + 内存库；connection:close 避免 keep-alive 挂住测试进程 */
async function setup(
  t: import('node:test').TestContext,
  opts: { auth?: PanelDeps['auth']; weiboResolver?: PanelDeps['weiboResolver'] } = {},
): Promise<Fixture> {
  const db = new Db(':memory:');
  const status: PanelStatus = {
    startedAt: Math.floor(Date.now() / 1000),
    notifiers: ['onebot', 'toast'],
    watchedCount: 0,
    liveCount: 0,
    platforms: [
      { key: 'bili', name: 'B站', state: 'ok', mid: '999' },
      { key: 'weibo', name: '微博', state: 'reserved' },
    ],
  };
  const server: Server = createPanelServer({
    db,
    weiboResolver: opts.weiboResolver,
    status: () => ({
      ...status,
      watchedCount: db.listWatchedUids().length,
      liveCount: db.countLiveRooms(),
    }),
    auth: opts.auth,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  const { port } = server.address() as AddressInfo;
  return { db, base: `http://127.0.0.1:${port}` };
}

interface ApiResult {
  status: number;
  json: Record<string, unknown> & { error?: string };
}

async function api(
  base: string, path: string, method = 'GET', body?: unknown, rawBody?: string,
): Promise<ApiResult> {
  const res = await fetch(base + path, {
    method,
    headers: { connection: 'close', ...(body !== undefined || rawBody ? { 'content-type': 'application/json' } : {}) },
    body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const json = (await res.json().catch(() => null)) as ApiResult['json'] | null;
  return { status: res.status, json: json ?? {} };
}

function clause(over: Partial<NewClause> = {}): Record<string, unknown> {
  return {
    uid: '1001', scenes: ['singing'], minConfidence: 0.7, titleKeywords: ['歌回'],
    priority: 'high', messageTemplate: '{alias} 开歌回了',
    targets: [{ type: 'group', id: '123456' }], enabled: true,
    ...over,
  };
}

// ---- 页面 ----

test('GET / 返回内嵌页面，包含三个卡片与关注未监听区', async (t) => {
  const { base } = await setup(t);
  const res = await fetch(base + '/', { headers: { connection: 'close' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const html = await res.text();
  for (const marker of ['运行状态', '直播计划时间表', '主播列表', '关注未监听']) {
    assert.ok(html.includes(marker), `页面应包含「${marker}」`);
  }
});

// ---- streamers（含 face / live / clauses 摘要）----

test('GET /api/streamers：enrich face / live=null / clauses 摘要与 maxPriority 排序', async (t) => {
  const { db, base } = await setup(t);
  db.upsertStreamer({ uid: '1001', uname: '阿梓', face: 'https://i0.hdslb.com/f1.jpg' });
  db.upsertStreamer({ uid: '1002', uname: '小可' });
  db.insertClause({ uid: '1001', scenes: [], minConfidence: null, titleKeywords: [],
    priority: 'low', messageTemplate: '', targets: null, enabled: true });
  db.insertClause({ uid: '1001', scenes: [], minConfidence: null, titleKeywords: [],
    priority: 'high', messageTemplate: '', targets: null, enabled: false });
  db.insertClause({ uid: '1001', scenes: [], minConfidence: null, titleKeywords: [],
    priority: 'normal', messageTemplate: '', targets: null, enabled: true });

  const r = await api(base, '/api/streamers');
  assert.equal(r.status, 200);
  const list = r.json['streamers'] as Array<{
    uid: string; face: string | null; roomId: string | null;
    watch: boolean; notify: boolean; analyze: boolean;
    weiboNick: string | null; weiboUid: string | null;
    live: unknown; clauses: { count: number; maxPriority: string | null };
  }>;
  const s1 = list.find((s) => s.uid === '1001')!;
  const s2 = list.find((s) => s.uid === '1002')!;
  assert.equal(s1.face, 'https://i0.hdslb.com/f1.jpg');
  assert.equal(s2.face, null);
  assert.deepEqual([s1.watch, s1.notify, s1.analyze], [true, true, false], '三开关注出布尔');
  assert.equal(s1.weiboNick, null);
  assert.equal(s1.weiboUid, null);
  assert.equal(s1.roomId, null);
  assert.equal(s1.live, null, '无 room_state 记录时 live=null');
  assert.deepEqual(s1.clauses, { count: 3, maxPriority: 'high' },
    'maxPriority 取最高档（high>normal>low），disabled 子句也计入');
  assert.deepEqual(s2.clauses, { count: 0, maxPriority: null });
});

test('GET /api/streamers：有 room_state 时 live 带实况字段与下播锚点', async (t) => {
  const { db, base } = await setup(t);
  db.upsertStreamer({ uid: '1001', uname: '阿梓', roomId: '80397' });
  db.upsertStreamer({ uid: '1002', uname: '小可' });
  db.saveRoomState('1001', {
    roomId: '80397', isLive: true, liveTime: 1_800_000_000, title: '唱歌',
    areaName: '虚拟主播', parentAreaName: 'Vtuber', keyframe: 'https://kf.jpg',
    cover: 'https://cv.jpg', online: 1234, face: '',
  });
  db.saveRoomState('1002', {
    roomId: '999', isLive: false, liveTime: 0, title: '上一场标题',
    areaName: '', parentAreaName: '', keyframe: '', cover: '', online: 0, face: '',
  });

  const r = await api(base, '/api/streamers');
  const list = r.json['streamers'] as Array<{
    uid: string;
    live: {
      isLive: boolean; title: string; liveTime: number; roomId: string;
      areaName: string; parentAreaName: string; keyframe: string; cover: string;
      online: number; lastLiveAt: number | null; polledAt: number;
    } | null;
  }>;
  const live1 = list.find((s) => s.uid === '1001')!.live!;
  assert.equal(live1.isLive, true);
  assert.equal(live1.title, '唱歌');
  assert.equal(live1.liveTime, 1_800_000_000);
  assert.equal(live1.roomId, '80397', '展示值优先 streamer.roomId');
  assert.equal(live1.areaName, '虚拟主播');
  assert.equal(live1.parentAreaName, 'Vtuber');
  assert.equal(live1.keyframe, 'https://kf.jpg');
  assert.equal(live1.cover, 'https://cv.jpg');
  assert.equal(live1.online, 1234);
  assert.ok(
    live1.lastLiveAt !== null && Math.abs(live1.lastLiveAt - Date.now() / 1000) < 60,
    '在播时 lastLiveAt=本轮落库时间（下播时长锚点）',
  );
  assert.ok(live1.polledAt > 0);

  const live2 = list.find((s) => s.uid === '1002')!.live!;
  assert.equal(live2.isLive, false);
  assert.equal(live2.roomId, '999', 'streamer.roomId 为空时回落 room_state.roomId');
  assert.equal(live2.lastLiveAt, null, '从未观测到在播时 lastLiveAt=null');
  assert.equal(live2.title, '上一场标题', '下播后保留上一场标题供展示');
});

test('PUT /api/streamers 部分更新（未提供字段保留原值）', async (t) => {
  const { db, base } = await setup(t);
  db.upsertStreamer({ uid: '1001', uname: '阿梓', alias: '梓宝' });

  const r = await api(base, '/api/streamers/1001', 'PUT', { notify: false, analyze: true });
  assert.equal(r.status, 200);
  const s = db.getStreamer('1001')!;
  assert.equal(s.notify, false);
  assert.equal(s.analyze, true);
  assert.equal(s.watch, true, '未提供的开关保留原值');
  assert.equal(s.alias, '梓宝', '未提供的字段保留原值');
});

test('PUT /api/streamers 校验：坏 uid / 未知 uid / 旧 mode 字段 / 未知字段 / 坏 JSON / 空补丁', async (t) => {
  const { db, base } = await setup(t);
  db.upsertStreamer({ uid: '1001' });

  assert.equal((await api(base, '/api/streamers/abc', 'PUT', { watch: true })).status, 400);
  assert.equal((await api(base, '/api/streamers/9999', 'PUT', { watch: true })).status, 404);

  const oldMode = await api(base, '/api/streamers/1001', 'PUT', { mode: 'on' });
  assert.equal(oldMode.status, 400, '旧 mode 字段不再可写');
  assert.match(oldMode.json.error ?? '', /未知字段/);

  const badBool = await api(base, '/api/streamers/1001', 'PUT', { watch: 'yes' });
  assert.equal(badBool.status, 400);
  assert.match(badBool.json.error ?? '', /watch/);

  assert.equal((await api(base, '/api/streamers/1001', 'PUT', { nickname: 'x' })).status, 400);
  assert.equal((await api(base, '/api/streamers/1001', 'PUT', {})).status, 400);
  assert.equal((await api(base, '/api/streamers/1001', 'PUT', { roomId: '123' })).status, 400,
    'roomId 不再可写（轮询自动回填）');

  const badJson = await api(base, '/api/streamers/1001', 'PUT', undefined, '{oops');
  assert.equal(badJson.status, 400);
  assert.match(badJson.json.error ?? '', /JSON/);
});

// ---- weiboNick：昵称→UID 解析（mock resolver）----

test('PUT weiboNick：解析成功 → weibo_nick + weibo_uid 一起入库', async (t) => {
  const calls: string[] = [];
  const { db, base } = await setup(t, {
    weiboResolver: { resolveUid: async (nick) => { calls.push(nick); return '2203177060'; } },
  });
  db.upsertStreamer({ uid: '1001', uname: '阿梓' });

  const r = await api(base, '/api/streamers/1001', 'PUT', { weiboNick: '阿梓从小就很可爱' });
  assert.equal(r.status, 200);
  assert.deepEqual(calls, ['阿梓从小就很可爱']);
  const s = db.getStreamer('1001')!;
  assert.equal(s.weiboNick, '阿梓从小就很可爱');
  assert.equal(s.weiboUid, '2203177060');
  const body = r.json['streamer'] as { weiboNick: string; weiboUid: string };
  assert.equal(body.weiboUid, '2203177060', '响应里也带解析结果');

  // 与现值相同 → 不重复解析
  const again = await api(base, '/api/streamers/1001', 'PUT', { weiboNick: '阿梓从小就很可爱' });
  assert.equal(again.status, 200);
  assert.equal(calls.length, 1, '昵称未变化时不重复解析');
});

test('PUT weiboNick：昵称不存在 400 / 解析器异常 400 / 未注入 resolver 400', async (t) => {
  const { db, base } = await setup(t, {
    weiboResolver: {
      resolveUid: async (nick) => {
        if (nick === '不存在的人') return null;
        throw new Error('微博访客令牌申请失败（HTTP 500）');
      },
    },
  });
  db.upsertStreamer({ uid: '1001' });

  const notFound = await api(base, '/api/streamers/1001', 'PUT', { weiboNick: '不存在的人' });
  assert.equal(notFound.status, 400);
  assert.match(notFound.json.error ?? '', /找不到这个昵称/);
  assert.equal(db.getStreamer('1001')?.weiboNick, null, '失败不入库');

  const netErr = await api(base, '/api/streamers/1001', 'PUT', { weiboNick: '别人' });
  assert.equal(netErr.status, 400);
  assert.match(netErr.json.error ?? '', /解析失败/);
  assert.match(netErr.json.error ?? '', /HTTP 500/, '带上解析器给的原因');

  const noResolver = await setup(t);
  noResolver.db.upsertStreamer({ uid: '1001' });
  const r = await api(noResolver.base, '/api/streamers/1001', 'PUT', { weiboNick: '阿梓' });
  assert.equal(r.status, 400);
  assert.match(r.json.error ?? '', /微博解析不可用/);
});

test('PUT weiboNick：传空 → weibo_nick 与 weibo_uid 一起清空', async (t) => {
  const { db, base } = await setup(t, {
    weiboResolver: { resolveUid: async () => { throw new Error('不该被调用'); } },
  });
  db.upsertStreamer({ uid: '1001', weiboNick: '阿梓从小就很可爱', weiboUid: '2203177060' });

  const r = await api(base, '/api/streamers/1001', 'PUT', { weiboNick: '' });
  assert.equal(r.status, 200);
  const s = db.getStreamer('1001')!;
  assert.equal(s.weiboNick, null);
  assert.equal(s.weiboUid, null, '清空时 uid 一起清');
});

// ---- 候选池一键加入 ----

test('POST /api/streamers/:uid/watch：候选池加入（拷 uname+face）/ 重复 409 / watch=0 重新打开', async (t) => {
  const { db, base } = await setup(t);
  db.upsertFollows([{ uid: '2001', uname: '阿梓', face: 'https://i0.hdslb.com/f1.jpg' }]);
  db.upsertStreamer({ uid: '2002', uname: '旧人', watch: false, alias: '保留我' });

  const r = await api(base, '/api/streamers/2001/watch', 'POST');
  assert.equal(r.status, 200);
  const s = db.getStreamer('2001')!;
  assert.equal(s.watch, true);
  assert.equal(s.notify, true, '新行默认 notify=1');
  assert.equal(s.analyze, false, '新行默认 analyze=0');
  assert.equal(s.source, 'follows');
  assert.equal(s.uname, '阿梓', 'uname 从 follows 预填');
  assert.equal(s.face, 'https://i0.hdslb.com/f1.jpg', 'face 也从 follows 拷贝');

  const dup = await api(base, '/api/streamers/2001/watch', 'POST');
  assert.equal(dup.status, 409, '已在名单（watch=1）不得重复加入');

  const re = await api(base, '/api/streamers/2002/watch', 'POST');
  assert.equal(re.status, 200);
  assert.equal(db.getStreamer('2002')!.watch, true, 'watch=0 的已有条目重新打开');
  assert.equal(db.getStreamer('2002')!.alias, '保留我', '已有字段不被覆盖');
});

test('GET /api/follows：只回 is_followed=1，带 face 并标注 watched', async (t) => {
  const { db, base } = await setup(t);
  db.upsertFollows([
    { uid: '2001', uname: 'A', face: 'https://i0.hdslb.com/fa.jpg' },
    { uid: '2002', uname: 'B' },
  ]);
  db.markFollowsSynced(['2001'], 1_800_000_000); // 2002 取关
  db.upsertStreamer({ uid: '2001', watch: true });

  const r = await api(base, '/api/follows');
  assert.equal(r.status, 200);
  const follows = r.json['follows'] as Array<{ uid: string; face: string | null; watched: boolean }>;
  assert.deepEqual(follows, [
    { uid: '2001', uname: 'A', face: 'https://i0.hdslb.com/fa.jpg', watched: true },
  ]);
});

// ---- preference_clauses ----

test('clause CRUD：POST → GET（含 disabled）→ PUT → DELETE', async (t) => {
  const { db, base } = await setup(t);
  db.upsertStreamer({ uid: '1001' });

  const created = await api(base, '/api/clauses', 'POST', clause());
  assert.equal(created.status, 201);
  const id = (created.json as { id: number }).id;
  assert.ok(id > 0);
  await api(base, '/api/clauses', 'POST', clause({ enabled: false }));

  const list = await api(base, '/api/clauses');
  const clauses = list.json['clauses'] as Array<{ id: number; enabled: boolean }>;
  assert.equal(clauses.length, 2, 'listClauses 含 disabled 子句');

  const patched = await api(base, `/api/clauses/${id}`, 'PUT', { priority: 'low', targets: null });
  assert.equal(patched.status, 200);
  const c = db.listClauses().find((x) => x.id === id)!;
  assert.equal(c.priority, 'low');
  assert.equal(c.targets, null);
  assert.equal(c.messageTemplate, '{alias} 开歌回了', '未提供字段保留');

  assert.equal((await api(base, `/api/clauses/${id}`, 'DELETE')).status, 200);
  assert.equal((await api(base, `/api/clauses/${id}`, 'DELETE')).status, 404, '重复删除 404');
});

test('clause 校验：坏 uid / 坏 scenes / 坏 targets / 坏置信度 / 坏 id / 缺失行 404 / 超大请求体', async (t) => {
  const { base } = await setup(t);

  assert.equal((await api(base, '/api/clauses', 'POST', clause({ uid: 'abc' }))).status, 400);

  const badScene = await api(base, '/api/clauses', 'POST', clause({ scenes: ['dancing'] }));
  assert.equal(badScene.status, 400);
  assert.match(badScene.json.error ?? '', /scenes/);

  assert.equal(
    (await api(base, '/api/clauses', 'POST', clause({ targets: [{ type: 'group', id: 'abc' }] }))).status,
    400,
  );
  assert.equal((await api(base, '/api/clauses', 'POST', clause({ minConfidence: 1.5 }))).status, 400);

  assert.equal((await api(base, '/api/clauses/xyz', 'PUT', { enabled: false })).status, 400);
  assert.equal((await api(base, '/api/clauses/999', 'PUT', { enabled: false })).status, 404);
  assert.equal((await api(base, '/api/clauses/999', 'DELETE')).status, 404);

  const huge = await api(base, '/api/clauses', 'POST', clause({ messageTemplate: 'x'.repeat(70 * 1024) }));
  assert.equal(huge.status, 400);
  assert.match(huge.json.error ?? '', /64KB/);
});

// ---- status / 404 ----

test('GET /api/status 返回装配处注入的新形状状态', async (t) => {
  const { db, base } = await setup(t);
  db.upsertStreamer({ uid: '1001', watch: true });
  db.upsertStreamer({ uid: '1002', watch: false });
  db.saveRoomState('1001', {
    roomId: '80397', isLive: true, liveTime: 1_800_000_000, title: 't',
    areaName: '', parentAreaName: '', keyframe: '', cover: '', online: 0, face: '',
  });

  const r = await api(base, '/api/status');
  assert.equal(r.status, 200);
  assert.ok(typeof r.json['startedAt'] === 'number');
  assert.deepEqual(r.json['notifiers'], ['onebot', 'toast']);
  assert.equal(r.json['watchedCount'], 1, '只数 watch=1');
  assert.equal(r.json['liveCount'], 1, '只数 is_live=1');
  assert.deepEqual(r.json['platforms'], [
    { key: 'bili', name: 'B站', state: 'ok', mid: '999' },
    { key: 'weibo', name: '微博', state: 'reserved' },
  ]);
});

test('未知路由 404 + 中文错误', async (t) => {
  const { base } = await setup(t);
  const r = await api(base, '/api/nope');
  assert.equal(r.status, 404);
  assert.match(r.json.error ?? '', /未知路由/);
});

// ---- 扫码登录 ----

function authFixture(t: import('node:test').TestContext, over: {
  pollStatus?: string; pollCookies?: Record<string, string>;
  onCookiesSaved?: (h: string) => void; selfMid?: string | null;
} = {}): { auth: PanelDeps['auth']; dir: string; savedHeaders: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'ddclaw-panel-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const savedHeaders: string[] = [];
  const auth: PanelDeps['auth'] = {
    cookiePath: join(dir, 'cookies.json'),
    onCookiesSaved: over.onCookiesSaved ?? ((h) => { savedHeaders.push(h); }),
    qrcode: {
      generateQrcode: async () => ({ key: 'k123', url: 'https://bilibili.tv/qr' }),
      pollQrcode: async () => {
        const status = over.pollStatus ?? 'waiting';
        if (status === 'confirmed') {
          return { status: 'confirmed', cookies: over.pollCookies ?? { SESSDATA: 's', bili_jct: 'j' } };
        }
        return { status: status as 'waiting' };
      },
    },
    selfFetcher: async () => ({ isLogin: true, mid: over.selfMid === undefined ? '424242' : over.selfMid }),
  };
  return { auth, dir, savedHeaders };
}

test('POST /api/auth/bili/qrcode 返回 {key,url}', async (t) => {
  const { auth } = authFixture(t);
  const { base } = await setup(t, { auth });
  const r = await api(base, '/api/auth/bili/qrcode', 'POST');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { key: 'k123', url: 'https://bilibili.tv/qr' });
});

test('GET poll：waiting / scanned / expired 透传，不落盘不回调', async (t) => {
  for (const st of ['waiting', 'scanned', 'expired']) {
    const { auth, dir, savedHeaders } = authFixture(t, { pollStatus: st });
    const { base } = await setup(t, { auth });
    const r = await api(base, '/api/auth/bili/qrcode/poll?key=k123');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { status: st });
    assert.equal(existsSync(join(dir, 'cookies.json')), false, `${st} 不得写 cookies.json`);
    assert.equal(savedHeaders.length, 0, `${st} 不得触发 onCookiesSaved`);
  }
});

test('GET poll confirmed：saveCookies 落盘（旧字段兜底）+ onCookiesSaved 回调 + 返回 mid', async (t) => {
  const saved: string[] = [];
  const { auth, dir } = authFixture(t, {
    pollStatus: 'confirmed',
    pollCookies: { SESSDATA: 'new-sess', bili_jct: 'new-jct' },
    onCookiesSaved: (h) => { saved.push(h); },
  });
  // 旧文件：buvid3 等风控字段应被 merge 保留
  writeFileSync(join(dir, 'cookies.json'), JSON.stringify({ SESSDATA: 'old', buvid3: 'keep' }));
  const { base } = await setup(t, { auth });

  const r = await api(base, '/api/auth/bili/qrcode/poll?key=k123');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { status: 'confirmed', mid: '424242' });

  const onDisk = JSON.parse(readFileSync(join(dir, 'cookies.json'), 'utf8')) as Record<string, string>;
  assert.deepEqual(onDisk, { SESSDATA: 'new-sess', bili_jct: 'new-jct', buvid3: 'keep' },
    '新值覆盖、旧的风控字段兜底');

  assert.equal(saved.length, 1, 'onCookiesSaved 被调一次');
  assert.match(saved[0]!, /SESSDATA=new-sess/);
  assert.match(saved[0]!, /buvid3=keep/, '回调拿到的是 merge 后的全量 cookie 头');

  const body = JSON.stringify(r.json) + JSON.stringify(onDisk);
  assert.ok(!body.includes('old'), '旧 SESSDATA 值不出现在任何输出里');
});

test('GET poll 缺 key 400', async (t) => {
  const { auth } = authFixture(t);
  const { base } = await setup(t, { auth });
  const r = await api(base, '/api/auth/bili/qrcode/poll');
  assert.equal(r.status, 400);
  assert.match(r.json.error ?? '', /key/);
});

test('无 auth dep 时扫码路由 404', async (t) => {
  const { base } = await setup(t);
  assert.equal((await api(base, '/api/auth/bili/qrcode', 'POST')).status, 404);
  assert.equal((await api(base, '/api/auth/bili/qrcode/poll?key=k')).status, 404);
});
