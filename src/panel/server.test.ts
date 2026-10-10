import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../core/db.js';
import { createPanelServer, type PanelDeps, type PanelStatus } from './server.js';
import { createLlmRouter, listLlmProviders, saveLlmProviders, setLlmEnabled, dbKeysOf, type LlmRouter, type FetchLike } from '../analysis/providers.js';
import type { LlmProviderConfig } from '../config/schema.js';
import { saveNapcatConfig } from '../notify/napcat.js';
import { emptyXFeedSnapshot, getXConfig, saveXConfig } from '../core/x-config.js';
import { emptyWeiboFeedSnapshot } from '../core/weibo-accounts.js';
import { defaultPostFilters } from '../core/post-rules.js';
import { UndoStore, adminScope, undoEffects, type UndoEffect, type UndoResult } from '../core/undo.js';
import { ChatStore } from '../core/chat-store.js';

interface Fixture {
  db: Db;
  base: string;
  llmRouter?: LlmRouter;
  /** 注入 undo dep 时（opts.undo）可取到，验证写快照落库 */
  undo?: UndoStore;
  /** 注入 undo dep 时装配的撤销执行器触发计数（按 undoEffects 标签分桶） */
  undoFired?: Record<UndoEffect, number>;
  /** 注入 chat dep 时（opts.chat）可取到，验证会话落库 / reset 语义 */
  chat?: ChatStore;
}

/** 记录 listen dep 的 onChanged 被调用次数（面板改开关 → 热启停源） */
let listenChangedCount = 0;

/** 真实 http.Server 绑临时端口 + 内存库；connection:close 避免 keep-alive 挂住测试进程 */
async function setup(
  t: import('node:test').TestContext,
  opts: {
    auth?: PanelDeps['auth']; weiboAuth?: PanelDeps['weiboAuth'];
    weiboResolver?: PanelDeps['weiboResolver'];
    llm?: {
      config: {
        enabled?: boolean;
        requestTimeoutMs: number;
        circuitThreshold: number;
        circuitCooldownMs: number;
        providers: LlmProviderConfig[];
      };
    };
    llmFetch?: FetchLike;
    /** 注入 listen dep；缺省不注入（/api/listen* 404）。twitter 可传函数 = 动态判据（代理配置会变） */
    listen?: { bili?: boolean; weibo?: boolean; twitter?: boolean | (() => boolean) };
    /** 注入 napcat dep；缺省不注入（/api/napcat* 404） */
    napcat?: PanelDeps['napcat'];
    /** 注入 advanced dep（onChanged 热生效回调）；缺省则保存只落库 */
    advanced?: PanelDeps['advanced'];
    /** 注入 snapshots dep（/api/snapshot 缓存关键帧）；缺省不注入（404） */
    snapshots?: PanelDeps['snapshots'];
    /** 注入 xAvatars dep（/api/x-avatar X 头像缓存）；缺省不注入（404） */
    xAvatars?: PanelDeps['xAvatars'];
    /** 注入头像代理 fetch（/api/avatar 测试用）；缺省用全局 fetch */
    avatar?: PanelDeps['avatar'];
    /** 注入 testPush dep（/api/push/test）；缺省不注入（404） */
    testPush?: PanelDeps['testPush'];
    /** 注入 x dep（/api/x*）；缺省不注入（404） */
    x?: PanelDeps['x'];
    /** 注入 weibo dep（/api/weibo*）；缺省不注入（404） */
    weibo?: PanelDeps['weibo'];
    /** 注入 weiboAvatars dep（/api/weibo-avatar）；缺省不注入（404） */
    weiboAvatars?: PanelDeps['weiboAvatars'];
    /** 注入 biliAvatars dep（/api/bili-avatar B站动态账号头像缓存）；缺省不注入（404） */
    biliAvatars?: PanelDeps['biliAvatars'];
    /** 注入 weiboImages dep（/api/weibo-image 微博帖子图反代）；缺省不注入（不落盘、纯反代） */
    weiboImages?: PanelDeps['weiboImages'];
    /** 注入 biliFeed dep（添加 B站动态账号后的即时首拉钩子）；缺省不注入（跳过） */
    biliFeed?: PanelDeps['biliFeed'];
    /** 注入 UndoStore（P0 写快照接线测试）；缺省不注入（写不落变更记录） */
    undo?: boolean;
    /** 注入 ChatStore（P1 /api/chat* 对话端点）；缺省不注入（404） */
    chat?: boolean;
    /** 注入已有库（时间轴测试需要预置历史数据）；缺省新建内存库 */
    db?: Db;
  } = {},
): Promise<Fixture> {
  const db = opts.db ?? new Db(':memory:');
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
  // llm dep：按生产装配方式建（providers/开关直接落 settings——唯一信源；
  // onProvidersChanged 重建 router；key resolver = 面板 settings）
  let llm: PanelDeps['llm'];
  if (opts.llm) {
    saveLlmProviders(db, opts.llm.config.providers);
    setLlmEnabled(db, opts.llm.config.enabled ?? true);
    const dep: PanelDeps['llm'] = {
      store: { list: () => listLlmProviders(db), save: (ps) => saveLlmProviders(db, ps) },
    };
    const build = () => createLlmRouter(
      {
        requestTimeoutMs: opts.llm!.config.requestTimeoutMs,
        circuitThreshold: opts.llm!.config.circuitThreshold,
        circuitCooldownMs: opts.llm!.config.circuitCooldownMs,
        providers: listLlmProviders(db),
      },
      dbKeysOf(db),
      opts.llmFetch ? { fetchFn: opts.llmFetch } : undefined,
    );
    dep.router = build();
    dep.onProvidersChanged = () => { dep.router = build(); };
    llm = dep;
  }
  const undoStore = opts.undo ? new UndoStore(db.raw) : undefined;
  undoStore?.migrate();
  const chatStore = opts.chat ? new ChatStore(db.raw) : undefined;
  chatStore?.migrate();
  // 撤销执行器（生产装配形状：撤栈顶 + 按 core/undo.ts 的 undoEffects 触发热生效回调）。
  // 回调闭包在 index.ts，测试里用计数桩代替——映射函数本身是生产代码，不是测试自己的复刻。
  const undoFired: Record<UndoEffect, number> = { runtime: 0, listen: 0, llm: 0, notifiers: 0 };
  const undoLast = undoStore === undefined
    ? undefined
    : (scope?: string): UndoResult => {
        const r = undoStore.undo(scope ?? 'admin');
        if (!r.ok) return r;
        for (const e of undoEffects(r)) undoFired[e]++;
        return r;
      };
  const server: Server = createPanelServer({
    db,
    ...(undoStore ? { undo: undoStore } : {}),
    ...(undoLast ? { undoLast } : {}),
    ...(chatStore ? { chat: chatStore } : {}),
    weiboResolver: opts.weiboResolver,
    status: () => ({
      ...status,
      watchedCount: db.listWatchedUids().length,
      liveCount: db.countLiveRooms(),
    }),
    auth: opts.auth,
    weiboAuth: opts.weiboAuth,
    llm,
    napcat: opts.napcat,
    advanced: opts.advanced,
    snapshots: opts.snapshots,
    xAvatars: opts.xAvatars,
    avatar: opts.avatar,
    testPush: opts.testPush,
    x: opts.x,
    weibo: opts.weibo,
    weiboAvatars: opts.weiboAvatars,
    biliAvatars: opts.biliAvatars,
    weiboImages: opts.weiboImages,
    biliFeed: opts.biliFeed,
    ...(opts.listen
      ? {
          listen: {
            login: () => ({
              bili: opts.listen!.bili ?? false,
              weibo: opts.listen!.weibo ?? false,
              twitter: typeof opts.listen!.twitter === 'function' ? opts.listen!.twitter() : (opts.listen!.twitter ?? false),
            }),
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
  return {
    db, base: `http://127.0.0.1:${port}`, llmRouter: llm?.router,
    ...(undoStore ? { undo: undoStore, undoFired } : {}),
    ...(chatStore ? { chat: chatStore } : {}),
  };
}

interface ApiResult {
  status: number;
  json: Record<string, unknown> & { error?: string };
}

async function api(
  base: string, path: string, method = 'GET', body?: unknown, rawBody?: string,
): Promise<ApiResult> {
  // 全套件并行时 Windows + undici 偶发 'fetch failed'（连接被重置），多次重试兜底
  let res: Response | null = null;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5 && res === null; attempt++) {
    try {
      res = await fetch(base + path, {
        method,
        headers: { connection: 'close', ...(body !== undefined || rawBody ? { 'content-type': 'application/json' } : {}) },
        body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
      });
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 30));
    }
  }
  if (res === null) throw lastErr;
  const json = (await res.json().catch(() => null)) as ApiResult['json'] | null;
  return { status: res.status, json: json ?? {} };
}

// ---- 页面 ----

test('GET / 返回内嵌页面，包含主要卡片与视图导航（时间表/主播/图文/设置、监听/LLM供应商/推送/关注列表）', async (t) => {
  const { base } = await setup(t);
  const res = await fetch(base + '/', { headers: { connection: 'close' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const html = await res.text();
  for (const marker of ['监听', 'LLM 供应商', '推送', 'id="schedule-body"', 'data-view="streamers"', '关注列表', 'id="view-schedule"', 'id="view-streamers"', 'id="view-x"', 'id="view-settings"']) {
    assert.ok(html.includes(marker), `页面应包含「${marker}」`);
  }
  // 关注列表是独立卡片（不再嵌在主播列表里），且带搜索框
  assert.ok(html.includes('id="card-follows"'), '关注列表应是独立卡片');
  assert.ok(html.includes('id="follow-search"'), '关注列表应有搜索框');
});

test('静态资产路由：/style.css、/js/core.js、demo 资产命中并带正确 content-type', async (t) => {
  const { base } = await setup(t);
  const css = await fetch(base + '/style.css', { headers: { connection: 'close' } });
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') ?? '', /text\/css/);
  assert.equal(css.headers.get('cache-control'), 'no-store');
  assert.ok((await css.text()).includes('--blue'), 'style.css 应含设计令牌');

  const js = await fetch(base + '/js/core.js', { headers: { connection: 'close' } });
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type') ?? '', /text\/javascript/);
  assert.ok((await js.text()).includes('export function'), 'core.js 应是 ES module');

  const mock = await fetch(base + '/demo/mock-data.js', { headers: { connection: 'close' } });
  assert.equal(mock.status, 200, 'demo 资产也应内嵌（真实部署 ?demo=1 可演示）');
});

test('静态资产路由：未知路径与路径穿越尝试 404', async (t) => {
  const { base } = await setup(t);
  for (const p of ['/nope.css', '/js/nonexistent.js', '/../package.json', '/..%2F..%2Fpackage.json']) {
    const res = await fetch(base + p, { headers: { connection: 'close' } });
    assert.equal(res.status, 404, `「${p}」应 404`);
  }
});

// ---- streamers（含 face / live / rules 摘要）----

test('GET /api/streamers：enrich face / live=null / 生效规则名标签（含 disabled）', async (t) => {
  const { db, base } = await setup(t);
  db.upsertStreamer({ uid: '1001', uname: '阿梓', face: 'https://i0.hdslb.com/f1.jpg' });
  db.upsertStreamer({ uid: '1002', uname: '小可' });
  db.upsertPushRule({ name: '全局规则', categoryId: null, uids: [], channels: [],
    messageTemplate: null, enabled: true });
  db.upsertPushRule({ name: '仅阿梓', categoryId: null, uids: ['1001'], channels: [],
    messageTemplate: null, enabled: true });
  db.upsertPushRule({ name: '停用的', categoryId: null, uids: ['1001'], channels: [],
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
  assert.deepEqual(s1.rules, { names: ['全局规则', '仅阿梓', '停用的'] },
    '生效规则按全局 sort 序，disabled 也带上');
  assert.deepEqual(s2.rules, { names: ['全局规则'] }, 'uids 空 = 对全部主播生效（含未来新增）');
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

test('POST /api/push/test：注入 testPush 才挂，透传结果；无 dep 404', async (t) => {
  const noDep = await setup(t);
  assert.equal((await api(noDep.base, '/api/push/test', 'POST')).status, 404);

  let calls = 0;
  const { base } = await setup(t, {
    testPush: async () => { calls++; return { total: 2, succeeded: 2 }; },
  });
  const r = await api(base, '/api/push/test', 'POST');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, total: 2, succeeded: 2 });
  assert.equal(calls, 1);
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

// ---- categories：分类规则 ----

function categoryBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: '歌回', keywords: ['歌回'], areas: [], condMode: 'and', enabled: true, ...over };
}

test('category CRUD：POST → GET → PUT → DELETE', async (t) => {
  const { db, base } = await setup(t);

  const created = await api(base, '/api/categories', 'POST', categoryBody());
  assert.equal(created.status, 201);
  const id = (created.json as { id: number }).id;
  assert.ok(id > 0);
  await api(base, '/api/categories', 'POST',
    categoryBody({ name: '游戏', llmPrompt: '在打游戏', keywords: [], enabled: false }));

  const list = await api(base, '/api/categories');
  const cats = list.json['categories'] as Array<{
    id: number; name: string; llmPrompt: string | null;
    keywords: string[]; condMode: string; enabled: boolean;
  }>;
  assert.equal(cats.length, 2);
  assert.deepEqual(cats[0]!.keywords, ['歌回']);
  assert.equal(cats[0]!.llmPrompt, null, '未传 llmPrompt 缺省 null（纯确定性分类）');
  assert.equal(cats[1]!.llmPrompt, '在打游戏');
  assert.equal(cats[1]!.enabled, false);

  const patched = await api(base, `/api/categories/${id}`, 'PUT', { condMode: 'or', areas: ['虚拟Singer'] });
  assert.equal(patched.status, 200);
  const c = db.listCategories().find((x) => x.id === id)!;
  assert.equal(c.condMode, 'or');
  assert.deepEqual(c.areas, ['虚拟Singer']);
  assert.equal(c.name, '歌回', '未提供字段保留');

  assert.equal((await api(base, `/api/categories/${id}`, 'DELETE')).status, 200);
  assert.equal((await api(base, `/api/categories/${id}`, 'DELETE')).status, 404, '重复删除 404');
});

test('category 名称：省略自动补「分类 N」，显式空白 400，PUT 改名 trim', async (t) => {
  const { db, base } = await setup(t);

  const auto = await api(base, '/api/categories', 'POST', { keywords: ['歌'] });
  assert.equal(auto.status, 201, 'name 可省略（Db 补「分类 N」）');
  const id = (auto.json as { id: number }).id;
  assert.equal(db.listCategories().find((c) => c.id === id)!.name, `分类 ${id}`);

  const blank = await api(base, '/api/categories', 'POST', categoryBody({ name: '  ' }));
  assert.equal(blank.status, 400);
  assert.match(blank.json.error ?? '', /分类名称不能为空/);
  assert.equal((await api(base, '/api/categories', 'POST', categoryBody({ name: 5 }))).status, 400);
  assert.equal((await api(base, `/api/categories/${id}`, 'PUT', { name: '' })).status, 400, 'PUT 空白名 400');

  const renamed = await api(base, `/api/categories/${id}`, 'PUT', { name: ' 杂谈 ' });
  assert.equal(renamed.status, 200);
  assert.equal(db.listCategories().find((c) => c.id === id)!.name, '杂谈', 'PUT 改名 trim 后入库');
});

test('category 校验：三条件皆空 400（POST 与 PUT 合并后）/ condMode 枚举 / 未知字段 / 404', async (t) => {
  const { db, base } = await setup(t);

  const empty = await api(base, '/api/categories', 'POST', { name: '空的' });
  assert.equal(empty.status, 400, 'llmPrompt/keywords/areas 皆空 400');
  assert.match(empty.json.error ?? '', /至少配置 LLM 提示词或关键词\/分区条件/);

  const badMode = await api(base, '/api/categories', 'POST', categoryBody({ condMode: 'xor' }));
  assert.equal(badMode.status, 400);
  assert.match(badMode.json.error ?? '', /condMode/);

  assert.equal((await api(base, '/api/categories', 'POST', categoryBody({ priority: 1 }))).status, 400,
    '未知字段');
  assert.equal((await api(base, '/api/categories', 'POST', categoryBody({ keywords: '歌' }))).status, 400);
  assert.equal((await api(base, '/api/categories/xyz', 'PUT', { enabled: false })).status, 400);
  assert.equal((await api(base, '/api/categories/999', 'PUT', { enabled: false })).status, 404);
  assert.equal((await api(base, '/api/categories/999', 'DELETE')).status, 404);

  // PUT 把唯一条件清空（合并后形状皆空）→ 400；有 llmPrompt 兜底则放行
  const created = await api(base, '/api/categories', 'POST', { keywords: ['歌'] });
  const id = (created.json as { id: number }).id;
  const cleared = await api(base, `/api/categories/${id}`, 'PUT', { keywords: [] });
  assert.equal(cleared.status, 400, '清空唯一条件 = 合并后皆空，400');
  assert.equal((await api(base, `/api/categories/${id}`, 'PUT', { llmPrompt: '在唱歌', keywords: [] })).status,
    200, 'llmPrompt 非空时清空关键词放行');
  // llmPrompt 空串 = 不用 LLM（归一化为 null）
  assert.equal((await api(base, `/api/categories/${id}`, 'PUT', { llmPrompt: '' })).status, 400,
    '清空 prompt 后条件又全空（keywords 已是 []）→ 400');
  assert.equal(db.listCategories().find((c) => c.id === id)!.llmPrompt, '在唱歌', '失败的 PUT 不落库');
});

test('PUT /api/categories/order：拖拽排序重写顺序；非法 ids 400', async (t) => {
  const { db, base } = await setup(t);
  const mk = { llmPrompt: null, keywords: ['x'], areas: [], condMode: 'and' as const, enabled: true };
  const a = db.upsertCategory({ ...mk, name: 'a' });
  const b = db.upsertCategory({ ...mk, name: 'b' });
  const c = db.upsertCategory({ ...mk, name: 'c' });

  const r = await api(base, '/api/categories/order', 'PUT', { ids: [c, a, b] });
  assert.equal(r.status, 200);
  assert.deepEqual(db.listCategories().map((x) => x.name), ['c', 'a', 'b'], '按新顺序返回');

  assert.equal((await api(base, '/api/categories/order', 'PUT', { ids: [a, b] })).status, 400, '长度不一致');
  assert.equal((await api(base, '/api/categories/order', 'PUT', { ids: [a, b, b] })).status, 400, '重复');
  assert.equal((await api(base, '/api/categories/order', 'PUT', { ids: [a, b, 999] })).status, 400, '不存在的 id');
  assert.equal((await api(base, '/api/categories/order', 'PUT', {})).status, 400);
});

test('DELETE /api/categories/:id：级联停用引用它的推送规则并返回 disabledRules', async (t) => {
  const { db, base } = await setup(t);
  const mk = { llmPrompt: null, keywords: ['x'], areas: [], condMode: 'and' as const, enabled: true };
  const cat = db.upsertCategory({ ...mk, name: '歌回' });
  const other = db.upsertCategory({ ...mk, name: '游戏' });
  const mkRule = { uids: [], channels: [], messageTemplate: null, enabled: true };
  db.upsertPushRule({ ...mkRule, name: 'r1', categoryId: cat });
  db.upsertPushRule({ ...mkRule, name: 'r2', categoryId: cat });
  db.upsertPushRule({ ...mkRule, name: 'r3', categoryId: other });

  const r = await api(base, `/api/categories/${cat}`, 'DELETE');
  assert.equal(r.status, 200);
  assert.equal(r.json['disabledRules'], 2, '返回被级联停用的规则数供面板提示');
  const rules = db.listPushRules();
  assert.equal(rules.find((x) => x.name === 'r1')!.enabled, false, '规则保留但停用（可恢复）');
  assert.equal(rules.find((x) => x.name === 'r3')!.enabled, true, '其他分类的规则不受影响');
  assert.equal(db.listCategories().some((c) => c.id === cat), false, '分类已删除');
});

// ---- push_rules v2：推送规则（全局；分类引用 + 生效主播集合）----

function ruleBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    categoryId: null, uids: [], channels: [],
    messageTemplate: '{liver} 开播了', enabled: true,
    ...over,
  };
}

test('rule CRUD：POST → GET → PUT → DELETE', async (t) => {
  const { db, base } = await setup(t);
  const chId = db.upsertPushChannel({
    name: '系统通知', notifier: 'toast', targetType: null, targetId: null, enabled: true,
  });
  const catId = db.upsertCategory({
    name: '歌回', llmPrompt: null, keywords: ['歌'], areas: [], condMode: 'and', enabled: true,
  });

  const created = await api(base, '/api/rules', 'POST', ruleBody({ categoryId: catId, channels: [chId] }));
  assert.equal(created.status, 201);
  const id = (created.json as { id: number }).id;
  assert.ok(id > 0);
  await api(base, '/api/rules', 'POST', ruleBody());

  const all = await api(base, '/api/rules');
  assert.equal((all.json['rules'] as unknown[]).length, 2, '不带参数返回全量');

  const patched = await api(base, `/api/rules/${id}`, 'PUT',
    { channels: [], messageTemplate: null, categoryId: null });
  assert.equal(patched.status, 200);
  const r = db.listPushRules().find((x) => x.id === id)!;
  assert.deepEqual(r.channels, []);
  assert.equal(r.messageTemplate, null);
  assert.equal(r.categoryId, null, 'categoryId 可置空（任意开播）');
  assert.deepEqual(r.uids, [], '未提供字段保留');

  assert.equal((await api(base, `/api/rules/${id}`, 'DELETE')).status, 200);
  assert.equal((await api(base, `/api/rules/${id}`, 'DELETE')).status, 404, '重复删除 404');
});

test('GET /api/rules?uid= 新语义：空 uids 对任何主播生效，显式名单只对列出主播', async (t) => {
  const { db, base } = await setup(t);
  db.upsertStreamer({ uid: '1001' });
  db.upsertStreamer({ uid: '1002' });
  const mk = { categoryId: null, channels: [], messageTemplate: null, enabled: true };
  const a = db.upsertPushRule({ ...mk, name: '全局', uids: [] });
  const b = db.upsertPushRule({ ...mk, name: '仅1001', uids: ['1001'] });

  const for1 = (await api(base, '/api/rules?uid=1001')).json['rules'] as Array<{ id: number }>;
  assert.deepEqual(for1.map((r) => r.id), [a, b], '名单内主播看到全局 + 专属');
  const for2 = (await api(base, '/api/rules?uid=1002')).json['rules'] as Array<{ id: number }>;
  assert.deepEqual(for2.map((r) => r.id), [a], '空 uids = 全部主播（含未来新增）');
  assert.equal((await api(base, '/api/rules?uid=abc')).status, 400);
});

test('rule 校验：引用存在性（分类/渠道/主播）+ 字段类型 + 未知字段 + 超大请求体', async (t) => {
  const { db, base } = await setup(t);
  db.upsertStreamer({ uid: '1001' });
  const chId = db.upsertPushChannel({
    name: '系统通知', notifier: 'toast', targetType: null, targetId: null, enabled: true,
  });

  const badCat = await api(base, '/api/rules', 'POST', ruleBody({ categoryId: 999 }));
  assert.equal(badCat.status, 400);
  assert.match(badCat.json.error ?? '', /分类不存在/);

  const badChan = await api(base, '/api/rules', 'POST', ruleBody({ channels: [chId, 999] }));
  assert.equal(badChan.status, 400);
  assert.match(badChan.json.error ?? '', /渠道不存在/);

  const badUid = await api(base, '/api/rules', 'POST', ruleBody({ uids: ['1001', '9999'] }));
  assert.equal(badUid.status, 400);
  assert.match(badUid.json.error ?? '', /不在监听名单/);

  assert.equal((await api(base, '/api/rules', 'POST', ruleBody({ uids: ['abc'] }))).status, 400,
    'uids 元素必须纯数字');
  assert.equal((await api(base, '/api/rules', 'POST', ruleBody({ categoryId: 'x' }))).status, 400);
  assert.equal((await api(base, '/api/rules', 'POST', ruleBody({ channels: ['x'] }))).status, 400);
  assert.equal((await api(base, '/api/rules', 'POST', ruleBody({ keywords: ['歌'] }))).status, 400,
    'keywords 已移除，属未知字段');
  assert.equal((await api(base, '/api/rules', 'POST', ruleBody({ uid: '1001' }))).status, 400,
    'uid 字段已移除，属未知字段');

  // PUT 对合并后形状做存在性校验
  const ok = await api(base, '/api/rules', 'POST', ruleBody({ channels: [chId] }));
  const id = (ok.json as { id: number }).id;
  assert.equal((await api(base, `/api/rules/${id}`, 'PUT', { channels: [999] })).status, 400,
    'PUT 改成不存在的渠道 400');
  assert.equal((await api(base, `/api/rules/${id}`, 'PUT', { uids: ['1001'] })).status, 200,
    'PUT 合并校验放行合法引用');
  assert.equal((await api(base, '/api/rules/xyz', 'PUT', { enabled: false })).status, 400);
  assert.equal((await api(base, '/api/rules/999', 'PUT', { enabled: false })).status, 404);
  assert.equal((await api(base, '/api/rules/999', 'DELETE')).status, 404);

  const huge = await api(base, '/api/rules', 'POST', ruleBody({ messageTemplate: 'x'.repeat(70 * 1024) }));
  assert.equal(huge.status, 400);
  assert.match(huge.json.error ?? '', /64KB/);
});

test('rule 名称：不传自动补「规则 N」，传了存自定义名（trim）；空白名 400', async (t) => {
  const { db, base } = await setup(t);

  const auto = await api(base, '/api/rules', 'POST', ruleBody());
  const id = (auto.json as { id: number }).id;
  assert.equal(db.listPushRules().find((r) => r.id === id)!.name, `规则 ${id}`);

  const named = await api(base, '/api/rules', 'POST', ruleBody({ name: '  歌回专用  ' }));
  const id2 = (named.json as { id: number }).id;
  assert.equal(db.listPushRules().find((r) => r.id === id2)!.name, '歌回专用', '名称 trim 后入库');

  assert.equal((await api(base, '/api/rules', 'POST', ruleBody({ name: 5 }))).status, 400);
  assert.equal((await api(base, '/api/rules', 'POST', ruleBody({ name: '' }))).status, 400, 'POST 空白名 400');
  assert.equal((await api(base, `/api/rules/${id}`, 'PUT', { name: '' })).status, 400, 'PUT 空白名 400');
  const renamed = await api(base, `/api/rules/${id}`, 'PUT', { name: ' 杂谈 ' });
  assert.equal(renamed.status, 200);
  assert.equal(db.listPushRules().find((r) => r.id === id)!.name, '杂谈', 'PUT 改名 trim 后入库');
});

test('PUT /api/rules/order：全局拖拽排序（不再按 uid），非法 ids 400', async (t) => {
  const { db, base } = await setup(t);
  const a = (await api(base, '/api/rules', 'POST', ruleBody({ name: 'a' }))).json as { id: number };
  const b = (await api(base, '/api/rules', 'POST', ruleBody({ name: 'b' }))).json as { id: number };
  const c = (await api(base, '/api/rules', 'POST', ruleBody({ name: 'c' }))).json as { id: number };

  const r = await api(base, '/api/rules/order', 'PUT', { ids: [c.id, a.id, b.id] });
  assert.equal(r.status, 200);
  assert.deepEqual(
    db.listEnabledPushRules().map((x) => x.name),
    ['c', 'a', 'b'],
    '重排后按新顺序 = 全局匹配优先级',
  );

  assert.equal((await api(base, '/api/rules/order', 'PUT', { ids: [a.id, b.id] })).status, 400, '长度不一致');
  assert.equal((await api(base, '/api/rules/order', 'PUT', { ids: [a.id, a.id, c.id] })).status, 400, '重复');
  assert.equal((await api(base, '/api/rules/order', 'PUT', { ids: [a.id, b.id, 999] })).status, 400,
    '不存在的 id');
  assert.equal((await api(base, '/api/rules/order', 'PUT', { ids: ['x'] })).status, 400);
  assert.equal((await api(base, '/api/rules/order', 'PUT', {})).status, 400);
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

test('PUT /api/listen/:feature：坏体 400；未知 feature 404', async (t) => {
  const { base } = await setup(t, { listen: { bili: true, weibo: false } });
  const r = await api(base, '/api/listen');
  const dyn = (r.json['rows'] as Record<string, any>)['dynamic'];
  assert.equal(dyn.enabled, true, '登录态决定 auto 有效态（无 config 闸门）');

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

const LLM_CFG = {
  enabled: true, requestTimeoutMs: 5000, circuitThreshold: 2, circuitCooldownMs: 60_000,
  providers: [{
    name: 'ds', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
    vision: false, keyEnvs: [], enabled: true, structuredOutput: 'schema',
    api: 'chat-completions',
  }] as LlmProviderConfig[],
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

test('PUT /api/llm/keys：保存 → source=panel + router 热更新 + GET 回显；清除 → unset', async (t) => {
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

test('PUT /api/llm/keys：provider 不存在 404；非法 value 400；中文逗号归一成英文落库', async (t) => {
  const { base } = await setup(t, { llm: { config: LLM_CFG } });
  assert.equal((await api(base, '/api/llm/keys', 'PUT', { provider: 'nope', value: 'x' })).status, 404);
  assert.equal((await api(base, '/api/llm/keys', 'PUT', { provider: 'ds', value: 'has space' })).status, 400);
  const cn = await api(base, '/api/llm/keys', 'PUT', { provider: 'ds', value: 'sk-a，sk-b' });
  assert.equal(cn.status, 200, '中文逗号分隔的多 key 可保存');
  assert.deepEqual(cn.json.key, { source: 'panel', count: 2, value: 'sk-a,sk-b' }, '落库归一成英文逗号');
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

// ---- NapCat 托管 ----

/** 假 napcat dep：生效配置内存可变，state/launch/save 可注入 */
function fakeNapcatDep(): NonNullable<PanelDeps['napcat']> & { saved: Array<Record<string, unknown>> } {
  const cfg = { enabled: true, autorestart: false, dir: 'D:/CLI/NapCat.Shell', uin: '2954481774' };
  const saved: Array<Record<string, unknown>> = [];
  return {
    saved,
    effective: () => ({ ...cfg }),
    platform: 'win32',
    source: () => ({ enabled: 'config', autorestart: 'config', dir: 'config', uin: 'config' }),
    save: async (patch) => {
      saved.push(patch as Record<string, unknown>);
      if (patch.enabled !== undefined) cfg.enabled = patch.enabled;
      if (patch.autorestart !== undefined) cfg.autorestart = patch.autorestart;
      if (patch.dir !== undefined) cfg.dir = patch.dir;
      if (patch.uin !== undefined) cfg.uin = patch.uin;
    },
    state: async () => ({
      endpoint: 'http://127.0.0.1:3000',
      probe: { state: 'ok', loggedIn: true },
      taskRegistered: true,
      configReady: true,
    }),
    launch: async () => {},
  };
}

test('GET /api/napcat：生效配置 + source + 状态；无 dep 404', async (t) => {
  const noDep = await setup(t);
  assert.equal((await api(noDep.base, '/api/napcat')).status, 404);
  assert.equal((await api(noDep.base, '/api/napcat', 'PUT', { enabled: true })).status, 404);
  assert.equal((await api(noDep.base, '/api/napcat/launch', 'POST')).status, 404);

  const dep = fakeNapcatDep();
  const { base } = await setup(t, { napcat: dep });
  const r = await api(base, '/api/napcat');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, {
    enabled: true, autorestart: false, dir: 'D:/CLI/NapCat.Shell', uin: '2954481774', alertQq: '',
    platform: 'win32',
    source: { enabled: 'config', autorestart: 'config', dir: 'config', uin: 'config' },
    endpoint: 'http://127.0.0.1:3000',
    probe: { state: 'ok', loggedIn: true },
    taskRegistered: true,
    configReady: true,
  });
});

test('PUT /api/napcat：保存生效；uin/autorestart 非纯数字/非布尔 400', async (t) => {
  const dep = fakeNapcatDep();
  const { base } = await setup(t, { napcat: dep });

  const bad = await api(base, '/api/napcat', 'PUT', { uin: 'abc' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error!, /纯数字/);
  assert.equal((await api(base, '/api/napcat', 'PUT', { enabled: 'yes' })).status, 400);
  assert.equal((await api(base, '/api/napcat', 'PUT', { autorestart: 'yes' })).status, 400);
  assert.equal(dep.saved.length, 0, '校验失败不落库');

  const ok = await api(base, '/api/napcat', 'PUT', { dir: 'E:/NC', uin: '111', enabled: false, autorestart: true });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true, enabled: false, autorestart: true, dir: 'E:/NC', uin: '111', alertQq: '' });
  assert.deepEqual(dep.saved, [{ dir: 'E:/NC', uin: '111', enabled: false, autorestart: true }]);
});

test('PUT /api/napcat alertQq：纯数字校验、落 settings、留空清除', async (t) => {
  const db = new Db(':memory:');
  const dep = fakeNapcatDep();
  const realSave = saveNapcatConfig;
  dep.save = async (patch) => {
    dep.saved.push(patch as Record<string, unknown>);
    realSave(db, patch);
  };
  const { base } = await setup(t, { napcat: dep, db });

  const bad = await api(base, '/api/napcat', 'PUT', { alertQq: 'abc' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error!, /纯数字/);
  assert.equal(dep.saved.length, 0, '校验失败不落库');

  const ok = await api(base, '/api/napcat', 'PUT', { alertQq: '12345' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.alertQq, '12345');
  assert.equal(db.getSetting('napcat_alert_qq'), '12345');

  const g = await api(base, '/api/napcat');
  assert.equal(g.json.alertQq, '12345', 'GET 回读告警 QQ');

  const clr = await api(base, '/api/napcat', 'PUT', { alertQq: '' });
  assert.equal(clr.json.alertQq, '');
  assert.equal(db.getSetting('napcat_alert_qq'), null, '留空删 key');
});

test('POST /api/napcat/launch：失败信息透传为 400', async (t) => {
  const dep = fakeNapcatDep();
  dep.launch = async () => { throw new Error('拉起失败：计划任务未创建（先点「计划任务」一次性设置）'); };
  const { base } = await setup(t, { napcat: dep });
  const r = await api(base, '/api/napcat/launch', 'POST');
  assert.equal(r.status, 400);
  assert.match(r.json.error!, /计划任务未创建/);

  dep.launch = async () => {};
  assert.equal((await api(base, '/api/napcat/launch', 'POST')).status, 200);
});

test('PUT /api/napcat autorestart：save 抛错（如建任务失败）透传为 400', async (t) => {
  const dep = fakeNapcatDep();
  dep.save = async (patch) => {
    if (patch.autorestart === true) throw new Error('先填好路径与机器人 QQ 号再开启自动拉起');
  };
  const { base } = await setup(t, { napcat: dep });
  const r = await api(base, '/api/napcat', 'PUT', { autorestart: true });
  assert.equal(r.status, 400);
  assert.match(r.json.error!, /先填好路径/);

  dep.save = async () => {};
  assert.equal((await api(base, '/api/napcat', 'PUT', { autorestart: true })).status, 200);
});

// ---- 高级设置 /api/advanced ----

test('/api/advanced：GET 默认值；PUT 校验、落库、触发 onChanged', async (t) => {
  let changed = 0;
  const { base, db } = await setup(t, { advanced: { onChanged: () => { changed++; } } });

  const g = await api(base, '/api/advanced');
  assert.equal(g.status, 200);
  assert.equal(g.json['pollIntervalSec'], 45);

  assert.equal((await api(base, '/api/advanced', 'PUT', { pollIntervalSec: 10 })).status, 400, '越界 400');
  assert.equal((await api(base, '/api/advanced', 'PUT', { notifyOnFirstRun: 'yes' })).status, 400, '布尔类型错 400');
  assert.equal((await api(base, '/api/advanced', 'PUT', {})).status, 400, '空 patch 400');
  assert.equal(changed, 0, '校验失败不触发热生效');

  const ok = await api(base, '/api/advanced', 'PUT', { pollIntervalSec: 120, notifyOnFirstRun: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.json['pollIntervalSec'], 120);
  assert.equal(db.getSetting('poll_interval_sec'), '120');
  assert.equal(db.getSetting('notify_on_first_run'), '1');
  assert.equal(changed, 1, '保存成功触发热生效回调');
});

test('/api/advanced 图文补推三键：范围校验、落库、GET 回读', async (t) => {
  const { base, db } = await setup(t);

  const g = await api(base, '/api/advanced');
  assert.equal(g.json['backlogPushEnabled'], false, '默认不补推');
  assert.equal(g.json['backlogMaxAgeHours'], 6);
  assert.equal(g.json['backlogMaxPerAccount'], 3);

  assert.equal((await api(base, '/api/advanced', 'PUT', { backlogMaxAgeHours: 999 })).status, 400, '越界 400');
  assert.equal((await api(base, '/api/advanced', 'PUT', { backlogPushEnabled: 1 })).status, 400, '布尔类型错 400');

  const ok = await api(base, '/api/advanced', 'PUT', {
    backlogPushEnabled: true, backlogMaxAgeHours: 48, backlogMaxPerAccount: 3,
  });
  assert.equal(ok.status, 200);
  assert.equal(db.getSetting('backlog_push_enabled'), '1');
  assert.equal(db.getSetting('backlog_max_age_hours'), '48');
  assert.equal(db.getSetting('backlog_max_per_account'), '3');
});

// ---- 时间表 /api/schedule ----

/** 与 server 同口径：日界日串 → 起点 ts（北京时间 06:00） */
function dayStart(day: string): number {
  return Math.floor(Date.parse(day + 'T06:00:00+08:00') / 1000);
}

interface SchedFixture { db: Db; raw: Database.Database; base: string }

/** 文件库 + 旁路 raw 连接（预置历史时间戳），注入 panel setup */
async function schedSetup(t: import('node:test').TestContext): Promise<SchedFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'ddclaw-sched-'));
  const db = new Db(join(dir, 's.db'));
  const raw = new Database(join(dir, 's.db'));
  t.after(() => { raw.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const { base } = await setup(t, { db });
  return { db, raw, base };
}

function insertSession(
  raw: Database.Database,
  p: { roomId: string; liveTime: number; uid: string; title: string;
    firstSeen: number; lastSeen: number | null },
): void {
  raw.prepare(
    `INSERT INTO live_sessions
       (room_id, live_time, uid, uname, title, area_name, keyframe, cover, first_seen, notified_at, last_seen)
     VALUES (?, ?, ?, '主播1', ?, '网游', 'k.jpg', 'c.jpg', ?, NULL, ?)`,
  ).run(p.roomId, p.liveTime, p.uid, p.title, p.firstSeen, p.lastSeen);
}

test('/api/schedule：日界归属 + 空日期占位 + segments/verdicts 组装', async (t) => {
  const { db, raw, base } = await schedSetup(t);
  db.upsertStreamer({ uid: '1', uname: '主播1', alias: '阿梓', face: 'f.jpg' });
  const d9 = dayStart('2026-08-09');

  // A：08-10 05:59:59 开播、跨 06:00 播到 08:00 —— 按开播日归 08-09（06:00 前开播算前一天）
  const startA = d9 + DAY_S - 1; // d9 日界 + 86399 = 次日 05:59:59
  insertSession(raw, { roomId: 'rA', liveTime: 1001, uid: '1', title: '凌晨场',
    firstSeen: startA, lastSeen: startA + 7300 });
  raw.prepare(
    `INSERT INTO live_segments (room_id, live_time, start_ts, end_ts, title, area_name, parent_area_name, keyframe, created_at)
     VALUES ('rA', 1001, ?, ?, '上半场', '网游', '电子竞技', 'k.jpg', 1)`,
  ).run(startA, startA + 3600);
  raw.prepare(
    `INSERT INTO live_segments (room_id, live_time, start_ts, end_ts, title, area_name, parent_area_name, keyframe, created_at)
     VALUES ('rA', 1001, ?, NULL, '下半场', '虚拟Singer', '虚拟主播', 'k2.jpg', 1)`,
  ).run(startA + 3600);
  db.insertVerdict({ roomId: 'rA', liveTime: 1001, uid: '1', categoryId: 1, categoryName: '歌回',
    source: 'llm', confidence: 0.9, evidence: '在唱歌' });

  // B：08-10 06:01 开播 —— 归 08-10（06:00 后开播算当天）
  insertSession(raw, { roomId: 'rB', liveTime: 1002, uid: '1', title: '早场',
    firstSeen: d9 + DAY_S + 61, lastSeen: null });

  const r = await api(base, '/api/schedule?from=2026-08-09&to=2026-08-11');
  assert.equal(r.status, 200);
  const days = r.json['days'] as Array<{ date: string; entries: Array<Record<string, unknown>> }>;
  assert.deepEqual(days.map((d) => d.date), ['2026-08-09', '2026-08-10', '2026-08-11']);
  assert.deepEqual(days[2]!.entries, [], '无场次的日期返回空 entries');

  const dayA = days[0]!.entries;
  assert.equal(dayA.length, 1);
  const a = dayA[0]!;
  assert.equal(a['kind'], 'live');
  assert.equal(a['name'], '阿梓', 'alias 优先');
  assert.equal(a['face'], 'f.jpg');
  assert.deepEqual([a['startTs'], a['endTs']], [startA, startA + 7300], '跨 06:00 整体按开播日归属');
  assert.deepEqual([a['keyframe'], a['cover']], ['k.jpg', 'c.jpg']);
  const aSegs = a['segments'] as Array<Record<string, unknown>>;
  assert.deepEqual(
    aSegs.map((s) => [s['startTs'], s['endTs'], s['title']]),
    [[startA, startA + 3600, '上半场'], [startA + 3600, startA + 7300, '下半场']],
    'last_seen 过鲜度窗口 = 已下播，开口段兜底关闭到场次终点',
  );
  assert.deepEqual(a['verdicts'], [
    { categoryName: '歌回', source: 'llm', confidence: 0.9, evidence: '在唱歌' },
  ]);

  const dayB = days[1]!.entries;
  assert.equal(dayB.length, 1);
  assert.equal(dayB[0]!['roomId'], 'rB', '06:01 开播归当天');
  assert.equal(dayB[0]!['endTs'], dayB[0]!['startTs'], '无 last_seen 的 legacy 场终点 = first_seen（零长，前端不画）');
});

const DAY_S = 86400;

test('/api/schedule：缺省 from/to = 今天-7 ~ 今天+1（北京日），共 9 天', async (t) => {
  const { base } = await setup(t);
  const r = await api(base, '/api/schedule');
  assert.equal(r.status, 200);
  const days = r.json['days'] as Array<{ date: string; entries: unknown[] }>;
  assert.equal(days.length, 9);
  const tomorrow = new Date(Date.now() + 8 * 3600_000 + DAY_S * 1000).toISOString().slice(0, 10);
  assert.equal(days[8]!.date, tomorrow, '缺省 to = 北京明天');
  for (const d of days) assert.deepEqual(d.entries, [], '空库全空 entries');
});

test('/api/schedule 参数校验：坏格式 / from 晚于 to / 跨度超 62 天 → 400', async (t) => {
  const { base } = await setup(t);
  const bad1 = await api(base, '/api/schedule?from=2026/08/01');
  assert.equal(bad1.status, 400);
  assert.match(bad1.json.error ?? '', /YYYY-MM-DD/);
  assert.equal((await api(base, '/api/schedule?from=2026-13-01')).status, 400, '非法月份');
  assert.equal((await api(base, '/api/schedule?from=2026-08-10&to=2026-08-09')).status, 400, 'from 晚于 to');
  assert.equal((await api(base, '/api/schedule?from=2026-08-01&to=2026-10-10')).status, 400, '跨度 70 天');
  assert.equal((await api(base, '/api/schedule?from=2026-08-01&to=2026-10-02')).status, 200, '62 天整放行');
});

// ---- /api/snapshot 缓存关键帧 ----

/** 二进制 GET（api() 助手固定解析 JSON，图片字节用它读不了）；带同款重试 */
async function rawGet(base: string, path: string): Promise<{ status: number; body: Buffer; headers: Headers }> {
  let res: Response | null = null;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5 && res === null; attempt++) {
    try {
      res = await fetch(base + path, { headers: { connection: 'close' } });
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 30));
    }
  }
  if (res === null) throw lastErr;
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}

test('/api/snapshot：200 字节与 content-type 正确（jpg/png）、no-store', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ddclaw-snap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { base, db } = await setup(t, { snapshots: { dir } });

  const jpgDir = join(dir, '80397', '1000');
  mkdirSync(jpgDir, { recursive: true });
  const jpgData = Buffer.from('fake-jpeg-bytes');
  writeFileSync(join(jpgDir, '1800000000.jpg'), jpgData);
  db.insertSnapshot({ roomId: '80397', liveTime: 1000, ts: 1800000000, path: join(jpgDir, '1800000000.jpg'), bytes: jpgData.length });
  const pngData = Buffer.from('fake-png-bytes');
  writeFileSync(join(jpgDir, '1800000300.png'), pngData);
  db.insertSnapshot({ roomId: '80397', liveTime: 1000, ts: 1800000300, path: join(jpgDir, '1800000300.png'), bytes: pngData.length });

  const r1 = await rawGet(base, '/api/snapshot?room=80397&lt=1000&ts=1800000100');
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.body, jpgData, '取最近一帧（jpg）');
  assert.equal(r1.headers.get('content-type'), 'image/jpeg');
  assert.equal(r1.headers.get('cache-control'), 'no-store');

  const r2 = await rawGet(base, '/api/snapshot?room=80397&lt=1000&ts=1800000290');
  assert.equal(r2.status, 200);
  assert.deepEqual(r2.body, pngData, '取最近一帧（png）');
  assert.equal(r2.headers.get('content-type'), 'image/png');
});

test('/api/snapshot：无匹配行 404、坏参 400、无 dep 404', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ddclaw-snap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { base } = await setup(t, { snapshots: { dir } });

  assert.equal((await rawGet(base, '/api/snapshot?room=80397&lt=1000&ts=100')).status, 404, '无行 404');
  assert.equal((await rawGet(base, '/api/snapshot?room=&lt=1000&ts=100')).status, 400, 'room 空 400');
  assert.equal((await rawGet(base, '/api/snapshot?room=abc&lt=1000&ts=100')).status, 400, 'room 非数字 400');
  assert.equal((await rawGet(base, '/api/snapshot?room=80397&lt=x&ts=100')).status, 400, 'lt 非数字 400');
  assert.equal((await rawGet(base, '/api/snapshot?room=80397&lt=1000')).status, 400, '缺 ts 400');

  const bare = await setup(t);
  assert.equal((await rawGet(bare.base, '/api/snapshot?room=80397&lt=1000&ts=100')).status, 404, '无 dep 404');
});

test('/api/snapshot：路径穿越 404（库里的 path 必须落在注入目录内）', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ddclaw-snap-'));
  const outside = mkdtempSync(join(tmpdir(), 'ddclaw-snap-out-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const { base, db } = await setup(t, { snapshots: { dir } });

  const secret = join(outside, 'secret.jpg');
  writeFileSync(secret, 'should-never-serve');
  db.insertSnapshot({ roomId: '80397', liveTime: 1000, ts: 100, path: secret, bytes: 18 });

  assert.equal((await rawGet(base, '/api/snapshot?room=80397&lt=1000&ts=100')).status, 404, '目录外文件 404');
});

test('/api/snapshot：库里有行但文件读不到 404', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ddclaw-snap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { base, db } = await setup(t, { snapshots: { dir } });
  db.insertSnapshot({ roomId: '80397', liveTime: 1000, ts: 100, path: join(dir, 'gone.jpg'), bytes: 10 });
  assert.equal((await rawGet(base, '/api/snapshot?room=80397&lt=1000&ts=100')).status, 404);
});

// ---- /api/avatar 头像代理 ----

test('/api/avatar：按 uid 反代主播头像（带 UA+Referer），内容/类型/缓存头正确', async (t) => {
  const fakePng = Buffer.from('fake-png-bytes');
  let seenUrl = '';
  let seenReferer = '';
  const fetchImpl: FetchLike = async (url, init) => {
    seenUrl = url;
    seenReferer = String(((init.headers ?? {}) as Record<string, string>)['Referer'] ?? '');
    return new Response(fakePng, { status: 200, headers: { 'content-type': 'image/png' } });
  };
  const { base, db } = await setup(t, { avatar: { fetchImpl } });
  db.upsertStreamer({ uid: '1001', uname: '阿梓', face: 'https://i0.hdslb.com/bfs/face/f1.png' });

  const r = await rawGet(base, '/api/avatar?uid=1001');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, fakePng);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(r.headers.get('cache-control'), 'private, no-cache');
  assert.equal(seenUrl, 'https://i0.hdslb.com/bfs/face/f1.png', '反代的是主播头像 URL');
  assert.equal(seenReferer, 'https://live.bilibili.com/', '带 B站图床要求的 Referer');
});

test('/api/avatar：坏 uid 400 / 无该主播或无头像 404 / 非白名单 host 400', async (t) => {
  const { base, db } = await setup(t);
  assert.equal((await rawGet(base, '/api/avatar?uid=abc')).status, 400, 'uid 非数字 400');
  assert.equal((await rawGet(base, '/api/avatar')).status, 400, '缺 uid 400');
  assert.equal((await rawGet(base, '/api/avatar?uid=9999')).status, 404, '无该主播 404');
  db.upsertStreamer({ uid: '1002', uname: '无头像' });
  assert.equal((await rawGet(base, '/api/avatar?uid=1002')).status, 404, '无头像 404');
  db.upsertStreamer({ uid: '1003', uname: '坏域名', face: 'https://evil.example.com/x.jpg' });
  assert.equal((await rawGet(base, '/api/avatar?uid=1003')).status, 400, '非白名单 host 400');
});

// ---- /api/x-avatar X 头像本地缓存 ----

test('/api/x-avatar：按文件名读缓存目录，jpg/png 类型与长缓存头正确', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ddclaw-xava-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { base } = await setup(t, { xAvatars: { dir } });

  const jpgName = 'a'.repeat(32) + '.jpg';
  const jpgData = Buffer.from('fake-x-avatar-jpg');
  writeFileSync(join(dir, jpgName), jpgData);
  const r1 = await rawGet(base, `/api/x-avatar?file=${jpgName}`);
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.body, jpgData);
  assert.equal(r1.headers.get('content-type'), 'image/jpeg');
  assert.equal(r1.headers.get('cache-control'), 'max-age=86400', 'md5 文件名随内容变，长缓存');

  const pngName = 'b'.repeat(32) + '.png';
  writeFileSync(join(dir, pngName), Buffer.from('fake-x-avatar-png'));
  assert.equal((await rawGet(base, `/api/x-avatar?file=${pngName}`)).headers.get('content-type'), 'image/png');
});

test('/api/x-avatar：坏文件名 400（白名单即防穿越）、缺文件 404、无 dep 404', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ddclaw-xava-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { base } = await setup(t, { xAvatars: { dir } });

  assert.equal((await rawGet(base, '/api/x-avatar?file=../../.env')).status, 400, '穿越字符 400');
  assert.equal((await rawGet(base, '/api/x-avatar?file=not-md5.jpg')).status, 400, '非 md5 名 400');
  assert.equal((await rawGet(base, '/api/x-avatar')).status, 400, '缺 file 400');
  assert.equal((await rawGet(base, `/api/x-avatar?file=${'c'.repeat(32)}.jpg`)).status, 404, '文件不存在 404');

  const bare = await setup(t);
  assert.equal((await rawGet(bare.base, `/api/x-avatar?file=${'c'.repeat(32)}.jpg`)).status, 404, '无 dep 404');
});

// ---- X / 推特 独立分页（/api/x*）----
// 这几条守的是「X 与开播那套设置完全分开」：X 未注入时整组端点 404，
// 注入后读写只碰 x_* 设置；探测走显式 POST，GET 绝不打网络（靠 onChanged/测试计数验证）。

/** 生产装配形状的 x dep：配置落 settings，探测结果只更新内存快照 */
function makeXDep(db: Db, calls: string[]): NonNullable<PanelDeps['x']> {
  let status = {
    proxy: { ok: false, message: '尚未测试', checkedAt: null as number | null },
    instances: [] as { host: string; ok: boolean; message: string }[],
    web: { ok: false, message: '尚未测试', checkedAt: null as number | null },
    // 生产形状里恒有 feed（emptyXStatus 就带它），桩也照抄，免得测出一个生产不会出现的空态
    feed: emptyXFeedSnapshot(),
    updatedAt: null as number | null,
  };
  return {
    info: () => ({ config: getXConfig(db), status }),
    save: (patch) => { saveXConfig(db, patch); return getXConfig(db); },
    test: async (req) => {
      calls.push(req.target);
      const cfg = getXConfig(db);
      const now = Math.floor(Date.now() / 1000);
      const out: Record<string, unknown> = {};
      if (req.target === 'all' || req.target === 'proxy') {
        out.proxy = { ok: true, kind: 'ok', target: 'https://x.com/robots.txt', status: 200, ms: 12, message: '代理可达' };
      }
      if (req.target === 'all' || req.target === 'instances') {
        out.instances = (req.instances !== undefined ? req.instances.split(',') : cfg.instances)
          .map((h) => ({ host: h.trim(), ok: h.trim() === 'a.example', kind: 'ok', status: 200, ms: 5, message: '可用' }));
      }
      if (req.target === 'all' || req.target === 'web') {
        out.web = { ok: true, screenName: 'watase_yuzuki', status: 200, ms: 9, tweetIds: 7, latestId: '1', latestAt: now, message: '免登录可用' };
      }
      if (out.proxy) status = { ...status, proxy: { ok: true, message: '代理可达', checkedAt: now } };
      if (out.instances) {
        status = { ...status, instances: (out.instances as { host: string; ok: boolean }[]).map((i) => ({ host: i.host, ok: i.ok, message: '可用' })) };
      }
      if (out.web) status = { ...status, web: { ok: true, message: '免登录可用', checkedAt: now } };
      status = { ...status, updatedAt: now };
      return { ...out, status };
    },
    // 存在性校验桩：名字里带 ghost 的算「不存在」，其余算存在（链路原因那条路在下面单独测）；
    // ok 分支带 og:title 抠出的显示名（生产里 verify 顺手种入 nickname）
    verify: async (screenName) => (screenName.includes('ghost')
      ? { checked: true, ok: false, kind: 'not-found' as const, message: 'x.com 提示该账号不存在' }
      : screenName.includes('offline')
        ? { checked: true, ok: false, kind: 'link' as const, message: '代理不可达（ECONNREFUSED）' }
        : { checked: true, ok: true, kind: 'ok' as const, name: '渡瀬 結月', message: '账号存在（页面含 7 条推文）' }),
    onChanged: () => { calls.push('saved'); },
  };
}

test('/api/x：未注入 x dep → 整组端点 404（与开播设置彻底分开）', async (t) => {
  const { base } = await setup(t);
  assert.equal((await api(base, '/api/x')).status, 404);
  assert.equal((await api(base, '/api/x', 'PUT', { intervalSec: 300 })).status, 404);
  assert.equal((await api(base, '/api/x/test', 'POST', { target: 'all' })).status, 404);
});

test('/api/x：GET 返回默认配置且不打网络；PUT 落 settings 并回调热生效', async (t) => {
  const db = new Db(':memory:');
  const calls: string[] = [];
  const { base } = await setup(t, { db, x: makeXDep(db, calls) });

  const got = await api(base, '/api/x');
  assert.equal(got.status, 200);
  const config = got.json.config as Record<string, unknown>;
  assert.equal(config.proxyUrl, 'http://127.0.0.1:7890', '默认代理');
  assert.equal(config.intervalSec, 300);
  assert.equal(config.fallbackHtml, true);
  assert.deepEqual(config.instances, ['nitter.jaydenha.uk', 'x.n0g.xyz']);
  assert.deepEqual(calls, [], 'GET 不得触发任何探测');

  const put = await api(base, '/api/x', 'PUT', {
    proxyUrl: '127.0.0.1:1080', instances: 'a.example, b.example', intervalSec: 600, fallbackHtml: false,
  });
  assert.equal(put.status, 200);
  assert.equal((put.json.config as Record<string, unknown>).proxyUrl, '127.0.0.1:1080', '裸 host:port 被接受');
  assert.equal(db.getSetting('x_proxy_url'), '127.0.0.1:1080', '落 settings 唯一信源');
  assert.equal(db.getSetting('x_nitter_instances'), 'a.example,b.example');
  assert.equal(db.getSetting('x_interval_sec'), '600');
  assert.equal(db.getSetting('x_fallback_html'), '0');
  assert.deepEqual(calls, ['saved'], '保存触发一次热生效回调');
});

test('/api/x：PUT 校验代理形状与间隔范围（配置错误当场报，不等轮询才炸）', async (t) => {
  const db = new Db(':memory:');
  const { base } = await setup(t, { db, x: makeXDep(db, []) });
  const bad = await api(base, '/api/x', 'PUT', { proxyUrl: 'socks5://127.0.0.1:1080' });
  assert.equal(bad.status, 400);
  assert.match(String(bad.json.error), /代理只支持 http/);
  assert.equal((await api(base, '/api/x', 'PUT', { intervalSec: 10 })).status, 400, '低于下限');
  assert.equal((await api(base, '/api/x', 'PUT', { intervalSec: 999999 })).status, 400, '高于上限');
  assert.equal((await api(base, '/api/x', 'PUT', { instances: 'bad_host' })).status, 400, '实例含下划线（非法 host）');
  assert.equal((await api(base, '/api/x', 'PUT', {})).status, 400, '空 patch');
  assert.equal((await api(base, '/api/x', 'PUT', { nope: 1 })).status, 400, '未知字段');
  assert.equal(db.getSetting('x_proxy_url'), null, '校验失败不落库');
});

test('/api/x/test：探测按 target 裁剪，且允许用未保存的输入值（先测后存）', async (t) => {
  const db = new Db(':memory:');
  const calls: string[] = [];
  const { base } = await setup(t, { db, x: makeXDep(db, calls) });

  const only = await api(base, '/api/x/test', 'POST', { target: 'proxy' });
  assert.equal(only.status, 200);
  assert.ok(only.json.proxy, '只测代理时返回 proxy');
  assert.equal(only.json.instances, undefined, '不越权测实例');
  assert.deepEqual(calls, ['proxy']);

  const inst = await api(base, '/api/x/test', 'POST', { target: 'instances', instances: 'a.example,b.example' });
  const list = inst.json.instances as { host: string; ok: boolean }[];
  assert.deepEqual(list.map((i) => i.host), ['a.example', 'b.example'], '用请求里的覆盖值而非库里的');
  assert.equal(list[0]!.ok, true, 'a.example 模拟可用');

  const bad = await api(base, '/api/x/test', 'POST', { target: 'nope' });
  assert.equal(bad.status, 400, 'target 白名单');

  const after = await api(base, '/api/x');
  const status = after.json.status as { proxy: { ok: boolean }; instances: unknown[] };
  assert.equal(status.proxy.ok, true, '测试结果写进快照供卡片显示');
  assert.equal(status.instances.length, 2);
});

// ---- X 关注账号（独立名单）：CRUD + 存在性校验的两类失败 ----

test('/api/x/accounts：空名单 / 新增成功（含校验回报）/ 重名 409 / 非法格式 400', async (t) => {
  const db = new Db(':memory:');
  const calls: string[] = [];
  const { base } = await setup(t, { db, x: makeXDep(db, calls) });

  assert.deepEqual(((await api(base, '/api/x/accounts')).json.accounts as unknown[]).length, 0, '初始为空');

  const created = await api(base, '/api/x/accounts', 'POST', { screenName: '@Watase_Yuzuki' });
  assert.equal(created.status, 200);
  const acc = created.json.account as { id: number; screenName: string; nickname: string | null; enabled: boolean };
  assert.equal(acc.screenName, 'watase_yuzuki', 'screen name 归一化（去 @ 转小写）');
  assert.equal(acc.enabled, true, '新增默认启用');
  assert.equal(acc.nickname, '渡瀬 結月', '昵称由 verify 顺手种入（og:title 显示名，平台事实不收手填）');
  assert.equal((created.json.verify as { ok: boolean }).ok, true, '回报校验结果');
  assert.deepEqual(calls, ['saved'], '新增触发一次热生效回调');

  assert.equal((await api(base, '/api/x/accounts', 'POST', { screenName: 'watase_yuzuki' })).status, 409, '重名');
  assert.equal((await api(base, '/api/x/accounts', 'POST', { screenName: 'bad name!' })).status, 400, '格式非法');
  assert.equal((await api(base, '/api/x/accounts', 'POST', { screenName: 'x', nickname: '手填昵称' })).status, 400, '昵称不接受手填（未知字段）');
  assert.equal((await api(base, '/api/x/accounts', 'POST', {})).status, 400, '缺 screenName');

  const list = (await api(base, '/api/x/accounts')).json.accounts as { screenName: string }[];
  assert.equal(list.length, 1);
});

test('/api/x/accounts：账号不存在 → 400；链路不通 → 照收并回报原因（代理没开也能加）', async (t) => {
  const db = new Db(':memory:');
  const { base } = await setup(t, { db, x: makeXDep(db, []) });

  const ghost = await api(base, '/api/x/accounts', 'POST', { screenName: 'ghost_user' });
  assert.equal(ghost.status, 400, '账号不存在是硬错误');
  assert.match(String(ghost.json.error), /账号不存在/);
  assert.equal(db.listXAccounts().length, 0, '拒绝时不落库');

  const offline = await api(base, '/api/x/accounts', 'POST', { screenName: 'offline_guy' });
  assert.equal(offline.status, 200, '链路原因不拦，照收');
  assert.equal((offline.json.verify as { ok: boolean }).ok, false);
  assert.match(String((offline.json.verify as { message: string }).message), /代理不可达/);
  assert.equal(db.listXAccounts().length, 1, '照收时确实入库');
});

test('/api/x/accounts：关联主播必须存在；编辑/启停/删除与 404', async (t) => {
  const db = new Db(':memory:');
  const { base } = await setup(t, { db, x: makeXDep(db, []) });
  db.upsertStreamer({ uid: '1001', uname: '阿梓' });
  const id = db.upsertXAccount({ screenName: 'watase_yuzuki', displayName: null, biliUid: null, enabled: true });

  assert.equal(
    (await api(base, '/api/x/accounts', 'POST', { screenName: 'd4dj_pj', biliUid: '9999' })).status, 400,
    '关联主播不在监听名单 → 400',
  );
  const withBili = await api(base, '/api/x/accounts', 'POST', { screenName: 'd4dj_pj', biliUid: '1001' });
  assert.equal(withBili.status, 200);
  assert.equal((withBili.json.account as { biliName: string }).biliName, '阿梓', '回显关联主播展示名');

  const put = await api(base, '/api/x/accounts/' + id, 'PUT', { enabled: false });
  assert.equal(put.status, 200);
  assert.equal((put.json.account as { enabled: boolean }).enabled, false, '启停生效');

  assert.equal((await api(base, '/api/x/accounts/' + id, 'PUT', { screenName: 'd4dj_pj' })).status, 400, 'screenName 是身份锚点不可改（未知字段 400）');
  assert.equal((await api(base, '/api/x/accounts/' + id, 'PUT', { nickname: '手填昵称' })).status, 400, '昵称是平台事实不可改（未知字段 400）');
  assert.equal((await api(base, '/api/x/accounts/' + id, 'PUT', {})).status, 400, '空 patch');
  assert.equal((await api(base, '/api/x/accounts/99999', 'PUT', { enabled: true })).status, 404);

  assert.equal((await api(base, '/api/x/accounts/' + id, 'DELETE')).status, 200);
  assert.equal((await api(base, '/api/x/accounts/' + id, 'DELETE')).status, 404, '再删一次 404');
  assert.equal(db.listXAccounts().length, 1, '只剩 d4dj_pj');
});

test('/api/listen：推特开关的 auto 判据是「代理已配置」，PUT 可落手动值', async (t) => {
  const db = new Db(':memory:');
  const calls: string[] = [];
  const { base } = await setup(t, {
    db, x: makeXDep(db, calls),
    listen: { bili: true, weibo: true, twitter: () => getXConfig(db).proxyUrl.trim() !== '' },
  });

  // 默认配置自带代理地址（http://127.0.0.1:7890）→ 前提满足 → auto 开
  let info = await api(base, '/api/listen');
  const rows = info.json.rows as Record<string, { enabled: boolean; setting: string | null }>;
  assert.equal(rows.twitter!.enabled, true, '默认代理已配置 → auto 开');
  assert.equal(info.json.xProxyConfigured, true);
  assert.equal(rows.twitter!.setting, null, 'auto 模式无手动设置');

  // 显式清空代理（墙外部署「不用代理」）→ 前提不满足 → auto 关
  saveXConfig(db, { proxyUrl: '' });
  info = await api(base, '/api/listen');
  assert.equal((info.json.rows as Record<string, { enabled: boolean }>).twitter!.enabled, false, '无代理 → auto 关');

  // 前提不满足也允许手动开：UI 显示开，源实际不跑（由 shouldRunListen 拦）
  const put = await api(base, '/api/listen/twitter', 'PUT', { enabled: true });
  assert.equal(put.status, 200);
  assert.equal((put.json as { enabled: boolean }).enabled, true);
  assert.equal(db.getSetting('listen_twitter'), '1');

  // 配好代理 → 前提满足；此时手动开 == auto，开关应回 auto（settings key 被删）
  saveXConfig(db, { proxyUrl: 'http://127.0.0.1:7890' });
  const put2 = await api(base, '/api/listen/twitter', 'PUT', { enabled: true });
  assert.equal((put2.json as { setting: string | null }).setting, null, '与 auto 一致 → 回 auto');
  info = await api(base, '/api/listen');
  assert.equal((info.json.rows as Record<string, { enabled: boolean }>).twitter!.enabled, true);
});

// ---- 图文帖规则（X/推特；与推送规则平行的另一张表）----

test('/api/post-rules：CRUD + 引用校验 + 死规则拒绝 + 排序', async (t) => {
  const db = new Db(':memory:');
  const { base } = await setup(t, { db, x: makeXDep(db, []) });
  const channelId = db.upsertPushChannel({
    name: '粉丝群', notifier: 'onebot', targetType: 'group', targetId: '10001', enabled: true,
  });

  assert.deepEqual(((await api(base, '/api/post-rules')).json.rules as unknown[]).length, 0, '初始无规则');

  const created = await api(base, '/api/post-rules', 'POST', {
    name: '只推带图原创', channels: [channelId], filters: { media: true },
  });
  assert.equal(created.status, 201);
  const id = (created.json as { id: number }).id;
  const list = (await api(base, '/api/post-rules')).json.rules as Array<{
    filters: { original: boolean; retweet: boolean; media: boolean };
  }>;
  assert.equal(list[0]!.filters.original, true, '未提供的筛选回落默认（只推原创）');
  assert.equal(list[0]!.filters.media, true);
  assert.equal('accountIds' in list[0]!, false, '规则不再携带账号集合（生效范围在账号侧 ruleIds）');
  assert.equal('platform' in list[0]!, false, '规则已平台无关，响应不再带 platform');

  // platform 已退役：按未知字段 400（与 accountIds 退役同口径）
  assert.equal(
    (await api(base, '/api/post-rules', 'POST', { platform: 'weibo' })).status, 400,
    'platform 已退役，按未知字段拒',
  );

  // 「原创/转发都不勾」= 永不命中的死规则，当场拒绝
  assert.equal(
    (await api(base, '/api/post-rules', 'POST', { filters: { original: false, retweet: false } })).status,
    400,
    '死规则拒绝',
  );
  assert.equal((await api(base, '/api/post-rules', 'POST', { channels: [999] })).status, 400, '渠道不存在');
  assert.equal(
    (await api(base, '/api/post-rules', 'POST', { accountIds: [1] })).status, 400,
    'accountIds 已退役，按未知字段拒',
  );
  assert.equal((await api(base, '/api/post-rules', 'POST', { filters: { nope: true } })).status, 400, '未知筛选字段');
  assert.equal((await api(base, '/api/post-rules', 'POST', { filters: { media: 'yes' } })).status, 400, '筛选类型错');

  // PUT：只改 filters 时渠道沿用旧值 → 合并后仍要可用
  assert.equal(
    (await api(base, `/api/post-rules/${id}`, 'PUT', { filters: { original: false, retweet: false } })).status,
    400,
    '合并后成了死规则也要拒',
  );
  assert.equal((await api(base, `/api/post-rules/${id}`, 'PUT', { enabled: false })).status, 200);
  assert.equal(db.listPostRules()[0]!.enabled, false);
  assert.equal((await api(base, `/api/post-rules/${id}`, 'PUT', {})).status, 400, '空 patch');
  assert.equal(
    (await api(base, `/api/post-rules/${id}`, 'PUT', { platform: 'twitter' })).status, 400,
    'PUT 传 platform 同样按未知字段拒',
  );

  // 排序：ids 必须是全排列
  const id2 = db.upsertPostRule({
    name: 'r2', channels: [], filters: defaultPostFilters(),
    messageTemplate: null, enabled: true,
  });
  assert.equal((await api(base, '/api/post-rules/order', 'PUT', { ids: [id2, id] })).status, 200);
  assert.deepEqual(db.listPostRules().map((r) => r.id), [id2, id], '顺序按传入重写');
  assert.equal((await api(base, '/api/post-rules/order', 'PUT', { ids: [id] })).status, 400, '必须全排列');

  assert.equal((await api(base, `/api/post-rules/${id}`, 'DELETE')).status, 200);
  assert.equal((await api(base, `/api/post-rules/${id}`, 'DELETE')).status, 404, '再删一次 404');
});

test('/api/post-rules：开了 LLM 判定就必须填判定标准（口径由人填）', async (t) => {
  const db = new Db(':memory:');
  const { base } = await setup(t, { db, x: makeXDep(db, []) });

  assert.equal(
    (await api(base, '/api/post-rules', 'POST', { llmJudge: true })).status, 400,
    '开了判定却没标准 → 拒绝（不让模型自由发挥）',
  );
  assert.equal(
    (await api(base, '/api/post-rules', 'POST', { llmJudge: true, judgePrompt: '   ' })).status, 400,
    '全空白不算填了',
  );

  const created = await api(base, '/api/post-rules', 'POST', {
    name: 'LLM 判定规则', llmJudge: true, judgePrompt: '只推与直播预告相关的推文', llmTranslate: true,
  });
  assert.equal(created.status, 201);
  const r = db.listPostRules()[0]!;
  assert.equal(r.llmJudge, true);
  assert.equal(r.judgePrompt, '只推与直播预告相关的推文');
  assert.equal(r.llmTranslate, true, '翻译开关落库');

  // PUT 对「合并后」的形状校验：只清标准、判定仍开 → 400
  assert.equal((await api(base, `/api/post-rules/${r.id}`, 'PUT', { judgePrompt: null })).status, 400);
  // 同时关掉判定就可以清空标准
  assert.equal(
    (await api(base, `/api/post-rules/${r.id}`, 'PUT', { llmJudge: false, judgePrompt: null })).status, 200,
  );
  assert.equal(db.listPostRules()[0]!.judgePrompt, null);
  assert.equal(db.listPostRules()[0]!.llmTranslate, true, '没动的字段保留');
});

test('/api/x/accounts：名单行携带最近 3 条推文（不含 raw）+ 关联主播展示名', async (t) => {
  const db = new Db(':memory:');
  const { base } = await setup(t, { db, x: makeXDep(db, []) });
  db.upsertXAccount({ screenName: 'watase_yuzuki', displayName: null, biliUid: null, enabled: true });
  db.insertPosts([
    { platform: 'twitter', uid: 'watase_yuzuki', itemId: '1', type: 'tweet', text: 'a', pics: [], pubTs: 2000, url: null, raw: '{"x":1}' },
    { platform: 'twitter', uid: 'watase_yuzuki', itemId: '2', type: 'retweet', text: 'b', pics: [], pubTs: 3000, url: null, raw: null },
    { platform: 'bili_dynamic', uid: '1', itemId: '3', type: 'DYNAMIC_TYPE_WORD', text: 'c', pics: [], pubTs: 4000, url: null, raw: null },
    { platform: 'twitter', uid: 'd4dj_pj', itemId: '4', type: 'tweet', text: 'd', pics: [], pubTs: 5000, url: null, raw: null },
  ]);
  const r = await api(base, '/api/x/accounts');
  assert.equal(r.status, 200);
  const accounts = r.json.accounts as Array<{ screenName: string; posts: Array<{ pubTs: number; raw?: unknown }> }>;
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]!.posts.length, 2, '只带本账号的 X 归档');
  assert.deepEqual(accounts[0]!.posts.map((p) => p.pubTs), [3000, 2000], '按发布时间倒序');
  assert.equal(accounts[0]!.posts[0]!.raw, undefined, 'raw 不下发');
});

// ---- 微博（图文分页第二个来源）：状态快照 + 独立名单 CRUD ----

/** 生产装配形状的 weibo dep：GET 只读快照，名单变化回调热生效（计数验证） */
function makeWeiboDep(db: Db, calls: string[]): NonNullable<PanelDeps['weibo']> {
  return {
    info: () => ({
      config: { intervalSec: 300 },
      status: { feed: emptyWeiboFeedSnapshot(), accounts: db.listWeiboAccounts(true).length },
    }),
    onChanged: () => { calls.push('changed'); },
  };
}

test('/api/weibo：未注入 dep → 整组端点 404', async (t) => {
  const { base } = await setup(t);
  assert.equal((await api(base, '/api/weibo')).status, 404);
  assert.equal((await api(base, '/api/weibo/accounts')).status, 404);
  assert.equal((await api(base, '/api/weibo/accounts', 'POST', { uid: '1' })).status, 404);
});

test('/api/weibo：GET 只读快照（含账号数与运行状态），绝不打网络', async (t) => {
  const db = new Db(':memory:');
  const calls: string[] = [];
  const { base } = await setup(t, { db, weibo: makeWeiboDep(db, calls) });
  db.upsertWeiboAccount({ uid: '2203177060', nickname: '渡瀬結月', biliUid: null, enabled: true });

  const r = await api(base, '/api/weibo');
  assert.equal(r.status, 200);
  const status = r.json.status as { accounts: number; feed: { running: boolean; lastError: string | null } };
  assert.equal(status.accounts, 1);
  assert.equal(status.feed.running, false);
  assert.equal(status.feed.lastError, null);
  assert.deepEqual(calls, [], 'GET 不触发热生效');
});

test('/api/weibo/accounts：uid 直填 / 昵称解析 / 重名 409 / 非法 uid 400', async (t) => {
  const db = new Db(':memory:');
  const calls: string[] = [];
  const { base } = await setup(t, {
    db,
    weibo: makeWeiboDep(db, calls),
    weiboResolver: {
      resolveUid: async (nick) => (nick === '渡瀬結月' ? '2203177060' : null),
    },
  });

  assert.deepEqual(((await api(base, '/api/weibo/accounts')).json.accounts as unknown[]).length, 0, '初始空名单');

  // 直填 uid（也认 weibo.com/u/<uid> 形态）
  const created = await api(base, '/api/weibo/accounts', 'POST', { uid: 'https://weibo.com/u/1234567890' });
  assert.equal(created.status, 200);
  assert.equal((created.json.account as { uid: string }).uid, '1234567890');
  assert.deepEqual(calls, ['changed'], '新增后触发热生效（立刻开始抓）');

  // 昵称解析：解析不到 → 400
  assert.equal((await api(base, '/api/weibo/accounts', 'POST', { nickname: '查无此人' })).status, 400);
  const byNick = await api(base, '/api/weibo/accounts', 'POST', { nickname: '渡瀬結月' });
  assert.equal(byNick.status, 200);
  assert.equal((byNick.json.account as { uid: string }).uid, '2203177060');

  assert.equal((await api(base, '/api/weibo/accounts', 'POST', { uid: '2203177060' })).status, 409, '重名 409');
  assert.equal((await api(base, '/api/weibo/accounts', 'POST', { uid: 'abc' })).status, 400, '非数字 uid');
  assert.equal((await api(base, '/api/weibo/accounts', 'POST', {})).status, 400, 'uid 与昵称都不给');
  assert.equal(
    (await api(base, '/api/weibo/accounts', 'POST', { uid: '111', biliUid: '999' })).status,
    400,
    '关联主播必须在监听名单',
  );
});

test('/api/weibo/accounts：编辑 / 启停 / 删除 / 关联主播 / 404', async (t) => {
  const db = new Db(':memory:');
  const calls: string[] = [];
  const { base } = await setup(t, { db, weibo: makeWeiboDep(db, calls) });
  db.upsertStreamer({ uid: '1', uname: '阿梓' });
  const id = db.upsertWeiboAccount({ uid: '2203177060', nickname: null, biliUid: null, enabled: true });

  const upd = await api(base, `/api/weibo/accounts/${id}`, 'PUT', { enabled: false, biliUid: '1' });
  assert.equal(upd.status, 200);
  const acc = db.getWeiboAccount(id)!;
  assert.equal(acc.enabled, false);
  assert.equal(acc.biliUid, '1', '关联主播落库');
  assert.equal((await api(base, `/api/weibo/accounts/${id}`, 'PUT', {})).status, 400, '空 patch');
  assert.equal((await api(base, '/api/weibo/accounts/9999', 'PUT', { enabled: true })).status, 404);
  assert.equal((await api(base, '/api/weibo/accounts/9999', 'DELETE')).status, 404);

  assert.equal((await api(base, `/api/weibo/accounts/${id}`, 'DELETE')).status, 200);
  assert.equal(db.getWeiboAccount(id), undefined);
});

test('PUT /api/streamers 填微博昵称 → 同步建微博名单行并关联本主播；清空 → 解关联但保留行', async (t) => {
  const db = new Db(':memory:');
  const { base } = await setup(t, {
    db,
    weiboResolver: { resolveUid: async () => '2203177060' },
  });
  db.upsertStreamer({ uid: '1', uname: '阿梓' });

  const r = await api(base, '/api/streamers/1', 'PUT', { weiboNick: '阿梓从小就很可爱' });
  assert.equal(r.status, 200);
  const acc = db.getWeiboAccountByUid('2203177060')!;
  assert.equal(acc.biliUid, '1', '主播详情填昵称 = 在微博名单里建行并关联');
  assert.equal(acc.nickname, '阿梓从小就很可爱');

  const cleared = await api(base, '/api/streamers/1', 'PUT', { weiboNick: null });
  assert.equal(cleared.status, 200);
  assert.equal(db.getWeiboAccountByUid('2203177060')!.biliUid, null, '清空昵称 → 解关联');
  assert.ok(db.getWeiboAccountByUid('2203177060'), '账号行保留（历史微博与图文页配置都还在）');
});

test('/api/weibo-avatar：按文件名读缓存目录；坏文件名 400、缺文件 404、无 dep 404', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ddclaw-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const name = 'a'.repeat(32) + '.jpg';
  writeFileSync(join(dir, name), Buffer.from([0xff, 0xd8, 0xff]));

  const { base } = await setup(t, { weiboAvatars: { dir } });
  const res = await fetch(`${base}/api/weibo-avatar?file=${name}`, { headers: { connection: 'close' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /image\/jpeg/);
  assert.equal((await res.arrayBuffer()).byteLength, 3);

  assert.equal((await api(base, '/api/weibo-avatar?file=../../etc/passwd')).status, 400);
  assert.equal((await api(base, `/api/weibo-avatar?file=${'b'.repeat(32)}.jpg`)).status, 404);

  const bare = await setup(t);
  assert.equal((await api(bare.base, '/api/weibo-avatar?file=' + name)).status, 404, '未装配 dep');
});

test('/api/weibo-image：sinaimg 白名单反代（带 Referer + 落盘缓存），白名单外 400', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ddclaw-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  let seenReferer = '';
  const fetchImpl: FetchLike = async (_url, init) => {
    calls++;
    seenReferer = String((init?.headers as Record<string, string> | undefined)?.Referer ?? '');
    return new Response(Buffer.from([0xff, 0xd8, 0xff]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    });
  };
  const { base } = await setup(t, { weiboImages: { dir, fetchImpl } });

  const pic = 'https://wx1.sinaimg.cn/orj960/abc123.jpg';
  const res = await fetch(`${base}/api/weibo-image?url=${encodeURIComponent(pic)}`, { headers: { connection: 'close' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /image\/jpeg/);
  assert.equal(seenReferer, 'https://weibo.com/', '反代必须带 weibo Referer（sinaimg 防盗链）');

  // 第二次命中磁盘缓存，不再打网络
  const res2 = await fetch(`${base}/api/weibo-image?url=${encodeURIComponent(pic)}`, { headers: { connection: 'close' } });
  assert.equal(res2.status, 200);
  assert.equal(calls, 1, '第二次应从磁盘缓存出');

  assert.equal(
    (await api(base, '/api/weibo-image?url=' + encodeURIComponent('https://evil.example.com/x.jpg'))).status,
    400, '白名单外 host 拒绝（防开放 SSRF）',
  );
  assert.equal((await api(base, '/api/weibo-image?url=not-a-url')).status, 400);
});

test('/api/bili/accounts：添加后调用 biliFeed.kickAccount 即时首拉', async (t) => {
  const kicked: string[] = [];
  const { base } = await setup(t, {
    biliFeed: { kickAccount: async (uid) => { kicked.push(uid); } },
  });
  const r = await api(base, '/api/bili/accounts', 'POST', { uid: 'https://space.bilibili.com/3546661873781168/dynamic' });
  assert.equal(r.status, 200);
  assert.deepEqual(kicked, ['3546661873781168'], '添加后应立即首拉新账号（不等下个轮询周期）');
});

test('添加微博 / X 账号同样即时首拉（deps.weibo / deps.x 的 kickAccount）', async (t) => {
  const db = new Db(':memory:');
  const kickedWeibo: string[] = [];
  const kickedX: string[] = [];
  const { base } = await setup(t, {
    db,
    x: { ...makeXDep(db, []), kickAccount: async (s) => { kickedX.push(s); } },
    weibo: { ...makeWeiboDep(db, []), kickAccount: async (uid) => { kickedWeibo.push(uid); } },
    weiboResolver: { resolveUid: async () => null, resolveNick: async () => null },
  });

  const rw = await api(base, '/api/weibo/accounts', 'POST', { uid: '1158211483' });
  assert.equal(rw.status, 200);
  assert.deepEqual(kickedWeibo, ['1158211483'], '微博添加后应立即首拉新账号');

  const rx = await api(base, '/api/x/accounts', 'POST', { screenName: 'hosi_tiri' });
  assert.equal(rx.status, 200);
  assert.deepEqual(kickedX, ['hosi_tiri'], 'X 添加后应立即首拉新账号');
});

test('/api/post-rules：规则平台无关——「引用」与「翻译」不再按平台拒绝保存', async (t) => {
  const db = new Db(':memory:');
  const { base } = await setup(t, { db, x: makeXDep(db, []) });

  // quote 对非 X 帖永不命中是**语义**（matcher 按帖子平台自然生效），不是保存校验错误
  assert.equal(
    (await api(base, '/api/post-rules', 'POST', { name: 'quote', filters: { quote: true } })).status, 201,
    '勾「引用」不再拒绝保存',
  );
  // 翻译从保存时校验改为运行时门控（非 X 帖不译）：任何规则都可开
  assert.equal(
    (await api(base, '/api/post-rules', 'POST', { name: 'tr', llmTranslate: true })).status, 201,
    '开「LLM 翻译」不再拒绝保存',
  );
  assert.equal(
    (await api(base, '/api/post-rules', 'POST', { name: 'judge', llmJudge: true, judgePrompt: '只推直播预告' })).status,
    201,
    'LLM 判定照常可用',
  );
});

// ---- 账号侧 ruleIds：规则存在即可选用（规则平台无关，三份名单同口径）----

test('账号 ruleIds：任何规则都可被任何平台账号选用；不存在的规则 400；GET 视图携带 ruleIds', async (t) => {
  const db = new Db(':memory:');
  const { base } = await setup(t, { db, x: makeXDep(db, []), weibo: makeWeiboDep(db, []) });
  const newRule = (name: string) => db.upsertPostRule({
    name, channels: [], filters: defaultPostFilters(),
    messageTemplate: null, llmJudge: false, judgePrompt: null, llmTranslate: false, enabled: true,
  });
  const rule1 = newRule('r1');
  const rule2 = newRule('r2');

  // X 账号：任意规则都收；不存在的拒
  const x = await api(base, '/api/x/accounts', 'POST', { screenName: 'watase_yuzuki', ruleIds: [rule1, rule2] });
  assert.equal(x.status, 200, 'X 账号可选用任何规则（规则平台无关）');
  assert.deepEqual((x.json.account as { ruleIds: number[] }).ruleIds, [rule1, rule2]);
  assert.equal(
    (await api(base, '/api/x/accounts', 'POST', { screenName: 'd4dj_pj', ruleIds: [9999] })).status, 400,
    '规则不存在 400',
  );
  const xId = (x.json.account as { id: number }).id;
  assert.equal((await api(base, `/api/x/accounts/${xId}`, 'PUT', { ruleIds: [] })).status, 200, '清空选用');
  assert.equal((await api(base, `/api/x/accounts/${xId}`, 'PUT', { ruleIds: [rule2] })).status, 200, 'PUT 任意规则也收');

  // 微博账号：同一条规则跨平台选用
  const w = await api(base, '/api/weibo/accounts', 'POST', { uid: '2203177060', ruleIds: [rule1] });
  assert.equal(w.status, 200);
  assert.deepEqual((w.json.account as { ruleIds: number[] }).ruleIds, [rule1]);

  // B站动态账号：混选多条规则也收
  const b = await api(base, '/api/bili/accounts', 'POST', { uid: '7706705', ruleIds: [rule1, rule2] });
  assert.equal(b.status, 200);
  assert.deepEqual((b.json.account as { ruleIds: number[] }).ruleIds, [rule1, rule2]);
  const bId = (b.json.account as { id: number }).id;
  assert.equal(
    (await api(base, `/api/bili/accounts/${bId}`, 'PUT', { ruleIds: [rule1, 9999] })).status, 400,
    '混入一条不存在的规则整体拒',
  );

  // GET 视图带 ruleIds
  const list = (await api(base, '/api/bili/accounts')).json.accounts as Array<{ ruleIds: number[] }>;
  assert.deepEqual(list[0]!.ruleIds, [rule1, rule2]);
});

test('DELETE /api/post-rules/:id 连带清扫三份账号名单里的 ruleIds（与 webui mock 同构）', async (t) => {
  const db = new Db(':memory:');
  const { base } = await setup(t, { db, x: makeXDep(db, []), weibo: makeWeiboDep(db, []) });
  const newRule = () => db.upsertPostRule({
    name: '', channels: [], filters: defaultPostFilters(),
    messageTemplate: null, llmJudge: false, judgePrompt: null, llmTranslate: false, enabled: true,
  });
  const xRule = newRule();
  const wbRule = newRule();
  const biRule = newRule();
  const xId = db.upsertXAccount({ screenName: 'watase_yuzuki', displayName: null, biliUid: null, enabled: true, ruleIds: [xRule] });
  const wbId = db.upsertWeiboAccount({ uid: '2203177060', nickname: null, biliUid: null, enabled: true, ruleIds: [wbRule] });
  const biId = db.upsertBiliAccount({ uid: '7706705', ruleIds: [biRule] });

  assert.equal((await api(base, `/api/post-rules/${xRule}`, 'DELETE')).status, 200);
  assert.deepEqual(db.getXAccount(xId)!.ruleIds, [], 'X 名单清扫');
  assert.deepEqual(db.getWeiboAccount(wbId)!.ruleIds, [wbRule], '其它名单不受影响');
  assert.equal((await api(base, `/api/post-rules/${wbRule}`, 'DELETE')).status, 200);
  assert.deepEqual(db.getWeiboAccount(wbId)!.ruleIds, [], '微博名单清扫');
  assert.equal((await api(base, `/api/post-rules/${biRule}`, 'DELETE')).status, 200);
  assert.deepEqual(db.getBiliAccount(biId)!.ruleIds, [], 'B站名单清扫');
});

// ---- B站动态账号（图文分页第三个来源）：独立名单 CRUD，恒挂载无 dep 门 ----

test('/api/bili/accounts：CRUD + uid 链接归一化 + 重名 409 + 视图带最近 3 帖（raw 不下发）', async (t) => {
  const db = new Db(':memory:');
  const { base } = await setup(t, { db });

  assert.deepEqual(((await api(base, '/api/bili/accounts')).json.accounts as unknown[]).length, 0, '初始空名单');

  const created = await api(base, '/api/bili/accounts', 'POST', {
    uid: 'https://space.bilibili.com/7706705/dynamic', displayName: '阿梓',
  });
  assert.equal(created.status, 200);
  const acc = created.json.account as { id: number; uid: string; enabled: boolean; ruleIds: number[] };
  assert.equal(acc.uid, '7706705', 'space.bilibili.com 链接归一化成纯数字 uid');
  assert.equal(acc.enabled, true, '新增默认启用');
  assert.deepEqual(acc.ruleIds, []);

  assert.equal((await api(base, '/api/bili/accounts', 'POST', { uid: '7706705' })).status, 409, '重复 uid 409');
  assert.equal((await api(base, '/api/bili/accounts', 'POST', { uid: 'abc' })).status, 400, '非数字 uid');
  assert.equal((await api(base, '/api/bili/accounts', 'POST', {})).status, 400, '缺 uid');

  // 名单行视图带最近 3 帖（按发布时间倒序，raw 不下发）
  db.insertPosts([
    { platform: 'bili_dynamic', uid: '7706705', itemId: '1', type: 'DYNAMIC_TYPE_WORD', text: 'a', pics: [], pubTs: 1000, url: null, raw: '{"secret":1}' },
    { platform: 'bili_dynamic', uid: '7706705', itemId: '2', type: 'DYNAMIC_TYPE_WORD', text: 'b', pics: [], pubTs: 2000, url: null, raw: null },
    { platform: 'bili_dynamic', uid: '7706705', itemId: '3', type: 'DYNAMIC_TYPE_WORD', text: 'c', pics: [], pubTs: 3000, url: null, raw: null },
    { platform: 'bili_dynamic', uid: '7706705', itemId: '4', type: 'DYNAMIC_TYPE_WORD', text: 'd', pics: [], pubTs: 4000, url: null, raw: null },
    { platform: 'bili_dynamic', uid: '999', itemId: '5', type: 'DYNAMIC_TYPE_WORD', text: '别人的', pics: [], pubTs: 5000, url: null, raw: null },
  ]);
  const list = (await api(base, '/api/bili/accounts')).json.accounts as Array<{
    posts: Array<{ pubTs: number; raw?: unknown }>;
  }>;
  assert.equal(list[0]!.posts.length, 3, '只带最近 3 条');
  assert.deepEqual(list[0]!.posts.map((p) => p.pubTs), [4000, 3000, 2000], '倒序且不含别人账号的帖');
  assert.equal(list[0]!.posts[0]!.raw, undefined, 'raw 不下发');

  // PUT：uid 是身份锚点、uname 是平台事实，都不可改；其它字段部分更新
  const put = await api(base, `/api/bili/accounts/${acc.id}`, 'PUT', { enabled: false });
  assert.equal(put.status, 200);
  assert.equal((put.json.account as { enabled: boolean }).enabled, false);
  assert.equal((put.json.account as { uname: unknown }).uname, null, 'uname 由抓取回写，输入面动不了');
  assert.equal((await api(base, `/api/bili/accounts/${acc.id}`, 'PUT', { uid: '1' })).status, 400, 'uid 不可改');
  assert.equal((await api(base, `/api/bili/accounts/${acc.id}`, 'PUT', { uname: '手填名' })).status, 400, 'uname 不可改');
  assert.equal((await api(base, `/api/bili/accounts/${acc.id}`, 'PUT', {})).status, 400, '空 patch');
  assert.equal((await api(base, '/api/bili/accounts/9999', 'PUT', { enabled: true })).status, 404);

  assert.equal((await api(base, `/api/bili/accounts/${acc.id}`, 'DELETE')).status, 200);
  assert.equal((await api(base, `/api/bili/accounts/${acc.id}`, 'DELETE')).status, 404, '再删一次 404');
});

test('/api/bili-avatar：按文件名读缓存目录；坏文件名 400、缺文件 404、无 dep 404', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ddclaw-biliava-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const name = 'a'.repeat(32) + '.jpg';
  writeFileSync(join(dir, name), Buffer.from([0xff, 0xd8, 0xff]));

  const { base } = await setup(t, { biliAvatars: { dir } });
  const res = await fetch(`${base}/api/bili-avatar?file=${name}`, { headers: { connection: 'close' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /image\/jpeg/);
  assert.equal(res.headers.get('cache-control'), 'max-age=86400', 'md5 文件名随内容变，长缓存');
  assert.equal((await res.arrayBuffer()).byteLength, 3);

  assert.equal((await api(base, '/api/bili-avatar?file=../../etc/passwd')).status, 400, '穿越字符 400');
  assert.equal((await api(base, `/api/bili-avatar?file=${'b'.repeat(32)}.jpg`)).status, 404, '文件不存在 404');

  const bare = await setup(t);
  assert.equal((await api(bare.base, '/api/bili-avatar?file=' + name)).status, 404, '未装配 dep');
});

// ---- P0 写快照接线：面板写经 runTool 落变更记录（撤销栈的数据源）----

test('写快照：配置写落 undo_changes（settings 前像/后像差分；streamers 混合表按列过滤后同样落记录）', async (t) => {
  const { db, base, undo } = await setup(t, { undo: true });
  db.upsertStreamer({ uid: '1001', uname: '阿梓' }); // 直调 Db（不过注册表），不留记录
  assert.equal(undo!.history().length, 0, '直调 Db 的写（轮询源就是这么写的）不进变更记录');

  // 配置写：推送总开关 → settings 行的前像/后像
  const r = await api(base, '/api/push/enabled', 'PUT', { enabled: false });
  assert.equal(r.status, 200);
  const hist = undo!.history();
  assert.equal(hist.length, 1);
  assert.equal(hist[0]!.tool, 'set_push_enabled');
  assert.equal(hist[0]!.entry, 'panel');
  assert.equal(hist[0]!.scope, 'admin', '面板写进全局 admin 栈');
  const row = hist[0]!.rows[0]!;
  assert.equal(row.table, 'settings');
  assert.deepEqual(row.pk, { key: 'push_enabled' });
  assert.equal(row.before, null, '首次写：前像不存在');
  assert.equal((row.after as { value: string }).value, '0');

  // streamers 是「配置 + 归档」混合表：按列过滤后与纯配置表同待遇——写生效、落记录、可撤销
  const r2 = await api(base, '/api/streamers/1001', 'PUT', { alias: '梓宝', notify: false });
  assert.equal(r2.status, 200);
  assert.equal(db.getStreamer('1001')!.alias, '梓宝');
  const hist2 = undo!.history();
  assert.equal(hist2.length, 2, 'streamers 写落变更记录（2026-09-21 口径变更；P1 冒烟的「改别名撤不掉」由此闭合）');
  assert.equal(hist2[0]!.tool, 'set_streamer');
  const srow = hist2[0]!.rows[0]!;
  assert.equal(srow.table, 'streamers');
  assert.deepEqual(srow.pk, { uid: '1001' });
  assert.equal((srow.before as { alias: string | null }).alias, null, '前像 = 改之前那一行');
  assert.equal((srow.after as { alias: string; notify: number }).alias, '梓宝');

  // 撤销前轮询源回填了同一行（uname/face/room_id/updated_at，直写库不走注册表）→ 比对只看配置列，仍撤得掉
  db.raw
    .prepare(`UPDATE streamers SET uname = '阿梓从小就很可爱', face = 'f.jpg', room_id = '80397', updated_at = 9999 WHERE uid = ?`)
    .run('1001');
  const u = await api(base, '/api/undo', 'POST');
  assert.equal(u.status, 200, '轮询列前进不得让撤销 409');
  const s = db.getStreamer('1001')!;
  assert.equal(s.alias, null, '配置列还原');
  assert.equal(s.notify, true, '配置列还原');
  assert.equal(s.uname, '阿梓从小就很可爱', '平台事实列保持撤销前的值');
  assert.equal(s.face, 'f.jpg', '头像同属轮询列');
  assert.equal(s.roomId, '80397', '房间号同属轮询列');
});

test('写快照：watch_streamer 的两种形状都可撤销（不在名单 = 插行；已在名单 = 更新同一行）', async (t) => {
  const { db, base, undo } = await setup(t, { undo: true });
  db.upsertFollows([{ uid: '1001', uname: '阿梓', face: 'f.jpg' }]);

  // 形状 A：uid 只在关注候选池里 → 建行；撤销 = 整行删除
  const w = await api(base, '/api/streamers/1001/watch', 'POST');
  assert.equal(w.status, 200);
  assert.equal(db.getStreamer('1001')!.watch, true);
  assert.equal(undo!.history()[0]!.tool, 'watch_streamer');
  assert.equal(undo!.history()[0]!.rows[0]!.beforeExists, false, '前像不存在 = 插行');
  assert.equal((await api(base, '/api/undo', 'POST')).status, 200);
  assert.equal(db.getStreamer('1001'), undefined, '撤销新建 = 行没了');

  // 形状 B：已在名单但 watch=0（先下过监听）→ upsertStreamer 走 ON CONFLICT 更新同一行；撤销 = 只还原配置列
  db.upsertStreamer({ uid: '1001', uname: '阿梓', alias: '别删我', watch: false });
  db.raw.prepare(`UPDATE streamers SET face = 'f.jpg', updated_at = 9999 WHERE uid = ?`).run('1001');
  const w2 = await api(base, '/api/streamers/1001/watch', 'POST');
  assert.equal(w2.status, 200);
  assert.equal(db.getStreamer('1001')!.watch, true);
  assert.equal(undo!.history()[0]!.rows[0]!.beforeExists, true, '前像存在 = 更新已存在行');
  assert.equal((await api(base, '/api/undo', 'POST')).status, 200);
  const s = db.getStreamer('1001')!;
  assert.equal(s.watch, false, 'watch 还原');
  assert.equal(s.alias, '别删我', '别名原样保留');
  assert.equal(s.face, 'f.jpg', '轮询列不还原');
});

test('写快照：删分类级联停用收敛为同一笔记录（事务化差分），撤销整体还原', async (t) => {
  const { db, base, undo } = await setup(t, { undo: true });
  const mk = { llmPrompt: null, keywords: ['x'], areas: [], condMode: 'and' as const, enabled: true };
  const cat = db.upsertCategory({ ...mk, name: '歌回' });
  db.upsertPushRule({ name: 'r1', categoryId: cat, uids: [], channels: [], messageTemplate: null, enabled: true });

  const r = await api(base, `/api/categories/${cat}`, 'DELETE');
  assert.equal(r.status, 200);
  const hist = undo!.history();
  assert.equal(hist.length, 1, '级联停用 + 删除 = 一笔记录');
  assert.equal(hist[0]!.tool, 'delete_category');
  const shapes = hist[0]!.rows.map((x) => `${x.table}:${x.beforeExists}->${x.afterExists}`).sort();
  assert.deepEqual(shapes, ['categories:true->false', 'push_rules:true->true']);

  // 撤销能整体还原（分类回来 + 规则恢复启用）——面板端点属切片 C，这里先经 store 验证记录可用
  const ur = undo!.undo('admin');
  assert.equal(ur.ok, true);
  assert.ok(db.listCategories().some((c) => c.id === cat), '撤销后分类还原');
  assert.equal(db.listPushRules().find((x) => x.name === 'r1')!.enabled, true, '撤销后规则恢复启用');
});

// ---- P0 撤销执行器（切片 C）：/api/undo/history 与 POST /api/undo ----

test('撤销端点：写 → history 可见 → undo 还原并触发热生效回调；空栈 404', async (t) => {
  const { db, base, undo, undoFired } = await setup(t, { undo: true, listen: { weibo: true } });
  const before = Math.floor(Date.now() / 1000);

  // 面板写一笔（listen 开关：want=false ≠ ready=true → 落手动值 '0'）
  const w = await api(base, '/api/listen/weibo', 'PUT', { enabled: false });
  assert.equal(w.status, 200);
  assert.equal(db.getSetting('listen_weibo'), '0', '手动关 = 落 settings');

  // history：新→旧，契约形状逐字（at 秒级、tables 去重、rows = 受影响行数）
  const h = await api(base, '/api/undo/history');
  assert.equal(h.status, 200);
  const changes = h.json.changes as Array<Record<string, unknown>>;
  assert.equal(changes.length, 1);
  const c = changes[0]!;
  assert.equal(typeof c.id, 'number');
  assert.equal(c.tool, 'set_listen');
  assert.equal(c.entry, 'panel');
  assert.equal(c.actor, 'panel');
  assert.equal(c.scope, 'admin');
  assert.equal(c.undone, false);
  assert.deepEqual(c.tables, ['settings']);
  assert.equal(c.rows, 1);
  assert.ok((c.at as number) >= before && (c.at as number) <= Math.floor(Date.now() / 1000));
  assert.ok((c.at as number) < 1e10, 'at 是秒级时间戳');

  // POST /api/undo：忽略 body，撤 admin 全局栈栈顶（title 与 change.title 都给：前端两种读法）
  const u = await api(base, '/api/undo', 'POST', { anything: '忽略' });
  assert.equal(u.status, 200);
  assert.deepEqual(u.json, {
    ok: true,
    change: { id: c.id, tool: 'set_listen', title: '监听开关' },
    title: '监听开关',
  });
  assert.equal(db.getSetting('listen_weibo'), null, '撤销 = 回到 auto（key 被删，区别于写值）');
  assert.equal(undoFired!.listen, 1, '撤 listen 开关要跑 reconcileListen');
  assert.equal(undoFired!.runtime + undoFired!.llm + undoFired!.notifiers, 0);

  // 历史全量保留（只标记 undone）；撤销自身不入栈
  const h2 = await api(base, '/api/undo/history');
  const changes2 = h2.json.changes as Array<Record<string, unknown>>;
  assert.equal(changes2.length, 1, '撤销不产生新记录（撤销自己不该可撤）');
  assert.equal(changes2[0]!.undone, true);
  assert.equal(undo!.peek('admin'), null);

  // 第二次撤销：栈已空
  const empty = await api(base, '/api/undo', 'POST');
  assert.equal(empty.status, 404);
  assert.equal(empty.json.error, '没有可撤销的变更');
});

test('撤销端点：撤 runtime config 走 reconcileRuntime；撤渠道走通道重装配', async (t) => {
  const { db, base, undoFired } = await setup(t, { undo: true });

  await api(base, '/api/advanced', 'PUT', { pollIntervalSec: 30, backlogPushEnabled: true });
  const u1 = await api(base, '/api/undo', 'POST');
  assert.equal(u1.status, 200);
  assert.equal(db.getSetting('poll_interval_sec'), null, '撤销后回代码默认值（key 不存在）');
  assert.equal(db.getSetting('backlog_push_enabled'), null);
  assert.equal(undoFired!.runtime, 1, '撤运行参数要跑 reconcileRuntime');

  // 撤渠道行：装配级重同步（幂等；dispatcher 逐条读表，这里按「撤了什么就重跑什么」）
  const ch = await api(base, '/api/channels', 'POST', { name: '群', notifier: 'onebot', targetType: 'group', targetId: '12345' });
  assert.equal(ch.status, 201);
  const u2 = await api(base, '/api/undo', 'POST');
  assert.equal(u2.status, 200);
  assert.equal(db.listPushChannels().length, 0, '新建的渠道被撤销删除');
  assert.equal(undoFired!.notifiers, 1);
});

test('撤销中止：后像 ≠ 当前值 → 409 且一行不动、不触发回调', async (t) => {
  const { db, base, undo, undoFired } = await setup(t, { undo: true });
  await api(base, '/api/advanced', 'PUT', { pollIntervalSec: 30 });

  // 第三方入口（绕过注册表直写库，等价于另一个入口的写）改了同一行
  db.setSetting('poll_interval_sec', '45');

  const r = await api(base, '/api/undo', 'POST');
  assert.equal(r.status, 409);
  assert.equal(r.json.error, '该设置已被其他入口修改，无法撤销本次');
  assert.equal(db.getSetting('poll_interval_sec'), '45', '中止时一行都不动');
  assert.equal(undo!.history()[0]!.undoneAt, null, '中止不得把记录标记为已撤销');
  assert.deepEqual(undoFired, { runtime: 0, listen: 0, llm: 0, notifiers: 0 }, '中止不触发热生效');

  // 冲突解除后仍可撤（栈没被动过）
  db.setSetting('poll_interval_sec', '30');
  assert.equal((await api(base, '/api/undo', 'POST')).status, 200);
});

test('撤销端点未装配 → 404（两个端点各自按 dep 挂载）', async (t) => {
  const { base } = await setup(t);
  assert.equal((await api(base, '/api/undo/history')).status, 404);
  assert.equal((await api(base, '/api/undo', 'POST')).status, 404);
});test('变更历史结构化：title / headline / detail(label+action+changes) / undoNote，与快照差分同源', async (t) => {
  const { db, base } = await setup(t, { undo: true, listen: { weibo: true } });

  // ① 新建分类：action=created，changes 恒为空数组（变化清单只对 updated 有意义，但键始终在）
  assert.equal((await api(base, '/api/categories', 'POST', { name: '歌回', keywords: ['唱歌'] })).status, 201);
  let c = (await api(base, '/api/undo/history')).json.changes as Array<Record<string, unknown>>;
  assert.equal(c[0]!.title, '保存分类', '中文操作名由后端给（工具名 → 文案）');
  assert.equal(c[0]!.headline, '新增了分类「歌回」', 'headline = 一句话操作描述');
  assert.deepEqual(c[0]!.detail, [{ label: '分类「歌回」', action: 'created', changes: [] }]);
  assert.equal(c[0]!.undoNote, null);

  // ② 改分类的启用开关：changes 带格式化后的旧值/新值（布尔 → 开/关），headline 值感知变动词
  const catId = db.listCategories()[0]!.id;
  assert.equal((await api(base, `/api/categories/${catId}`, 'PUT', { enabled: false })).status, 200);
  c = (await api(base, '/api/undo/history')).json.changes as Array<Record<string, unknown>>;
  const upd = (c[0]!.detail as Array<Record<string, unknown>>)[0]!;
  assert.equal(upd.label, '分类「歌回」');
  assert.equal(upd.action, 'updated');
  assert.deepEqual(upd.changes, [{ field: '启用', from: '开', to: '关', bool: true }]);
  assert.equal(c[0]!.headline, '停用了分类「歌回」', '布尔单列变化 → 动词句');

  // ③ 删分类：action=deleted（前像在、后像无）
  assert.equal((await api(base, `/api/categories/${catId}`, 'DELETE')).status, 200);
  c = (await api(base, '/api/undo/history')).json.changes as Array<Record<string, unknown>>;
  assert.equal(c[0]!.title, '删除分类');
  assert.equal(c[0]!.headline, '删除了分类「歌回」');
  assert.deepEqual(c[0]!.detail, [{ label: '分类「歌回」', action: 'deleted', changes: [] }]);

  // ④ settings 行 = 设置项中文名（「分类「名」」式是行表用的）；首次手动关开关（created 行）也组动词句
  assert.equal((await api(base, '/api/listen/weibo', 'PUT', { enabled: false })).status, 200);
  c = (await api(base, '/api/undo/history')).json.changes as Array<Record<string, unknown>>;
  assert.equal(c[0]!.title, '监听开关');
  assert.equal(c[0]!.headline, '关闭了微博监听开关');
  assert.deepEqual(c[0]!.detail, [{ label: '微博监听开关', action: 'created', changes: [] }]);
  assert.equal(c[0]!.undoNote, null, '普通设置项撤销即完成，没有额外注意事项');

  // 已存在的 settings 键再写一次 = updated；settings 是 kv 面，字段名直接用设置项中文名，数值键带单位
  assert.equal((await api(base, '/api/advanced', 'PUT', { pollIntervalSec: 30 })).status, 200);
  assert.equal((await api(base, '/api/advanced', 'PUT', { pollIntervalSec: 60 })).status, 200);
  c = (await api(base, '/api/undo/history')).json.changes as Array<Record<string, unknown>>;
  assert.equal(c[0]!.title, '修改运行时参数');
  assert.equal(c[0]!.headline, '修改了直播轮询间隔');
  assert.deepEqual(c[0]!.detail, [{ label: '直播轮询间隔', action: 'updated', changes: [{ field: '直播轮询间隔', from: '30 秒', to: '60 秒' }] }]);

  // 回到 auto（值等于运行前提）→ 删掉那个键，撤销记录里就是 deleted
  assert.equal((await api(base, '/api/listen/weibo', 'PUT', { enabled: true })).status, 200);
  c = (await api(base, '/api/undo/history')).json.changes as Array<Record<string, unknown>>;
  assert.deepEqual(c[0]!.detail, [{ label: '微博监听开关', action: 'deleted', changes: [] }]);

  // ⑤ 混合表：主播行的标签用 uname，changes 不含被忽略的轮询列（更新时间/昵称/直播间）
  db.upsertStreamer({ uid: '1001', uname: '阿梓', face: 'https://x/f.jpg' });
  assert.equal((await api(base, '/api/streamers/1001', 'PUT', { alias: '梓宝' })).status, 200);
  c = (await api(base, '/api/undo/history')).json.changes as Array<Record<string, unknown>>;
  assert.equal(c[0]!.title, '修改主播设置');
  const sRow = (c[0]!.detail as Array<Record<string, unknown>>)[0]!;
  assert.equal(sRow.label, '主播「阿梓」');
  assert.deepEqual(sRow.changes, [{ field: '简称', from: '（空）', to: '梓宝' }], '只报配置列：轮询回写列被忽略表挡在外面');
  assert.equal(c[0]!.undoNote, null);
});

test('变更历史结构化：LLM key 行的 undoNote=refill，撤销响应带 title 与 refill 透传', async (t) => {
  const { db, base } = await setup(t, { undo: true, llm: { config: LLM_CFG } });

  assert.equal((await api(base, '/api/llm/keys', 'PUT', { provider: 'ds', value: 'sk-refill' })).status, 200);
  const c = (await api(base, '/api/undo/history')).json.changes as Array<Record<string, unknown>>;
  assert.equal(c[0]!.title, '设置 LLM 密钥');
  assert.equal(c[0]!.headline, '设置了 ds 的 LLM 密钥');
  assert.deepEqual(c[0]!.detail, [{
    label: 'LLM 密钥（ds）',
    action: 'created',
    changes: [],
  }]);
  assert.equal(c[0]!.undoNote, 'refill', '涉及 llm_key:* → 撤销 = 清空、需重填');
  assert.ok(!JSON.stringify(c[0]).includes('sk-refill'), '明文 key 绝不进历史');

  // 撤销：refill 从 UndoResult 透传（同一份口径，不是这里另算的），title 与 /api/undo/history 同源
  const u = await api(base, '/api/undo', 'POST');
  assert.equal(u.status, 200);
  assert.equal(u.json.title, '设置 LLM 密钥');
  assert.equal((u.json.change as Record<string, unknown>).title, '设置 LLM 密钥');
  assert.deepEqual(u.json.refill, ['settings.(key=llm_key:ds)']);
  assert.deepEqual((u.json.change as Record<string, unknown>).refill, ['settings.(key=llm_key:ds)']);
  assert.equal(db.getSetting('llm_key:ds'), null, '撤销 = 清空该行（值本来就没落库）');

  // 撤销后历史仍标 refill（记录不变），只是 undone=true
  const c2 = (await api(base, '/api/undo/history')).json.changes as Array<Record<string, unknown>>;
  assert.equal(c2[0]!.undoNote, 'refill');
  assert.equal(c2[0]!.undone, true);
});

// ---- P1 WebUI Agent：/api/chat* 四端点契约（形状/状态码逐字冻结，webui demo mock 同构）----

/**
 * 假 LLM 端点：按脚本依次返回 chat/completions 信封（最后一条重复，供「工具 → 终答」两轮用）；
 * 顺带留档请求体，用来验证请求里真的带上了系统提示与工具面。
 */
function chatFetch(queue: unknown[]): { fn: FetchLike; bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = [];
  const fn: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>);
    const body = queue[Math.min(bodies.length - 1, queue.length - 1)];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { fn, bodies };
}

test('/api/chat：单轮直答 {ok,reply,usage}；空消息 400；LLM 未就绪 400 并指引设置页', async (t) => {
  const llm = chatFetch([{ choices: [{ message: { content: '现在没有在播的监听主播。' } }] }]);
  const { base } = await setup(t, { chat: true, llm: { config: LLM_CFG }, llmFetch: llm.fn });

  // chat dep 有、llm dep 有，但 provider 缺 key = 400（不是 502）：让用户去设置页修
  const blocked = await api(base, '/api/chat', 'POST', { message: '现在谁在播' });
  assert.equal(blocked.status, 400);
  assert.match(blocked.json.error!, /设置页/);

  // message 形状在 LLM 检查之前就拦（空/非字符串一律 400）
  const empty = await api(base, '/api/chat', 'POST', { message: '   ' });
  assert.equal(empty.status, 400);
  assert.equal(empty.json.error, 'message 必须是非空字符串');
  assert.equal((await api(base, '/api/chat', 'POST', { message: 42 })).status, 400);
  assert.equal((await api(base, '/api/chat', 'POST', {})).status, 400);
  assert.equal(llm.bodies.length, 0, '400 的请求不打 LLM');

  await api(base, '/api/llm/keys', 'PUT', { provider: 'ds', value: 'sk-chat' });
  const r = await api(base, '/api/chat', 'POST', { message: '现在谁在播' });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ['calls', 'ok', 'provider', 'reply', 'usage'], '响应形状逐字冻结');
  assert.equal(r.json.ok, true);
  assert.equal(r.json.reply, '现在没有在播的监听主播。');
  assert.equal(r.json.provider, 'ds', 'provider = 实际回答的模型（自动路由下就是路由落点）');
  assert.deepEqual(r.json.calls, [], '单轮直答没有工具调用');
  assert.deepEqual(r.json.usage, { messages: 2, chars: 17, needsResetHint: false });

  // 请求带上了系统提示（写模式纪律）与工具面：真的走了 agent loop
  const sent = llm.bodies[0]!;
  const sys = (sent.messages as Array<{ role: string; content: string }>)[0]!;
  assert.equal(sys.role, 'system');
  assert.match(sys.content, /写前询问/);
  const tools = (sent.tools as Array<{ function: { name: string } }>).map((x) => x.function.name);
  assert.ok(tools.includes('search_streamers') && tools.includes('set_push_enabled'));
  assert.ok(!tools.includes('set_chat_mode'), '写模式开关不进 LLM 工具面');
  assert.ok(!tools.includes('set_chat_provider'), '模型选择不进 LLM 工具面（主人决定，模型不能自己点将）');
});

test('/api/chat：模型请求写工具 → 能力层写库；变更记录 entry=agent（与面板人手可区分）', async (t) => {
  const llm = chatFetch([
    {
      choices: [{
        message: {
          content: '好，我把推送总开关关掉。',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'set_push_enabled', arguments: '{"enabled":false}' } }],
        },
      }],
    },
    { choices: [{ message: { content: '已关闭推送总开关。' } }] },
  ]);
  const { base, db, undo } = await setup(t, { chat: true, undo: true, llm: { config: LLM_CFG }, llmFetch: llm.fn });
  await api(base, '/api/llm/keys', 'PUT', { provider: 'ds', value: 'sk-chat' });

  const r = await api(base, '/api/chat', 'POST', { message: '把推送关了' });
  assert.equal(r.status, 200);
  assert.equal(r.json.reply, '已关闭推送总开关。');
  assert.equal(db.getSetting('push_enabled'), '0', '工具真的执行了');
  assert.equal(llm.bodies.length, 2, '工具结果回填后又问了一轮');

  // 工具调用明细（ToolCallView）：POST 回包与 history 回放同一形状信源
  const calls = r.json.calls as Array<Record<string, unknown>>;
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0]!).sort(),
    ['args', 'id', 'name', 'ok', 'output', 'target', 'title'], 'calls 行形状逐字冻结');
  assert.equal(calls[0]!.id, 'c1');
  assert.equal(calls[0]!.name, 'set_push_enabled');
  assert.equal(calls[0]!.title, '开关推送', '中文操作名 = undo-view 唯一信源');
  assert.equal(calls[0]!.ok, true);

  // history：带调用的中间轮与终答分两条，calls 配在中间轮上；无调用的行不带 calls 键
  const h = await api(base, '/api/chat/history');
  const msgs = h.json.messages as Array<Record<string, unknown>>;
  assert.deepEqual(msgs.map((m) => [m.role, m.content]),
    [['user', '把推送关了'], ['assistant', '好，我把推送总开关关掉。'], ['assistant', '已关闭推送总开关。']]);
  assert.equal((msgs[1]!.calls as Array<Record<string, unknown>>).length, 1);
  assert.equal((msgs[1]!.calls as Array<Record<string, unknown>>)[0]!.id, 'c1');
  assert.equal(msgs[2]!.calls, undefined);

  // 变更历史：entry 区分入口（面板人手 vs 进程内 agent），都在 admin 全局栈
  const changes = (await api(base, '/api/undo/history')).json.changes as Array<Record<string, unknown>>;
  assert.deepEqual(changes.map((c) => `${c.entry}:${c.actor}:${c.tool}`),
    ['agent:webui-agent:set_push_enabled', 'panel:panel:set_llm_key']);
  assert.equal(undo!.history()[0]!.scope, 'admin');

  // 结论：agent 写出来的配置，主人一样能从面板撤销
  const u = await api(base, '/api/undo', 'POST');
  assert.equal(u.status, 200);
  assert.equal(db.getSetting('push_enabled'), null);
});

test('/api/chat/history 与 reset：消息累积、mode 回显、reset 清消息保会话行', async (t) => {
  const llm = chatFetch([{ choices: [{ message: { content: '答复一' } }] }]);
  const { base, chat, db } = await setup(t, { chat: true, undo: true, llm: { config: LLM_CFG }, llmFetch: llm.fn });

  const blank = await api(base, '/api/chat/history');
  assert.equal(blank.status, 200);
  assert.deepEqual(blank.json.messages, [], '空会话 messages = []');
  assert.equal(blank.json.mode, 'ask', '缺省写模式 = 写前询问');
  assert.equal(blank.json.provider, '', '缺省模型选择 = 自动路由');
  assert.deepEqual(blank.json.usage, { messages: 0, chars: 0, needsResetHint: false });

  await api(base, '/api/llm/keys', 'PUT', { provider: 'ds', value: 'sk-chat' });
  const before = Math.floor(Date.now() / 1000);
  await api(base, '/api/chat', 'POST', { message: '问题一' });

  const h = await api(base, '/api/chat/history');
  const messages = h.json.messages as Array<Record<string, unknown>>;
  assert.deepEqual(messages.map((m) => [m.role, m.content]), [['user', '问题一'], ['assistant', '答复一']]);
  assert.deepEqual(Object.keys(messages[0]!).sort(), ['at', 'content', 'id', 'provider', 'role']);
  assert.ok(Number.isInteger(messages[0]!.id) && (messages[0]!.id as number) > 0, 'id = chat_messages.id（轮询去重键）');
  assert.ok((messages[0]!.at as number) >= before && (messages[0]!.at as number) < 1e10, 'at 是秒级时间戳');
  assert.deepEqual(h.json.usage, { messages: 2, chars: 6, needsResetHint: false });

  // 写模式：非法值 400；合法值落 settings（经注册表 = 进变更历史，可撤销）
  assert.equal((await api(base, '/api/chat/mode', 'PUT', { mode: 'nope' })).status, 400);
  assert.equal((await api(base, '/api/chat/mode', 'PUT', {})).status, 400);
  const m = await api(base, '/api/chat/mode', 'PUT', { mode: 'auto' });
  assert.equal(m.status, 200);
  assert.deepEqual(m.json, { ok: true, mode: 'auto' });
  assert.equal(db.getSetting('chat_write_mode'), 'auto');
  assert.equal((await api(base, '/api/chat/history')).json.mode, 'auto');
  const modeChange = (await api(base, '/api/undo/history')).json.changes as Array<Record<string, unknown>>;
  assert.deepEqual(modeChange.map((c) => `${c.entry}:${c.tool}`), ['panel:set_chat_mode', 'panel:set_llm_key']);

  // 重置上下文：忽略 body、清空消息、保留会话行（id 不变，供审计与 UI 复用）
  const sessionId = chat!.find(adminScope())!.id;
  const reset = await api(base, '/api/chat/reset', 'POST', { ignored: true });
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.json, { ok: true });
  assert.deepEqual((await api(base, '/api/chat/history')).json.messages, []);
  assert.equal(chat!.find(adminScope())!.id, sessionId, '会话行保留');
});

test('PUT /api/chat/provider：选定/自动/不存在 400；history 与发消息都回显 provider；写进变更历史', async (t) => {
  const llm = chatFetch([{ choices: [{ message: { content: '答复' } }] }]);
  const { base, db } = await setup(t, { chat: true, undo: true, llm: { config: LLM_CFG }, llmFetch: llm.fn });

  // 形状：provider 必须是字符串（zod 层）；名字必须已配置（handler），不存在一律 400
  assert.equal((await api(base, '/api/chat/provider', 'PUT', {})).status, 400);
  assert.equal((await api(base, '/api/chat/provider', 'PUT', { provider: 42 })).status, 400);
  const nope = await api(base, '/api/chat/provider', 'PUT', { provider: 'nope' });
  assert.equal(nope.status, 400);
  assert.match(nope.json.error!, /没有这个 LLM provider/);
  assert.equal(db.getSetting('chat_provider'), null, '400 不落库');

  // 指定 ds（已配置、但还缺 key）：写入成功；chat 前置检查按「选定的那个」判 → 400 且指引改回自动
  const set = await api(base, '/api/chat/provider', 'PUT', { provider: 'ds' });
  assert.equal(set.status, 200);
  assert.deepEqual(set.json, { ok: true, provider: 'ds' });
  assert.equal(db.getSetting('chat_provider'), 'ds');
  const blocked = await api(base, '/api/chat', 'POST', { message: '在吗' });
  assert.equal(blocked.status, 400);
  assert.match(blocked.json.error!, /选定的 LLM provider「ds」当前不可用/);
  assert.equal(llm.bodies.length, 0, '选定的 provider 没就绪就不打 LLM');

  // 补上 key 后点名路由成真：回复自带 provider
  await api(base, '/api/llm/keys', 'PUT', { provider: 'ds', value: 'sk-chat' });
  const r = await api(base, '/api/chat', 'POST', { message: '在吗' });
  assert.equal(r.status, 200);
  assert.equal(r.json.provider, 'ds', '点名路由下 provider = 选定的那个');

  // history：当前选定 + 每条 assistant 消息自己是谁答的（user 行恒 null）
  const h = await api(base, '/api/chat/history');
  assert.equal(h.json.provider, 'ds');
  assert.deepEqual((h.json.messages as Array<Record<string, unknown>>).map((m) => [m.role, m.provider]),
    [['user', null], ['assistant', 'ds']]);

  // 回到自动：''' = 删键（不是写空串），history.provider 回空串
  const auto = await api(base, '/api/chat/provider', 'PUT', { provider: '' });
  assert.equal(auto.status, 200);
  assert.deepEqual(auto.json, { ok: true, provider: '' });
  assert.equal(db.getSetting('chat_provider'), null);
  assert.equal((await api(base, '/api/chat/history')).json.provider, '');

  // 配置写 → 进变更历史（可撤销、中文操作名、设置项中文标签）
  const changes = (await api(base, '/api/undo/history')).json.changes as Array<Record<string, unknown>>;
  assert.equal(changes[0]!.tool, 'set_chat_provider');
  assert.equal(changes[0]!.title, '选择 Agent 模型');
  assert.deepEqual(changes[0]!.detail, [{ label: 'Agent 模型选择', action: 'deleted', changes: [] }]);
});

test('GET /api/llm 的 providers 带 ready；chatProvider 回显当前选择', async (t) => {
  const { base } = await setup(t, { chat: true, llm: { config: LLM_CFG } });
  const first = await api(base, '/api/llm');
  assert.equal(first.json.chatProvider, '', '缺省模型选择 = 自动路由（与 /api/chat/history 同一个键）');
  const p0 = (first.json.providers as Array<Record<string, unknown>>)[0]!;
  assert.equal(p0.ready, false, '缺 key → ready=false');
  assert.match(String(p0.status), /缺 key/);

  await api(base, '/api/llm/keys', 'PUT', { provider: 'ds', value: 'sk-chat' });
  assert.equal((await api(base, '/api/chat/provider', 'PUT', { provider: 'ds' })).status, 200);
  const info = (await api(base, '/api/llm')).json;
  assert.equal(info.chatProvider, 'ds', '选择器只需读这一处就能预选');
  const p1 = (info.providers as Array<Record<string, unknown>>)[0]!;
  assert.equal(p1.ready, true);
  assert.equal(p1.status, 'ready');
});

test('/api/chat：assistant 消息的 provider 落库（老消息/无 = null；QQ 侧同一张表同一列）', async (t) => {
  const llm = chatFetch([{ choices: [{ message: { content: '答复二' } }] }]);
  const { base, chat } = await setup(t, { chat: true, llm: { config: LLM_CFG }, llmFetch: llm.fn });
  // 直插一条「老消息」（加列之前落库的形态：provider 为 NULL），验证读取不炸、回 null
  chat!.append(adminScope(), { role: 'assistant', content: '老消息' });
  await api(base, '/api/llm/keys', 'PUT', { provider: 'ds', value: 'sk-chat' });

  await api(base, '/api/chat', 'POST', { message: '第二个问题' });

  const stored = chat!.messages(adminScope());
  assert.deepEqual(stored.map((m) => [m.role, m.provider]),
    [['assistant', null], ['user', null], ['assistant', 'ds']], '老消息 null，本轮回答记 ds');
  const shown = ((await api(base, '/api/chat/history')).json.messages as Array<Record<string, unknown>>)
    .map((m) => [m.role, m.provider]);
  assert.deepEqual(shown, [['assistant', null], ['user', null], ['assistant', 'ds']]);
});

test('/api/chat：LLM 调用彻底失败 → 502（与「未就绪 400」分开）', async (t) => {
  const failFetch: FetchLike = async () => new Response('boom', { status: 500 });
  const { base } = await setup(t, { chat: true, llm: { config: LLM_CFG }, llmFetch: failFetch });
  await api(base, '/api/llm/keys', 'PUT', { provider: 'ds', value: 'sk-chat' });

  const r = await api(base, '/api/chat', 'POST', { message: '在吗' });
  assert.equal(r.status, 502);
  assert.match(r.json.error!, /LLM 调用失败/);
  const body = JSON.stringify(r.json);
  assert.ok(!body.includes('sk-chat'), '错误信息不含 key');
});

test('无 chat dep 时 /api/chat* 一律 404（五个端点各自按 dep 挂载）', async (t) => {
  const { base } = await setup(t);
  assert.equal((await api(base, '/api/chat/history')).status, 404);
  assert.equal((await api(base, '/api/chat', 'POST', { message: '你好' })).status, 404);
  assert.equal((await api(base, '/api/chat/reset', 'POST')).status, 404);
  assert.equal((await api(base, '/api/chat/mode', 'PUT', { mode: 'auto' })).status, 404);
  assert.equal((await api(base, '/api/chat/provider', 'PUT', { provider: 'ds' })).status, 404);
});