/**
 * 面板前端 · 卡片2 LLM 分析：总开关（卡片右上角）+ provider 列表
 * （勾选框/名称/多模态/测试/编辑/删除/拖拽把手）+ 最后一行新增按钮。
 * 顺序 = 调用优先级，用拖拽排序，落库后热生效。
 * 内嵌进页面 <script>，内容不得出现反引号与 ${，一律字符串拼接。依赖 app-core 段。
 */
export const APP_LLM = `
function jsq(s) { return String(s).replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'"); }

var llmCache = [];
var llmDragName = null;

function llmRow(p, i) {
  return '<div class="llm-row" draggable="true" data-name="' + esc(p.name) + '"' +
    ' ondragstart="llmDragStart(event)" ondragover="llmDragOver(event)"' +
    ' ondrop="llmDrop(event, ' + i + ')" ondragend="llmDragEnd()">' +
    '<span class="llm-grip">☰</span>' +
    '<label><input type="checkbox" onchange="toggleLlmProvider(\\'' + jsq(p.name) + '\\', this.checked)"' +
    (p.enabled ? ' checked' : '') + '></label>' +
    '<span class="llm-name">' + esc(p.name) + '</span>' +
    (p.vision ? '<span class="tag">多模态</span>' : '') +
    '<span class="grow"></span>' +
    '<button onclick="testLlmProvider(\\'' + jsq(p.name) + '\\')">测试</button>' +
    '<button onclick="openLlmModal(' + i + ')">编辑</button>' +
    '<button onclick="delLlmProvider(\\'' + jsq(p.name) + '\\')">删除</button>' +
    '</div>';
}
function loadLlm() {
  return api('/api/llm').then(function (j) {
    llmCache = j.providers || [];
    var en = document.getElementById('llm-enabled');
    if (en) en.checked = j.enabled;
    document.getElementById('llm-list').innerHTML =
      llmCache.map(llmRow).join('') +
      '<div class="llm-add-row"><button onclick="openLlmModal(null)">新增 provider</button></div>';
  }).catch(function (e) { toast(e.message, true); });
}
function toggleLlm(on) {
  api('/api/llm/enabled', 'PUT', { enabled: on })
    .then(function () { toast(on ? 'LLM 分析已启用' : 'LLM 分析已停用'); })
    .catch(function (e) { toast(e.message, true); loadLlm(); });
}

// ---- 新增 / 编辑弹窗（同一个表单：i=null 新增，否则编辑 llmCache[i]） ----
function openLlmModal(i) {
  var p = i === null ? null : llmCache[i];
  openModal(
    '<h3>' + (p ? '编辑 provider' : '新增 provider') + '</h3>' +
    '<div class="mrow"><input id="lp-name" class="wfull" placeholder="名称，如 deepseek" value="' +
    (p ? esc(p.name) : '') + '"' + (p ? ' disabled' : '') + '></div>' +
    '<div class="mrow"><input id="lp-base" class="wfull" placeholder="baseURL，如 https://api.deepseek.com/v1" value="' +
    (p ? esc(p.baseURL) : '') + '"></div>' +
    '<div class="mrow"><input id="lp-model" class="wfull" placeholder="模型，如 deepseek-chat" value="' +
    (p ? esc(p.model) : '') + '"></div>' +
    '<div class="mrow"><input id="lp-key" class="wfull" placeholder="API key（多个用英文逗号分隔；本地无鉴权端点留空）" value="' +
    (p && p.key.value ? esc(p.key.value) : '') + '"></div>' +
    '<div class="mrow"><label><input type="checkbox" id="lp-vision"' +
    (p && p.vision ? ' checked' : '') + '> 多模态（可接含图任务，进 vision 路由）</label> ' +
    '<select id="lp-so"><option value="schema">结构化输出: schema（默认）</option>' +
    '<option value="object">object</option>' +
    '<option value="none">none（本地小模型）</option></select> ' +
    '<select id="lp-api"><option value="chat-completions">协议: chat/completions（默认）</option>' +
    '<option value="responses">responses（GPT 5.6 等）</option></select></div>' +
    '<div class="mrow"><button onclick="saveLlmModal(' + (i === null ? 'null' : i) + ')">保存</button>' +
    '<button onclick="closeModal()">取消</button></div>'
  );
  if (p) document.getElementById('lp-so').value = p.structuredOutput || 'schema';
  if (p) document.getElementById('lp-api').value = p.api || 'chat-completions';
}
function saveLlmModal(i) {
  var body = {
    baseURL: document.getElementById('lp-base').value.trim(),
    model: document.getElementById('lp-model').value.trim(),
    vision: document.getElementById('lp-vision').checked,
    structuredOutput: document.getElementById('lp-so').value,
    api: document.getElementById('lp-api').value,
    key: document.getElementById('lp-key').value.trim(),
  };
  var req = i === null
    ? api('/api/llm/providers', 'POST', Object.assign(
        { name: document.getElementById('lp-name').value.trim() }, body))
    : api('/api/llm/providers/' + encodeURIComponent(llmCache[i].name), 'PUT', body);
  req.then(function () {
    closeModal();
    toast(i === null ? '已新增' : '已保存');
    loadLlm();
  }).catch(function (e) { toast(e.message, true); });
}

// ---- 行内操作 ----
function toggleLlmProvider(name, enabled) {
  api('/api/llm/providers/' + encodeURIComponent(name), 'PUT', { enabled: enabled })
    .then(function () { toast(enabled ? '已启用' : '已停用'); })
    .catch(function (e) { toast(e.message, true); loadLlm(); });
}
function delLlmProvider(name) {
  if (!confirm('删除 provider「' + name + '」？它的 key 设置会保留。')) return;
  api('/api/llm/providers/' + encodeURIComponent(name), 'DELETE')
    .then(function () { toast('已删除'); loadLlm(); })
    .catch(function (e) { toast(e.message, true); });
}
function testLlmProvider(name) {
  api('/api/llm/providers/' + encodeURIComponent(name) + '/test', 'POST')
    .then(function (j) { toast('可用（' + j.ms + 'ms）'); })
    .catch(function (e) { toast('不可用: ' + e.message, true); });
}

// ---- 拖拽排序 ----
function llmDragStart(e) {
  llmDragName = e.currentTarget.getAttribute('data-name');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', llmDragName);
  e.currentTarget.classList.add('dragging');
}
function llmDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}
function llmDrop(e, i) {
  e.preventDefault();
  if (llmDragName == null) return;
  var from = -1;
  for (var k = 0; k < llmCache.length; k++) if (llmCache[k].name === llmDragName) { from = k; break; }
  if (from < 0 || from === i) return;
  var names = llmCache.map(function (p) { return p.name; });
  var moved = names.splice(from, 1)[0];
  names.splice(i, 0, moved);
  api('/api/llm/providers/order', 'PUT', { names: names })
    .then(loadLlm)
    .catch(function (err) { toast(err.message, true); loadLlm(); });
}
function llmDragEnd() {
  llmDragName = null;
  var rows = document.querySelectorAll('.llm-row.dragging');
  for (var i = 0; i < rows.length; i++) rows[i].classList.remove('dragging');
}

loadLlm();
`;
