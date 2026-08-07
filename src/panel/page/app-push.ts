/**
 * 面板前端 · 卡片3 推送：总开关（卡片右上角）+ 渠道列表
 * （勾选框/名称/类型标签〔群号写在标签内〕/编辑/删除/拖拽把手）。
 * 新增/编辑走弹窗；全局默认推送在弹窗里，主卡片底部留按钮入口。
 * 内嵌进页面 <script>，内容不得出现反引号与 ${，一律字符串拼接。依赖 app-core 段。
 */
export const APP_PUSH = `
var chCache = [];
var chDragId = null;

function chanTag(c) {
  if (c.targetType === 'group') return 'QQ群 ' + (c.targetId || '');
  if (c.targetType === 'private') return 'QQ私聊 ' + (c.targetId || '');
  return '系统通知';
}

function channelRow(c, i) {
  return '<div class="llm-row" draggable="true" data-id="' + c.id + '"' +
    ' ondragstart="chDragStart(event)" ondragover="chDragOver(event)"' +
    ' ondrop="chDrop(event, ' + i + ')" ondragend="chDragEnd()">' +
    '<span class="llm-grip">☰</span>' +
    '<label><input type="checkbox" onchange="toggleChannel(' + c.id + ', this.checked)"' +
    (c.enabled ? ' checked' : '') + '></label>' +
    '<span class="llm-name">' + esc(c.name) + '</span>' +
    '<span class="tag">' + esc(chanTag(c)) + '</span>' +
    '<span class="grow"></span>' +
    '<button onclick="openChannelModal(' + i + ')">编辑</button>' +
    '<button onclick="delChannel(' + c.id + ')">删除</button>' +
    '</div>';
}

function loadPush() {
  return Promise.all([api('/api/push'), api('/api/channels')]).then(function (rs) {
    var en = document.getElementById('push-enabled');
    if (en) en.checked = rs[0].enabled;
    chCache = rs[1].channels || [];
    document.getElementById('channel-list').innerHTML = chCache.map(channelRow).join('');
  }).catch(function (e) { toast(e.message, true); });
}
function togglePush(on) {
  api('/api/push/enabled', 'PUT', { enabled: on })
    .then(function () { toast(on ? '推送已启用' : '推送已停用'); })
    .catch(function (e) { toast(e.message, true); loadPush(); });
}

// ---- 渠道 新增/编辑 弹窗（i=null 新增，否则编辑 chCache[i]） ----
function openChannelModal(i) {
  var c = i === null ? null : chCache[i];
  var selType = c ? (c.notifier === 'toast' ? 'toast' : c.targetType) : 'toast';
  openModal(
    '<h3>' + (c ? '编辑渠道' : '新增渠道') + '</h3>' +
    '<div class="mrow"><input id="cn-name" class="wfull" placeholder="名称，如：粉丝群" value="' +
    (c ? esc(c.name) : '') + '"></div>' +
    '<div class="mrow"><select id="cn-type" onchange="cnTypeChange()">' +
    '<option value="toast">系统通知</option>' +
    '<option value="group">QQ群</option>' +
    '<option value="private">QQ私聊</option></select>' +
    '<input id="cn-target" class="wfull" placeholder="群号 / QQ号" value="' +
    (c && c.targetId ? esc(c.targetId) : '') + '"></div>' +
    '<div class="mrow"><button onclick="saveChannel(' + (i === null ? 'null' : i) + ')">保存</button>' +
    '<button onclick="closeModal()">取消</button></div>'
  );
  document.getElementById('cn-type').value = selType;
  cnTypeChange();
}
function cnTypeChange() {
  document.getElementById('cn-target').disabled =
    document.getElementById('cn-type').value === 'toast';
}
function saveChannel(i) {
  var type = document.getElementById('cn-type').value;
  var body = {
    name: document.getElementById('cn-name').value.trim(),
    notifier: type === 'toast' ? 'toast' : 'onebot',
  };
  if (type === 'toast') {
    body.targetType = null;
    body.targetId = null;
  } else {
    body.targetType = type;
    body.targetId = document.getElementById('cn-target').value.trim();
  }
  var req = i === null
    ? api('/api/channels', 'POST', body)
    : api('/api/channels/' + chCache[i].id, 'PUT', body);
  req.then(function () {
    closeModal();
    toast(i === null ? '已新增' : '已保存');
    loadPush();
  }).catch(function (e) { toast(e.message, true); });
}

// ---- 行内操作 ----
function toggleChannel(id, enabled) {
  api('/api/channels/' + id, 'PUT', { enabled: enabled })
    .then(function () { toast(enabled ? '已启用' : '已停用'); })
    .catch(function (e) { toast(e.message, true); loadPush(); });
}
function delChannel(id) {
  if (!confirm('删除这个渠道？勾选了它的规则会少一个推送去处。')) return;
  api('/api/channels/' + id, 'DELETE')
    .then(function () { toast('已删除'); loadPush(); })
    .catch(function (e) { toast(e.message, true); });
}

// ---- 拖拽排序 ----
function chDragStart(e) {
  chDragId = Number(e.currentTarget.getAttribute('data-id'));
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(chDragId));
  e.currentTarget.classList.add('dragging');
}
function chDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}
function chDrop(e, i) {
  e.preventDefault();
  if (chDragId == null) return;
  var from = -1;
  for (var k = 0; k < chCache.length; k++) if (chCache[k].id === chDragId) { from = k; break; }
  if (from < 0 || from === i) return;
  var ids = chCache.map(function (c) { return c.id; });
  var moved = ids.splice(from, 1)[0];
  ids.splice(i, 0, moved);
  api('/api/channels/order', 'PUT', { ids: ids })
    .then(loadPush)
    .catch(function (err) { toast(err.message, true); loadPush(); });
}
function chDragEnd() {
  chDragId = null;
  var rows = document.querySelectorAll('.llm-row.dragging');
  for (var i = 0; i < rows.length; i++) rows[i].classList.remove('dragging');
}

// ---- 全局默认推送（settings.default_channels + default_template），弹窗内配置 ----
function openPushDefaultModal() {
  Promise.all([api('/api/push/default'), api('/api/channels')]).then(function (rs) {
    var def = rs[0], channels = rs[1].channels || [];
    var boxes = channels.map(function (c) {
      return '<label><input type="checkbox" class="pd-ch" value="' + c.id + '"' +
        ((def.channels || []).indexOf(c.id) >= 0 ? ' checked' : '') + '> ' + esc(c.name) +
        ' <span class="tag">' + esc(chanTag(c)) + '</span></label>';
    }).join('');
    openModal(
      '<h3>全局默认推送</h3>' +
      '<div class="mrow">渠道 ' + (boxes || '<span class="hint">还没有渠道</span>') + '</div>' +
      '<div class="mrow"><input id="tpl-input" class="wfull" value="' + esc(def.template || '') +
      '" placeholder="推送词，支持 {alias} {uname} {title}"></div>' +
      '<div class="mrow"><button onclick="savePushDefault()">保存</button>' +
      '<button onclick="closeModal()">取消</button></div>'
    );
  }).catch(function (e) { toast(e.message, true); });
}
function savePushDefault() {
  var ids = Array.prototype.slice.call(document.querySelectorAll('.pd-ch'))
    .filter(function (x) { return x.checked; }).map(function (x) { return Number(x.value); });
  api('/api/push/default', 'PUT', {
    template: document.getElementById('tpl-input').value.trim(),
    channels: ids,
  }).then(function () { closeModal(); toast('已保存'); })
    .catch(function (e) { toast(e.message, true); });
}

loadPush();
`;
