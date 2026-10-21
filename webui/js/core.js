// 面板前端公共模块：esc / api（含配置写白名单 → 联动刷新钩子）/ toast（顶部胶囊）/ sheet（两级统一弹窗）/ 开关与勾选框与图标按钮 /
// 自绘下拉 dropdownHtml / 通用拖拽排序 makeSortable / 事件委托（data-action / data-change / data-input）/
// fitRow 行宽适配 / 头像兜底 avatarHtml / 时长每秒重算 / onConfigWrite + onTableRefresh（写成功与撤销后的刷新注册表）。
// 视觉 = UI 重设计 v2 基座（2026-09 平移），接口保持生产现状（卡片模块在用，导出签名不变）。
// 本模块是被各卡模块显式 import 的唯一公共依赖，导出全部共享符号。
import { icon } from './icons.js';

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// ---- 逗号分隔列表输入的唯一拆分口径：中英文逗号均可，去空白去空项 ----
// ---- （关键词/分区/实例等输入框统一走这里，别在卡片模块里再写 split(',')）----
export function splitCsv(v) {
  return String(v == null ? '' : v).split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
}
// ---- 配置写白名单（统一联动刷新的口径；2026-09-22 「同页操作后历史不更新」的重做）----
// 只有「人改配置」的写请求才触发联动：非 GET 且路径落在下面这些前缀里。前缀后必须是 / 或结尾，
// 免得 /api/x 误吞 /api/x-avatar 这类读接口。排除项逐条都有明确理由：
//   · `/test` 结尾的探活（POST /api/llm/providers/<n>/test、/api/push/test、/api/x/test）——不改库；
//   · /api/napcat/launch 这类动作按钮——不改配置，也不进变更历史；
//   · /api/chat 的回合（POST /api/chat 很慢）与 /api/chat/reset——不碰配置；
//   · /api/undo*——撤销执行器自己会刷历史（见 undo.js）；
//   · /api/auth/*——扫码建码与轮询，都不进配置面。
// 唯一「看起来该排除、其实要收」的是 /api/chat/mode 与 /api/chat/provider：它们经注册表
// （set_chat_mode / set_chat_provider）落库，是**真配置写**，会进变更历史，故按整条路径列进来。
// 轮询一律是 GET，天然被挡在门外。
const CONFIG_WRITE_PREFIXES = [
  '/api/llm', '/api/decision', '/api/advanced', '/api/categories', '/api/rules', '/api/channels',
  '/api/streamers', '/api/follows', '/api/listen', '/api/push',
  '/api/x', '/api/weibo', '/api/bili', '/api/napcat', '/api/chat/mode', '/api/chat/provider',
];
function isConfigWrite(path, method) {
  if (!method || String(method).toUpperCase() === 'GET') return false;
  if (path.indexOf('/test') >= 0 || path === '/api/napcat/launch') return false;
  for (var i = 0; i < CONFIG_WRITE_PREFIXES.length; i++) {
    var p = CONFIG_WRITE_PREFIXES[i];
    if (path === p || path.indexOf(p + '/') === 0) return true;
  }
  return false;
}
// 配置写成功后的钩子（undo.js 用它刷「变更历史」；注册表而非直接 import，避免 core ←→ 卡片模块成环）
const configWriteHooks = [];
export function onConfigWrite(fn) { if (configWriteHooks.indexOf(fn) < 0) configWriteHooks.push(fn); }

export function api(path, method, body) {
  return fetch(path, {
    method: method || 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(function (r) {
    return r.json().then(function (j) {
      if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
      if (isConfigWrite(path, method)) {
        for (var i = 0; i < configWriteHooks.length; i++) {
          try { configWriteHooks[i](path); } catch (e) { /* 联动刷新失败绝不影响本次写的成功 */ }
        }
      }
      return j;
    });
  });
}
// ---- 表名 → 数据刷新函数（撤销后把页面状态拉回真实态）----
// 注册表：卡片模块 import 副作用即登记自己的 loader（各模块的 loader 不必为此外抛）。
// 表名口径 = 服务端 /api/undo/history 的 tables（core/undo.ts 的 DEFAULT_CONFIG_TABLES）；
// 一个表可以挂多个 loader（如 categories → 分类卡与规则卡的分类快照），同一函数只跑一次。
const tableRefreshers = new Map();
export function onTableRefresh(tables, fn) {
  for (var i = 0; i < tables.length; i++) {
    var t = tables[i];
    var set = tableRefreshers.get(t);
    if (!set) { set = []; tableRefreshers.set(t, set); }
    if (set.indexOf(fn) < 0) set.push(fn);
  }
}
/** 按受影响表刷新卡片（去重；单个 loader 抛错不影响其余） */
export function refreshTables(tables) {
  var fns = [];
  for (var i = 0; i < (tables || []).length; i++) {
    var set = tableRefreshers.get(tables[i]) || [];
    for (var j = 0; j < set.length; j++) if (fns.indexOf(set[j]) < 0) fns.push(set[j]);
  }
  for (var k = 0; k < fns.length; k++) {
    try { fns[k](); } catch (e) { /* 刷新失败由各 loader 自己 toast */ }
  }
  return fns.length;
}
// ---- toast：顶部居中浮动胶囊，成功绿/错误红，约 3s 自动消失，多条纵向堆叠 ----
export function toast(msg, isErr) {
  var host = document.getElementById('toasts');
  if (!host) return;
  var el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.innerHTML = icon(isErr ? 'xmark' : 'check') + '<span></span>';
  el.querySelector('span').textContent = msg;
  host.appendChild(el);
  setTimeout(function () {
    el.classList.add('out');
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 350);
  }, 3000);
}
// ---- 事件委托：消灭内联 on* 处理器。渲染只写 data-action / data-change / data-input 与 ----
// ---- data-id 等数据属性，处理函数注册进这三张表；所有插值必须过 esc() ----
export var ACTIONS = {};
export var CHANGES = {};
export var INPUTS = {};
document.addEventListener('click', function (e) {
  if (!(e.target instanceof Element)) return;
  var el = e.target.closest('[data-action]');
  if (!el) return;
  var fn = ACTIONS[el.getAttribute('data-action')];
  if (fn) fn(el, e);
});
document.addEventListener('change', function (e) {
  if (!(e.target instanceof Element)) return;
  var el = e.target.closest('[data-change]');
  if (!el) return;
  var fn = CHANGES[el.getAttribute('data-change')];
  if (fn) fn(el, e);
});
document.addEventListener('input', function (e) {
  if (!(e.target instanceof Element)) return;
  var el = e.target.closest('[data-input]');
  if (!el) return;
  var fn = INPUTS[el.getAttribute('data-input')];
  if (fn) fn(el, e);
});
// 卡片里的链接等需要吞掉卡片点击的元素标 data-action="noop"（导航等默认行为不受影响）
ACTIONS.noop = function () {};
// ---- sheet：统一两级弹窗（1 主弹窗 / 2 嵌套弹窗），遮罩点击或右上角 × 关闭 ----
// sheetCleanups 由打开方注册清理逻辑（停轮询、清状态等），关窗时执行。
// 可选第四参 footHtml：传字符串 = 自定义底部按钮区；传 null = 无底部区（v2 形态）；
// 省略 = 不加底部区（生产现存调用把按钮写在 bodyHtml 内的 .sheet-foot 里，两种都支持）。
export var sheetCleanups = { 1: null, 2: null };
export function openSheet(title, bodyHtml, level, footHtml) {
  var l = level || 1;
  closeDropDown();
  var mask = document.getElementById('sheet-mask' + l);
  mask.querySelector('.sheet').innerHTML =
    // .sheet-title 类保留：streamers.js 详情弹窗事后往标题里插 .sheet-head-meta
    `<div class="sheet-head"><b class="sheet-title">${esc(title)}</b>` +
    `<button class="sheet-x" data-action="close-sheet" data-level="${l}" title="关闭" aria-label="关闭">` +
    `${icon('xmark')}</button></div>` +
    `<div class="sheet-body">${bodyHtml}</div>` +
    (footHtml != null ? `<div class="sheet-foot">${footHtml}</div>` : '');
  mask.classList.remove('hidden');
}
export function closeSheet(level) {
  var l = level || 1;
  closeDropDown(); // 打开中的下拉菜单在 body 上，弹窗一关先收回
  if (sheetCleanups[l]) { try { sheetCleanups[l](); } catch (e) {} sheetCleanups[l] = null; }
  document.getElementById('sheet-mask' + l).classList.add('hidden');
  document.querySelector('#sheet-mask' + l + ' .sheet').innerHTML = '';
}
ACTIONS['close-sheet'] = function (el) { closeSheet(Number(el.getAttribute('data-level')) || 1); };
(function () {
  for (var l = 1; l <= 2; l++) {
    (function (lv) {
      document.getElementById('sheet-mask' + lv).addEventListener('click', function (e) {
        if (e.target === this) closeSheet(lv);
      });
    })(l);
  }
})();
// ---- 通用控件 ----
// 开关：宽胶囊滑块（42×20 轨道 + 24×16 滑块），关 = 中性灰，开 = 蓝渐变 + 轨道内阴影
export function switchHtml(attrs, checked, disabled) {
  return `<label class="switch"><input type="checkbox" ${attrs}` +
    `${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}><span class="knob"></span></label>`;
}
export function iconBtn(action, iconName, title, danger) {
  return `<button class="icon-btn${danger ? ' danger' : ''}" data-action="${action}"` +
    ` title="${esc(title)}" aria-label="${esc(title)}">${icon(iconName)}</button>`;
}
// 勾选框（圆环 → 蓝盘白勾）：并排多选场景用（供应商多模态 / 详情三选项 / 关键帧开关）
// text 非空时把文字包进同一个 label（点击文字也切换）
export function checkboxHtml(attrs, checked, disabled, text) {
  return `<label class="checkbox"><input type="checkbox" ${attrs}` +
    `${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}><span class="box"></span>` +
    `${text ? `<span class="check-text">${esc(text)}</span>` : ''}</label>`;
}
// 多选行：整行是 label，点击任意处切换（v2 形态：隐藏 input + 内容区 + 尾端勾选圆点，
// 圆点选中态由 CSS 兄弟选择器 input:checked ~ .checkdot 驱动，无需 JS 同步）。
// extraClass 例：'ref-off' = 引用对象（渠道）已停用——保留勾选状态，仅视觉置灰划线
export function checkRowHtml(attrs, checked, innerHtml, extraClass) {
  // checkdot 不带 .on 静态类——否则初始勾选的行点掉 input 后 .on 仍在，视觉上「无法取消」
  return `<label class="check-row${extraClass ? ' ' + extraClass : ''}">` +
    `<input type="checkbox" hidden ${attrs}${checked ? ' checked' : ''}>` +
    `<span class="cr-main">${innerHtml}</span>` +
    `<span class="checkdot"><i>${icon('check')}</i></span></label>`;
}
// 推送规则可达性（两张规则卡与主播详情弹窗共用，live/post 两形态同一套判定）：引用对象被
// 停用/删除会让规则实际失效。返回 null = 可达；否则为原因文案：规则自身停用 / 分类已删除 /
// 分类已停用（分类判定只跑启用分类，永不命中）/ 分类与内容形态不符（分类只服务另一种内容，
// 判定集里永远没有它）/ 未选渠道（命中后渠道并集为空不推）/ 渠道不可用（所选渠道全部停用或
// 已删除，dispatcher 只发「选中且启用」）。uids 全为主播 watch=0 属临时态，不算死态。
export function mergeVisibleOrder(items, ids) {
  const visible = new Set(ids);
  let next = 0;
  return items.map(function (item) { return visible.has(item.id) ? ids[next++] : item.id; });
}

export function ruleDeadReason(r, cats, chans) {
  if (!r.enabled) return '已停用';
  if (r.categoryId != null) {
    let cat = null;
    for (let i = 0; i < cats.length; i++) if (cats[i].id === r.categoryId) cat = cats[i];
    if (!cat) return '分类已删除';
    if (cat.enabled === false) return '分类已停用';
    if ((cat.appliesTo || 'live') !== (r.subjectKind || 'live')) return '分类与内容形态不符';
  }
  if (!r.channels || r.channels.length === 0) return '未选渠道';
  let usable = 0;
  for (let i = 0; i < r.channels.length; i++) {
    for (let j = 0; j < chans.length; j++) {
      if (chans[j].id === r.channels[i] && chans[j].enabled) { usable++; break; }
    }
  }
  if (usable === 0) return '渠道不可用';
  return null;
}
// 勾选排序列表的启停勾：圆环 → 蓝盘白勾（input:checked + .cd 驱动，占位对齐）
export function checkDotHtml(attrs, checked, disabled) {
  return `<label class="checkdot"><input type="checkbox" ${attrs}` +
    `${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}><span class="cd"></span></label>`;
}
export function gripHtml() { return `<span class="grip" title="拖拽排序">${icon('grip')}</span>`; }
// ---- 胶囊分段导航（segnav）：通用单选切换条。灰轨道 + 白色滑块（thumb），切换时滑块 ----
// ---- 横滑过去（left/width 过渡）。两档尺寸：lg = 页面级筛选条 / sm = 弹窗内切换。 ----
// 用法：segnavHtml(items, active, size, action) 出骨架插入 DOM → layoutSegnav(nav, false)
// 无动画定位滑块；点击由调用方的 data-action 处理（改状态后调 segnavSelect 滑过去）。
// ResizeObserver 跟随容器尺寸/可见性变化重定位（视图从 hidden 切回时 offsetWidth 才有值）。
export function segnavHtml(items, active, size, action) {
  return `<div class="segnav segnav-${size === 'sm' ? 'sm' : 'lg'}"><span class="segnav-thumb"></span>` +
    items.map(function (it) {
      return `<button type="button" class="segnav-item${String(it.value) === String(active) ? ' on' : ''}"` +
        ` data-action="${esc(action)}" data-value="${esc(String(it.value))}">${esc(it.label)}</button>`;
    }).join('') + '</div>';
}
var segnavSeen = new WeakSet();
var segnavRO = new ResizeObserver(function (es) {
  for (var i = 0; i < es.length; i++) layoutSegnav(es[i].target, false);
});
/** 把滑块定位到当前 .on 项（animate=false 时瞬移，用于首渲与尺寸跟随） */
export function layoutSegnav(nav, animate) {
  if (!nav) return;
  var thumb = nav.querySelector('.segnav-thumb');
  var on = nav.querySelector('.segnav-item.on');
  if (!thumb) return;
  if (!animate) nav.classList.add('noanim');
  if (on && on.offsetWidth) {
    thumb.style.left = on.offsetLeft + 'px';
    thumb.style.width = on.offsetWidth + 'px';
  }
  if (!animate) { void nav.offsetHeight; nav.classList.remove('noanim'); }
  if (!segnavSeen.has(nav)) { segnavSeen.add(nav); segnavRO.observe(nav); }
}
/** 切换选中项并滑动滑块（点击处理里调；业务状态变更仍是调用方自己的事） */
export function segnavSelect(nav, value) {
  if (!nav) return;
  var items = nav.querySelectorAll('.segnav-item');
  for (var i = 0; i < items.length; i++) {
    items[i].classList.toggle('on', items[i].getAttribute('data-value') === String(value));
  }
  layoutSegnav(nav, true);
}
export function field(label, inputHtml) {
  return `<div class="field"><label class="field-label">${esc(label)}</label>${inputHtml}</div>`;
}
// ---- 头像（v2 吸收）：有图用 img，无图/加载失败 = 首字占位圆（.avatar-ph）。
// 加载失败兜底走捕获阶段 error 委托（不内联 onerror——本项目禁用内联事件处理器） ----
export function avatarHtml(face, name, cls) {
  cls = cls || 'ava';
  var ch = String(name || '?').charAt(0);
  if (face) return `<img class="${cls}" src="${esc(face)}" alt="" referrerpolicy="no-referrer" data-ph="${esc(ch)}">`;
  return avatarPhHtml(ch, cls);
}
export function avatarPhHtml(ch, cls) {
  return `<span class="avatar-ph ${cls || 'ava'}">${esc(ch)}</span>`;
}
document.addEventListener('error', function (e) {
  var t = e.target;
  if (!(t instanceof HTMLImageElement) || !t.hasAttribute('data-ph')) return;
  t.outerHTML = avatarPhHtml(t.getAttribute('data-ph'), t.className);
}, true);
// ---- 时间格式化（v2 吸收）----
// 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前
export function relTime(ts) {
  var diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  return Math.floor(diff / 86400) + ' 天前';
}
// 开播时长：h:mm:ss / m:ss（融进 LIVE 角标，读起来像计时器）
export function fmtLiveDur(sec) {
  sec = Math.max(0, Math.floor(sec));
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  var mm = String(m).padStart(h ? 2 : 1, '0'), ss = String(s).padStart(2, '0');
  return h ? h + ':' + mm + ':' + ss : mm + ':' + ss;
}
// ---- 下拉选择（自绘，完全替代原生 select）：触发器观感同输入框，caret 为 chevron 图标重画，
// 展开列表为 fixed 自绘 div（搬到 body、随触发器宽度、空间不足自动上翻），不弹任何原生菜单。
// 值/事件状态仍挂在隐藏的原生 select（.dd-native）上：getElementById(id).value 与 change 事件
// （data-change 委托）照常可用，程序化回填用 ddSetValue 同步触发器文本。
// 选项可带 off:true（引用对象已停用，如分类）：写入 option 的 data-off，选项与触发器文本置灰划线。
const ddCaret = icon('chevron-down');
function ddOptOff(o) { return o.getAttribute('data-off') === '1'; }
function ddSyncTrigger(id) {
  const sel = document.getElementById(id);
  const labelEl = document.querySelector('.dd-trigger[data-dd="' + id + '"] .dd-value');
  if (!sel || !labelEl) return;
  if (sel.multiple) {
    const selected = Array.from(sel.selectedOptions);
    labelEl.textContent = selected.length ? selected.map(function (option) { return option.textContent; }).join('、') : sel.getAttribute('data-placeholder');
    labelEl.classList.toggle('dd-placeholder', selected.length === 0);
    labelEl.classList.remove('off');
    return;
  }
  const cur = sel.options[sel.selectedIndex];
  if (!cur) return;
  labelEl.textContent = cur.textContent;
  labelEl.classList.toggle('off', ddOptOff(cur));
}
export function dropdownHtml(id, options, value, changeAction, placeholder) {
  const opts = options || [];
  const multiple = Array.isArray(value);
  const selectedValues = multiple ? value.map(String) : [];
  const selIdx = Math.max(0, opts.findIndex(function (o) { return String(o.value) === String(value); }));
  const selOpts = opts.map(function (o, i) {
    const selected = multiple ? selectedValues.includes(String(o.value)) : i === selIdx;
    return `<option value="${esc(o.value)}"${selected ? ' selected' : ''}` +
      `${o.off ? ' data-off="1"' : ''}>${esc(o.label)}</option>`;
  }).join('');
  const cur = opts[selIdx];
  const selectedOpts = multiple ? opts.filter(function (option) { return selectedValues.includes(String(option.value)); }) : [];
  const label = multiple ? (selectedOpts.length ? selectedOpts.map(function (option) { return option.label; }).join('、') : (placeholder || '请选择')) : (cur ? cur.label : '');
  return `<div class="dd"><select id="${id}" class="dd-native"` +
    (multiple ? ` multiple data-placeholder="${esc(placeholder || '请选择')}"` : '') +
    `${changeAction ? ' data-change="' + changeAction + '"' : ''}>${selOpts}</select>` +
    `<button type="button" class="dd-trigger" data-action="dd-toggle" data-dd="${id}" aria-haspopup="listbox" aria-expanded="false">` +
    `<span class="dd-value${multiple ? (selectedOpts.length ? '' : ' dd-placeholder') : (cur && cur.off ? ' off' : '')}">${esc(label)}</span>${ddCaret}</button></div>`;
}
export function ddSetValue(id, value) {
  const sel = document.getElementById(id);
  if (!sel) return;
  sel.value = value;
  ddSyncTrigger(id);
}
var openDd = null;
var ddMenus = {};
ACTIONS['dd-toggle'] = function (el) {
  const id = el.getAttribute('data-dd');
  if (openDd === id) { closeDropDown(true); return; }
  openDropDown(id);
};
ACTIONS['dd-pick'] = function (el) {
  pickDropDown(el.getAttribute('data-dd'), el.getAttribute('data-ddv'));
};
function openDropDown(id) {
  const sel = document.getElementById(id);
  const trig = document.querySelector('.dd-trigger[data-dd="' + id + '"]');
  if (!sel || !trig) return;
  if (openDd) closeDropDown();
  const rows = Array.prototype.map.call(sel.options, function (o) {
    return `<button type="button" role="option" aria-selected="${o.selected}" class="dd-opt${o.selected ? ' sel' : ''}` +
      `${ddOptOff(o) ? ' off' : ''}" data-action="dd-pick" data-dd="${id}" data-ddv="${esc(o.value)}">` +
      `<span class="dd-opt-txt">${esc(o.textContent)}</span>` + icon('check') + `</button>`;
  }).join('');
  let menu = ddMenus[id];
  if (!menu) {
    menu = document.createElement('div');
    menu.className = 'dd-menu';
    menu.setAttribute('role', 'listbox');
    document.body.appendChild(menu);
    ddMenus[id] = menu;
  }
  menu.innerHTML = rows;
  menu.setAttribute('aria-multiselectable', String(sel.multiple));
  trig.setAttribute('aria-expanded', 'true');
  menu.classList.remove('show');   // visibility:hidden 仍可测量，定位后再 visible
  menu.classList.add('open');      // display:block 供测量高度
  const r = trig.getBoundingClientRect();
  const mh = menu.offsetHeight;
  menu.style.width = Math.max(r.width, 160) + 'px';
  menu.style.left = r.left + 'px';
  const below = window.innerHeight - r.bottom;
  menu.style.top = (below >= mh || below >= r.top ? r.bottom : r.top - mh) + 'px';
  openDd = id;
  const first = menu.querySelector('.dd-opt.sel') || menu.querySelector('.dd-opt');
  if (first) { first.focus(); first.scrollIntoView({ block: 'nearest' }); }
  requestAnimationFrame(function () { if (openDd === id) menu.classList.add('show'); });
}
function closeDropDown(refocus) {
  if (!openDd) return;
  const id = openDd;
  openDd = null;
  const menu = ddMenus[id];
  if (menu) { menu.classList.remove('open'); menu.classList.remove('show'); }
  const trigger = document.querySelector('.dd-trigger[data-dd="' + id + '"]');
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
  if (refocus) {
    const trig = document.querySelector('.dd-trigger[data-dd="' + id + '"]');
    if (trig) trig.focus();
  }
}
function pickDropDown(id, value) {
  const sel = document.getElementById(id);
  if (!sel) return;
  if (sel.multiple) {
    const option = Array.from(sel.options).find(function (option) { return String(option.value) === String(value); });
    if (!option) return;
    option.selected = !option.selected;
    ddSyncTrigger(id);
    const menu = ddMenus[id];
    if (menu) menu.querySelectorAll('.dd-opt').forEach(function (entry) {
      if (entry.getAttribute('data-ddv') !== String(value)) return;
      entry.classList.toggle('sel', option.selected);
      entry.setAttribute('aria-selected', String(option.selected));
    });
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  if (String(sel.value) !== String(value)) {
    sel.value = value;
    ddSyncTrigger(id); // 同步触发器文本与 off 态（引用对象停用时选中项划线）
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
  closeDropDown(true);
}
document.addEventListener('click', function (e) {
  if (!openDd || !(e.target instanceof Element)) return;
  if (e.target.closest('[data-dd], .dd-menu')) return; // 触发器/选项由 data-action 处理
  closeDropDown();
});
document.addEventListener('keydown', function (e) {
  if (!openDd) {
    const a = document.activeElement;
    if (a && a.matches && a.matches('.dd-trigger[data-dd]') && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      openDropDown(a.getAttribute('data-dd'));
    }
    return;
  }
  if (e.key === 'Escape') { e.preventDefault(); closeDropDown(true); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const menu = ddMenus[openDd];
    if (!menu) return;
    const opts = menu.querySelectorAll('.dd-opt');
    if (!opts.length) return;
    let i = Array.prototype.indexOf.call(opts, document.activeElement);
    i = e.key === 'ArrowDown' ? Math.min(opts.length - 1, i + 1) : Math.max(0, i - 1);
    if (i < 0) i = e.key === 'ArrowDown' ? 0 : opts.length - 1;
    opts[i].focus();
    opts[i].scrollIntoView({ block: 'nearest' });
  }
});
// 渠道类型 → 人话标签（推送卡片与规则编辑共用）
export function chanTypeName(c) {
  if (c.notifier === 'toast') return '系统通知';
  return c.targetType === 'group' ? 'QQ群' : 'QQ私聊';
}
export function chanTag(c) {
  if (c.targetType === 'group') return 'QQ群 ' + (c.targetId || '');
  if (c.targetType === 'private') return 'QQ私聊 ' + (c.targetId || '');
  return '系统通知';
}
// ---- 通用拖拽排序：provider / 渠道 / 分类 / 规则四套列表共用 ----
// 行需 .row[data-sid]（不需要 draggable 属性；拖拽把手为行内 .grip，行身也可拖）。
// 视觉 = v2：被拖行脱离流（fixed）浮起跟随鼠标（浅蓝底 + 中性阴影），原位插 .drop-gap
// 内嵌浅蓝块预留空位，移动中按「指针越过相邻行中线」实时搬 gap，其余行 FLIP 平滑让位，
// 松手落入槽位并调 opts.onOrder(ids) 落库。
// opts: { items: fn() 当前数组, getId: fn(item), onOrder: fn(ids) 落库 }
export function makeSortable(container, opts) {
  var drag = null;         // 活动中的拖拽状态
  var pending = null;      // 待确认拖拽（pointerdown 后未超过移动阈值）
  var raf = 0;
  var suppressClick = false; // 拖拽结束后吞掉合成 click，防误触行内按钮

  container.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 || drag || pending) return;
    if (!(e.target instanceof Element)) return;
    var t = e.target;
    if (t.closest('button, input, label, select, a')) return; // 控件区不发起拖拽
    var row = t.closest('.row');
    if (row && row.getAttribute('data-sid') != null) {
      e.preventDefault();
      pending = { row: row, x: e.clientX, y: e.clientY, offX: 0, offY: 0 };
      try { t.setPointerCapture(e.pointerId); } catch (err) {} // 移到窗口外也不丢事件
    }
  });

  document.addEventListener('pointermove', function (e) {
    if (drag) {
      drag.px = e.clientX; drag.py = e.clientY;
      if (!raf) raf = requestAnimationFrame(step);
    } else if (pending) {
      var dx = e.clientX - pending.x, dy = e.clientY - pending.y;
      if (dx * dx + dy * dy > 16) {              // 超过 4px 阈值才真正开始拖
        var r = pending.row.getBoundingClientRect();
        pending.offX = e.clientX - r.left;
        pending.offY = e.clientY - r.top;
        begin(pending, r);
        pending = null;
      }
    }
  });

  function finishPointer() {
    pending = null;
    if (drag) end(drag);
  }
  document.addEventListener('pointerup', finishPointer);
  document.addEventListener('pointercancel', function () { abort(); });
  window.addEventListener('blur', function () { abort(); });

  function begin(p, rect) {
    var gap = document.createElement('div');
    gap.className = 'drop-gap';                   // 空位槽：与行同外边距同圆角的内嵌浅蓝块
    gap.style.height = rect.height + 'px';
    drag = { row: p.row, gap: gap, offX: p.offX, offY: p.offY, px: 0, py: 0 };
    container.insertBefore(gap, p.row);           // 让位：原行位置换成空槽
    p.row.classList.add('dragging');
    var st = p.row.style;
    st.position = 'fixed';                        // 悬浮跟随鼠标，脱离文档流
    st.left = rect.left + 'px';
    st.top = rect.top + 'px';
    st.width = rect.width + 'px';
    st.margin = '0';
    document.body.classList.add('sort-dragging');
    suppressClick = true;
  }

  function stillRows() { // 非拖拽行（gap 之后的最近一行 = gap 当前位置参照）
    return Array.prototype.filter.call(container.querySelectorAll('.row'), function (el) {
      return !el.classList.contains('dragging');
    });
  }

  function step() {
    raf = 0;
    var d = drag;
    if (!d) return;
    d.row.style.left = (d.px - d.offX) + 'px';
    d.row.style.top = (d.py - d.offY) + 'px';
    // 找鼠标所在的槽位：第一个「中线在指针下方」的元素之前的空位
    var y = d.py, kids = container.children, i = 0;
    for (; i < kids.length; i++) {
      var el = kids[i];
      if (el === d.row) continue;                 // 悬浮行不参与让位计算
      var r = el.getBoundingClientRect();
      if (y < r.top + r.height / 2) break;
    }
    var gap = d.gap;
    if (i < kids.length && kids[i] === gap) return; // 已在目标槽位，无需移动
    var sibs = stillRows();
    var tops = new Map(sibs.map(function (el) { return [el, el.getBoundingClientRect().top]; }));
    if (i >= kids.length) container.appendChild(gap);
    else container.insertBefore(gap, kids[i]);      // 实时更新排序槽位
    for (var j = 0; j < sibs.length; j++) {         // FLIP 让位
      var el2 = sibs[j];
      var dy = tops.get(el2) - el2.getBoundingClientRect().top;
      if (!dy) continue;
      el2.style.transition = 'none';
      el2.style.transform = 'translateY(' + dy + 'px)';
      void el2.offsetHeight;
      el2.style.transition = 'transform .18s ease';
      el2.style.transform = '';
      // 过渡结束后清掉内联 transition，恢复 CSS 的 hover 底色过渡
      el2.addEventListener('transitionend', function () {
        if (!el2.style.transform) el2.style.transition = '';
      }, { once: true });
    }
  }

  // 鼠标取消/失焦：中止拖拽，还原视觉但不提交排序（DOM 仍是原序）
  function abort() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    pending = null;
    var d = drag;
    drag = null;
    if (!d) return;
    document.body.classList.remove('sort-dragging');
    d.row.classList.remove('dragging');
    var st = d.row.style;
    st.position = ''; st.left = ''; st.top = ''; st.width = ''; st.margin = '';
    if (d.gap.parentNode === container) container.removeChild(d.gap);
  }

  function end(d) {
    drag = null;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    document.body.classList.remove('sort-dragging');
    d.row.classList.remove('dragging');
    var st = d.row.style;
    st.position = ''; st.left = ''; st.top = ''; st.width = ''; st.margin = '';
    if (!d.row.isConnected) {                       // 拖拽中被重渲，放弃本次
      if (d.gap.parentNode === container) container.removeChild(d.gap);
      return;
    }
    var kids = container.children;
    var at = Array.prototype.indexOf.call(kids, d.gap);
    if (at >= 0) container.removeChild(d.gap);
    if (at >= kids.length || at < 0) container.appendChild(d.row);
    else container.insertBefore(d.row, kids[at]); // 松手:插入空位槽所在位置
    var ids = [];
    // data-sid 是字符串，但落库 id 要按各列表类型来：渠道/分类/规则 = number，provider = string。
    // 直接取 data-sid 会发成字符串 → 服务端校验 400（mock 里 indexOf 也不匹配）→ 一边还原一边报错。
    var items = opts.items();
    var bySid = {};
    for (var j = 0; j < items.length; j++) bySid[String(opts.getId(items[j]))] = items[j];
    var rows = container.querySelectorAll('.row[data-sid]');
    for (var i = 0; i < rows.length; i++) {
      var it = bySid[rows[i].getAttribute('data-sid')];
      if (it !== undefined) ids.push(opts.getId(it));
    }
    var same = ids.length === items.length;
    for (var j2 = 0; j2 < items.length && same; j2++) {
      if (String(ids[j2]) !== String(opts.getId(items[j2]))) same = false;
    }
    if (!same) opts.onOrder(ids);               // 顺序没变不落库（点一下 grip 不算拖）
  }

  // 拖拽结束后吞掉该次合成 click，避免落到行内按钮上误触发动作
  document.addEventListener('click', function (e) {
    if (!suppressClick) return;
    suppressClick = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}
// ---- 行内标签自适应舍弃（fitRow）：行宽不足时从最后一枚标签开始整枚隐藏，
// 全部隐藏后才轮到标题截断（.row-title 的 ellipsis），两侧控件（flex:none）永不被挤。
// CSS 表达不了「按内容」的优先级（flex 收缩只会把标签压成无信息量的碎片），故用 JS：
// ResizeObserver 跟行宽变化（含视图从隐藏切回），MutationObserver 捕获重渲插入的新行 ----
// 标签可以在行直接子级（.row-title + .tag 同层的单行档）或 .row-main > .row-line 内部
//（分类卡/规则卡：标题与摘要标签同在一条 line 里）——两种结构同一套舍弃逻辑。
// 溢出判定不能看 row.scrollWidth：行右 padding + 行尾负 margin 有约 20px 静默余量，
// 小溢出会被吞掉（表现为标签完整、标题反被 flex 压出省略号）。改为钉回标题自然宽度后，
// 比较行内容区右缘与「参照末元素」（有 line 看 line 的末元素，否则行的末元素）右缘。
function rowOverflows(row) {
  var main = row.querySelector(':scope > .row-main');
  var line = main && main.querySelector(':scope > .row-line');
  // 有 line 的行（标题 + 摘要标签嵌在 row-main 里）：可用宽度止于 row-end（编辑/删除钮，
  // flex:none）之前——以 row-main 右缘为界，否则标签盖到按钮上也不算溢出；
  // 单行档（标签是行直接子级）：以行内容区右缘为界（原口径）。
  // 末元素要跳过已隐藏（fitRow 正在逐枚舍弃的）标签，否则 rect 全 0 永不溢出、循环提前退出
  var kids = line ? line.children : row.children;
  var last = null;
  for (var i = kids.length - 1; i >= 0; i--) {
    if (kids[i].getBoundingClientRect().width > 0) { last = kids[i]; break; }
  }
  if (!last) return false;
  var limitEl = line ? main : row;
  var padR = line ? 0 : parseFloat(getComputedStyle(row).paddingRight) || 0;
  var mr = parseFloat(getComputedStyle(last).marginRight) || 0;
  var limit = limitEl.getBoundingClientRect().right - padR + Math.max(0, -mr);
  return last.getBoundingClientRect().right > limit + 1;
}
function fitRow(row) {
  var line = row.querySelector(':scope > .row-main > .row-line');
  var scope = line || row;
  var tags = scope.querySelectorAll(':scope > .tag');
  if (!tags.length) return;
  var title = scope.querySelector(':scope > .row-title');
  for (var i = 0; i < tags.length; i++) tags[i].style.display = '';
  // 标题平时靠 flex 收缩吃掉小溢出，先钉回自然宽度才能测出真实溢出
  if (title) title.style.flex = 'none';
  var n = tags.length;
  while (n > 0 && rowOverflows(row)) tags[--n].style.display = 'none';
  if (title) title.style.flex = '';
}
var rowFitRO = new ResizeObserver(function (es) {
  for (var i = 0; i < es.length; i++) fitRow(es[i].target);
});
new MutationObserver(function (ms) {
  for (var i = 0; i < ms.length; i++) {
    var added = ms[i].addedNodes, removed = ms[i].removedNodes;
    for (var j = 0; j < removed.length; j++) {
      var rn = removed[j];
      if (rn.nodeType !== 1) continue;
      if (rn.matches('.row')) rowFitRO.unobserve(rn);
      var rr = rn.querySelectorAll('.row');
      for (var k = 0; k < rr.length; k++) rowFitRO.unobserve(rr[k]);
    }
    for (var j2 = 0; j2 < added.length; j2++) {
      var n2 = added[j2];
      if (n2.nodeType !== 1) continue;
      var rows = n2.matches('.row') ? [n2] : Array.from(n2.querySelectorAll('.row'));
      for (var k2 = 0; k2 < rows.length; k2++) { rowFitRO.observe(rows[k2]); fitRow(rows[k2]); }
    }
  }
}).observe(document.body, { childList: true, subtree: true });
// ---- 时长：.dur 元素带 data-ts（秒级时间戳）+ data-prefix，每秒本地重算，不打接口 ----
export function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec));
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
}
export function durSpan(ts, prefix) {
  return `<span class="dur" data-ts="${ts}" data-prefix="${esc(prefix)}">` +
    `${esc(prefix)}${fmtDur(Date.now() / 1000 - ts)}</span>`;
}
setInterval(function () {
  var now = Date.now() / 1000;
  var els = document.querySelectorAll('.dur');
  for (var i = 0; i < els.length; i++) {
    var ts = Number(els[i].getAttribute('data-ts'));
    if (ts > 0) els[i].textContent = els[i].getAttribute('data-prefix') + fmtDur(now - ts);
  }
}, 1000);
// 壳里的静态图标位（data-icon 属性）统一填充
(function () {
  var els = document.querySelectorAll('[data-icon]');
  for (var i = 0; i < els.length; i++) els[i].innerHTML = icon(els[i].getAttribute('data-icon'));
})();
