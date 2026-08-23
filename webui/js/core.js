// 面板前端公共模块：esc / api / toast（顶部胶囊）/ sheet（两级统一弹窗）/ iOS 开关与图标按钮 /
// 通用拖拽排序 makeSortable / 事件委托（data-action / data-change / data-input）/ 时长每秒重算。
// 本模块是被各卡模块显式 import 的唯一公共依赖，导出全部共享符号。
import { icon } from './icons.js';

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
export function api(path, method, body) {
  return fetch(path, {
    method: method || 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(function (r) {
    return r.json().then(function (j) {
      if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
      return j;
    });
  });
}
// ---- toast：顶部居中浮动胶囊，成功绿/错误红，约 3s 自动消失，多条纵向堆叠 ----
export function toast(msg, isErr) {
  var host = document.getElementById('toasts');
  if (!host) return;
  var el = document.createElement('div');
  el.className = 'toast-capsule ' + (isErr ? 'err' : 'ok');
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
// sheetCleanups 由打开方注册清理逻辑（停轮询、清状态等），关窗时执行
export var sheetCleanups = { 1: null, 2: null };
export function openSheet(title, bodyHtml, level) {
  var l = level || 1;
  var mask = document.getElementById('sheet-mask' + l);
  mask.querySelector('.sheet').innerHTML =
    `<div class="sheet-head"><div class="sheet-title">${esc(title)}</div>` +
    `<button class="icon-btn" data-action="close-sheet" data-level="${l}" title="关闭">` +
    `${icon('xmark')}</button></div>` +
    `<div class="sheet-body">${bodyHtml}</div>`;
  mask.classList.remove('hidden');
}
export function closeSheet(level) {
  var l = level || 1;
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
export function switchHtml(attrs, checked, disabled) {
  return `<label class="switch"><input type="checkbox" ${attrs}` +
    `${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}><span class="knob"></span></label>`;
}
export function iconBtn(action, iconName, title, danger) {
  return `<button class="icon-btn${danger ? ' danger' : ''}" data-action="${action}"` +
    ` title="${esc(title)}" aria-label="${esc(title)}">${icon(iconName)}</button>`;
}
// macOS 勾选框（16x16 圆角小方块，选中蓝底白勾）：并排多选场景用（详情三选项 / 渠道多选）
// text 非空时把文字包进同一个 label（点击文字也切换）
export function checkboxHtml(attrs, checked, disabled, text) {
  return `<label class="checkbox"><input type="checkbox" ${attrs}` +
    `${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}><span class="box"></span>` +
    `${text ? `<span class="check-text">${esc(text)}</span>` : ''}</label>`;
}
// 多选行：整行是 label，点击任意处切换（不能套 checkboxHtml，避免 label 嵌套）
export function checkRowHtml(attrs, checked, innerHtml) {
  return `<label class="check-row"><span class="checkbox"><input type="checkbox" ${attrs}` +
    `${checked ? ' checked' : ''}><span class="box"></span></span>${innerHtml}</label>`;
}
// 勾选排序列表的启停勾：无方框，选中 = 蓝色勾，未选 = 浅灰空心圆环（占位对齐）
export function checkDotHtml(attrs, checked, disabled) {
  return `<label class="checkdot"><input type="checkbox" ${attrs}` +
    `${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}><span class="cd"></span></label>`;
}
export function gripHtml() { return `<span class="grip" title="拖拽排序">${icon('grip')}</span>`; }
export function field(label, inputHtml) {
  return `<div class="field"><label class="field-label">${esc(label)}</label>${inputHtml}</div>`;
}
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
// 拖动时被拖行悬浮跟随鼠标，其余行实时让位——在鼠标位置空出一个虚线槽位（.sort-ph），
// 排序随移动实时更新，松手即落入槽位并调 opts.onOrder(ids) 落库。
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
    var cs = getComputedStyle(p.row);
    var ph = document.createElement('div');
    ph.className = 'sort-ph';                     // 空位槽：占住被拖行的原空间
    ph.style.height = rect.height + 'px';
    ph.style.marginTop = cs.marginTop;
    ph.style.marginBottom = cs.marginBottom;
    drag = { row: p.row, ph: ph, offX: p.offX, offY: p.offY, px: 0, py: 0 };
    container.insertBefore(ph, p.row);            // 让位：原行位置换成空槽
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
    var ph = d.ph;
    if (i < kids.length && kids[i] === ph) return; // 已在目标槽位，无需移动
    if (i >= kids.length) container.appendChild(ph);
    else container.insertBefore(ph, kids[i]);      // 实时更新排序槽位
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
    if (d.ph.parentNode === container) container.removeChild(d.ph);
  }

  function end(d) {
    drag = null;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    document.body.classList.remove('sort-dragging');
    d.row.classList.remove('dragging');
    var st = d.row.style;
    st.position = ''; st.left = ''; st.top = ''; st.width = ''; st.margin = '';
    if (!d.row.isConnected) return;               // 拖拽中被重渲，放弃本次
    var kids = container.children;
    var at = Array.prototype.indexOf.call(kids, d.ph);
    if (at >= 0) container.removeChild(d.ph);
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
    for (var j = 0; j < items.length && same; j++) {
      if (String(ids[j]) !== String(opts.getId(items[j]))) same = false;
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
