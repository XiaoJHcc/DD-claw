/**
 * 面板前端 · 时间表：过往直播的时间轴（纵轴日期升序、横轴时间），**5 天滑动窗口制**。
 * 窗口 = 居中日 center ± 2 天（一次请求）：中间 3 天全量行（泳道装箱 / 行高自适应 /
 * 条内小字 / hover 弹层 / 今天红线），两端 2 天缩略行（同一套装箱、
 * --sched-mini-lane-h 超窄道高、条只留颜色，无文字 / hover / 红线）。
 * 点击任意非居中天 → 该天居中（带方向感滑动动画：向未来内容上移进场、向过去下移）；
 * 滚轮按天步进（preventDefault 阻止页面滚动，300ms 节流，动画期内忽略后续滚动）。
 * 无内部滚动容器，随页面整体滚动。
 *
 * 共享轴（偏移语义）：轴 = 相对各行归属日 06:00 的偏移秒数（offStart/offEnd，
 * 0 = 06:00；06:00 日界只用于「归属哪天」，与渲染窗口无关），按**当前可见全部
 * 5 天**的实际内容算定（center 变化 / 60s 定时器重算）；在播场终点用真实 now——
 * 「假定播 2 小时 + 30 分钟散尾」是纯绘制层假设，绝不进轴。空窗口兜底 {0, 86400}。
 * 每天行窗口 = 当天 06:00 + [offStart, offEnd]（可延伸到次日白天，正是设计意图），
 * 跨天竖向对齐天然成立；offEnd ≤ offStart + 24h ⇒ 相邻天窗口不重叠（至多首尾相接）。
 * 红线跟随行窗口：now 落在哪行窗口就画哪行（至多一行命中；缩略行 / 空档不画）。
 *
 * 泳道候选 = 当天 entries + 前一天 entries（通宵场溢出段接续：归属日行画到该行窗口
 * 右端，次日行从其窗口左起接续，相邻窗口首尾相接故无缝）。段与行窗口求交后按
 * **uid 分组整体装箱**（同主播当天多场永远同泳道；组内条互叠的异常数据退化为
 * 逐 bar 装箱）。装箱窗口 == 绘制窗口，行高 = 泳道数 × 道高。
 *
 * 内嵌进页面 <script>，内容不得出现反引号与 ${，一律字符串拼接。依赖 icons / app-core 段。
 */
export const APP_SCHEDULE = `
var schedDays = [];           // 窗口内 5 天升序 [{date, entries:[...]}]
var schedCenter = null;       // 居中日（日串）
var schedColors = {};         // uid → css 颜色（头像平均色 / 哈希色回退）
var schedColorPending = {};   // uid → true（平均色计算中，避免重复拉图）
var schedAxis = null;         // {offStart, offEnd} 相对当天 06:00 的偏移秒数；null = 尚未算过
var schedSeq = 0;             // 请求序号戳：连点/连滚时作废旧渲染
var schedWheelLock = 0;       // wheel 节流时间戳

// ---- 北京时间工具（固定 UTC+8，与服务端同口径；日界 = 凌晨 6 点，仅用于归属）----
function bjToday() { return new Date(Date.now() + 28800000).toISOString().slice(0, 10); }
function schedAddDays(day, n) {
  return new Date(Date.parse(day + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}
function schedDayStartTs(day) { return Math.floor(Date.parse(day + 'T06:00:00+08:00') / 1000); }
/**
 * 场次的有效终点：真实下播后 = endTs；在播中 = max(now, startTs + 7200) + 1800——
 * 假定至少播 2 小时，尾端再加 30 分钟渐变散尾区（齐头散尾；将来的直播预告条同样式）。
 * 仅装箱 / 绘制使用（纯绘制层假设）；共享轴用真实 now（见 recomputeSchedAxis）。
 */
function schedEffEnd(e, now) {
  return e.endTs !== null && e.endTs !== undefined
    ? e.endTs
    : Math.max(now, e.startTs + 7200) + 1800;
}
function schedFmtHm(ts) {
  var d = new Date(ts * 1000 + 28800000);
  var h = d.getUTCHours(), m = d.getUTCMinutes();
  return (h < 10 ? '0' + h : String(h)) + ':' + (m < 10 ? '0' + m : String(m));
}
function schedDayLabel(date) {
  var p = date.split('-');
  var wd = new Date(Date.parse(date + 'T12:00:00Z')).getUTCDay();
  return Number(p[1]) + '月' + Number(p[2]) + '日 星期' + '日一二三四五六'.charAt(wd);
}

// ---- 颜色：头像平均色（canvas），失败回退 uid 哈希色；结果缓存 localStorage ----
function schedHashColor(uid) {
  var h = 0;
  var s = String(uid);
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return 'hsl(' + (h % 360) + ', 55%, 42%)';
}
function schedColorOf(uid) { return schedColors[uid] || schedHashColor(uid); }
// 在播条背景（齐头散尾）：实色到 p1%（红线处）→ 同色 40% 半透平台到 p2%（开播满 2h 处）
// → 尾端线性渐变到全透（约 30 分钟宽度）。p1 == p2 时（已播超 2h）从红线直接散尾。
// 将来的直播预告条（只有开播时间、无下播时间）复用同款散尾样式。
// 注意：本文件是 TS 模板字符串，正则里的反斜杠转义会被模板静默吃掉（qr-lib 有同类坑记录），
// 所以这里用字符串操作给 rgb()/hsl() 插 alpha 通道，不写正则。
function schedLiveBg(css, p1, p2) {
  var open = css.indexOf('('), close = css.lastIndexOf(')');
  var kind = css.slice(0, 3);
  if (open < 0 || close < open || (kind !== 'rgb' && kind !== 'hsl')) return css;
  var inner = css.slice(open + 1, close);
  var a4 = kind + 'a(' + inner + ', 0.4)';
  var a0 = kind + 'a(' + inner + ', 0)';
  var s1 = (Math.round(p1 * 10) / 10) + '%', s2 = (Math.round(p2 * 10) / 10) + '%';
  return 'linear-gradient(90deg, ' + css + ' ' + s1 + ', ' + a4 + ' ' + s1 +
    ', ' + a4 + ' ' + s2 + ', ' + a0 + ' 100%)';
}
function schedPrepareColor(uid, face) {
  if (!uid || schedColors[uid] || schedColorPending[uid]) return;
  var cached = null;
  try { cached = localStorage.getItem('dd-claw-color:' + uid); } catch (e) {}
  if (cached) { schedColors[uid] = cached; return; }
  if (!face) { schedColors[uid] = schedHashColor(uid); return; }
  schedColorPending[uid] = true;
  var img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = function () {
    schedColorPending[uid] = false;
    var css = schedHashColor(uid);
    try {
      var cv = document.createElement('canvas');
      cv.width = 8; cv.height = 8;
      var g = cv.getContext('2d');
      g.drawImage(img, 0, 0, 8, 8);
      var data = g.getImageData(0, 0, 8, 8).data;
      var r = 0, gg = 0, b = 0, n = 0;
      for (var i = 0; i < data.length; i += 4) { r += data[i]; gg += data[i + 1]; b += data[i + 2]; n++; }
      r = Math.round(r / n); gg = Math.round(gg / n); b = Math.round(b / n);
      // 亮度压到白字可读区间（过亮压暗、过暗提亮）
      var lum = 0.299 * r + 0.587 * gg + 0.114 * b;
      var f = 1;
      if (lum > 170) f = 170 / lum;
      else if (lum < 55) f = 55 / Math.max(lum, 1);
      r = Math.min(255, Math.round(r * f));
      gg = Math.min(255, Math.round(gg * f));
      b = Math.min(255, Math.round(b * f));
      css = 'rgb(' + r + ',' + gg + ',' + b + ')';
    } catch (e) { /* CORS 污染画布等 → 哈希色 */ }
    schedColors[uid] = css;
    try { localStorage.setItem('dd-claw-color:' + uid, css); } catch (e2) {}
    renderSchedBody();
  };
  img.onerror = function () {
    schedColorPending[uid] = false;
    schedColors[uid] = schedHashColor(uid); // 图床拒跨域 → 哈希色
    renderSchedBody();
  };
  img.src = face;
}
function schedPrepareColors(days) {
  for (var i = 0; i < days.length; i++) {
    var es = days[i].entries;
    for (var j = 0; j < es.length; j++) schedPrepareColor(es[j].uid, es[j].face);
  }
}

// ---- 窗口加载：center ± 2 天一次请求；dir = 'future'（内容上移进场）/ 'past'（下移）----
function schedFetch(from, to) {
  return api('/api/schedule?from=' + from + '&to=' + to).then(function (j) { return j.days || []; });
}

function schedLoad(center, dir) {
  var seq = ++schedSeq;
  schedFetch(schedAddDays(center, -2), schedAddDays(center, 2)).then(function (days) {
    if (seq !== schedSeq) return; // 已有更新的请求在路上，作废旧渲染
    schedCenter = center;
    schedDays = days;
    schedPrepareColors(days);
    recomputeSchedAxis(); // center 变化时重算（按可见 5 天实际内容）
    renderSched();
    if (dir) playSchedAnim(dir);
  }).catch(function (e) {
    if (seq === schedSeq) toast(e.message, true);
  });
}

ACTIONS['sched-center'] = function (el) {
  var date = el.getAttribute('data-date');
  if (!date || !schedCenter || date === schedCenter) return;
  schedLoad(date, date > schedCenter ? 'future' : 'past');
};

function schedStep(n) {
  if (!schedCenter) return;
  var next = schedAddDays(schedCenter, n);
  schedLoad(next, n > 0 ? 'future' : 'past');
}

function playSchedAnim(dir) {
  var body = document.getElementById('schedule-body');
  body.classList.remove('sched-anim-up', 'sched-anim-down');
  void body.offsetWidth; // 强制 reflow 以重启动画
  body.classList.add(dir === 'past' ? 'sched-anim-down' : 'sched-anim-up');
}

// ---- 共享轴：按当前可见全部 5 天的实际内容算定（缩略行也在视野内，同样参与）；
// 在播场终点用真实 now（2h/散尾假设只属于绘制层）；返回轴是否变化 ----
function recomputeSchedAxis() {
  var now = Math.floor(Date.now() / 1000);
  var minOff = -1, maxOff = 0;
  for (var i = 0; i < schedDays.length; i++) {
    // 每天先换算成相对自己归属日 06:00 的偏移（offE 可 > 24h），再合并取轴
    var base = schedDayStartTs(schedDays[i].date);
    var es = schedDays[i].entries;
    for (var j = 0; j < es.length; j++) {
      var offS = es[j].startTs - base;
      var offE = (es[j].endTs !== null && es[j].endTs !== undefined ? es[j].endTs : now) - base;
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

/** now 是否落在某个全量行的窗口内（60s 定时器红线刷新用；缩略行不画红线） */
function schedNowInFullRow() {
  if (!schedCenter || !schedAxis) return false;
  var now = Math.floor(Date.now() / 1000);
  var miniFrom = schedAddDays(schedCenter, -2), miniTo = schedAddDays(schedCenter, 2);
  for (var i = 0; i < schedDays.length; i++) {
    var dd = schedDays[i].date;
    if (dd === miniFrom || dd === miniTo) continue;
    if (schedRowHasNow(dd, now)) return true;
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
        // 在播 = [startTs, 绘制终点 schedEffEnd)，与行窗口有交集才算
        if ((e.endTs === null || e.endTs === undefined) &&
          e.startTs < winEnd && schedEffEnd(e, now) > winStart) return true;
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

function renderSchedAxis() {
  var el = document.getElementById('schedule-axis');
  var span = schedAxis ? schedAxis.offEnd - schedAxis.offStart : 0;
  if (span <= 0) { el.innerHTML = ''; return; }
  // 刻度标签 = 时钟时间，用今天的日界作参考换算（偏移语义下任意参考日都一样）
  var ref = schedDayStartTs(bjToday());
  var labelEvery = span > 12 * 3600 ? 2 : 1;
  var hours = Math.floor(span / 3600);
  var html = '';
  for (var h = 0; h <= hours; h++) {
    var pct = (h * 3600 / span) * 100;
    html += '<span class="sched-tick" style="left:' + pct + '%"></span>';
    if (h % labelEvery === 0 && h < hours) {
      html += '<span class="sched-tick-label" style="left:' + pct + '%">' +
        schedFmtHm(ref + schedAxis.offStart + h * 3600) + '</span>';
    }
  }
  el.innerHTML = html;
}

/**
 * 一天的条装箱：候选 = 当天 entries + 前一天 entries（通宵场溢出段接续绘制：
 * 归属日行画到该行窗口右端，次日行从其窗口左起接续，相邻窗口首尾相接故无缝）。
 * 装箱窗口 == 绘制窗口 = 当天 06:00 + [offStart, offEnd]（可延伸到次日白天）。
 * 末段在播的绘制终点带「假定 2h + 30min 散尾」假设（schedEffEnd，纯绘制层）；
 * 非末段缺 endTs 不至于发生，兜底 e.endTs ?? now。
 * 装箱按 **uid 分组整体放置**（同主播当天多场 + 其前一天溢出段同组，永远同泳道；
 * 这会故意增加泳道数，是明确选择）：组按最早 bar.start 排序，逐组放入第一条
 * 「该组所有 bar 与泳道已有 bar 全不相交」的泳道，都冲突才开新泳道。
 * 防御：组内 bar 互相重叠（数据异常）时该组退化为逐 bar 独立装箱。
 * 返回泳道数组（元素 = 条数组，道内按 start 排序）。
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
    var effEnd = schedEffEnd(e, now); // 末段在播的绘制终点（含散尾假设）
    for (var s = 0; s < e.segments.length; s++) {
      var seg = e.segments[s];
      var live = s === e.segments.length - 1 && (e.endTs === null || e.endTs === undefined);
      var segEnd = seg.endTs || (live ? effEnd : (e.endTs || now));
      var a = Math.max(seg.startTs, winStart);
      var b = Math.min(segEnd, winEnd);
      if (b <= a) continue; // 与行窗口无交集
      bars.push({
        start: a, end: b,
        di: item.di, ei: item.ei, si: s, uid: e.uid,
        live: live,
        cont: s > 0,
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
    // 防御：组内 bar 互相重叠（数据异常）→ 退化为逐 bar 独立装箱
    var bad = false;
    for (var m = 0; m < grp.length && !bad; m++) {
      for (var n = m + 1; n < grp.length; n++) {
        if (grp[m].start < grp[n].end && grp[n].start < grp[m].end) { bad = true; break; }
      }
    }
    if (bad) { for (var q = 0; q < grp.length; q++) units.push([grp[q]]); }
    else units.push(grp);
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
  var today = bjToday();
  var now = Math.floor(Date.now() / 1000);
  var miniFrom = schedAddDays(schedCenter, -2), miniTo = schedAddDays(schedCenter, 2);
  var html = '';
  for (var d = 0; d < schedDays.length; d++) {
    var day = schedDays[d];
    var isMini = day.date === miniFrom || day.date === miniTo;
    var winStart = schedDayStartTs(day.date) + schedAxis.offStart;
    // 当前时间红线跟随行窗口：now 落在本行窗口内才画（相邻窗口不重叠，至多一行命中；
    // 落在缩略行或行窗口外的空档不画）
    var nowPct = schedRowHasNow(day.date, now) ? ((now - winStart) / span) * 100 : -1;
    var lanes = packSchedLanes(d);
    var lanesHtml = '';
    for (var L = 0; L < lanes.length; L++) {
      var barsHtml = '';
      for (var k = 0; k < lanes[L].length; k++) {
        var bar = lanes[L][k]; // 装箱窗口 == 绘制窗口，条已全部在轴内
        var e = schedDays[bar.di].entries[bar.ei];
        var seg = e.segments[bar.si];
        var left = ((bar.start - winStart) / span) * 100;
        var width = ((bar.end - bar.start) / span) * 100;
        // 在播条 = 一根连续条（齐头散尾）：实色到红线 → 40% 半透平台补齐到开播满 2h
        // → 30 分钟渐变散尾；真实下播后 endTs 非空自动失效
        var bg = schedColorOf(bar.uid);
        if (bar.live && bar.end > now && now > bar.start) {
          var spanDs = bar.end - bar.start;
          var p1 = ((now - bar.start) / spanDs) * 100;
          var p2 = Math.min(100, ((Math.max(now, e.startTs + 7200) - bar.start) / spanDs) * 100);
          bg = schedLiveBg(bg, p1, p2);
        }
        if (isMini) {
          // 缩略行：条只留颜色，无文字 / hover（半透明延伸同样生效）
          barsHtml += '<div class="sched-mini-seg" style="left:' + left + '%;width:' + width +
            '%;background:' + bg + '"></div>';
          continue;
        }
        var cat = e.verdicts.length
          ? e.verdicts.map(function (v) { return v.categoryName; }).join('、')
          : '未分类';
        barsHtml +=
          '<div class="sched-seg' + (bar.cont ? ' cont' : '') + '"' +
          ' data-d="' + bar.di + '" data-e="' + bar.ei + '" data-s="' + bar.si + '"' +
          ' style="left:' + left + '%;width:' + width + '%;background:' + bg + '">' +
          '<span class="sched-seg-text">' + esc(e.name + ' · ' + cat + ' · ' + (seg.title || '')) + '</span>' +
          '</div>';
      }
      lanesHtml += '<div class="sched-lane">' + barsHtml + '</div>';
    }
    // 无条的天 = 一条道高的空行；非居中天可点击居中
    html += '<div class="sched-day' + (isMini ? ' mini' : '') + '"' +
      (day.date === schedCenter ? '' : ' data-action="sched-center" data-date="' + day.date + '"') + '>' +
      '<div class="sched-day-head' + (day.date === today ? ' today' : '') + '">' +
      esc(schedDayLabel(day.date)) + '</div>' +
      '<div class="sched-lanes">' + (lanesHtml || '<div class="sched-lane"></div>') +
      (!isMini && nowPct >= 0
        ? '<span class="sched-now" style="left:' + nowPct + '%"></span>'
        : '') +
      '</div></div>';
  }
  body.innerHTML = html;
}

// ---- hover 弹层（跟随鼠标，离开段即关；全部 esc；缩略行无 .sched-seg 不触发）----
function schedHidePop() {
  var p = document.getElementById('sched-pop');
  if (p) p.classList.add('hidden');
}

function schedShowPop(el, evt) {
  var d = Number(el.getAttribute('data-d'));
  var eIdx = Number(el.getAttribute('data-e'));
  var sIdx = Number(el.getAttribute('data-s'));
  var day = schedDays[d];
  var e = day && day.entries[eIdx];
  var seg = e && e.segments[sIdx];
  if (!seg) return;
  var p = document.getElementById('sched-pop');
  var now = Math.floor(Date.now() / 1000);
  var img = e.keyframe || e.cover; // 段不带 keyframe（API 形状），用场次快照兜底
  var area = [seg.parentAreaName, seg.areaName].filter(Boolean).join(' / ');
  var time = schedFmtHm(seg.startTs) + ' – ' +
    (seg.endTs ? schedFmtHm(seg.endTs) : schedFmtHm(now) + '（直播中）');
  var vs = e.verdicts.length
    ? e.verdicts.map(function (v) {
        return '<div class="sched-pop-v"><span class="tag">' + esc(v.categoryName) + '</span>' +
          '<span class="sched-pop-src">' + (v.source === 'llm' ? 'LLM' : '规则') +
          (v.confidence != null ? ' ' + v.confidence.toFixed(2) : '') + '</span>' +
          (v.evidence ? '<div class="sched-pop-ev">' + esc(v.evidence) + '</div>' : '') + '</div>';
      }).join('')
    : '<div class="sched-pop-ev">未分类</div>';
  p.innerHTML =
    '<div class="sched-pop-title">' + esc(seg.title || '(无标题)') + '</div>' +
    (area ? '<div class="sched-pop-meta">' + esc(area) + '</div>' : '') +
    (img ? '<img referrerpolicy="no-referrer" src="' + esc(img) + '" alt="">' : '') +
    '<div class="sched-pop-meta">' + esc(e.name) + ' · ' + esc(time) + '</div>' + vs;
  p.classList.remove('hidden');
  schedMovePop(evt);
}

function schedMovePop(evt) {
  var p = document.getElementById('sched-pop');
  var x = evt.clientX + 14, y = evt.clientY + 14;
  var r = p.getBoundingClientRect();
  if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - 14;
  if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - 14;
  p.style.left = Math.max(8, x) + 'px';
  p.style.top = Math.max(8, y) + 'px';
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
    var el = e.target.closest('.sched-seg');
    if (el) schedShowPop(el, e);
  });
  body.addEventListener('mousemove', function (e) {
    var p = document.getElementById('sched-pop');
    if (p && !p.classList.contains('hidden')) schedMovePop(e);
  });
  body.addEventListener('mouseout', function (e) {
    if (!(e.target instanceof Element)) return;
    var el = e.target.closest('.sched-seg');
    if (el && !(e.relatedTarget instanceof Element && el.contains(e.relatedTarget))) schedHidePop();
  });

  schedLoad(bjToday(), null);

  // 在播条右端与当前时间红线跟随时间：轴变了整体重渲；轴没变时，
  // 全量行内有在播场或 now 落在某全量行窗口内（红线需推进）才重画条区（省电）
  setInterval(function () {
    if (!schedCenter || schedDays.length === 0 || !schedAxis) return;
    if (recomputeSchedAxis()) { renderSched(); return; }
    if (schedHasLive() || schedNowInFullRow()) renderSchedBody();
  }, 60000);
})();
`;
