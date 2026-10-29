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
// 主分类组（primary）是分类自身的字段：defaults.json 同时是首启默认值的源、不能塞 demo 专用值，
// 故进来后在下面按名单补标——demo 需要主分类组非空，时间表 hover 与内容记录才有主分类可展示。
const DEMO_PRIMARY = new Set(['歌回', '带图原创']);
const demoCategories = (defaults?.categories ?? []).map((c, i) => ({
  id: i + 1, name: c.name, judgeMode: c.judgeMode === 'precise' ? 'precise' : 'simple',
  llmPrompt: c.llmPrompt ?? null, judgeConditions: clone(c.judgeConditions ?? []),
  keywords: c.keywords ?? [], areas: c.areas ?? [],
  appliesTo: 'live', postTypes: [], requireQuote: false, requireMedia: false,
  condMode: c.condMode ?? 'and', primary: DEMO_PRIMARY.has(c.name),
  enabled: true, createdAt: nowSec, updatedAt: nowSec,
})).concat([
  // 直播分类补充（判定描述 + 确定性条件各一档，主分类组只放歌回）
  {
    id: 2, name: '杂谈', llmPrompt: '以聊天为主的直播，典型特征是画面没有游戏或歌词，主播在看弹幕或念留言',
    keywords: ['杂谈', '聊天'], areas: [], appliesTo: 'live', postTypes: [],
    requireQuote: false, requireMedia: false, condMode: 'or', primary: false,
    enabled: true, createdAt: nowSec, updatedAt: nowSec,
  },
  // 图文分类（判定口径上移进分类：原图文规则的 filters/judgePrompt）
  {
    id: 101, name: '带图原创', llmPrompt: '只推与直播预告、新曲发布相关的推文',
    keywords: [], areas: [], appliesTo: 'post', postTypes: ['original'],
    requireQuote: false, requireMedia: true, condMode: 'and', primary: DEMO_PRIMARY.has('带图原创'),
    enabled: true, createdAt: nowSec, updatedAt: nowSec,
  },
  {
    id: 102, name: '转发/live', llmPrompt: null,
    keywords: ['live'], areas: [], appliesTo: 'post', postTypes: ['retweet'],
    requireQuote: false, requireMedia: false, condMode: 'and', primary: false,
    enabled: true, createdAt: nowSec, updatedAt: nowSec,
  },
  {
    id: 103, name: '预告词', llmPrompt: null,
    keywords: ['预告', '直播'], areas: [], appliesTo: 'post', postTypes: ['original'],
    requireQuote: false, requireMedia: false, condMode: 'and', primary: false,
    enabled: true, createdAt: nowSec, updatedAt: nowSec,
  },
]);
demoCategories.forEach(function (category) {
  category.judgeMode = category.judgeMode === 'precise' ? 'precise' : 'simple';
  category.judgeConditions = Array.isArray(category.judgeConditions) ? category.judgeConditions : [];
});
const catIdByName = new Map(demoCategories.map((c) => [c.name, c.id]));
const allChannelIds = M.mockChannels.map((c) => c.id);
const demoRules = (defaults?.rules ?? []).map((r, i) => ({
  id: i + 1, name: r.name, subjectKind: 'live',
  categoryId: r.category != null ? (catIdByName.get(r.category) ?? null) : null,
  scope: [], channels: [...allChannelIds],
  messageTemplate: r.messageTemplate ?? null, llmTranslate: false,
  enabled: true, createdAt: nowSec, updatedAt: nowSec,
})).concat(clone(M.mockPostRules));
// demo 专用补充：一条「指定了主播」的开播规则（scope 非空），让主播卡/规则卡能演
// allScope=false 的 hover 提示与范围标签（与真实后端 listPushRules 同形状）
demoRules.push({
  id: 900, name: '仅第一位主播', subjectKind: 'live', categoryId: null,
  scope: [String(clone(fixtures?.streamers ?? [])[0]?.uid ?? '')].filter(Boolean),
  channels: [2], messageTemplate: null, llmTranslate: false,
  enabled: true, sort: demoRules.length, createdAt: nowSec, updatedAt: nowSec,
});

// ---- 内存库（深拷贝种子，本会话可改）----
const store = {
  streamers: clone(fixtures?.streamers ?? []),
  follows: clone(fixtures?.follows ?? []),
  // 夹具是真实库导出（可能早于主分类契约）：缺 primary 时按主分类组里首个属于的 verdict 推一个，与后端确定性主分类同口径；
  // 缺 classificationRuns（多时机历史是后加的）时把最新的 verdicts/primary 包成一条开播轮次，
  // 让时间表 hover 的分类区在旧夹具上也有可用的时间轴。
  schedule: clone(fixtures?.schedule ?? []).map(function (entry) {
    const hit = (entry.verdicts || []).find(function (v) { return DEMO_PRIMARY.has(v.categoryName); });
    const primary = entry.primary !== undefined
      ? entry.primary
      : (hit ? { categoryName: hit.categoryName, source: hit.source } : null);
    const runs = Array.isArray(entry.classificationRuns) ? entry.classificationRuns : [{
      triggerKind: 'start', ts: entry.startTs,
      verdicts: entry.verdicts || [],
      primary: primary
        ? {
          categoryId: catIdByName.get(primary.categoryName) ?? 0,
          categoryName: primary.categoryName, source: primary.source,
        }
        : null,
    }];
    return { ...entry, primary, classificationRuns: runs };
  }),
  channels: clone(M.mockChannels),
  categories: demoCategories,
  rules: demoRules,
  llmProviders: clone(defaults?.llmProviders ?? []),
  decisionProviders: clone(defaults?.decisionProviders ?? []),
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
  twitterPosts: clone(M.mockTwitterPosts),
  postVerdicts: clone(M.mockPostVerdicts),
  pushEnabled: true,
  llmEnabled: true,
  decisionEnabled: true,
  undoHistory: clone(M.mockUndoHistory),
  chat: { mode: M.mockChat.mode, provider: M.mockChat.provider, messages: clone(M.mockChat.messages) },
  chatPending: null,   // 挂起的「等你确认」写操作（写前询问模式：确认后才回报已执行）
  biliLoggedIn: true,
  weiboLoggedIn: true,
  listenSettings: { dynamic: 'auto', weibo: 'auto', twitter: 'auto' },
  biliQrStep: 0,
  weiboQrStep: 0,
};

// 内容记录（analysis 区）与后端同构：results 同一分类可有多行（确定性行 + 决策行 + 模型行），
// 每个分类恰一行 effective；primary 为各来源的主分类结论（至多一行 effective）。
// 首个示例额外造一条非生效的确定性行 + 一条决策主分类（含概率分布），让 demo 能看到分组次要行与主分类区。
const demoContentAudits = Object.fromEntries(Object.entries(store.postVerdicts).map(function ([subjectId, verdicts], index) {
  const results = verdicts.map(function (entry) {
    const category = demoCategories.find(function (item) { return item.name === entry.ruleName; });
    return { categoryId: category?.id ?? 0, name: entry.ruleName, pass: entry.pass,
      evidence: entry.evidence, source: entry.source,
      confidence: entry.source === 'decision' ? (entry.pass ? 0.87 : 0.12) : null, effective: true };
  });
  if (index === 0 && results[0]) {
    // 同一分类的前档确定性行：命中但未定案，交模型定案 → 非生效
    results.unshift({ categoryId: results[0].categoryId, name: results[0].name, pass: true,
      evidence: '关键词与带图条件命中，交模型判定', source: 'rule', confidence: null, effective: false });
  }
  const primary = index === 0 ? [{
    source: 'decision', categoryId: results[0]?.categoryId ?? 101, name: results[0]?.name ?? '带图原创',
    distribution: { 带图原创: 0.72, '转发/live': 0.19, 预告词: 0.09 },
    evidence: '最像直播预告', effective: true,
  }] : [];
  const matchedRules = clone(demoRules.filter(function (rule) { return rule.subjectKind === 'post'; }));
  const post = [...store.twitterPosts, ...store.weiboPosts, ...store.biliPosts]
    .find(function (entry) { return entry.platform + ':' + entry.itemId === subjectId; });
  const ref = post ? (post.platform === 'bili_dynamic' ? 'bili:' : post.platform + ':') + post.uid : '';
  const rules = matchedRules.map(function (rule) {
    const inScope = !rule.scope.length || rule.scope.includes(ref);
    const matchedCategory = rule.categoryId === null || results.some(function (entry) { return entry.categoryId === rule.categoryId && entry.pass; });
    const matched = rule.enabled && inScope && matchedCategory;
    return { id: rule.id, name: rule.name, matched, reason: !rule.enabled ? '规则已停用'
      : !inScope ? '内容不在生效范围' : !matchedCategory ? '未命中引用分类' : '规则命中', configuration: rule };
  });
  const channelIds = new Set(rules.filter(function (rule) { return rule.matched; }).flatMap(function (rule) { return rule.configuration.channels; }));
  const channels = clone(store.channels.filter(function (channel) { return channelIds.has(channel.id); }))
    .map(function ({ id, name, enabled }) { return { id, name, enabled }; });
  const pass = channels.some(function (channel) { return channel.enabled; });
  const failedDelivery = pass && index === 0;
  const deliveries = store.channels.filter(function (channel) { return channelIds.has(channel.id) && channel.enabled; })
    .map(function (channel) {
      const failed = failedDelivery && channel.notifier === 'onebot';
      return { channel: channel.notifier, ...(channel.targetId ? { target: channel.targetType + ':' + channel.targetId } : {}),
        ok: !failed, ...(failed ? { error: '演示：NapCat 连接超时' } : {}) };
    });
  const succeeded = deliveries.filter(function (delivery) { return delivery.ok; }).length;
  return ['post:' + subjectId, {
    subjectType: 'post', subjectId, updatedAt: nowSec,
    analysis: { status: 'done', categories: clone(demoCategories.filter(function (category) { return category.appliesTo === 'post'; })),
      results, ...(primary.length ? { primary } : {}), imageCount: 1, durationMs: 850,
      attempts: [
        { channel: 'decision', provider: 'Jev', model: 'jev-1.14.0', status: 'success' },
        { channel: 'llm', provider: '演示模型', model: 'demo-vision', status: 'success' },
      ] },
    push: { status: !pass ? 'skipped' : succeeded === 0 ? 'failed' : succeeded < deliveries.length ? 'partial' : 'sent',
      reason: pass ? `发送完成：${succeeded}/${deliveries.length} 成功` : '无命中规则或没有启用的发送渠道',
      rules,
      channels,
      deliveries,
    },
  }];
}));

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
  const selected = store.llmProviders.find((p) => p.id === store.chat.provider);
  if (selected) return selected.name;
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
  'channels', 'categories', 'rules', 'streamers', 'xAccounts',
  'weiboAccounts', 'biliAccounts', 'llmProviders', 'decisionProviders', 'pushEnabled', 'llmEnabled',
  'decisionEnabled', 'listenSettings', 'napcat', 'x',
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

/** 写路径 → 记录文案（demo 口径：够读即可，真实文案由后端工具给；形状 = 新契约 headline + changes） */
function writeMeta(method, path, b) {
  const del = method === 'DELETE';
  const upd = { action: 'updated' };
  if (path === '/api/llm/enabled') {
    return { tool: 'set_llm_enabled', title: '开关 LLM', headline: b.enabled ? '开启了 LLM 总开关' : '关闭了 LLM 总开关', tables: ['settings'],
      detail: [{ label: 'LLM 总开关', ...upd, changes: [{ field: 'LLM 总开关', from: b.enabled ? '关' : '开', to: b.enabled ? '开' : '关', bool: true }] }] };
  }
  if (path === '/api/decision/enabled') {
    return { tool: 'set_decision_enabled', title: '开关决策模型', headline: b.enabled ? '开启了决策模型判定' : '关闭了决策模型判定', tables: ['settings'],
      detail: [{ label: '决策模型判定总开关', ...upd, changes: [{ field: '决策模型判定总开关', from: b.enabled ? '关' : '开', to: b.enabled ? '开' : '关', bool: true }] }] };
  }
  if (path === '/api/llm/providers/order') {
    return { tool: 'reorder_llm_providers', title: '调整供应商顺序', headline: '调整了 LLM 供应商顺序', tables: ['settings'],
      detail: [{ label: 'LLM 供应商名单', ...upd, changes: [{ field: 'LLM 供应商名单', to: '顺序已调整' }] }] };
  }
  if (path === '/api/llm/providers' || /^\/api\/llm\/providers\/[^/]+$/.test(path)) {
    const id = path === '/api/llm/providers' ? '' : decodeURIComponent(path.split('/').pop());
    const name = path === '/api/llm/providers' ? b.name : (store.llmProviders.find((p) => p.id === id) || {}).name || id;
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
  if (path === '/api/decision/providers/order') {
    return { tool: 'reorder_decision_providers', title: '调整决策模型顺序', headline: '调整了决策模型供应商顺序', tables: ['settings'],
      detail: [{ label: '决策模型供应商名单', ...upd, changes: [{ field: '决策模型供应商名单', to: '顺序已调整' }] }] };
  }
  if (path === '/api/decision/providers' || /^\/api\/decision\/providers\/[^/]+$/.test(path)) {
    const id = path === '/api/decision/providers' ? '' : decodeURIComponent(path.split('/').pop());
    const name = path === '/api/decision/providers' ? b.name : (store.decisionProviders.find((p) => p.id === id) || {}).name || id;
    const withKey = !del && !!(b.key && String(b.key).trim());
    return {
      tool: del ? 'delete_decision_provider' : 'upsert_decision_provider',
      title: del ? '删除决策模型供应商' : (path === '/api/decision/providers' ? '新增决策模型供应商' : '保存决策模型供应商'),
      headline: del ? `删除了决策模型供应商「${name}」` : (path === '/api/decision/providers' ? `新增了决策模型供应商「${name}」` : `修改了决策模型供应商「${name}」`),
      tables: ['settings'],
      detail: [{ label: `供应商「${name}」`, action: del ? 'deleted' : (path === '/api/decision/providers' ? 'created' : 'updated'),
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
  // 四类 CRUD 家族：渠道 / 分类 / 推送规则（含图文规则）/ 三张账号名单，形状一致
  const fam = [
    { re: /^\/api\/channels(?:\/(\d+))?$|^\/api\/channels\/order$/, table: 'push_channels', noun: '推送渠道', names: ['新增推送渠道', '保存推送渠道', '删除推送渠道'] },
    { re: /^\/api\/categories(?:\/(\d+))?$|^\/api\/categories\/order$/, table: 'categories', noun: '分类', names: ['保存分类', '保存分类', '删除分类'] },
    { re: /^\/api\/rules(?:\/(\d+))?$|^\/api\/rules\/order$/, table: 'push_rules', noun: '推送规则', names: ['保存推送规则', '保存推送规则', '删除推送规则'] },
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
    ...(meta.refill ? { refill: meta.refill } : {}),
  };
  store.undoHistory.unshift(rec);
  undoReverts.set(rec.id, snap);
}

// demo 里触发联动刷新的写白名单（与 webui/js/core.js 的 CONFIG_WRITE_PREFIXES 同口径——
// 前端只在配置写成功后刷变更历史，mock 也只在配置写成功后记一条，两边才不会打架）。
// 注意 /api/chat 只列 mode / provider 两条真配置写（都进变更历史），聊天回合与 reset 不算。
const MOCK_WRITE_PREFIXES = [
  '/api/llm', '/api/decision', '/api/advanced', '/api/categories', '/api/rules', '/api/channels',
  '/api/streamers', '/api/follows', '/api/listen', '/api/push',
  '/api/x', '/api/weibo', '/api/bili', '/api/napcat', '/api/chat/mode', '/api/chat/provider',
];
function isMockConfigWrite(method, path) {
  if (!method || method.toUpperCase() === 'GET') return false;
  if (path.includes('/test') || path === '/api/napcat/launch') return false;
  return MOCK_WRITE_PREFIXES.some((p) => path === p || path.startsWith(p + '/'));
}

// ---- 路由 ----
function categoryError(category) {
  const kind = category.appliesTo || 'live';
  if (kind !== 'live' && kind !== 'post') return 'appliesTo 必须是 live 或 post';
  if (kind === 'live' && ((category.postTypes || []).length || category.requireQuote || category.requireMedia)) {
    return '直播分类不能配置帖子类型、引用或带图条件';
  }
  if (kind === 'post' && (category.areas || []).length) return '图文分类不能配置直播分区条件';
  const hasModelConditions = category.judgeMode === 'precise'
    ? (category.judgeConditions || []).some((condition) => condition.direction === 'pass' && condition.enabled && condition.text.trim())
    : !!(category.llmPrompt || '').trim();
  if (!hasModelConditions && !(category.keywords || []).length
    && !(category.areas || []).length && !(category.postTypes || []).length
    && !category.requireQuote && !category.requireMedia) return '至少配置判定条件或一组确定性条件（关键词/分区/帖子类型/引用/带图）';
  return null;
}

function ruleRefsError(rule) {
  if (rule.categoryId != null) {
    const category = store.categories.find((category) => category.id === rule.categoryId);
    if (!category) return '分类不存在';
    if ((category.appliesTo || 'live') !== (rule.subjectKind || 'live')) return '分类与推送规则的内容类型不一致';
  }
  if ((rule.channels || []).some((id) => !store.channels.some((channel) => channel.id === id))) return '渠道不存在';
  for (const ref of rule.scope || []) {
    if ((rule.subjectKind || 'live') === 'live') {
      if (!store.streamers.some((streamer) => String(streamer.uid) === ref)) return '主播不在监听名单: ' + ref;
    } else {
      const [platform, key] = ref.split(':');
      const exists = platform === 'twitter' ? store.xAccounts.some((account) => account.screenName === key)
        : platform === 'weibo' ? store.weiboAccounts.some((account) => account.uid === key)
        : platform === 'bili' && store.biliAccounts.some((account) => account.uid === key);
      if (!exists) return '账号引用不存在: ' + ref;
    }
  }
  return null;
}

function orderError(items, ids) {
  return !Array.isArray(ids) || ids.length !== items.length || new Set(ids).size !== ids.length
    || ids.some((id) => !items.some((item) => item.id === id)) ? 'ids 必须包含全部现有 id，且不能重复' : null;
}

// ---- 分类测试（GET samples 随机抽样 → POST test 指定样本复测）：与 src/panel/category-test.ts 同构 ----
// 抽样池 = 真实归档（时间表 + 三平台帖子夹具）；规则列按请求里的**当前草稿**走条件算子真算，
// 证据文案与 analysis/matcher 逐字一致；LLM / 决策列确定性模拟（同一份内容恒定同结论），
// 形状齐全：决策概率、灰区（未定案）、未填判定描述 = skipped、模型停用 = unavailable。
// 只读：不落库、不进变更历史（isMockConfigWrite 已把 /test 排除在外）。
const TEST_POST_STORE = { bili_dynamic: 'biliPosts', weibo: 'weiboPosts', twitter: 'twitterPosts' };
const TEST_IMAGE_MAX = 9;                 // analysis/image-prep 的张数上限（超出的图逐张进 skippedImages）
const NO_CONDITION_NOTE = '无确定性条件';   // 纯模型分类：确定性档无从判定（判否 + 该说明）
const NO_PROMPT_REASON = '未填写判定描述';

function hash32(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
/** 0~1 的稳定概率：只由内容身份与判定描述决定，同一份内容每次请求同值 */
function simConfidence(seed) { return (hash32(seed) % 1000) / 1000; }

// 条件算子：id / 适用形态 / 证据文案都与 analysis/matcher.ts 的条件算子注册表一致
const TEST_OPS = {
  keyword: {
    appliesTo: ['live', 'post'],
    test(values, item) {
      const text = item.text.toLowerCase();
      const hit = values.find((k) => text.includes(String(k).toLowerCase()));
      return hit !== undefined ? `关键词「${hit}」` : null;
    },
  },
  area: {
    appliesTo: ['live'],
    test(values, item) {
      const hay = `${item.tags.area ?? ''}\n${item.tags.parentArea ?? ''}`.toLowerCase();
      const hit = values.find((a) => hay.includes(String(a).toLowerCase()));
      return hit !== undefined ? `分区「${hit}」` : null;
    },
  },
  postType: {
    appliesTo: ['post'],
    test(values, item) {
      const type = item.tags.type ?? '';
      return values.includes(type) ? `类型「${type === 'retweet' ? '转发' : '原创'}」` : null;
    },
  },
  quote: { appliesTo: ['post'], test: (_values, item) => (item.tags.isQuote === 'true' ? '引用帖' : null) },
  media: { appliesTo: ['post'], test: (_values, item) => (item.tags.hasMedia === 'true' ? '带图' : null) },
};

// 直播样本：一场直播 = 时间表条目（subjectId = roomId:liveTime）；标题与分区取首段
function liveTestSample(entry) {
  const seg = (entry.segments || [])[0] || {};
  return {
    item: {
      subjectType: 'live',
      subjectId: entry.roomId + ':' + entry.liveTime,
      uid: String(entry.uid),
      authorName: entry.name || entry.uname || String(entry.uid),
      text: seg.title || '',
      tags: { area: seg.areaName || '', parentArea: seg.parentAreaName || '' },
      url: 'https://live.bilibili.com/' + entry.roomId,
      ts: entry.liveTime,
      image: entry.keyframe || entry.cover || null,
    },
    // 直播只送一张图：关键帧优先、缺则封面（与 pipeline 同一条选择）
    images: entry.keyframe ? ['keyframe'] : entry.cover ? ['cover'] : [],
  };
}

function testPostAuthor(post) {
  if (post.platform === 'twitter') return '@' + post.uid;
  if (post.platform === 'bili_dynamic') {
    const account = store.biliAccounts.find((a) => String(a.uid) === String(post.uid));
    return (account && (account.displayName ?? account.uname)) || String(post.uid);
  }
  const account = store.weiboAccounts.find((a) => String(a.uid) === String(post.uid));
  return (account && (account.displayName ?? account.nickname)) || String(post.uid);
}

// 图文样本：三平台帖子夹具（subjectId = platform:itemId）；tags 与 analysis/content.ts 的投影同形
function postTestSample(post) {
  const pics = post.pics || [];
  return {
    item: {
      subjectType: 'post',
      subjectId: post.platform + ':' + post.itemId,
      uid: String(post.uid),
      authorName: testPostAuthor(post),
      text: String(post.text || ''),
      tags: {
        type: post.type === 'retweet' ? 'retweet' : 'original',
        isQuote: 'unknown',   // 夹具没有 posts.raw 的引用标记：与真实链路的「未知」同义
        hasMedia: String(pics.length > 0),
        platform: post.platform,
      },
      url: post.url || '',
      ts: post.pubTs,
      image: post.platform === 'twitter' && pics.length > 0 ? M.svgKeyframe('#5b657f', 'X') : (pics[0] || null),
    },
    images: pics.map((_url, i) => `pic#${i + 1}`),
  };
}

function testImages(images) {
  return {
    imageCount: Math.min(images.length, TEST_IMAGE_MAX),
    skippedImages: images.slice(TEST_IMAGE_MAX).map((ref) => ({ ref, reason: '超过张数上限' })),
  };
}

// 规则列：五组条件 → 空组忽略 / condMode 控制组间关系 / 无有效组不命中（纯模型分类不被误判成恒中）
function testRuleResult(category, item) {
  const groups = [
    { op: 'keyword', values: category.keywords || [] },
    { op: 'area', values: category.areas || [] },
    { op: 'postType', values: category.postTypes || [] },
    // requireQuote / requireMedia 是开关型条件组：置位即参与（算子只看内容标签）
    { op: 'quote', values: category.requireQuote ? ['1'] : [] },
    { op: 'media', values: category.requireMedia ? ['1'] : [] },
  ];
  const active = groups.filter((group) => group.values.length > 0);
  const usable = active.filter((group) => TEST_OPS[group.op].appliesTo.includes(item.subjectType));
  let pass = false;
  let evidence = NO_CONDITION_NOTE;
  if (active.length > 0) {
    const hits = active
      .map((group) => (TEST_OPS[group.op].appliesTo.includes(item.subjectType)
        ? TEST_OPS[group.op].test(group.values, item) : null))
      .filter((hit) => hit !== null);
    pass = category.condMode === 'or' ? hits.length > 0 : hits.length === active.length;
    evidence = pass ? `命中${hits.join('、')}` : usable.length > 0 ? '确定性条件未命中' : NO_CONDITION_NOTE;
  }
  return { source: 'rule', status: 'ok', pass, confidence: null, decided: true, evidence, reason: null };
}

function preciseConditions(category) {
  return (category.judgeConditions || []).filter((condition) => condition.enabled && condition.text.trim());
}

function modelSeed(category) {
  if (category.judgeMode !== 'precise') return String(category.llmPrompt || '').trim();
  return preciseConditions(category).map((condition) => condition.id + ':' + condition.text).join('|');
}

function skipModelTier(category, source) {
  const precise = category.judgeMode === 'precise';
  const missing = precise
    ? !preciseConditions(category).some((condition) => condition.direction === 'pass')
    : !String(category.llmPrompt || '').trim();
  if (!missing) return null;
  return { source, status: 'skipped', pass: null, confidence: null, decided: false, evidence: null,
    reason: precise ? '精确模式没有启用的通过条件' : NO_PROMPT_REASON };
}

function testLlmResult(category, item) {
  const skipped = skipModelTier(category, 'llm');
  if (skipped) return skipped;
  if (!store.llmEnabled || store.llmProviders.filter((p) => p.enabled).length === 0) {
    return { source: 'llm', status: 'unavailable', pass: null, confidence: null, decided: false, evidence: null,
      reason: store.llmEnabled ? '没有可用的 LLM 供应商' : 'LLM 已停用' };
  }
  const precise = category.judgeMode === 'precise';
  const pass = simConfidence(modelSeed(category) + '|' + item.subjectId) >= 0.5;
  return { source: 'llm', status: 'ok', pass, confidence: null, decided: true,
    evidence: pass ? `与${precise ? '精确条件' : '判定描述'}相符` : `与${precise ? '精确条件' : '判定描述'}不符`, reason: null };
}

function testDecisionResult(category, item) {
  const skipped = skipModelTier(category, 'decision');
  if (skipped) return skipped;
  if (!store.decisionEnabled || store.decisionProviders.length === 0) {
    return { source: 'decision', status: 'unavailable', pass: null, confidence: null, decided: false, evidence: null,
      reason: store.decisionEnabled ? '没有可用的决策模型供应商' : '决策模型已停用' };
  }
  const low = store.advanced.decisionGrayLowPct / 100;
  const high = store.advanced.decisionGrayHighPct / 100;
  const provider = store.decisionProviders[0];
  const base = provider.name + ' · ' + provider.model;
  if (category.judgeMode === 'precise') {
    const conditionResults = preciseConditions(category).map((condition) => {
      const p = Number(simConfidence('decision|' + condition.id + '|' + condition.text + '|' + item.subjectId).toFixed(2));
      return {
        categoryId: -1, conditionId: condition.id, direction: condition.direction, text: condition.text, p,
        band: p >= high ? 'high' : p <= low ? 'low' : 'gray', decisive: false,
      };
    });
    const passResults = conditionResults.filter((condition) => condition.direction === 'pass');
    const rejectResults = conditionResults.filter((condition) => condition.direction === 'reject');
    const rejected = rejectResults.some((condition) => condition.p >= high);
    const unsupported = passResults.every((condition) => condition.p <= low);
    const accepted = !rejected && passResults.some((condition) => condition.p >= high)
      && rejectResults.every((condition) => condition.p <= low);
    const decided = rejected || unsupported || accepted;
    conditionResults.forEach(function (condition) {
      condition.decisive = decided && (rejected
        ? condition.direction === 'reject' && condition.p >= high
        : unsupported ? condition.direction === 'pass' : condition.direction === 'pass' && condition.p >= high);
    });
    const verdict = decided ? (rejected ? '拒绝条件达到否决门槛' : accepted ? '通过条件达到定案门槛' : '没有通过条件达到支持门槛') : '条件概率落在灰区，未定案';
    return {
      source: 'decision', status: 'ok', pass: accepted, confidence: null, decided, conditionResults,
      evidence: base + '；' + verdict,
      reason: null,
    };
  }
  const confidence = simConfidence('decision|' + modelSeed(category) + '|' + item.subjectId);
  const decided = confidence <= low || confidence >= high;
  const verdict = decided
    ? (confidence >= high ? '概率高于灰区上界' : '概率低于灰区下界')
    : '概率落在灰区，未定案';
  return {
    source: 'decision', status: 'ok',
    pass: confidence >= 0.5,
    confidence: Number(confidence.toFixed(2)),
    decided,
    evidence: base + '；' + verdict,
    reason: null,
  };
}

// 草稿缺省值与校验走 /api/categories 新建同一套口径（parseNewCategory）
function testDraftCategory(raw) {
  const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (c.appliesTo !== undefined && c.appliesTo !== null && c.appliesTo !== 'live' && c.appliesTo !== 'post') {
    return { error: 'appliesTo 必须是 live 或 post' };
  }
  const category = {
    appliesTo: c.appliesTo === 'post' ? 'post' : 'live',
    name: typeof c.name === 'string' ? c.name : null,
    judgeMode: c.judgeMode === 'precise' ? 'precise' : 'simple',
    llmPrompt: typeof c.llmPrompt === 'string' ? c.llmPrompt : null,
    judgeConditions: Array.isArray(c.judgeConditions) ? clone(c.judgeConditions) : [],
    primary: c.primary === true,
    keywords: Array.isArray(c.keywords) ? c.keywords : [],
    areas: Array.isArray(c.areas) ? c.areas : [],
    postTypes: Array.isArray(c.postTypes) ? c.postTypes : [],
    requireQuote: c.requireQuote === true,
    requireMedia: c.requireMedia === true,
    condMode: c.condMode === 'or' ? 'or' : 'and',
    enabled: true,
  };
  const error = categoryError(category);
  return error ? { error } : { category };
}

// 过滤面校验（错误文案与 src/panel/category-test.ts 的 parseCategoryTestFilter 一致）
function testFilter(raw, appliesTo) {
  const f = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const filter = { limit: 10 };
  if (f.uid !== undefined && f.uid !== null) {
    if (typeof f.uid !== 'string' || f.uid.trim() === '') return { error: 'filter.uid 必须是非空字符串' };
    const uid = f.uid.trim();
    if (appliesTo === 'live' && !/^\d+$/.test(uid)) return { error: '直播样本的 filter.uid 必须是纯数字主播 uid' };
    filter.uid = uid;
  }
  if (f.platform !== undefined && f.platform !== null) {
    if (typeof f.platform !== 'string' || !TEST_POST_STORE[f.platform]) {
      return { error: 'filter.platform 必须是 bili_dynamic / weibo / twitter 之一' };
    }
    filter.platform = f.platform;
  }
  for (const [key, label] of [['fromTs', 'filter.fromTs'], ['toTs', 'filter.toTs']]) {
    const value = f[key];
    if (value === undefined || value === null) continue;
    if (!Number.isInteger(value) || value < 0) return { error: label + ' 必须是非负整数（秒级时间戳）' };
    filter[key] = value;
  }
  if (filter.fromTs !== undefined && filter.toTs !== undefined && filter.fromTs > filter.toTs) {
    return { error: 'filter.fromTs 不能晚于 filter.toTs' };
  }
  if (f.limit !== undefined && f.limit !== null) {
    if (!Number.isInteger(f.limit) || f.limit < 1 || f.limit > 20) return { error: 'filter.limit 必须是 1~20 的整数' };
    filter.limit = f.limit;
  }
  return { filter };
}

function categorySamplePool(kind, filter, requireImage = true) {
  const pool = [];
  if (kind === 'post') {
    const platforms = filter.platform ? [filter.platform] : Object.keys(TEST_POST_STORE);
    for (const platform of platforms) {
      for (const post of store[TEST_POST_STORE[platform]] || []) pool.push(postTestSample(post));
    }
  } else {
    const seen = new Set();
    for (const entry of store.schedule) {
      const sample = liveTestSample(entry);
      if (seen.has(sample.item.subjectId)) continue;
      seen.add(sample.item.subjectId);
      pool.push(sample);
    }
  }
  let picked = pool;
  if (filter.uid !== undefined) picked = picked.filter((sample) => sample.item.uid === filter.uid);
  if (filter.fromTs !== undefined) picked = picked.filter((sample) => sample.item.ts >= filter.fromTs);
  if (filter.toTs !== undefined) picked = picked.filter((sample) => sample.item.ts <= filter.toTs);
  if (requireImage) picked = picked.filter((sample) => sample.images.length > 0);
  return picked;
}

function sampleCategoryRecords(raw) {
  if (raw.kind !== 'live' && raw.kind !== 'post') return err(400, 'kind 必须是 live 或 post');
  const parsed = testFilter(raw.filter, raw.kind);
  if (parsed.error) return err(400, parsed.error);
  const picked = categorySamplePool(raw.kind, parsed.filter);
  for (let i = picked.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [picked[i], picked[j]] = [picked[j], picked[i]];
  }
  return ok({ samples: picked.slice(0, parsed.filter.limit).map((sample) => sample.item) });
}

function testCategory(raw) {
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  for (const key of Object.keys(body)) {
    if (key !== 'category' && key !== 'filter' && key !== 'sources' && key !== 'sampleIds') return err(400, '未知字段: ' + key);
  }
  const sourceOrder = ['rule', 'llm', 'decision'];
  const requestedSources = body.sources === undefined ? sourceOrder : body.sources;
  if (!Array.isArray(requestedSources) || requestedSources.length < 1 || requestedSources.length > 3
    || requestedSources.some((source) => !sourceOrder.includes(source))
    || new Set(requestedSources).size !== requestedSources.length) {
    return err(400, 'sources 必须是 1~3 个不重复的 rule / llm / decision');
  }
  const sources = sourceOrder.filter((source) => requestedSources.includes(source));
  const draft = testDraftCategory(body.category);
  if (draft.error) return err(400, draft.error);
  const category = draft.category;
  let picked;
  if (body.sampleIds !== undefined) {
    if (!Array.isArray(body.sampleIds) || body.sampleIds.length < 1 || body.sampleIds.length > 20
      || body.sampleIds.some((id) => typeof id !== 'string' || !id)
      || new Set(body.sampleIds).size !== body.sampleIds.length) {
      return err(400, 'sampleIds 必须是 1~20 个不重复的非空字符串');
    }
    const byId = new Map(categorySamplePool(category.appliesTo, {}, false).map((sample) => [sample.item.subjectId, sample]));
    picked = [];
    for (const id of body.sampleIds) {
      const sample = byId.get(id);
      if (!sample) return err(400, '样本不存在或内容类型不匹配: ' + id);
      picked.push(sample);
    }
  } else {
    const parsed = testFilter(body.filter, category.appliesTo);
    if (parsed.error) return err(400, parsed.error);
    picked = categorySamplePool(category.appliesTo, parsed.filter);
    for (let i = picked.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [picked[i], picked[j]] = [picked[j], picked[i]];
    }
    picked = picked.slice(0, parsed.filter.limit);
  }
  return ok({
    samples: picked.map((sample) => {
      const images = sources.includes('llm') || sources.includes('decision')
        ? testImages(sample.images) : { imageCount: 0, skippedImages: [] };
      const results = {
        rule: () => testRuleResult(category, sample.item),
        llm: () => testLlmResult(category, sample.item),
        decision: () => testDecisionResult(category, sample.item),
      };
      return {
        ...sample.item,
        imageCount: images.imageCount,
        skippedImages: images.skippedImages,
        results: sources.map((source) => results[source]()),
      };
    }),
  });
}

function handle(method, path, q, rawBody) {
  const body = () => { try { return JSON.parse(rawBody || '{}'); } catch { return {}; } };
  if (path === '/api/content-audit' && method === 'GET') {
    const subjectType = q.get('subjectType');
    const subjectId = q.get('subjectId');
    if (!['live', 'post'].includes(subjectType) || !subjectId || subjectId.length > 256) {
      return json(400, { error: '内容类型或身份键不合法' });
    }
    const audit = demoContentAudits[subjectType + ':' + subjectId] || null;
    const liveEntry = subjectType === 'live' ? store.schedule
      .find(function (entry) { return entry.roomId + ':' + entry.liveTime === subjectId; }) : null;
    const catIdOf = function (name) { return demoCategories.find(function (c) { return c.name === name; })?.id ?? 0; };
    return ok({ audit,
      verdicts: subjectType === 'post' ? (store.postVerdicts[subjectId] || []).map(function (entry) {
        return { categoryId: catIdOf(entry.ruleName), categoryName: entry.ruleName, source: entry.source, pass: entry.pass,
          evidence: entry.evidence, confidence: null, effective: true };
      }) : (liveEntry?.verdicts || []).map(function (entry) {
        return { ...entry, categoryId: catIdOf(entry.categoryName), pass: true, effective: true };
      }),
      primary: (audit?.analysis?.primary || []).map(function (p) {
        return { categoryId: p.categoryId, categoryName: p.name, source: p.source, distribution: p.distribution,
          evidence: p.evidence, effective: p.effective };
      }).concat(!audit && liveEntry?.primary ? [{ categoryId: catIdOf(liveEntry.primary.categoryName),
        categoryName: liveEntry.primary.categoryName, source: liveEntry.primary.source, distribution: null,
        evidence: '', effective: true }] : []) });
  }

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

  // 图文规则已统一进 /api/rules（subjectKind='post'）：post_rules 端点退役（与真实后端同构）。
  // 命中 /api/post-rules* 落到末尾的 404。

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
    // 跨字段校验与后端一致：灰区下界必须低于上界（合并后比对，只改一端也检查）
    const low = b.decisionGrayLowPct !== undefined ? b.decisionGrayLowPct : store.advanced.decisionGrayLowPct;
    const high = b.decisionGrayHighPct !== undefined ? b.decisionGrayHighPct : store.advanced.decisionGrayHighPct;
    if (low >= high) return err(400, `决策灰区下界（${low}%）必须小于上界（${high}%）`);
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
    if (b.ruleIds !== undefined) {
      return json(400, { error: '未知字段: ruleIds（生效范围改在规则 scope 上）' });
    }
    // 演示的 verify 显示名（真实后端从 og:title 抠出，种进 nickname）
    const demoNames = { watase_yuzuki: '渡瀬 結月', hololive_en: 'hololive English', nhk_news: 'NHKニュース' };
    const row = {
      id: ++store.xAccountSeq, screenName, nickname: demoNames[screenName] || null,
      displayName: b.displayName ? String(b.displayName) : null,
      biliUid: b.biliUid ? String(b.biliUid) : null, enabled: b.enabled !== false,
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
      if (b.ruleIds !== undefined) return json(400, { error: '未知字段: ruleIds（生效范围改在规则 scope 上）' });
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
    if (b.ruleIds !== undefined) {
      return json(400, { error: '未知字段: ruleIds（生效范围改在规则 scope 上）' });
    }
    const row = {
      id: ++store.weiboAccountSeq, uid, nickname, displayName: b.displayName ? String(b.displayName) : null,
      biliUid: b.biliUid ?? null,
      enabled: b.enabled !== false,
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
        if (b.ruleIds !== undefined) return json(400, { error: '未知字段: ruleIds（生效范围改在规则 scope 上）' });
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
    if (b.ruleIds !== undefined) {
      return json(400, { error: '未知字段: ruleIds（生效范围改在规则 scope 上）' });
    }
    const row = {
      id: ++store.biliAccountSeq, uid, uname: null,
      displayName: b.displayName ? String(b.displayName) : null,
      enabled: b.enabled !== false,
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
        if (b.ruleIds !== undefined) return json(400, { error: '未知字段: ruleIds（生效范围改在规则 scope 上）' });
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
    const list = store.streamers.map((s) => {
      const applied = store.rules.filter((r) => r.subjectKind === 'live' && (r.scope.length === 0 || r.scope.includes(s.uid)));
      return {
        ...s,
        rules: {
          // 与真实后端 enrichedStreamers 同构：names（纯名列表）+ items（id/name/allScope，空范围=true）
          names: applied.map((r) => r.name),
          items: applied.map((r) => ({ id: r.id, name: r.name, allScope: r.scope.length === 0 })),
        },
      };
    });
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
  if (path === '/api/categories/samples' && method === 'GET') {
    const filter = {};
    for (const key of ['uid', 'platform']) if (q.has(key)) filter[key] = q.get(key);
    for (const key of ['fromTs', 'toTs', 'limit']) if (q.has(key)) filter[key] = Number(q.get(key));
    return sampleCategoryRecords({ kind: q.get('kind'), filter });
  }
  if (path === '/api/categories/test' && method === 'POST') return testCategory(body());
  if (path === '/api/categories' && method === 'GET') return ok({ categories: store.categories });
  if (path === '/api/categories' && method === 'POST') {
    const b = body();
    const error = categoryError(b);
    if (error) return err(400, error);
    const id = store.categories.reduce((m, c) => Math.max(m, c.id), 0) + 1;
    store.categories.push({
      id, name: b.name || ('分类 ' + id),
      judgeMode: b.judgeMode === 'precise' ? 'precise' : 'simple',
      llmPrompt: b.llmPrompt ?? null, judgeConditions: clone(b.judgeConditions || []),
      keywords: b.keywords || [], areas: b.areas || [],
      appliesTo: b.appliesTo || 'live',
      postTypes: b.postTypes || [],
      requireQuote: !!b.requireQuote, requireMedia: !!b.requireMedia,
      condMode: b.condMode || 'and', primary: b.primary === true, enabled: b.enabled !== false,
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    return created({ id });
  }
  if (path === '/api/categories/order' && method === 'PUT') {
    const ids = body().ids || [];
    const error = orderError(store.categories, ids);
    if (error) return err(400, error);
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
        if (b.appliesTo !== undefined && b.appliesTo !== (c.appliesTo || 'live')) {
          return err(400, '分类的内容类型不可更改，请在对应页面新增分类');
        }
        const error = categoryError({ ...c, ...b });
        if (error) return err(400, error);
        for (const k of ['name', 'judgeMode', 'llmPrompt', 'judgeConditions', 'keywords', 'areas', 'appliesTo', 'postTypes', 'requireQuote', 'requireMedia', 'condMode', 'primary']) if (b[k] !== undefined) c[k] = clone(b[k]);
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

  // ---- 推送规则（统一规则：subjectKind × 分类引用 × scope × 渠道 × 附加动作）----
  if (path === '/api/rules' && method === 'GET') {
    const uid = q.get('uid');
    // ?uid= = 对该主播生效的开播规则（scope 空 = 全部主播；图文规则不进主播卡）
    const rules = uid
      ? store.rules.filter((r) => r.subjectKind === 'live' && (r.scope.length === 0 || r.scope.includes(uid)))
      : store.rules;
    return ok({ rules });
  }
  if (path === '/api/rules' && method === 'POST') {
    const b = body();
    const error = ruleRefsError(b);
    if (error) return err(400, error);
    const id = store.rules.reduce((m, r) => Math.max(m, r.id), 0) + 1;
    if (b.channels && b.channels.some((cid) => !store.channels.some((c) => c.id === cid))) {
      return json(400, { error: '渠道不存在' });
    }
    store.rules.push({
      id, name: b.name || ('规则 ' + id),
      subjectKind: b.subjectKind === 'post' ? 'post' : 'live',
      categoryId: b.categoryId ?? null,
      scope: b.scope || [], channels: b.channels || [],
      messageTemplate: b.messageTemplate ?? null,
      llmTranslate: b.llmTranslate === true,
      enabled: b.enabled !== false,
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    return created({ id });
  }
  if (path === '/api/rules/order' && method === 'PUT') {
    const ids = body().ids || [];
    const error = orderError(store.rules, ids);
    if (error) return err(400, error);
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
        const error = ruleRefsError({ ...r, ...b });
        if (error) return err(400, error);
        if (b.channels && b.channels.some((cid) => !store.channels.some((c) => c.id === cid))) {
          return json(400, { error: '渠道不存在' });
        }
        for (const k of ['name', 'subjectKind', 'categoryId', 'scope', 'channels', 'messageTemplate', 'llmTranslate']) {
          if (b[k] !== undefined) r[k] = b[k];
        }
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
    const ids = body().ids || [];
    store.llmProviders.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
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
    const id = crypto.randomUUID();
    store.llmProviders.push({
      id, name: b.name, baseURL: b.baseURL || '', model: b.model || '',
      vision: !!b.vision, enabled: true,
      structuredOutput: b.structuredOutput || 'schema', api: b.api || 'chat-completions',
    });
    return created({ id, name: b.name });
  }
  {
    const pm = path.match(/^\/api\/llm\/providers\/([^/]+)$/);
    if (pm) {
      const id = decodeURIComponent(pm[1]);
      const p = store.llmProviders.find((x) => x.id === id);
      if (!p) return err(404, 'provider 不存在');
      if (method === 'PUT') {
        const b = body();
        if (store.llmProviders.some((x) => x.id !== id && x.name === b.name)) return err(400, `provider name 重复: ${b.name}`);
        for (const k of ['name', 'baseURL', 'model', 'vision', 'enabled', 'structuredOutput', 'api']) if (b[k] !== undefined) p[k] = b[k];
        return ok({ ok: true, id, name: p.name });
      }
      if (method === 'DELETE') {
        store.llmProviders = store.llmProviders.filter((x) => x.id !== id);
        return ok({ ok: true });
      }
    }
  }

  // ---- 决策模型供应商（System One 管理面；与 LLM 完全隔离）----
  if (path === '/api/decision' && method === 'GET') {
    return ok({
      enabled: store.decisionEnabled,
      providers: store.decisionProviders.map((p) => ({
        ...p,
        key: { source: 'unset', count: 0, value: null },
      })),
    });
  }
  if (path === '/api/decision/enabled' && method === 'PUT') {
    const b = body();
    store.decisionEnabled = !!b.enabled;
    return ok({ ok: true, enabled: store.decisionEnabled });
  }
  if (path === '/api/decision/providers/order' && method === 'PUT') {
    const ids = body().ids || [];
    store.decisionProviders.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    return ok({ ok: true });
  }
  {
    const tm = path.match(/^\/api\/decision\/providers\/([^/]+)\/test$/);
    if (tm && method === 'POST') {
      const p = store.decisionProviders.find((x) => x.id === decodeURIComponent(tm[1]));
      if (!p) return err(404, 'provider 不存在');
      return ok({ ok: true, ms: 38, model: p.model });
    }
  }
  if (path === '/api/decision/providers' && method === 'POST') {
    const b = body();
    if (store.decisionProviders.some((p) => p.name === b.name)) return err(400, `provider name 重复: ${b.name}`);
    const id = crypto.randomUUID();
    store.decisionProviders.push({
      id, name: b.name, baseURL: b.baseURL || '', model: b.model || '',
      protocol: b.protocol || 'systemone', vision: !!b.vision, enabled: true,
    });
    return created({ id, name: b.name });
  }
  {
    const pm = path.match(/^\/api\/decision\/providers\/([^/]+)$/);
    if (pm) {
      const id = decodeURIComponent(pm[1]);
      const p = store.decisionProviders.find((x) => x.id === id);
      if (!p) return err(404, 'provider 不存在');
      if (method === 'PUT') {
        const b = body();
        if (store.decisionProviders.some((x) => x.id !== id && x.name === b.name)) return err(400, `provider name 重复: ${b.name}`);
        for (const k of ['name', 'baseURL', 'model', 'protocol', 'vision', 'enabled']) if (b[k] !== undefined) p[k] = b[k];
        return ok({ ok: true, id, name: p.name });
      }
      if (method === 'DELETE') {
        store.decisionProviders = store.decisionProviders.filter((x) => x.id !== id);
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
    const refill = top.undoNote === 'refill' ? (top.refill || []) : undefined;
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
    if (p !== '' && !store.llmProviders.some((x) => x.id === p)) {
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
