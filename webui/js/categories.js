// 面板前端 · 卡片「分类规则」：分类列表（拖拽把手/启停勾/名称/条件摘要标签/编辑/删除）
// + 底部新增按钮。分类 = LLM 提示词 + 确定性条件（关键词/分区，且/或），归类结果供推送规则引用。
// 新增/编辑走一级 sheet，保存报错内联在按钮行；删除分类会级联停用引用它的推送规则（先 confirm 告知）。
// 视觉 = v2（行内嵌形态 + tag-purple/blue/mint 摘要标签 + .inp 表单控件），行为与接口不变。
import { api, toast, ACTIONS, CHANGES, esc, gripHtml, checkDotHtml, iconBtn, field, makeSortable, openSheet, closeSheet, splitCsv, onTableRefresh } from './core.js';
import { loadPush } from './push.js';
import { loadStreamers } from './streamers.js';

let catCache = [];

function catById(id) {
  for (let i = 0; i < catCache.length; i++) if (catCache[i].id === id) return catCache[i];
  return null;
}

function catSummaryTags(c) {
  let tags = '';
  if (c.llmPrompt) tags += '<span class="tag tag-purple">LLM</span>';
  if (c.keywords.length) tags += `<span class="tag tag-blue">关键词 ${c.keywords.length}</span>`;
  if (c.areas.length) tags += `<span class="tag tag-mint">分区 ${c.areas.length}</span>`;
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
    .then(function () { toast(on ? '已启用' : '已停用'); loadPush(); }) // loadPush：引用规则的「分类已停用」划线态
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
      loadPush();      // 推送卡规则区的分类名标签
      loadStreamers(); // 主播卡的规则名标签不受影响，但分类删改后刷新一遍最稳
    }).catch(function (e) { toast(e.message, true); });
  }).catch(function (e) { toast(e.message, true); });
};

// ---- 分类 新增/编辑 弹窗（id=null 新增）；保存报错内联在按钮行 ----
ACTIONS['add-category'] = function () { openCategorySheet(null); };
ACTIONS['edit-category'] = function (el) {
  openCategorySheet(Number(el.closest('.row').getAttribute('data-sid')));
};

function openCategorySheet(id) {
  const c = id === null ? null : catById(id);
  if (id !== null && !c) { toast('分类数据未加载', true); return; }
  const cond = c ? c.condMode || 'and' : 'and';
  openSheet(c ? '编辑分类' : '新增分类',
    field('名称', `<input class="inp" id="cg-name" placeholder="如：歌回；留空自动命名" value="` +
      (c ? esc(c.name) : '') + '">') +
    field('LLM 提示词', '<textarea class="inp" id="cg-prompt" rows="4" placeholder="留空 = 不使用 LLM 判定（只走下面的确定性条件）">' +
      (c && c.llmPrompt ? esc(c.llmPrompt) : '') + '</textarea>') +
    // 关键词/分区并排，中间小方钮切换两组条件的关系（且/或）；当前值在按钮 data-mode 上
    field('确定性条件', '<div class="cond-row">' +
      `<input class="inp" id="cg-kw" placeholder="关键词，中英文逗号分隔" value="` +
        (c ? esc(c.keywords.join(', ')) : '') + '">' +
      `<button class="cond-toggle" id="cg-cond" data-action="toggle-cond" data-mode="${cond}"` +
        ' title="关键词与分区两组条件的关系，点击切换 且/或">' + (cond === 'or' ? '或' : '且') + '</button>' +
      `<input class="inp" id="cg-area" placeholder="分区，中英文逗号分隔" value="` +
        (c ? esc(c.areas.join(', ')) : '') + '">' +
      '</div>') +
    '<div class="sheet-foot"><span id="category-err" class="form-err"></span>' +
    '<button class="btn" data-action="close-sheet" data-level="1">取消</button>' +
    `<button class="btn btn-primary" data-action="save-category" data-id="${c ? c.id : ''}">保存</button></div>`);
}

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
  // name 空则不提交该字段：POST 由后端自动补「分类 N」，PUT 保留原名（显式空串会 400）
  const body = {
    llmPrompt: prompt || null,
    keywords: splitCsv(document.getElementById('cg-kw').value),
    areas: splitCsv(document.getElementById('cg-area').value),
    condMode: document.getElementById('cg-cond').getAttribute('data-mode') || 'and',
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
    loadPush(); // 推送卡规则区的分类名标签
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
// 分类行（关键词 / 分区 / 判定方式 / 停用）在 categories 表——撤销后重拉本卡
// （规则卡对分类的引用快照由 push.js 的 loadPush 负责，两处各修各的）
onTableRefresh(['categories'], loadCategories);
