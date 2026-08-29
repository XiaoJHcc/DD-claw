// core.js — 重设计 Demo 的基础工具：图标 / HTML 助手 / 时间 / 事件委托 / sheet / toast
// 纯展示层，不含业务语义；所有「写入」操作在 Demo 里只改本地状态并 toast。

// ---- 图标集（24 viewBox，stroke 风格，圆角线帽）----
const ICONS = {
  paw: '<path d="M12 13.2c-2.9 0-5.3 2.1-5.3 4.6 0 1.7 1.2 2.9 2.9 2.9 1 0 1.6-.4 2.4-.4s1.4.4 2.4.4c1.7 0 2.9-1.2 2.9-2.9 0-2.5-2.4-4.6-5.3-4.6z" fill="currentColor" stroke="none"/><circle cx="5.6" cy="10.2" r="1.9" fill="currentColor" stroke="none"/><circle cx="9.2" cy="6.4" r="2" fill="currentColor" stroke="none"/><circle cx="14.8" cy="6.4" r="2" fill="currentColor" stroke="none"/><circle cx="18.4" cy="10.2" r="1.9" fill="currentColor" stroke="none"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3.5"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  users: '<circle cx="9" cy="8" r="3.4"/><path d="M3.4 19.5c.7-3.1 2.9-4.7 5.6-4.7s4.9 1.6 5.6 4.7"/><circle cx="16.8" cy="9" r="2.6"/><path d="M15.8 14.6c2.3.3 4 1.7 4.7 4"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.42a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09c0 .68.4 1.3 1.03 1.56a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08c.26.63.88 1.03 1.56 1.03H21a2 2 0 1 1 0 4h-.09c-.68 0-1.3.4-1.51 1.03z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  pencil: '<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
  trash: '<path d="M3 6h18M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6M19 6l-1 14.2a1.8 1.8 0 0 1-1.8 1.8H7.8A1.8 1.8 0 0 1 6 20.2L5 6M10 11v6M14 11v6"/>',
  bolt: '<path d="M13 2 3.5 13.5h7.7L10.8 22l9.5-11.5h-7.7L13 2z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  xmark: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.4 2"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  qrcode: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 14h3v3h-3zM21 14v.01M14 21v.01M21 21v.01M17.5 17.5v.01"/>',
  bell: '<path d="M18 8.5a6 6 0 1 0-12 0c0 6.5-2.7 8.5-2.7 8.5h17.4S18 15 18 8.5"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  sparkles: '<path d="M12 3.5 13.8 9l5.5 1.8-5.5 1.8L12 18l-1.8-5.4L4.7 10.8 10.2 9 12 3.5z"/><path d="M19 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z"/>',
  tag: '<path d="M12.6 2.6 21 11a2 2 0 0 1 0 2.8l-7.2 7.2a2 2 0 0 1-2.8 0L2.6 12.6A2 2 0 0 1 2 11.2V4a2 2 0 0 1 2-2h7.2a2 2 0 0 1 1.4.6z"/><circle cx="7.5" cy="7.5" r="1.4"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.7" cy="6" r="1.1" fill="currentColor" stroke="none"/><circle cx="3.7" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="3.7" cy="18" r="1.1" fill="currentColor" stroke="none"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="3.5"/><path d="M12 8V4.5M12 4.5h3"/><circle cx="9" cy="13.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="13.5" r="1.2" fill="currentColor" stroke="none"/><path d="M9.5 17.2c1.5 1 3.5 1 5 0"/>',
  headphone: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="2.5" y="14" width="5" height="7" rx="2.2"/><rect x="16.5" y="14" width="5" height="7" rx="2.2"/>',
  send: '<path d="M21 3 3 10.5l7 2.5m11-10-8 17-3-7m11-10L10 13"/>',
  grip: '<circle cx="9" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.4" fill="currentColor" stroke="none"/>',
  'video-off': '<path d="m16 16.5 5 3v-15l-5 3"/><rect x="2" y="5.5" width="14" height="13" rx="2.5"/><path d="m2.5 2.5 19 19"/>',
  link: '<path d="M10 14a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 10a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  message: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-3-.4-4.2-1L3 20l1.1-5.2A8.5 8.5 0 1 1 21 11.5z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6"/>',
};
export function icon(name) {
  const d = ICONS[name] || ICONS.tag;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
}
export function fillIcons(root) {
  root.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.getAttribute('data-icon')); el.removeAttribute('data-icon'); });
}

// ---- 基础助手 ----
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function avatarHtml(face, name, cls) {
  if (face) return `<img class="${cls || 'ava'}" src="${esc(face)}" referrerpolicy="no-referrer" onerror="this.outerHTML=avatarPhHtml('${esc((name || '?')[0])}','${cls || 'ava'}')">`;
  return avatarPhHtml((name || '?')[0], cls);
}
// onerror 回退需要全局可达
window.avatarPhHtml = avatarPhHtml;
export function avatarPhHtml(ch, cls) {
  return `<span class="avatar-ph ${cls || ''}">${esc(ch)}</span>`;
}

// ---- 时间格式化 ----
export function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
export function fmtClock(ts) {
  const d = new Date(ts * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export function relTime(ts) {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

// ---- 北京时间日界（06:00，仅用于归属，与服务端同口径）----
export function bjToday() { return new Date(Date.now() + 28800000).toISOString().slice(0, 10); }
export function bjAddDays(day, n) { return new Date(Date.parse(day + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
export function bjDayStart(day) { return Math.floor(Date.parse(day + 'T06:00:00+08:00') / 1000); }
export function bjDayKey(tsSec) { return new Date((tsSec + 7200) * 1000).toISOString().slice(0, 10); }

// ---- demo 时间冻结：无论哪天打开，"现在"锚在夹具导出瞬间（随后照常流动）----
export function freezeTime(fixedMs) {
  const RealDate = Date;
  const off = fixedMs - RealDate.now();
  class DemoDate extends RealDate {
    constructor(...a) { super(...(a.length ? a : [RealDate.now() + off])); }
    static now() { return RealDate.now() + off; }
  }
  window.Date = DemoDate;
}

// ---- 事件委托 ----
export const ACTIONS = {};
export const CHANGES = {};
export const INPUTS = {};
document.addEventListener('click', e => {
  const t = e.target.closest('[data-action]');
  if (t && ACTIONS[t.getAttribute('data-action')]) { ACTIONS[t.getAttribute('data-action')](t, e); }
});
document.addEventListener('change', e => {
  const t = e.target.closest('[data-change]');
  if (t && CHANGES[t.getAttribute('data-change')]) CHANGES[t.getAttribute('data-change')](t, e);
});
document.addEventListener('input', e => {
  const t = e.target.closest('[data-input]');
  if (t && INPUTS[t.getAttribute('data-input')]) INPUTS[t.getAttribute('data-input')](t, e);
});

// ---- 控件生成 ----
export function switchHtml(attrs, checked, disabled) {
  return `<label class="sw${disabled ? ' dis' : ''}"><input type="checkbox" ${attrs} ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}><i></i></label>`;
}
export function checkDotHtml(attrs, checked) {
  return `<button class="checkdot${checked ? ' on' : ''}" ${attrs}>${icon('check')}</button>`;
}
export function iconBtn(action, iconName, title, danger, extra) {
  return `<button class="icon-btn${danger ? ' danger' : ''}" data-action="${action}" title="${esc(title || '')}" ${extra || ''}>${icon(iconName)}</button>`;
}
export function gripHtml() { return `<span class="grip">${icon('grip')}</span>`; }

// ---- sheet 两级弹窗 ----
const sheetCleanups = { 1: [], 2: [] };
export function openSheet(title, bodyHtml, level = 1, footHtml) {
  const mask = document.getElementById('sheet-mask' + level);
  const sheet = document.getElementById('sheet' + level);
  sheet.innerHTML =
    `<div class="sheet-head"><b>${title}</b><button class="sheet-x" data-action="sheet-x" data-level="${level}">${icon('xmark')}</button></div>` +
    `<div class="sheet-body">${bodyHtml}</div>` +
    (footHtml !== null ? `<div class="sheet-foot">${footHtml ?? `<span class="sp"></span><button class="btn btn-line" data-action="sheet-x" data-level="${level}">取消</button><button class="btn btn-primary" data-action="sheet-save" data-level="${level}">保存</button>`}</div>` : '');
  mask.hidden = false;
}
export function closeSheet(level = 1) {
  (sheetCleanups[level] || []).forEach(fn => { try { fn(); } catch { } });
  sheetCleanups[level] = [];
  const mask = document.getElementById('sheet-mask' + level);
  mask.hidden = true;
  document.getElementById('sheet' + level).innerHTML = '';
}
export function onSheetCleanup(level, fn) { sheetCleanups[level].push(fn); }
ACTIONS['sheet-x'] = t => closeSheet(Number(t.getAttribute('data-level')) || 1);
ACTIONS['sheet-save'] = t => { toast('演示模式：改动不会真正保存'); closeSheet(Number(t.getAttribute('data-level')) || 1); };
document.getElementById('sheet-mask1').addEventListener('click', e => { if (e.target.id === 'sheet-mask1') closeSheet(1); });
document.getElementById('sheet-mask2').addEventListener('click', e => { if (e.target.id === 'sheet-mask2') closeSheet(2); });

// ---- toast ----
export function toast(msg, isErr) {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.innerHTML = `<span class="t-ic">${icon(isErr ? 'xmark' : 'check')}</span><span>${esc(msg)}</span>`;
  box.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 350); }, 2600);
}

// 复选行/选择行的勾选圆点与隐藏 checkbox 视觉同步（纯演示态）
document.addEventListener('change', e => {
  const cb = e.target;
  if (!(cb instanceof HTMLInputElement) || cb.type !== 'checkbox') return;
  const row = cb.closest('.check-row, .pick-row');
  if (!row) return;
  const dot = row.querySelector('.checkdot');
  if (dot) dot.classList.toggle('on', cb.checked);
});

// ---- 表单字段 ----
export function field(label, inner, hint) {
  return `<div class="field"><label>${esc(label)}</label>${inner}${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</div>`;
}
export function checkRowHtml(attrs, checked, innerHtml) {
  return `<label class="check-row"><input type="checkbox" hidden ${attrs} ${checked ? 'checked' : ''}><span class="cr-main">${innerHtml}</span>${checkDotHtml('', checked)}</label>`;
}
