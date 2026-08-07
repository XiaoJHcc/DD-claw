/**
 * 面板前端 · 卡片3 推送：总开关（卡片右上角）+ 渠道列表
 * （iOS 开关/名称/类型标签〔群号写在标签内〕/编辑/删除/拖拽把手）。
 * 新增/编辑走 sheet；全局默认推送也在 sheet 里配置，主卡片底部留两个按钮入口。
 * 内嵌进页面 <script>，内容不得出现反引号与 ${，一律字符串拼接。依赖 icons / app-core 段。
 */
export const APP_PUSH = `
var chCache = [];

function channelRowHtml(c) {
  return '<div class="row" draggable="true" data-sid="' + c.id + '">' +
    gripHtml() +
    switchHtml('data-change="toggle-channel"', c.enabled) +
    '<span class="row-title">' + esc(c.name) + '</span>' +
    '<span class="tag">' + esc(chanTag(c)) + '</span>' +
    '<span class="row-end">' +
    iconBtn('edit-channel', 'pencil', '编辑') +
    iconBtn('del-channel', 'trash', '删除', true) +
    '</span></div>';
}

function loadPush() {
  return Promise.all([api('/api/push'), api('/api/channels')]).then(function (rs) {
    var en = document.getElementById('push-enabled');
    if (en) en.checked = rs[0].enabled;
    chCache = rs[1].channels || [];
    document.getElementById('channel-list').innerHTML = chCache.map(channelRowHtml).join('');
  }).catch(function (e) { toast(e.message, true); });
}

CHANGES['toggle-push'] = function (el) {
  var on = el.checked;
  api('/api/push/enabled', 'PUT', { enabled: on })
    .then(function () { toast(on ? '推送已启用' : '推送已停用'); })
    .catch(function (e) { toast(e.message, true); loadPush(); });
};

CHANGES['toggle-channel'] = function (el) {
  var id = el.closest('.row').getAttribute('data-sid');
  var on = el.checked;
  api('/api/channels/' + id, 'PUT', { enabled: on })
    .then(function () { toast(on ? '已启用' : '已停用'); })
    .catch(function (e) { toast(e.message, true); loadPush(); });
};

function pushChannelById(id) {
  for (var i = 0; i < chCache.length; i++) if (chCache[i].id === id) return chCache[i];
  return null;
}

ACTIONS['del-channel'] = function (el) {
  var id = el.closest('.row').getAttribute('data-sid');
  if (!confirm('删除这个渠道？勾选了它的规则会少一个推送去处。')) return;
  api('/api/channels/' + id, 'DELETE')
    .then(function () { toast('已删除'); loadPush(); })
    .catch(function (e) { toast(e.message, true); });
};

// ---- 渠道 新增/编辑 弹窗（id=null 新增） ----
ACTIONS['add-channel'] = function () { openChannelSheet(null); };
ACTIONS['edit-channel'] = function (el) {
  openChannelSheet(Number(el.closest('.row').getAttribute('data-sid')));
};

function openChannelSheet(id) {
  var c = id === null ? null : pushChannelById(id);
  if (id !== null && !c) { toast('渠道数据未加载', true); return; }
  var selType = c ? (c.notifier === 'toast' ? 'toast' : c.targetType) : 'toast';
  openSheet(c ? '编辑渠道' : '新增渠道',
    field('名称', '<input id="cn-name" placeholder="如：粉丝群" value="' + (c ? esc(c.name) : '') + '">') +
    field('类型', '<select id="cn-type" data-change="cn-type-change">' +
      '<option value="toast">系统通知</option>' +
      '<option value="group">QQ群</option>' +
      '<option value="private">QQ私聊</option></select>') +
    field('群号 / QQ号', '<input id="cn-target" value="' + (c && c.targetId ? esc(c.targetId) : '') + '">') +
    '<div class="sheet-foot"><button class="btn" data-action="close-sheet" data-level="1">取消</button>' +
    '<button class="btn btn-primary" data-action="save-channel" data-id="' + (c ? c.id : '') + '">保存</button></div>');
  document.getElementById('cn-type').value = selType;
  document.getElementById('cn-target').disabled = selType === 'toast';
}

CHANGES['cn-type-change'] = function (el) {
  document.getElementById('cn-target').disabled = el.value === 'toast';
};

ACTIONS['save-channel'] = function (el) {
  var idAttr = el.getAttribute('data-id');
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
  var req = idAttr
    ? api('/api/channels/' + idAttr, 'PUT', body)
    : api('/api/channels', 'POST', body);
  req.then(function () {
    closeSheet(1);
    toast(idAttr ? '已保存' : '已新增');
    loadPush();
  }).catch(function (e) { toast(e.message, true); });
};

// ---- 全局默认推送（settings.default_channels + default_template）：条件规则都不命中时走这里 ----
ACTIONS['open-push-default'] = function () {
  Promise.all([api('/api/push/default'), api('/api/channels')]).then(function (rs) {
    var def = rs[0], channels = rs[1].channels || [];
    var rows = channels.map(function (c) {
      return '<div class="row"><span class="row-title">' + esc(c.name) + '</span>' +
        '<span class="tag">' + esc(chanTag(c)) + '</span>' +
        '<span class="row-end">' +
        switchHtml('class="pd-ch" value="' + c.id + '"', (def.channels || []).indexOf(c.id) >= 0) +
        '</span></div>';
    }).join('');
    openSheet('全局默认推送',
      '<div class="field"><label>渠道</label>' + (rows || '<span class="hint">还没有渠道</span>') + '</div>' +
      field('推送词', '<input id="tpl-input" value="' + esc(def.template || '') +
        '" placeholder="支持 {alias} {uname} {title}">') +
      '<div class="sheet-foot"><button class="btn" data-action="close-sheet" data-level="1">取消</button>' +
      '<button class="btn btn-primary" data-action="save-push-default">保存</button></div>');
  }).catch(function (e) { toast(e.message, true); });
};

ACTIONS['save-push-default'] = function () {
  var ids = Array.prototype.slice.call(document.querySelectorAll('#sheet-mask1 .pd-ch'))
    .filter(function (x) { return x.checked; }).map(function (x) { return Number(x.value); });
  api('/api/push/default', 'PUT', {
    template: document.getElementById('tpl-input').value.trim(),
    channels: ids,
  }).then(function () { closeSheet(1); toast('已保存'); })
    .catch(function (e) { toast(e.message, true); });
};

// 拖拽排序：渠道展示顺序落库
makeSortable(document.getElementById('channel-list'), {
  items: function () { return chCache; },
  getId: function (c) { return c.id; },
  onOrder: function (ids) {
    api('/api/channels/order', 'PUT', { ids: ids })
      .then(loadPush)
      .catch(function (err) { toast(err.message, true); loadPush(); });
  },
});

loadPush();
`;
