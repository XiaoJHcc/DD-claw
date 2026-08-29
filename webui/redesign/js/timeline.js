// timeline.js — 时间表视图（重设计版）
// 布局边界与动画过渡算法与原版一致：5 天滑动窗口 / 泳道按 uid 组贪心装箱 /
// 0-1-2 级权重水装填行高解算 / basis 恒像素值的 px→px CSS 过渡 / 三步空间降级 /
// 滚轮步进节流 / 头像平均色取色 / 齐头散尾在播渐变。视觉样式全面重做。
import { bjToday, bjAddDays, bjDayStart, esc, icon, fmtClock } from './core.js';
import { DATA, scheduleWindow } from './data.js';

const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

let schedCenter = null;     // 居中日（北京日串）
let schedDays = [];         // [{date, entries}]
let schedAxis = null;       // {offStart, offEnd}
let schedDegrade = 0;
let schedWheelLock = 0;
const schedCollapsing = {}; // date → true（折叠离场中）
const schedExpanding = {};  // date → true（展开进场中）
const schedColors = {};     // uid → {h,s} | null(失败) | undefined(未算)
let bodyEl = null, axisEl = null, popEl = null;
let popFor = null;          // 当前弹层对应的 bar key

// ---------- 绘制层假设（绝不进轴） ----------
function schedEffEnd(e, now) {
  return e.endTs !== null && e.endTs !== undefined ? e.endTs : Math.max(now, e.startTs + 7200) + 1800;
}

// ---------- 头像平均色（h/s 存储，亮度固定亮色主题 70） ----------
function schedHashHS(uid) {
  let h = 0; const s = String(uid);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return { h: ((h % 360) + 360) % 360, s: 50 };
}
function schedColorOf(uid) {
  const c = schedColors[uid] || schedHashHS(uid);
  return `hsl(${c.h} ${c.s}% 68%)`;
}
function schedTextShadowOf(uid) {
  const c = schedColors[uid] || schedHashHS(uid);
  return `0 1px 3px hsl(${c.h} ${c.s}% 30% / .45)`;
}
function schedLiveBg(base, p1, p2) {
  // 齐头散尾：实色到红线处 → 半透平台 → 尾端线性全透
  const inner = base.slice(4, -1); // "H S% L%"
  return `linear-gradient(90deg, ${base} ${p1}%, hsl(${inner} / .55) ${p1}%, hsl(${inner} / .55) ${p2}%, hsl(${inner} / 0) 100%)`;
}
function schedPrepareColors(days) {
  for (const d of days) for (const e of d.entries) {
    const uid = String(e.uid);
    if (uid in schedColors) continue; // 已算出或已定哈希兜底
    schedColors[uid] = null; // 先记哈希兜底，取色成功后覆盖
    if (!e.face || /^https?:/.test(e.face)) continue; // 远程头像 demo 不取色（避免跨域画布污染）
    const img = new Image();
    img.onload = () => {
      try {
        const cv = document.createElement('canvas');
        cv.width = cv.height = 8;
        const cx = cv.getContext('2d');
        cx.drawImage(img, 0, 0, 8, 8);
        const d8 = cx.getImageData(0, 0, 8, 8).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < d8.length; i += 4) { r += d8[i]; g += d8[i + 1]; b += d8[i + 2]; n++; }
        r /= n; g /= n; b /= n;
        const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255;
        const l = (mx + mn) / 2;
        let h = 0, s = 0;
        if (mx !== mn) {
          const dlt = mx - mn;
          s = l > .5 ? dlt / (2 - mx - mn) : dlt / (mx + mn);
          if (mx === r / 255) h = ((g / 255 - b / 255) / dlt + (g < b ? 6 : 0)) / 6;
          else if (mx === g / 255) h = ((b / 255 - r / 255) / dlt + 2) / 6;
          else h = ((r / 255 - g / 255) / dlt + 4) / 6;
        }
        schedColors[uid] = { h: Math.round(h * 360), s: Math.round(Math.sqrt(s) * 100) };
        renderSchedBody(); // 取色完成重渲（几何不变，纯换色）
      } catch { schedColors[uid] = null; }
    };
    img.onerror = () => { schedColors[uid] = null; };
    img.src = e.face;
  }
}

// ---------- 共享轴（按可见 5 天实际内容算定） ----------
function recomputeSchedAxis() {
  const now = Math.floor(Date.now() / 1000);
  let minOff = -1, maxOff = 0;
  for (const day of schedDays) {
    const base = bjDayStart(day.date);
    for (const e of day.entries) {
      const offS = e.startTs - base;
      const offE = (e.endTs ?? now) - base;
      if (minOff < 0 || offS < minOff) minOff = offS;
      if (offE > maxOff) maxOff = offE;
    }
  }
  if (minOff < 0) {
    if (schedAxis && schedAxis.offStart === 0 && schedAxis.offEnd === 86400) return false;
    schedAxis = { offStart: 0, offEnd: 86400 };
    return true;
  }
  const offStart = Math.floor(minOff / 3600) * 3600;
  let offEnd = Math.min(offStart + 86400, Math.ceil(maxOff / 3600) * 3600);
  if (offEnd <= offStart) offEnd = offStart + 3600;
  if (schedAxis && schedAxis.offStart === offStart && schedAxis.offEnd === offEnd) return false;
  schedAxis = { offStart, offEnd };
  return true;
}

function renderSchedAxis() {
  if (!schedAxis) return;
  const span = schedAxis.offEnd - schedAxis.offStart;
  const stepH = span <= 12 * 3600 ? 1 : span <= 24 * 3600 ? 2 : 3;
  let html = '';
  for (let off = schedAxis.offStart; off <= schedAxis.offEnd; off += stepH * 3600) {
    const pct = ((off - schedAxis.offStart) / span) * 100;
    const hh = (6 + off / 3600) % 24;
    const major = hh % 6 === 0;
    html += `<span class="axis-tick${major ? ' axis-major' : ''}" style="left:${pct}%"><b>${Math.round(hh)}:00</b><i></i></span>`;
  }
  axisEl.innerHTML = html;
}

// ---------- 泳道装箱（与原版同算法：候选含前一天、按 uid 分组、组级贪心） ----------
function schedMergeSegments(bars) {
  const groups = [];
  const lastBySession = {};
  for (const b of bars) {
    const skey = b.rid + ':' + b.lt;
    const gi = lastBySession[skey];
    const prev = gi !== undefined ? groups[gi] : null;
    if (prev && prev.end === b.start) {
      prev.parts.push({ si: b.si, start: b.start, end: b.end, live: b.live });
      prev.end = b.end;
      if (b.live) prev.live = true;
    } else {
      groups.push({ start: b.start, end: b.end, live: b.live, uid: b.uid, di: b.di, ei: b.ei, parts: [{ si: b.si, start: b.start, end: b.end, live: b.live }] });
      lastBySession[skey] = groups.length - 1;
    }
  }
  return groups;
}
function schedUnitFitsLane(unit, lane) {
  for (const a of unit) for (const b of lane) {
    if (a.start < b.end && b.start < a.end) return false;
  }
  return true;
}
function packSchedLanes(dayIdx) {
  const day = schedDays[dayIdx];
  const now = Math.floor(Date.now() / 1000);
  const dayStart = bjDayStart(day.date);
  const winStart = dayStart + schedAxis.offStart;
  const winEnd = dayStart + schedAxis.offEnd;
  const cand = [];
  for (let j = 0; j < day.entries.length; j++) cand.push({ di: dayIdx, ei: j, e: day.entries[j] });
  if (dayIdx > 0) {
    const prev = schedDays[dayIdx - 1];
    for (let j = 0; j < prev.entries.length; j++) cand.push({ di: dayIdx - 1, ei: j, e: prev.entries[j] });
  }
  const bars = [];
  for (const item of cand) {
    const e = item.e;
    const effEnd = schedEffEnd(e, now);
    for (let s = 0; s < e.segments.length; s++) {
      const seg = e.segments[s];
      const live = s === e.segments.length - 1 && (e.endTs === null || e.endTs === undefined);
      const segEnd = seg.endTs || (live ? effEnd : (e.endTs || now));
      const a = Math.max(seg.startTs, winStart);
      const b = Math.min(segEnd, winEnd);
      if (b <= a) continue;
      bars.push({ start: a, end: b, di: item.di, ei: item.ei, si: s, uid: e.uid, rid: e.roomId, lt: e.liveTime, live });
    }
  }
  bars.sort((x, y) => x.start - y.start || x.end - y.end);
  const groupByUid = {};
  for (const b of bars) {
    const u = String(b.uid);
    (groupByUid[u] || (groupByUid[u] = [])).push(b);
  }
  const units = [];
  for (const key in groupByUid) {
    const grp = groupByUid[key];
    const groups = schedMergeSegments(grp);
    let bad = false;
    for (let m = 0; m < groups.length && !bad; m++)
      for (let n = m + 1; n < groups.length; n++)
        if (groups[m].start < groups[n].end && groups[n].start < groups[m].end) { bad = true; break; }
    if (bad) for (const b of grp) units.push([{ start: b.start, end: b.end, live: b.live, uid: b.uid, di: b.di, ei: b.ei, parts: [{ si: b.si, start: b.start, end: b.end, live: b.live }] }]);
    else units.push(...groups.map(g => [g]));
  }
  units.sort((x, y) => x[0].start - y[0].start || x[0].end - y[0].end);
  const lanes = [];
  for (const unit of units) {
    let placed = false;
    for (let L = 0; L < lanes.length; L++) {
      if (schedUnitFitsLane(unit, lanes[L])) { lanes[L].push(...unit); placed = true; break; }
    }
    if (!placed) lanes.push(unit.slice());
  }
  return lanes;
}

// ---------- 三级行 + 三步降级 + 水装填行高（与原版同算法） ----------
function schedLevelFor(date, degrade) {
  const miniFrom = bjAddDays(schedCenter, -2), miniTo = bjAddDays(schedCenter, 2);
  const lv = (date === miniFrom || date === miniTo) ? 'mini' : (date === schedCenter ? 'center' : 'single');
  if (degrade >= 1 && lv === 'mini') return null;
  if (degrade >= 2 && lv === 'single') return 'mini';
  if (degrade >= 3 && lv === 'center') return 'single';
  return lv;
}
function schedFits(degrade, lanesByDay, availH) {
  let total = 0, count = 0;
  for (let i = 0; i < schedDays.length; i++) {
    const lv = schedLevelFor(schedDays[i].date, degrade);
    if (!lv) continue;
    count++;
    const lc = Math.max(10, lanesByDay[i].length);
    if (lv === 'mini') total += lc * 5 + Math.max(0, lc - 1);
    else total += lc * (lv === 'center' ? 32 : 16);
  }
  return total + 20 * count <= availH;
}
function schedApplyDayPx(el, px) {
  px = Math.round(px);
  if (el._schedPx === px) return;
  el._schedPx = px;
  el.style.flexBasis = px + 'px';
}
function schedSolveHeights(body) {
  const rows = body.querySelectorAll('.sched-day');
  const minis = [], items = [];
  let miniPxSum = 0, visibleCount = 0;
  for (const el of rows) {
    if (schedCollapsing[el.getAttribute('data-date')]) continue;
    visibleCount++;
    const lc = el._schedLanes || 10;
    if (el._schedLevel === 'mini') {
      const px = lc * 5 + Math.max(0, lc - 1);
      minis.push({ el, px });
      miniPxSum += px;
    } else {
      const center = el._schedLevel === 'center';
      items.push({ el, w: lc * (center ? 2 : 1), min: lc * (center ? 32 : 16) });
    }
  }
  let free = body.clientHeight - 20 * visibleCount - miniPxSum;
  let pending = items.slice();
  for (;;) {
    if (pending.length === 0) break;
    let W = 0;
    for (const it of pending) W += it.w;
    if (free <= 0) { for (const it of pending) it.px = it.min; break; }
    const clamped = [];
    for (const it of pending) {
      it.px = free * it.w / W;
      if (it.px < it.min) { it.px = it.min; free -= it.min; clamped.push(it); }
    }
    if (clamped.length === 0) break;
    pending = pending.filter(it => !clamped.includes(it));
  }
  for (const m of minis) schedApplyDayPx(m.el, m.px);
  for (const it of items) schedApplyDayPx(it.el, it.px);
}

// ---------- 行渲染 ----------
function dayLabel(date) {
  const d = new Date(date + 'T12:00:00+08:00');
  const wd = WD[d.getUTCDay()];
  const md = date.slice(5).replace('-', '/');
  return date === bjToday() ? `<b>今天</b><span class="wd">${md} ${wd}</span>` : `<b>${md}</b><span class="wd">${wd}</span>`;
}

function renderRowContent(el, dayIdx, lanes) {
  const day = schedDays[dayIdx];
  const now = Math.floor(Date.now() / 1000);
  const dayStart = bjDayStart(day.date);
  const winStart = dayStart + schedAxis.offStart;
  const span = schedAxis.offEnd - schedAxis.offStart;
  let html = `<span class="day-pill">${dayLabel(day.date)}</span>`;
  const laneCount = Math.max(10, lanes.length); // 道数下限 10：空道补齐，与行高解算同口径
  for (let li = 0; li < laneCount; li++) {
    const lane = lanes[li] || [];
    html += '<div class="sched-lane">';
    for (const g of lane) {
      const e = schedDays[g.di].entries[g.ei];
      const left = ((g.start - winStart) / span) * 100;
      const width = ((g.end - g.start) / span) * 100;
      const base = schedColorOf(g.uid);
      let bg = base;
      if (g.live && g.end > now && now > g.start) {
        const spanDs = g.end - g.start;
        const p1 = ((now - g.start) / spanDs) * 100;
        const p2 = Math.min(100, ((Math.max(now, e.startTs + 7200) - g.start) / spanDs) * 100);
        bg = schedLiveBg(base, p1, p2);
      }
      html += `<div class="sched-bar${g.live ? ' is-live' : ''}" data-edate="${schedDays[g.di].date}" data-e="${g.ei}" data-s="${g.parts[0].si}" style="left:${left}%;width:${width}%;background:${bg};text-shadow:${schedTextShadowOf(g.uid)}">`;
      // 分段：首段带主播名，每段带标题；段间分割线
      for (let p = 0; p < g.parts.length; p++) {
        const part = g.parts[p];
        const seg = e.segments[part.si];
        const pl = ((part.start - g.start) / (g.end - g.start)) * 100;
        const pw = ((part.end - part.start) / (g.end - g.start)) * 100;
        if (p > 0) html += `<span class="part-div" style="left:${pl}%"></span>`;
        html += `<span class="part-txt" style="left:${pl}%;width:${pw}%">${p === 0 ? `<span class="nm">${esc(e.uname || e.name)}</span>` : ''}<span class="tt">${esc(seg.title || '')}</span></span>`;
      }
      html += '</div>';
    }
    html += '</div>';
  }
  // 当前时间红线
  const nowPct = (now >= winStart && now <= winStart + span) ? ((now - winStart) / span) * 100 : -1;
  if (nowPct >= 0) html += `<span class="sched-now" style="left:${nowPct}%"></span>`;
  el.querySelector('.sched-lanes').innerHTML = html;
}

function renderSchedBody() {
  if (!bodyEl || !schedAxis) return;
  const lanesByDay = schedDays.map((_, i) => packSchedLanes(i));
  const availH = bodyEl.clientHeight;
  if (availH > 0) {
    schedDegrade = 0;
    while (schedDegrade < 3 && !schedFits(schedDegrade, lanesByDay, availH)) schedDegrade++;
  }
  // 1) 离场：窗口外的行折叠
  const wantDates = new Set(schedDays.map(d => d.date));
  for (const el of Array.from(bodyEl.querySelectorAll('.sched-day'))) {
    const date = el.getAttribute('data-date');
    if (!wantDates.has(date) && !schedCollapsing[date]) collapseDay(el);
  }
  // 2) 进场/更新
  for (let i = 0; i < schedDays.length; i++) {
    const day = schedDays[i];
    const level = schedLevelFor(day.date, schedDegrade);
    if (!level) continue;
    let el = bodyEl.querySelector(`.sched-day[data-date="${day.date}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'sched-day';
      el.setAttribute('data-date', day.date);
      el.innerHTML = '<div class="sched-lanes"></div>';
      // 按日期顺序插入
      let ref = null;
      for (const other of bodyEl.querySelectorAll('.sched-day')) {
        if (other.getAttribute('data-date') > day.date) { ref = other; break; }
      }
      bodyEl.insertBefore(el, ref);
      expandDay(el);
    } else if (schedCollapsing[day.date]) {
      // 折叠中又滚回来了：取消离场，从当前位置连续滑回
      delete schedCollapsing[day.date];
      schedExpanding[day.date] = true;
      el.style.margin = '';
      el.style.opacity = '1';
      setTimeout(() => { delete schedExpanding[day.date]; el.style.overflow = ''; }, 320);
    }
    el._schedLevel = level;
    el._schedLanes = Math.max(10, lanesByDay[i].length);
    const cls = `sched-day lv-${level}`;
    if (el.className !== cls) el.className = cls;
    renderRowContent(el, i, lanesByDay[i]);
  }
  schedSolveHeights(bodyEl);
}

function collapseDay(el) {
  const date = el.getAttribute('data-date');
  schedCollapsing[date] = true;
  el.style.overflow = 'hidden';
  el._schedPx = 0;
  el.style.flexBasis = '0px';
  el.style.margin = '0';
  el.style.opacity = '0';
  setTimeout(() => {
    if (!schedCollapsing[date]) return;
    delete schedCollapsing[date];
    el.parentNode && el.parentNode.removeChild(el);
  }, 320);
}
function expandDay(el) {
  schedExpanding[el.getAttribute('data-date')] = true;
  el.style.overflow = 'hidden';
  el.style.flexBasis = '0px';
  el.style.margin = '0';
  el.style.opacity = '0';
  void el.offsetHeight; // 提交 0 态
  el.style.margin = '';
  el.style.opacity = '1';
  setTimeout(() => { delete schedExpanding[el.getAttribute('data-date')]; el.style.overflow = ''; }, 320);
}

function renderSched() {
  recomputeSchedAxis();
  renderSchedAxis();
  renderSchedBody();
}

// ---------- 窗口滑动 ----------
export function schedStep(n) {
  schedCenter = bjAddDays(schedCenter, n);
  schedDays = scheduleWindow(schedCenter);
  schedPrepareColors(schedDays);
  // 方向感滑动
  bodyEl.style.animation = 'none';
  void bodyEl.offsetHeight;
  bodyEl.style.animation = `sched-slide-${n > 0 ? 'l' : 'r'} .3s ease`;
  renderSched();
}
function schedLoad(center) {
  schedCenter = center;
  schedDays = scheduleWindow(center);
  schedPrepareColors(schedDays);
  recomputeSchedAxis();
  renderSched();
}

// ---------- hover 弹层 ----------
const PV_COLORS = ['tag', 'tag-blue', 'tag-mint', 'tag-amber', 'tag-purple'];
function pvColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return PV_COLORS[Math.abs(h) % PV_COLORS.length];
}
function showPop(bar, clientX, clientY) {
  const edate = bar.getAttribute('data-edate');
  const ei = Number(bar.getAttribute('data-e'));
  const si = Number(bar.getAttribute('data-s'));
  const day = schedDays.find(d => d.date === edate);
  const e = day && day.entries[ei];
  if (!e) return;
  const seg = e.segments[si] || e.segments[0];
  const live = e.endTs == null;
  const img = e.keyframe || e.cover;
  const timeRange = `${fmtClock(seg.startTs)} – ${seg.endTs ? fmtClock(seg.endTs) : live ? '进行中' : '—'}`;
  let vh = '';
  if (e.verdicts && e.verdicts.length) {
    vh = '<div class="pop-verdicts">' + e.verdicts.map(v =>
      `<div class="pv"><div class="pv-head"><span class="tag ${pvColor(v.categoryName)}">${esc(v.categoryName)}</span>` +
      `<span class="tag tag-grey">${v.source === 'llm' ? `LLM ${v.confidence != null ? v.confidence.toFixed(2) : ''}` : '规则'}</span></div>` +
      (v.evidence ? `<span class="pv-ev">${esc(v.evidence)}</span>` : '') + '</div>').join('') + '</div>';
  } else {
    vh = '<div class="pop-verdicts"><span class="pv-none">未分类</span></div>';
  }
  popEl.innerHTML =
    (img ? `<img class="pop-img" src="${esc(img)}" referrerpolicy="no-referrer" onerror="this.remove()">` : '') +
    `<div class="pop-body"><div class="pop-title">${esc(seg.title || e.name)}</div>` +
    `<div class="pop-meta">${icon('clock')}<span>${esc(e.uname || e.name)} · ${timeRange}</span>${live ? '<span class="pop-live">· 直播中</span>' : ''}</div>` +
    `<div class="pop-meta">${esc([seg.parentAreaName, seg.areaName].filter(Boolean).join(' / ') || '—')}</div>` +
    vh + '</div>';
  popEl.hidden = false;
  movePop(clientX, clientY);
}
function movePop(x, y) {
  if (popEl.hidden) return;
  const w = popEl.offsetWidth, h = popEl.offsetHeight;
  let left = x + 14, top = y + 14;
  if (left + w > window.innerWidth - 12) left = x - w - 14;
  if (top + h > window.innerHeight - 12) top = y - h - 14;
  popEl.style.left = left + 'px';
  popEl.style.top = top + 'px';
}
function hidePop() { popEl.hidden = true; popFor = null; }

// ---------- 装配 ----------
export function mountSchedule() {
  bodyEl = document.getElementById('schedule-body');
  axisEl = document.getElementById('schedule-axis');
  popEl = document.getElementById('sched-pop');
  // ?center=YYYY-MM-DD 可指定初始居中日（demo 走查便利参数）
  const initCenter = new URLSearchParams(location.search).get('center');
  schedLoad(initCenter && /^\d{4}-\d{2}-\d{2}$/.test(initCenter) ? initCenter : bjToday());

  const card = document.getElementById('card-schedule');
  card.addEventListener('wheel', e => {
    e.preventDefault();
    const now = Date.now();
    if (now - schedWheelLock < 300) return;
    schedWheelLock = now;
    if (e.deltaY > 0) schedStep(1);
    else if (e.deltaY < 0) schedStep(-1);
  }, { passive: false });

  // 点击非居中天居中
  bodyEl.addEventListener('click', e => {
    const row = e.target.closest('.sched-day');
    if (!row) return;
    const date = row.getAttribute('data-date');
    if (date === schedCenter) return;
    const diff = Math.round((Date.parse(date + 'T12:00:00Z') - Date.parse(schedCenter + 'T12:00:00Z')) / 86400000);
    schedStep(diff);
  });

  // hover 弹层（mini 行不触发）
  bodyEl.addEventListener('mouseover', e => {
    const bar = e.target.closest('.sched-bar');
    if (!bar) return;
    if (bar.closest('.sched-day').classList.contains('lv-mini')) return;
    const key = bar.getAttribute('data-edate') + ':' + bar.getAttribute('data-e');
    if (popFor === key) return;
    popFor = key;
    showPop(bar, e.clientX, e.clientY);
  });
  bodyEl.addEventListener('mousemove', e => {
    if (!popEl.hidden) movePop(e.clientX, e.clientY);
  });
  bodyEl.addEventListener('mouseout', e => {
    const bar = e.target.closest('.sched-bar');
    if (bar && !bar.contains(e.relatedTarget)) hidePop();
  });

  window.addEventListener('resize', () => { if (!document.getElementById('view-schedule').hidden) renderSchedBody(); });

  // 红线/在播条推进（60s；轴可能随时间变化则整体重算）
  setInterval(() => {
    if (document.getElementById('view-schedule').hidden) return;
    renderSched();
  }, 60000);
}

/** 视图从隐藏切回可见时调用：高度解算需要真实 clientHeight */
export function scheduleVisible() {
  if (schedAxis) { renderSchedAxis(); renderSchedBody(); }
}
