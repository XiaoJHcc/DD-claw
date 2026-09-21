// 面板前端 · lucide 图标节点数据（只收面板用到的图标；完整集上千个不收）。
// 源：lucide v1.33.0（ISC）dist/esm/icons/*.mjs 按名映射节选，节点格式与官方一致：
//   [tag, { attr: value }][]。改图标 = 换这里 + icons.js 的 icon() 照常渲染。
// 旧版为手绘仿 SF Symbols 内联集，已改用官方 lucide 图形（2026-08）。
// v2 设计新增图标（paw/headphone/sparkles/tag/list/bot/bell/eye/send 等）节点数据
// 取自 webui/redesign/v2/js/core.js 的内置集（v2 手绘，与 lucide 风格一致）；
// users 是 users-round 的别名（v2 命名），chevron 是 chevron-right 的别名（v2 命名）。
export const LUCIDE = {
  plus: [["path", { d: "M5 12h14" }], ["path", { d: "M12 5v14" }]],
  pencil: [
    ["path", { d: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" }],
    ["path", { d: "m15 5 4 4" }],
  ],
  trash: [
    ["path", { d: "M10 11v6" }], ["path", { d: "M14 11v6" }],
    ["path", { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" }],
    ["path", { d: "M3 6h18" }], ["path", { d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" }],
  ],
  bolt: [
    ["path", { d: "M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z" }],
  ],
  grip: [
    ["circle", { cx: "9", cy: "12", r: "1" }], ["circle", { cx: "9", cy: "5", r: "1" }],
    ["circle", { cx: "9", cy: "19", r: "1" }], ["circle", { cx: "15", cy: "12", r: "1" }],
    ["circle", { cx: "15", cy: "5", r: "1" }], ["circle", { cx: "15", cy: "19", r: "1" }],
  ],
  search: [
    ["path", { d: "m21 21-4.34-4.34" }], ["circle", { cx: "11", cy: "11", r: "8" }],
  ],
  xmark: [["path", { d: "M18 6 6 18" }], ["path", { d: "m6 6 12 12" }]],
  qrcode: [
    ["rect", { width: "5", height: "5", x: "3", y: "3", rx: "1" }],
    ["rect", { width: "5", height: "5", x: "16", y: "3", rx: "1" }],
    ["rect", { width: "5", height: "5", x: "3", y: "16", rx: "1" }],
    ["path", { d: "M21 16h-3a2 2 0 0 0-2 2v3" }],
    ["path", { d: "M21 21v.01" }], ["path", { d: "M12 7v3a2 2 0 0 1-2 2H7" }],
    ["path", { d: "M3 12h.01" }], ["path", { d: "M12 3h.01" }], ["path", { d: "M12 16v.01" }],
    ["path", { d: "M16 12h1" }], ["path", { d: "M21 12v.01" }], ["path", { d: "M12 21v-1" }],
  ],
  check: [["path", { d: "M20 6 9 17l-5-5" }]],
  'video-off': [
    ["path", { d: "M10.66 6H14a2 2 0 0 1 2 2v2.5l5.248-3.062A.5.5 0 0 1 22 7.87v8.196" }],
    ["path", { d: "M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2" }],
    ["path", { d: "m2 2 20 20" }],
  ],
  'chevron-right': [["path", { d: "m9 18 6-6-6-6" }]],
  clock: [["circle", { cx: "12", cy: "12", r: "10" }], ["path", { d: "M12 6v6l4 2" }]],
  sliders: [
    ["path", { d: "M10 5H3" }], ["path", { d: "M12 19H3" }],
    ["path", { d: "M14 3v4" }], ["path", { d: "M16 17v4" }],
    ["path", { d: "M21 12h-9" }], ["path", { d: "M21 19h-5" }], ["path", { d: "M21 5h-7" }],
    ["path", { d: "M8 10v4" }], ["path", { d: "M8 12H3" }],
  ],
  gear: [
    ["path", { d: "M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" }],
    ["circle", { cx: "12", cy: "12", r: "3" }],
  ],
  calendar: [
    ["path", { d: "M8 2v3" }], ["path", { d: "M16 2v3" }],
    ["rect", { x: "3", y: "3", width: "18", height: "18", rx: "2" }],
    ["path", { d: "M3 9h18" }],
  ],
  'users-round': [
    ["path", { d: "M18 21a8 8 0 0 0-16 0" }],
    ["circle", { cx: "10", cy: "8", r: "5" }],
    ["path", { d: "M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3" }],
  ],
  // users = users-round 的 v2 命名别名
  users: [
    ["path", { d: "M18 21a8 8 0 0 0-16 0" }],
    ["circle", { cx: "10", cy: "8", r: "5" }],
    ["path", { d: "M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3" }],
  ],
  // chevron = chevron-right 的 v2 命名别名
  chevron: [["path", { d: "m9 18 6-6-6-6" }]],
  'chevron-down': [["path", { d: "m6 9 6 6 6-6" }]],
  // ---- 以下取自 v2 core.js 内置图标集（实心点/块用 fill=currentColor stroke=none） ----
  paw: [
    ["path", { d: "M12 13.2c-2.9 0-5.3 2.1-5.3 4.6 0 1.7 1.2 2.9 2.9 2.9 1 0 1.6-.4 2.4-.4s1.4.4 2.4.4c1.7 0 2.9-1.2 2.9-2.9 0-2.5-2.4-4.6-5.3-4.6z", fill: "currentColor", stroke: "none" }],
    ["circle", { cx: "5.6", cy: "10.2", r: "1.9", fill: "currentColor", stroke: "none" }],
    ["circle", { cx: "9.2", cy: "6.4", r: "2", fill: "currentColor", stroke: "none" }],
    ["circle", { cx: "14.8", cy: "6.4", r: "2", fill: "currentColor", stroke: "none" }],
    ["circle", { cx: "18.4", cy: "10.2", r: "1.9", fill: "currentColor", stroke: "none" }],
  ],
  headphone: [
    ["path", { d: "M4 15v-3a8 8 0 0 1 16 0v3" }],
    ["rect", { x: "2.5", y: "14", width: "5", height: "7", rx: "2.2" }],
    ["rect", { x: "16.5", y: "14", width: "5", height: "7", rx: "2.2" }],
  ],
  sparkles: [
    ["path", { d: "M12 3.5 13.8 9l5.5 1.8-5.5 1.8L12 18l-1.8-5.4L4.7 10.8 10.2 9 12 3.5z" }],
    ["path", { d: "M19 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z" }],
  ],
  tag: [
    ["path", { d: "M12.6 2.6 21 11a2 2 0 0 1 0 2.8l-7.2 7.2a2 2 0 0 1-2.8 0L2.6 12.6A2 2 0 0 1 2 11.2V4a2 2 0 0 1 2-2h7.2a2 2 0 0 1 1.4.6z" }],
    ["circle", { cx: "7.5", cy: "7.5", r: "1.4" }],
  ],
  list: [
    ["path", { d: "M8 6h13M8 12h13M8 18h13" }],
    ["circle", { cx: "3.7", cy: "6", r: "1.1", fill: "currentColor", stroke: "none" }],
    ["circle", { cx: "3.7", cy: "12", r: "1.1", fill: "currentColor", stroke: "none" }],
    ["circle", { cx: "3.7", cy: "18", r: "1.1", fill: "currentColor", stroke: "none" }],
  ],
  bot: [
    ["rect", { x: "4", y: "8", width: "16", height: "12", rx: "3.5" }],
    ["path", { d: "M12 8V4.5M12 4.5h3" }],
    ["circle", { cx: "9", cy: "13.5", r: "1.2", fill: "currentColor", stroke: "none" }],
    ["circle", { cx: "15", cy: "13.5", r: "1.2", fill: "currentColor", stroke: "none" }],
    ["path", { d: "M9.5 17.2c1.5 1 3.5 1 5 0" }],
  ],
  bell: [
    ["path", { d: "M18 8.5a6 6 0 1 0-12 0c0 6.5-2.7 8.5-2.7 8.5h17.4S18 15 18 8.5" }],
    ["path", { d: "M13.7 21a2 2 0 0 1-3.4 0" }],
  ],
  eye: [
    ["path", { d: "M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" }],
    ["circle", { cx: "12", cy: "12", r: "3" }],
  ],
  send: [["path", { d: "M21 3 3 10.5l7 2.5m11-10-8 17-3-7m11-10L10 13" }]],
  // Agent 视图（聊天面板）：导航项与卡片头图标（聊天气泡）
  'message-square': [["path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" }]],
  link: [
    ["path", { d: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" }],
    ["path", { d: "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" }],
  ],
};