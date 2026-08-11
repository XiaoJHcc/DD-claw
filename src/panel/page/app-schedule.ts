/**
 * 面板前端 · 时间表：过往直播的时间轴（纵轴日期升序、横轴时间），**5 天滑动窗口制**。
 * 窗口 = 居中日 center ± 2 天（一次请求）：中间 3 天全量行（泳道装箱 / 行高自适应 /
 * 条内小字 / hover 弹层 / 今天红线），两端 2 天缩略行（同一套装箱、
 * --sched-mini-lane-h 超窄道高、条只留颜色，无文字 / hover / 红线）。
 * 点击任意非居中天 → 该天居中（带方向感滑动动画：向未来内容上移进场、向过去下移）；
 * 滚轮按天步进（preventDefault 阻止页面滚动，300ms 节流，动画期内忽略后续滚动）。
 * 无内部滚动容器，随页面整体滚动。
 *
 * 共享轴（偏移语义）：轴 = 相对当天北京 06:00 日界的偏移秒数（offStart/offEnd，
 * 0 = 06:00），按**中间 3 个全量天**的归属场次一次算定，仅 center 变化时重算；
 * 空窗口兜底 {0, 86400}。每天行内独立换算窗口（winStart = 当天 06:00 + offStart），
 * 跨天竖向对齐天然成立，>24h 场次的溢出部分与次日行窗口求交才画到次日。
 *
 * 泳道按**完整日窗**（当天 06:00 起 24h）裁剪后贪心装箱（行高 = 泳道数 × 道高，
 * 与轴重算解耦）；绘制按共享轴窗口裁剪，落在轴外的条占泳道位不画。
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
 * 装箱 / 绘制 / 共享轴三处统一走它，语义一致。
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
    recomputeSchedAxis(); // 仅 center 变化时重算（按中间 3 天一次算定）
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

// ---- 共享轴：按中间 3 个全量天的归属场次一次算定；返回轴是否变化 ----
function recomputeSchedAxis() {
  var now = Math.floor(Date.now() / 1000);
  var minOff = -1, maxOff = 0;
  var miniFrom = schedAddDays(schedCenter, -2), miniTo = schedAddDays(schedCenter, 2);
  for (var i = 0; i < schedDays.length; i++) {
    var dd = schedDays[i].date;
    if (dd === miniFrom || dd === miniTo) continue; // 缩略行不参与轴计算
    // 每天先换算成相对自己 06:00 日界的偏移（offE 可 > 24h），再合并取轴
    var base = schedDayStartTs(dd);
    var es = schedDays[i].entries;
    for (var j = 0; j < es.length; j++) {
      var offS = es[j].startTs - base;
      var offE = schedEffEnd(es[j], now) - base;
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
  var offStart = Math.max(0, Math.floor(minOff / 3600) * 3600);
  var offEnd = Math.min(offStart + 86400, Math.ceil(maxOff / 3600) * 3600);
  if (offEnd <= offStart) offEnd = offStart + 3600;
  if (schedAxis && schedAxis.offStart === offStart && schedAxis.offEnd === offEnd) return false;
  schedAxis = { offStart: offStart, offEnd: offEnd };
  return true;
}

/** 全量行内是否有在播场次（60s 定时器用：有才需要重渲染推进右端） */
function schedHasLive() {
  var miniFrom = schedAddDays(schedCenter, -2), miniTo = schedAddDays(schedCenter, 2);
  for (var i = 0; i < schedDays.length; i++) {
    var dd = schedDays[i].date;
    if (dd === miniFrom || dd === miniTo) continue;
    var winEnd = schedDayStartTs(dd) + schedAxis.offEnd;
    var es = schedDays[i].entries;
    for (var j = 0; j < es.length; j++) {
      if (es[j].endTs === null && es[j].startTs < winEnd) return true;
    }
  }
  return false;
}

/** 今天是否作为全量行在窗口内（红线分钟级刷新用；缩略行不画红线） */
function schedTodayFull() {
  if (!schedCenter) return false;
  var today = bjToday();
  return today >= schedAddDays(schedCenter, -1) && today <= schedAddDays(schedCenter, 1);
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
 * 一天的条贪心装箱：候选 = 本天归属 + 前一天归属（溢出段）。
 * 装箱用**完整日窗**（当天 06:00 起 24h，行高稳定）；绘制范围（ds/de）仍与
 * 共享轴窗口求交——落在轴外的条占泳道位但不画。
 * 条按 startTs 排序后放入第一条「最后一条结束 ≤ 本条开始」的泳道，
 * 都冲突才开新泳道。同场次相邻段 end==start 自然共道。返回泳道数组（元素 = 条数组）。
 */
function packSchedLanes(dayIdx) {
  var day = schedDays[dayIdx];
  var now = Math.floor(Date.now() / 1000);
  var fullStart = schedDayStartTs(day.date);
  var fullEnd = fullStart + 86400;
  var winStart = fullStart + schedAxis.offStart;
  var winEnd = fullStart + schedAxis.offEnd;
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
    var effEnd = schedEffEnd(e, now);
    if (effEnd <= fullStart || e.startTs >= fullEnd) continue; // 与完整日窗无交集
    for (var s = 0; s < e.segments.length; s++) {
      var seg = e.segments[s];
      var segEnd = seg.endTs || effEnd;
      var a = Math.max(seg.startTs, fullStart);
      var b = Math.min(segEnd, fullEnd);
      if (b <= a) continue;
      bars.push({
        start: a, end: b,
        ds: Math.max(a, winStart), de: Math.min(b, winEnd),
        di: item.di, ei: item.ei, si: s, uid: e.uid,
        live: s === e.segments.length - 1 && e.endTs === null,
        cont: s > 0,
      });
    }
  }
  bars.sort(function (x, y) { return x.start - y.start || x.end - y.end; });
  var lanes = [];
  for (var k = 0; k < bars.length; k++) {
    var bar = bars[k];
    var placed = false;
    for (var L = 0; L < lanes.length; L++) {
      var lane = lanes[L];
      if (lane[lane.length - 1].end <= bar.start) { lane.push(bar); placed = true; break; }
    }
    if (!placed) lanes.push([bar]);
  }
  return lanes;
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
  // 当前时间红线（仅今天的全量行，且落在轴范围内才画）
  var nowOff = now - schedDayStartTs(today);
  var nowPct = nowOff >= schedAxis.offStart && nowOff <= schedAxis.offEnd
    ? ((nowOff - schedAxis.offStart) / span) * 100
    : -1;
  var html = '';
  for (var d = 0; d < schedDays.length; d++) {
    var day = schedDays[d];
    var isMini = day.date === miniFrom || day.date === miniTo;
    var winStart = schedDayStartTs(day.date) + schedAxis.offStart;
    var lanes = packSchedLanes(d);
    var lanesHtml = '';
    for (var L = 0; L < lanes.length; L++) {
      var barsHtml = '';
      for (var k = 0; k < lanes[L].length; k++) {
        var bar = lanes[L][k];
        if (bar.de <= bar.ds) continue; // 落在当前轴外：占泳道位（行高稳定）但不画
        var e = schedDays[bar.di].entries[bar.ei];
        var seg = e.segments[bar.si];
        var left = ((bar.ds - winStart) / span) * 100;
        var width = ((bar.de - bar.ds) / span) * 100;
        // 在播条 = 一根连续条（齐头散尾）：实色到红线 → 40% 半透平台补齐到开播满 2h
        // → 30 分钟渐变散尾；真实下播后 endTs 非空自动失效
        var bg = schedColorOf(bar.uid);
        if (bar.live && bar.de > now && now > bar.ds) {
          var spanDs = bar.de - bar.ds;
          var p1 = ((now - bar.ds) / spanDs) * 100;
          var p2 = Math.min(100, ((Math.max(now, e.startTs + 7200) - bar.ds) / spanDs) * 100);
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
      (!isMini && day.date === today && nowPct >= 0
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
  // 全量行内有在播场或今天为全量行才重画条区（省电）
  setInterval(function () {
    if (!schedCenter || schedDays.length === 0 || !schedAxis) return;
    if (recomputeSchedAxis()) { renderSched(); return; }
    if (schedHasLive() || schedTodayFull()) renderSchedBody();
  }, 60000);
})();
`;
