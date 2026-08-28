// 面板前端 · 卡片「推送渠道」+「推送规则」两张独立小卡：
// 渠道卡 = 总开关（卡片右上角）+ 渠道行列表（启停勾/名称/类型标签〔群号写在标签内〕/编辑/删除/拖拽把手）
// + 底部新增渠道按钮；规则卡 = 规则行列表（启停勾/名称/分类与生效主播标签/编辑/删除/拖拽把手，
// 全局排序 = 匹配优先级）+ 底部添加规则按钮。
// 渠道与规则的新增/编辑都走 sheet；规则的生效主播选择是二级 sheet。
// 引用对象不可用的可视化（ruleDeadReason，core.js）：规则引用的分类/渠道被停用或删除时规则实际
// 失效——规则行整行置灰 + 标题划线 + 原因标签；编辑弹窗里停用渠道保留勾选但灰勾划线、
// 停用分类在下拉里置灰划线，设置状态本身不受影响。
import { api, toast, ACTIONS, CHANGES, esc, gripHtml, checkDotHtml, iconBtn, field, checkRowHtml, chanTypeName, chanTag, makeSortable, openSheet, closeSheet, sheetCleanups, dropdownHtml, ruleDeadReason } from './core.js';
import { icon } from './icons.js';
import { loadStreamers, avatarHtml } from './streamers.js';

let chCache = [];
let ruleCache = [];
let ruleCats = [];
let streamerCache = [];
let ruleSheetUids = [];

// 规则行生效主播标签与一级表单摘要是空间受限场景：名称用简称（alias）优先、回退原名；
// 空间充足处（详情弹窗标题、生效主播勾选列表行）一律原名
function streamerName(uid) {
  for (let i = 0; i < streamerCache.length; i++) {
    if (String(streamerCache[i].uid) === String(uid)) {
      const s = streamerCache[i];
      return s.alias || s.uname || String(uid);
    }
  }
  return 'UID ' + uid;
}

function channelRowHtml(c) {
  return `<div class="row" data-sid="${c.id}">` +
    gripHtml() +
    checkDotHtml('data-change="toggle-channel"', c.enabled) +
    `<span class="row-title">${esc(c.name)}</span>` +
    `<span class="tag">${esc(chanTag(c))}</span>` +
    '<span class="row-end">' +
    iconBtn('edit-channel', 'pencil', '编辑') +
    iconBtn('del-channel', 'trash', '删除', true) +
    '</span></div>';
}

function ruleCatName(categoryId) {
  if (categoryId == null) return '任意开播';
  for (let i = 0; i < ruleCats.length; i++) if (ruleCats[i].id === categoryId) return ruleCats[i].name;
  return '分类已删除';
}

// 规则整体不可达（ruleDeadReason：自身停用 / 分类停用或已删 / 渠道全不可用）时整行置灰、
// 标题划线，且只保留不可达原因标签（分类/主播标签此时已无意义）；勾选状态不受影响，
// 恢复引用对象即自动复原。生效主播标签用简称优先（空间受限，短名能留下更多枚），
// uids 空 = 一枚「全部主播」标签；行宽不足时 fitRow 从尾部逐枚舍弃
function ruleRowHtml(r) {
  const dead = ruleDeadReason(r, ruleCats, chCache);
  const uidsTags = r.uids.length === 0
    ? '<span class="tag">全部主播</span>'
    : r.uids.map(function (u) { return `<span class="tag">${esc(streamerName(u))}</span>`; }).join('');
  return `<div class="row${dead ? ' rule-dead' : ''}" data-sid="${r.id}">` +
    gripHtml() +
    checkDotHtml('data-change="toggle-push-rule"', r.enabled) +
    `<span class="row-title">${esc(r.name)}</span>` +
    (dead ? `<span class="tag">${esc(dead)}</span>`
          : `<span class="tag">${esc(ruleCatName(r.categoryId))}</span>` + uidsTags) +
    '<span class="row-end">' +
    iconBtn('edit-push-rule', 'pencil', '编辑') +
    iconBtn('del-push-rule', 'trash', '删除', true) +
    '</span></div>';
}

export function loadPush() {
  return Promise.all([
    api('/api/push'), api('/api/channels'), api('/api/rules'), api('/api/categories'), api('/api/streamers'),
  ]).then(function (rs) {
    const en = document.getElementById('push-enabled');
    if (en) en.checked = rs[0].enabled;
    chCache = rs[1].channels || [];
    document.getElementById('channel-list').innerHTML = chCache.map(channelRowHtml).join('');
    ruleCache = rs[2].rules || [];
    ruleCats = rs[3].categories || [];
    streamerCache = rs[4].streamers || [];
    document.getElementById('rule-list').innerHTML = ruleCache.map(ruleRowHtml).join('');
  }).catch(function (e) { toast(e.message, true); });
}

CHANGES['toggle-push'] = function (el) {
  const on = el.checked;
  api('/api/push/enabled', 'PUT', { enabled: on })
    .then(function () { toast(on ? '推送已启用' : '推送已停用'); })
    .catch(function (e) { toast(e.message, true); loadPush(); });
};

CHANGES['toggle-channel'] = function (el) {
  const id = el.closest('.row').getAttribute('data-sid');
  const on = el.checked;
  api('/api/channels/' + id, 'PUT', { enabled: on })
    .then(function () { toast(on ? '已启用' : '已停用'); loadPush(); }) // 刷新 chCache + 规则行/弹窗的渠道灰态
    .catch(function (e) { toast(e.message, true); loadPush(); });
};

CHANGES['toggle-push-rule'] = function (el) {
  const id = el.closest('.row').getAttribute('data-sid');
  const on = el.checked;
  api('/api/rules/' + id, 'PUT', { enabled: on })
    .then(function () { toast(on ? '已启用' : '已停用'); loadPush(); loadStreamers(); }) // loadPush：规则行「已停用」划线态
    .catch(function (e) { toast(e.message, true); loadPush(); });
};

function pushChannelById(id) {
  for (let i = 0; i < chCache.length; i++) if (chCache[i].id === id) return chCache[i];
  return null;
}

function pushRuleById(id) {
  for (let i = 0; i < ruleCache.length; i++) if (ruleCache[i].id === id) return ruleCache[i];
  return null;
}

ACTIONS['del-channel'] = function (el) {
  const id = el.closest('.row').getAttribute('data-sid');
  if (!confirm('删除这个渠道？勾选了它的规则会少一个推送去处。')) return;
  api('/api/channels/' + id, 'DELETE')
    .then(function () { toast('已删除'); loadPush(); })
    .catch(function (e) { toast(e.message, true); });
};

ACTIONS['del-push-rule'] = function (el) {
  const id = el.closest('.row').getAttribute('data-sid');
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
  const c = id === null ? null : pushChannelById(id);
  if (id !== null && !c) { toast('渠道数据未加载', true); return; }
  const selType = c ? (c.notifier === 'toast' ? 'toast' : c.targetType) : 'toast';
  openSheet(c ? '编辑渠道' : '新增渠道',
    field('名称', `<input id="cn-name" placeholder="如：粉丝群" value="${c ? esc(c.name) : ''}">`) +
    field('类型', dropdownHtml('cn-type', [
      { value: 'toast', label: '系统通知' },
      { value: 'group', label: 'QQ群' },
      { value: 'private', label: 'QQ私聊' },
    ], selType, 'cn-type-change')) +
    '<div class="field" id="cn-target-field">' +
      '<label class="field-label" id="cn-target-label">群号</label>' +
      `<input id="cn-target" value="${c && c.targetId ? esc(c.targetId) : ''}">` +
    '</div>' +
    '<div class="sheet-foot"><button class="btn" data-action="close-sheet" data-level="1">取消</button>' +
    `<button class="btn btn-primary" data-action="save-channel" data-id="${c ? c.id : ''}">保存</button></div>`);
  applyCnTarget(document.getElementById('cn-type'));
}

// 目标号随类型联动：系统通知不显示输入框；QQ群/QQ私聊分别标「群号」「QQ号」
function applyCnTarget(sel) {
  const fieldEl = document.getElementById('cn-target-field');
  const labelEl = document.getElementById('cn-target-label');
  if (sel.value === 'toast') {
    fieldEl.classList.add('hidden');
    return;
  }
  fieldEl.classList.remove('hidden');
  labelEl.textContent = sel.value === 'group' ? '群号' : 'QQ号';
}

CHANGES['cn-type-change'] = function (el) { applyCnTarget(el); };

ACTIONS['save-channel'] = function (el) {
  const idAttr = el.getAttribute('data-id');
  const type = document.getElementById('cn-type').value;
  const body = {
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
  const req = idAttr
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
  if (uids.length === 0) return '全部主播（含未来新增）';
  return uids.map(streamerName).join('、');
}

function openPushRuleSheet(id) {
  const r = id === null ? null : pushRuleById(id);
  if (id !== null && !r) { toast('规则数据未加载', true); return; }
  ruleSheetUids = r ? r.uids.slice() : [];
  const catOptions = [{ value: '', label: '任意开播' }].concat(ruleCats.map(function (c) {
    return { value: c.id, label: c.name, off: c.enabled === false };
  }));
  const chanRows = chCache.length === 0
    ? ''
    : chCache.map(function (c) {
        // 停用渠道保留勾选状态，仅灰勾 + 名称划线（ref-off），类型标签不显示
        return checkRowHtml(`class="pr-ch" value="${c.id}"`, !!(r && (r.channels || []).indexOf(c.id) >= 0),
          `<span class="row-title">${esc(c.name)}</span>` +
          (c.enabled ? `<span class="tag">${esc(chanTypeName(c))}</span>` : ''),
          c.enabled ? '' : 'ref-off');
      }).join('');
  openSheet(r ? '编辑规则' : '添加规则',
    field('名称', `<input id="pr-name" placeholder="留空自动命名" value="${r ? esc(r.name) : ''}">`) +
    field('分类', dropdownHtml('pr-cat', catOptions, r ? r.categoryId : '')) +
    field('生效主播', '<div class="row" data-action="open-rule-streamers">' +
      `<span class="row-title" id="pr-uids-summary">${esc(uidsSummary(ruleSheetUids))}</span>` +
      `<span class="row-end">${icon('chevron-right')}</span></div>`) +
    '<div class="field"><label>渠道</label>' + (chanRows || '<span class="hint">还没有渠道</span>') + '</div>' +
    field('推送词', `<input id="pr-tpl" placeholder="留空 = 默认推送词（{liver} 开播了）" value="` +
      (r ? esc(r.messageTemplate || '') : '') + '">') +
    '<div class="sheet-foot"><span id="rule-err" class="form-err"></span>' +
    '<button class="btn" data-action="close-sheet" data-level="1">取消</button>' +
    `<button class="btn btn-primary" data-action="save-push-rule" data-id="${r ? r.id : ''}">保存</button></div>`);
}

// 二级 sheet：生效主播勾选（全部不勾 = 全部主播含未来新增）。
// 列表样式 = 左头像+原名（UID 小字）、右勾选框，行间分割线（.pick-list，非卡片行）
ACTIONS['open-rule-streamers'] = function () {
  api('/api/streamers').then(function (j) {
    const list = j.streamers || [];
    streamerCache = list; // 顺带刷新名称缓存（规则行标签/一级表单摘要共用）
    const rows = list.map(function (s) {
      const nm = s.uname || String(s.uid);
      return '<label class="pick-row">' +
        avatarHtml(s.face, nm, 'avatar avatar-sm') +
        `<span class="pick-name">${esc(nm)}</span>` +
        `<span class="meta">UID ${esc(s.uid)}</span>` +
        `<span class="checkbox"><input type="checkbox" class="pr-uid" value="${esc(s.uid)}"` +
        `${ruleSheetUids.indexOf(String(s.uid)) >= 0 ? ' checked' : ''}><span class="box"></span></span>` +
        '</label>';
    }).join('');
    openSheet('生效主播',
      '<div class="hint">全部不勾 = 对全部主播生效（含未来新增）</div>' +
      (rows ? `<div class="pick-list">${rows}</div>` : '<p class="hint">监听名单为空</p>') +
      '<div class="sheet-foot"><button class="btn btn-primary" data-action="close-sheet" data-level="2">完成</button></div>',
      2);
    // 关窗（完成 / × / 遮罩）统一走 cleanup 同步选择回一级表单的摘要
    sheetCleanups[2] = syncRuleUids;
  }).catch(function (e) { toast(e.message, true); });
};

function syncRuleUids() {
  ruleSheetUids = Array.prototype.slice.call(document.querySelectorAll('#sheet-mask2 .pr-uid'))
    .filter(function (x) { return x.checked; }).map(function (x) { return x.value; });
  const el = document.getElementById('pr-uids-summary');
  if (el) el.textContent = uidsSummary(ruleSheetUids);
}

ACTIONS['save-push-rule'] = function (el) {
  const err = document.getElementById('rule-err');
  if (err) err.textContent = '';
  const name = document.getElementById('pr-name').value.trim();
  const catVal = document.getElementById('pr-cat').value;
  // name 空则不提交该字段：POST 由后端自动补「规则 N」，PUT 保留原名（显式空串会 400）
  const body = {
    categoryId: catVal === '' ? null : Number(catVal),
    uids: ruleSheetUids,
    channels: Array.prototype.slice.call(document.querySelectorAll('#sheet-mask1 .pr-ch'))
      .filter(function (x) { return x.checked; }).map(function (x) { return Number(x.value); }),
    messageTemplate: document.getElementById('pr-tpl').value.trim() || null,
  };
  if (name) body.name = name;
  const idAttr = el.getAttribute('data-id');
  const req = idAttr
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

// 主播详情弹窗的规则行（streamers.js 渲染，data-action 委托到这张表）：关详情弹窗 →
// 切到设置视图 → 直接打开该规则的编辑弹窗（刷新缓存后开，规则已删则 toast 提示）
ACTIONS['goto-push-rule'] = function (el) {
  const rid = Number(el.getAttribute('data-rid'));
  closeSheet(1);
  const nav = document.querySelector('.nav-item[data-view="settings"]');
  if (nav) nav.click();
  loadPush().then(function () { openPushRuleSheet(rid); });
};

// ---- 推送设置（推送渠道卡底部按钮）：冷启动触发时机 2 项 ----
function pushBoolRow(id, text, on) {
  return checkRowHtml(`id="${id}"`, on, `<span class="row-title">${esc(text)}</span>`);
}

ACTIONS['open-push-settings'] = function () {
  api('/api/advanced').then(function (j) {
    openSheet('推送设置',
      pushBoolRow('ps-b-first', '启动时已在播也推送', j.notifyOnFirstRun) +
      pushBoolRow('ps-b-newsub', '新增订阅在播即推送', j.notifyOnNewSubscription) +
      '<div class="add-row"><button class="btn btn-block" data-action="test-push">' +
      icon('bolt') + ' 测试推送渠道</button></div>' +
      '<div class="sheet-foot"><button class="btn" data-action="close-sheet" data-level="1">取消</button>' +
      '<button class="btn btn-primary" data-action="save-push-settings">保存</button></div>');
  }).catch(function (e) { toast(e.message, true); });
};

ACTIONS['test-push'] = function () {
  if (!confirm('向全部启用的渠道发送一条测试推送？')) return;
  api('/api/push/test', 'POST')
    .then(function (j) {
      if (j.total === 0) toast('没有可用的推送渠道：先在渠道列表添加并启用', true);
      else toast('测试推送完成：' + j.succeeded + '/' + j.total + ' 成功');
    })
    .catch(function (e) { toast(e.message, true); });
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
