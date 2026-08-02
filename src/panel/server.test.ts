import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Db } from '../core/db.js';
import { createPanelServer, type PanelStatus } from './server.js';
import type { NewClause } from '../core/streamers.js';

interface Fixture {
  db: Db;
  base: string;
}

/** 真实 http.Server 绑临时端口 + 内存库；connection:close 避免 keep-alive 挂住测试进程 */
async function setup(t: import('node:test').TestContext): Promise<Fixture> {
  const db = new Db(':memory:');
  const status: PanelStatus = {
    cookieImported: false, followsEnabled: true,
    notifiers: ['onebot', 'toast'], watchedCount: 0,
    startedAt: Math.floor(Date.now() / 1000),
  };
  const server: Server = createPanelServer({
    db,
    status: () => ({ ...status, watchedCount: db.listWatchedUids().length }),
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

test('GET / 返回内嵌页面，包含四个区块标识', async (t) => {
  const { base } = await setup(t);
  const res = await fetch(base + '/', { headers: { connection: 'close' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const html = await res.text();
  for (const marker of ['监听名单', '候选池', '偏好子句', '系统状态']) {
    assert.ok(html.includes(marker), `页面应包含「${marker}」`);
  }
});

// ---- streamers ----

test('GET /api/streamers + PUT 部分更新（未提供字段保留原值）', async (t) => {
  const { db, base } = await setup(t);
  db.upsertStreamer({ uid: '1001', uname: '阿梓', alias: '梓宝', mode: 'on' });
  db.upsertStreamer({ uid: '1002', uname: '小可', mode: 'silent' });

  const list = await api(base, '/api/streamers');
  assert.equal(list.status, 200);
  const streamers = list.json['streamers'] as Array<{ uid: string }>;
  assert.deepEqual(streamers.map((s) => s.uid), ['1001', '1002']);

  const r = await api(base, '/api/streamers/1001', 'PUT', { mode: 'silent', analyze: true });
  assert.equal(r.status, 200);
  const s = db.getStreamer('1001')!;
  assert.equal(s.mode, 'silent');
  assert.equal(s.analyze, true);
  assert.equal(s.alias, '梓宝', '未提供的字段保留原值');
});

test('PUT /api/streamers 校验：坏 uid / 未知 uid / 坏 mode / 未知字段 / 坏 JSON / 空补丁', async (t) => {
  const { db, base } = await setup(t);
  db.upsertStreamer({ uid: '1001' });

  assert.equal((await api(base, '/api/streamers/abc', 'PUT', { mode: 'on' })).status, 400);
  assert.equal((await api(base, '/api/streamers/9999', 'PUT', { mode: 'on' })).status, 404);

  const badMode = await api(base, '/api/streamers/1001', 'PUT', { mode: 'banana' });
  assert.equal(badMode.status, 400);
  assert.match(badMode.json.error ?? '', /mode/);

  assert.equal((await api(base, '/api/streamers/1001', 'PUT', { nickname: 'x' })).status, 400);
  assert.equal((await api(base, '/api/streamers/1001', 'PUT', {})).status, 400);

  const badJson = await api(base, '/api/streamers/1001', 'PUT', undefined, '{oops');
  assert.equal(badJson.status, 400);
  assert.match(badJson.json.error ?? '', /JSON/);
});

// ---- 候选池一键加入 ----

test('POST /api/streamers/:uid/watch：候选池加入 / 重复 409 / mode=off 重新打开', async (t) => {
  const { db, base } = await setup(t);
  db.upsertFollows([{ uid: '2001', uname: '阿梓' }]);
  db.upsertStreamer({ uid: '2002', uname: '旧人', mode: 'off', alias: '保留我' });

  const r = await api(base, '/api/streamers/2001/watch', 'POST');
  assert.equal(r.status, 200);
  const s = db.getStreamer('2001')!;
  assert.equal(s.mode, 'on');
  assert.equal(s.source, 'follows');
  assert.equal(s.uname, '阿梓', 'uname 从 follows 预填');

  const dup = await api(base, '/api/streamers/2001/watch', 'POST');
  assert.equal(dup.status, 409, '已在名单（mode!=off）不得重复加入');

  const re = await api(base, '/api/streamers/2002/watch', 'POST');
  assert.equal(re.status, 200);
  assert.equal(db.getStreamer('2002')!.mode, 'on', 'mode=off 的已有条目重新打开');
  assert.equal(db.getStreamer('2002')!.alias, '保留我', '已有字段不被覆盖');
});

test('GET /api/follows：只回 is_followed=1 并标注 watched', async (t) => {
  const { db, base } = await setup(t);
  db.upsertFollows([{ uid: '2001', uname: 'A' }, { uid: '2002', uname: 'B' }]);
  db.markFollowsSynced(['2001'], 1_800_000_000); // 2002 取关
  db.upsertStreamer({ uid: '2001', mode: 'on' });

  const r = await api(base, '/api/follows');
  assert.equal(r.status, 200);
  const follows = r.json['follows'] as Array<{ uid: string; watched: boolean }>;
  assert.deepEqual(follows, [{ uid: '2001', uname: 'A', watched: true }]);
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

test('GET /api/status 返回装配处注入的状态', async (t) => {
  const { db, base } = await setup(t);
  db.upsertStreamer({ uid: '1001', mode: 'on' });
  db.upsertStreamer({ uid: '1002', mode: 'off' });

  const r = await api(base, '/api/status');
  assert.equal(r.status, 200);
  assert.equal(r.json['cookieImported'], false);
  assert.equal(r.json['followsEnabled'], true);
  assert.deepEqual(r.json['notifiers'], ['onebot', 'toast']);
  assert.equal(r.json['watchedCount'], 1, '只数 mode!=off');
  assert.ok(typeof r.json['startedAt'] === 'number');
});

test('未知路由 404 + 中文错误', async (t) => {
  const { base } = await setup(t);
  const r = await api(base, '/api/nope');
  assert.equal(r.status, 404);
  assert.match(r.json.error ?? '', /未知路由/);
});
