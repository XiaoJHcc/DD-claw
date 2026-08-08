/**
 * 面板前端公共段：esc / api / toast（顶部胶囊）/ sheet（两级统一弹窗）/ iOS 开关与图标按钮 /
 * 通用拖拽排序 makeSortable / 事件委托（data-action / data-change / data-input）/ 时长每秒重算。
 * 内嵌进页面 <script>，内容不得出现反引号与 ${（外层是模板字面量），一律字符串拼接。依赖 icons 段。
 */
export const APP_CORE = `
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function api(path, method, body) {
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
function toast(msg, isErr) {
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
var ACTIONS = {}; var CHANGES = {}; var INPUTS = {};
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
var sheetCleanups = { 1: null, 2: null };
function openSheet(title, bodyHtml, level) {
  var l = level || 1;
  var mask = document.getElementById('sheet-mask' + l);
  mask.querySelector('.sheet').innerHTML =
    '<div class="sheet-head"><div class="sheet-title">' + esc(title) + '</div>' +
    '<button class="icon-btn" data-action="close-sheet" data-level="' + l + '" title="关闭">' +
    icon('xmark') + '</button></div>' +
    '<div class="sheet-body">' + bodyHtml + '</div>';
  mask.classList.remove('hidden');
}
function closeSheet(level) {
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
function switchHtml(attrs, checked, disabled) {
  return '<label class="switch"><input type="checkbox" ' + attrs +
    (checked ? ' checked' : '') + (disabled ? ' disabled' : '') + '><span class="knob"></span></label>';
}
function iconBtn(action, iconName, title, danger) {
  return '<button class="icon-btn' + (danger ? ' danger' : '') + '" data-action="' + action +
    '" title="' + esc(title) + '" aria-label="' + esc(title) + '">' + icon(iconName) + '</button>';
}
// macOS 勾选框（16x16 圆角小方块，选中蓝底白勾）：并排多选场景用（详情三选项 / 渠道多选）
// text 非空时把文字包进同一个 label（点击文字也切换）
function checkboxHtml(attrs, checked, disabled, text) {
  return '<label class="checkbox"><input type="checkbox" ' + attrs +
    (checked ? ' checked' : '') + (disabled ? ' disabled' : '') + '><span class="box"></span>' +
    (text ? '<span class="check-text">' + esc(text) + '</span>' : '') + '</label>';
}
// 多选行：整行是 label，点击任意处切换（不能套 checkboxHtml，避免 label 嵌套）
function checkRowHtml(attrs, checked, innerHtml) {
  return '<label class="check-row"><span class="checkbox"><input type="checkbox" ' + attrs +
    (checked ? ' checked' : '') + '><span class="box"></span></span>' + innerHtml + '</label>';
}
// 勾选排序列表的启停勾：无方框，选中 = 蓝色勾，未选 = 浅灰空心圆环（占位对齐）
function checkDotHtml(attrs, checked, disabled) {
  return '<label class="checkdot"><input type="checkbox" ' + attrs +
    (checked ? ' checked' : '') + (disabled ? ' disabled' : '') + '><span class="cd"></span></label>';
}
function gripHtml() { return '<span class="grip" title="拖拽排序">' + icon('grip') + '</span>'; }
function field(label, inputHtml) {
  return '<div class="field"><label>' + esc(label) + '</label>' + inputHtml + '</div>';
}
// 渠道类型 → 人话标签（推送卡片与规则编辑共用）
function chanTypeName(c) {
  if (c.notifier === 'toast') return '系统通知';
  return c.targetType === 'group' ? 'QQ群' : 'QQ私聊';
}
function chanTag(c) {
  if (c.targetType === 'group') return 'QQ群 ' + (c.targetId || '');
  if (c.targetType === 'private') return 'QQ私聊 ' + (c.targetId || '');
  return '系统通知';
}
// ---- 通用拖拽排序：provider / 渠道 / 规则三套列表共用 ----
// 行需 .row[draggable][data-sid]；opts: { items: fn() 当前数组, getId: fn(item), onOrder: fn(ids) 落库 }
function makeSortable(container, opts) {
  var dragId = null;
  container.addEventListener('dragstart', function (e) {
    if (!(e.target instanceof Element)) return;
    var row = e.target.closest('.row[draggable]');
    if (!row) return;
    dragId = row.getAttribute('data-sid');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId || '');
    row.classList.add('dragging');
  });
  container.addEventListener('dragover', function (e) {
    if (dragId == null) return;
    if (!(e.target instanceof Element)) return;
    if (!e.target.closest('.row[draggable]')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });
  container.addEventListener('drop', function (e) {
    if (!(e.target instanceof Element)) return;
    var row = e.target.closest('.row[draggable]');
    if (!row || dragId == null) return;
    e.preventDefault();
    var items = opts.items();
    var from = -1, to = -1, tid = row.getAttribute('data-sid');
    for (var i = 0; i < items.length; i++) {
      var id = String(opts.getId(items[i]));
      if (id === dragId) from = i;
      if (id === tid) to = i;
    }
    dragId = null;
    if (from < 0 || to < 0 || from === to) return;
    var ids = items.map(function (x) { return opts.getId(x); });
    var moved = ids.splice(from, 1)[0];
    ids.splice(to, 0, moved);
    opts.onOrder(ids);
  });
  container.addEventListener('dragend', function () {
    dragId = null;
    var rows = container.querySelectorAll('.row.dragging');
    for (var i = 0; i < rows.length; i++) rows[i].classList.remove('dragging');
  });
}
// ---- 时长：.dur 元素带 data-ts（秒级时间戳）+ data-prefix，每秒本地重算，不打接口 ----
function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec));
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
}
function durSpan(ts, prefix) {
  return '<span class="dur" data-ts="' + ts + '" data-prefix="' + esc(prefix) + '">' +
    esc(prefix) + fmtDur(Date.now() / 1000 - ts) + '</span>';
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
`;
