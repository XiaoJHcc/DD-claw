/**
 * 面板前端 · 卡片4 推送：全局默认推送词 + 渠道管理（系统通知 / QQ群 / QQ私聊）。
 * 内嵌进页面 <script>，内容不得出现反引号与 ${，一律字符串拼接。依赖 app-core 段。
 */
export const APP_PUSH = `
// ---- 默认推送词模板（settings.default_template；留空 = 内置默认） ----
function loadPushTemplate() {
  return api('/api/push/template').then(function (j) {
    document.getElementById('push-template').innerHTML =
      '<div class="mrow"><input id="tpl-input" class="wfull" value="' + esc(j.template || '') +
      '" placeholder="留空 = 内置默认：🔴 {alias} 开播了">' +
      '<button onclick="saveTemplate()">保存</button></div>' +
      '<p class="hint">变量：{alias} 别名（没填用主播名） {uname} 主播名 {title} 直播标题；每个主播的规则可单独覆盖</p>';
  }).catch(function (e) { toast(e.message, true); });
}
function saveTemplate() {
  api('/api/push/template', 'PUT', { template: document.getElementById('tpl-input').value.trim() })
    .then(function () { toast('已保存'); loadPushTemplate(); })
    .catch(function (e) { toast(e.message, true); });
}

// ---- 渠道列表 ----
function channelRow(c) {
  return '<div class="chan"><span class="grow"><b>' + esc(c.name) + '</b> ' +
    '<span class="tag">' + chanTypeName(c) + '</span>' +
    (c.targetId ? ' <span class="meta">' + esc(c.targetId) + '</span>' : '') +
    '</span>' +
    '<label><input type="checkbox" onchange="toggleChannel(' + c.id + ', this.checked)"' +
    (c.enabled ? ' checked' : '') + '> 启用</label>' +
    '<button onclick="delChannel(' + c.id + ')">删除</button></div>';
}
function loadChannels() {
  return api('/api/channels').then(function (j) {
    var list = j.channels || [];
    document.getElementById('channel-list').innerHTML =
      list.map(channelRow).join('') || '<p class="hint">还没有渠道，先在下方新增一个。</p>';
  }).catch(function (e) { toast(e.message, true); });
}
function toggleChannel(id, enabled) {
  api('/api/channels/' + id, 'PUT', { enabled: enabled })
    .then(function () { toast(enabled ? '已启用' : '已停用'); })
    .catch(function (e) { toast(e.message, true); loadChannels(); });
}
function delChannel(id) {
  if (!confirm('删除这个渠道？勾选了它的规则会少一个推送去处。')) return;
  api('/api/channels/' + id, 'DELETE')
    .then(function () { toast('已删除'); loadChannels(); })
    .catch(function (e) { toast(e.message, true); });
}

// ---- 新增渠道表单：类型下拉 + 名称 + 目标号（系统通知无目标号） ----
function renderChannelAdd() {
  document.getElementById('channel-add').innerHTML =
    '<div class="chan add"><select id="ca-type" onchange="caTypeChange()">' +
    '<option value="toast">系统通知</option>' +
    '<option value="group">QQ群</option>' +
    '<option value="private">QQ私聊</option></select>' +
    '<input id="ca-name" placeholder="名称，如：粉丝群">' +
    '<input id="ca-target" class="hidden" placeholder="群号 / QQ号">' +
    '<button onclick="addChannel()">新增渠道</button></div>';
}
function caTypeChange() {
  document.getElementById('ca-target').classList.toggle(
    'hidden', document.getElementById('ca-type').value === 'toast');
}
function addChannel() {
  var type = document.getElementById('ca-type').value;
  var body = {
    name: document.getElementById('ca-name').value.trim(),
    notifier: type === 'toast' ? 'toast' : 'onebot',
  };
  if (type !== 'toast') {
    body.targetType = type;
    body.targetId = document.getElementById('ca-target').value.trim();
  }
  api('/api/channels', 'POST', body).then(function () {
    toast('已新增'); loadChannels(); renderChannelAdd();
  }).catch(function (e) { toast(e.message, true); });
}

loadPushTemplate();
loadChannels();
renderChannelAdd();
`;
