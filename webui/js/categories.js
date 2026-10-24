// 面板前端 · 卡片「分类规则」：分类列表（拖拽把手/启停勾/名称/条件摘要标签/编辑/删除）
// + 底部新增按钮。分类 = 判定描述（同时喂 LLM 与决策模型）+ 确定性条件组 + 是否进主分类组，
// 归类结果供推送规则引用。
// 新增/编辑走一级 sheet，保存报错内联在按钮行；删除分类会级联停用引用它的推送规则（先 confirm 告知）。
// 表单草稿 → 提交体由 catSheetBody() 统一构造（保存与测试共用）；弹窗底部的测试区见 category-test.js。
// 摘要标签格式两形态统一：主分类（进主分类组）+ 模型（有判定描述）+ 条件摘要（关键词 N / 分区 N / 只原·只转 / 须引用 / 须带图）。
import { api, toast, ACTIONS, CHANGES, esc, gripHtml, checkDotHtml, checkRowHtml, iconBtn, field, makeSortable, mergeVisibleOrder, openSheet, closeSheet, sheetCleanups, splitCsv, dropdownHtml, onTableRefresh } from './core.js';
import { notifyRulesChanged } from './rules.js';
import { catTestHtml, catTestCleanup, resetCatTest } from './category-test.js';

let catCache = [];

function catById(id) {
  for (let i = 0; i < catCache.length; i++) if (catCache[i].id === id) return catCache[i];
  return null;
}

// 摘要标签（两形态统一的 tag 语言）：模型紫 / 关键词蓝 / 分区·帖子形态·引用·带图 mint / 主分类琥珀（末位，窄卡溢出时先让出）
function catSummaryTags(c) {
  let tags = '';
  if (c.llmPrompt) tags += '<span class="tag tag-purple">模型</span>';
  if (c.keywords.length) tags += `<span class="tag tag-blue">关键词 ${c.keywords.length}</span>`;
  if (c.appliesTo !== 'post' && c.areas.length) tags += `<span class="tag tag-mint">分区 ${c.areas.length}</span>`;
  if (c.appliesTo === 'post') {
    const pts = (c.postTypes || []);
    if (pts.length && pts.length < 2) tags += `<span class="tag tag-mint">${pts[0] === 'retweet' ? '只转' : '只原'}</span>`;
    if (c.requireQuote) tags += '<span class="tag tag-mint">须引用</span>';
    if (c.requireMedia) tags += '<span class="tag tag-mint">须带图</span>';
  }
  if (c.primary) tags += '<span class="tag tag-amber">主分类</span>';
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
    ['live', 'post'].forEach(function (kind) {
      const list = document.getElementById(kind === 'live' ? 'category-list' : 'post-category-list');
      if (list) list.innerHTML = catCache.filter(function (c) { return (c.appliesTo || 'live') === kind; }).map(categoryRowHtml).join('');
    });
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
ACTIONS['add-category'] = function (el) { openCategorySheet(null, el.getAttribute('data-kind') || 'live'); };
ACTIONS['edit-category'] = function (el) {
  openCategorySheet(Number(el.closest('.row').getAttribute('data-sid')));
};

let catDraft = null;

function captureCatDraft() {
  if (!catDraft) return;
  const kw = document.getElementById('cg-kw');
  const area = document.getElementById('cg-area');
  const cond = document.getElementById('cg-cond');
  if (kw) catDraft.keywords = kw.value;
  if (area) catDraft.areas = area.value;
  if (cond) catDraft.condMode = cond.getAttribute('data-mode') || 'and';
  const postConditions = document.getElementById('cg-post-conditions');
  if (postConditions) {
    const selected = Array.from(postConditions.selectedOptions).map(function (option) { return option.value; });
    catDraft.postTypes = selected.filter(function (value) { return value === 'original' || value === 'retweet'; });
    catDraft.requireQuote = selected.includes('requireQuote');
    catDraft.requireMedia = selected.includes('requireMedia');
  }
}

// 当前草稿 → 提交体：保存与测试共用（测试用未保存草稿，故一律从表单现值读，不读 catCache）。
// name 空则不提交该字段：POST 由后端自动补「分类 N」，PUT 保留原名（显式空串会 400）
function catSheetBody() {
  if (!catDraft) return null;
  captureCatDraft();
  const promptEl = document.getElementById('cg-prompt');
  const nameEl = document.getElementById('cg-name');
  const primaryEl = document.getElementById('cg-primary');
  const name = nameEl ? nameEl.value.trim() : '';
  const isPost = catDraft.kind === 'post';
  const body = {
    appliesTo: catDraft.kind,
    llmPrompt: (promptEl ? promptEl.value.trim() : '') || null,
    primary: !!primaryEl && primaryEl.checked,
    keywords: splitCsv(catDraft.keywords),
    areas: isPost ? [] : splitCsv(catDraft.areas),
    postTypes: isPost ? catDraft.postTypes : [],
    requireQuote: isPost && catDraft.requireQuote,
    requireMedia: isPost && catDraft.requireMedia,
    condMode: catDraft.condMode || 'and',
  };
  if (name) body.name = name;
  return body;
}

function openCategorySheet(id, kind) {
  const c = id === null ? null : catById(id);
  if (id !== null && !c) { toast('分类数据未加载', true); return; }
  catDraft = {
    kind: c ? (c.appliesTo || 'live') : (kind || 'live'),
    keywords: c ? c.keywords.join(', ') : '',
    areas: c ? c.areas.join(', ') : '',
    condMode: c ? (c.condMode || 'and') : 'and',
    postTypes: c ? (c.postTypes || []).slice() : [],
    requireQuote: !!(c && c.requireQuote),
    requireMedia: !!(c && c.requireMedia),
  };
  resetCatTest(catDraft.kind, catSheetBody);
  openSheet(c ? '编辑分类' : '新增分类',
    '<div class="two cat-name-row">' +
      field('名称', `<input class="inp" id="cg-name" placeholder="如：歌回；留空自动命名" value="` +
        (c ? esc(c.name) : '') + '">') +
      '<div class="field">' + checkRowHtml('id="cg-primary"', !!(c && c.primary), '主分类') + '</div>' +
    '</div>' +
    field('判定描述', '<textarea class="inp" id="cg-prompt" rows="4" placeholder="留空仅使用确定性条件">' +
      (c && c.llmPrompt ? esc(c.llmPrompt) : '') + '</textarea>') +
    // 确定性条件区：按适用内容渲染可用算子（同一组件、同一交互语言）
    `<div class="field" id="cg-cond-area">${condAreaHtml()}</div>` +
    '<div class="sheet-foot"><span id="category-err" class="form-err"></span>' +
    '<button class="btn" data-action="close-sheet" data-level="1">取消</button>' +
    `<button class="btn btn-primary" data-action="save-category" data-id="${c ? c.id : ''}">保存</button></div>`,
    1, null, catTestHtml);
  // 草稿关闭清理：下次打开是全新草稿（测试区随之作废在途请求与筛选状态）
  sheetCleanups[1] = function () { catTestCleanup(); catDraft = null; };
}

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
      '</div>';
  }
  const selected = d.postTypes.slice();
  if (d.requireQuote) selected.push('requireQuote');
  if (d.requireMedia) selected.push('requireMedia');
  return '<label class="field-label">确定性条件</label><div class="cond-row">' +
    kw + toggle + dropdownHtml('cg-post-conditions', [
      { value: 'original', label: '原创' },
      { value: 'retweet', label: '转发' },
      { value: 'requireQuote', label: '须引用（仅X）' },
      { value: 'requireMedia', label: '须带图' },
    ], selected, null, '帖子条件') + '</div>';
}

ACTIONS['toggle-cond'] = function (el) {
  const or = el.getAttribute('data-mode') !== 'or';
  el.setAttribute('data-mode', or ? 'or' : 'and');
  el.textContent = or ? '或' : '且';
};

ACTIONS['save-category'] = function (el) {
  const err = document.getElementById('category-err');
  if (err) err.textContent = '';
  const body = catSheetBody();
  if (!body) return;
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
['live', 'post'].forEach(function (kind) {
  makeSortable(document.getElementById(kind === 'live' ? 'category-list' : 'post-category-list'), {
    items: function () { return catCache.filter(function (c) { return (c.appliesTo || 'live') === kind; }); },
    getId: function (c) { return c.id; },
    onOrder: function (ids) {
      api('/api/categories/order', 'PUT', { ids: mergeVisibleOrder(catCache, ids) })
        .then(loadCategories)
        .catch(function (err) { toast(err.message, true); loadCategories(); });
    },
  });
});

loadCategories();
// 分类行（关键词 / 分区 / 判定方式 / 停用）在 categories 表——撤销后重拉本卡；
// 规则卡对分类的引用快照由 rules.js 的共享缓存负责（notifyRulesChanged 广播刷新）
onTableRefresh(['categories'], loadCategories);
