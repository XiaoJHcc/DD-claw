// 面板前端 · 卡片2 LLM 供应商：总开关（卡片右上角）+ provider 列表（v2 内嵌双行
// .row-2：拖拽把手/启停勾/主行名称+多模态 tag/副行模型 ID·端点/测试/编辑/删除）+ 底部新增按钮。
// 顺序 = 调用优先级，拖拽排序落库热生效；新增与编辑统一走 sheet 表单（v2 .field 观感，
// 协议/结构化输出走自绘下拉 dropdownHtml）。视觉 = UI 重设计 v2 平移，行为与旧版 1:1。
import { api, toast, ACTIONS, CHANGES, esc, gripHtml, checkDotHtml, iconBtn, field, checkRowHtml, makeSortable, openSheet, closeSheet, dropdownHtml } from './core.js';

let llmCache = [];

function llmRowHtml(p) {
  return `<div class="row row-2" data-sid="${esc(p.name)}">` +
    gripHtml() +
    checkDotHtml('data-change="toggle-llm-provider"', p.enabled) +
    '<span class="row-main"><span class="row-line">' +
    `<span class="row-title">${esc(p.name)}</span>` +
    (p.vision ? '<span class="tag tag-purple">多模态</span>' : '') +
    '</span>' +
    `<span class="row-sub">${esc(p.model || p.baseURL || '')}</span></span>` +
    '<span class="row-end">' +
    iconBtn('test-llm', 'bolt', '测试') +
    iconBtn('edit-llm', 'pencil', '编辑') +
    iconBtn('del-llm', 'trash', '删除', true) +
    '</span></div>';
}

function loadLlm() {
  return api('/api/llm').then(function (j) {
    llmCache = j.providers || [];
    const en = document.getElementById('llm-enabled');
    if (en) en.checked = j.enabled;
    document.getElementById('llm-list').innerHTML = llmCache.map(llmRowHtml).join('');
  }).catch(function (e) { toast(e.message, true); });
}

CHANGES['toggle-llm'] = function (el) {
  const on = el.checked;
  api('/api/llm/enabled', 'PUT', { enabled: on })
    .then(function () { toast(on ? 'LLM 分析已启用' : 'LLM 分析已停用'); })
    .catch(function (e) { toast(e.message, true); loadLlm(); });
};

CHANGES['toggle-llm-provider'] = function (el) {
  const name = el.closest('.row').getAttribute('data-sid');
  const on = el.checked;
  api('/api/llm/providers/' + encodeURIComponent(name), 'PUT', { enabled: on })
    .then(function () { toast(on ? '已启用' : '已停用'); })
    .catch(function (e) { toast(e.message, true); loadLlm(); });
};

function llmByName(name) {
  for (let i = 0; i < llmCache.length; i++) if (llmCache[i].name === name) return llmCache[i];
  return null;
}

ACTIONS['test-llm'] = function (el) {
  const name = el.closest('.row').getAttribute('data-sid');
  api('/api/llm/providers/' + encodeURIComponent(name) + '/test', 'POST')
    .then(function (j) { toast('可用（' + j.ms + 'ms）'); })
    .catch(function (e) { toast('不可用: ' + e.message, true); });
};

ACTIONS['del-llm'] = function (el) {
  const name = el.closest('.row').getAttribute('data-sid');
  if (!confirm('删除供应商「' + name + '」？它的 key 设置会保留。')) return;
  api('/api/llm/providers/' + encodeURIComponent(name), 'DELETE')
    .then(function () { toast('已删除'); loadLlm(); })
    .catch(function (e) { toast(e.message, true); });
};

ACTIONS['add-llm'] = function () { openLlmSheet(null); };
ACTIONS['edit-llm'] = function (el) { openLlmSheet(el.closest('.row').getAttribute('data-sid')); };

// ---- 新增 / 编辑弹窗（同一个表单；name 是路径标识，编辑时不可改） ----
function openLlmSheet(name) {
  const p = name === null ? null : llmByName(name);
  if (name !== null && !p) { toast('供应商数据未加载', true); return; }
  openSheet(p ? '编辑供应商' : '新增供应商',
    field('名称', `<input id="lp-name" class="inp" placeholder="如 deepseek" value="` +
      (p ? esc(p.name) : '') + '"' + (p ? ' disabled' : '') + '>') +
    '<div class="two">' +
    field('Base URL', `<input id="lp-base" class="inp" placeholder="如 https://api.deepseek.com/v1" value="` +
      (p ? esc(p.baseURL) : '') + '">') +
    field('协议', dropdownHtml('lp-api', [
      { value: 'chat-completions', label: 'chat/completions（默认）' },
      { value: 'responses', label: 'responses（GPT 5.6 等）' },
    ], p ? (p.api || 'chat-completions') : 'chat-completions')) +
    '</div>' +
    field('API key', `<input id="lp-key" class="inp" placeholder="如 sk-xxx；本地无鉴权可留空" value="` +
      (p && p.key.value ? esc(p.key.value) : '') + '">') +
    '<div class="two">' +
    field('模型 ID', `<input id="lp-model" class="inp" placeholder="如 deepseek-chat" value="` +
      (p ? esc(p.model) : '') + '">') +
    // 多模态勾：v2 表单布尔 = 多选行形态（左文字右勾点，.field 内 check-row 恒 ctl-h 高）
    '<div class="field"><label class="field-label">多模态</label>' +
    checkRowHtml('id="lp-vision"', !!(p && p.vision), '识图（带图分类）') +
    '</div>' +
    '</div>' +
    field('结构化输出', dropdownHtml('lp-so', [
      { value: 'schema', label: 'schema（默认）' },
      { value: 'object', label: 'object' },
      { value: 'none', label: 'none（本地小模型）' },
    ], p ? (p.structuredOutput || 'schema') : 'schema')) +
    '<div class="sheet-foot"><button class="btn btn-line" data-action="close-sheet" data-level="1">取消</button>' +
    '<button class="btn btn-primary" data-action="save-llm">保存</button></div>');
}

ACTIONS['save-llm'] = function () {
  const nameEl = document.getElementById('lp-name');
  const isNew = !nameEl.disabled;
  const body = {
    baseURL: document.getElementById('lp-base').value.trim(),
    model: document.getElementById('lp-model').value.trim(),
    vision: document.getElementById('lp-vision').checked,
    structuredOutput: document.getElementById('lp-so').value,
    api: document.getElementById('lp-api').value,
    key: document.getElementById('lp-key').value.trim(),
  };
  const req = isNew
    ? api('/api/llm/providers', 'POST', Object.assign({ name: nameEl.value.trim() }, body))
    : api('/api/llm/providers/' + encodeURIComponent(nameEl.value), 'PUT', body);
  req.then(function () {
    closeSheet(1);
    toast(isNew ? '已新增' : '已保存');
    loadLlm();
  }).catch(function (e) { toast(e.message, true); });
};

// ---- LLM 高级（LLM 卡底部按钮）：超时 / 熔断阈值 / 熔断冷却 3 项 ----
function llmAdvNum(id) {
  const v = parseInt(document.getElementById(id).value, 10);
  return isNaN(v) ? null : v;
}

ACTIONS['open-llm-advanced'] = function () {
  api('/api/advanced').then(function (j) {
    openSheet('LLM 高级',
      field('请求超时（秒，1~600）', `<input id="la-timeout" class="inp" value="${Math.round(j.llmRequestTimeoutMs / 1000)}">`) +
      '<div class="two">' +
      field('熔断阈值（连续失败次数，1~20）', `<input id="la-threshold" class="inp" value="${j.llmCircuitThreshold}">`) +
      field('熔断冷却（秒，10~3600）', `<input id="la-cooldown" class="inp" value="${Math.round(j.llmCircuitCooldownMs / 1000)}">`) +
      '</div>' +
      '<div class="sheet-foot"><span id="la-err" class="form-err"></span>' +
      '<button class="btn btn-line" data-action="close-sheet" data-level="1">取消</button>' +
      '<button class="btn btn-primary" data-action="save-llm-advanced">保存</button></div>');
  }).catch(function (e) { toast(e.message, true); });
};

ACTIONS['save-llm-advanced'] = function () {
  const errEl = document.getElementById('la-err');
  const ids = ['la-timeout', 'la-threshold', 'la-cooldown'];
  const vals = {};
  for (let i = 0; i < ids.length; i++) {
    const v = llmAdvNum(ids[i]);
    if (v === null) { errEl.textContent = '数值项请输入整数'; return; }
    vals[ids[i]] = v;
  }
  api('/api/advanced', 'PUT', {
    llmRequestTimeoutMs: vals['la-timeout'] * 1000,
    llmCircuitThreshold: vals['la-threshold'],
    llmCircuitCooldownMs: vals['la-cooldown'] * 1000,
  }).then(function () {
    closeSheet(1);
    toast('已保存并生效');
  }).catch(function (e) { errEl.textContent = e.message; });
};

// 拖拽排序：顺序 = 调用优先级，落库后热生效
makeSortable(document.getElementById('llm-list'), {
  items: function () { return llmCache; },
  getId: function (p) { return p.name; },
  onOrder: function (names) {
    api('/api/llm/providers/order', 'PUT', { names: names })
      .then(loadLlm)
      .catch(function (err) { toast(err.message, true); loadLlm(); });
  },
});

loadLlm();
