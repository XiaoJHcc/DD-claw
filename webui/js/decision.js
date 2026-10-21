// 面板前端 · 决策模型供应商卡：System One 通道的管理面（与 LLM 供应商卡完全隔离）。
// 行 = 拖拽把手 / 启停勾 / 名称 + 模型或端点 / 测试 / 编辑 / 删除；顺序 = 后续判定通道的优先级。
// 新增与编辑统一走 sheet 表单；协议下拉当前只有 systemone（Jev 的 /v1/systemone 线格式），
// 保留下拉是为了后续加 /v1/decisions 时不改表单结构。
import { api, toast, ACTIONS, CHANGES, esc, gripHtml, checkDotHtml, iconBtn, field, dropdownHtml, makeSortable, openSheet, closeSheet, onTableRefresh } from './core.js';

let decisionCache = [];

function decisionRowHtml(p) {
  return `<div class="row row-2" data-sid="${esc(p.name)}">` +
    gripHtml() +
    checkDotHtml('data-change="toggle-decision-provider"', p.enabled) +
    '<span class="row-main"><span class="row-line">' +
    `<span class="row-title">${esc(p.name)}</span>` +
    '</span>' +
    `<span class="row-sub">${esc(p.model || p.baseURL || '')}</span></span>` +
    '<span class="row-end">' +
    iconBtn('test-decision', 'bolt', '测试') +
    iconBtn('edit-decision', 'pencil', '编辑') +
    iconBtn('del-decision', 'trash', '删除', true) +
    '</span></div>';
}

function loadDecision() {
  return api('/api/decision').then(function (j) {
    decisionCache = j.providers || [];
    document.getElementById('decision-list').innerHTML = decisionCache.map(decisionRowHtml).join('');
  }).catch(function (e) { toast(e.message, true); });
}

CHANGES['toggle-decision-provider'] = function (el) {
  const name = el.closest('.row').getAttribute('data-sid');
  const on = el.checked;
  api('/api/decision/providers/' + encodeURIComponent(name), 'PUT', { enabled: on })
    .then(function () { toast(on ? '已启用' : '已停用'); })
    .catch(function (e) { toast(e.message, true); loadDecision(); });
};

function decisionByName(name) {
  for (let i = 0; i < decisionCache.length; i++) if (decisionCache[i].name === name) return decisionCache[i];
  return null;
}

ACTIONS['test-decision'] = function (el) {
  const name = el.closest('.row').getAttribute('data-sid');
  api('/api/decision/providers/' + encodeURIComponent(name) + '/test', 'POST')
    .then(function (j) { toast('可用（' + j.ms + 'ms，' + j.model + '）'); })
    .catch(function (e) { toast('不可用: ' + e.message, true); });
};

ACTIONS['del-decision'] = function (el) {
  const name = el.closest('.row').getAttribute('data-sid');
  if (!confirm('删除供应商「' + name + '」？它的 key 设置会保留。')) return;
  api('/api/decision/providers/' + encodeURIComponent(name), 'DELETE')
    .then(function () { toast('已删除'); loadDecision(); })
    .catch(function (e) { toast(e.message, true); });
};

ACTIONS['add-decision'] = function () { openDecisionSheet(null); };
ACTIONS['edit-decision'] = function (el) { openDecisionSheet(el.closest('.row').getAttribute('data-sid')); };

// ---- 新增 / 编辑弹窗（同一个表单；name 是路径标识，编辑时不可改） ----
function openDecisionSheet(name) {
  const p = name === null ? null : decisionByName(name);
  if (name !== null && !p) { toast('供应商数据未加载', true); return; }
  openSheet(p ? '编辑供应商' : '新增供应商',
    field('名称', `<input id="dp-name" class="inp" placeholder="如 jev" value="` +
      (p ? esc(p.name) : '') + '"' + (p ? ' disabled' : '') + '>') +
    '<div class="two">' +
    field('Base URL', `<input id="dp-base" class="inp" placeholder="如 https://api.typesafe.ai/v1" value="` +
      (p ? esc(p.baseURL) : '') + '">') +
    field('协议', dropdownHtml('dp-protocol', [
      { value: 'systemone', label: 'systemone' },
    ], p ? (p.protocol || 'systemone') : 'systemone')) +
    '</div>' +
    field('API key', `<input id="dp-key" class="inp" placeholder="如 sk-xxx；本地无鉴权可留空" value="` +
      (p && p.key.value ? esc(p.key.value) : '') + '">') +
    field('模型 ID', `<input id="dp-model" class="inp" placeholder="如 jev-1.14.0" value="` +
      (p ? esc(p.model) : '') + '">') +
    '<div class="sheet-foot"><button class="btn btn-line" data-action="close-sheet" data-level="1">取消</button>' +
    '<button class="btn btn-primary" data-action="save-decision">保存</button></div>');
}

ACTIONS['save-decision'] = function () {
  const nameEl = document.getElementById('dp-name');
  const isNew = !nameEl.disabled;
  const body = {
    baseURL: document.getElementById('dp-base').value.trim(),
    model: document.getElementById('dp-model').value.trim(),
    protocol: document.getElementById('dp-protocol').value,
    key: document.getElementById('dp-key').value.trim(),
  };
  const req = isNew
    ? api('/api/decision/providers', 'POST', Object.assign({ name: nameEl.value.trim() }, body))
    : api('/api/decision/providers/' + encodeURIComponent(nameEl.value), 'PUT', body);
  req.then(function () {
    closeSheet(1);
    toast(isNew ? '已新增' : '已保存');
    loadDecision();
  }).catch(function (e) { toast(e.message, true); });
};

// 拖拽排序：顺序 = 后续判定通道的调用优先级
makeSortable(document.getElementById('decision-list'), {
  items: function () { return decisionCache; },
  getId: function (p) { return p.name; },
  onOrder: function (names) {
    api('/api/decision/providers/order', 'PUT', { names: names })
      .then(loadDecision)
      .catch(function (err) { toast(err.message, true); loadDecision(); });
  },
});

loadDecision();
// 名单与 key 都在 settings 表（decision_providers / decision_key:<name>）——撤销后重拉本卡
onTableRefresh(['settings'], loadDecision);
