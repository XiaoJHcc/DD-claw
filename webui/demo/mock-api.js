// Demo 专用 fetch 拦截器：内存实现整张 /api/* 路由表（含 PUT/POST/DELETE 变更与排序）。
// 仅当 URL 里带 ?demo=1 时由 boot.js 动态 import 本模块；import 副作用 = 装上拦截器。
// 契约：与真实后端 /api/* 完全同构（改 server.ts 路由时须同步改这里，见 AGENTS.md 开发约定）。
//
// 数据来源三部分（见 mock-data.js 头注）：fixtures.json（真实库导出的主播/关注/时间表
// 节选，随仓库发布）+ defaults.json（LLM/分类/推送规则的手工展示案例 = 首启默认值）
// + mock-data.js 手写设置卡片。夹具带 meta.exportedAt——demo 把页面时间冻结在导出
// 时刻渲染（freezeTime），哪天打开看到的都是导出瞬间的样子。
import * as M from './mock-data.js';
import { splitCsv } from '../js/core.js';

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
  biliAccounts: clone(fixtures?.biliAccounts ?? []),
  biliAccountSeq: (fixtures?.biliAccounts ?? []).length,
  biliPosts: clone(fixtures?.biliPosts ?? []),
  postRules: clone(M.mockPostRules),
  postRuleSeq: M.mockPostRules.length,
  twitterPosts: clone(M.mockTwitterPosts),
  postVerdicts: clone(M.mockPostVerdicts),
  pushEnabled: true,
  llmEnabled: true,
  undoHistory: clone(M.mockUndoHistory),
  chat: { mode: M.mockChat.mode, provider: M.mockChat.provider, messages: clone(M.mockChat.messages) },
  chatPending: null,   // 挂起的「等你确认」写操作（写前询问模式：确认后才回报已执行）
  biliLoggedIn: true,
  weiboLoggedIn: true,
  listenSettings: { dynamic: 'auto', weibo: 'auto', twitter: 'auto' },
  biliQrStep: 0,
  weiboQrStep: 0,
};

// 账号卡帖子段的帖子形状（与真实后端 accountPosts 同构）：Post + 该帖判定行 verdicts
// （键 = `platform:item_id`，字段 ruleId/ruleName/pass/evidence/source；无判定行 = 空数组）
const postView = (p) => ({
  ...clone(p),
  verdicts: clone(store.postVerdicts[p.platform + ':' + p.itemId] ?? []),
});

// demo 专用的额外供应商：Agent 卡的模型选择器要能演「自动路由 + 多选 + 停用项不出现在选项里」，
// 而 defaults.json 同时是**真实后端的首启种入信源**（构建期生成 onboarding-defaults.gen.ts），
// 故 demo 专用补充只加在这里，绝不改 defaults.json。第二条停用 = 演示「只列 enabled」。
store.llmProviders.push(
  {
    name: '本地 Ollama', baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b',
    vision: false, enabled: true, structuredOutput: 'none', api: 'chat-completions',
  },
  {
    name: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash',
    vision: false, enabled: false, structuredOutput: 'schema', api: 'chat-completions',
  },
);

// X 快照的时间戳也用冻结时刻（连接卡副行要显示「上次测试 x/x xx:xx」）
store.x.status.proxy.checkedAt = nowSec;
store.x.status.web.checkedAt = nowSec;
store.x.status.updatedAt = nowSec;
store.x.status.feed.lastRunAt = nowSec - 120;
store.x.status.feed.lastOkAt = nowSec - 120;
store.x.status.feed.linkDown = false;
for (const a of store.xAccounts) {
  if (a.lastTweetAt) a.lastTweetAt = nowSec - 4200;
  if (a.lastOkAt) a.lastOkAt = nowSec - 120;
  a.createdAt = nowSec;
  a.updatedAt = nowSec;
}
// 账号级抓取故障样例（长期问题不推送，只上账号卡）：第一个 X 账号标一个「账号不存在」
if (store.xAccounts[0]) {
  store.xAccounts[0].fetchFailSince = nowSec - 3600 * 26;
  store.xAccounts[0].fetchError = 'x.com 返回 404（账号不存在或已改名）';
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
// 微博帖子同样冻结（账号卡微博段显示「x 分钟前」读 pubTs）
for (const p of store.weiboPosts) {
  p.pubTs = nowSec - 2400 * p.id;
  p.createdAt = nowSec;
}
// B站动态名单与帖子同样用冻结时刻（账号卡副行「动态 x 小时前」读最近一条帖子的 pubTs）
for (const a of store.biliAccounts) {
  if (a.lastOkAt) a.lastOkAt = nowSec - 100;
  a.createdAt = nowSec;
  a.updatedAt = nowSec;
}
for (const p of store.biliPosts) {
  p.pubTs = nowSec - 2400 * p.id;
  p.createdAt = nowSec;
}
// 变更历史的 at 同样用冻结时刻（列表显示「x 分钟前」；偏移与 mockUndoHistory 顺序一一对应，恒新→旧；
// 最老一条落到昨天以演示按日分组）；已撤销条目的 undoneAt = 变更后 20 分钟
const undoAges = [40, 6 * 60, 22 * 60, 50 * 60, 3 * 3600, 30 * 3600];
store.undoHistory.forEach((c, i) => {
  c.at = nowSec - (undoAges[i] ?? 3600);
  if (c.undone) c.undoneAt = c.at + 1200;
});
// Agent 初始会话同样用冻结时刻（气泡显示「x 分钟前」；越靠后越新，偏移递减）
const chatAges = [600, 540, 300, 240, 235];
store.chat.messages.forEach((m, i) => { m.at = nowSec - (chatAges[i] ?? 60); });
// 消息 id 自增器：与真实后端 chat_messages.id 同语义（前端进行中轮询的增量去重键）
let chatSeq = store.chat.messages.reduce((max, m) => Math.max(max, m.id || 0), 0) + 1;
let callSeq = 100;   // 工具调用 id（种子消息用了 demo_call_1/2；前端只按字符串去重）

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
const ok = (obj) => json(200, obj);
const created = (obj) => json(201, obj);
const err = (status, msg) => json(status, { error: msg });

// ---- Agent 聊天剧本（demo 的 POST /api/chat：真实实现是多轮 LLM + 工具调用，这里按关键词回固定话术）----
// 返回 { reply, calls }：calls 与真实后端 ToolCallView 同构（demo 里手工拼，title 用真实工具中文名）。
// 三条剧本：
//   ① 含「撤销」→ 真把变更历史的栈顶标成已撤销 + undo_last_change 工具行
//   ② 含「推送」/「规则」→ 写前询问模式下先回确认话术并把这次写挂进 chatPending（用户回「确认/好」
//      才回「已执行」+ upsert 工具行，否则回「先不动」）；自动修改模式直接回「已执行」
//   ③ 缺省 → 查态剧本：两枚只读工具行（含一枚失败态）+ 全元素 markdown，专门用来验收渲染
// 变更记录的中文名一律读记录自带的 title（后端唯一信源，前端与 mock 都不再维护工具名映射）。
// 用量字段与真实后端同构：messages / chars 由当前会话算，needsResetHint 在 demo 里恒 false（正常值）
function demoCall(name, title, target, ok2, args, output) {
  return { id: 'demo_call_' + (++callSeq), name, title, target, ok: ok2, args, output };
}
const chatUsage = () => {
  let chars = 0;
  for (const m of store.chat.messages) chars += String(m.content || '').length;
  return { messages: store.chat.messages.length, chars, needsResetHint: false };
};
// 这条回复由谁提供：选定模型优先，'' = 自动路由 → 取第一个启用的供应商（无则 null，仿「LLM 全停用」）
function activeProviderName() {
  if (store.chat.provider) return store.chat.provider;
  const first = store.llmProviders.find((p) => p.enabled);
  return first ? first.name : null;
}
function chatScript(text) {
  if (store.chatPending) {
    const what = store.chatPending;
    store.chatPending = null;
    if (!/^(确认|好的|好|行|可以|ok|yes|是)/i.test(text)) {
      return { reply: '好，那我先不动。想改的时候再说具体改什么。', calls: [] };
    }
    return {
      reply: `已执行：${what}。（改动可在设置页「变更历史」撤销）`,
      calls: [demoCall('upsert_push_rule', '保存推送规则', '歌回', true,
        '{\n  "name": "歌回",\n  "channels": ["粉丝群"]\n}', '{\n  "ok": true\n}')],
    };
  }
  if (text.includes('撤销')) {
    const top = store.undoHistory.find((c) => !c.undone);
    if (!top) return { reply: '刚查了「变更历史」：没有可撤销的变更（栈是空的）。', calls: [] };
    undoRecord(top);   // 与 POST /api/undo 同一条路径：标已撤销 + 还原写前快照
    return {
      reply: `已撤销最近一次变更：${top.title || top.tool}` +
        `（${top.tables.length} 张表 · ${top.rows} 行）。\n这条记录已在设置页「变更历史」里标为已撤销。`,
      calls: [demoCall('undo_last_change', '撤销变更', '', true, '{}',
        `{\n  "undone": "${top.title || top.tool}"\n}`)],
    };
  }
  if (text.includes('推送') || text.includes('规则')) {
    const what = '把推送规则「歌回」的渠道改成只留「粉丝群」';
    if (store.chat.mode === 'ask') {
      store.chatPending = what;
      return {
        reply: `我先确认一下：要${what}吗？回「确认」我就写入。`,
        calls: [demoCall('list_push_rules', '列出推送规则', '', true, '{}',
          '{\n  "rules": [\n    { "name": "歌回", "channels": ["粉丝群", "私信"] }\n  ]\n}')],
      };
    }
    return {
      reply: `已执行：${what}。\n这次是「自动修改」模式直接写入的，改动记进「变更历史」，可撤销。`,
      calls: [demoCall('upsert_push_rule', '保存推送规则', '歌回', true,
        '{\n  "name": "歌回",\n  "channels": ["粉丝群"]\n}', '{\n  "ok": true\n}')],
    };
  }
  return {
    reply: '现在 **6 位**在播，按直播时长排：\n\n| 主播 | 分区 | 已播 |\n| --- | --- | --- |\n' +
      '| 阿梓从小就很可爱 | 虚拟主播 | 2:14 |\n| 七海 Nana7mi | 虚拟主播 | 1:03 |\n\n' +
      '- 微博图文 3 条归档未推（都在补推窗口外）\n- X 链路 `fallback-html` 正常\n\n' +
      '想改什么直接说，比如「把推送规则的渠道改一改」。',
    calls: [
      demoCall('get_live_now', '查看在播列表', '', true, '{}',
        '{\n  "live": [\n    { "uname": "阿梓从小就很可爱", "area": "虚拟主播", "minutes": 134 },\n    { "uname": "七海 Nana7mi", "area": "虚拟主播", "minutes": 63 }\n  ]\n}'),
      demoCall('search_posts', '搜索图文帖', '演唱会', false,
        '{\n  "query": "演唱会",\n  "limit": 5\n}', '错误：微博登录态失效，请到设置页重新扫码'),
    ],
  };
}

// ---- 配置写记账（demo 专用）：真实后端由写工具落变更记录（title / detail 都是服务端文案），
// demo 里没有工具层，故在 fetch 拦截器上补一层：写前快照 → 写成功则往历史头部插一条同构记录
// （带 title / detail / tables）并记下快照。有了它才演得出「改设置后历史立即多一条」与
// 「撤销后页面状态还原」（撤销 = 还原快照，且返回 title / refill）。
const undoReverts = new Map();   // 记录 id → 写前快照（只在撤销时用，不上交换面）
let undoSeq = 100;              // 新记录 id 从 100 起（种子是 1~6，保持「新→旧 = id 降序」成立）
const undoAt = () => Math.floor(Date.now() / 1000);

// 参与快照的状态切片（与真实后端 DEFAULT_CONFIG_TABLES 对应的那几张表 + 开关）
const SNAPSHOT_KEYS = [
  'channels', 'categories', 'rules', 'postRules', 'streamers', 'xAccounts',
  'weiboAccounts', 'biliAccounts', 'llmProviders', 'pushEnabled', 'llmEnabled',
  'listenSettings', 'napcat', 'x',
];
function snapshotStore() {
  const snap = {};
  for (const k of SNAPSHOT_KEYS) snap[k] = clone(store[k]);
  // agent 会话设置（写模式 / 选定模型）单独一份：它们也是配置写（后端 set_chat_mode /
  // set_chat_provider 进变更历史），但**消息不参与回滚**——撤销一次模型切换不该吞掉之后的对话
  snap.chatSettings = { mode: store.chat.mode, provider: store.chat.provider };
  return snap;
}
function restoreStore(snap) {
  for (const k of SNAPSHOT_KEYS) if (snap[k] !== undefined) store[k] = clone(snap[k]);
  if (snap.chatSettings) {
    store.chat.mode = snap.chatSettings.mode;
    store.chat.provider = snap.chatSettings.provider;
  }
}
/** 撤销一条记录：标已撤销 + 撤销时刻（与真实后端的 undoneAt 同语义）+（新记录才有）还原写前快照 */
function undoRecord(rec) {
  rec.undone = true;
  rec.undoneAt = Math.floor(Date.now() / 1000);
  const snap = undoReverts.get(rec.id);
  if (snap) { restoreStore(snap); undoReverts.delete(rec.id); }
}
const refillNames = () => store.llmProviders.filter((p) => p.enabled).map((p) => p.name);

/** 写路径 → 记录文案（demo 口径：够读即可，真实文案由后端工具给；形状 = 新契约 headline + changes） */
function writeMeta(method, path, b) {
  const del = method === 'DELETE';
  const upd = { action: 'updated' };
  if (path === '/api/llm/enabled') {
    return { tool: 'set_llm_enabled', title: '开关 LLM', headline: b.enabled ? '开启了 LLM 总开关' : '关闭了 LLM 总开关', tables: ['settings'],
      detail: [{ label: 'LLM 总开关', ...upd, changes: [{ field: 'LLM 总开关', from: b.enabled ? '关' : '开', to: b.enabled ? '开' : '关', bool: true }] }] };
  }
  if (path === '/api/llm/providers/order') {
    return { tool: 'reorder_llm_providers', title: '调整供应商顺序', headline: '调整了 LLM 供应商顺序', tables: ['settings'],
      detail: [{ label: 'LLM 供应商名单', ...upd, changes: [{ field: 'LLM 供应商名单', to: '顺序已调整' }] }] };
  }
  if (path === '/api/llm/providers' || /^\/api\/llm\/providers\/[^/]+$/.test(path)) {
    const name = path === '/api/llm/providers' ? b.name : decodeURIComponent(path.split('/').pop());
    const withKey = !del && !!(b.key && String(b.key).trim());
    return {
      tool: del ? 'delete_llm_provider' : 'upsert_llm_provider',
      title: del ? '删除 LLM 供应商' : (path === '/api/llm/providers' ? '新增 LLM 供应商' : '保存 LLM 供应商'),
      headline: del ? `删除了 LLM 供应商「${name}」` : (path === '/api/llm/providers' ? `新增了 LLM 供应商「${name}」` : `修改了 LLM 供应商「${name}」`),
      tables: ['settings'],
      detail: [{ label: `供应商「${name}」`, action: del ? 'deleted' : (path === '/api/llm/providers' ? 'created' : 'updated'),
        changes: withKey ? [{ field: 'API key', redacted: true }] : [] }],
      // 填了 key 的写：撤销 = 清空密钥需重填（与后端 undoNote 同语义）
      undoNote: withKey ? 'refill' : undefined,
      refill: withKey ? [name] : undefined,
    };
  }
  if (path === '/api/advanced') {
    return { tool: 'update_runtime_config', title: '修改运行时参数', headline: '修改了运行时参数', tables: ['settings'],
      detail: [{ label: '运行时参数', ...upd, changes: [] }] };
  }
  if (path === '/api/chat/mode') {
    return { tool: 'set_chat_mode', title: '设置写模式', headline: '设置了 Agent 写模式', tables: ['settings'],
      detail: [{ label: 'Agent 写模式', ...upd, changes: [{ field: 'Agent 写模式', to: b.mode === 'auto' ? '自动（直接写）' : '写前询问' }] }] };
  }
  if (path === '/api/chat/provider') {
    return { tool: 'set_chat_provider', title: '选择 Agent 模型', headline: '选择了 Agent 模型', tables: ['settings'],
      detail: [{ label: 'Agent 模型选择', ...upd, changes: [{ field: 'Agent 模型选择', to: b.provider || '自动路由' }] }] };
  }
  if (path === '/api/push/enabled') {
    return { tool: 'set_push_enabled', title: '开关推送', headline: b.enabled ? '开启了推送总开关' : '关闭了推送总开关', tables: ['settings'],
      detail: [{ label: '推送总开关', ...upd, changes: [{ field: '推送总开关', from: b.enabled ? '关' : '开', to: b.enabled ? '开' : '关', bool: true }] }] };
  }
  if (path === '/api/napcat') {
    return { tool: 'update_napcat', title: '修改 NapCat 配置', headline: '修改了 NapCat 配置', tables: ['settings'],
      detail: [{ label: 'NapCat 连接', ...upd, changes: [] }] };
  }
  if (path === '/api/x') {
    return { tool: 'update_x_config', title: '修改 X 连接设置', headline: '修改了 X 连接设置', tables: ['settings'],
      detail: [{ label: 'X 连接', ...upd, changes: [] }] };
  }
  const lm = path.match(/^\/api\/listen\/(dynamic|weibo|twitter)$/);
  if (lm) {
    const plat = { dynamic: 'B站动态', weibo: '微博', twitter: 'X' }[lm[1]];
    return { tool: 'set_listen', title: '监听开关', headline: b.enabled ? `开启了${plat}监听开关` : `关闭了${plat}监听开关`, tables: ['settings'],
      detail: [{ label: `${plat}监听开关`, ...upd, changes: [{ field: `${plat}监听开关`, from: b.enabled ? '关' : '开', to: b.enabled ? '开' : '关', bool: true }] }] };
  }
  // 四类 CRUD 家族：渠道 / 分类 / 推送规则 / 图文规则 / 三张账号名单，形状一致
  const fam = [
    { re: /^\/api\/channels(?:\/(\d+))?$|^\/api\/channels\/order$/, table: 'push_channels', noun: '推送渠道', names: ['新增推送渠道', '保存推送渠道', '删除推送渠道'] },
    { re: /^\/api\/categories(?:\/(\d+))?$|^\/api\/categories\/order$/, table: 'categories', noun: '分类', names: ['保存分类', '保存分类', '删除分类'] },
    { re: /^\/api\/rules(?:\/(\d+))?$|^\/api\/rules\/order$/, table: 'push_rules', noun: '推送规则', names: ['保存推送规则', '保存推送规则', '删除推送规则'] },
    { re: /^\/api\/post-rules(?:\/(\d+))?$|^\/api\/post-rules\/order$/, table: 'post_rules', noun: '图文规则', names: ['保存图文规则', '保存图文规则', '删除图文规则'] },
    { re: /^\/api\/x\/accounts(?:\/(\d+))?$/, table: 'x_accounts', noun: 'X 账号', names: ['保存 X 账号', '保存 X 账号', '删除 X 账号'] },
    { re: /^\/api\/weibo\/accounts(?:\/(\d+))?$/, table: 'weibo_accounts', noun: '微博账号', names: ['保存微博账号', '保存微博账号', '删除微博账号'] },
    { re: /^\/api\/bili\/accounts(?:\/(\d+))?$/, table: 'bili_accounts', noun: 'B站动态账号', names: ['保存B站动态账号', '保存B站动态账号', '删除B站动态账号'] },
  ];
  for (const f of fam) {
    if (!f.re.test(path)) continue;
    if (path.endsWith('/order')) {
      return { tool: 'reorder', title: `调整${f.noun}顺序`, headline: `调整了${f.noun}顺序`, tables: [f.table],
        detail: [{ label: `${f.noun}顺序`, ...upd, changes: [{ field: `${f.noun}顺序`, to: '已调整' }] }] };
    }
    const id = path.match(/\/(\d+)$/)?.[1];
    const tool = del ? 'delete' : (method === 'POST' ? 'upsert_new' : 'upsert');
    const name = b.nickname || b.screenName || b.alias || b.name || (id ? '#' + id : '');
    return {
      tool: `${tool}_${f.table}`,
      title: f.names[del ? 2 : (method === 'POST' ? 0 : 1)],
      headline: del ? `删除了${f.noun}「${name}」` : (method === 'POST' ? `新增了${f.noun}「${name}」` : `修改了${f.noun}「${name}」`),
      tables: [f.table],
      detail: [{ label: `${f.noun}「${name}」`,
        action: del ? 'deleted' : (method === 'POST' ? 'created' : 'updated'),
        changes: [] }],
    };
  }
  const watch = path.match(/^\/api\/streamers\/([^/]+)(\/watch)?$/);
  if (watch) {
    const uid = decodeURIComponent(watch[1]);
    const add = method === 'POST' && !!watch[2];
    return {
      tool: add ? 'watch_streamer' : 'set_streamer',
      title: add ? '加入监听' : (b.watch === false ? '取消监听' : '修改主播设置'),
      headline: add ? `开始监听主播 ${uid}` : (b.watch === false ? `停止监听主播 ${uid}` : `修改了主播 ${uid} 的设置`),
      tables: ['streamers'],
      detail: [{ label: `主播 ${uid}`, action: 'updated', changes: [] }],
    };
  }
  // 未覆盖的写：不猜语义，只记一条能读的记录（真实后端不会走到这里）
  return { tool: 'unknown_write', title: '修改设置', headline: '修改了设置', tables: ['settings'],
    detail: [{ label: method + ' ' + path, ...upd, changes: [] }] };
}

/** 写成功后往历史头部插一条同构记录（顺序 = 新→旧） */
function recordWrite(method, path, rawBody, snap) {
  let b = {};
  try { b = JSON.parse(rawBody || '{}'); } catch { /* 非 JSON body */ }
  const meta = writeMeta(method, path, b);
  const rec = {
    id: ++undoSeq, tool: meta.tool, entry: 'panel', actor: 'panel', scope: 'admin',
    at: undoAt(), undone: false, undoneAt: null,
    tables: meta.tables, rows: meta.detail.length,
    title: meta.title, headline: meta.headline ?? meta.title, detail: meta.detail,
    ...(meta.undoNote ? { undoNote: meta.undoNote } : {}),
  };
  store.undoHistory.unshift(rec);
  undoReverts.set(rec.id, snap);
}

// demo 里触发联动刷新的写白名单（与 webui/js/core.js 的 CONFIG_WRITE_PREFIXES 同口径——
// 前端只在配置写成功后刷变更历史，mock 也只在配置写成功后记一条，两边才不会打架）。
// 注意 /api/chat 只列 mode / provider 两条真配置写（都进变更历史），聊天回合与 reset 不算。
const MOCK_WRITE_PREFIXES = [
  '/api/llm', '/api/advanced', '/api/categories', '/api/rules', '/api/channels',
  '/api/post-rules', '/api/streamers', '/api/follows', '/api/listen', '/api/push',
  '/api/x', '/api/weibo', '/api/bili', '/api/napcat', '/api/chat/mode', '/api/chat/provider',
];
function isMockConfigWrite(method, path) {
  if (!method || method.toUpperCase() === 'GET') return false;
  if (path.includes('/test') || path === '/api/napcat/launch') return false;
  return MOCK_WRITE_PREFIXES.some((p) => path === p || path.startsWith(p + '/'));
}

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

  // ---- 图文帖规则（X/推特 + 微博 + B站动态共用；与推送规则平行的另一张表）----
  // 规则平台无关（无 platform 字段，传入按未知字段 400）、不带账号 scope——
  // 账号侧用 ruleIds 选用（账号 POST/PUT 只校验规则存在，任何账号可选用任何规则）。
  const checkPostRule = (b, rule) => {
    if (b.platform !== undefined) return { error: '未知字段: platform（图文规则已平台无关）' };
    const filters = Object.assign(
      { original: true, retweet: false, quote: false, media: false, keywords: [] },
      rule ? rule.filters : {}, b.filters || {},
    );
    if (!filters.original && !filters.retweet) {
      return { error: '「原创」与「转发」至少要勾一个，否则这条规则永远不会命中' };
    }
    const judge = b.llmJudge !== undefined ? b.llmJudge === true : (rule ? rule.llmJudge : false);
    const prompt = b.judgePrompt !== undefined ? b.judgePrompt : (rule ? rule.judgePrompt : null);
    if (judge && !String(prompt || '').trim()) return { error: '开启「LLM 判定」必须填判定提示词' };
    if (Array.isArray(b.channels) && b.channels.some((id) => !store.channels.some((c) => c.id === id))) {
      return { error: '渠道不存在' };
    }
    return { filters };
  };
  // 账号 ruleIds 校验：只校验规则存在（规则平台无关，不再校验平台一致）
  const checkRuleIds = (ids) =>
    Array.isArray(ids) && ids.every((id) => store.postRules.some((r) => r.id === id));

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
      channels: b.channels || [], filters: c.filters,
      messageTemplate: b.messageTemplate ?? null,
      llmJudge: b.llmJudge === true,
      judgePrompt: b.judgePrompt ?? null,
      llmTranslate: b.llmTranslate === true,
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
        if (b.channels !== undefined) rule.channels = b.channels;
        rule.filters = c.filters;
        if (b.llmJudge !== undefined) rule.llmJudge = b.llmJudge === true;
        if (b.judgePrompt !== undefined) rule.judgePrompt = b.judgePrompt;
        if (b.llmTranslate !== undefined) rule.llmTranslate = b.llmTranslate === true;
        if (b.messageTemplate !== undefined) rule.messageTemplate = b.messageTemplate;
        if (typeof b.enabled === 'boolean') rule.enabled = b.enabled;
        rule.updatedAt = nowSec;
        return ok({ ok: true });
      }
      if (method === 'DELETE') {
        store.postRules = store.postRules.filter((r) => r.id !== rule.id);
        // 选用关系一并去掉（账号 ruleIds 不残留已删规则的 id）
        for (const list of [store.xAccounts, store.weiboAccounts, store.biliAccounts]) {
          for (const a of list) a.ruleIds = (a.ruleIds || []).filter((id) => id !== rule.id);
        }
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
      .map(postView);
    return { ...clone(a), biliName: bili ? (bili.alias || bili.uname || String(a.biliUid)) : null, biliFace: bili ? (bili.face ?? null) : null, posts };
  };
  if (path === '/api/x/accounts' && method === 'GET') {
    return ok({ accounts: store.xAccounts.map(xAccountView) });
  }
  if (path === '/api/x/accounts' && method === 'POST') {
    const b = body();
    // 与真实后端 parseNewXAccount 同构：昵称不收（平台事实——verify 种入 / 抓取回写）
    if (b.nickname !== undefined) return json(400, { error: '未知字段: nickname' });
    const screenName = String(b.screenName || '').trim().replace(/^@+/, '').toLowerCase();
    if (!/^[a-z0-9_]{1,15}$/.test(screenName)) return json(400, { error: 'X 账号格式不对（字母 / 数字 / 下划线，1~15 位）' });
    if (store.xAccounts.some((a) => a.screenName === screenName)) return json(409, { error: `@${screenName} 已在名单里` });
    // 演示口径：名单里已有 3 个 + nhk_news 算「存在」，其余给「账号不存在」，便于看 400 那条路
    const known = ['watase_yuzuki', 'hololive_en', 'nhk_news'].includes(screenName);
    if (!known) return json(400, { error: `X 账号不存在：@${screenName}` });
    if (b.biliUid != null && !store.streamers.some((s) => String(s.uid) === String(b.biliUid))) {
      return json(400, { error: `关联主播不在监听名单: ${b.biliUid}` });
    }
    if (b.ruleIds !== undefined && !checkRuleIds(b.ruleIds)) {
      return json(400, { error: '规则不存在' });
    }
    // 演示的 verify 显示名（真实后端从 og:title 抠出，种进 nickname）
    const demoNames = { watase_yuzuki: '渡瀬 結月', hololive_en: 'hololive English', nhk_news: 'NHKニュース' };
    const row = {
      id: ++store.xAccountSeq, screenName, nickname: demoNames[screenName] || null,
      displayName: b.displayName ? String(b.displayName) : null,
      biliUid: b.biliUid ? String(b.biliUid) : null, enabled: b.enabled !== false,
      ruleIds: (b.ruleIds || []).map(Number),
      lastTweetId: null, lastTweetAt: null, lastOkAt: null, avatar: null,
      fetchFailSince: null, fetchError: null, createdAt: nowSec, updatedAt: nowSec,
    };
    store.xAccounts.push(row);
    return ok({ account: xAccountView(row), verify: { checked: true, ok: true, kind: 'ok', name: demoNames[screenName] || null, message: `账号存在（页面含 7 条推文）` } });
  }
  {
    const xa = path.match(/^\/api\/x\/accounts\/(\d+)$/);
    if (xa && method === 'PUT') {
      const row = store.xAccounts.find((a) => a.id === Number(xa[1]));
      if (!row) return json(404, { error: 'X 账号不存在' });
      const b = body();
      // 与真实后端 parseXAccountPatch 同构：ID 与昵称是平台事实不可改（未知字段 400）
      if (b.screenName !== undefined) return json(400, { error: '未知字段: screenName' });
      if (b.nickname !== undefined) return json(400, { error: '未知字段: nickname' });
      if (b.biliUid !== undefined && b.biliUid !== null
        && !store.streamers.some((s) => String(s.uid) === String(b.biliUid))) {
        return json(400, { error: `关联主播不在监听名单: ${b.biliUid}` });
      }
      if (b.displayName !== undefined) row.displayName = b.displayName === null ? null : String(b.displayName);
      if (b.biliUid !== undefined) row.biliUid = b.biliUid === null ? null : String(b.biliUid);
      if (typeof b.enabled === 'boolean') row.enabled = b.enabled;
      if (b.ruleIds !== undefined) {
        if (!checkRuleIds(b.ruleIds)) return json(400, { error: '规则不存在' });
        row.ruleIds = b.ruleIds.map(Number);
      }
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
      store.x.config.instances = splitCsv(b.instances);
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
  // 契约与真实后端 /api/weibo* 同构：uid 与昵称二选一（只填昵称 → 演示口径固定解析成 1158211483）
  const weiboAccountView = (a) => {
    const bili = a.biliUid != null
      ? store.streamers.find((s) => String(s.uid) === String(a.biliUid)) : null;
    const posts = store.weiboPosts
      .filter((p) => p.uid === a.uid)
      .sort((x2, y2) => y2.pubTs - x2.pubTs)
      .slice(0, 3)
      .map(postView);
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
  // 昵称 ↔ uid 即时互查（与真实后端同构；演示口径：名单里的账号 + 「阿梓」可解析，其余 404）
  if (path === '/api/weibo/resolve' && method === 'GET') {
    const nick = (q.get('nick') || '').trim();
    const uidRaw = (q.get('uid') || '').trim();
    if (nick) {
      const hit = store.weiboAccounts.find((a) => a.nickname === nick);
      if (hit) return ok({ uid: hit.uid, nickname: nick });
      if (nick === '阿梓从小就很可爱' || nick === '阿梓') return ok({ uid: '2203177060', nickname: nick });
      return json(404, { error: `微博上找不到这个昵称：${nick}` });
    }
    if (uidRaw) {
      const hit = store.weiboAccounts.find((a) => a.uid === uidRaw);
      if (hit) return ok({ uid: uidRaw, nickname: hit.nickname });
      if (uidRaw === '2203177060') return ok({ uid: uidRaw, nickname: '阿梓从小就很可爱' });
      return json(404, { error: `微博上找不到这个 uid：${uidRaw}` });
    }
    return json(400, { error: 'nick 与 uid 至少给一个' });
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
    // 与真实后端 normalizeWeiboUid 同构：可粘贴 weibo.com/u/<uid> 主页链接
    const uidFromUrl = uid.match(/weibo\.com\/(?:u\/)?(\d+)/);
    if (uidFromUrl) uid = uidFromUrl[1];
    if (!uid) return json(400, { error: 'uid 与昵称至少填一个' });
    if (!/^\d{1,20}$/.test(uid)) return json(400, { error: '微博 uid 必须是数字（可从 weibo.com/u/<uid> 复制）' });
    if (store.weiboAccounts.some((a) => a.uid === uid)) return json(409, { error: `微博 ${uid} 已在名单里` });
    if (b.biliUid != null && !store.streamers.some((s) => String(s.uid) === String(b.biliUid))) {
      return json(400, { error: `关联主播不在监听名单: ${b.biliUid}` });
    }
    if (b.ruleIds !== undefined && !checkRuleIds(b.ruleIds)) {
      return json(400, { error: '规则不存在' });
    }
    const row = {
      id: ++store.weiboAccountSeq, uid, nickname, displayName: b.displayName ? String(b.displayName) : null,
      biliUid: b.biliUid ?? null,
      enabled: b.enabled !== false, ruleIds: (b.ruleIds || []).map(Number),
      lastPostId: null, lastPostAt: null, lastOkAt: null,
      avatar: null, fetchFailSince: null, fetchError: null, createdAt: nowSec, updatedAt: nowSec,
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
        // 与真实后端 parseWeiboAccountPatch 同构：uid 与昵称是平台事实不可改（未知字段 400）
        if (b.uid !== undefined) return json(400, { error: '未知字段: uid' });
        if (b.nickname !== undefined) return json(400, { error: '未知字段: nickname' });
        if (b.biliUid !== undefined && b.biliUid !== null
          && !store.streamers.some((s) => String(s.uid) === String(b.biliUid))) {
          return json(400, { error: `关联主播不在监听名单: ${b.biliUid}` });
        }
        if (b.displayName !== undefined) row.displayName = b.displayName;
        if (b.biliUid !== undefined) row.biliUid = b.biliUid;
        if (typeof b.enabled === 'boolean') row.enabled = b.enabled;
        if (b.ruleIds !== undefined) {
          if (!checkRuleIds(b.ruleIds)) return json(400, { error: '规则不存在' });
          row.ruleIds = b.ruleIds.map(Number);
        }
        row.updatedAt = nowSec;
        return ok({ account: weiboAccountView(row) });
      }
      if (method === 'DELETE') {
        store.weiboAccounts = store.weiboAccounts.filter((a) => a.id !== row.id);
        return ok({ ok: true });
      }
    }
  }

  // ---- B站动态（图文分页第三个来源）：独立名单 CRUD，与 weibo 同构 ----
  // uid 支持粘贴 space.bilibili.com 链接（归一化成纯数字）；头像文件名走 /api/bili-avatar
  // （demo 下图片不经本拦截器，dev 静态服映射到 data/cache/bili-avatars，无缓存则前端兜底占位圆）
  const biliAccountView = (a) => {
    const posts = store.biliPosts
      .filter((p) => p.uid === a.uid)
      .sort((x2, y2) => y2.pubTs - x2.pubTs)
      .slice(0, 3)
      .map(postView);
    return { ...clone(a), posts };
  };
  if (path === '/api/bili/accounts' && method === 'GET') {
    return ok({ accounts: store.biliAccounts.map(biliAccountView) });
  }
  if (path === '/api/bili/accounts' && method === 'POST') {
    const b = body();
    // 与真实后端 parseNewBiliAccount 同构：uname 是平台事实（抓取回写），不收
    if (b.uname !== undefined) return json(400, { error: '未知字段: uname' });
    const raw = String(b.uid || '').trim();
    const m = raw.match(/space\.bilibili\.com\/(\d+)/);
    const uid = m ? m[1] : raw;
    if (!/^\d{1,20}$/.test(uid)) return json(400, { error: 'uid 必须是数字（可粘贴 space.bilibili.com/<uid> 链接）' });
    if (store.biliAccounts.some((a) => a.uid === uid)) return json(409, { error: `uid ${uid} 已在名单里` });
    if (b.ruleIds !== undefined && !checkRuleIds(b.ruleIds)) {
      return json(400, { error: '规则不存在' });
    }
    const row = {
      id: ++store.biliAccountSeq, uid, uname: null,
      displayName: b.displayName ? String(b.displayName) : null,
      enabled: b.enabled !== false, ruleIds: (b.ruleIds || []).map(Number),
      lastOkAt: null, avatar: null, fetchFailSince: null, fetchError: null, createdAt: nowSec, updatedAt: nowSec,
    };
    store.biliAccounts.push(row);
    return ok({ account: biliAccountView(row) });
  }
  {
    const ba = path.match(/^\/api\/bili\/accounts\/(\d+)$/);
    if (ba) {
      const row = store.biliAccounts.find((a) => a.id === Number(ba[1]));
      if (!row) return json(404, { error: 'B站动态账号不存在' });
      if (method === 'PUT') {
        const b = body();
        // 与真实后端 parseBiliAccountPatch 同构：uid 是身份锚点、uname 是平台事实，都不可改
        if (b.uid !== undefined) return json(400, { error: '未知字段: uid' });
        if (b.uname !== undefined) return json(400, { error: '未知字段: uname' });
        if (b.displayName !== undefined) row.displayName = b.displayName;
        if (typeof b.enabled === 'boolean') row.enabled = b.enabled;
        if (b.ruleIds !== undefined) {
          if (!checkRuleIds(b.ruleIds)) return json(400, { error: '规则不存在' });
          row.ruleIds = b.ruleIds.map(Number);
        }
        row.updatedAt = nowSec;
        return ok({ account: biliAccountView(row) });
      }
      if (method === 'DELETE') {
        store.biliAccounts = store.biliAccounts.filter((a) => a.id !== row.id);
        return ok({ ok: true });
      }
    }
  }

  if (path === '/api/x/test' && method === 'POST') {
    const b = body();
    const target = b.target || 'all';
    const proxyUrl = typeof b.proxyUrl === 'string' && b.proxyUrl ? b.proxyUrl : store.x.config.proxyUrl;
    const hosts = typeof b.instances === 'string' && b.instances
      ? splitCsv(b.instances)
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
      || splitCsv(String(b.instances)).join(',') === store.x.config.instances.join(',');
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

  // ---- 变更历史与撤销（P0b 撤销的用户面）：与 /api/undo* 逐字同构 ----
  // 历史新→旧全量（只标 undone 不删行）；POST /api/undo 撤「最新一条未撤销的」（mock 只演成功路径：
  // 点撤销把栈顶标 undone + 还原写前快照，并回 title / refill 两个新字段；把记录都撤完后再点已无按钮，
  // 符合空栈 404 语义）。refill 只在记录带 undoNote='refill' 时回，值为需重填的 provider 名。
  if (path === '/api/undo/history' && method === 'GET') {
    return ok({ changes: store.undoHistory });
  }
  if (path === '/api/undo' && method === 'POST') {
    const top = store.undoHistory.find((c) => !c.undone);
    if (!top) return err(404, '没有可撤销的变更');
    undoRecord(top);
    const refill = top.undoNote === 'refill' ? refillNames() : undefined;
    return ok({
      ok: true, change: { id: top.id, tool: top.tool }, title: top.title || top.tool,
      ...(refill ? { refill } : {}),
    });
  }

  // ---- Agent 聊天（P1 前端聊天视图）：与真实后端 /api/chat* 逐字同构 ----
  // 会话在 mock 内存里演进（history 返回它，reset 清空；UI 不缓存），回复逻辑 = 上面的 chatScript。
  // provider：history 回**当前选定**（'' = 自动路由），assistant 消息各带**自己那条**的归属，POST 回本次实际回答者。
  if (path === '/api/chat/history' && method === 'GET') {
    return ok({
      messages: clone(store.chat.messages), mode: store.chat.mode,
      provider: store.chat.provider, usage: chatUsage(),
    });
  }
  if (path === '/api/chat' && method === 'POST') {
    const text = String(body().message || '').trim();
    if (!text) return json(400, { error: '消息不能为空' });
    const at = Math.floor(Date.now() / 1000);
    store.chat.messages.push({ id: chatSeq++, role: 'user', content: text, at, provider: null });
    const out = chatScript(text);
    const provider = activeProviderName();
    // 工具调用与终答分两条落库（中间轮 content 为空、只带 calls），与真实后端的回放形状一致
    if (out.calls.length) {
      store.chat.messages.push({ id: chatSeq++, role: 'assistant', content: '', at, provider, calls: out.calls });
    }
    store.chat.messages.push({ id: chatSeq++, role: 'assistant', content: out.reply, at, provider });
    return ok({ ok: true, reply: out.reply, provider, usage: chatUsage(), calls: out.calls });
  }
  if (path === '/api/chat/reset' && method === 'POST') {
    store.chat.messages = [];
    store.chatPending = null;
    return ok({ ok: true });
  }
  if (path === '/api/chat/mode' && method === 'PUT') {
    const m = body().mode;
    if (m !== 'ask' && m !== 'auto') return json(400, { error: 'mode 必须是 ask 或 auto' });
    store.chat.mode = m;
    return ok({ ok: true, mode: m });
  }
  if (path === '/api/chat/provider' && method === 'PUT') {
    const p = body().provider;
    if (typeof p !== 'string') return json(400, { error: 'provider 必须是字符串' });
    if (p !== '' && !store.llmProviders.some((x) => x.name === p)) {
      return json(400, { error: `provider 不存在: ${p}` });
    }
    store.chat.provider = p;
    return ok({ ok: true, provider: p });
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
    const run = () => {
      // 配置写：写前留一张快照，写成功则记一条变更历史（撤销时还原它）——见上面「配置写记账」
      const snap = isMockConfigWrite(method, u.pathname) ? snapshotStore() : null;
      const res = handle(method, u.pathname, u.searchParams, rawBody);
      if (snap && res && res.status < 300) recordWrite(method, u.pathname, rawBody, snap);
      return res;
    };
    // 发消息是唯一「慢」的路由（真实实现是多轮 LLM + 工具调用）：延迟一下再回，
    // 让 UI 的在途态（输入框禁用 + 「思考中」气泡）在 demo 里真的看得见；其余路由立即返回。
    if (u.pathname === '/api/chat' && method === 'POST') {
      return new Promise((resolve) => setTimeout(() => resolve(run()), 700));
    }
    return Promise.resolve(run());
  }
  return realFetch(input, init);
};
