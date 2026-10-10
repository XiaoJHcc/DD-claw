// 面板前端 · 卡片「推送渠道」+「推送规则」两张独立小卡（v2 形态，行为与接口不变）：
// 渠道卡 = 总开关（卡片右上角）+ 渠道行列表（拖拽把手/启停勾/名称+类型标签/副行「类型 · 目标号」，
// 双行档 .row-2）+ 底部新增渠道按钮；规则卡 = 规则行列表（拖拽把手/启停勾/名称/分类与生效主播标签
// /编辑/删除，全局排序 = 匹配优先级）+ 底部添加规则按钮。
// 渠道与规则的新增/编辑都走一级 sheet。规则表单内：分类 = 自绘下拉（停用分类 off 置灰划线）、
// 渠道 = .chips 胶囊并排多选（未选灰圈浅灰字、已选蓝字淡蓝底带勾、停用渠道更浅灰 + 贯穿整枚删除线，
// 仍可勾——勾上也不生效，语义同旧版「保留勾选但灰勾划线」）、生效主播 = .cyl-card 3D 圆柱头像卡
// （点击开二级挑选弹窗）。挑选弹窗 = 关注列表同款 pick-card 头像卡网格（整卡可点、搜索只按昵称过滤、
// 挑选即生效到内存草稿并实时同步圆柱卡），全部不选 = 全部主播（含未来新增）；保存时才 PUT/POST 落库。
// 引用对象不可用的可视化（ruleDeadReason，core.js）：规则行整行置灰 + 标题划线 + 原因标签。
import { api, toast, ACTIONS, CHANGES, INPUTS, esc, gripHtml, checkDotHtml, iconBtn, field, checkRowHtml, chanTypeName, makeSortable, openSheet, closeSheet, dropdownHtml, ruleDeadReason, avatarHtml, onTableRefresh } from './core.js';
import { icon } from './icons.js';
import { loadStreamers } from './streamers.js';

let chCache = [];
let ruleCache = [];
let ruleCats = [];
let streamerCache = [];
let ruleDraftUids = new Set(); // 规则表单草稿：生效主播 uid（字符串），空 = 全部主播（含未来新增）

// 规则行生效主播标签是空间受限场景：名称用简称（alias）优先、回退原名
function streamerName(uid) {
  for (let i = 0; i < streamerCache.length; i++) {
    if (String(streamerCache[i].uid) === String(uid)) {
      const s = streamerCache[i];
      return s.alias || s.uname || String(uid);
    }
  }
  return 'UID ' + uid;
}

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

function ruleCatName(categoryId) {
  if (categoryId == null) return '任意内容';
  for (let i = 0; i < ruleCats.length; i++) if (ruleCats[i].id === categoryId) return ruleCats[i].name;
  return '分类已删除';
}

// 规则行生效范围标签：live 规则的 scope 是主播 uid（名称用简称优先、回退原名）；
// post 规则的 scope 是账号引用（`twitter:xxx` 等）——空 = 全部生效
function ruleScopeTags(r) {
  if ((r.scope || []).length === 0) {
    return r.subjectKind === 'post'
      ? '<span class="tag">全部账号</span>'
      : '<span class="tag">全部主播</span>';
  }
  if (r.subjectKind === 'post') {
    return r.scope.map(function (ref) { return `<span class="tag">${esc(ref)}</span>`; }).join('');
  }
  return r.scope.map(function (u) { return `<span class="tag">${esc(streamerName(u))}</span>`; }).join('');
}

// 规则整体不可达（ruleDeadReason：自身停用 / 分类停用或已删 / 渠道全不可用）时整行置灰、
// 标题划线，且只保留不可达原因标签（分类/范围标签此时已无意义）；勾选状态不受影响，
// 恢复引用对象即自动复原。行宽不足时 fitRow 从尾部逐枚舍弃（标签须为 .row 直接子级）
function ruleRowHtml(r) {
  const dead = ruleDeadReason(r, ruleCats, chCache);
  const scopeTags = ruleScopeTags(r);
  const catTag = (r.categoryId == null
    ? '<span class="tag tag-mint">任意内容</span>'
    : `<span class="tag tag-blue">${esc(ruleCatName(r.categoryId))}</span>`) +
    (r.subjectKind === 'post' ? '<span class="tag tag-purple">图文</span>' : '');
  return `<div class="row${dead ? ' rule-dead' : ''}" data-sid="${r.id}">` +
    gripHtml() +
    checkDotHtml('data-change="toggle-push-rule"', r.enabled) +
    `<span class="row-title">${esc(r.name)}</span>` +
    (dead ? `<span class="tag">${esc(dead)}</span>` : catTag + scopeTags) +
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

// ---- 推送规则 新增/编辑 弹窗（一级 sheet；生效主播挑选是二级 sheet） ----
ACTIONS['add-push-rule'] = function () { openPushRuleSheet(null); };
ACTIONS['edit-push-rule'] = function (el) {
  openPushRuleSheet(Number(el.closest('.row').getAttribute('data-sid')));
};

// ---- 生效主播 3D 圆柱卡（形态照搬 v2：头像按圆柱面投影位置排布、正对观察者不随柱面旋转、
// 只渲染正面可见弧 ±65°、两侧减半缩放、布局恒定单排最多 11 枚）----
// 未选（全部主播）= 同一排布循环补位铺满可见弧 + 正中盖「全部主播」；已选 = 按草稿序从正中向两侧排开
const CYL = { r: 240, ava: 46, gap: 2, thetaMax: 65, max: 11 };
CYL.step = 2 * Math.asin((CYL.ava + CYL.gap) / (2 * CYL.r)) * 180 / Math.PI; // ≈11.5°（弦长 = 头像 46 + 缝 2）

// 草稿 uid → 主播对象；已移出监听名单的 uid 给占位（同旧版摘要的「UID xxx」，不静默丢弃）
function streamerOf(uid) {
  for (let i = 0; i < streamerCache.length; i++) {
    if (String(streamerCache[i].uid) === uid) return streamerCache[i];
  }
  return { uid: uid, uname: 'UID ' + uid, face: null };
}

function cylCardHtml() {
  const all = streamerCache;
  const isAll = ruleDraftUids.size === 0;
  const list = isAll
    ? (all.length ? Array.from({ length: CYL.max }, function (_, i) { return all[i % all.length]; }) : [])
    : Array.from(ruleDraftUids).slice(0, CYL.max).map(streamerOf);
  const items = list.map(function (s, i) {
    const a = (i - (list.length - 1) / 2) * CYL.step;
    const f = 1 - 0.55 * Math.pow(Math.abs(a) / CYL.thetaMax, 2); // 两侧减半：弧端缩至 ≈0.45
    const x = (CYL.r * Math.sin(a * Math.PI / 180)).toFixed(2);
    const z = (CYL.r * Math.cos(a * Math.PI / 180)).toFixed(2);
    return `<span class="cyl-item" data-uid="${esc(String(s.uid))}" style="transform:translate3d(${x}px,0,${z}px) scale3d(${f.toFixed(3)},${f.toFixed(3)},1)">${avatarHtml(s.face, s.uname)}</span>`;
  }).join('');
  return `<button type="button" class="cyl-card" data-action="open-rule-streamers" aria-label="` +
    (isAll ? '全部主播' : `已选 ${ruleDraftUids.size} 人`) + '，点击挑选">' +
    '<span class="cyl-view" style="height:78px"><span class="cyl-stage">' + items + '</span>' +
    (isAll ? '<span class="cyl-alltag">全部主播</span>' : '') +
    '</span></button>';
}

// 挑选弹窗勾选 → 同步重画规则表单里的圆柱卡（sheet1 挂在 sheet2 弹窗后面，实时可见）。
// 循环补位会产生重复 uid，重复时无法按键配对滑动，只能整体重建；否则按 uid 原地改 transform 滑位
function renderRuleUids() {
  const card = document.querySelector('#sheet-mask1 .cyl-card');
  if (!card) return;
  const tpl = document.createElement('template');
  tpl.innerHTML = cylCardHtml();
  const next = tpl.content.firstElementChild;
  const oldStage = card.querySelector('.cyl-stage');
  const newStage = next.querySelector('.cyl-stage');
  const uids = function (stage) {
    return Array.prototype.map.call(stage.children, function (el) { return el.getAttribute('data-uid'); });
  };
  const keyed = function (stage) { const u = uids(stage); return new Set(u).size === u.length; };
  if (oldStage && keyed(oldStage) && keyed(newStage)) {
    const pool = new Map(Array.prototype.map.call(oldStage.children, function (el) {
      return [el.getAttribute('data-uid'), el];
    }));
    Array.prototype.forEach.call(newStage.querySelectorAll('.cyl-item'), function (n) {
      const uid = n.getAttribute('data-uid');
      const old = pool.get(uid);
      if (old) { old.style.transform = n.style.transform; pool.delete(uid); n.remove(); }
      else n.classList.add('cyl-new');
    });
    pool.forEach(function (el) { el.remove(); });
    Array.prototype.slice.call(newStage.children).forEach(function (n) { oldStage.appendChild(n); });
    const tag = card.querySelector('.cyl-alltag'), ntag = next.querySelector('.cyl-alltag');
    if (ntag && !tag) card.querySelector('.cyl-view').appendChild(ntag);
    if (!ntag && tag) tag.remove();
    card.setAttribute('aria-label', next.getAttribute('aria-label'));
  } else {
    card.innerHTML = next.innerHTML;
  }
}

let ruleDraftKind = 'live'; // 规则表单草稿：内容形态（live=开播 / post=图文）

function openPushRuleSheet(id) {
  const r = id === null ? null : pushRuleById(id);
  if (id !== null && !r) { toast('规则数据未加载', true); return; }
  ruleDraftUids = new Set((r && r.subjectKind === 'live' ? (r.scope || []) : []).map(function (u) { return String(u); }));
  ruleDraftKind = r ? (r.subjectKind || 'live') : 'live';
  const catOptions = [{ value: '', label: '任意内容' }].concat(ruleCats.map(function (c) {
    return { value: c.id, label: c.name + (c.appliesTo === 'post' ? '（图文）' : ''), off: c.enabled === false };
  }));
  // 渠道 = 胶囊并排多选（.chips）：已选 .on；停用渠道 .chip-dis（更浅灰 + 贯穿删除线，
  // 保留勾选状态仍可切换，title 提示勾上也不生效）
  const chips = chCache.length === 0
    ? ''
    : chCache.map(function (c) {
        const on = !!(r && (r.channels || []).indexOf(c.id) >= 0);
        const dis = !c.enabled;
        return `<button type="button" class="chip pr-ch${on ? ' on' : ''}${dis ? ' chip-dis' : ''}"` +
          ` data-action="rule-chip-toggle" data-chid="${c.id}"` +
          (dis ? ' title="该渠道已停用：勾选不会生效"' : '') +
          `><span class="chip-ic">${icon('check')}</span><span class="chip-txt">${esc(c.name)}</span></button>`;
      }).join('');
  const postScopeText = r && r.subjectKind === 'post' && (r.scope || []).length
    ? r.scope.join('、')
    : '全部账号生效（可在「图文」页账号卡上勾选限定）';
  openSheet(r ? '编辑规则' : '添加规则',
    field('内容形态', dropdownHtml('pr-kind', [
      { value: 'live', label: '直播开播' },
      { value: 'post', label: '图文帖' },
    ], ruleDraftKind, 'pr-kind-change')) +
    field('名称', `<input class="inp" id="pr-name" placeholder="留空自动命名" value="${r ? esc(r.name) : ''}">`) +
    field('分类', dropdownHtml('pr-cat', catOptions, r ? r.categoryId : '')) +
    `<div class="field" id="pr-live-fields"><label class="field-label">生效主播</label>${cylCardHtml()}</div>` +
    `<div class="field hidden" id="pr-post-fields"><label class="field-label">生效范围</label>` +
      `<div class="hint">${esc(postScopeText)}</div></div>` +
    '<div class="field"><label class="field-label">渠道</label>' +
      (chips ? `<div class="chips">${chips}</div>` : '<span class="hint">还没有渠道</span>') + '</div>' +
    field('推送词', `<input class="inp" id="pr-tpl" placeholder="留空 = 默认推送词" value="` +
      (r ? esc(r.messageTemplate || '') : '') + '">') +
    '<div class="field"><label class="field-label">附加动作</label><div class="chips">' +
      `<button type="button" class="chip rule-llm-toggle${r && r.llmTranslate ? ' on' : ''}" data-action="rule-llm-toggle"` +
      '><span class="chip-ic">' + icon('check') + '</span><span class="chip-txt">附译文（仅X帖）</span></button>' +
      '</div></div>' +
    '<div class="sheet-foot"><span id="rule-err" class="form-err"></span>' +
    '<button class="btn" data-action="close-sheet" data-level="1">取消</button>' +
    `<button class="btn btn-primary" data-action="save-push-rule" data-id="${r ? r.id : ''}">保存</button></div>`);
  applyRuleKind(ruleDraftKind);
}

// 内容形态联动：live 显示生效主播挑选，post 显示范围提示（账号勾选在图文页账号卡）
function applyRuleKind(kind) {
  ruleDraftKind = kind;
  const live = document.getElementById('pr-live-fields');
  const post = document.getElementById('pr-post-fields');
  if (live) live.classList.toggle('hidden', kind !== 'live');
  if (post) post.classList.toggle('hidden', kind !== 'post');
}

CHANGES['pr-kind-change'] = function (el) { applyRuleKind(el.value); };
ACTIONS['rule-llm-toggle'] = function (el) { el.classList.toggle('on'); };

// 渠道胶囊可勾可取消；停用渠道（.chip-dis）勾了也置灰划线提示「勾上也没用」，但状态照常切换
ACTIONS['rule-chip-toggle'] = function (el) { el.classList.toggle('on'); };

// ---- 二级 sheet：生效主播挑选（关注列表同款 pick-card 头像卡网格，无 UID）----
// 整卡可点切换勾选（选中 = 浅蓝底 + 蓝色内嵌描边）；搜索只按昵称过滤（隐藏不重渲染、保留勾选态）；
// 挑选即生效到内存草稿并实时同步一级表单的圆柱卡，点「完成」（或 × / 遮罩）关窗，保存规则时才落库。
// 全部不选 = 对全部主播生效（含未来新增）
function pickCountText() {
  return ruleDraftUids.size ? `已选 ${ruleDraftUids.size} 人` : '未选 · 生效全部主播';
}
function updatePickCount() {
  const el = document.querySelector('#sheet-mask2 .pick-count');
  if (el) el.textContent = pickCountText();
}

ACTIONS['open-rule-streamers'] = function () {
  api('/api/streamers').then(function (j) {
    const list = j.streamers || [];
    streamerCache = list; // 顺带刷新名称缓存（规则行标签/圆柱卡共用）
    const cards = list.map(function (s) {
      const nm = s.uname || String(s.uid);
      const on = ruleDraftUids.has(String(s.uid));
      return `<button type="button" class="follow-card pick-card${on ? ' on' : ''}" aria-pressed="${on}"` +
        ` data-action="pick-toggle" data-uid="${esc(String(s.uid))}" data-name="${esc(nm)}">` +
        avatarHtml(s.face, nm) + `<span class="f-name">${esc(nm)}</span></button>`;
    }).join('');
    openSheet('生效主播',
      '<div class="pick-head"><div class="search-box"><i>' + icon('search') + '</i>' +
        '<input class="inp" placeholder="搜索主播昵称" data-input="pick-q"></div>' +
        `<span class="pick-count">${pickCountText()}</span></div>` +
      (cards
        ? `<div class="pick-scroll"><div class="follow-grid">${cards}</div>` +
          '<div class="pick-empty" hidden>没有匹配的主播</div></div>'
        : '<p class="hint">监听名单为空</p>'),
      2,
      '<span class="sp"></span><button class="btn btn-primary" data-action="close-sheet" data-level="2">完成</button>');
  }).catch(function (e) { toast(e.message, true); });
};

ACTIONS['pick-toggle'] = function (el) {
  const uid = el.getAttribute('data-uid');
  const on = !ruleDraftUids.has(uid);
  if (on) ruleDraftUids.add(uid); else ruleDraftUids.delete(uid);
  el.classList.toggle('on', on);
  el.setAttribute('aria-pressed', String(on));
  updatePickCount();
  renderRuleUids(); // 弹窗后面规则表单里的圆柱卡实时同步
};

INPUTS['pick-q'] = function (el) {
  const q = el.value.trim();
  let visible = 0;
  document.querySelectorAll('#sheet-mask2 .pick-card').forEach(function (c) {
    const hit = !q || (c.getAttribute('data-name') || '').indexOf(q) >= 0;
    c.hidden = !hit;
    if (hit) visible++;
  });
  const empty = document.querySelector('#sheet-mask2 .pick-empty');
  if (empty) empty.hidden = visible > 0;
};

ACTIONS['save-push-rule'] = function (el) {
  const err = document.getElementById('rule-err');
  if (err) err.textContent = '';
  const name = document.getElementById('pr-name').value.trim();
  const catVal = document.getElementById('pr-cat').value;
  const existing = el.getAttribute('data-id') ? pushRuleById(Number(el.getAttribute('data-id'))) : null;
  // name 空则不提交该字段：POST 由后端自动补「规则 N」，PUT 保留原名（显式空串会 400）
  const body = {
    subjectKind: ruleDraftKind,
    categoryId: catVal === '' ? null : Number(catVal),
    // live：生效主播草稿；post：范围在图文页账号卡勾选（空 = 全部生效），这里原样保留
    scope: ruleDraftKind === 'live'
      ? Array.from(ruleDraftUids)
      : (existing ? (existing.scope || []) : []),
    channels: Array.prototype.slice.call(document.querySelectorAll('#sheet-mask1 .pr-ch'))
      .filter(function (x) { return x.classList.contains('on'); })
      .map(function (x) { return Number(x.getAttribute('data-chid')); }),
    messageTemplate: document.getElementById('pr-tpl').value.trim() || null,
    llmTranslate: !!document.querySelector('#sheet-mask1 .rule-llm-toggle.on'),
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
// 切到主播视图（推送规则卡已随直播设置搬入主播分页）→ 直接打开该规则的编辑弹窗（刷新缓存后开，规则已删则 toast 提示）
ACTIONS['goto-push-rule'] = function (el) {
  const rid = Number(el.getAttribute('data-rid'));
  closeSheet(1);
  const nav = document.querySelector('.nav-item[data-view="streamers"]');
  if (nav) nav.click();
  loadPush().then(function () { openPushRuleSheet(rid); });
};

// ---- 推送设置（推送渠道卡底部按钮）：直播推送 / 图文推送两组 ----
function pushBoolRow(id, text, on) {
  return checkRowHtml(`id="${id}"`, on, `<span class="row-title">${esc(text)}</span>`);
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
      '<div class="adv-group">直播推送</div>' +
      pushBoolRow('ps-b-first', '启动时已在播也推送', j.notifyOnFirstRun) +
      pushBoolRow('ps-b-newsub', '新增订阅在播即推送', j.notifyOnNewSubscription) +
      '<div class="adv-group">图文推送</div>' +
      pushBoolRow('ps-b-backlog', '补推未运行期间的图文', j.backlogPushEnabled) +
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
// 一次拉全（推送开关 / 渠道 / 规则 / 分类 / 主播）——这五张表任一被撤销都靠它拉回真实态；
// 登记为同一个函数，refreshTables 的去重保证只跑一次。
onTableRefresh(['settings', 'push_channels', 'push_rules', 'categories', 'streamers'], loadPush);
