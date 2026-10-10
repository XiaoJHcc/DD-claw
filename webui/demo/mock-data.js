// Demo 数据层：三部分来源——
// 1. fixtures.json（mock-api 启动时 fetch）：真实库一次性导出的主播列表/关注列表/时间表
//    节选，随仓库发布，人工节选维护（重新导出 npm run demo:fixtures --force）。
// 2. defaults.json（同上要 fetch）：LLM provider / 分类规则 / 推送规则的手工展示案例，
//    同时是发布后首启默认值（构建期生成 src/core/onboarding-defaults.gen.ts 种入）。
// 3. 本文件手写：渠道 / NapCat / 高级设置等设置卡片的 demo 态（按已登录最简态呈现）。
// 图片占位用 data: URI SVG（离线兜底），真实夹具里是 B站图床 URL。

export const PALETTE = [
  '#007aff', '#ff3b30', '#34c759', '#ff9500', '#af52de',
  '#5ac8fa', '#ff2d55', '#ffcc00', '#64d2ff', '#a2845e',
];

/** uid → 稳定色（与服务端 schedule 的哈希色同思路，保证时间条与头像同色系） */
export function colorFor(uid) {
  let h = 2166136261 >>> 0;
  const s = String(uid);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return PALETTE[h % PALETTE.length];
}

/** 圆形人物剪影头像（纯色底），face 缺失时的兜底 */
export function svgAvatar(color) {
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${color}"/><circle cx="32" cy="26" r="13" fill="rgba(255,255,255,.9)"/><path d="M8 58c2-15 12-23 24-23s22 8 24 23z" fill="rgba(255,255,255,.9)"/></svg>`,
  );
}

/** 16:9 渐变占位图（扫码演示等） */
export function svgKeyframe(color, label) {
  const text = label
    ? `<text x="50%" y="50%" font-family="sans-serif" font-size="16" fill="rgba(255,255,255,.92)" text-anchor="middle">${label}</text>`
    : '';
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="#141416"/></linearGradient></defs><rect width="320" height="180" fill="url(#g)"/>${text}</svg>`,
  );
}

/** demo 时间冻结：把页面「现在」锁定在夹具导出时刻（偏移式，demo 时间照常流动）。
 * 无论哪天打开 demo，时间表红线/在播时长/动态相对时间都按导出瞬间渲染。 */
export function freezeTime(fixedMs) {
  const RealDate = Date;
  const offset = fixedMs - RealDate.now();
  class DemoDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [RealDate.now() + offset])); }
    static now() { return RealDate.now() + offset; }
  }
  window.Date = DemoDate;
}

// ---- 北京日界（与服务端 /api/schedule 同口径：UTC+8 凌晨 6 点，仅用于归属）----
export function bjToday() { return new Date(Date.now() + 28800000).toISOString().slice(0, 10); }
export function bjAddDays(day, n) {
  return new Date(Date.parse(day + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}
export function bjDayStart(day) { return Math.floor(Date.parse(day + 'T06:00:00+08:00') / 1000); }
export function bjDayKey(tsSec) {
  return new Date((tsSec + 7200) * 1000).toISOString().slice(0, 10);
}

// ---- 渠道（demo 手写：toast + QQ群/私聊示例，targetId 为占位假号；备用群停用，演示引用对象置灰划线）----
export const mockChannels = [
  { id: 1, name: '系统通知', notifier: 'toast', targetType: null, targetId: null, enabled: true, createdAt: 0, updatedAt: 0 },
  { id: 2, name: '粉丝群', notifier: 'onebot', targetType: 'group', targetId: '10001', enabled: true, createdAt: 0, updatedAt: 0 },
  { id: 3, name: '我（私聊）', notifier: 'onebot', targetType: 'private', targetId: '10002', enabled: true, createdAt: 0, updatedAt: 0 },
  { id: 4, name: '备用群', notifier: 'onebot', targetType: 'group', targetId: '10003', enabled: false, createdAt: 0, updatedAt: 0 },
];

// ---- 运行时参数（/api/advanced 默认值，与后端 NUM/BOOL_SPECS 对齐）----
export const mockAdvanced = {
  pollIntervalSec: 45,
  pollJitterSec: 8,
  healthAlertToastAfterSec: 180,
  followsSyncIntervalSec: 1800,
  dynamicIntervalSec: 300,
  weiboIntervalSec: 300,
  llmRequestTimeoutMs: 60000,
  llmCircuitThreshold: 3,
  llmCircuitCooldownMs: 600000,
  notifyOnFirstRun: false,
  notifyOnNewSubscription: true,
  keyframeIntervalSec: 300,
  keyframeEnabled: true,
  backlogPushEnabled: false,
  backlogMaxAgeHours: 6,
  backlogMaxPerAccount: 3,
};

// ---- NapCat（demo 手写：已登录最简态，uin/alertQq 为占位假号）----
export const mockNapcat = {
  enabled: true,
  autorestart: false,
  dir: 'D:/CLI/NapCat.Shell',
  uin: '10001',
  alertQq: '10001',
  platform: 'win32',
  source: { enabled: 'panel', autorestart: 'panel', dir: 'panel', uin: 'panel' },
  endpoint: 'http://127.0.0.1:41990',
  probe: { state: 'ok', loggedIn: true },
  taskRegistered: true,
  configReady: true,
};

// ---- 系统状态骨架（startedAt/watchedCount/liveCount 由 mock-api 在冻结时间后计算）----
export const mockPlatforms = [
  { key: 'bili', name: 'B站', state: 'ok', mid: '10086' },
  { key: 'weibo', name: '微博', state: 'ok', mid: '9001' },
];

// ---- X / 推特（独立分页）：demo 手写一份「刚测过、三实例两通一限速」的现场，
// 让 ?demo=1 下连接卡的状态点、实例分类与测试结果都能被看见（含一条失败对照）----
export const mockX = {
  config: {
    proxyUrl: 'http://127.0.0.1:7890',
    instances: ['nitter.jaydenha.uk', 'x.n0g.xyz', 'nitter.kareem.one'],
    intervalSec: 300,
    fallbackHtml: true,
  },
  status: {
    proxy: { ok: true, message: '代理可达 · x.com 200 · 1780ms', checkedAt: 0 },
    instances: [
      { host: 'nitter.jaydenha.uk', ok: true, message: '可用 · 20 条 · 940ms' },
      { host: 'x.n0g.xyz', ok: true, message: '可用 · 20 条 · 1120ms' },
      { host: 'nitter.kareem.one', ok: false, message: '429 被限速' },
    ],
    web: { ok: true, message: '免登录可用 · 7 个 id · 最新 2026-09-16T00:54:10.000Z', checkedAt: 0 },
    feed: {
      running: true, lastRunAt: 0, lastOkAt: 0,
      via: 'nitter', host: 'nitter.jaydenha.uk', accounts: 2, okAccounts: 2, lastError: null,
    },
    updatedAt: 0,
  },
};

// ---- X 关注账号（独立名单：不要求对应 B站主播；留一个停用项做对照）----
// avatar = X 链路抓到的本地缓存文件名；demo 由 webui-dev 把 /api/x-avatar 映射到
// data/cache/x-avatars，这里的文件名对应该目录下真实存在的缓存文件。
// 生效范围在规则侧 scope（A.2：账号侧 rule_ids 已删除）——选用关系见 mockPostRules 的 scope。
export const mockXAccounts = [
  {
    // nickname = 平台显示名（添加时校验种入 og:title / 抓取回写）；displayName = 用户自定义备注
    id: 1, screenName: 'watase_yuzuki', nickname: '渡瀬 結月', displayName: '渡濑结月', biliUid: null, enabled: true,
    lastTweetId: '2101671199457894850', lastTweetAt: 1, lastOkAt: 1,
    avatar: '661034f88371821109aed0e05c5389dc.jpg', createdAt: 1, updatedAt: 1,
  },
  {
    id: 2, screenName: 'hololive_en', displayName: 'hololive English', biliUid: null, enabled: false,
    lastTweetId: null, lastTweetAt: null, lastOkAt: null,
    avatar: 'a57dc1efff44d79e3ca2b5d9b3144013.png', createdAt: 0, updatedAt: 0,
  },
];

// ---- 图文规则（统一 push_rules 里 subject_kind='post' 的行；与开播规则同表同序）----
// 判定口径（原 filters/judgePrompt）在分类上（categoryId 指向 mock-api 里种的图文分类）；
// 生效范围在规则 scope（`twitter:账号` / `weibo:uid` / `bili:uid`；空 = 全部账号生效）。
// 四条演示：「带图原创 → 粉丝群」、停用的「转发 → 系统通知」、两条「预告词 → 粉丝群（+私聊）」
export const mockPostRules = [
  {
    id: 101, name: '带图原创', subjectKind: 'post', categoryId: 101,
    scope: ['twitter:watase_yuzuki', 'weibo:1158211483'], channels: [2],
    messageTemplate: null, llmTranslate: true,
    enabled: true, sort: 0, createdAt: 1, updatedAt: 1,
  },
  {
    id: 102, name: '转发也看', subjectKind: 'post', categoryId: 102,
    scope: [], channels: [1],
    messageTemplate: '{author} 转发了', llmTranslate: false,
    enabled: false, sort: 1, createdAt: 1, updatedAt: 1,
  },
  {
    id: 103, name: '微博预告', subjectKind: 'post', categoryId: 103,
    scope: ['weibo:1158211483'], channels: [2],
    messageTemplate: '{author} 发了新微博', llmTranslate: false,
    enabled: true, sort: 2, createdAt: 1, updatedAt: 1,
  },
  {
    id: 104, name: '动态预告', subjectKind: 'post', categoryId: 103,
    scope: ['bili:80397'], channels: [2, 3],
    messageTemplate: null, llmTranslate: false,
    enabled: true, sort: 3, createdAt: 1, updatedAt: 1,
  },
];

// ---- 微博（图文分页第二个来源）：源运行状态 + 独立名单 + 最近微博 ----
// 与 X 同构但前提不同：微博要登录态（没有代理/实例那套设置，间隔走「抓取设置」）。
export const mockWeibo = {
  config: { intervalSec: 300 },
  status: {
    feed: {
      running: true, lastRunAt: 0, lastOkAt: 0, accounts: 1, okAccounts: 1, lastError: null,
    },
  },
};

export const mockWeiboAccounts = [
  {
    id: 1, uid: '1158211483', nickname: 'Hosi_Tiri', biliUid: null, enabled: true,
    lastPostId: '5345338974275832', lastPostAt: 1, lastOkAt: 1,
    avatar: '39d3ac4936e727f6ae12b559ee372266.jpg', createdAt: 1, updatedAt: 1,
  },
];

// 最近微博（微博账号卡帖子段的演示数据，2026-09-20 真实抓取；pubTs 由 mock-api 在冻结时刻后填）
export const mockWeiboPosts = [
  {
    id: 1, platform: 'weibo', uid: '1158211483', itemId: '5345338974275832', type: 'mblog',
    text: '#髙橋ミナミ# ​​​',
    pics: [
      'https://wx1.sinaimg.cn/orj960/4508e79bgy1ihagt9renpj20rw116djo.jpg',
      'https://wx3.sinaimg.cn/orj960/4508e79bgy1ihagt9fvfyj20rg10m77t.jpg',
      'https://wx4.sinaimg.cn/orj960/4508e79bgy1ihagt9hkv2j20s811mq6v.jpg',
      'https://wx1.sinaimg.cn/orj960/4508e79bgy1ihagt9nbj1j20t412sdk1.jpg',
      'https://wx1.sinaimg.cn/orj960/4508e79bgy1ihagt9htlhj216o1kw0yc.jpg',
      'https://wx1.sinaimg.cn/orj960/4508e79bgy1ihagt9mqpjj216o1kwdl8.jpg',
    ],
    pubTs: 1, url: 'https://weibo.com/1158211483/Rj1tnhWl2', createdAt: 1,
  },
  {
    id: 2, platform: 'weibo', uid: '1158211483', itemId: '5345338391266881', type: 'mblog',
    text: '#早见沙织# ​​​',
    pics: [
      'https://wx1.sinaimg.cn/orj960/4508e79bgy1ihagqv7ttfj20w013kwjy.jpg',
      'https://wx3.sinaimg.cn/orj960/4508e79bgy1ihagquxwcrj20w013ktek.jpg',
      'https://wx3.sinaimg.cn/orj960/4508e79bgy1ihagqv2x0uj20w013k79a.jpg',
    ],
    pubTs: 1, url: 'https://weibo.com/1158211483/Rj1sr5jzz', createdAt: 1,
  },
  {
    id: 3, platform: 'weibo', uid: '1158211483', itemId: '5345338287197042', type: 'mblog',
    text: '#岡田夢以# ​​​',
    pics: [
      'https://wx4.sinaimg.cn/orj960/4508e79bgy1ihagqf84inj22512urkjl.jpg',
      'https://wx2.sinaimg.cn/orj960/4508e79bgy1ihagqfdb48j22c0340hdu.jpg',
    ],
    pubTs: 1, url: 'https://weibo.com/1158211483/Rj1sguchk', createdAt: 1,
  },
];

// ---- 最近推文（账号卡推文段的演示数据，2026-09-20 真实归档；按 uid 归到各账号卡，pubTs 由 mock-api 在冻结时刻后填）----
export const mockTwitterPosts = [
  {
    id: 1, platform: 'twitter', uid: 'watase_yuzuki', itemId: '2101671199457894850', type: 'tweet',
    text: 'こちらご確認お願いいたします\n\nずっと楽しみにしていたイベントだったので悔しいですが、楽しみの気持ちをお昼の部で全部お伝えできればと...!!\n安全第一でお会いしましょう!!',
    pics: [],
    pubTs: 1, url: 'https://x.com/watase_yuzuki/status/2101671199457894850', createdAt: 1,
  },
  {
    id: 2, platform: 'twitter', uid: 'watase_yuzuki', itemId: '2101668953844064324', type: 'tweet',
    text: '【重要なお知らせ】\n台風に伴う一部開催中止および変更について\n\n9月21日(月・祝)東京・全電通労働会館にて開催予定の『声グラゼミナール～業界のいろは学びまSHOW～夏の特別授業』につきまして、ご案内いたします。\n\n■開催予定の内容\n・昼の部公演\n\n予定通り【開催】の方向で準備を進めております。 https://t.co/zxqnYfpfT6',
    pics: ['https://pbs.twimg.com/media/HSqdLbUbIAEtuN1.jpg'],
    pubTs: 1, url: 'https://x.com/seigura/status/2101668953844064324', createdAt: 1,
  },
  {
    id: 3, platform: 'twitter', uid: 'watase_yuzuki', itemId: '2101622144761537011', type: 'retweet',
    text: '【お知らせ】 9月21日(月･祝)開催『声グラゼミナール～夏の特別授業』につきまして 台風の影響による今後の対応について、現在の状況をご案内いたします。 ■ 昼の部公演 慎重に協議のうえ【開催】の方向で準備を進めております。今後の気象情報や交通状況の急激な悪化によっては変更となる可能性がございます。 ■ 会場物販・夜の部公演 気象情報・交通状況を注視し、引き続き【慎重に検討中】でございます。 夜の部・物販の実施可否につきましては、本日中に本アカウントにて改めてご案内いたします。 ご来場予定の皆様にはご心配をおかけし誠に申し訳ございませんが、今しばらくお待ちいただけますと幸いです。 #声グラゼミ',
    pics: ['https://pbs.twimg.com/media/HSp0XnRbcAAWV2T.jpg'],
    pubTs: 1, url: 'https://x.com/seigura/status/2101622144761537011', createdAt: 1,
  },
];

// ---- 帖子判定行（账号卡帖子段「推 / 不推」标记的演示数据，键 = `platform:item_id`）----
// 形状与真实后端 accountPosts 附带的 verdicts 逐字段同构（ruleId/ruleName/pass/evidence/source）；
// ruleName = 判定时冗余的规则名（规则删除后历史仍可读）。三条演示三种形态：
// LLM 判过（绿「推」）/ LLM 判否（灰「不推」）/ LLM 不可用回退机械筛选放行（source=rule）；
// 没跑过判定的帖子不在此表 = 无判定行 = 不显示标记。
export const mockPostVerdicts = {
  'twitter:2101671199457894850': [
    { ruleId: 1, ruleName: '带图原创', pass: true, evidence: '内容是活动出席预告，与直播相关', source: 'llm' },
  ],
  'twitter:2101668953844064324': [
    { ruleId: 1, ruleName: '带图原创', pass: false, evidence: '台风导致的活动变更通知，不是直播预告', source: 'llm' },
  ],
  'weibo:5345338974275832': [
    {
      ruleId: 1, ruleName: '带图原创', pass: true,
      evidence: 'LLM 不可用/失败，回退机械筛选放行（LLM 未启用）', source: 'rule',
    },
  ],
};

// ---- 变更历史（P0b 撤销的用户面的 demo 态）：六条 = 设置 LLM 密钥（含 refill 副作用：撤销 = 清空密钥
// 需重填）/ 保存分类 / 删分类（级联 4 行 = 「多行明细」样例）/ 群渠道关推送（MCP 来源 + 渠道栈）/
// 修改运行时参数 / 调整渠道顺序（已撤销——演示置灰行与「撤销」按钮只挂栈顶）。
// 字段与 GET /api/undo/history 的每一条逐字同构（id / tool / entry / actor / scope / at / undone /
// undoneAt / tables / rows / title / headline / detail / undoNote），顺序恒为**新→旧**（id 降序）；
// at / undoneAt 由 mock-api 在冻结时刻后按偏移种入。headline / detail 是后端给的中文文案
// （前端不维护工具名映射），detail 每条 = { label 中文对象名, action: created|updated|deleted,
// changes: [{ field, from, to }] }（值不可示人 = { field, redacted: true }）。
// scope 取值同服务端：面板/本机 admin = 'admin'，渠道栈 = 'ch:<channelId>'。
export const mockUndoHistory = [
  {
    id: 6, tool: 'set_llm_key', entry: 'panel', actor: 'panel', scope: 'admin',
    at: 0, undone: false, undoneAt: null, tables: ['settings'], rows: 1,
    title: '设置 LLM 密钥', headline: '设置了 DeepSeek 的 LLM 密钥', undoNote: 'refill',
    detail: [{ label: '设置项「LLM 密钥（DeepSeek）」', action: 'updated', changes: [{ field: '密钥', redacted: true }] }],
  },
  {
    id: 5, tool: 'upsert_category', entry: 'panel', actor: 'panel', scope: 'admin',
    at: 0, undone: false, undoneAt: null, tables: ['categories'], rows: 1,
    title: '保存分类', headline: '修改了分类「歌回」',
    detail: [{ label: '分类「歌回」', action: 'updated', changes: [
      { field: '关键词', from: '唱、歌、音乐', to: '唱、歌、音乐、演唱会' },
      { field: '条件关系', from: '或', to: '且' },
    ] }],
  },
  {
    id: 4, tool: 'delete_category', entry: 'panel', actor: 'panel', scope: 'admin',
    at: 0, undone: false, undoneAt: null, tables: ['categories', 'push_rules'], rows: 4,
    title: '删除分类', headline: '删除了分类「杂谈」',
    detail: [
      { label: '分类「杂谈」', action: 'deleted', changes: [] },
      { label: '推送规则「杂谈-开播」', action: 'updated', changes: [{ field: '启用', from: '开', to: '关', bool: true }] },
      { label: '推送规则「杂谈-闲聊」', action: 'updated', changes: [{ field: '启用', from: '开', to: '关', bool: true }] },
      { label: '推送规则「全部」', action: 'updated', changes: [{ field: '启用', from: '开', to: '关', bool: true }] },
    ],
  },
  {
    id: 3, tool: 'set_push_enabled', entry: 'mcp', actor: 'maibot', scope: 'ch:2',
    at: 0, undone: false, undoneAt: null, tables: ['settings'], rows: 1,
    title: '开关推送', headline: '关闭了推送总开关',
    detail: [{ label: '设置项「推送总开关」', action: 'updated', changes: [{ field: '推送总开关', from: '开', to: '关', bool: true }] }],
  },
  {
    id: 2, tool: 'update_runtime_config', entry: 'panel', actor: 'panel', scope: 'admin',
    at: 0, undone: false, undoneAt: null, tables: ['settings'], rows: 2,
    title: '修改运行时参数', headline: '修改运行时参数（2 项变更）',
    detail: [
      { label: '设置项「LLM 请求超时」', action: 'updated', changes: [{ field: 'LLM 请求超时', from: '60 秒', to: '45 秒' }] },
      { label: '设置项「LLM 熔断阈值」', action: 'updated', changes: [{ field: 'LLM 熔断阈值', from: '3 次', to: '5 次' }] },
    ],
  },
  {
    id: 1, tool: 'reorder_channels', entry: 'panel', actor: 'panel', scope: 'admin',
    at: 0, undone: true, undoneAt: 0, tables: ['push_channels'], rows: 4,
    title: '调整渠道顺序', headline: '调整渠道顺序（4 项变更）',
    detail: [
      { label: '推送渠道「系统通知」', action: 'updated', changes: [{ field: '位置', from: '第 1 位', to: '第 2 位' }] },
      { label: '推送渠道「粉丝群」', action: 'updated', changes: [{ field: '位置', from: '第 2 位', to: '第 1 位' }] },
      { label: '推送渠道「我（私聊）」', action: 'updated', changes: [{ field: '位置', from: '第 3 位', to: '第 4 位' }] },
      { label: '推送渠道「备用群」', action: 'updated', changes: [{ field: '位置', from: '第 4 位', to: '第 3 位' }] },
    ],
  },
];

// ---- Agent 聊天（P1 前端聊天视图的 demo 态）：初始会话 = 一次完整的「写前询问」往返
// （用户要改分类关键词 → agent 先要确认 → 确认后调工具写入 → markdown 回报），一进 demo 就能看到
// 气泡、markdown 正文与 kimi 式工具调用行。话题与 defaults.json 的种子数据一致（分类「歌回」、
// 渠道「粉丝群」），免得演示露出后端没有的对象。at 由 mock-api 在冻结时刻后按偏移种入。
// 形状与真实 /api/chat/history 同构：id = 消息 id（轮询去重键）；provider = 该条回复实际由谁提供；
// calls = 工具调用行（中间轮 content 为空、只有 calls，与真实后端配对产出的形状一致；
// {id, name, title, target, ok, args, output} 逐字对应后端 agent/tool-view.ts 的 ToolCallView）。
// 交互剧本（mock 的 POST /api/chat 按关键词回话）另见 mock-api.js 的 chatScript。
export const mockChat = {
  mode: 'ask',
  provider: '',
  messages: [
    { id: 1, role: 'user', content: '给「歌回」这个分类加上关键词「演唱会」', at: 0, provider: null },
    { id: 2, role: 'assistant', content: '我先确认一下：要给分类「歌回」新增关键词「演唱会」吗？\n确认后我就写入（改动记进设置页的「变更历史」，可撤销）。', at: 0, provider: 'DeepSeek' },
    { id: 3, role: 'user', content: '确认', at: 0, provider: null },
    { id: 4, role: 'assistant', content: '', at: 0, provider: 'DeepSeek', calls: [
      { id: 'demo_call_1', name: 'list_categories', title: '列出分类', target: '', ok: true,
        args: '{}',
        output: '{\n  "categories": [\n    {\n      "name": "歌回",\n      "keywords": ["唱", "歌", "音乐"],\n      "condMode": "或",\n      "enabled": true\n    }\n  ]\n}' },
      { id: 'demo_call_2', name: 'upsert_category', title: '保存分类', target: '歌回', ok: true,
        args: '{\n  "name": "歌回",\n  "keywords": ["唱", "歌", "音乐", "演唱会"],\n  "condMode": "或"\n}',
        output: '{\n  "ok": true\n}' },
    ]},
    { id: 5, role: 'assistant', content: '已写入。分类「歌回」现在长这样：\n\n- **关键词**：唱、歌、音乐、演唱会\n- **匹配方式**：或（任一命中即归类）\n\n改动记进了设置页的「变更历史」，随时可以撤销。', at: 0, provider: 'DeepSeek' },
  ],
};
