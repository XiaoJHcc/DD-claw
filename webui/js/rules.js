// 面板前端 · 推送规则统一组件（直播开播 / 图文帖共用同一行渲染、同一规则弹窗、同一作用域语义）：
// 规则 = 内容形态（live/post）× 分类引用（空 = 任意内容）× 生效范围（空 = 全部生效，D1）
//        × 渠道 × 推送词 × 附加动作（附译文——仅图文规则显示，运行时只对 X 帖生效）。
// 主播页「推送规则」卡与图文页「图文规则」卡都从这里拿行 HTML（ruleRowHtml）与规则弹窗
//（openRuleSheet），两处卡片是同一组件、同一交互语言；账号浮窗的反向勾选（x.js）与主播卡
// 的规则标签（streamers.js）读同一份缓存数据。
// 数据一次拉全（规则/分类/渠道/主播 + 三平台账号），loadRuleCard() 带在途去重——两个页面的
// 刷新钩子同 tick 并发调用也只发一轮请求。规则写/删/启停成功后 notifyRulesChanged() 广播给
// 宿主注册的刷新钩子（push.js 重画渠道+规则卡与主播卡标签，x.js 重画图文页与账号浮窗）。
// 生效范围编辑两形态并排统一：live = 3D 圆柱卡 + 二级挑选弹窗（原交互保留）；post = 表单内
// 三平台账号挑选栅格（平台角标、账号墙同款卡样）。两形态都明示「全不选 = 全部生效」。
import { api, toast, ACTIONS, CHANGES, INPUTS, esc, gripHtml, checkDotHtml, iconBtn, field, openSheet, closeSheet, sheetCleanups, dropdownHtml, avatarHtml, ruleDeadReason } from './core.js';
import { icon } from './icons.js';

/** 占位措辞用一套通用文案（「附译文」运行时只对 X 帖生效） */
const RULE_TPL = '{author} 发了新帖';

/** 规则数据快照（两页共用；只经 loadRuleCard() 整体重拉，不做字段级写） */
const cache = { rules: [], categories: [], channels: [], streamers: [], accounts: { twitter: [], weibo: [], bili: [] } };
let loading = null;

/** 拉全量共享数据（在途去重：并发调用共享同一轮请求；落定后下一次调用重新拉） */
export function loadRuleCard() {
  if (loading) return loading;
  loading = Promise.all([
    api('/api/rules'), api('/api/categories'), api('/api/channels'), api('/api/streamers'),
    api('/api/x/accounts'), api('/api/weibo/accounts'), api('/api/bili/accounts'),
  ]).then(function (rs) {
    cache.rules = rs[0].rules || [];
    cache.categories = rs[1].categories || [];
    cache.channels = rs[2].channels || [];
    cache.streamers = rs[3].streamers || [];
    cache.accounts = {
      twitter: rs[4].accounts || [], weibo: rs[5].accounts || [], bili: rs[6].accounts || [],
    };
    loading = null;
    return cache;
  }, function (e) { loading = null; throw e; });
  return loading;
}

export function getRuleCardData() { return cache; }

// ---- 规则变更广播：宿主（push.js / x.js）注册自己的重画逻辑；分类卡改分类后也走这里 ----
const changedHooks = [];
export function onRulesChanged(fn) { if (changedHooks.indexOf(fn) < 0) changedHooks.push(fn); }
export function notifyRulesChanged() {
  for (let i = 0; i < changedHooks.length; i++) {
    try { changedHooks[i](); } catch (e) { /* 单个宿主刷新失败不影响其余 */ }
  }
}

// ---- 查表小件 ----
function catById(id) {
  for (let i = 0; i < cache.categories.length; i++) if (cache.categories[i].id === id) return cache.categories[i];
  return null;
}
export function catName(id) {
  if (id == null) return '任意内容';
  const c = catById(id);
  return c ? c.name : '分类已删除';
}
function channelById(id) {
  for (let i = 0; i < cache.channels.length; i++) if (String(cache.channels[i].id) === String(id)) return cache.channels[i];
  return null;
}
export function channelName(id) {
  const c = channelById(id);
  return c ? c.name : '渠道 ' + id;
}
// 规则行/圆柱卡的主播名是空间受限场景：简称（alias）优先、回退原名
function streamerName(uid) {
  for (let i = 0; i < cache.streamers.length; i++) {
    if (String(cache.streamers[i].uid) === String(uid)) {
      const s = cache.streamers[i];
      return s.alias || s.uname || String(uid);
    }
  }
  return 'UID ' + uid;
}

// ---- 账号（三平台混排）：引用格式 = A.2 钉死的 `twitter:screenName` / `weibo:uid` / `bili:uid` ----
/** 账号 → 规则 scope 引用 */
export function accountRef(platform, a) {
  return (platform === 'weibo' ? 'weibo:' : platform === 'bili' ? 'bili:' : 'twitter:') +
    (platform === 'twitter' ? a.screenName : a.uid);
}
export function accountName(platform, a) {
  return a.displayName || a.nickname || a.uname ||
    (platform === 'twitter' ? '@' + a.screenName : platform === 'weibo' ? '微博 ' + a.uid : 'UID ' + a.uid);
}
// 头像链与账号卡同一条：平台本地缓存 → 关联主播的 B站头像 → 首字占位圆
function accountFace(platform, a) {
  if (platform === 'twitter') return a.avatar ? '/api/x-avatar?file=' + encodeURIComponent(a.avatar) : (a.biliFace || '');
  if (platform === 'weibo') return a.avatar ? '/api/weibo-avatar?file=' + encodeURIComponent(a.avatar) : (a.biliFace || '');
  return a.avatar ? '/api/bili-avatar?file=' + encodeURIComponent(a.avatar) : '';
}
/** scope 引用 → 人话标签（账号已不在名单时回退可读形式，不静默吞） */
export function accountLabel(ref) {
  const i = String(ref).indexOf(':');
  const kind = i > 0 ? ref.slice(0, i) : '';
  const key = i > 0 ? ref.slice(i + 1) : String(ref);
  const list = kind === 'weibo' ? cache.accounts.weibo : kind === 'bili' ? cache.accounts.bili : cache.accounts.twitter;
  for (let n = 0; n < list.length; n++) {
    const a = list[n];
    if (kind === 'twitter' ? a.screenName === key : String(a.uid) === key) return accountName(kind, a);
  }
  return kind === 'twitter' ? '@' + key : ref;
}
/** 三平台全部账号引用（作用域具体化 / 反向勾选的全集） */
export function allAccountRefs() {
  const out = [];
  cache.accounts.twitter.forEach(function (a) { out.push(accountRef('twitter', a)); });
  cache.accounts.weibo.forEach(function (a) { out.push(accountRef('weibo', a)); });
  cache.accounts.bili.forEach(function (a) { out.push(accountRef('bili', a)); });
  return out;
}

// ---- 规则可达性 / 摘要（两形态统一；不可达 = 整行置灰划线 + 副行只留原因） ----
export function deadReason(r) {
  const reason = ruleDeadReason(r, cache.categories, cache.channels);
  if (reason) return reason;
  return null;
}
/** 生效范围摘要：空 = 全部生效（D1），非空 = 逐个列名字（副行截断由 CSS 管） */
export function scopeSummary(r) {
  const s = r.scope || [];
  if (s.length === 0) return r.subjectKind === 'post' ? '全部账号' : '全部主播';
  if (r.subjectKind === 'post') {
    return '已选 ' + s.length + ' 个账号：' + s.map(accountLabel).join('、');
  }
  return '已选 ' + s.length + ' 位主播：' + s.map(streamerName).join('、');
}
/** 规则副行：不可达 = 原因；可达 = 分类 · 生效范围 · 渠道（· 译文） */
export function ruleSub(r) {
  const dead = deadReason(r);
  if (dead) return dead;
  return catName(r.categoryId) + ' · ' + scopeSummary(r) +
    ' · ' + ((r.channels || []).length ? r.channels.map(channelName).join('、') : '未选渠道') +
    (r.llmTranslate ? ' · 译文' : '');
}
/** 该账号视角下规则是否生效（D1：空 scope = 全部账号生效） */
export function ruleAppliesTo(r, ref) {
  const s = r.scope || [];
  return s.length === 0 || s.indexOf(ref) >= 0;
}
/** 生效范围语义的人话 title（账号浮窗勾选行 / 主播卡标签共用）：空 = 全部生效（D1） */
export function scopeTitle(scope, noun) {
  return !scope || scope.length === 0
    ? `该规则对全部${noun}生效`
    : `仅按生效范围限定的${noun}生效（当前主体在范围内）`;
}

// ---- 规则行（两张规则卡共用；.row-2 双行档：主行名称 + 副行「分类 · 范围 · 渠道」） ----
// opts.showKindTag：混排卡（主播页）给图文规则补一枚「图文」标签——直播行不打标（卡面主语境）；
// 图文页卡全是图文规则，不打标。不可达行副行只留原因（.rule-dead CSS 置灰划线）。
export function ruleRowHtml(r, opts) {
  const o = opts || {};
  const dead = deadReason(r);
  const kindTag = o.showKindTag && r.subjectKind === 'post' ? '<span class="tag tag-purple">图文</span>' : '';
  return `<div class="row row-2${dead ? ' rule-dead' : ''}" data-sid="${r.id}">` +
    gripHtml() +
    checkDotHtml('data-change="toggle-rule"', r.enabled) +
    '<span class="row-main"><span class="row-line">' +
    `<span class="row-title">${esc(r.name)}</span>` + kindTag + '</span>' +
    `<span class="row-sub">${esc(ruleSub(r))}</span></span>` +
    '<span class="row-end">' +
    iconBtn('edit-rule', 'pencil', '编辑') +
    iconBtn('del-rule', 'trash', '删除', true) +
    '</span></div>';
}

// ---- 规则弹窗（live/post 同一张；内容形态由入口定死：主播页新增 = 直播、图文页新增 = 图文、 ----
// ---- 编辑 = 规则自身的 subject_kind，不再给「换形态」入口——两形态 scope 引用域不同，换形态 ----
// ---- 等于换规则）。字段序 = 名称 / 分类（按形态过滤，停用置灰）/ 生效范围 / 渠道 / 推送词 / ----
// ---- 附加动作（仅图文）。保存报错内联在按钮行。 ----
let ruleSheet = null; // { id, kind, level, liveScope: Set<uid>, postScope: string[] }

function maskVisible(level) {
  const m = document.getElementById('sheet-mask' + level);
  return !!m && !m.classList.contains('hidden');
}

/** 分类下拉选项：按内容形态过滤（停用 off 置灰）；历史坏数据（分类形态不符）保留为划线项可见 */
function catOptionsFor(kind, selectedId) {
  const opts = [{ value: '', label: '任意内容' }];
  for (let i = 0; i < cache.categories.length; i++) {
    const c = cache.categories[i];
    if ((c.appliesTo || 'live') === kind) {
      opts.push({ value: c.id, label: c.name, off: c.enabled === false });
    } else if (c.id === selectedId) {
      opts.push({ value: c.id, label: c.name + '（内容形态不符）', off: true });
    }
  }
  return opts;
}

// ---- 生效主播 3D 圆柱卡（形态照搬 v2：头像按圆柱面投影位置排布、正对观察者不随柱面旋转、
// 只渲染正面可见弧 ±65°、两侧减半缩放、布局恒定单排最多 11 枚）----
// 未选（全部主播）= 同一排布循环补位铺满可见弧 + 正中盖「全部主播」；已选 = 按草稿序从正中向两侧排开
const CYL = { r: 240, ava: 46, gap: 2, thetaMax: 65, max: 11 };
CYL.step = 2 * Math.asin((CYL.ava + CYL.gap) / (2 * CYL.r)) * 180 / Math.PI; // ≈11.5°（弦长 = 头像 46 + 缝 2）

// 草稿 uid → 主播对象；已移出监听名单的 uid 给占位（同旧版摘要的「UID xxx」，不静默丢弃）
function streamerOf(uid) {
  for (let i = 0; i < cache.streamers.length; i++) {
    if (String(cache.streamers[i].uid) === String(uid)) return cache.streamers[i];
  }
  return { uid: uid, uname: 'UID ' + uid, face: null };
}

function cylCardHtml() {
  const all = cache.streamers;
  const isAll = ruleSheet.liveScope.size === 0;
  const list = isAll
    ? (all.length ? Array.from({ length: CYL.max }, function (_, i) { return all[i % all.length]; }) : [])
    : Array.from(ruleSheet.liveScope).slice(0, CYL.max).map(streamerOf);
  const items = list.map(function (s, i) {
    const a = (i - (list.length - 1) / 2) * CYL.step;
    const f = 1 - 0.55 * Math.pow(Math.abs(a) / CYL.thetaMax, 2); // 两侧减半：弧端缩至 ≈0.45
    const x = (CYL.r * Math.sin(a * Math.PI / 180)).toFixed(2);
    const z = (CYL.r * Math.cos(a * Math.PI / 180)).toFixed(2);
    return `<span class="cyl-item" data-uid="${esc(String(s.uid))}" style="transform:translate3d(${x}px,0,${z}px) scale3d(${f.toFixed(3)},${f.toFixed(3)},1)">${avatarHtml(s.face, s.uname)}</span>`;
  }).join('');
  return `<button type="button" class="cyl-card" data-action="open-rule-scope" aria-label="` +
    (isAll ? '全部主播' : `已选 ${ruleSheet.liveScope.size} 人`) + '，点击挑选">' +
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

// ---- 生效账号（post 形态）：表单内挑选栅格——三平台混排 + 平台角标，卡样同账号墙（头像 +
// 名字 + 角标）。首枚「全部账号」胶囊 = 清空 scope（D1 空即全部生效），与逐卡勾选互斥联动；
// scope 里已不在名单的失效引用保留成可点移除的灰 chip（不静默丢范围，保存时后端也会拦）。
const PICK_PLATS = [
  { key: 'twitter', label: 'X', cls: 'x-plat-x' },
  { key: 'weibo', label: '微博', cls: 'x-plat-weibo' },
  { key: 'bili', label: 'B站', cls: 'x-plat-bili' },
];

function acctPickHtml() {
  const refs = ruleSheet.postScope;
  const known = new Set(allAccountRefs());
  let html = '<div class="chips">' +
    `<button type="button" class="chip${refs.length === 0 ? ' on' : ''}" data-action="rule-acct-all"` +
    '><span class="chip-ic">' + icon('check') + '</span>' +
    '<span class="chip-txt">全部账号（不选 = 全部生效）</span></button></div>';
  let cards = '';
  for (let p = 0; p < PICK_PLATS.length; p++) {
    const plat = PICK_PLATS[p];
    const list = cache.accounts[plat.key];
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const ref = accountRef(plat.key, a);
      const on = refs.indexOf(ref) >= 0;
      cards += `<button type="button" class="pick-card acct-card${on ? ' on' : ''}" aria-pressed="${on}"` +
        ` data-action="rule-acct-toggle" data-ref="${esc(ref)}" title="${esc(ref)}">` +
        avatarHtml(accountFace(plat.key, a), accountName(plat.key, a)) +
        `<span class="x-plat ${plat.cls}">${plat.label}</span>` +
        `<span class="f-name">${esc(accountName(plat.key, a))}</span></button>`;
    }
  }
  for (let n = 0; n < refs.length; n++) {
    if (known.has(refs[n])) continue;
    cards += `<button type="button" class="chip chip-dis" data-action="rule-acct-toggle"` +
      ` data-ref="${esc(refs[n])}" title="该账号已不在名单里：保存会被后端拒绝，点击移除">` +
      `<span class="chip-txt">${esc(refs[n])}</span>${icon('xmark')}</button>`;
  }
  return html + `<div class="acct-pick">${cards || '<span class="hint">名单为空</span>'}</div>`;
}

function renderAcctPick() {
  const box = document.getElementById('pr-accts');
  if (box) box.innerHTML = acctPickHtml();
}

export function openRuleSheet(r, opts) {
  const o = opts || {};
  const level = o.level || 1;
  const kind = r ? (r.subjectKind || 'live') : (o.kind || 'live');
  ruleSheet = {
    id: r ? r.id : null,
    kind: kind,
    level: level,
    liveScope: new Set(kind === 'live' && r ? (r.scope || []).map(String) : []),
    postScope: kind === 'post' && r ? (r.scope || []).slice() : [],
  };
  // 渠道 = 胶囊并排多选（.chips）：已选 .on；停用渠道 .chip-dis（更浅灰 + 贯穿删除线，
  // 保留勾选状态仍可切换，title 提示勾上也不生效）
  const chips = cache.channels.length === 0
    ? ''
    : cache.channels.map(function (c) {
        const on = !!(r && (r.channels || []).indexOf(c.id) >= 0);
        const dis = !c.enabled;
        return `<button type="button" class="chip pr-ch${on ? ' on' : ''}${dis ? ' chip-dis' : ''}"` +
          ` data-action="rule-chip-toggle" data-chid="${c.id}"` +
          (dis ? ' title="该渠道已停用：勾选不会生效"' : '') +
          `><span class="chip-ic">${icon('check')}</span><span class="chip-txt">${esc(c.name)}</span></button>`;
      }).join('');
  openSheet(r ? '编辑规则' : '添加规则',
    field('名称', `<input class="inp" id="pr-name" placeholder="留空自动命名" value="${r ? esc(r.name) : ''}">`) +
    field('分类', dropdownHtml('pr-cat', catOptionsFor(kind, r ? r.categoryId : null), r ? r.categoryId : '')) +
    `<div class="field" id="pr-live-fields"><label class="field-label">生效主播</label>${cylCardHtml()}` +
      '<span class="hint">全部不选 = 对全部主播生效（含未来新增）；点击圆柱卡挑选</span></div>' +
    `<div class="field hidden" id="pr-post-fields"><label class="field-label">生效账号</label>` +
      `<div id="pr-accts">${acctPickHtml()}</div>` +
      '<span class="hint">全部不选 = 对全部账号生效（含未来新增）；也可在「图文」页账号卡上反向勾选</span></div>' +
    '<div class="field"><label class="field-label">渠道</label>' +
      (chips ? `<div class="chips">${chips}</div>` : '<span class="hint">还没有渠道</span>') + '</div>' +
    field('推送词', `<input class="inp" id="pr-tpl" placeholder="留空 = 默认推送词" value="` +
      (r && r.messageTemplate ? esc(r.messageTemplate) : '') + '">' +
      `<span class="row-sub hidden" id="pr-tpl-vars">可用变量：{author} {text} {url} {liver}</span>`) +
    `<div class="field" id="pr-translate"><label class="field-label">附加动作</label><div class="chips">` +
      `<button type="button" class="chip rule-llm-toggle${r && r.llmTranslate ? ' on' : ''}" data-action="rule-llm-toggle"` +
      '><span class="chip-ic">' + icon('check') + '</span><span class="chip-txt">附译文（仅X帖）</span></button>' +
      '</div></div>' +
    '<div class="sheet-foot">' +
    (r ? `<button class="btn" data-action="del-rule" data-id="${r.id}">删除</button>` : '') +
    '<span class="sp"></span>' +
    `<span id="rule-err" class="form-err"></span>` +
    `<button class="btn" data-action="close-sheet" data-level="${level}">取消</button>` +
    `<button class="btn btn-primary" data-action="save-rule" data-id="${r ? r.id : ''}">保存</button></div>`);
  applyRuleSheetKind(kind);
  sheetCleanups[level] = function () { ruleSheet = null; };
}

// 形态联动：live = 圆柱卡 + 主播范围提示；post = 账号挑选栅格 + 附译文（仅 X）；推送词变量提示仅图文
function applyRuleSheetKind(kind) {
  const live = document.getElementById('pr-live-fields');
  const post = document.getElementById('pr-post-fields');
  if (live) live.classList.toggle('hidden', kind !== 'live');
  if (post) post.classList.toggle('hidden', kind !== 'post');
  const tr = document.getElementById('pr-translate');
  if (tr) tr.classList.toggle('hidden', kind !== 'post');
  const tpl = document.getElementById('pr-tpl');
  if (tpl) tpl.placeholder = kind === 'post' ? `留空 = 默认（${RULE_TPL}）` : '留空 = 默认推送词';
  const vars = document.getElementById('pr-tpl-vars');
  if (vars) vars.classList.toggle('hidden', kind !== 'post');
}

ACTIONS['rule-chip-toggle'] = function (el) { el.classList.toggle('on'); };
ACTIONS['rule-llm-toggle'] = function (el) { el.classList.toggle('on'); };
ACTIONS['rule-acct-toggle'] = function (el) {
  if (!ruleSheet) return;
  const ref = el.getAttribute('data-ref');
  const i = ruleSheet.postScope.indexOf(ref);
  if (i >= 0) ruleSheet.postScope.splice(i, 1); else ruleSheet.postScope.push(ref);
  renderAcctPick();
};
ACTIONS['rule-acct-all'] = function () {
  if (!ruleSheet) return;
  ruleSheet.postScope = [];
  renderAcctPick();
};

// ---- 二级 sheet：生效主播挑选（关注列表同款 pick-card 头像卡网格，无 UID）----
// 整卡可点切换勾选（选中 = 浅蓝底 + 蓝色内嵌描边）；搜索只按昵称过滤（隐藏不重渲染、保留勾选态）；
// 挑选即生效到内存草稿并实时同步一级表单的圆柱卡，点「完成」（或 × / 遮罩）关窗，保存规则时才落库。
// 全部不选 = 对全部主播生效（含未来新增）
function pickCountText() {
  return ruleSheet && ruleSheet.liveScope.size ? `已选 ${ruleSheet.liveScope.size} 人` : '未选 · 生效全部主播';
}
function updatePickCount() {
  const el = document.querySelector('#sheet-mask2 .pick-count');
  if (el) el.textContent = pickCountText();
}

ACTIONS['open-rule-scope'] = function () {
  api('/api/streamers').then(function (j) {
    const list = j.streamers || [];
    cache.streamers = list; // 顺带刷新名称缓存（规则行标签/圆柱卡共用）
    const cards = list.map(function (s) {
      const nm = s.uname || String(s.uid);
      const on = ruleSheet && ruleSheet.liveScope.has(String(s.uid));
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
  if (!ruleSheet) return;
  const uid = el.getAttribute('data-uid');
  const on = !ruleSheet.liveScope.has(uid);
  if (on) ruleSheet.liveScope.add(uid); else ruleSheet.liveScope.delete(uid);
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

// ---- 行内入口（两张卡的编辑/删除/启停统一走这里；账号浮窗的整行点击也复用 edit-rule） ----
function ruleById(id) {
  for (let i = 0; i < cache.rules.length; i++) if (String(cache.rules[i].id) === String(id)) return cache.rules[i];
  return null;
}

ACTIONS['edit-rule'] = function (el, e) {
  // 整行可点打开编辑（账号浮窗的选用规则行）；行内勾选点/删除钮有自己的语义不触发
  //（编辑铅笔 icon 本身例外——它就是入口）
  if (!el.classList.contains('icon-btn') && e && e.target instanceof Element && e.target.closest('label, button')) return;
  const row = el.closest('.row');
  if (!row) return;
  const r = ruleById(row.getAttribute('data-sid'));
  if (!r) { toast('规则数据未加载', true); return; }
  openRuleSheet(r, { level: maskVisible(1) ? 2 : 1 });
};

ACTIONS['del-rule'] = function (el) {
  // 行内删除钮走 .row；弹窗底部删除走 data-id（删完顺手关掉弹窗）
  const row = el.closest('.row');
  const idAttr = el.getAttribute('data-id');
  const r = row ? ruleById(row.getAttribute('data-sid')) : idAttr ? ruleById(idAttr) : null;
  if (!r) return;
  if (!confirm('删除规则「' + r.name + '」？')) return;
  const fromSheet = !!idAttr && !row;
  const level = ruleSheet ? ruleSheet.level : 1;
  api('/api/rules/' + r.id, 'DELETE')
    .then(function () {
      if (fromSheet) closeSheet(level);
      toast('已删除');
      notifyRulesChanged();
    })
    .catch(function (e) { toast(e.message, true); });
};

CHANGES['toggle-rule'] = function (el) {
  const id = el.closest('.row').getAttribute('data-sid');
  const on = el.checked;
  api('/api/rules/' + id, 'PUT', { enabled: on })
    .then(function () { toast(on ? '已启用' : '已停用'); notifyRulesChanged(); })
    .catch(function (e) { toast(e.message, true); notifyRulesChanged(); });
};

ACTIONS['save-rule'] = function (el) {
  if (!ruleSheet) return;
  const err = document.getElementById('rule-err');
  if (err) err.textContent = '';
  const sheet = ruleSheet; // closeSheet 会清空草稿，先钉住本次保存的上下文
  const name = document.getElementById('pr-name').value.trim();
  const catVal = document.getElementById('pr-cat').value;
  // name 空则不提交该字段：POST 由后端自动补「规则 N」，PUT 保留原名（显式空串会 400）
  const body = {
    subjectKind: sheet.kind,
    categoryId: catVal === '' ? null : Number(catVal),
    scope: sheet.kind === 'live' ? Array.from(sheet.liveScope) : sheet.postScope.slice(),
    channels: Array.prototype.slice.call(document.querySelectorAll('#sheet-mask' + sheet.level + ' .pr-ch'))
      .filter(function (x) { return x.classList.contains('on'); })
      .map(function (x) { return Number(x.getAttribute('data-chid')); }),
    messageTemplate: document.getElementById('pr-tpl').value.trim() || null,
  };
  if (sheet.kind === 'post') {
    body.llmTranslate = !!document.querySelector('#sheet-mask' + sheet.level + ' .rule-llm-toggle.on');
  }
  if (name) body.name = name;
  const idAttr = el.getAttribute('data-id');
  const req = idAttr
    ? api('/api/rules/' + idAttr, 'PUT', body)
    : api('/api/rules', 'POST', body);
  req.then(function () {
    closeSheet(sheet.level);
    toast(idAttr ? '已保存' : '已添加');
    notifyRulesChanged();
  }).catch(function (e) { if (err) err.textContent = e.message; });
};
