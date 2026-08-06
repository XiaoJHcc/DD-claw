/**
 * 面板前端 · 卡片5 LLM：总开关 + provider 列表（增/删/改/启停/测试）。
 * 新增与编辑都在弹窗里做（复用 app-core 的 openModal/closeModal）；
 * key 是本机面板，明文展示与编辑（用户决策 2026-08-06，不做掩码）。
 * 内嵌进页面 <script>，内容不得出现反引号与 ${，一律字符串拼接。依赖 app-core 段。
 */
export const APP_LLM = `
// ---- 工具：name 嵌进 onclick 的 JS 字符串字面量要转义 ----
function jsq(s) { return String(s).replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'"); }

var llmCache = [];

// ---- provider 列表（每行一条；URL 与 key 在「编辑」弹窗里看和改） ----
function llmRow(p, i) {
  return '<div class="chan"><span class="grow"><b>' + esc(p.name) + '</b> ' +
    '<span class="meta">' + esc(p.model) + '</span> ' +
    (p.vision ? '<span class="tag">多模态</span> ' : '') +
    '<span class="tag">路由: ' + (p.routes.join(', ') || '无') + '</span> ' +
    (p.status ? '<span class="tag">' + esc(p.status) + '</span>' : '') +
    '<span class="meta" id="lt-' + i + '"></span>' +
    '</span>' +
    '<label><input type="checkbox" onchange="toggleLlmProvider(\\'' + jsq(p.name) + '\\', this.checked)"' +
    (p.enabled ? ' checked' : '') + '> 启用</label>' +
    '<button onclick="moveLlmProvider(' + i + ', -1)"' + (i === 0 ? ' disabled' : '') + '>上移</button>' +
    '<button onclick="moveLlmProvider(' + i + ', 1)"' +
    (i === llmCache.length - 1 ? ' disabled' : '') + '>下移</button>' +
    '<button onclick="testLlmProvider(\\'' + jsq(p.name) + '\\', ' + i + ')">测试</button>' +
    '<button onclick="openLlmModal(' + i + ')">编辑</button>' +
    '<button onclick="delLlmProvider(\\'' + jsq(p.name) + '\\')">删除</button></div>';
}
function loadLlm() {
  return api('/api/llm').then(function (j) {
    llmCache = j.providers || [];
    var rows = llmCache.map(function (p, i) { return llmRow(p, i); }).join('');
    document.getElementById('llm-list').innerHTML =
      '<div class="mrow"><label><input type="checkbox" onchange="toggleLlm(this.checked)"' +
      (j.enabled ? ' checked' : '') + '> <b>启用 LLM 分析</b></label> ' +
      '<button onclick="openLlmModal(null)">新增 provider</button></div>' +
      (rows || '<p class="hint">还没有 provider，点「新增 provider」添加。</p>') +
      (rows ? '<p class="hint">顺序 = 调用优先级（用上移/下移调整），失败/熔断自动降级到后面的；改动即刻生效，无需重启。</p>' : '');
  }).catch(function (e) { toast(e.message, true); });
}
function moveLlmProvider(i, dir) {
  var j = i + dir;
  if (j < 0 || j >= llmCache.length) return;
  var names = llmCache.map(function (p) { return p.name; });
  var t = names[i]; names[i] = names[j]; names[j] = t;
  api('/api/llm/providers/order', 'PUT', { names: names })
    .then(function () { loadLlm(); })
    .catch(function (e) { toast(e.message, true); loadLlm(); });
}
function toggleLlm(on) {
  api('/api/llm/enabled', 'PUT', { enabled: on })
    .then(function () { toast(on ? 'LLM 分析已启用' : 'LLM 分析已停用'); loadLlm(); })
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
    '<option value="none">none（本地小模型）</option></select></div>' +
    '<div class="mrow"><button onclick="saveLlmModal(' + (i === null ? 'null' : i) + ')">保存</button>' +
    '<button onclick="closeModal()">取消</button></div>'
  );
  if (p) document.getElementById('lp-so').value = p.structuredOutput || 'schema';
}
function saveLlmModal(i) {
  var body = {
    baseURL: document.getElementById('lp-base').value.trim(),
    model: document.getElementById('lp-model').value.trim(),
    vision: document.getElementById('lp-vision').checked,
    structuredOutput: document.getElementById('lp-so').value,
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
    .then(function () { toast(enabled ? '已启用' : '已停用'); loadLlm(); })
    .catch(function (e) { toast(e.message, true); loadLlm(); });
}
function delLlmProvider(name) {
  if (!confirm('删除 provider「' + name + '」？它的 key 设置会保留。')) return;
  api('/api/llm/providers/' + encodeURIComponent(name), 'DELETE')
    .then(function () { toast('已删除'); loadLlm(); })
    .catch(function (e) { toast(e.message, true); });
}
function testLlmProvider(name, i) {
  var out = document.getElementById('lt-' + i);
  out.textContent = '测试中…';
  api('/api/llm/providers/' + encodeURIComponent(name) + '/test', 'POST')
    .then(function (j) { out.textContent = '可用（' + j.ms + 'ms）'; })
    .catch(function (e) { out.textContent = '不可用: ' + e.message; });
}

loadLlm();
`;
