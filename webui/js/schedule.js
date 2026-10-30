// 面板前端 · 时间表：过往直播的时间轴（纵轴日期升序、横轴时间），**5 天滑动窗口制**。
// 窗口 = 居中日 center ± 2 天（一次请求）。条颜色 = 头像平均色取 h/s（远程头像经 /api/avatar
// 同源反代、同源头像〔demo 本地化 demo/avatars/*〕直连，规避 B站图床无 CORS 的画布污染），
// 亮度随主题：亮色 70% / 暗色 40%（s 开根号提饱和）。
// 头像获取不到才回退 uid 哈希色 hsl(h, 50%, L)，未算出颜色前一律占位灰；主题切换只改亮度重渲。
// 三级行：center（双行字：主播名 + 直播间标题，实色不透明）> single（单行字，减淡）>
// mini（无字色条，更淡），由 .sched-day 的 class 驱动，条透明度 / 字层全走
// CSS 过渡。点击任意非居中天 → 该天居中；滚轮按天步进（preventDefault 阻止页面滚动，
// 300ms 节流；相邻 ±1 步窗口后台预取，滚动命中缓存立即渲染——动画不被数据加载延迟
// 打断，随后后台重取纠偏，内容有变化才重渲）。滑动时重叠天不重建 DOM，只切 level class
// + 原地更新条几何与文字，颜色条在无字/单行/双行间平滑渐变。卡片刚好一屏：行高由 JS
// 按 0-1-2 权重解算成 flex-basis 像素值（mini 日固定 5px 窄条；single/center 日按
// 道数 × 级权重 1/2 水装填分配余高，每道下限 16/32px，钳住后余量重分），grow/shrink
// 恒 0——级别切换、道数变化、日进出窗口、窗口缩放全是 basis px→px 的 CSS 过渡，
// 全程连续；日插入从 0 高展开、移除等高度到 0 才删 DOM。空间连每道下限都放不下时
// 按步降级（schedLevelFor）：1 去掉首末两天（只显示三天）→ 2 相邻两天降 mini 条 →
// 3 当天也降单行条；降级由 JS 按实际道数/可用高度算定，空间恢复自动升回，
// 各级切换同样全走折叠/展开与 class 过渡。
//
// 视觉（v2 化，2026-09 时间表美学改版）：时间胶囊刻度 + 虚线基线轴；日标签为行内悬浮胶囊
// （无左侧日头列，居中天蓝渐变）；仅居中天有浅蓝底色；泳道无底色、道间浅分割线（mini 不画）；
// 条面纯实色（无光泽无投影，2026-09-03 决策）；在播 / 未知下播散尾 = ::before 的 mask（--fade）整体淡出——
// 尾端不漏硬边、文字层保持实色、右端直角不收圆；红线 = 粉色纵向渐变 + 圆点光环；
// hover 弹层 = 16:9 图置顶 + 标题/时间/分区/判定证据（分类名按名哈希五色 tag；生效主分类置首、
// 走实色 tag 档，与其余分类区分）；图与分类区都跟随鼠标横向位置的时间点，分类取该场历次判定里
// 最后一个 ts ≤ 该时间的轮次（第一轮之前 = 未分类，无历史才回退最新结果）。
//
// 共享轴（偏移语义）：轴 = 相对各行归属日 06:00 的偏移秒数（offStart/offEnd，
// 0 = 06:00；06:00 日界只用于「归属哪天」，与渲染窗口无关），按**当前可见全部
// 5 天**的实际内容算定（center 变化 / 60s 定时器重算）；在播场终点用真实 now，
// 未观测下播场用最后一次在播观测（lastLiveTs）——「假定播 2 小时」是纯绘制层假设，
// 绝不进轴；未知下播的 30 分钟散尾区要给出行内空间，否则行尾会把虚化裁成硬边。
// 空窗口兜底 {0, 86400}。
// 每天行窗口 = 当天 06:00 + [offStart, offEnd]（可延伸到次日白天，正是设计意图），
// 跨天竖向对齐天然成立；offEnd ≤ offStart + 24h ⇒ 相邻天窗口不重叠（至多首尾相接）。
// 红线跟随行窗口：now 落在哪行窗口就画哪行（至多一行命中；缩略行 / 空档不画）。
//
// 泳道候选 = 当天 entries + 前一天 entries（通宵场溢出段接续：归属日行画到该行窗口
// 右端，次日行从其窗口左起接续，相邻窗口首尾相接故无缝）。段与行窗口求交后按
// **uid 分组整体装箱**（同主播当天多场永远同泳道；组内条互叠的异常数据退化为
// 逐 bar 装箱）。装箱窗口 == 绘制窗口，行高 = 泳道数 × 道高。
//
// 服务在线区间：/api/schedule 随 days 返回 service.online（服务进程心跳区间）与
// trackedFrom（记录起点）。行内窗口减去在线区间 = 服务未运行时段，铺灰底；trackedFrom
// 之前没有记录，不铺灰。场次起点用平台给的 live_time（真实开播）；终点只在真观测到
// 下播时用 endTs。停机/断轮询导致没观测到下播的场次 endTs=null，画到最后一次在播
// 观测 lastLiveTs，并从那里向后散尾——不把停机时刻写成下播时间。
import { api, toast, ACTIONS, esc } from './core.js';
import { icon } from './icons.js';
import { openContentAudit } from './content-audit.js';

var schedDays = [];           // 窗口内 5 天升序 [{date, entries:[...]}]
var schedOnline = [];         // 服务在线区间 [{startTs, endTs}]
var schedTrackedFrom = null;  // 服务在线记录起点；null = 没有记录（不画灰底）
var schedCenter = null;       // 居中日（日串）
var schedColors = {};         // uid → {h, s}（头像平均色取 h/s）/ null（头像获取不到→哈希色）；undefined = 未算出→占位灰
var schedColorPending = {};   // uid → true（平均色计算中，避免重复拉图）
var schedAxis = null;         // {offStart, offEnd} 相对当天 06:00 的偏移秒数；null = 尚未算过
var schedSeq = 0;             // 请求序号戳：连点/连滚时作废旧渲染
var schedWheelLock = 0;       // wheel 节流时间戳
var schedCollapsing = {};     // 日期 → true：该行正在折叠离场（滚动折返时可取消）
var schedExpanding = {};      // 日期 → true：该行正在展开进场（中途重渲不清它的内联样式）
var schedDegrade = 0;         // 当前空间降级步数（0-3，schedLevelFor；视图隐藏 clientHeight=0 时保持上次值）

// ---- 北京时间工具（固定 UTC+8，与服务端同口径；日界 = 凌晨 6 点，仅用于归属）----
function bjToday() { return new Date(Date.now() + 28800000).toISOString().slice(0, 10); }
/** 逻辑今天 = 红线所在日（6:00 日界：now 减 6h 再取日串；凌晨归前一天）。
 *  「今天」标注与初始居中日都用它——行归属是固定日界，与轴内容无关，
 *  故红线恒不晚于本行（次日行窗口起点 ≥ 24h 偏移，now 到不了）。 */
function schedLogicalToday() { return new Date(Date.now() + 28800000 - 21600000).toISOString().slice(0, 10); }
function schedAddDays(day, n) {
  return new Date(Date.parse(day + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}
function schedDayStartTs(day) { return Math.floor(Date.parse(day + 'T06:00:00+08:00') / 1000); }
/** 仍在播：后端显式 live；旧 demo 夹具/缓存没有该字段时按 endTs=null 推断 */
function schedIsLive(e) {
  return e.live !== undefined ? !!e.live : (e.endTs === null || e.endTs === undefined);
}
/** 未观测下播（停机/断轮询）：有开播但既不在播也没拿到真实 endTs */
function schedUnknownEnd(e) {
  return !schedIsLive(e) && (e.endTs === null || e.endTs === undefined);
}
/** 最后一轮确认在播的时刻（未知下播的收口点，不是下播时间）；无打点旧场退回开播 */
function schedCutTs(e) {
  return e.lastLiveTs !== null && e.lastLiveTs !== undefined ? e.lastLiveTs : e.startTs;
}
/**
 * 场次的有效终点：真实下播后 = endTs；在播中 = max(now, startTs + 7200) + 1800——
 * 假定至少播 2 小时，尾端再加 30 分钟渐变散尾区（齐头散尾；将来的直播预告条同样式）。
 * 未知下播 = lastLiveTs + 1800：从最后一次在播观测起散尾，不假定它又播了多久。
 * 仅装箱 / 绘制使用（纯绘制层假设）；共享轴见 recomputeSchedAxis。
 */
function schedEffEnd(e, now) {
  if (e.endTs !== null && e.endTs !== undefined) return e.endTs;
  if (schedIsLive(e)) return Math.max(now, e.startTs + 7200) + 1800;
  return schedCutTs(e) + 1800;
}
function schedFmtHm(ts) {
  var d = new Date(ts * 1000 + 28800000);
  var h = d.getUTCHours(), m = d.getUTCMinutes();
  return (h < 10 ? '0' + h : String(h)) + ':' + (m < 10 ? '0' + m : String(m));
}
/** 日标签拆段：{ d: 'M月D日', w: '周X' }，供行内悬浮胶囊（.sched-day-pill）拼装 */
function schedDayParts(date) {
  var p = date.split('-');
  var wd = new Date(Date.parse(date + 'T12:00:00Z')).getUTCDay();
  return { d: Number(p[1]) + '月' + Number(p[2]) + '日', w: '周' + '日一二三四五六'.charAt(wd) };
}

// ---- 颜色：h/s 由来源决定，亮度随主题（亮色 70% / 暗色 40%）----
// 头像平均色取 h/s（s 开根号提饱和）；头像获取不到回退哈希色（s=50）；未算出前占位灰（s=0）。
// 存 {h, s} 而非成品色串，主题切换只改亮度重渲，不用重算头像。
// v2 平移后全站浅色单主题（style.css 无深色段），亮度恒走亮色 70%；
// 恢复深色主题时把下面一行改回 matchMedia 探测即可（监听与重渲机制保留）。
function schedIsDark() { return false; }
function schedL() { return schedIsDark() ? 40 : 70; }
function schedHsl(h, s, l) { return 'hsl(' + h + ',' + s + '%,' + (l === undefined ? schedL() : l) + '%)'; }
function schedHashHS(uid) {
  var h = 0;
  var s = String(uid);
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return { h: h % 360, s: 50 };
}
/** uid → {h, s}：头像平均色 / 哈希（头像获取不到）/ 灰（未算出） */
function schedHSOf(uid) {
  var c = schedColors[uid];
  if (c) return { h: c.h, s: c.s };
  if (c === null) return schedHashHS(uid); // 头像获取不到 → 哈希色
  return { h: 0, s: 0 };                    // 未算出 → 占位灰
}
function schedColorOf(uid) { var hs = schedHSOf(uid); return schedHsl(hs.h, hs.s); }
/** 暗色模式条内文字：与条同色系，亮度提到 90%（阴影由 style.css 暗色规则去掉） */
function schedTextColorOf(uid) { var hs = schedHSOf(uid); return schedHsl(hs.h, hs.s, 90); }
/** 亮色模式条内文字阴影：与条同色系加深（l=20%），替代通用黑色阴影 */
function schedTextShadowOf(uid) { var hs = schedHSOf(uid); return '0 0 3px hsl(' + hs.h + ',' + hs.s + '%,20%)'; }
/** 同场分段间的分割线：同色系，亮度取条底与文字之间的中间档（亮/暗模式都可见） */
function schedDividerOf(uid) { var hs = schedHSOf(uid); return 'hsl(' + hs.h + ',' + hs.s + '%,55%)'; }
/** 段间竖分割线（标题/分区切换边界）并入条背景层：每层 = L% 处 1px 竖线渐变。
 *  画在 ::before 背景里随 border-radius 裁切——落在条圆角边缘的分界线不伸出颜色区域，
 *  在播条随 mask 一起散尾。与文字层分离，文字保持可向右溢出（设计），互不影响 */
function schedDividerLayers(bar) {
  var gspan = bar.end - bar.start;
  var color = schedDividerOf(bar.uid);
  var s = '';
  for (var i = 1; i < bar.parts.length; i++) {
    var l = Math.round(((bar.parts[i].start - bar.start) / gspan) * 1000) / 10;
    s += 'linear-gradient(90deg, transparent ' + l + '%, ' + color + ' ' + l + '%, ' +
      color + ' calc(' + l + '% + 1px), transparent calc(' + l + '% + 1px)), ';
  }
  return s;
}
/** 条是否处于散尾态（is-fade class 与 --fade mask 共用同一判定）：在播散尾到 now、
 *  未知下播散尾到 lastLiveTs；几何终点都没越过散尾起点才画。 */
function schedBarFading(bar, now) {
  return (bar.live && bar.end > now && now > bar.start) ||
    (bar.unknown && bar.cut < bar.end);
}
/** 在播条散尾 mask（齐头散尾）：不透明到 p1%（红线处）→ 40% 半透平台到 p2%（开播满 2h 处）
 *  → 尾端线性渐变到全透（约 30 分钟宽度）。p1 == p2 时（已播超 2h）从红线直接散尾。
 *  将来的直播预告条（只有开播时间、无下播时间）复用同款散尾样式。 */
function schedFadeMask(bar, e, now) {
  var spanDs = bar.end - bar.start;
  var r1 = (Math.round(((now - bar.start) / spanDs) * 1000) / 10) + '%';
  var r2 = (Math.round(Math.min(100, ((Math.max(now, e.startTs + 7200) - bar.start) / spanDs) * 100) * 10) / 10) + '%';
  return 'linear-gradient(90deg, #000 ' + r1 + ', rgba(0,0,0,0.4) ' + r1 +
    ', rgba(0,0,0,0.4) ' + r2 + ', rgba(0,0,0,0) 100%)';
}
/** 未知下播的散尾 mask：不透明到最后一次在播观测（bar.cut），随后直接线性淡出，
 *  不套「至少播 2 小时」的平台——那是对仍在播的假设，停机后不该再假定还在播。 */
function schedCutFadeMask(bar) {
  var spanDs = bar.end - bar.start;
  var r = spanDs > 0 ? (bar.cut - bar.start) / spanDs : 1;
  r = Math.max(0, Math.min(1, r));
  r = Math.round(r * 1000) / 10 + '%';
  return 'linear-gradient(90deg, #000 ' + r + ', rgba(0,0,0,0.4) ' + r +
    ', rgba(0,0,0,0) 100%)';
}
function schedPrepareColor(uid, face) {
  if (!uid || schedColors[uid] !== undefined || schedColorPending[uid]) return;
  if (!face) { schedColors[uid] = null; return; } // 无头像 → 哈希色
  schedColorPending[uid] = true;
  var img = new Image();
  img.onload = function () {
    schedColorPending[uid] = false;
    var h = 0, sat = 0, ok = false;
    try {
      var cv = document.createElement('canvas');
      cv.width = 8; cv.height = 8;
      var g = cv.getContext('2d');
      g.drawImage(img, 0, 0, 8, 8);
      var data = g.getImageData(0, 0, 8, 8).data;
      var r = 0, gg = 0, b = 0, n = 0;
      for (var i = 0; i < data.length; i += 4) { r += data[i]; gg += data[i + 1]; b += data[i + 2]; n++; }
      r = r / n; gg = gg / n; b = b / n;
      // h/s 都取自己算出的平均色；s 开根号提饱和；平均色无彩度（灰）s=0 原样输出
      var mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), dd = mx - mn;
      if (dd > 0) {
        if (mx === r) h = ((gg - b) / dd) % 6;
        else if (mx === gg) h = ((b - r) / dd) + 2;
        else h = ((r - gg) / dd) + 4;
        h = Math.round(h * 60);
        if (h < 0) h += 360;
        // 标准 HSL 饱和度（按平均色的实际亮度折算），开根号提饱和（0.25→0.5、0.49→0.7）
        if ((mx + mn) / 510 <= 0.5) sat = dd / (mx + mn);
        else sat = dd / (510 - mx - mn);
        sat = Math.round(Math.sqrt(sat) * 100);
      }
      ok = true;
    } catch (e) { /* CORS 污染画布等 → 哈希色 */ }
    schedColors[uid] = ok ? { h: h, s: sat } : null;
    renderSchedBody();
  };
  img.onerror = function () {
    schedColorPending[uid] = false;
    schedColors[uid] = null; // 头像拉取失败 → 哈希色
    renderSchedBody();
  };
  // 远程头像（B站图床无 CORS）走 /api/avatar 同源反代；同源头像（demo 夹具把头像
  // 本地化为 demo/avatars/* 站点相对路径）直连即可，本地图不污染画布
  img.src = /^https?:/i.test(face) ? '/api/avatar?uid=' + encodeURIComponent(uid) : face;
}
function schedPrepareColors(days) {
  for (var i = 0; i < days.length; i++) {
    var es = days[i].entries;
    for (var j = 0; j < es.length; j++) schedPrepareColor(es[j].uid, es[j].face);
  }
}

// ---- 窗口加载：center ± 2 天一次请求；dir = 'future'（内容上移进场）/ 'past'（下移）----
function schedFetch(from, to) {
  return api('/api/schedule?from=' + from + '&to=' + to).then(function (j) {
    var service = j.service || {};
    return {
      days: j.days || [],
      online: Array.isArray(service.online) ? service.online : [],
      trackedFrom: typeof service.trackedFrom === 'number' ? service.trackedFrom : null,
    };
  });
}

/** 应用一窗数据（days + 服务在线区间），颜色按 uid 缓存复用 */
function schedApplyData(data) {
  schedDays = data.days || [];
  schedOnline = (data.online || []).slice().sort(function (a, b) { return a.startTs - b.startTs; });
  schedTrackedFrom = data.trackedFrom == null ? null : data.trackedFrom;
  schedPrepareColors(schedDays);
}

// ---- 服务离线灰底：行窗口 [winStart, winEnd) 减去服务在线区间；trackedFrom 之前不画 ----
var SCHED_OFFLINE_FILL = 'rgba(15,23,42,.065)';

/** 生成行内离线时段的硬边渐变（透明 = 在线，灰 = 离线）；无记录/无离线段返回空串 */
function schedOfflineGradient(winStart, winEnd, now) {
  if (schedTrackedFrom == null) return '';
  var start = Math.max(winStart, schedTrackedFrom);
  var end = Math.min(winEnd, now); // 未来时段不画灰
  if (end <= start) return '';
  var cursor = start;
  var gaps = [];
  for (var i = 0; i < schedOnline.length; i++) {
    var a = Math.max(schedOnline[i].startTs, start);
    var b = Math.min(schedOnline[i].endTs, end);
    if (b <= cursor) continue;
    if (a > cursor) gaps.push([cursor, a]);
    if (b > cursor) cursor = b;
    if (cursor >= end) break;
  }
  if (cursor < end) gaps.push([cursor, end]);
  if (gaps.length === 0) return '';
  var span = winEnd - winStart;
  var stops = [];
  for (var j = 0; j < gaps.length; j++) {
    var l = ((gaps[j][0] - winStart) / span) * 100;
    var r = ((gaps[j][1] - winStart) / span) * 100;
    if (r <= l) continue;
    stops.push(
      'transparent ' + l.toFixed(4) + '%',
      SCHED_OFFLINE_FILL + ' ' + l.toFixed(4) + '%',
      SCHED_OFFLINE_FILL + ' ' + r.toFixed(4) + '%',
      'transparent ' + r.toFixed(4) + '%',
    );
  }
  return stops.length === 0 ? '' : 'linear-gradient(90deg, ' + stops.join(', ') + ')';
}

/** 把离线灰底铺到行泳道容器（背景层，条与日标签画在其上） */
function schedPaintOffline(lanesEl, winStart, winEnd, now) {
  var bg = schedOfflineGradient(winStart, winEnd, now);
  if (bg) {
    lanesEl.style.backgroundImage = bg;
    lanesEl.style.backgroundRepeat = 'no-repeat';
    lanesEl.style.backgroundSize = '100% 100%';
  } else {
    lanesEl.style.backgroundImage = '';
  }
}

// ---- 相邻窗口预取缓存：当前窗口加载完成后，后台预取 ±1 步的窗口。滚动步进命中缓存时
// 立即渲染（折叠/展开动画不被数据加载延迟打断，否则先停顿再猛地一齐动 = 跳闪），
// 同时后台重取纠偏。缓存只留 center ±3 步内，防长期滚动无限增长 ----
var schedWinCache = {};      // 'from_to' → {days, online, trackedFrom}
var schedWinFetching = {};   // key → true（预取在途去重）

function schedCacheKey(from, to) { return from + '_' + to; }

/** 预取一个窗口（未缓存且不在途才发请求） */
function schedPrefetchWindow(from, to) {
  var key = schedCacheKey(from, to);
  if (schedWinCache[key] || schedWinFetching[key]) return;
  schedWinFetching[key] = true;
  schedFetch(from, to).then(function (data) {
    schedWinFetching[key] = false;
    schedWinCache[key] = data;
  }).catch(function () { schedWinFetching[key] = false; }); // 预取失败静默，滚过去时正常加载
}

/** 预取 center ±1 步的两个相邻窗口 */
function schedPrefetchAdjacent(center) {
  schedPrefetchWindow(schedAddDays(center, -3), schedAddDays(center, 1));
  schedPrefetchWindow(schedAddDays(center, -1), schedAddDays(center, 3));
}

/** 修剪缓存：只留当前 center ±3 步内的窗口 */
function schedPruneCache() {
  if (!schedCenter) return;
  var keep = {};
  for (var n = -3; n <= 3; n++) {
    keep[schedCacheKey(schedAddDays(schedCenter, n - 2), schedAddDays(schedCenter, n + 2))] = true;
  }
  for (var k in schedWinCache) if (!keep[k]) delete schedWinCache[k];
}

function schedLoad(center) {
  var seq = ++schedSeq;
  var from = schedAddDays(center, -2), to = schedAddDays(center, 2);
  var key = schedCacheKey(from, to);
  var cached = schedWinCache[key];
  if (cached) {
    // 命中预取缓存：立即渲染（动画即时连贯），随后后台重取纠偏——内容有变化才重渲
    //（新几何照旧走 CSS 过渡，不硬切）
    schedCenter = center;
    schedApplyData(cached);
    recomputeSchedAxis();
    renderSched();
    schedPruneCache();
    schedPrefetchAdjacent(center);
    schedFetch(from, to).then(function (data) {
      if (seq !== schedSeq) return; // 用户又滚走了，纠偏结果只进缓存
      schedWinCache[key] = data;
      if (JSON.stringify(data) === JSON.stringify(cached)) return; // 无变化不重渲（防二次闪动）
      schedApplyData(data);
      recomputeSchedAxis();
      renderSched();
    }).catch(function () { /* 纠偏失败忽略，60s 保鲜周期再试 */ });
    return;
  }
  schedFetch(from, to).then(function (data) {
    if (seq !== schedSeq) return; // 已有更新的请求在路上，作废旧渲染
    schedCenter = center;
    schedApplyData(data);
    recomputeSchedAxis(); // center 变化时重算；轴变化只改几何（reconcile 原地更新），不整窗重画
    renderSched();
    schedWinCache[key] = data;
    schedPruneCache();
    schedPrefetchAdjacent(center);
  }).catch(function (e) {
    if (seq === schedSeq) toast(e.message, true);
  });
}

ACTIONS['sched-center'] = function (el) {
  var date = el.getAttribute('data-date');
  if (!date || !schedCenter || date === schedCenter) return;
  schedLoad(date);
};

function schedStep(n) {
  if (!schedCenter) return;
  var next = schedAddDays(schedCenter, n);
  schedLoad(next);
}

/** 周期数据保鲜：重取当前窗口数据（在播场下播后拿到真实 endTs；停机后已结束的场次
 *  从在播变成未知下播，横条改画散尾），再重算轴 + 重渲。颜色按 uid 缓存复用，不重复拉头像。
 *  与 schedLoad 共用 schedSeq 作废机制：用户滚动导航时更新 seq，本刷新结果自然丢弃。 */
function schedRefreshData() {
  if (!schedCenter) return;
  var seq = ++schedSeq;
  var from = schedAddDays(schedCenter, -2), to = schedAddDays(schedCenter, 2);
  schedFetch(from, to).then(function (data) {
    if (seq !== schedSeq) return; // 已有更新的请求在路上，作废本次刷新
    schedApplyData(data);
    schedWinCache[schedCacheKey(from, to)] = data; // 保鲜结果同步进预取缓存，滚动回去不拿到旧数据
    recomputeSchedAxis();
    renderSched();
  }).catch(function () { /* 瞬时失败忽略，下个周期再试 */ });
}

// ---- 共享轴：按当前可见全部 5 天的实际内容算定（缩略行也在视野内，同样参与）；
// 在播场终点用真实 now，未观测下播用 lastLiveTs + 30min 散尾区（2h 假设只属于绘制层）；
// 返回轴是否变化 ----
function recomputeSchedAxis() {
  var now = Math.floor(Date.now() / 1000);
  var minOff = -1, maxOff = 0;
  for (var i = 0; i < schedDays.length; i++) {
    // 每天先换算成相对自己归属日 06:00 的偏移（offE 可 > 24h），再合并取轴
    var base = schedDayStartTs(schedDays[i].date);
    var es = schedDays[i].entries;
    for (var j = 0; j < es.length; j++) {
      var e = es[j];
      var offS = e.startTs - base;
      var offE;
      if (e.endTs !== null && e.endTs !== undefined) offE = e.endTs - base;
      else if (schedIsLive(e)) offE = now - base;
      else offE = schedCutTs(e) + 1800 - base; // 未知下播：给散尾区留出行内空间
      if (minOff < 0 || offS < minOff) minOff = offS;
      if (offE > maxOff) maxOff = offE;
    }
  }
  if (minOff < 0) {
    // 空窗口：06:00 起 24h 全轴
    if (schedAxis && schedAxis.offStart === 0 && schedAxis.offEnd === 86400) return false;
    schedAxis = { offStart: 0, offEnd: 86400 };
    return true;
  }
  var offStart = Math.floor(minOff / 3600) * 3600;
  var offEnd = Math.min(offStart + 86400, Math.ceil(maxOff / 3600) * 3600);
  if (offEnd <= offStart) offEnd = offStart + 3600;
  if (schedAxis && schedAxis.offStart === offStart && schedAxis.offEnd === offEnd) return false;
  schedAxis = { offStart: offStart, offEnd: offEnd };
  return true;
}

/** 一行窗口是否包含 now（[winStart, winEnd)；相邻窗口不重叠，至多一行命中） */
function schedRowHasNow(day, now) {
  var base = schedDayStartTs(day);
  return now >= base + schedAxis.offStart && now < base + schedAxis.offEnd;
}

/** now 是否落在某行的窗口内（60s 定时器红线刷新用；缩略行也画红线） */
function schedNowInRow() {
  if (!schedCenter || !schedAxis) return false;
  var now = Math.floor(Date.now() / 1000);
  for (var i = 0; i < schedDays.length; i++) {
    if (schedRowHasNow(schedDays[i].date, now)) return true;
  }
  return false;
}

/** 全量行内是否有在播场次（60s 定时器用：有才需要重渲染推进右端） */
function schedHasLive() {
  var now = Math.floor(Date.now() / 1000);
  var miniFrom = schedAddDays(schedCenter, -2), miniTo = schedAddDays(schedCenter, 2);
  for (var i = 0; i < schedDays.length; i++) {
    var dd = schedDays[i].date;
    if (dd === miniFrom || dd === miniTo) continue;
    var winStart = schedDayStartTs(dd) + schedAxis.offStart;
    var winEnd = schedDayStartTs(dd) + schedAxis.offEnd;
    // 候选 = 当天 + 前一天 entries（在播场的溢出段落在本行窗口内也算）
    for (var k = i - 1; k <= i; k++) {
      if (k < 0) continue;
      var es = schedDays[k].entries;
      for (var j = 0; j < es.length; j++) {
        var e = es[j];
        // 在播 = [startTs, 绘制终点 schedEffEnd)，与行窗口有交集才算（未知下播不推进右端）
        if (schedIsLive(e) && e.startTs < winEnd && schedEffEnd(e, now) > winStart) return true;
      }
    }
  }
  return false;
}

// ---- 渲染 ----
function renderSched() {
  renderSchedAxis();
  renderSchedBody();
}

/** 重新解算行高（窗口缩放 / 视图从隐藏切回时调用；几何目标没变时无副作用、无闪动） */
export function schedRelayout() {
  if (!schedCenter || schedDays.length === 0 || !schedAxis) return;
  renderSchedBody();
}

function renderSchedAxis() {
  var el = document.getElementById('schedule-axis');
  var span = schedAxis ? schedAxis.offEnd - schedAxis.offStart : 0;
  if (span <= 0) { el.innerHTML = ''; return; }
  // 刻度标签 = 时钟时间，用今天的日界作参考换算（偏移语义下任意参考日都一样）
  var ref = schedDayStartTs(bjToday());
  var labelEvery = span > 12 * 3600 ? 2 : 1;
  var hours = Math.floor(span / 3600);
  var html = '';
  // 刻度 = 单元素（时间胶囊 <b> + 刻度小竖条 <i>），axis 底缘为虚线基线（见 style.css）
  for (var h = 0; h <= hours; h++) {
    var pct = (h * 3600 / span) * 100;
    var labeled = h % labelEvery === 0 && h < hours;
    html += '<span class="sched-tick' + (h === 0 ? ' edge-l' : '') + '" style="left:' + pct + '%">' +
      (labeled ? '<b>' + schedFmtHm(ref + schedAxis.offStart + h * 3600) + '</b>' : '') +
      '<i></i></span>';
  }
  el.innerHTML = html;
}

/**
 * 一天的条装箱：候选 = 当天 entries + 前一天 entries（通宵场溢出段接续绘制：
 * 归属日行画到该行窗口右端，次日行从其窗口左起接续，相邻窗口首尾相接故无缝）。
 * 装箱窗口 == 绘制窗口 = 当天 06:00 + [offStart, offEnd]（可延伸到次日白天）。
 * 末段在播的绘制终点带「假定 2h + 30min 散尾」假设；未知下播带「lastLiveTs + 30min
 * 散尾」假设（schedEffEnd，纯绘制层）；非末段缺 endTs 不至于发生，兜底 e.endTs ?? now。
 * 先按段生成 bar，再把**同场相邻分段（同 rid+lt 且首尾相接）合并为一个视觉组**
 * （schedMergeSegments：整场画成单个圆角矩形，组内 parts 只负责文字，段间竖分割线
 *  并入条 ::before 背景层〔schedDividerLayers，随圆角裁切不伸出颜色区域〕，
 * 首/末段再窄也不破坏圆角）。装箱按 **uid 分组整体放置**（同主播当天多场 +
 * 其前一天溢出段同组，永远同泳道；这会故意增加泳道数，是明确选择）：组按最早
 * start 排序，逐组放入第一条「该组所有 bar 与泳道已有 bar 全不相交」的泳道，
 * 都冲突才开新泳道。防御：同主播不同场重叠（数据异常）退化为逐段独立装箱。
 * 返回泳道数组（元素 = 组数组，道内按 start 排序）。
 */
function packSchedLanes(dayIdx) {
  var day = schedDays[dayIdx];
  var now = Math.floor(Date.now() / 1000);
  var dayStart = schedDayStartTs(day.date);
  var winStart = dayStart + schedAxis.offStart;
  var winEnd = dayStart + schedAxis.offEnd;
  var bars = [];
  var cand = [];
  var j;
  for (j = 0; j < day.entries.length; j++) cand.push({ di: dayIdx, ei: j, e: day.entries[j] });
  if (dayIdx > 0) {
    var prev = schedDays[dayIdx - 1];
    for (j = 0; j < prev.entries.length; j++) cand.push({ di: dayIdx - 1, ei: j, e: prev.entries[j] });
  }
  for (var c = 0; c < cand.length; c++) {
    var item = cand[c];
    var e = item.e;
    var effEnd = schedEffEnd(e, now); // 末段在播/未知下播的绘制终点（含散尾假设）
    var lastSci = e.segments.length - 1;
    for (var s = 0; s < e.segments.length; s++) {
      var seg = e.segments[s];
      var lastSeg = s === lastSci;
      var live = lastSeg && schedIsLive(e);
      var unknown = lastSeg && schedUnknownEnd(e);
      var segEnd = seg.endTs || (live || unknown ? effEnd : (e.endTs || now));
      var a = Math.max(seg.startTs, winStart);
      var b = Math.min(segEnd, winEnd);
      if (b <= a) continue; // 与行窗口无交集
      bars.push({
        start: a, end: b,
        di: item.di, ei: item.ei, si: s, uid: e.uid,
        rid: e.roomId, lt: e.liveTime,
        live: live, unknown: unknown, cut: unknown ? schedCutTs(e) : null,
      });
    }
  }
  bars.sort(function (x, y) { return x.start - y.start || x.end - y.end; });
  // 按 uid 分组（同主播当天多场 + 其前一天溢出段同组 → 同泳道）；组内保持 start 升序
  var groupByUid = {};
  for (var g = 0; g < bars.length; g++) {
    var u = String(bars[g].uid);
    (groupByUid[u] || (groupByUid[u] = [])).push(bars[g]);
  }
  var units = [];
  for (var key in groupByUid) {
    var grp = groupByUid[key];
    var groups = schedMergeSegments(grp);
    // 防御：同主播不同场重叠（数据异常）→ 退化为逐段独立装箱（各段自成一个单段组）
    var bad = false;
    for (var m = 0; m < groups.length && !bad; m++) {
      for (var n = m + 1; n < groups.length; n++) {
        if (groups[m].start < groups[n].end && groups[n].start < groups[m].end) { bad = true; break; }
      }
    }
    if (bad) {
      for (var q = 0; q < groups.length; q++) {
        for (var p2 = 0; p2 < groups[q].parts.length; p2++) {
          var pt = groups[q].parts[p2];
          units.push([{
            start: pt.start, end: pt.end,
            di: groups[q].di, ei: groups[q].ei, uid: groups[q].uid,
            rid: groups[q].rid, lt: groups[q].lt, live: pt.live,
            unknown: groups[q].unknown && p2 === groups[q].parts.length - 1,
            cut: groups[q].cut,
            parts: [pt],
          }]);
        }
      }
    } else {
      units.push(groups);
    }
  }
  units.sort(function (x, y) { return x[0].start - y[0].start || x[0].end - y[0].end; });
  // 逐组放入第一条「组内所有 bar 与泳道已有 bar 全不相交」的泳道，都冲突开新泳道
  var lanes = [];
  for (var w = 0; w < units.length; w++) {
    var unit = units[w];
    var placed = false;
    for (var L = 0; L < lanes.length; L++) {
      if (schedUnitFitsLane(unit, lanes[L])) {
        for (var t = 0; t < unit.length; t++) lanes[L].push(unit[t]);
        placed = true;
        break;
      }
    }
    if (!placed) lanes.push(unit.slice());
  }
  for (var r = 0; r < lanes.length; r++) {
    lanes[r].sort(function (x, y) { return x.start - y.start || x.end - y.end; });
  }
  return lanes;
}

/** 同场相邻分段（同 rid+lt 且首尾相接）合并为一个视觉组；parts 为组内分段（保持 start 升序）。
 * 不同场穿插时按「该场最近一个组」续接（lastBySession），不依赖数组相邻。 */
function schedMergeSegments(bars) {
  var groups = [];
  var lastBySession = {}; // rid:lt → 该场最近一个组的下标
  for (var i = 0; i < bars.length; i++) {
    var b = bars[i];
    var skey = b.rid + ':' + b.lt;
    var gi = lastBySession[skey];
    var prev = gi !== undefined ? groups[gi] : null;
    if (prev && prev.end === b.start) {
      prev.parts.push({ si: b.si, start: b.start, end: b.end, live: b.live });
      prev.end = b.end;
      if (b.live) prev.live = true;
      if (b.unknown) { prev.unknown = true; prev.cut = b.cut; }
    } else {
      groups.push({
        start: b.start, end: b.end,
        di: b.di, ei: b.ei, uid: b.uid, rid: b.rid, lt: b.lt,
        live: b.live, unknown: b.unknown, cut: b.cut,
        parts: [{ si: b.si, start: b.start, end: b.end, live: b.live }],
      });
      lastBySession[skey] = groups.length - 1;
    }
  }
  return groups;
}

/** 一组 bar 是否与泳道内已有 bar 全不相交（区间相交 = a.start < b.end && b.start < a.end） */
function schedUnitFitsLane(unit, lane) {
  for (var i = 0; i < unit.length; i++) {
    for (var j = 0; j < lane.length; j++) {
      if (unit[i].start < lane[j].end && lane[j].start < unit[i].end) return false;
    }
  }
  return true;
}

function renderSchedBody() {
  var body = document.getElementById('schedule-body');
  schedHidePop();
  if (!schedCenter || schedDays.length === 0) {
    body.innerHTML = '<p class="hint">加载中…</p>';
    return;
  }
  var span = schedAxis.offEnd - schedAxis.offStart;
  var now = Math.floor(Date.now() / 1000);
  // 逐日装箱一次（降级判定与泳道 reconcile 共用，不重复装箱）
  var lanesByDay = [];
  for (var p = 0; p < schedDays.length; p++) lanesByDay.push(packSchedLanes(p));
  // 空间连每道下限都放不下时按步降级（schedLevelFor）；clientHeight 为 0（视图隐藏）
  // 时保持上次降级级别——不切级别毁掉 DOM 行，切回视图时 schedRelayout 会重算
  var availH = body.clientHeight;
  if (availH > 0) {
    schedDegrade = 0;
    while (schedDegrade < 3 && !schedFits(schedDegrade, lanesByDay, availH)) schedDegrade++;
  }
  // 是否已有行：首载（无行）先清掉初始「加载中…」文本，且新行直接以自然高度呈现
  var hadDays = body.querySelector('.sched-day') != null;
  if (!hadDays) body.textContent = '';
  // 始终走原地 reconcile：泳道/条按 key 复用、只更新几何与文字，元素不销毁 →
  // 道高、透明度、字层的 CSS 过渡每次滚动都照常触发（不整窗重画、不硬切）
  var targetDates = [];
  for (var d = 0; d < schedDays.length; d++) {
    if (schedLevelFor(schedDays[d].date, schedDegrade)) targetDates.push(schedDays[d].date);
  }
  // 先折叠不在窗口内（或被降级去掉）的旧行（高度过渡到 0 再移除，其余行随空间平滑伸缩）。
  // 已在折叠中的行跳过——头像色异步解析 / 60s 保鲜等中途重渲会走到这里，
  // 不跳过会每次重渲都从半途重新发起折叠（动画跳闪）
  var existing = body.querySelectorAll('.sched-day');
  for (var i = 0; i < existing.length; i++) {
    var ex = existing[i];
    var exDate = ex.getAttribute('data-date');
    if (targetDates.indexOf(exDate) < 0 && ex.parentNode && !schedCollapsing[exDate]) schedCollapseDay(ex);
  }
  // 逐日更新 / 新建：重叠行原地不动（含折叠中的行），新进场行按日期插入到正确位置
  for (var d2 = 0; d2 < schedDays.length; d2++) {
    var day = schedDays[d2];
    var level = schedLevelFor(day.date, schedDegrade);
    if (!level) continue; // 降级去掉的天：不在 targetDates 里，既有行已在上面发起折叠
    var el = body.querySelector('.sched-day[data-date="' + day.date + '"]');
    var created = false;
    if (!el) {
      el = document.createElement('div');
      el.setAttribute('data-date', day.date);
      created = true;
    } else if (schedCollapsing[day.date]) {
      delete schedCollapsing[day.date]; // 折叠中又滚回来了：取消离场（basis px 从当前位置连续滑回目标）
      schedExpanding[day.date] = true;  // 视为重新展开：margin/opacity 回目标，overflow 到位后才恢复可见
      el.style.margin = '';
      el.style.opacity = '1';
      (function (row) {
        setTimeout(function () {
          delete schedExpanding[row.getAttribute('data-date')];
          row.style.overflow = '';
        }, 320);
      })(el);
    }
    updateSchedDay(el, day, level, span, now, lanesByDay[d2]);
    if (created) {
      // 按日期找插入点（第一个日期更大的行之前；找不到 = 追加末尾），不移动既有行
      var anchor = null;
      var child = body.firstChild;
      while (child) {
        var cd = child.getAttribute ? child.getAttribute('data-date') : null;
        if (cd && cd > day.date) { anchor = child; break; }
        child = child.nextSibling;
      }
      body.insertBefore(el, anchor);
      // 新进场行：从 0 高度展开（首载直接自然高度，滚动时才过渡）
      if (hadDays) schedExpandDay(el);
    }
  }
  // 高度统一解算：所有行 basis px → px 过渡（含折叠中的行滑向 0、新行从 0 展开）
  schedSolveHeights(body);
}

function updateSchedDay(el, day, level, span, now, lanes) {
  // 复用行清除可能残留的折叠内联样式（滚动折返重新入场时恢复自然状态）。
  // 正在展开进场的行不清（清 overflow 会让内容在中途重渲时溢出短行外 = 跳闪）
  if (!schedExpanding[el.getAttribute('data-date')]) {
    el.style.margin = '';
    el.style.opacity = '';
    el.style.overflow = '';
  }
  el.style.flexGrow = '0';   // 高度全由解算器出 basis 像素值，grow/shrink 恒 0
  el.style.flexShrink = '0';
  var winStart = schedDayStartTs(day.date) + schedAxis.offStart;
  var winEnd = winStart + span;
  // 当前时间红线跟随行窗口：now 落在本行窗口内才画（相邻窗口不重叠，至多一行命中；
  // 行窗口外的空档不画；缩略行也画红线，今天滚到首末天时红线不消失）
  var nowPct = schedRowHasNow(day.date, now) ? ((now - winStart) / span) * 100 : -1;
  // 行级 class 驱动条透明度 / 字层的 CSS 过渡（不再驱动道高）
  el.className = 'sched-day ' + level;
  if (day.date === schedCenter) el.removeAttribute('data-action');
  else el.setAttribute('data-action', 'sched-center');
  var lanesEl = el.querySelector('.sched-lanes');
  if (!lanesEl) { lanesEl = document.createElement('div'); lanesEl.className = 'sched-lanes'; el.appendChild(lanesEl); }
  // 日标签 = 行内悬浮胶囊（不占左侧日头列；pointer-events 穿透，不挡条的 hover/点击）；
  // 行按 data-date 复用、日期不变，文本有变化才写
  var pill = lanesEl.querySelector('.sched-day-pill');
  if (!pill) { pill = document.createElement('span'); pill.className = 'sched-day-pill'; lanesEl.appendChild(pill); }
  var parts = schedDayParts(day.date);
  // 「今天/昨天」前缀：逻辑日 = 红线所在行；0-6 点时逻辑日是真实昨天，如实写「昨天」
  var schedLogical = schedLogicalToday();
  var dayPrefix = day.date === schedLogical ? (schedLogical === bjToday() ? '今天 · ' : '昨天 · ') : '';
  var pillHtml = '<b>' + dayPrefix + parts.d + '</b><span>' + parts.w + '</span>';
  if (pill.innerHTML !== pillHtml) pill.innerHTML = pillHtml;
  // 服务离线时段铺灰底（背景层，条与日标签在其上）；trackedFrom 之前不画
  schedPaintOffline(lanesEl, winStart, winEnd, now);
  // 级别与道数挂在元素上，供 schedSolveHeights 解算像素高度
  el._schedLevel = level;
  el._schedLanes = reconcileSchedLanes(lanesEl, now, winStart, span, lanes);
  // 红线挂在 .sched-lanes 内（absolute 定位上下文），不能挂到 .sched-day 上（会飞出）
  var nowEl = lanesEl.querySelector('.sched-now');
  if (nowPct >= 0) {
    if (!nowEl) { nowEl = document.createElement('span'); nowEl.className = 'sched-now'; lanesEl.appendChild(nowEl); }
    nowEl.style.left = nowPct + '%';
  } else if (nowEl && nowEl.parentNode) {
    nowEl.parentNode.removeChild(nowEl);
  }
}

/** 应用一行解算出的目标高度：basis 恒为像素值（grow/shrink 恒 0），目标变化即
 *  basis px→px 的 CSS 过渡；目标没变就不碰样式（进行中的过渡不被打断） */
function schedApplyDayPx(el, px) {
  px = Math.round(px);
  if (el._schedPx === px) return;
  el._schedPx = px;
  el.style.flexBasis = px + 'px';
}

/** 一天的显示级别（degrade = 空间降级步数，空间不足时逐级省空间）：
 *  0 = 原级（首末天 mini / 相邻天 single / 当天 center）
 *  1 = 去掉首末两天（返回 null = 不显示，只留三天）
 *  2 = 相邻两天再降为 mini 条
 *  3 = 当天也降为单行条 */
function schedLevelFor(date, degrade) {
  var miniFrom = schedAddDays(schedCenter, -2), miniTo = schedAddDays(schedCenter, 2);
  var lv = (date === miniFrom || date === miniTo) ? 'mini' : (date === schedCenter ? 'center' : 'single');
  if (degrade >= 1 && lv === 'mini') return null;
  if (degrade >= 2 && lv === 'single') return 'mini';
  if (degrade >= 3 && lv === 'center') return 'single';
  return lv;
}

/** 该降级步数下「各行每道下限 + 行间距」是否还放得下（与 schedSolveHeights 同口径：
 *  mini 道 5px+间距 1px、single/center 每道下限 16/32px、行间距 20px、道数不足 10 补空） */
function schedFits(degrade, lanesByDay, availH) {
  var total = 0, count = 0;
  for (var i = 0; i < schedDays.length; i++) {
    var lv = schedLevelFor(schedDays[i].date, degrade);
    if (!lv) continue;
    count++;
    var lc = Math.max(10, lanesByDay[i].length);
    if (lv === 'mini') total += lc * 5 + Math.max(0, lc - 1);
    else total += lc * (lv === 'center' ? 32 : 16);
  }
  return total + 20 * count <= availH;
}

/** 高度统一解算（水装填法）：mini 日固定窄条（道 5px + 间距 1px）；single/center 日按
 * 「道数 × 级权重（1/2）」分配剩余高度，每道下限 single 16px / center 32px——低于下限
 * 的行钳到下限、余量重分给未钳行（迭代到收敛）；极端压缩（下限总和都放不下）时全钳
 * 下限，超出部分由 .sched-body 裁底（先经 schedLevelFor 三步降级仍放不下才到这里）。
 * 折叠中的行目标 0 不占空间；margin 目标每行 20px。
 * 因为 basis 恒为像素值，级别切换/道数变化/窗口缩放/日进出全是 px→px 连续过渡，
 * 无 class 硬跳、无 min-height 瞬弹 */
function schedSolveHeights(body) {
  var rows = body.querySelectorAll('.sched-day');
  var minis = [], items = [], miniPxSum = 0, visibleCount = 0;
  for (var i = 0; i < rows.length; i++) {
    var el = rows[i];
    if (schedCollapsing[el.getAttribute('data-date')]) continue; // 折叠中：目标 0
    visibleCount++;
    var lc = el._schedLanes || 10;
    if (el._schedLevel === 'mini') {
      var px = lc * 5 + Math.max(0, lc - 1);
      minis.push({ el: el, px: px });
      miniPxSum += px;
    } else {
      var center = el._schedLevel === 'center';
      items.push({ el: el, w: lc * (center ? 2 : 1), min: lc * (center ? 32 : 16) });
    }
  }
  var free = body.clientHeight - 20 * visibleCount - miniPxSum;
  // 水装填：权重分配，低于下限的钳住并从 free 扣除，余量重分给未钳行
  var pending = items.slice();
  for (;;) {
    if (pending.length === 0) break;
    var W = 0;
    for (var a = 0; a < pending.length; a++) W += pending[a].w;
    if (free <= 0) { // 极端压缩：余量没了，剩余行全钳下限
      for (var b = 0; b < pending.length; b++) pending[b].px = pending[b].min;
      break;
    }
    var clamped = [];
    for (var c = 0; c < pending.length; c++) {
      var it = pending[c];
      it.px = free * it.w / W;
      if (it.px < it.min) { it.px = it.min; free -= it.min; clamped.push(it); }
    }
    if (clamped.length === 0) break; // 全部高于下限，分配成立
    for (var d = 0; d < clamped.length; d++) pending.splice(pending.indexOf(clamped[d]), 1);
  }
  for (var m = 0; m < minis.length; m++) schedApplyDayPx(minis[m].el, minis[m].px);
  for (var k = 0; k < items.length; k++) schedApplyDayPx(items[k].el, items[k].px);
}

/** 折叠离场：basis 已是像素值，直接过渡到 0 + margin/opacity 收起，**高度到 0 后才移除**；
 *  其余天由解算器重新分配释放出的空间、同步伸展 */
function schedCollapseDay(el) {
  var date = el.getAttribute('data-date');
  schedCollapsing[date] = true;
  el.style.overflow = 'hidden'; // 折叠期裁剪内容（平时 overflow 可见，红线圆点要溢出到间距）
  el._schedPx = 0; // 记录目标 0：折返取消时解算器才能感知差异、从当前位置连续滑回
  el.style.flexBasis = '0px';
  el.style.margin = '0';
  el.style.opacity = '0';
  setTimeout(function () {
    if (!schedCollapsing[date]) return; // 折叠期间又滚回来了 → 已取消
    delete schedCollapsing[date];
    if (el.parentNode) el.parentNode.removeChild(el);
  }, 320);
}

/** 展开进场：**从 0 高度开始**——先写好 0 态并强制提交（元素首帧就是 0 高，看不到满高态），
 *  随后 renderSchedBody 末尾的解算器赋目标像素，basis 从 0 连续展开 */
function schedExpandDay(el) {
  schedExpanding[el.getAttribute('data-date')] = true;
  el.style.overflow = 'hidden'; // 展开期裁剪内容
  el.style.flexBasis = '0px';
  el.style.margin = '0';
  el.style.opacity = '0';
  void el.offsetHeight; // 提交 0 态
  el.style.margin = '';
  el.style.opacity = '1';
  setTimeout(function () {
    delete schedExpanding[el.getAttribute('data-date')];
    el.style.overflow = '';
  }, 320);
}

function schedBarKey(bar) { return bar.rid + ':' + bar.lt; }

/** 单场视觉组完整 HTML：外层 .sched-seg 是一个完整圆角矩形（背景在 ::before，--bar-bg 注入），
 * 内层 .sched-part 按段划分，只负责文字，不背背景（段间竖分割线并入 ::before 背景层，
 * 随圆角裁切）——首/末段再窄也不破坏圆角。 */
function schedGroupHtml(bar, now, winStart, span) {
  var e = schedDays[bar.di].entries[bar.ei];
  var left = ((bar.start - winStart) / span) * 100;
  var width = ((bar.end - bar.start) / span) * 100;
  // --bar-bg：条背景（::before 承载）；is-fade + --fade：在播/未知下播散尾条由 mask 整体淡出
  var fading = schedBarFading(bar, now);
  var fadeMask = fading ? (bar.unknown ? schedCutFadeMask(bar) : schedFadeMask(bar, e, now)) : '';
  var segStyle = 'left:' + left + '%;width:' + width + '%;--bar-bg:' +
    schedDividerLayers(bar) + schedColorOf(bar.uid) +
    (fading ? ';--fade:' + fadeMask : '');
  if (schedIsDark()) segStyle += ';color:' + schedTextColorOf(bar.uid); // 暗色文字同色系提亮
  var cls = 'sched-seg' + (fading ? ' is-fade' : '');
  var partsHtml = '';
  for (var i = 0; i < bar.parts.length; i++) partsHtml += schedPartHtml(bar, bar.parts[i], e, i === 0);
  return '<div class="' + cls + '"' +
    ' data-k="' + schedBarKey(bar) + '"' +
    ' data-edate="' + schedDays[bar.di].date + '" data-e="' + bar.ei + '"' +
    ' data-bs="' + bar.start + '" data-be="' + bar.end + '"' +
    ' style="' + segStyle + '">' + partsHtml + '</div>';
}

/** 组内一段：双行（.sched-part-two，center 显示）与单行（.sched-part-one，single 显示）两套字层。
 * 首段：主播名（双行第 1 行）+ 标题（第 2 行），单行 = 主播名 · 标题；后续段仅标题，
 * 主播名保留占位隐藏（visibility）保证双行标题仍停在第二行；首段名不截断、自然顺延。 */
function schedPartHtml(bar, part, e, isFirst) {
  var seg = e.segments[part.si];
  var gspan = bar.end - bar.start;
  var left = ((part.start - bar.start) / gspan) * 100;
  var width = ((part.end - part.start) / gspan) * 100;
  var partStyle = 'left:' + left + '%;width:' + width + '%'; // 段间竖分割线已并入条背景层（schedDividerLayers）
  var txtShadow = '';
  if (!schedIsDark()) txtShadow = ' style="text-shadow:' + schedTextShadowOf(bar.uid) + '"'; // 亮色同色系阴影
  var oneText = isFirst ? e.name + ' · ' + (seg.title || '') : (seg.title || '');
  var nameHidden = isFirst ? '' : ' style="visibility:hidden"';
  return '<div class="sched-part"' +
    ' data-edate="' + schedDays[bar.di].date + '" data-e="' + bar.ei + '" data-s="' + part.si + '"' +
    ' data-bs="' + part.start + '" data-be="' + part.end + '"' +
    ' style="' + partStyle + '">' +
    '<span class="sched-part-one"' + txtShadow + '>' + esc(oneText) + '</span>' +
    '<span class="sched-part-two"' + txtShadow + '>' +
    '<span class="sched-part-name"' + nameHidden + '>' + esc(e.name) + '</span>' +
    '<span class="sched-part-title">' + esc(seg.title || '') + '</span>' +
    '</span></div>';
}

/** 复用段时原地更新几何 / hover 数据与文字（textContent 保留字层 span） */
function schedApplyPart(partEl, bar, part, e, isFirst) {
  var seg = e.segments[part.si];
  var gspan = bar.end - bar.start;
  var left = ((part.start - bar.start) / gspan) * 100;
  var width = ((part.end - part.start) / gspan) * 100;
  partEl.style.left = left + '%';
  partEl.style.width = width + '%';
  partEl.setAttribute('data-edate', schedDays[bar.di].date);
  partEl.setAttribute('data-e', bar.ei);
  partEl.setAttribute('data-s', part.si);
  partEl.setAttribute('data-bs', part.start);
  partEl.setAttribute('data-be', part.end);
  var dark = schedIsDark();
  var oneEl = partEl.querySelector('.sched-part-one');
  if (oneEl) {
    oneEl.style.textShadow = dark ? 'none' : schedTextShadowOf(bar.uid);
    var oneText = isFirst ? e.name + ' · ' + (seg.title || '') : (seg.title || '');
    if (oneEl.textContent !== oneText) oneEl.textContent = oneText;
  }
  var twoEl = partEl.querySelector('.sched-part-two');
  if (twoEl) {
    twoEl.style.textShadow = dark ? 'none' : schedTextShadowOf(bar.uid);
    var nameEl = twoEl.querySelector('.sched-part-name');
    var titleEl = twoEl.querySelector('.sched-part-title');
    var title = seg.title || '';
    if (nameEl) {
      nameEl.style.visibility = isFirst ? '' : 'hidden'; // 非首段隐藏但保留占位（标题停在第二行）
      if (nameEl.textContent !== e.name) nameEl.textContent = e.name;
    }
    if (titleEl && titleEl.textContent !== title) titleEl.textContent = title;
  }
}

/** 复用视觉组时原地更新：组几何/背景/颜色 + reconcile 内部分段（按 data-s 复用） */
function schedApplyGroup(segEl, bar, now, winStart, span) {
  var e = schedDays[bar.di].entries[bar.ei];
  var left = ((bar.start - winStart) / span) * 100;
  var width = ((bar.end - bar.start) / span) * 100;
  segEl.setAttribute('data-edate', schedDays[bar.di].date);
  segEl.setAttribute('data-e', bar.ei);
  segEl.setAttribute('data-bs', bar.start);
  segEl.setAttribute('data-be', bar.end);
  segEl.style.left = left + '%';
  segEl.style.width = width + '%';
  segEl.style.setProperty('--bar-bg', schedDividerLayers(bar) + schedColorOf(bar.uid));
  var fading = schedBarFading(bar, now);
  if (fading) {
    segEl.style.setProperty('--fade', bar.unknown ? schedCutFadeMask(bar) : schedFadeMask(bar, e, now));
  } else {
    segEl.style.removeProperty('--fade');
  }
  segEl.classList.toggle('is-fade', fading); // 散尾条：::before 套 --fade mask
  segEl.style.color = schedIsDark() ? schedTextColorOf(bar.uid) : ''; // 暗色文字同色系提亮，亮色回落白字
  var existing = {};
  var oldParts = segEl.querySelectorAll('.sched-part');
  for (var i = 0; i < oldParts.length; i++) existing[oldParts[i].getAttribute('data-s')] = oldParts[i];
  var used = {};
  for (var p = 0; p < bar.parts.length; p++) {
    var part = bar.parts[p];
    var si = String(part.si);
    var partEl = existing[si] && !used[si] ? existing[si] : null;
    if (!partEl) {
      var tmp = document.createElement('div');
      tmp.innerHTML = schedPartHtml(bar, part, e, p === 0);
      partEl = tmp.firstChild;
    }
    used[si] = true;
    schedApplyPart(partEl, bar, part, e, p === 0);
    segEl.appendChild(partEl); // 按组内顺序排（appendChild 会移动复用的）
  }
  for (var k2 in existing) {
    if (!used[k2] && existing[k2].parentNode) existing[k2].parentNode.removeChild(existing[k2]);
  }
}

/** 原地 reconcile 泳道与条：泳道按下标复用、条按 key 复用，只更新几何，保留元素做过渡。
 *  lanes 由调用方预先装箱（降级判定与 reconcile 共用同一份，不重复装箱）。
 *  返回泳道数（含补空），调用方挂在元素上供 schedSolveHeights 解算像素行高 */
function reconcileSchedLanes(lanesEl, now, winStart, span, lanes) {
  // 每天都至少 10 条泳道（不足/空天补空行），空天也占住一份基础高度、不塌成一条缝
  var laneCount = Math.max(10, lanes.length);
  var existing = {};
  var oldBars = lanesEl.querySelectorAll('.sched-seg');
  for (var i = 0; i < oldBars.length; i++) existing[oldBars[i].getAttribute('data-k')] = oldBars[i];
  var laneEls = lanesEl.querySelectorAll('.sched-lane');
  var used = {};
  for (var L = 0; L < laneCount; L++) {
    var laneEl = laneEls[L];
    if (!laneEl) {
      laneEl = document.createElement('div');
      laneEl.className = 'sched-lane';
      lanesEl.appendChild(laneEl);
    }
    var bars = L < lanes.length ? lanes[L] : [];
    var targetKeys = {};
    for (var k = 0; k < bars.length; k++) targetKeys[schedBarKey(bars[k])] = true;
    // 清掉本泳道里已不存在的条
    var laneBars = laneEl.querySelectorAll('.sched-seg');
    for (var b = 0; b < laneBars.length; b++) {
      if (!targetKeys[laneBars[b].getAttribute('data-k')]) laneEl.removeChild(laneBars[b]);
    }
    // 按序放置条（只移动错位的，已就位的原地不动，避免重排打断过渡）
    var prevBar = null;
    for (var k2 = 0; k2 < bars.length; k2++) {
      var bar = bars[k2];
      var key = schedBarKey(bar);
      var segEl = existing[key] && !used[key] ? existing[key] : null;
      if (segEl) {
        used[key] = true;
        schedApplyGroup(segEl, bar, now, winStart, span);
      } else {
        var tmp = document.createElement('div');
        tmp.innerHTML = schedGroupHtml(bar, now, winStart, span);
        segEl = tmp.firstChild;
        used[key] = true;
      }
      var anchor = prevBar ? prevBar.nextElementSibling : laneEl.firstElementChild;
      if (segEl !== anchor) laneEl.insertBefore(segEl, anchor);
      prevBar = segEl;
    }
  }
  // 删掉多余的泳道
  for (var L2 = laneCount; L2 < laneEls.length; L2++) {
    if (laneEls[L2] && laneEls[L2].parentNode) laneEls[L2].parentNode.removeChild(laneEls[L2]);
  }
  // 删掉未被复用的条
  for (var key2 in existing) {
    if (!used[key2] && existing[key2].parentNode) existing[key2].parentNode.removeChild(existing[key2]);
  }
  return laneCount;
}

// ---- hover 弹层（跟随鼠标，离开段即关；全部 esc；缩略行 mini 不触发）----
// 缩略图与分类区都按鼠标在条内的横向位置对应的时间点取：
//  - 图 = 「最近缓存关键帧」（/api/snapshot，按 60s 分桶，桶变才换图，鼠标静止不换）；
//    API 404 回退远程 e.keyframe || e.cover（旧行为），并记 schedSnapFail——本场 hover
//    不再试 API（防移动时 404 轰炸）；远程图也挂（或没有远程图）则移除 img，防 onerror 循环
//  - 分类 = 该场历次判定（classificationRuns）里最后一个 ts ≤ 鼠标时间的；第一轮之前 = 未分类；
//    该场没有历史（旧场次）才回退 entry.verdicts / primary
var schedPopEl = null;      // 当前弹层归属的 .sched-seg
var schedPopBucket = -1;    // 当前已请求的 60s 桶（-1 = 本次 hover 还未取图）
var schedPopClassKey = '';  // 当前已渲染的分类区标识（run.ts 变了才重画）
var schedSnapFail = {};     // 'roomId:liveTime' → true（该场 hover 已 404）

function schedHidePop() {
  schedPopEl = null;
  schedPopClassKey = '';
  var p = document.getElementById('sched-pop');
  if (p) p.classList.add('hidden');
}

/** 鼠标在条内的横向位置 → 时间点（秒，clamp 0..1） */
function schedTimeAt(el, clientX) {
  var bs = Number(el.getAttribute('data-bs'));
  var be = Number(el.getAttribute('data-be'));
  var r = el.getBoundingClientRect();
  var f = r.width > 0 ? (clientX - r.left) / r.width : 0;
  if (f < 0) f = 0;
  if (f > 1) f = 1;
  return Math.round(bs + f * (be - bs));
}

/** 鼠标位置对应的时间点，按 60s 分桶 */
function schedBucketOf(el, clientX) {
  return Math.floor(schedTimeAt(el, clientX) / 60) * 60;
}

/** 按条上的稳定引用（data-edate 场次归属日 / data-e 场次下标 / data-s 段下标）取场次与段；
   窗口滑动不改变这些值（旧 data-d 是窗口内日下标，会随滑动偏移，已弃用） */
function schedEntryOf(el) {
  var edate = el.getAttribute('data-edate');
  var ei = Number(el.getAttribute('data-e'));
  var si = Number(el.getAttribute('data-s'));
  for (var i = 0; i < schedDays.length; i++) {
    if (schedDays[i].date === edate) {
      var e = schedDays[i].entries[ei];
      if (!e) return null;
      return { entry: e, seg: e.segments[si] || null };
    }
  }
  return null;
}

/** 桶变了才换图：缓存关键帧优先，该场已 404 直接用远程兜底 */
function schedPopImg(el, clientX) {
  var p = document.getElementById('sched-pop');
  var img = p.querySelector('img');
  if (!img) return;
  var bucket = schedBucketOf(el, clientX);
  if (bucket === schedPopBucket) return;
  schedPopBucket = bucket;
  var found = schedEntryOf(el);
  var e = found && found.entry;
  if (!e) return;
  if (!schedSnapFail[e.roomId + ':' + e.liveTime]) {
    img.src = '/api/snapshot?room=' + encodeURIComponent(e.roomId) +
      '&lt=' + e.liveTime + '&ts=' + bucket;
  } else {
    var remote = e.keyframe || e.cover;
    if (remote) img.src = remote;
  }
}

/** 判定分类名 → 全局 .tag 五色修饰类（名字符串哈希取模，同一分类恒同色） */
var SCHED_TAG_COLORS = ['tag-blue', 'tag-mint', 'tag-purple', 'tag-amber', 'tag-pink'];
function schedTagColor(name) {
  var h = 0, s = String(name || '');
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return SCHED_TAG_COLORS[h % SCHED_TAG_COLORS.length];
}
/** 判定来源 → 弹层文案（LLM 与决策两个通道分开标；旧行 source 为 rule = 确定性条件定案） */
function schedSourceName(source) {
  return source === 'llm' ? 'LLM' : source === 'decision' ? '决策' : '规则';
}

/** 生效主分类（categoryId=0 = 「其他」，不进展示；缺字段也算没有） */
function schedPrimaryOf(primary) {
  if (!primary || primary.categoryId === 0) return null;
  return primary;
}

/**
 * 该场在时间点 t 的分类：`undefined` = 该场没有历史（旧场次，回退最新结果）；
 * `null` = 第一轮判定之前（未分类）；否则返回最后一轮 ts ≤ t 的判定。
 */
function schedRunAt(entry, t) {
  var runs = entry.classificationRuns;
  if (!runs || !runs.length) return undefined;
  var pick = null;
  for (var i = 0; i < runs.length; i++) {
    if (runs[i].ts <= t) pick = runs[i]; else break;
  }
  return pick;
}

/** 分类区标识：变了才重画（鼠标在同一轮判定内移动不重排 DOM） */
function schedRunKey(entry, t) {
  var run = schedRunAt(entry, t);
  if (run === undefined) return 'latest';
  return run === null ? 'none' : 'ts:' + run.ts;
}

/**
 * 分类区 HTML：主分类先列（其 tag 走实色档，与其余分类的浅底 tag 区分），同名的 verdict 行
 * 不再重复——证据并回主分类行，避免丢依据；其余 verdicts 原样逐条列（confidence 只有决策档有值）。
 */
function schedClassHtml(verdicts, primary) {
  var rows = [];
  if (primary) {
    var primaryVerdict = null;
    for (var i = 0; i < verdicts.length; i++) {
      if (verdicts[i].categoryName === primary.categoryName) { primaryVerdict = verdicts[i]; break; }
    }
    rows.push('<div class="sched-pop-v"><span class="tag tag-solid ' + schedTagColor(primary.categoryName) + '">' +
      esc(primary.categoryName) + '</span>' +
      '<span class="sched-pop-src">' + schedSourceName(primary.source) + '</span>' +
      (primaryVerdict && primaryVerdict.evidence ? '<div class="sched-pop-ev">' + esc(primaryVerdict.evidence) + '</div>' : '') +
      '</div>');
  }
  for (var j = 0; j < verdicts.length; j++) {
    var v = verdicts[j];
    if (primary && v.categoryName === primary.categoryName) continue;
    rows.push('<div class="sched-pop-v"><span class="tag ' + schedTagColor(v.categoryName) + '">' +
      esc(v.categoryName) + '</span>' +
      '<span class="sched-pop-src">' + schedSourceName(v.source) +
      (v.confidence != null ? ' ' + v.confidence.toFixed(2) : '') + '</span>' +
      (v.evidence ? '<div class="sched-pop-ev">' + esc(v.evidence) + '</div>' : '') + '</div>');
  }
  return rows.length ? rows.join('') : '<div class="sched-pop-ev">未分类</div>';
}

/** 该场在时间点 t 的分类区 HTML（先看历史轮次，旧场次才回退最新结果） */
function schedClassHtmlAt(entry, t) {
  var run = schedRunAt(entry, t);
  if (run === undefined) {
    return schedClassHtml(entry.verdicts || [], schedPrimaryOf(entry.primary));
  }
  if (run === null) return '<div class="sched-pop-ev">未分类</div>';
  return schedClassHtml(run.verdicts || [], schedPrimaryOf(run.primary));
}

function schedShowPop(el, evt) {
  var found = schedEntryOf(el);
  var e = found && found.entry;
  var seg = found && found.seg;
  if (!e || !seg) return;
  var p = document.getElementById('sched-pop');
  var area = [seg.parentAreaName, seg.areaName].filter(Boolean).join(' / ');
  var onAir = schedIsLive(e) && !seg.endTs;
  // 未观测下播的末段没有 endTs：写「… 之后」，不把最后一次在播观测冒充下播时间
  var unknownEnd = !onAir && schedUnknownEnd(e) && !seg.endTs;
  var endText = onAir ? '进行中'
    : unknownEnd ? schedFmtHm(schedCutTs(e)) + ' 之后'
      : schedFmtHm(seg.endTs || e.endTs || seg.startTs);
  var time = schedFmtHm(seg.startTs) + ' – ' + endText;
  var t = schedTimeAt(el, evt.clientX);
  schedPopClassKey = schedRunKey(e, t);
  p.innerHTML =
    '<img referrerpolicy="no-referrer" alt="">' + // src 由 schedPopImg 按鼠标时间点填
    '<div class="sched-pop-body">' +
    '<div class="sched-pop-title">' + esc(seg.title || '(无标题)') + '</div>' +
    // 弹层空间充足用原名（e.uname），demo 旧夹具无此字段则回退横条名（简称优先的 e.name）
    '<div class="sched-pop-meta">' + icon('clock') + '<span>' + esc(e.uname || e.name) + ' · ' +
    esc(time) + '</span>' + (onAir ? '<span class="sched-pop-live">直播中</span>' : '') + '</div>' +
    (area ? '<div class="sched-pop-meta">' + esc(area) + '</div>' : '') +
    '<div id="sched-pop-class">' + schedClassHtmlAt(e, t) + '</div></div>';
  p.classList.remove('hidden');
  schedPopEl = el;
  schedPopBucket = -1; // 强制按当前鼠标位置取一次
  // 回退链挂在 img 上（JS 赋值非内联，事件委托惯例不冲突）
  var img = p.querySelector('img');
  var failKey = e.roomId + ':' + e.liveTime;
  img.onerror = function () {
    if (!schedSnapFail[failKey]) {
      schedSnapFail[failKey] = true;
      var remote = e.keyframe || e.cover;
      if (remote) { img.src = remote; return; }
    }
    img.onerror = null; // 防循环
    if (img.parentNode) img.parentNode.removeChild(img);
  };
  schedMovePop(evt);
}

/** 跨过一轮判定就即时换分类区（不必等重新 mouseover）；图片仍按 60s 分桶 */
function schedUpdateClass(el, clientX) {
  var box = document.getElementById('sched-pop-class');
  if (!box) return;
  var found = schedEntryOf(el);
  var e = found && found.entry;
  if (!e) return;
  var t = schedTimeAt(el, clientX);
  var key = schedRunKey(e, t);
  if (key === schedPopClassKey) return;
  schedPopClassKey = key;
  box.innerHTML = schedClassHtmlAt(e, t);
}

function schedMovePop(evt) {
  var p = document.getElementById('sched-pop');
  var x = evt.clientX + 14, y = evt.clientY + 14;
  var r = p.getBoundingClientRect();
  if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - 14;
  if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - 14;
  p.style.left = Math.max(8, x) + 'px';
  p.style.top = Math.max(8, y) + 'px';
  if (schedPopEl) {
    schedPopImg(schedPopEl, evt.clientX);
    schedUpdateClass(schedPopEl, evt.clientX);
  }
}

// ---- 初始化 ----
(function initSched() {
  var card = document.getElementById('card-schedule');
  var body = document.getElementById('schedule-body');
  var pop = document.createElement('div');
  pop.id = 'sched-pop';
  pop.className = 'sched-pop hidden';
  document.body.appendChild(pop);

  // 滚轮按天步进：preventDefault 阻止页面滚动（用户明确要求），300ms 节流
  card.addEventListener('wheel', function (e) {
    e.preventDefault();
    var now = Date.now();
    if (now - schedWheelLock < 300) return;
    schedWheelLock = now;
    if (e.deltaY > 0) schedStep(1);
    else if (e.deltaY < 0) schedStep(-1);
  }, { passive: false });

  body.addEventListener('mouseover', function (e) {
    if (!(e.target instanceof Element)) return;
    var el = e.target.closest('.sched-part'); // 组内分段各自响应 hover（标题/快照按段）
    if (!el) return;
    if (el.closest('.sched-day.mini')) return; // 缩略行（无字色条）无 hover
    schedShowPop(el, e);
  });
  body.addEventListener('click', function (event) {
    if (!(event.target instanceof Element)) return;
    const part = event.target.closest('.sched-part');
    if (!part || part.closest('.sched-day.mini')) return;
    const found = schedEntryOf(part);
    if (!found) return;
    event.stopPropagation();
    schedHidePop();
    openContentAudit('live', found.entry.roomId + ':' + found.entry.liveTime, found.entry.uname + ' · 分类与推送记录');
  });
  body.addEventListener('mousemove', function (e) {
    var p = document.getElementById('sched-pop');
    if (p && !p.classList.contains('hidden')) schedMovePop(e);
  });
  body.addEventListener('mouseout', function (e) {
    if (!(e.target instanceof Element)) return;
    var el = e.target.closest('.sched-part');
    if (el && !(e.relatedTarget instanceof Element && el.contains(e.relatedTarget))) schedHidePop();
  });

  schedLoad(schedLogicalToday()); // 初始居中 = 逻辑今天（红线所在日，与「今天」标注同口径）

  // 窗口缩放 → 重新解算各行像素高度（basis px→px 过渡，连续）；视图从隐藏切回时也需重排
  //（display:none 下 clientHeight 为 0，隐藏期的渲染解算出的高度无效）
  window.addEventListener('resize', schedRelayout);

  // 主题切换（亮/暗）→ 重渲条区：亮度随主题（70/40），h/s 不变，无需重算头像
  if (window.matchMedia) {
    var schedMQ = window.matchMedia('(prefers-color-scheme: dark)');
    function schedOnSchemeChange() { if (schedCenter && schedDays.length) renderSchedBody(); }
    if (schedMQ.addEventListener) schedMQ.addEventListener('change', schedOnSchemeChange);
    else if (schedMQ.addListener) schedMQ.addListener(schedOnSchemeChange);
  }

  // 在播条右端与当前时间红线跟随时间：轴变了重渲轴刻度 + 原地 reconcile 几何；
  // 轴没变时，全量行内有在播场或 now 落在某全量行窗口内（红线需推进）才刷新条区（省电）
  setInterval(function () {
    if (!schedCenter || schedDays.length === 0 || !schedAxis) return;
    var axisChanged = recomputeSchedAxis();
    if (axisChanged) { renderSched(); return; }
    if (schedHasLive() || schedNowInRow()) renderSchedBody();
  }, 60000);

  // 数据保鲜：schedDays 只在 schedLoad 时取一次，若某场开播时 endTs=null，之后下播了
  // 缓存里仍是 null，在播条会一直延伸到「现在」像是没下播，必须刷新才能纠正。停机后
  // 重启也靠这次刷新把在播条换成「最后一次在播观测 + 散尾」。故周期重取当前窗口数据，
  // 并重算轴 + 重渲。
  setInterval(function () {
    if (!schedCenter || schedDays.length === 0) return;
    schedRefreshData();
  }, 60000);
})();
