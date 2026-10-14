// 面板前端 · 卡片「推送渠道」+「推送规则」两张独立小卡（v2 形态）：
// 渠道卡 = 总开关（卡片右上角）+ 渠道行列表（拖拽把手/启停勾/名称+类型标签/副行「类型 · 目标号」，
// 双行档 .row-2）+ 底部新增渠道按钮，本文件自管；规则卡 = **统一规则组件**（rules.js）渲染的
// 作用域编辑/启停删除全部走 rules.js（与图文页「图文规则」卡同一组件、同一交互语言）。
// 渠道的新增/编辑走一级 sheet。规则整体不可达（ruleDeadReason，core.js）时整行置灰 + 标题划线，
// 副行只留不可达原因；勾选状态不受影响，恢复引用对象即自动复原。
import { api, toast, ACTIONS, CHANGES, esc, gripHtml, checkDotHtml, iconBtn, field, checkRowHtml, chanTypeName, makeSortable, mergeVisibleOrder, openSheet, closeSheet, dropdownHtml, onTableRefresh } from './core.js';
import { loadRuleCard, getRuleCardData, ruleRowHtml, openRuleSheet, onRulesChanged } from './rules.js';
import { icon } from './icons.js';
import { loadStreamers } from './streamers.js';

let chCache = [];
let ruleCache = [];

// 渠道行：v2 双行档（.row-2）——主行名称，副行只放真实信息「类型 · 目标号」（v2 不定 tag，副行已承载）
function channelRowHtml(c) {
  const sub = c.notifier === 'toast' ? '本机系统通知' : chanTypeName(c) + ' · ' + (c.targetId || '');
  return `<div class="row row-2" data-sid="${c.id}">` +
    gripHtml() +
    checkDotHtml('data-change="toggle-channel"', c.enabled) +
    '<span class="row-main"><span class="row-line">' +
    `<span class="row-title">${esc(c.name)}</span>` +
    '</span>' +
    `<span class="row-sub">${esc(sub)}</span></span>` +
    '<span class="row-end">' +
    iconBtn('edit-channel', 'pencil', '编辑') +
    iconBtn('del-channel', 'trash', '删除', true) +
    '</span></div>';
}

export function loadPush() {
  return Promise.all([api('/api/push'), loadRuleCard()]).then(function (rs) {
    const en = document.getElementById('push-enabled');
    if (en) en.checked = rs[0].enabled;
    chCache = rs[1].channels;
    document.getElementById('channel-list').innerHTML = chCache.map(channelRowHtml).join('');
    ruleCache = rs[1].rules.filter(function (r) { return (r.subjectKind || 'live') === 'live'; });
    const list = document.getElementById('rule-list');
    if (list) list.innerHTML = ruleCache.map(ruleRowHtml).join('');
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

ACTIONS['del-channel'] = function (el) {
  const id = el.closest('.row').getAttribute('data-sid');
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
  const c = id === null ? null : pushChannelById(id);
  if (id !== null && !c) { toast('渠道数据未加载', true); return; }
  const selType = c ? (c.notifier === 'toast' ? 'toast' : c.targetType) : 'toast';
  openSheet(c ? '编辑渠道' : '新增渠道',
    field('名称', `<input class="inp" id="cn-name" placeholder="如：粉丝群" value="${c ? esc(c.name) : ''}">`) +
    field('类型', dropdownHtml('cn-type', [
      { value: 'toast', label: '系统通知' },
      { value: 'group', label: 'QQ群' },
      { value: 'private', label: 'QQ私聊' },
    ], selType, 'cn-type-change')) +
    '<div class="field" id="cn-target-field">' +
      '<label class="field-label" id="cn-target-label">群号</label>' +
      `<input class="inp" id="cn-target" value="${c && c.targetId ? esc(c.targetId) : ''}">` +
    '</div>' +
    '<div class="sheet-foot"><button class="btn" data-action="close-sheet" data-level="1">取消</button>' +
    `<button class="btn btn-primary" data-action="save-channel" data-id="${c ? c.id : ''}">保存</button></div>`);
  applyCnTarget(document.getElementById('cn-type'));
}

function pushChannelById(id) {
  for (let i = 0; i < chCache.length; i++) if (chCache[i].id === id) return chCache[i];
  return null;
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

// ---- 推送规则：入口开统一规则弹窗（rules.js）；直播形态为本页默认 ----
ACTIONS['add-push-rule'] = function () { openRuleSheet(null, { kind: 'live' }); };

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

makeSortable(document.getElementById('rule-list'), {
  items: function () { return ruleCache; },
  getId: function (r) { return r.id; },
  onOrder: function (ids) {
    api('/api/rules/order', 'PUT', { ids: mergeVisibleOrder(getRuleCardData().rules, ids) })
      .then(loadPush)
      .catch(function (err) { toast(err.message, true); loadPush(); });
  },
});

// 主播详情弹窗的规则行（streamers.js 渲染，data-action 委托到这张表）：关详情弹窗 →
// 切到主播视图（推送规则卡已随直播设置搬入主播分页）→ 直接打开该规则的统一编辑弹窗
ACTIONS['goto-push-rule'] = function (el) {
  const rid = Number(el.getAttribute('data-rid'));
  closeSheet(1);
  const nav = document.querySelector('.nav-item[data-view="streamers"]');
  if (nav) nav.click();
  loadPush().then(function () {
    const r = getRuleCardData().rules.find(function (x) { return x.id === rid; });
    if (r) openRuleSheet(r, { level: 1 });
    else toast('规则已删除', true);
  });
};

// ---- 推送设置（推送渠道卡底部按钮）：「错过期间的处理」一组，按内容类型分行标注 ----
// 直播侧 = 冷启动三类抑制（pipeline 侧）；图文侧 = 补推开关 + 时间窗/条数封顶（source 侧 backlog）。
// 实现仍分属两处，产品概念是一件事：程序没在跑/重启期间错过的推送，怎么补。
function psRow(id, kind, text, on) {
  const tagCls = kind === '直播场次' ? 'tag-blue' : 'tag-mint';
  return checkRowHtml(`id="${id}"`, on,
    `<span class="tag ${tagCls}">${esc(kind)}</span><span class="row-title">${esc(text)}</span>`);
}

function syncBacklogOpts() {
  const cb = document.getElementById('ps-b-backlog');
  const box = document.getElementById('ps-backlog-opts');
  if (cb && box) box.style.display = cb.checked ? '' : 'none';
}
document.addEventListener('change', function (e) {
  if (e.target && e.target.id === 'ps-b-backlog') syncBacklogOpts();
});

ACTIONS['open-push-settings'] = function () {
  api('/api/advanced').then(function (j) {
    openSheet('推送设置',
      '<div class="adv-group">错过期间的处理</div>' +
      '<div class="hint" style="margin-bottom:8px">程序未运行 / 重启期间错过的推送，按内容类型分别处理</div>' +
      psRow('ps-b-first', '直播场次', '启动时已在播也推送', j.notifyOnFirstRun) +
      psRow('ps-b-newsub', '直播场次', '新增订阅在播即推送', j.notifyOnNewSubscription) +
      psRow('ps-b-backlog', '图文帖', '补推未运行期间的图文', j.backlogPushEnabled) +
      '<div class="two" id="ps-backlog-opts">' +
      field('补推时间限制（小时）', '<input class="inp" type="number" id="ps-n-age" value="' + j.backlogMaxAgeHours + '">') +
      field('补推账号条数限制（1~50）', '<input class="inp" type="number" id="ps-n-count" value="' + j.backlogMaxPerAccount + '">') +
      '</div>' +
      '<div class="add-row"><button class="btn btn-block" data-action="test-push">' +
      icon('bolt') + ' 测试推送渠道</button></div>' +
      '<div class="sheet-foot"><span id="ps-err" class="form-err"></span><button class="btn" data-action="close-sheet" data-level="1">取消</button>' +
      '<button class="btn btn-primary" data-action="save-push-settings">保存</button></div>');
    syncBacklogOpts();
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
  const errEl = document.getElementById('ps-err');
  const age = parseInt(document.getElementById('ps-n-age').value, 10);
  const count = parseInt(document.getElementById('ps-n-count').value, 10);
  if (isNaN(age) || isNaN(count)) { errEl.textContent = '补推上限请输入整数'; return; }
  api('/api/advanced', 'PUT', {
    notifyOnFirstRun: document.getElementById('ps-b-first').checked,
    notifyOnNewSubscription: document.getElementById('ps-b-newsub').checked,
    backlogPushEnabled: document.getElementById('ps-b-backlog').checked,
    backlogMaxAgeHours: age,
    backlogMaxPerAccount: count,
  }).then(function () {
    closeSheet(1);
    toast('已保存并生效');
  }).catch(function (e) { toast(e.message, true); });
};

loadPush();
onRulesChanged(function () { loadPush(); loadStreamers(); });
// 一次拉全（推送开关 / 渠道 / 规则·分类·名单·账号〔rules.js 共享缓存〕）——这些表任一被撤销
// 都靠它拉回真实态；登记为同一个函数，refreshTables 的去重保证只跑一次。
onTableRefresh(['settings', 'push_channels', 'push_rules', 'categories', 'streamers'], loadPush);
