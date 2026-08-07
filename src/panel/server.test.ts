import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../core/db.js';
import { createPanelServer, type PanelDeps, type PanelStatus } from './server.js';
import { createLlmRouter, seedLlmProvidersIfEmpty, listLlmProviders, saveLlmProviders, dbKeysOf, type LlmRouter, type FetchLike } from '../analysis/providers.js';

interface Fixture {
  db: Db;
  base: string;
  llmRouter?: LlmRouter;
}

/** 记录 listen dep 的 onChanged 被调用次数（面板改开关 → 热启停源） */
let listenChangedCount = 0;

/** 真实 http.Server 绑临时端口 + 内存库；connection:close 避免 keep-alive 挂住测试进程 */
async function setup(
  t: import('node:test').TestContext,
  opts: {
    auth?: PanelDeps['auth']; weiboAuth?: PanelDeps['weiboAuth'];
    weiboResolver?: PanelDeps['weiboResolver']; llm?: PanelDeps['llm'];
    llmFetch?: FetchLike;
    /** 注入 listen dep；缺省不注入（/api/listen* 404） */
    listen?: { bili?: boolean; weibo?: boolean; dynamicEnabled?: boolean; weiboEnabled?: boolean };
  } = {},
): Promise<Fixture> {
  const db = new Db(':memory:');
  const status: PanelStatus = {
    startedAt: Math.floor(Date.now() / 1000),
    notifiers: ['onebot', 'toast'],
    watchedCount: 0,
    liveCount: 0,
    followsCount: 0,
    platforms: [
      { key: 'bili', name: 'B站', state: 'ok', mid: '999' },
      { key: 'weibo', name: '微博', state: 'reserved' },
    ],
  };
  // llm dep：按生产装配方式建（种子 config providers → settings；store 落库；
  // onProvidersChanged 重建 router；key resolver = 面板 settings 覆盖 > process.env）
  let llm: PanelDeps['llm'];
  if (opts.llm) {
    seedLlmProvidersIfEmpty(db, opts.llm.config.providers);
    const dep: PanelDeps['llm'] = {
      config: opts.llm.config,
      store: { list: () => listLlmProviders(db), save: (ps) => saveLlmProviders(db, ps) },
    };
    const build = () => createLlmRouter(
      { ...opts.llm!.config, providers: listLlmProviders(db) },
      dbKeysOf(db),
      opts.llmFetch ? { fetchFn: opts.llmFetch } : undefined,
    );
    dep.router = build();
    dep.onProvidersChanged = () => { dep.router = build(); };
    llm = dep;
  }
  const server: Server = createPanelServer({
    db,
    weiboResolver: opts.weiboResolver,
    status: () => ({
      ...status,
      watchedCount: db.listWatchedUids().length,
      liveCount: db.countLiveRooms(),
    }),
    auth: opts.auth,
    weiboAuth: opts.weiboAuth,
    llm,
    ...(opts.listen
      ? {
          listen: {
            config: {
              dynamic: { enabled: opts.listen.dynamicEnabled ?? true, intervalSec: 300 },
              weibo: { enabled: opts.listen.weiboEnabled ?? true, intervalSec: 300 },
            },
            login: () => ({ bili: opts.listen!.bili ?? false, weibo: opts.listen!.weibo ?? false }),
            onChanged: () => { listenChangedCount++; },
          },
        }
      : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  const { port } = server.address() as AddressInfo;
  return { db, base: `http://127.0.0.1:${port}`, llmRouter: llm?.router };
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

// ---- 页面 ----

test('GET / 返回内嵌页面，包含六张卡片（监听/LLM分析/推送/时间表/主播列表/关注列表）', async (t) => {
  const { base } = await setup(t);
  const res = await fetch(base + '/', { headers: { connection: 'close' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const html = await res.text();
  for (const marker of ['监听', 'LLM 分析', '推送', '直播计划时间表', '主播列表', '关注列表']) {
    assert.ok(html.includes(marker), `页面应包含「${marker}」`);
  }
  // 关注列表是独立卡片（不再嵌在主播列表里），且带搜索框
  assert.ok(html.includes('id="card-follows"'), '关注列表应是独立卡片');
  assert.ok(html.includes('id="follow-search"'), '关注列表应有搜索框');
});

// ---- streamers（含 face / live / rules 摘要）----

test('GET /api/streamers：enrich face / live=null / 规则名标签（含 disabled）', async (t) => {
  const { db, base } = await setup(t);
  db.upsertStreamer({ uid: '1001', uname: '阿梓', face: 'https://i0.hdslb.com/f1.jpg' });
  db.upsertStreamer({ uid: '1002', uname: '小可' });
  db.upsertPushRule({ uid: '1001', name: '歌回', keywords: [], areas: [], channels: [],
    messageTemplate: null, enabled: true });
  db.upsertPushRule({ uid: '1001', name: '杂谈', keywords: ['歌'], areas: [], channels: [],
    messageTemplate: null, enabled: false });

  const r = await api(base, '/api/streamers');
  assert.equal(r.status, 200);
  const list = r.json['streamers'] as Array<{
    uid: string; face: string | null; roomId: string | null;
    watch: boolean; notify: boolean; analyze: boolean;
    weiboNick: string | null; weiboUid: string | null;
    live: unknown; rules: { names: string[] };
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
  assert.deepEqual(s1.rules, { names: ['歌回', '杂谈'] }, '规则名按优先级顺序，disabled 也带上');
  assert.deepEqual(s2.rules, { names: [] });
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

test('GET /api/streamers：enrich 带 posts（pub_ts 倒序取 5，raw 不下发）', async (t) => {
  const { db, base } = await setup(t);
  db.upsertStreamer({ uid: '1001', uname: '阿梓' });
  db.upsertStreamer({ uid: '1002', uname: '小可' });
  const mk = (uid: string, itemId: string, pubTs: number) => ({
    platform: 'bili_dynamic', uid, itemId, type: 'DYNAMIC_TYPE_WORD',
    text: `正文 ${itemId}`, pics: ['https://i0.hdslb.com/p.jpg'], pubTs,
    url: `https://t.bilibili.com/${itemId}`, raw: '{"secret":"不下发"}',
  });
  // 6 条：enrich 只带最近 5
  db.insertPosts([1, 2, 3, 4, 5, 6].map((i) => mk('1001', `a${i}`, 1000 + i)));

  const r = await api(base, '/api/streamers');
  assert.equal(r.status, 200);
  const list = r.json['streamers'] as Array<{
    uid: string;
    posts: Array<{ platform: string; type: string; text: string; pics: string[];
      pubTs: number; url: string; raw?: string }>;
  }>;
  const s1 = list.find((s) => s.uid === '1001')!;
  assert.equal(s1.posts.length, 5, '每主播最多 5 条');
  assert.deepEqual(s1.posts.map((p) => p.text), [
    '正文 a6', '正文 a5', '正文 a4', '正文 a3', '正文 a2',
  ], 'pub_ts 倒序，最旧的一条被截掉');
  assert.equal(s1.posts[0]!.platform, 'bili_dynamic');
  assert.deepEqual(s1.posts[0]!.pics, ['https://i0.hdslb.com/p.jpg']);
  assert.equal(s1.posts[0]!.url, 'https://t.bilibili.com/a6');
  assert.equal(s1.posts[0]!.raw, undefined, 'raw 不下发给前端');
  assert.deepEqual(list.find((s) => s.uid === '1002')!.posts, [], '无动态 = 空数组');
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

// ---- push_channels ----

function channelBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: '粉丝群', notifier: 'onebot', targetType: 'group', targetId: '123456', ...over };
}

test('channel CRUD：POST → GET → PUT → DELETE', async (t) => {
  const { db, base } = await setup(t);

  const created = await api(base, '/api/channels', 'POST', channelBody());
  assert.equal(created.status, 201);
  const id = (created.json as { id: number }).id;
  assert.ok(id > 0);
  await api(base, '/api/channels', 'POST', { name: '系统通知', notifier: 'toast' });

  const list = await api(base, '/api/channels');
  const channels = list.json['channels'] as Array<{ id: number; name: string; enabled: boolean }>;
  assert.equal(channels.length, 2);

  const patched = await api(base, `/api/channels/${id}`, 'PUT', { name: '亲友群', enabled: false });
  assert.equal(patched.status, 200);
  const c = db.listPushChannels().find((x) => x.id === id)!;
  assert.equal(c.name, '亲友群');
  assert.equal(c.enabled, false);
  assert.equal(c.targetId, '123456', '未提供字段保留');

  assert.equal((await api(base, `/api/channels/${id}`, 'DELETE')).status, 200);
  assert.equal((await api(base, `/api/channels/${id}`, 'DELETE')).status, 404, '重复删除 404');
});

test('PUT /api/channels/order：拖拽排序重写展示顺序；非法 ids 400', async (t) => {
  const { db, base } = await setup(t);
  const a = db.upsertPushChannel({ name: 'a', notifier: 'toast', targetType: null, targetId: null, enabled: true });
  const b = db.upsertPushChannel({ name: 'b', notifier: 'toast', targetType: null, targetId: null, enabled: true });
  const c = db.upsertPushChannel({ name: 'c', notifier: 'toast', targetType: null, targetId: null, enabled: true });

  const r = await api(base, '/api/channels/order', 'PUT', { ids: [c, a, b] });
  assert.equal(r.status, 200);
  assert.deepEqual(db.listPushChannels().map((x) => x.name), ['c', 'a', 'b'], '按新顺序返回');

  assert.equal((await api(base, '/api/channels/order', 'PUT', { ids: [a, b] })).status, 400, '长度不一致');
  assert.equal((await api(base, '/api/channels/order', 'PUT', { ids: [a, b, b] })).status, 400, '重复');
  assert.equal((await api(base, '/api/channels/order', 'PUT', { ids: [a, b, 999] })).status, 400, '不存在的 id');
  assert.equal((await api(base, '/api/channels/order', 'PUT', { ids: ['x'] })).status, 400);
  assert.equal((await api(base, '/api/channels/order', 'PUT', {})).status, 400);
});

test('推送总开关：GET 缺省开，PUT 改后生效', async (t) => {
  const { db, base } = await setup(t);
  const get = await api(base, '/api/push');
  assert.equal(get.status, 200);
  assert.equal(get.json['enabled'], true, '缺省开');

  const off = await api(base, '/api/push/enabled', 'PUT', { enabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.json['enabled'], false);
  assert.equal(db.getSetting('push_enabled'), '0');
  assert.equal((await api(base, '/api/push')).json['enabled'], false);

  assert.equal((await api(base, '/api/push/enabled', 'PUT', { enabled: 'x' })).status, 400);
});

test('channel 校验：notifier 枚举 / onebot 必填纯数字 targetId / name 非空 / toast 无目标', async (t) => {
  const { base } = await setup(t);

  assert.equal((await api(base, '/api/channels', 'POST', channelBody({ notifier: 'ntfy' }))).status, 400);
  assert.equal((await api(base, '/api/channels', 'POST', channelBody({ name: '  ' }))).status, 400);
  assert.equal((await api(base, '/api/channels', 'POST', channelBody({ targetId: 'abc' }))).status, 400);

  const noTarget = await api(base, '/api/channels', 'POST', channelBody({ targetId: null }));
  assert.equal(noTarget.status, 400);
  assert.match(noTarget.json.error ?? '', /targetId/);

  const toastWithTarget = await api(base, '/api/channels', 'POST',
    { name: '系统通知', notifier: 'toast', targetId: '123' });
  assert.equal(toastWithTarget.status, 400, '系统通知渠道没有目标号');

  // PUT：toast 改 onebot 不补目标号 → 合并后形状不合法
  const created = await api(base, '/api/channels', 'POST', { name: '系统通知', notifier: 'toast' });
  const id = (created.json as { id: number }).id;
  const badSwitch = await api(base, `/api/channels/${id}`, 'PUT', { notifier: 'onebot' });
  assert.equal(badSwitch.status, 400);

  assert.equal((await api(base, '/api/channels/xyz', 'PUT', { enabled: false })).status, 400);
  assert.equal((await api(base, '/api/channels/999', 'PUT', { enabled: false })).status, 404);
  assert.equal((await api(base, '/api/channels/999', 'DELETE')).status, 404);
});

// ---- 全局默认推送（template + channels） ----

test('push/default：GET 缺省形状，PUT 后可读，校验类型', async (t) => {
  const { db, base } = await setup(t);
  const chId = db.upsertPushChannel({
    name: '系统通知', notifier: 'toast', targetType: null, targetId: null, enabled: true,
  });
  db.upsertPushChannel({
    name: '停用的', notifier: 'toast', targetType: null, targetId: null, enabled: false,
  });

  const empty = await api(base, '/api/push/default');
  assert.equal(empty.status, 200);
  assert.equal(empty.json['template'], null);
  assert.deepEqual(empty.json['channels'], [chId], 'channels 未设置 = 全部启用渠道 id');

  assert.equal(
    (await api(base, '/api/push/default', 'PUT', { template: '{alias} 开播了！', channels: [] })).status,
    200,
  );
  const got = await api(base, '/api/push/default');
  assert.equal(got.json['template'], '{alias} 开播了！');
  assert.deepEqual(got.json['channels'], [], '显式空数组 = 默认不推');

  assert.equal((await api(base, '/api/push/default', 'PUT', { template: 1 })).status, 400);
  assert.equal((await api(base, '/api/push/default', 'PUT', {})).status, 400);
  assert.equal((await api(base, '/api/push/default', 'PUT', { channels: ['x'] })).status, 400);
  assert.equal((await api(base, '/api/push/template')).status, 404, '旧 template 接口已移除');
});

// ---- push_rules ----

function ruleBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid: '1001', keywords: ['歌回'], areas: ['虚拟Singer'], channels: [1],
    messageTemplate: '{alias} 开歌回了', enabled: true,
    ...over,
  };
}

test('rule CRUD：POST → GET（uid 过滤）→ PUT → DELETE', async (t) => {
  const { db, base } = await setup(t);
  db.upsertStreamer({ uid: '1001' });

  const created = await api(base, '/api/rules', 'POST', ruleBody());
  assert.equal(created.status, 201);
  const id = (created.json as { id: number }).id;
  assert.ok(id > 0);
  await api(base, '/api/rules', 'POST', ruleBody({ uid: '1002' }));

  const mine = await api(base, '/api/rules?uid=1001');
  const rules = mine.json['rules'] as Array<{ id: number; uid: string }>;
  assert.deepEqual(rules.map((r) => r.id), [id], 'uid 过滤生效');
  const all = await api(base, '/api/rules');
  assert.equal((all.json['rules'] as unknown[]).length, 2, '不带 uid 返回全量');

  const patched = await api(base, `/api/rules/${id}`, 'PUT', { channels: [], messageTemplate: null });
  assert.equal(patched.status, 200);
  const r = db.listPushRules().find((x) => x.id === id)!;
  assert.deepEqual(r.channels, []);
  assert.equal(r.messageTemplate, null);
  assert.deepEqual(r.keywords, ['歌回'], '未提供字段保留');

  assert.equal((await api(base, `/api/rules/${id}`, 'DELETE')).status, 200);
  assert.equal((await api(base, `/api/rules/${id}`, 'DELETE')).status, 404, '重复删除 404');
});

test('rule 校验：坏 uid / 坏 channels / 未知字段 / 坏 id / 缺失行 404 / 超大请求体', async (t) => {
  const { base } = await setup(t);

  assert.equal((await api(base, '/api/rules', 'POST', ruleBody({ uid: 'abc' }))).status, 400);

  const badChannels = await api(base, '/api/rules', 'POST', ruleBody({ channels: ['x'] }));
  assert.equal(badChannels.status, 400);
  assert.match(badChannels.json.error ?? '', /channels/);

  assert.equal((await api(base, '/api/rules', 'POST', ruleBody({ priority: 'high' }))).status, 400,
    'priority 已移除，属未知字段');
  assert.equal((await api(base, '/api/rules', 'POST', ruleBody({ keywords: '歌' }))).status, 400);
  assert.equal((await api(base, '/api/rules?uid=abc')).status, 400);

  assert.equal((await api(base, '/api/rules/xyz', 'PUT', { enabled: false })).status, 400);
  assert.equal((await api(base, '/api/rules/999', 'PUT', { enabled: false })).status, 404);
  assert.equal((await api(base, '/api/rules/999', 'DELETE')).status, 404);

  const huge = await api(base, '/api/rules', 'POST', ruleBody({ messageTemplate: 'x'.repeat(70 * 1024) }));
  assert.equal(huge.status, 400);
  assert.match(huge.json.error ?? '', /64KB/);
});

test('rule 空条件（关键词/分区都不填 = 任意匹配）可建可改', async (t) => {
  const { db, base } = await setup(t);
  db.upsertStreamer({ uid: '1001' });

  const created = await api(base, '/api/rules', 'POST', ruleBody({ keywords: [], areas: [] }));
  assert.equal(created.status, 201, '空条件规则允许（任意匹配）');
  const id = (created.json as { id: number }).id;
  const r = db.listPushRules().find((x) => x.id === id)!;
  assert.deepEqual(r.keywords, []);
  assert.deepEqual(r.areas, []);

  // PUT 把条件清空同样放行
  assert.equal((await api(base, `/api/rules/${id}`, 'PUT', { keywords: [], areas: [] })).status, 200);
});

test('rule 名称：不传自动补「规则 N」，传了存自定义名；未知字段仍拒', async (t) => {
  const { db, base } = await setup(t);
  db.upsertStreamer({ uid: '1001' });

  const auto = await api(base, '/api/rules', 'POST', ruleBody());
  const id = (auto.json as { id: number }).id;
  assert.equal(db.listPushRules().find((r) => r.id === id)!.name, `规则 ${id}`);

  const named = await api(base, '/api/rules', 'POST', ruleBody({ name: '歌回专用' }));
  const id2 = (named.json as { id: number }).id;
  assert.equal(db.listPushRules().find((r) => r.id === id2)!.name, '歌回专用');

  assert.equal((await api(base, '/api/rules', 'POST', ruleBody({ name: 5 }))).status, 400);
});

test('PUT /api/rules/order：同 uid 拖拽排序，非法 ids 400', async (t) => {
  const { db, base } = await setup(t);
  db.upsertStreamer({ uid: '1001' });
  const a = (await api(base, '/api/rules', 'POST', ruleBody({ keywords: ['a'] }))).json as { id: number };
  const b = (await api(base, '/api/rules', 'POST', ruleBody({ keywords: ['b'] }))).json as { id: number };
  const c = (await api(base, '/api/rules', 'POST', ruleBody({ keywords: ['c'] }))).json as { id: number };

  const r = await api(base, '/api/rules/order', 'PUT', { uid: '1001', ids: [c.id, a.id, b.id] });
  assert.equal(r.status, 200);
  assert.deepEqual(
    db.listEnabledPushRules('1001').map((x) => x.keywords[0]),
    ['c', 'a', 'b'],
    '重排后按新顺序 = 匹配优先级',
  );

  assert.equal((await api(base, '/api/rules/order', 'PUT', { uid: '1001', ids: [a.id, b.id] })).status, 400);
  assert.equal((await api(base, '/api/rules/order', 'PUT', { uid: '1001', ids: [a.id, a.id, c.id] })).status, 400);
  assert.equal((await api(base, '/api/rules/order', 'PUT', { uid: '1001', ids: [a.id, b.id, 999] })).status, 400);
  assert.equal((await api(base, '/api/rules/order', 'PUT', { uid: '1001', ids: ['x'] })).status, 400);
  assert.equal((await api(base, '/api/rules/order', 'PUT', { uid: 'abc', ids: [1] })).status, 400);
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

// ---- 监听功能开关 ----

test('GET /api/listen：auto 跟随登录态；无 listen dep 时 404', async (t) => {
  // 未注入 listen dep → 404
  const noDep = await setup(t);
  assert.equal((await api(noDep.base, '/api/listen')).status, 404);
  assert.equal((await api(noDep.base, '/api/listen/dynamic', 'PUT', { enabled: true })).status, 404);

  // bili 已登录、weibo 未登录：dynamic=auto开、weibo=auto关
  const { base } = await setup(t, { listen: { bili: true, weibo: false } });
  const r = await api(base, '/api/listen');
  assert.equal(r.status, 200);
  assert.equal(r.json['biliLoggedIn'], true);
  assert.equal(r.json['weiboLoggedIn'], false);
  assert.deepEqual(r.json['platforms'], [
    { key: 'bili', name: 'B站', state: 'ok', mid: '999' },
    { key: 'weibo', name: '微博', state: 'reserved' },
  ]);
  const rows = r.json['rows'] as Record<string, any>;
  assert.equal(rows['live'], undefined, '直播间常开不在卡片展示，API 也不回');
  assert.equal(rows['dynamic'].enabled, true, 'B站已登录 → 动态 auto 开');
  assert.equal(rows['dynamic'].setting, null, 'auto 模式');
  assert.equal(rows['weibo'].enabled, false, '微博未登录 → 微博 auto 关');
  assert.equal(rows['weibo'].setting, null);
});

test('PUT /api/listen/:feature：手动关闭粘住；与 auto 一致则回 auto', async (t) => {
  // bili 已登录，dynamic 初始 auto 开；手动关 → setting=0，onChanged 触发
  listenChangedCount = 0;
  const { base } = await setup(t, { listen: { bili: true } });
  const off = await api(base, '/api/listen/dynamic', 'PUT', { enabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.json['enabled'], false);
  assert.equal(off.json['setting'], '0', '手动关');
  assert.equal(listenChangedCount, 1, '面板改开关触发热启停回调');

  // GET 确认：手动关闭粘住（bili 仍已登录，但有效是关）
  const g = await api(base, '/api/listen');
  const dyn = (g.json['rows'] as Record<string, any>)['dynamic'];
  assert.equal(dyn.setting, '0');
  assert.equal(dyn.enabled, false, '手动关闭粘住（登录后仍关）');

  // 再开（与 auto 默认一致）→ 清除手动设置回 auto
  const on = await api(base, '/api/listen/dynamic', 'PUT', { enabled: true });
  assert.equal(on.json['enabled'], true);
  assert.equal(on.json['setting'], null, '与 auto 一致 → 回 auto 模式');
});

test('PUT /api/listen/:feature：config 停用时开关禁用；坏体 400', async (t) => {
  const { base } = await setup(t, { listen: { bili: true, weibo: false, dynamicEnabled: false } });
  const r = await api(base, '/api/listen');
  const dyn = (r.json['rows'] as Record<string, any>)['dynamic'];
  assert.equal(dyn.configEnabled, false);
  assert.equal(dyn.enabled, false, 'config 停用 → 有效关');

  const bad = await api(base, '/api/listen/weibo', 'PUT', { enabled: 'yes' });
  assert.equal(bad.status, 400);

  const nope = await api(base, '/api/listen/follows', 'PUT', { enabled: true });
  assert.equal(nope.status, 404, '未知 feature 404');
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

// ---- 微博扫码登录 ----

function weiboAuthFixture(t: import('node:test').TestContext, over: {
  pollStatus?: string; exchangeCookies?: Record<string, string>;
  onCookiesSaved?: (h: string) => void; selfUid?: string | null;
} = {}): { weiboAuth: PanelDeps['weiboAuth']; dir: string; savedHeaders: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'ddclaw-panel-wb-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const savedHeaders: string[] = [];
  const weiboAuth: PanelDeps['weiboAuth'] = {
    cookiePath: join(dir, 'weibo-cookies.json'),
    onCookiesSaved: over.onCookiesSaved ?? ((h) => { savedHeaders.push(h); }),
    qrcode: {
      generateQrcode: async () => ({ qrid: 'q123', image: 'https://passport.weibo.com/sso/v2/qrcode/q123.png' }),
      pollQrcode: async () => {
        const status = over.pollStatus ?? 'waiting';
        if (status === 'confirmed') {
          return { status: 'confirmed', loginUrl: 'https://login.sina.com.cn/crossdomain/abc' };
        }
        return { status: status as 'waiting' };
      },
      exchangeCookies: async () => over.exchangeCookies ?? { SUB: 's2', SUBP: 'p2' },
    },
    selfFetcher: async () => ({
      loggedIn: true, uid: over.selfUid === undefined ? '2203177060' : over.selfUid,
    }),
  };
  return { weiboAuth, dir, savedHeaders };
}

test('POST /api/auth/weibo/qrcode 返回 {image}（png 直链）并建立会话', async (t) => {
  const { weiboAuth } = weiboAuthFixture(t);
  const { base } = await setup(t, { weiboAuth });
  const r = await api(base, '/api/auth/weibo/qrcode', 'POST');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { image: 'https://passport.weibo.com/sso/v2/qrcode/q123.png' });

  // 会话已建立：poll 不再 400
  const poll = await api(base, '/api/auth/weibo/qrcode/poll');
  assert.equal(poll.status, 200);
  assert.deepEqual(poll.json, { status: 'waiting' });
});

test('GET weibo poll 未生成二维码 → 400', async (t) => {
  const { weiboAuth } = weiboAuthFixture(t);
  const { base } = await setup(t, { weiboAuth });
  const r = await api(base, '/api/auth/weibo/qrcode/poll');
  assert.equal(r.status, 400);
  assert.match(r.json.error ?? '', /请先生成二维码/);
});

test('GET weibo poll：waiting / scanned 透传，不落盘不回调', async (t) => {
  for (const st of ['waiting', 'scanned']) {
    const { weiboAuth, dir, savedHeaders } = weiboAuthFixture(t, { pollStatus: st });
    const { base } = await setup(t, { weiboAuth });
    await api(base, '/api/auth/weibo/qrcode', 'POST');
    const r = await api(base, '/api/auth/weibo/qrcode/poll');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { status: st });
    assert.equal(existsSync(join(dir, 'weibo-cookies.json')), false, `${st} 不得写 weibo-cookies.json`);
    assert.equal(savedHeaders.length, 0, `${st} 不得触发 onCookiesSaved`);
  }
});

test('GET weibo poll：expired 透传并清会话（再 poll → 400）', async (t) => {
  const { weiboAuth } = weiboAuthFixture(t, { pollStatus: 'expired' });
  const { base } = await setup(t, { weiboAuth });
  await api(base, '/api/auth/weibo/qrcode', 'POST');
  const r = await api(base, '/api/auth/weibo/qrcode/poll');
  assert.deepEqual(r.json, { status: 'expired' });
  assert.equal((await api(base, '/api/auth/weibo/qrcode/poll')).status, 400, '会话已清');
});

test('GET weibo poll confirmed：换票 → saveWeiboCookies 落盘（旧字段兜底）+ onCookiesSaved 回调 + 返回 uid', async (t) => {
  const saved: string[] = [];
  const { weiboAuth, dir } = weiboAuthFixture(t, {
    pollStatus: 'confirmed',
    exchangeCookies: { SUB: 'new-sub', SUBP: 'new-subp' },
    onCookiesSaved: (h) => { saved.push(h); },
  });
  // 旧文件：未提及字段应被 merge 保留
  writeFileSync(join(dir, 'weibo-cookies.json'), JSON.stringify({ SUB: 'old', SSO_LOGIN: 'keep' }));
  const { base } = await setup(t, { weiboAuth });

  await api(base, '/api/auth/weibo/qrcode', 'POST');
  const r = await api(base, '/api/auth/weibo/qrcode/poll');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { status: 'confirmed', uid: '2203177060' });

  const onDisk = JSON.parse(readFileSync(join(dir, 'weibo-cookies.json'), 'utf8')) as Record<string, string>;
  assert.deepEqual(onDisk, { SUB: 'new-sub', SUBP: 'new-subp', SSO_LOGIN: 'keep' },
    '新值覆盖、旧字段兜底');

  assert.equal(saved.length, 1, 'onCookiesSaved 被调一次');
  assert.match(saved[0]!, /SUB=new-sub/);
  assert.match(saved[0]!, /SSO_LOGIN=keep/, '回调拿到的是 merge 后的全量 cookie 头');

  const body = JSON.stringify(r.json) + JSON.stringify(onDisk);
  assert.ok(!body.includes('old'), '旧 SUB 值不出现在任何输出里');
});

test('无 weiboAuth dep 时微博扫码路由 404', async (t) => {
  const { base } = await setup(t);
  assert.equal((await api(base, '/api/auth/weibo/qrcode', 'POST')).status, 404);
  assert.equal((await api(base, '/api/auth/weibo/qrcode/poll')).status, 404);
});

// ---- LLM key 管理 ----

const LLM_CFG: NonNullable<PanelDeps['llm']>['config'] = {
  enabled: true, requestTimeoutMs: 5000, circuitThreshold: 2, circuitCooldownMs: 60_000,
  providers: [{
    name: 'ds', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
    vision: false, keyEnvs: ['TEST_PANEL_DS_KEY'], enabled: true, structuredOutput: 'schema',
    api: 'chat-completions',
  }],
};

test('GET /api/llm：provider 与 key 状态（本机面板，key 值明文回显）', async (t) => {
  const { base } = await setup(t, { llm: { config: LLM_CFG } });
  const r = await api(base, '/api/llm');
  assert.equal(r.status, 200);
  assert.equal(r.json.enabled, true);
  const p = (r.json.providers as Array<Record<string, unknown>>)[0]!;
  assert.equal(p.name, 'ds');
  assert.deepEqual(p.routes, ['text']);
  assert.deepEqual(p.key, { source: 'unset', count: 0, value: null });
});

test('PUT /api/llm/keys：保存 → source=panel + router 热更新 + GET 回显；清除 → 回退', async (t) => {
  const { base, llmRouter } = await setup(t, { llm: { config: LLM_CFG } });
  assert.match(llmRouter!.describe()[0]!.status, /缺 key/, '初始缺 key');

  const r = await api(base, '/api/llm/keys', 'PUT', { provider: 'ds', value: 'sk-panel-123' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, provider: 'ds', key: { source: 'panel', count: 1, value: 'sk-panel-123' } });
  assert.equal(llmRouter!.describe()[0]!.status, 'ready', 'refreshKeys 热更新，免重启');

  const info = await api(base, '/api/llm');
  assert.deepEqual(
    (info.json.providers as Array<{ key: unknown }>)[0]!.key,
    { source: 'panel', count: 1, value: 'sk-panel-123' },
    '本机面板，key 明文回显供编辑',
  );

  const cleared = await api(base, '/api/llm/keys', 'PUT', { provider: 'ds', value: '' });
  assert.deepEqual(cleared.json.key, { source: 'unset', count: 0, value: null }, '空值 = 清除面板填写');
  assert.match(llmRouter!.describe()[0]!.status, /缺 key/);
});

test('PUT /api/llm/keys：provider 不存在 404；非法 value 400', async (t) => {
  const { base } = await setup(t, { llm: { config: LLM_CFG } });
  assert.equal((await api(base, '/api/llm/keys', 'PUT', { provider: 'nope', value: 'x' })).status, 404);
  assert.equal((await api(base, '/api/llm/keys', 'PUT', { provider: 'ds', value: 'has space' })).status, 400);
});

test('POST /api/llm/providers/:name/test：真实 ping 判断能不能用', async (t) => {
  const okFetch: FetchLike = async () => new Response(
    JSON.stringify({ choices: [{ message: { content: '{"pong":true}' } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
  const { base } = await setup(t, { llm: { config: LLM_CFG }, llmFetch: okFetch });

  assert.equal((await api(base, '/api/llm/providers/nope/test', 'POST')).status, 404, '不存在 404');
  const noKey = await api(base, '/api/llm/providers/ds/test', 'POST');
  assert.equal(noKey.status, 400, '缺 key 400');

  await api(base, '/api/llm/keys', 'PUT', { provider: 'ds', value: 'sk-ping-test' });
  const ok = await api(base, '/api/llm/providers/ds/test', 'POST');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.equal(typeof ok.json.ms, 'number');
});

test('POST /api/llm/providers/:name/test：端点报错 502，错误信息不含 key', async (t) => {
  const failFetch: FetchLike = async () => new Response('invalid api key', { status: 401 });
  const { base } = await setup(t, { llm: { config: LLM_CFG }, llmFetch: failFetch });
  await api(base, '/api/llm/keys', 'PUT', { provider: 'ds', value: 'sk-secret-xyz' });
  const r = await api(base, '/api/llm/providers/ds/test', 'POST');
  assert.equal(r.status, 502);
  assert.equal(r.json.ok, false);
  assert.match(r.json.error!, /401/);
  assert.ok(!JSON.stringify(r.json).includes('sk-secret-xyz'), '错误信息不含 key');
});

test('PUT /api/llm/enabled：面板总开关覆盖 config 默认值', async (t) => {
  const { base } = await setup(t, { llm: { config: { ...LLM_CFG, enabled: false } } });
  assert.equal((await api(base, '/api/llm')).json.enabled, false, 'config 默认关');
  assert.equal((await api(base, '/api/llm/enabled', 'PUT', { enabled: true })).status, 200);
  assert.equal((await api(base, '/api/llm')).json.enabled, true, '面板打开');
  assert.equal((await api(base, '/api/llm/enabled', 'PUT', { enabled: 'yes' })).status, 400);
});

test('无 llm dep 时 /api/llm* 一律 404', async (t) => {
  const { base } = await setup(t);
  assert.equal((await api(base, '/api/llm')).status, 404);
  assert.equal((await api(base, '/api/llm/keys', 'PUT', { env: 'A', value: 'b' })).status, 404);
  assert.equal((await api(base, '/api/llm/providers', 'POST', {})).status, 404);
});

// ---- LLM provider CRUD（settings 表是事实来源）----

test('POST /api/llm/providers：新增即出现在 GET，路由自动推导；重名/非法 → 400', async (t) => {
  const { base } = await setup(t, { llm: { config: LLM_CFG } });
  const added = await api(base, '/api/llm/providers', 'POST', {
    name: 'mm', baseURL: 'https://api.minimaxi.com/v1', model: 'MiniMax-M3',
    vision: true, keyEnvs: ['TEST_PANEL_MM_KEY'], structuredOutput: 'schema',
    api: 'responses',
  });
  assert.equal(added.status, 201);

  const info = await api(base, '/api/llm');
  const providers = info.json.providers as Array<{ name: string; routes: string[]; api: string }>;
  assert.deepEqual(providers.map((p) => p.name), ['ds', 'mm'], 'config 种子 + 新增');
  assert.deepEqual(providers[0]!.routes, ['text'], '纯文本只进 text 路由');
  assert.deepEqual(providers[1]!.routes, ['text', 'vision'], '多模态进两条路由');
  assert.equal(providers[0]!.api, 'chat-completions', '缺省协议回显');
  assert.equal(providers[1]!.api, 'responses', 'POST 指定 responses 协议');

  // PUT 可改协议；非法值 400
  assert.equal((await api(base, '/api/llm/providers/mm', 'PUT', { api: 'chat-completions' })).status, 200);
  const after = await api(base, '/api/llm');
  assert.equal((after.json.providers as Array<{ api: string }>)[1]!.api, 'chat-completions');
  assert.equal((await api(base, '/api/llm/providers/mm', 'PUT', { api: 'anthropic' })).status, 400, '不支持 anthropic 协议');

  assert.equal((await api(base, '/api/llm/providers', 'POST', {
    name: 'mm', baseURL: 'https://x.com/v1', model: 'm',
  })).status, 400, '重名 400');
  const bad = await api(base, '/api/llm/providers', 'POST', { name: 'x', baseURL: 'not-a-url', model: 'm' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error!, /baseURL/);
});

test('provider 表单可携带 key：POST/PUT 直接保存，GET 明文回显', async (t) => {
  const { base } = await setup(t, { llm: { config: { ...LLM_CFG, providers: [] } } });
  assert.equal((await api(base, '/api/llm/providers', 'POST', {
    name: 'k', baseURL: 'https://api.x.com/v1', model: 'm', key: 'sk-form-1',
  })).status, 201);
  let info = await api(base, '/api/llm');
  assert.deepEqual((info.json.providers as Array<{ key: { value: string } }>)[0]!.key,
    { source: 'panel', count: 1, value: 'sk-form-1' }, 'POST 带 key 直接保存');
  await api(base, '/api/llm/providers/k', 'PUT', { key: 'sk-form-2' });
  info = await api(base, '/api/llm');
  assert.equal((info.json.providers as Array<{ key: { value: string } }>)[0]!.key.value, 'sk-form-2', 'PUT 带 key 更新');
  await api(base, '/api/llm/providers/k', 'PUT', { model: 'm2' });
  info = await api(base, '/api/llm');
  assert.equal((info.json.providers as Array<{ key: { value: string } }>)[0]!.key.value, 'sk-form-2',
    '不带 key 的 PUT 不动现有 key');
});

test('PUT /api/llm/providers/order：整体重排；名单不对应/重复 → 400', async (t) => {
  const { base } = await setup(t, { llm: { config: LLM_CFG } });
  await api(base, '/api/llm/providers', 'POST', {
    name: 'mm', baseURL: 'https://api.minimaxi.com/v1', model: 'MiniMax-M3', vision: true,
  });
  const r = await api(base, '/api/llm/providers/order', 'PUT', { names: ['mm', 'ds'] });
  assert.equal(r.status, 200);
  const info = await api(base, '/api/llm');
  assert.deepEqual((info.json.providers as Array<{ name: string }>).map((p) => p.name), ['mm', 'ds']);
  assert.equal((await api(base, '/api/llm/providers/order', 'PUT', { names: ['mm'] })).status, 400, '缺一个');
  assert.equal((await api(base, '/api/llm/providers/order', 'PUT', { names: ['mm', 'mm'] })).status, 400, '重复');
  assert.equal((await api(base, '/api/llm/providers/order', 'PUT', { names: ['mm', 'ghost'] })).status, 400, '不存在');
});

test('PUT 启停影响路由推导；DELETE 移除；onProvidersChanged 重建 router', async (t) => {
  const { base, llmRouter } = await setup(t, { llm: { config: LLM_CFG } });
  assert.deepEqual(llmRouter!.describe().map((s) => s.name), ['ds']);

  const off = await api(base, '/api/llm/providers/ds', 'PUT', { enabled: false });
  assert.equal(off.status, 200);
  const info = await api(base, '/api/llm');
  assert.deepEqual((info.json.providers as Array<{ routes: string[] }>)[0]!.routes, [], '停用后出路由');

  assert.equal((await api(base, '/api/llm/providers/nope', 'PUT', { enabled: false })).status, 404);
  assert.equal((await api(base, '/api/llm/providers/ds', 'DELETE')).status, 200);
  const after = await api(base, '/api/llm');
  assert.deepEqual(after.json.providers, [], '删除后名单为空（router 已随 onProvidersChanged 重建）');
  assert.equal((await api(base, '/api/llm/providers/ds', 'DELETE')).status, 404);
});
