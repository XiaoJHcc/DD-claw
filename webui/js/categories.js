// 面板前端 · 卡片「分类规则」：分类列表（拖拽把手/启停勾/名称/条件摘要标签/编辑/删除）
// + 底部新增按钮。分类 = LLM 提示词 + 确定性条件组，归类结果供推送规则引用。
// 新增/编辑走一级 sheet，保存报错内联在按钮行；删除分类会级联停用引用它的推送规则（先 confirm 告知）。
// **直播与图文同一组件**（P3 统一）：分类卡只出现在主播页这一处，但行渲染（摘要标签 =
// LLM / 关键词 / 分区 / 帖子类型 / 引用 / 带图，同一套 tag 语言）与编辑弹窗都按 appliesTo
// 驱动——适用内容切换时只换「确定性条件」算子区（live = 关键词+分区；post = 关键词 +
// 原创·转发 chips + 须引用 + 须带图），LLM 提示词 / 名称 / 启停 / 拖拽排序 / 删除级联确认共用。
// 摘要标签格式两形态统一：LLM（有提示词）+ 条件摘要（关键词 N / 分区 N / 只原·只转 / 须引用 / 须带图）。
import { api, toast, ACTIONS, CHANGES, esc, gripHtml, checkDotHtml, iconBtn, field, makeSortable, openSheet, closeSheet, splitCsv, dropdownHtml, onTableRefresh } from './core.js';
import { notifyRulesChanged } from './rules.js';

let catCache = [];

function catById(id) {
  for (let i = 0; i < catCache.length; i++) if (catCache[i].id === id) return catCache[i];
  return null;
}

// 摘要标签（两形态统一的 tag 语言）：LLM 紫 / 关键词蓝 / 分区·帖子形态·引用·带图 mint
function catSummaryTags(c) {
  let tags = '';
  if (c.appliesTo === 'post') tags += '<span class="tag tag-purple">图文</span>';
  if (c.llmPrompt) tags += '<span class="tag tag-purple">LLM</span>';
  if (c.keywords.length) tags += `<span class="tag tag-blue">关键词 ${c.keywords.length}</span>`;
  if (c.appliesTo !== 'post' && c.areas.length) tags += `<span class="tag tag-mint">分区 ${c.areas.length}</span>`;
  if (c.appliesTo === 'post') {
    const pts = (c.postTypes || []);
    if (pts.length && pts.length < 2) tags += `<span class="tag tag-mint">${pts[0] === 'retweet' ? '只转' : '只原'}</span>`;
    if (c.requireQuote) tags += '<span class="tag tag-mint">须引用</span>';
    if (c.requireMedia) tags += '<span class="tag tag-mint">须带图</span>';
  }
  return tags;
}

function categoryRowHtml(c) {
  return `<div class="row" data-sid="${c.id}">` +
    gripHtml() +
    checkDotHtml('data-change="toggle-category"', c.enabled) +
    '<span class="row-main"><span class="row-line">' +
    `<span class="row-title">${esc(c.name)}</span>` +
    catSummaryTags(c) +
    '</span></span>' +
    '<span class="row-end">' +
    iconBtn('edit-category', 'pencil', '编辑') +
    iconBtn('del-category', 'trash', '删除', true) +
    '</span></div>';
}

function loadCategories() {
  return api('/api/categories').then(function (j) {
    catCache = j.categories || [];
    document.getElementById('category-list').innerHTML = catCache.map(categoryRowHtml).join('');
  }).catch(function (e) { toast(e.message, true); });
}

CHANGES['toggle-category'] = function (el) {
  const id = el.closest('.row').getAttribute('data-sid');
  const on = el.checked;
  api('/api/categories/' + id, 'PUT', { enabled: on })
    .then(function () {
      toast(on ? '已启用' : '已停用');
      notifyRulesChanged(); // 引用规则的「分类已停用」划线态（两张规则卡 + 主播卡标签一起刷）
    })
    .catch(function (e) { toast(e.message, true); loadCategories(); });
};

ACTIONS['del-category'] = function (el) {
  const id = Number(el.closest('.row').getAttribute('data-sid'));
  const c = catById(id);
  // 先查引用：有启用中的引用规则时 confirm 里告知会被级联停用
  api('/api/rules').then(function (j) {
    const refs = (j.rules || []).filter(function (r) { return r.categoryId === id && r.enabled; });
    let msg = '删除分类「' + (c ? c.name : id) + '」？';
    if (refs.length > 0) msg += '将同时停用 ' + refs.length + ' 条引用它的推送规则。';
    if (!confirm(msg)) return;
    api('/api/categories/' + id, 'DELETE').then(function (res) {
      toast(res.disabledRules > 0 ? '已删除，并停用 ' + res.disabledRules + ' 条引用规则' : '已删除');
      loadCategories();
      notifyRulesChanged(); // 规则卡的分类名标签 + 主播卡标签一起刷
    }).catch(function (e) { toast(e.message, true); });
  }).catch(function (e) { toast(e.message, true); });
};

// ---- 分类 新增/编辑 弹窗（id=null 新增）；保存报错内联在按钮行 ----
ACTIONS['add-category'] = function () { openCategorySheet(null); };
ACTIONS['edit-category'] = function (el) {
  openCategorySheet(Number(el.closest('.row').getAttribute('data-sid')));
};

// 分类表单草稿：适用内容切换时条件区整体重建，值从 DOM 收进草稿再重渲（不丢已填内容）
let catDraft = null;

function captureCatDraft() {
  if (!catDraft) return;
  const kw = document.getElementById('cg-kw');
  const area = document.getElementById('cg-area');
  const cond = document.getElementById('cg-cond');
  if (kw) catDraft.keywords = kw.value;
  if (area) catDraft.areas = area.value;
  if (cond) catDraft.condMode = cond.getAttribute('data-mode') || 'and';
  const pts = Array.prototype.slice.call(document.querySelectorAll('#cg-cond-area .cg-pt'))
    .filter(function (x) { return x.classList.contains('on'); })
    .map(function (x) { return x.getAttribute('data-value'); });
  if (pts.length || document.querySelector('#cg-cond-area .cg-pt')) catDraft.postTypes = pts;
  const q = document.querySelector('#cg-cond-area .cg-flag[data-value="requireQuote"]');
  const m = document.querySelector('#cg-cond-area .cg-flag[data-value="requireMedia"]');
  if (q) catDraft.requireQuote = q.classList.contains('on');
  if (m) catDraft.requireMedia = m.classList.contains('on');
}

function openCategorySheet(id) {
  const c = id === null ? null : catById(id);
  if (id !== null && !c) { toast('分类数据未加载', true); return; }
  catDraft = {
    kind: c ? (c.appliesTo || 'live') : 'live',
    keywords: c ? c.keywords.join(', ') : '',
    areas: c ? c.areas.join(', ') : '',
    condMode: c ? (c.condMode || 'and') : 'and',
    postTypes: c ? (c.postTypes || []).slice() : [],
    requireQuote: !!(c && c.requireQuote),
    requireMedia: !!(c && c.requireMedia),
  };
  openSheet(c ? '编辑分类' : '新增分类',
    field('适用内容', dropdownHtml('cg-kind', [
      { value: 'live', label: '直播（开播场次）' },
      { value: 'post', label: '图文帖（X/微博/B站动态）' },
    ], catDraft.kind, 'cg-kind-change')) +
    field('名称', `<input class="inp" id="cg-name" placeholder="如：歌回；留空自动命名" value="` +
      (c ? esc(c.name) : '') + '">') +
    field('LLM 提示词', '<textarea class="inp" id="cg-prompt" rows="4" placeholder="留空 = 不使用 LLM 判定（只走下面的确定性条件）">' +
      (c && c.llmPrompt ? esc(c.llmPrompt) : '') + '</textarea>') +
    // 确定性条件区：按适用内容渲染可用算子（同一组件、同一交互语言）
    `<div class="field" id="cg-cond-area">${condAreaHtml()}</div>` +
    '<div class="sheet-foot"><span id="category-err" class="form-err"></span>' +
    '<button class="btn" data-action="close-sheet" data-level="1">取消</button>' +
    `<button class="btn btn-primary" data-action="save-category" data-id="${c ? c.id : ''}">保存</button></div>`);
  // 草稿关闭清理：下次打开是全新草稿
  // （sheetCleanups 不导出到本模块，openSheet/closeSheet 的 innerHTML 重置已足够）
}

// 条件区（live：关键词 + 且/或 + 分区；post：关键词 + 且/或 + 原创/转发/须引用/须带图 chips）。
// 中间小方钮切换两组条件的关系（且/或）；当前值在按钮 data-mode 上。
function condAreaHtml() {
  const d = catDraft;
  const toggle = `<button class="cond-toggle" id="cg-cond" data-action="toggle-cond" data-mode="${d.condMode}"` +
    ' title="各组条件的关系，点击切换 且/或">' + (d.condMode === 'or' ? '或' : '且') + '</button>';
  const kw = `<input class="inp" id="cg-kw" placeholder="关键词，中英文逗号分隔" value="${esc(d.keywords)}">`;
  if (d.kind === 'live') {
    return '<label class="field-label">确定性条件</label><div class="cond-row">' +
      kw + toggle +
      `<input class="inp" id="cg-area" placeholder="分区，中英文逗号分隔" value="${esc(d.areas)}">` +
      '</div>' +
      '<div class="hint" style="margin-top:6px">关键词与分区两组条件留空且无 LLM 提示词 = 死分类（保存时拒绝）</div>';
  }
  const chip = function (value, label, on) {
    return `<button type="button" class="chip ${value === 'original' || value === 'retweet' ? 'cg-pt' : 'cg-flag'}${on ? ' on' : ''}"` +
      ` data-action="cg-post-type" data-value="${value}"><span class="chip-ic">✓</span>` +
      `<span class="chip-txt">${esc(label)}</span></button>`;
  };
  return '<label class="field-label">确定性条件</label><div class="cond-row">' +
    kw + toggle + '</div>' +
    '<div class="chips" style="margin-top:8px">' +
    chip('original', '原创', d.postTypes.indexOf('original') >= 0) +
    chip('retweet', '转发', d.postTypes.indexOf('retweet') >= 0) +
    chip('requireQuote', '须引用（仅X）', d.requireQuote) +
    chip('requireMedia', '须带图', d.requireMedia) +
    '</div>' +
    '<div class="hint" style="margin-top:6px">帖子类型都不勾 = 不限；条件留空且无 LLM 提示词 = 死分类（保存时拒绝）</div>';
}

// 适用内容联动：live ↔ post 切换时先把 DOM 值收进草稿，再整体重建条件区（已填关键词不丢）
CHANGES['cg-kind-change'] = function (el) {
  if (!catDraft) return;
  captureCatDraft();
  catDraft.kind = el.value;
  const box = document.getElementById('cg-cond-area');
  if (box) box.innerHTML = condAreaHtml();
};
ACTIONS['cg-post-type'] = function (el) { el.classList.toggle('on'); };

ACTIONS['toggle-cond'] = function (el) {
  const or = el.getAttribute('data-mode') !== 'or';
  el.setAttribute('data-mode', or ? 'or' : 'and');
  el.textContent = or ? '或' : '且';
};

ACTIONS['save-category'] = function (el) {
  const err = document.getElementById('category-err');
  if (err) err.textContent = '';
  const prompt = document.getElementById('cg-prompt').value.trim();
  const name = document.getElementById('cg-name').value.trim();
  captureCatDraft();
  const isPost = catDraft.kind === 'post';
  // name 空则不提交该字段：POST 由后端自动补「分类 N」，PUT 保留原名（显式空串会 400）
  const body = {
    appliesTo: catDraft.kind,
    llmPrompt: prompt || null,
    keywords: splitCsv(catDraft.keywords),
    areas: isPost ? [] : splitCsv(catDraft.areas),
    postTypes: isPost ? catDraft.postTypes : [],
    requireQuote: isPost && catDraft.requireQuote,
    requireMedia: isPost && catDraft.requireMedia,
    condMode: catDraft.condMode || 'and',
  };
  if (name) body.name = name;
  const idAttr = el.getAttribute('data-id');
  const req = idAttr
    ? api('/api/categories/' + idAttr, 'PUT', body)
    : api('/api/categories', 'POST', body);
  req.then(function () {
    closeSheet(1);
    toast(idAttr ? '已保存' : '已新增');
    loadCategories();
    notifyRulesChanged(); // 推送卡规则区的分类名标签 + 死态（两张规则卡一起刷）
  }).catch(function (e) { if (err) err.textContent = e.message; });
};

// 拖拽排序：分类展示顺序落库
makeSortable(document.getElementById('category-list'), {
  items: function () { return catCache; },
  getId: function (c) { return c.id; },
  onOrder: function (ids) {
    api('/api/categories/order', 'PUT', { ids: ids })
      .then(loadCategories)
      .catch(function (err) { toast(err.message, true); loadCategories(); });
  },
});

loadCategories();
// 分类行（关键词 / 分区 / 判定方式 / 停用）在 categories 表——撤销后重拉本卡；
// 规则卡对分类的引用快照由 rules.js 的共享缓存负责（notifyRulesChanged 广播刷新）
onTableRefresh(['categories'], loadCategories);
