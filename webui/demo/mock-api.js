// Demo 专用 fetch 拦截器：内存实现整张 /api/* 路由表（含 PUT/POST/DELETE 变更与排序）。
// 仅当 URL 里带 ?demo=1 时由 boot.js 动态 import 本模块；import 副作用 = 装上拦截器。
// 契约：与真实后端 /api/* 完全同构（改 server.ts 路由时须同步改这里，见 AGENTS.md 开发约定）。
//
// 数据来源三部分（见 mock-data.js 头注）：fixtures.json（真实库导出的主播/关注/时间表
// 节选，随仓库发布）+ defaults.json（LLM/分类/推送规则的手工展示案例 = 首启默认值）
// + mock-data.js 手写设置卡片。夹具带 meta.exportedAt——demo 把页面时间冻结在导出
// 时刻渲染（freezeTime），哪天打开看到的都是导出瞬间的样子。
import * as M from './mock-data.js';

function clone(x) { return structuredClone(x); }

// ---- 夹具加载（此刻拦截器尚未安装，这是真实 HTTP 请求；缺失时逐项回退空态）----
let fixtures = null;
let defaults = null;
try {
  const fr = await window.fetch('/demo/fixtures.json', { cache: 'no-store' });
  if (fr.ok) fixtures = await fr.json();
} catch { /* 无夹具 */ }
try {
  const dr = await window.fetch('/demo/defaults.json', { cache: 'no-store' });
  if (dr.ok) defaults = await dr.json();
} catch { /* 无默认值 */ }

// demo 时间冻结：fixtures 有导出时刻就把「现在」锁到那一刻（须在 app.js 加载前，
// boot.js 的 import 顺序已保证）
if (fixtures?.meta?.exportedAt) M.freezeTime(fixtures.meta.exportedAt);

const nowSec = Math.floor(Date.now() / 1000);

// ---- defaults.json → 卡片行（补 id/时间戳；规则渠道 = 全部渠道，分类按名映射回 id）----
const demoCategories = (defaults?.categories ?? []).map((c, i) => ({
  id: i + 1, name: c.name, llmPrompt: c.llmPrompt ?? null,
  keywords: c.keywords ?? [], areas: c.areas ?? [], condMode: c.condMode ?? 'and',
  enabled: true, createdAt: nowSec, updatedAt: nowSec,
}));
const catIdByName = new Map(demoCategories.map((c) => [c.name, c.id]));
const allChannelIds = M.mockChannels.map((c) => c.id);
const demoRules = (defaults?.rules ?? []).map((r, i) => ({
  id: i + 1, name: r.name,
  categoryId: r.category != null ? (catIdByName.get(r.category) ?? null) : null,
  uids: [], channels: [...allChannelIds],
  messageTemplate: r.messageTemplate ?? null,
  enabled: true, createdAt: nowSec, updatedAt: nowSec,
}));

// ---- 内存库（深拷贝种子，本会话可改）----
const store = {
  streamers: clone(fixtures?.streamers ?? []),
  follows: clone(fixtures?.follows ?? []),
  schedule: clone(fixtures?.schedule ?? []),
  channels: clone(M.mockChannels),
  categories: demoCategories,
  rules: demoRules,
  llmProviders: clone(defaults?.llmProviders ?? []),
  advanced: { ...M.mockAdvanced },
  napcat: clone(M.mockNapcat),
  x: clone(M.mockX),
  xAccounts: clone(M.mockXAccounts),
  xAccountSeq: M.mockXAccounts.length,
  weibo: clone(M.mockWeibo),
  weiboAccounts: clone(M.mockWeiboAccounts),
  weiboAccountSeq: M.mockWeiboAccounts.length,
  weiboPosts: clone(M.mockWeiboPosts),
  postRules: clone(M.mockPostRules),
  postRuleSeq: M.mockPostRules.length,
  twitterPosts: clone(M.mockTwitterPosts),
  pushEnabled: true,
  llmEnabled: true,
  biliLoggedIn: true,
  weiboLoggedIn: true,
  listenSettings: { dynamic: 'auto', weibo: 'auto', twitter: 'auto' },
  biliQrStep: 0,
  weiboQrStep: 0,
};

// X 快照的时间戳也用冻结时刻（连接卡副行要显示「上次测试 x/x xx:xx」）
store.x.status.proxy.checkedAt = nowSec;
store.x.status.web.checkedAt = nowSec;
store.x.status.updatedAt = nowSec;
store.x.status.feed.lastRunAt = nowSec - 120;
store.x.status.feed.lastOkAt = nowSec - 120;
for (const a of store.xAccounts) {
  if (a.lastTweetAt) a.lastTweetAt = nowSec - 4200;
  if (a.lastOkAt) a.lastOkAt = nowSec - 120;
  a.createdAt = nowSec;
  a.updatedAt = nowSec;
}
// 微博快照与名单同样用冻结时刻（卡片显示「微博 x 小时前」；快照本身面板不展示，保留以免与后端契约分叉）
store.weibo.status.feed.lastRunAt = nowSec - 90;
store.weibo.status.feed.lastOkAt = nowSec - 90;
for (const a of store.weiboAccounts) {
  if (a.lastPostAt) a.lastPostAt = nowSec - 3600 * 5;
  if (a.lastOkAt) a.lastOkAt = nowSec - 90;
  a.createdAt = nowSec;
  a.updatedAt = nowSec;
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
const ok = (obj) => json(200, obj);
const created = (obj) => json(201, obj);
const err = (status, msg) => json(status, { error: msg });

// ---- 路由 ----
function handle(method, path, q, rawBody) {
  const body = () => { try { return JSON.parse(rawBody || '{}'); } catch { return {}; } };

  // ---- 扫码登录（演示循环：waiting → scanned → confirmed）----
  if (path === '/api/auth/bili/qrcode' && method === 'POST') {
    store.biliQrStep = 0;
    return ok({ key: 'demo-bili-key', url: 'https://passport.bilibili.com/h5-app/passport/login/scan?navhide=1&qrcode_key=demo' });
  }
  if (path === '/api/auth/bili/qrcode/poll' && method === 'GET') {
    store.biliQrStep += 1;
    const s = store.biliQrStep;
    if (s <= 2) return ok({ status: 'waiting' });
    if (s === 3) return ok({ status: 'scanned' });
    store.biliLoggedIn = true;
    return ok({ status: 'confirmed', mid: '10086' });
  }
  if (path === '/api/auth/weibo/qrcode' && method === 'POST') {
    store.weiboQrStep = 0;
    return ok({ image: M.svgKeyframe('#ff8200', '微博扫码') });
  }
  if (path === '/api/auth/weibo/qrcode/poll' && method === 'GET') {
    store.weiboQrStep += 1;
    const s = store.weiboQrStep;
    if (s <= 2) return ok({ status: 'waiting' });
    if (s === 3) return ok({ status: 'scanned' });
    store.weiboLoggedIn = true;
    return ok({ status: 'confirmed', uid: '9001' });
  }

  // ---- 系统状态 ----
  if (path === '/api/status' && method === 'GET') {
    return ok({
      startedAt: nowSec - 3600 * 26,
      notifiers: ['onebot', 'toast'],
      watchedCount: store.streamers.filter((s) => s.watch).length,
      liveCount: store.streamers.filter((s) => s.live && s.live.isLive).length,
      platforms: M.mockPlatforms,
    });
  }

  // 最近推文的时间戳也用冻结时刻（账号卡推文段要显示「x 小时前」）
for (const p of store.twitterPosts) {
  p.pubTs = nowSec - 1800 * p.id;
  p.createdAt = nowSec;
}

// ---- 监听开关 ----
  if (path === '/api/listen' && method === 'GET') {
    // X 没有登录态：它的「运行前提」是代理已配置（与真实后端 listenReady 同构）
    const ready = (feature) => feature === 'dynamic' ? store.biliLoggedIn
      : feature === 'weibo' ? store.weiboLoggedIn
      : Boolean(store.x.config.proxyUrl);
    const row = (feature) => ({
      feature,
      setting: store.listenSettings[feature],
      enabled: ready(feature) && (store.listenSettings[feature] !== '0'),
    });
    return ok({
      biliLoggedIn: store.biliLoggedIn,
      weiboLoggedIn: store.weiboLoggedIn,
      xProxyConfigured: Boolean(store.x.config.proxyUrl),
      platforms: M.mockPlatforms,
      rows: {
        dynamic: row('dynamic'),
        weibo: row('weibo'),
        twitter: row('twitter'),
      },
    });
  }
  {
    const lm = path.match(/^\/api\/listen\/(dynamic|weibo|twitter)$/);
    if (lm && method === 'PUT') {
      const b = body();
      const feature = lm[1];
      const ready = feature === 'dynamic' ? store.biliLoggedIn
        : feature === 'weibo' ? store.weiboLoggedIn
        : Boolean(store.x.config.proxyUrl);
      store.listenSettings[feature] = b.enabled === !ready ? (b.enabled ? '1' : '0') : 'auto';
      return ok({
        feature,
        enabled: ready && (store.listenSettings[feature] !== '0'),
        setting: store.listenSettings[feature],
      });
    }
  }

  // ---- 图文帖规则（X/推特 + 微博；与推送规则平行的另一张表，platform 决定账号名单）----
  // 平台 → 名单/报错文案，与真实后端 checkPostRuleRefs 同构（两张名单的自增 id 会撞）
  const acctList = (platform) => platform === 'weibo' ? store.weiboAccounts : store.xAccounts;
  const acctErr = (platform) => platform === 'weibo' ? '微博 账号不存在' : 'X 账号不存在';
  const checkPostRule = (b, rule) => {
    const platform = b.platform !== undefined ? b.platform : (rule ? rule.platform : 'twitter');
    if (platform !== 'twitter' && platform !== 'weibo') return { error: 'platform 必须是 twitter 或 weibo' };
    const filters = Object.assign(
      { original: true, retweet: false, quote: false, media: false, keywords: [] },
      rule ? rule.filters : {}, b.filters || {},
    );
    if (!filters.original && !filters.retweet) {
      return { error: '「原创」与「转发」至少要勾一个，否则这条规则永远不会命中' };
    }
    if (platform === 'weibo' && filters.quote) return { error: '微博没有「引用」这种形态，「引用」筛选只对 X 生效' };
    if (platform === 'weibo' && b.llmTranslate === true) return { error: '微博正文本就是中文，不需要 LLM 翻译' };
    const judge = b.llmJudge !== undefined ? b.llmJudge === true : (rule ? rule.llmJudge : false);
    const prompt = b.judgePrompt !== undefined ? b.judgePrompt : (rule ? rule.judgePrompt : null);
    if (judge && !String(prompt || '').trim()) return { error: '开启「LLM 判定」必须填判定提示词' };
    if (Array.isArray(b.channels) && b.channels.some((id) => !store.channels.some((c) => c.id === id))) {
      return { error: '渠道不存在' };
    }
    // 换平台时没带新名单 → 清空（旧平台 id 指向另一个账号）；与真实后端同口径
    const accountIds = b.accountIds !== undefined
      ? b.accountIds
      : (rule && rule.platform !== platform ? [] : (rule ? rule.accountIds : []));
    const bad = accountIds.find((id) => !acctList(platform).some((a) => a.id === id));
    if (bad !== undefined) return { error: acctErr(platform) };
    return { platform, filters, accountIds };
  };

  if (path === '/api/post-rules' && method === 'GET') {
    return ok({ rules: clone(store.postRules) });
  }
  if (path === '/api/post-rules' && method === 'POST') {
    const b = body();
    const c = checkPostRule(b, null);
    if (c.error) return json(400, { error: c.error });
    const rule = {
      id: ++store.postRuleSeq,
      name: b.name || `图文帖规则 ${store.postRuleSeq}`,
      platform: c.platform,
      accountIds: c.accountIds, channels: b.channels || [], filters: c.filters,
      messageTemplate: b.messageTemplate ?? null,
      llmJudge: b.llmJudge === true,
      judgePrompt: b.judgePrompt ?? null,
      llmTranslate: c.platform === 'weibo' ? false : b.llmTranslate === true,
      enabled: b.enabled !== false,
      sort: store.postRules.length, createdAt: nowSec, updatedAt: nowSec,
    };
    store.postRules.push(rule);
    return ok({ id: rule.id });
  }
  if (path === '/api/post-rules/order' && method === 'PUT') {
    const ids = body().ids || [];
    if (ids.length !== store.postRules.length) return json(400, { error: 'ids 必须与现有图文帖规则一一对应' });
    store.postRules.sort((a, b2) => ids.indexOf(a.id) - ids.indexOf(b2.id));
    store.postRules.forEach((r, i) => { r.sort = i; });
    return ok({ ok: true });
  }
  {
    const prm = path.match(/^\/api\/post-rules\/(\d+)$/);
    if (prm) {
      const rule = store.postRules.find((r) => r.id === Number(prm[1]));
      if (!rule) return json(404, { error: '图文帖规则不存在' });
      if (method === 'PUT') {
        const b = body();
        const c = checkPostRule(b, rule);
        if (c.error) return json(400, { error: c.error });
        if (b.name !== undefined) rule.name = b.name;
        rule.platform = c.platform;
        rule.accountIds = c.accountIds;
        if (b.channels !== undefined) rule.channels = b.channels;
        rule.filters = c.filters;
        if (b.llmJudge !== undefined) rule.llmJudge = b.llmJudge === true;
        if (b.judgePrompt !== undefined) rule.judgePrompt = b.judgePrompt;
        if (b.llmTranslate !== undefined) rule.llmTranslate = c.platform === 'weibo' ? false : b.llmTranslate === true;
        if (b.messageTemplate !== undefined) rule.messageTemplate = b.messageTemplate;
        if (typeof b.enabled === 'boolean') rule.enabled = b.enabled;
        rule.updatedAt = nowSec;
        return ok({ ok: true });
      }
      if (method === 'DELETE') {
        store.postRules = store.postRules.filter((r) => r.id !== rule.id);
        return ok({ ok: true });
      }
    }
  }

  // ---- NapCat ----
  if (path === '/api/napcat' && method === 'GET') {
    return ok({ ...store.napcat });
  }
  if (path === '/api/napcat' && method === 'PUT') {
    const b = body();
    for (const k of ['enabled', 'autorestart']) if (typeof b[k] === 'boolean') store.napcat[k] = b[k];
    for (const k of ['dir', 'uin', 'alertQq']) if (typeof b[k] === 'string') store.napcat[k] = b[k].trim();
    return ok({ ok: true, ...store.napcat });
  }
  if (path === '/api/napcat/launch' && method === 'POST') {
    store.napcat.endpoint = 'http://127.0.0.1:41990';
    store.napcat.probe = { state: 'ok', loggedIn: true };
    return ok({ ok: true });
  }

  // ---- 高级设置 ----
  if (path === '/api/advanced' && method === 'GET') {
    return ok({ ...store.advanced });
  }
  if (path === '/api/advanced' && method === 'PUT') {
    const b = body();
    Object.assign(store.advanced, b);
    return ok({ ok: true, ...store.advanced });
  }

  // ---- X / 推特（独立分页；契约与真实后端同构：GET 只读快照，探测走 /test）----
  if (path === '/api/x' && method === 'GET') {
    return ok({ config: store.x.config, status: store.x.status });
  }
  // X 关注账号：独立名单 CRUD；视图 = 名单行 + 关联主播展示名 + 最近 3 条推文
  // （与真实后端 server.ts 的 xAccountView 同构，账号卡身份段/推文段都读它）
  const xAccountView = (a) => {
    const bili = a.biliUid != null
      ? store.streamers.find((s) => String(s.uid) === String(a.biliUid)) : null;
    const posts = store.twitterPosts
      .filter((p) => p.uid === a.screenName)
      .sort((x2, y2) => y2.pubTs - x2.pubTs)
      .slice(0, 3)
      .map((p) => clone(p));
    return { ...clone(a), biliName: bili ? (bili.alias || bili.uname || String(a.biliUid)) : null, biliFace: bili ? (bili.face ?? null) : null, posts };
  };
  if (path === '/api/x/accounts' && method === 'GET') {
    return ok({ accounts: store.xAccounts.map(xAccountView) });
  }
  if (path === '/api/x/accounts' && method === 'POST') {
    const b = body();
    const screenName = String(b.screenName || '').trim().replace(/^@+/, '').toLowerCase();
    if (!/^[a-z0-9_]{1,15}$/.test(screenName)) return json(400, { error: 'X 账号格式不对（字母 / 数字 / 下划线，1~15 位）' });
    if (store.xAccounts.some((a) => a.screenName === screenName)) return json(409, { error: `@${screenName} 已在名单里` });
    // 演示口径：名单里已有 3 个 + nhk_news 算「存在」，其余给「账号不存在」，便于看 400 那条路
    const known = ['watase_yuzuki', 'd4dj_pj', 'hololive_en', 'nhk_news'].includes(screenName);
    if (!known) return json(400, { error: `X 账号不存在：@${screenName}` });
    const row = {
      id: ++store.xAccountSeq, screenName, displayName: b.displayName ? String(b.displayName) : null,
      biliUid: b.biliUid ? String(b.biliUid) : null, enabled: b.enabled !== false,
      lastTweetId: null, lastTweetAt: null, lastOkAt: null, avatar: null, createdAt: nowSec, updatedAt: nowSec,
    };
    store.xAccounts.push(row);
    return ok({ account: xAccountView(row), verify: { checked: true, ok: true, kind: 'ok', message: '账号存在（页面含 7 条推文）' } });
  }
  {
    const xa = path.match(/^\/api\/x\/accounts\/(\d+)$/);
    if (xa && method === 'PUT') {
      const row = store.xAccounts.find((a) => a.id === Number(xa[1]));
      if (!row) return json(404, { error: 'X 账号不存在' });
      const b = body();
      if (typeof b.screenName === 'string') row.screenName = b.screenName.trim().replace(/^@+/, '').toLowerCase();
      if (b.biliUid !== undefined) row.biliUid = b.biliUid === null ? null : String(b.biliUid);
      if (b.displayName !== undefined) row.displayName = b.displayName === null ? null : String(b.displayName);
      if (typeof b.enabled === 'boolean') row.enabled = b.enabled;
      row.updatedAt = nowSec;
      return ok({ account: xAccountView(row) });
    }
    if (xa && method === 'DELETE') {
      const i = store.xAccounts.findIndex((a) => a.id === Number(xa[1]));
      if (i < 0) return json(404, { error: 'X 账号不存在' });
      store.xAccounts.splice(i, 1);
      return ok({ ok: true });
    }
  }
  if (path === '/api/x' && method === 'PUT') {
    const b = body();
    const prev = JSON.stringify(store.x.config);
    if (typeof b.proxyUrl === 'string') store.x.config.proxyUrl = b.proxyUrl;
    if (typeof b.instances === 'string') {
      store.x.config.instances = b.instances.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (Number.isInteger(b.intervalSec)) store.x.config.intervalSec = b.intervalSec;
    if (typeof b.fallbackHtml === 'boolean') store.x.config.fallbackHtml = b.fallbackHtml;
    // 与真实后端 invalidateXStatus 同构：配置变了，相关旧结论作废（别让红点配着新地址）
    const before = JSON.parse(prev);
    const stale = { ok: false, message: '配置已改，请重新测试', checkedAt: null };
    if (store.x.config.proxyUrl !== before.proxyUrl || store.x.config.fallbackHtml !== before.fallbackHtml) {
      store.x.status.proxy = { ...stale };
      store.x.status.web = { ...stale };
    }
    if (store.x.config.instances.join(',') !== before.instances.join(',')) {
      store.x.status.instances = [];
    }
    return ok({ config: store.x.config, status: store.x.status });
  }
  // ---- 微博（图文分页第二个来源）：GET 只读快照 + 独立名单 CRUD ----
  // 契约与真实后端 /api/weibo* 同构：uid 与昵称二选一（只填昵称 → 演示口径固定解析成 2203177060）
  const weiboAccountView = (a) => {
    const bili = a.biliUid != null
      ? store.streamers.find((s) => String(s.uid) === String(a.biliUid)) : null;
    const posts = store.weiboPosts
      .filter((p) => p.uid === a.uid)
      .sort((x2, y2) => y2.pubTs - x2.pubTs)
      .slice(0, 3)
      .map((p) => clone(p));
    return {
      ...clone(a),
      biliName: bili ? (bili.alias || bili.uname || String(a.biliUid)) : null,
      biliFace: bili ? (bili.face ?? null) : null,
      posts,
    };
  };
  if (path === '/api/weibo' && method === 'GET') {
    return ok({
      config: store.weibo.config,
      status: { ...store.weibo.status, accounts: store.weiboAccounts.filter((a) => a.enabled).length },
    });
  }
  if (path === '/api/weibo/accounts' && method === 'GET') {
    return ok({ accounts: store.weiboAccounts.map(weiboAccountView) });
  }
  if (path === '/api/weibo/accounts' && method === 'POST') {
    const b = body();
    let uid = String(b.uid || '').trim();
    let nickname = b.nickname ? String(b.nickname).trim() : null;
    if (!uid && nickname) {
      if (nickname !== '阿梓从小就很可爱' && nickname !== '阿梓') {
        return json(400, { error: `微博上找不到这个昵称：${nickname}` });
      }
      uid = '2203177060';
    }
    if (!uid) return json(400, { error: 'uid 与昵称至少填一个' });
    if (!/^\d{1,20}$/.test(uid)) return json(400, { error: '微博 uid 必须是数字（可从 weibo.com/u/<uid> 复制）' });
    if (store.weiboAccounts.some((a) => a.uid === uid)) return json(409, { error: `微博 ${uid} 已在名单里` });
    if (b.biliUid != null && !store.streamers.some((s) => String(s.uid) === String(b.biliUid))) {
      return json(400, { error: `关联主播不在监听名单: ${b.biliUid}` });
    }
    const row = {
      id: ++store.weiboAccountSeq, uid, nickname, biliUid: b.biliUid ?? null,
      enabled: b.enabled !== false, lastPostId: null, lastPostAt: null, lastOkAt: null,
      avatar: null, createdAt: nowSec, updatedAt: nowSec,
    };
    store.weiboAccounts.push(row);
    return ok({ account: weiboAccountView(row) });
  }
  {
    const wa = path.match(/^\/api\/weibo\/accounts\/(\d+)$/);
    if (wa) {
      const row = store.weiboAccounts.find((a) => a.id === Number(wa[1]));
      if (!row) return json(404, { error: '微博账号不存在' });
      if (method === 'PUT') {
        const b = body();
        if (b.uid !== undefined && !/^\d{1,20}$/.test(String(b.uid))) {
          return json(400, { error: '微博 uid 必须是数字' });
        }
        if (b.uid !== undefined && String(b.uid) !== row.uid
          && store.weiboAccounts.some((a) => a.uid === String(b.uid))) {
          return json(409, { error: `微博 ${b.uid} 已在名单里` });
        }
        if (b.biliUid !== undefined && b.biliUid !== null
          && !store.streamers.some((s) => String(s.uid) === String(b.biliUid))) {
          return json(400, { error: `关联主播不在监听名单: ${b.biliUid}` });
        }
        if (b.uid !== undefined) row.uid = String(b.uid);
        if (b.nickname !== undefined) row.nickname = b.nickname;
        if (b.biliUid !== undefined) row.biliUid = b.biliUid;
        if (typeof b.enabled === 'boolean') row.enabled = b.enabled;
        row.updatedAt = nowSec;
        return ok({ account: weiboAccountView(row) });
      }
      if (method === 'DELETE') {
        store.weiboAccounts = store.weiboAccounts.filter((a) => a.id !== row.id);
        return ok({ ok: true });
      }
    }
  }

  if (path === '/api/x/test' && method === 'POST') {
    const b = body();
    const target = b.target || 'all';
    const proxyUrl = typeof b.proxyUrl === 'string' && b.proxyUrl ? b.proxyUrl : store.x.config.proxyUrl;
    const hosts = typeof b.instances === 'string' && b.instances
      ? b.instances.split(',').map((s) => s.trim()).filter(Boolean)
      : store.x.config.instances;
    const out = {};
    // 演示口径：代理与免登录恒通；实例按已知名单给「两通一限速」，未知实例按 404 不可用
    if (target === 'all' || target === 'proxy') {
      // 与真实 probeProxy 同构：非法代理形状不抛错，而是回一条可读的失败原因
      const looksValid = !proxyUrl || /^(https?:\/\/)?[a-z0-9.-]+(:\d{1,5})?$/i.test(proxyUrl);
      out.proxy = !proxyUrl
        ? { ok: false, kind: 'unconfigured', target: 'https://x.com/robots.txt', status: null, ms: 0, message: '未配置代理；境内直连 x.com 会 TLS 被重置，X 功能不可用' }
        : !looksValid
          ? { ok: false, kind: 'error', target: 'https://x.com/robots.txt', status: null, ms: 0, message: '配置有误：代理只支持 http://（CONNECT），收到 ' + proxyUrl.split(':')[0] + '://' }
          : { ok: true, kind: 'ok', target: 'https://x.com/robots.txt', status: 200, ms: 1780, message: '代理可达 · x.com 200 · 1780ms' };
    }
    if (target === 'all' || target === 'instances') {
      out.instances = hosts.map(function (h) {
        if (h === 'nitter.kareem.one') return { host: h, ok: false, kind: 'blocked', status: 429, ms: 620, items: 0, message: '429 被限速' };
        if (h === 'nitter.jaydenha.uk') return { host: h, ok: true, kind: 'ok', status: 200, ms: 940, items: 20, message: '可用 · 20 条 · 940ms' };
        if (h === 'x.n0g.xyz') return { host: h, ok: true, kind: 'ok', status: 200, ms: 1120, items: 20, message: '可用 · 20 条 · 1120ms' };
        return { host: h, ok: false, kind: 'error', status: 404, ms: 510, items: 0, message: 'HTTP 404' };
      });
    }
    if (target === 'all' || target === 'web') {
      out.web = { ok: true, screenName: 'watase_yuzuki', status: 200, ms: 1980, tweetIds: 7, latestId: '2100025416010661982', latestAt: nowSec - 3600 * 10, message: '免登录可用 · 7 个 id' };
    }
    const now = Math.floor(Date.now() / 1000);
    // 与真实后端 isSavedConfigTest 同构：测的是未保存的输入值 → 只回结果，不动卡片快照
    const proxySame = b.proxyUrl === undefined || String(b.proxyUrl).trim() === store.x.config.proxyUrl.trim();
    const instSame = b.instances === undefined
      || String(b.instances).split(',').map((s) => s.trim()).filter(Boolean).join(',') === store.x.config.instances.join(',');
    if (!(proxySame && instSame)) return ok({ ...out, status: store.x.status });
    if (out.proxy) store.x.status.proxy = { ok: out.proxy.ok, message: out.proxy.message, checkedAt: now };
    if (out.instances) {
      store.x.status.instances = out.instances.map((i) => ({ host: i.host, ok: i.ok, message: i.message }));
    }
    if (out.web) store.x.status.web = { ok: out.web.ok, message: out.web.message, checkedAt: now };
    store.x.status.updatedAt = now;
    return ok({ ...out, status: store.x.status });
  }

  // ---- 快照 / 头像：demo 下不经本拦截器 ----
  // 前端对 /api/snapshot 与 /api/avatar 走 <img>.src 直载（schedule.js），不经过 fetch，
  // 静态服回 404 → 前端回退链生效（快照：远程 keyframe ?? cover；头像：哈希色），属预期行为。

  // ---- 主播列表 / 关注 ----
  if (path === '/api/streamers' && method === 'GET') {
    const list = store.streamers.map((s) => ({
      ...s,
      rules: {
        names: store.rules
          .filter((r) => r.uids.length === 0 || r.uids.includes(s.uid))
          .map((r) => r.name),
      },
    }));
    return ok({ streamers: list });
  }
  if (path === '/api/follows' && method === 'GET') {
    const watched = new Set(store.streamers.filter((s) => s.watch).map((s) => s.uid));
    return ok({ follows: store.follows.map((f) => ({ uid: f.uid, uname: f.uname, face: f.face, watched: watched.has(f.uid) })) });
  }
  {
    const sm = path.match(/^\/api\/streamers\/([^/]+?)(\/watch)?$/);
    if (sm) {
      const uid = sm[1];
      if (sm[2] && method === 'POST') {
        const ex = store.streamers.find((s) => s.uid === uid);
        if (ex && ex.watch) return err(409, '该主播已在监听名单');
        if (ex) {
          ex.watch = true;
        } else {
          const f = store.follows.find((x) => x.uid === uid);
          store.streamers.push({
            uid, uname: f ? f.uname : uid, alias: null, roomId: uid,
            face: f ? f.face : null, watch: true, analyze: false, notify: true,
            weiboNick: null, weiboUid: null, profileNote: null, live: null, posts: [],
          });
        }
        return ok({ streamer: store.streamers.find((s) => s.uid === uid) });
      }
      if (!sm[2] && method === 'PUT') {
        const prev = store.streamers.find((s) => s.uid === uid);
        if (!prev) return err(404, '该 uid 不在监听名单');
        const b = body();
        for (const k of ['alias', 'profileNote']) if (typeof b[k] === 'string' || b[k] === null) prev[k] = b[k];
        for (const k of ['watch', 'analyze', 'notify']) if (typeof b[k] === 'boolean') prev[k] = b[k];
        if (b.weiboNick !== undefined) {
          if (!b.weiboNick) { prev.weiboNick = null; prev.weiboUid = null; }
          else { prev.weiboNick = b.weiboNick; prev.weiboUid = prev.weiboUid || '9' + uid; }
        }
        return ok({ streamer: prev });
      }
    }
  }

  // ---- 推送总开关 / 测试 ----
  if (path === '/api/push' && method === 'GET') return ok({ enabled: store.pushEnabled });
  if (path === '/api/push/enabled' && method === 'PUT') {
    const b = body();
    if (typeof b.enabled !== 'boolean') return err(400, 'enabled 必须是布尔值');
    store.pushEnabled = b.enabled;
    return ok({ ok: true, enabled: b.enabled });
  }
  if (path === '/api/push/test' && method === 'POST') {
    const total = store.channels.filter((c) => c.enabled).length;
    return ok({ ok: true, total, succeeded: total });
  }

  // ---- 渠道 ----
  if (path === '/api/channels' && method === 'GET') return ok({ channels: store.channels });
  if (path === '/api/channels' && method === 'POST') {
    const b = body();
    const id = store.channels.reduce((m, c) => Math.max(m, c.id), 0) + 1;
    store.channels.push({
      id, name: b.name || ('渠道 ' + id), notifier: b.notifier || 'toast',
      targetType: b.notifier === 'onebot' ? (b.targetType || 'private') : null,
      targetId: b.notifier === 'onebot' ? (b.targetId || null) : null,
      enabled: true, createdAt: Date.now(), updatedAt: Date.now(),
    });
    return created({ id });
  }
  if (path === '/api/channels/order' && method === 'PUT') {
    const ids = body().ids || [];
    store.channels.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    return ok({ ok: true });
  }
  {
    const cm = path.match(/^\/api\/channels\/([^/]+)$/);
    if (cm) {
      const id = Number(cm[1]);
      const c = store.channels.find((x) => x.id === id);
      if (!c) return err(404, '渠道不存在');
      if (method === 'PUT') {
        const b = body();
        for (const k of ['name', 'notifier', 'targetType', 'targetId']) if (b[k] !== undefined) c[k] = b[k];
        if (typeof b.enabled === 'boolean') c.enabled = b.enabled;
        return ok({ ok: true });
      }
      if (method === 'DELETE') {
        store.channels = store.channels.filter((x) => x.id !== id);
        return ok({ ok: true });
      }
    }
  }

  // ---- 分类规则 ----
  if (path === '/api/categories' && method === 'GET') return ok({ categories: store.categories });
  if (path === '/api/categories' && method === 'POST') {
    const b = body();
    const id = store.categories.reduce((m, c) => Math.max(m, c.id), 0) + 1;
    store.categories.push({
      id, name: b.name || ('分类 ' + id),
      llmPrompt: b.llmPrompt ?? null,
      keywords: b.keywords || [], areas: b.areas || [],
      condMode: b.condMode || 'and', enabled: true,
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    return created({ id });
  }
  if (path === '/api/categories/order' && method === 'PUT') {
    const ids = body().ids || [];
    store.categories.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    return ok({ ok: true });
  }
  {
    const cm = path.match(/^\/api\/categories\/([^/]+)$/);
    if (cm) {
      const id = Number(cm[1]);
      const c = store.categories.find((x) => x.id === id);
      if (!c) return err(404, '分类不存在');
      if (method === 'PUT') {
        const b = body();
        for (const k of ['name', 'llmPrompt', 'keywords', 'areas', 'condMode']) if (b[k] !== undefined) c[k] = b[k];
        if (typeof b.enabled === 'boolean') c.enabled = b.enabled;
        return ok({ ok: true });
      }
      if (method === 'DELETE') {
        const disabledRules = store.rules.filter((r) => r.categoryId === id && r.enabled).length;
        store.rules.forEach((r) => { if (r.categoryId === id) r.enabled = false; });
        store.categories = store.categories.filter((x) => x.id !== id);
        return ok({ ok: true, disabledRules });
      }
    }
  }

  // ---- 推送规则 ----
  if (path === '/api/rules' && method === 'GET') {
    const uid = q.get('uid');
    const rules = uid ? store.rules.filter((r) => r.uids.length === 0 || r.uids.includes(uid)) : store.rules;
    return ok({ rules });
  }
  if (path === '/api/rules' && method === 'POST') {
    const b = body();
    const id = store.rules.reduce((m, r) => Math.max(m, r.id), 0) + 1;
    store.rules.push({
      id, name: b.name || ('规则 ' + id),
      categoryId: b.categoryId ?? null,
      uids: b.uids || [], channels: b.channels || [],
      messageTemplate: b.messageTemplate ?? null, enabled: true,
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    return created({ id });
  }
  if (path === '/api/rules/order' && method === 'PUT') {
    const ids = body().ids || [];
    store.rules.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    return ok({ ok: true });
  }
  {
    const rm = path.match(/^\/api\/rules\/([^/]+)$/);
    if (rm) {
      const id = Number(rm[1]);
      const r = store.rules.find((x) => x.id === id);
      if (!r) return err(404, '规则不存在');
      if (method === 'PUT') {
        const b = body();
        for (const k of ['name', 'categoryId', 'uids', 'channels', 'messageTemplate']) if (b[k] !== undefined) r[k] = b[k];
        if (typeof b.enabled === 'boolean') r.enabled = b.enabled;
        return ok({ ok: true });
      }
      if (method === 'DELETE') {
        store.rules = store.rules.filter((x) => x.id !== id);
        return ok({ ok: true });
      }
    }
  }

  // ---- LLM ----
  if (path === '/api/llm' && method === 'GET') {
    return ok({
      enabled: store.llmEnabled,
      providers: store.llmProviders.map((p) => ({
        ...p,
        routes: p.vision ? ['text', 'vision'] : ['text'],
        status: null,
        // 首启最简态：未填 key（默认值不种 key，面板自行填写）
        key: { source: 'unset', count: 0, value: null },
      })),
    });
  }
  if (path === '/api/llm/enabled' && method === 'PUT') {
    const b = body();
    store.llmEnabled = !!b.enabled;
    return ok({ ok: true, enabled: store.llmEnabled });
  }
  if (path === '/api/llm/keys' && method === 'PUT') {
    return ok({ ok: true });
  }
  if (path === '/api/llm/providers/order' && method === 'PUT') {
    const names = body().names || [];
    store.llmProviders.sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name));
    return ok({ ok: true });
  }
  {
    const tm = path.match(/^\/api\/llm\/providers\/([^/]+)\/test$/);
    if (tm && method === 'POST') {
      return ok({ ok: true, ms: 42 });
    }
  }
  if (path === '/api/llm/providers' && method === 'POST') {
    const b = body();
    if (store.llmProviders.some((p) => p.name === b.name)) return err(400, `provider name 重复: ${b.name}`);
    store.llmProviders.push({
      name: b.name, baseURL: b.baseURL || '', model: b.model || '',
      vision: !!b.vision, enabled: true,
      structuredOutput: b.structuredOutput || 'schema', api: b.api || 'chat-completions',
    });
    return created({ name: b.name });
  }
  {
    const pm = path.match(/^\/api\/llm\/providers\/([^/]+)$/);
    if (pm) {
      const name = decodeURIComponent(pm[1]);
      const p = store.llmProviders.find((x) => x.name === name);
      if (!p) return err(404, 'provider 不存在');
      if (method === 'PUT') {
        const b = body();
        for (const k of ['baseURL', 'model', 'vision', 'enabled', 'structuredOutput', 'api']) if (b[k] !== undefined) p[k] = b[k];
        return ok({ ok: true, name });
      }
      if (method === 'DELETE') {
        store.llmProviders = store.llmProviders.filter((x) => x.name !== name);
        return ok({ ok: true });
      }
    }
  }

  // ---- 时间表 ----
  if (path === '/api/schedule' && method === 'GET') {
    const from = q.get('from') || M.bjAddDays(M.bjToday(), -7);
    const to = q.get('to') || M.bjAddDays(M.bjToday(), 1);
    const fromTs = M.bjDayStart(from);
    const toTs = M.bjDayStart(to);
    const byDay = new Map();
    for (const e of store.schedule) {
      const k = M.bjDayKey(e.startTs);
      if (e.startTs < fromTs || e.startTs >= toTs + 86400) continue;
      const list = byDay.get(k) || [];
      list.push(e);
      byDay.set(k, list);
    }
    const days = [];
    for (let d = fromTs; d <= toTs; d += 86400) {
      days.push({ date: M.bjDayKey(d), entries: byDay.get(M.bjDayKey(d)) || [] });
    }
    return ok({ days });
  }

  return err(404, '未知路由');
}

// ---- 拦截 fetch（仅拦本域 /api/*，其余透传）----
const realFetch = window.fetch.bind(window);
window.fetch = function (input, init) {
  const urlStr = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
  const u = new URL(urlStr, location.href);
  if (u.origin === location.origin && u.pathname.startsWith('/api/')) {
    const method = (init && init.method) || 'GET';
    const rawBody = (init && init.body) || null;
    return Promise.resolve(handle(method, u.pathname, u.searchParams, rawBody));
  }
  return realFetch(input, init);
};
