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
  healthAlertAfterFailures: 5,
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
};

// ---- NapCat（demo 手写：已登录最简态，uin/alertQq 为占位假号）----
export const mockNapcat = {
  enabled: true,
  autorestart: false,
  dir: '',
  uin: '10001',
  alertQq: '10001',
  platform: 'win32',
  source: { enabled: 'panel', autorestart: 'panel', dir: 'default', uin: 'panel' },
  endpoint: 'http://127.0.0.1:41990',
  probe: { state: 'ok', loggedIn: true },
  taskRegistered: true,
};

// ---- 系统状态骨架（startedAt/watchedCount/liveCount 由 mock-api 在冻结时间后计算）----
export const mockPlatforms = [
  { key: 'bili', name: 'B站', state: 'ok', mid: '10086' },
  { key: 'weibo', name: '微博', state: 'ok', mid: '9001' },
];
