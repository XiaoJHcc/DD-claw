/**
 * 面板前端 · 卡片「推送渠道」+「推送规则」两张独立小卡：
 * 渠道卡 = 总开关（卡片右上角）+ 渠道行列表（启停勾/名称/类型标签〔群号写在标签内〕/编辑/删除/拖拽把手）
 * + 底部新增渠道按钮；规则卡 = 规则行列表（启停勾/名称/分类与生效主播标签/编辑/删除/拖拽把手，
 * 全局排序 = 匹配优先级）+ 底部添加规则按钮。
 * 渠道与规则的新增/编辑都走 sheet；规则的生效主播选择是二级 sheet。
 * 内嵌进页面 <script>，内容不得出现反引号与 ${，一律字符串拼接。依赖 icons / app-core 段。
 */
export const APP_PUSH = `
var chCache = [];
var ruleCache = [];
var ruleCats = [];
var ruleSheetUids = [];

function channelRowHtml(c) {
  return '<div class="row" draggable="true" data-sid="' + c.id + '">' +
    gripHtml() +
    checkDotHtml('data-change="toggle-channel"', c.enabled) +
    '<span class="row-title">' + esc(c.name) + '</span>' +
    '<span class="tag">' + esc(chanTag(c)) + '</span>' +
    '<span class="row-end">' +
    iconBtn('edit-channel', 'pencil', '编辑') +
    iconBtn('del-channel', 'trash', '删除', true) +
    '</span></div>';
}

function ruleCatName(categoryId) {
  if (categoryId == null) return '任意开播';
  for (var i = 0; i < ruleCats.length; i++) if (ruleCats[i].id === categoryId) return ruleCats[i].name;
  return '分类已删除';
}

function ruleRowHtml(r) {
  return '<div class="row" draggable="true" data-sid="' + r.id + '">' +
    gripHtml() +
    checkDotHtml('data-change="toggle-push-rule"', r.enabled) +
    '<span class="row-title">' + esc(r.name) + '</span>' +
    '<span class="tag">' + esc(ruleCatName(r.categoryId)) + '</span>' +
    '<span class="tag">' + (r.uids.length === 0 ? '全部主播' : r.uids.length + ' 位主播') + '</span>' +
    '<span class="row-end">' +
    iconBtn('edit-push-rule', 'pencil', '编辑') +
    iconBtn('del-push-rule', 'trash', '删除', true) +
    '</span></div>';
}

function loadPush() {
  return Promise.all([
    api('/api/push'), api('/api/channels'), api('/api/rules'), api('/api/categories'),
  ]).then(function (rs) {
    var en = document.getElementById('push-enabled');
    if (en) en.checked = rs[0].enabled;
    chCache = rs[1].channels || [];
    document.getElementById('channel-list').innerHTML = chCache.map(channelRowHtml).join('');
    ruleCache = rs[2].rules || [];
    ruleCats = rs[3].categories || [];
    document.getElementById('rule-list').innerHTML =
      ruleCache.map(ruleRowHtml).join('') +
      '<div class="add-row"><button class="btn btn-block" data-action="add-push-rule">' +
      icon('plus') + ' 添加规则</button></div>';
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

CHANGES['toggle-push-rule'] = function (el) {
  var id = el.closest('.row').getAttribute('data-sid');
  var on = el.checked;
  api('/api/rules/' + id, 'PUT', { enabled: on })
    .then(function () { toast(on ? '已启用' : '已停用'); loadStreamers(); })
    .catch(function (e) { toast(e.message, true); loadPush(); });
};

function pushChannelById(id) {
  for (var i = 0; i < chCache.length; i++) if (chCache[i].id === id) return chCache[i];
  return null;
}

function pushRuleById(id) {
  for (var i = 0; i < ruleCache.length; i++) if (ruleCache[i].id === id) return ruleCache[i];
  return null;
}

ACTIONS['del-channel'] = function (el) {
  var id = el.closest('.row').getAttribute('data-sid');
  if (!confirm('删除这个渠道？勾选了它的规则会少一个推送去处。')) return;
  api('/api/channels/' + id, 'DELETE')
    .then(function () { toast('已删除'); loadPush(); })
    .catch(function (e) { toast(e.message, true); });
};

ACTIONS['del-push-rule'] = function (el) {
  var id = el.closest('.row').getAttribute('data-sid');
  if (!confirm('删除这条规则？')) return;
  api('/api/rules/' + id, 'DELETE')
    .then(function () { toast('已删除'); loadPush(); loadStreamers(); })
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

// ---- 推送规则 新增/编辑 弹窗（一级 sheet；生效主播选择是二级 sheet） ----
ACTIONS['add-push-rule'] = function () { openPushRuleSheet(null); };
ACTIONS['edit-push-rule'] = function (el) {
  openPushRuleSheet(Number(el.closest('.row').getAttribute('data-sid')));
};

function uidsSummary(uids) {
  return uids.length === 0 ? '全部主播（含未来新增）' : '已选 ' + uids.length + ' 位主播';
}

function openPushRuleSheet(id) {
  var r = id === null ? null : pushRuleById(id);
  if (id !== null && !r) { toast('规则数据未加载', true); return; }
  ruleSheetUids = r ? r.uids.slice() : [];
  var catOptions = '<option value="">任意开播</option>' + ruleCats.map(function (c) {
    return '<option value="' + c.id + '"' + (r && r.categoryId === c.id ? ' selected' : '') + '>' +
      esc(c.name) + '</option>';
  }).join('');
  var chanRows = chCache.length === 0
    ? ''
    : chCache.map(function (c) {
        return checkRowHtml('class="pr-ch" value="' + c.id + '"', !!(r && (r.channels || []).indexOf(c.id) >= 0),
          '<span class="row-title">' + esc(c.name) + '</span>' +
          '<span class="tag">' + esc(chanTypeName(c)) + '</span>');
      }).join('');
  openSheet(r ? '编辑规则' : '添加规则',
    field('名称', '<input id="pr-name" placeholder="留空自动命名" value="' + (r ? esc(r.name) : '') + '">') +
    field('分类', '<select id="pr-cat">' + catOptions + '</select>') +
    field('生效主播', '<div class="row" data-action="open-rule-streamers">' +
      '<span class="row-title" id="pr-uids-summary">' + esc(uidsSummary(ruleSheetUids)) + '</span>' +
      '<span class="row-end">' + icon('chevron-right') + '</span></div>') +
    '<div class="field"><label>渠道</label>' + (chanRows || '<span class="hint">还没有渠道</span>') + '</div>' +
    field('推送词', '<input id="pr-tpl" placeholder="留空 = 默认推送词（{alias} 开播了）" value="' +
      (r ? esc(r.messageTemplate || '') : '') + '">') +
    '<div class="sheet-foot"><span id="rule-err" class="form-err"></span>' +
    '<button class="btn" data-action="close-sheet" data-level="1">取消</button>' +
    '<button class="btn btn-primary" data-action="save-push-rule" data-id="' + (r ? r.id : '') + '">保存</button></div>');
}

// 二级 sheet：生效主播勾选（全部不勾 = 全部主播含未来新增）
ACTIONS['open-rule-streamers'] = function () {
  api('/api/streamers').then(function (j) {
    var list = j.streamers || [];
    var rows = list.map(function (s) {
      return checkRowHtml('class="pr-uid" value="' + esc(s.uid) + '"',
        ruleSheetUids.indexOf(String(s.uid)) >= 0,
        '<span class="row-title">' + esc(s.alias || s.uname || s.uid) + '</span>' +
        '<span class="meta">UID ' + esc(s.uid) + '</span>');
    }).join('');
    openSheet('生效主播',
      '<div class="hint">全部不勾 = 对全部主播生效（含未来新增）</div>' +
      (rows || '<p class="hint">监听名单为空</p>') +
      '<div class="sheet-foot"><button class="btn btn-primary" data-action="close-sheet" data-level="2">完成</button></div>',
      2);
    // 关窗（完成 / × / 遮罩）统一走 cleanup 同步选择回一级表单的摘要
    sheetCleanups[2] = syncRuleUids;
  }).catch(function (e) { toast(e.message, true); });
};

function syncRuleUids() {
  ruleSheetUids = Array.prototype.slice.call(document.querySelectorAll('#sheet-mask2 .pr-uid'))
    .filter(function (x) { return x.checked; }).map(function (x) { return x.value; });
  var el = document.getElementById('pr-uids-summary');
  if (el) el.textContent = uidsSummary(ruleSheetUids);
}

ACTIONS['save-push-rule'] = function (el) {
  var err = document.getElementById('rule-err');
  if (err) err.textContent = '';
  var name = document.getElementById('pr-name').value.trim();
  var catVal = document.getElementById('pr-cat').value;
  // name 空则不提交该字段：POST 由后端自动补「规则 N」，PUT 保留原名（显式空串会 400）
  var body = {
    categoryId: catVal === '' ? null : Number(catVal),
    uids: ruleSheetUids,
    channels: Array.prototype.slice.call(document.querySelectorAll('#sheet-mask1 .pr-ch'))
      .filter(function (x) { return x.checked; }).map(function (x) { return Number(x.value); }),
    messageTemplate: document.getElementById('pr-tpl').value.trim() || null,
  };
  if (name) body.name = name;
  var idAttr = el.getAttribute('data-id');
  var req = idAttr
    ? api('/api/rules/' + idAttr, 'PUT', body)
    : api('/api/rules', 'POST', body);
  req.then(function () {
    closeSheet(1);
    toast(idAttr ? '已保存' : '已添加');
    loadPush();
    loadStreamers(); // 主播卡的规则名标签
  }).catch(function (e) { if (err) err.textContent = e.message; });
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

// 拖拽排序：规则全局顺序 = 匹配优先级
makeSortable(document.getElementById('rule-list'), {
  items: function () { return ruleCache; },
  getId: function (r) { return r.id; },
  onOrder: function (ids) {
    api('/api/rules/order', 'PUT', { ids: ids })
      .then(loadPush)
      .catch(function (err) { toast(err.message, true); loadPush(); });
  },
});

// ---- 推送设置（推送渠道卡底部按钮）：冷启动触发时机 2 项 ----
function pushBoolRow(id, text, on) {
  return checkRowHtml('id="' + id + '"', on, '<span class="row-title">' + esc(text) + '</span>');
}

ACTIONS['open-push-settings'] = function () {
  api('/api/advanced').then(function (j) {
    openSheet('推送设置',
      pushBoolRow('ps-b-first', '启动时已在播也推送', j.notifyOnFirstRun) +
      pushBoolRow('ps-b-newsub', '新增订阅在播即推送', j.notifyOnNewSubscription) +
      '<div class="sheet-foot"><button class="btn" data-action="close-sheet" data-level="1">取消</button>' +
      '<button class="btn btn-primary" data-action="save-push-settings">保存</button></div>');
  }).catch(function (e) { toast(e.message, true); });
};

ACTIONS['save-push-settings'] = function () {
  api('/api/advanced', 'PUT', {
    notifyOnFirstRun: document.getElementById('ps-b-first').checked,
    notifyOnNewSubscription: document.getElementById('ps-b-newsub').checked,
  }).then(function () {
    closeSheet(1);
    toast('已保存并生效');
  }).catch(function (e) { toast(e.message, true); });
};

loadPush();
`;
