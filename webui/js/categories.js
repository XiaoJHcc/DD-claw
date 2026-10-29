// 面板前端 · 卡片「分类规则」：分类列表（拖拽把手/启停勾/名称/条件摘要标签/编辑/删除）
// + 底部新增按钮与「分类时机」入口（只有直播分类卡有：五个时机 × 三档判定 + 时间口径）。
// 分类 = 简单描述或精确原子条件 + 确定性条件组 + 是否进主分类组。
// 新增/编辑走一级 sheet，保存报错内联在按钮行；删除分类会级联停用引用它的推送规则（先 confirm 告知）。
// 表单草稿 → 提交体由 catSheetBody() 统一构造（保存与测试共用）；弹窗底部的测试区见 category-test.js。
import { api, toast, ACTIONS, CHANGES, INPUTS, esc, gripHtml, checkDotHtml, checkRowHtml, iconBtn, field, makeSortable, mergeVisibleOrder, openSheet, closeSheet, sheetCleanups, splitCsv, dropdownHtml, onTableRefresh, segnavHtml, layoutSegnav, segnavSelect } from './core.js';
import { icon } from './icons.js';
import { notifyRulesChanged } from './rules.js';
import { catTestHtml, catTestCleanup, resetCatTest } from './category-test.js';

let catCache = [];
let conditionSeq = 0;

function catById(id) {
  for (let i = 0; i < catCache.length; i++) if (catCache[i].id === id) return catCache[i];
  return null;
}

function catSummaryTags(c) {
  let tags = c.primary ? '<span class="tag tag-amber">主分类</span>' : '';
  if (c.judgeMode === 'precise') tags += '<span class="tag tag-purple">精确</span>';
  else if (c.llmPrompt) tags += '<span class="tag tag-purple">模型</span>';
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
    ['live', 'post'].forEach(function (kind) {
      const list = document.getElementById(kind === 'live' ? 'category-list' : 'post-category-list');
      if (list) list.innerHTML = catCache.filter(function (c) { return (c.appliesTo || 'live') === kind; }).map(categoryRowHtml).join('');
    });
  }).catch(function (e) { toast(e.message, true); });
}

CHANGES['toggle-category'] = function (el) {
  const id = Number(el.closest('.row').getAttribute('data-sid'));
  const on = el.checked;
  api('/api/categories/' + id, 'PUT', { enabled: on })
    .then(function () {
      toast(on ? '已启用' : '已停用');
      notifyRulesChanged();
    })
    .catch(function (e) { toast(e.message, true); loadCategories(); });
};

ACTIONS['del-category'] = function (el) {
  const id = Number(el.closest('.row').getAttribute('data-sid'));
  const c = catById(id);
  api('/api/rules').then(function (j) {
    const refs = (j.rules || []).filter(function (r) { return r.categoryId === id && r.enabled; });
    let msg = '删除分类「' + (c ? c.name : id) + '」？';
    if (refs.length > 0) msg += '将同时停用 ' + refs.length + ' 条引用它的推送规则。';
    if (!confirm(msg)) return;
    api('/api/categories/' + id, 'DELETE').then(function (res) {
      toast(res.disabledRules > 0 ? '已删除，并停用 ' + res.disabledRules + ' 条引用规则' : '已删除');
      loadCategories();
      notifyRulesChanged();
    }).catch(function (e) { toast(e.message, true); });
  }).catch(function (e) { toast(e.message, true); });
};

// ---- 分类 新增/编辑 弹窗（id=null 新增）；保存报错内联在按钮行 ----
ACTIONS['add-category'] = function (el) { openCategorySheet(null, el.getAttribute('data-kind') || 'live'); };
ACTIONS['edit-category'] = function (el) {
  openCategorySheet(Number(el.closest('.row').getAttribute('data-sid')));
};

let catDraft = null;

function newJudgeCondition(direction) {
  conditionSeq += 1;
  const id = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
    ? globalThis.crypto.randomUUID() : `condition-${Date.now()}-${conditionSeq}`;
  return { id, direction, text: '', enabled: true };
}

function normalizeJudgeConditions(c) {
  return (c && Array.isArray(c.judgeConditions) ? c.judgeConditions : []).map(function (condition) {
    return {
      id: String(condition.id),
      direction: condition.direction === 'reject' ? 'reject' : 'pass',
      text: String(condition.text || ''),
      enabled: condition.enabled !== false,
    };
  });
}

function captureCatDraft() {
  if (!catDraft) return;
  const kw = document.getElementById('cg-kw');
  const area = document.getElementById('cg-area');
  const cond = document.getElementById('cg-cond');
  const prompt = document.getElementById('cg-prompt');
  if (kw) catDraft.keywords = kw.value;
  if (area) catDraft.areas = area.value;
  if (cond) catDraft.condMode = cond.getAttribute('data-mode') || 'and';
  if (prompt) catDraft.llmPrompt = prompt.value;
  const precise = document.getElementById('cg-judge-precise');
  if (precise) {
    precise.querySelectorAll('.judge-condition-input').forEach(function (input) {
      const condition = catDraft.judgeConditions.find(function (item) { return item.id === input.getAttribute('data-id'); });
      if (condition) condition.text = input.value;
    });
  }
  const postConditions = document.getElementById('cg-post-conditions');
  if (postConditions) {
    const selected = Array.from(postConditions.selectedOptions).map(function (option) { return option.value; });
    catDraft.postTypes = selected.filter(function (value) { return value === 'original' || value === 'retweet'; });
    catDraft.requireQuote = selected.includes('requireQuote');
    catDraft.requireMedia = selected.includes('requireMedia');
  }
}

// 当前草稿 → 提交体：保存与测试共用；两种判定模式的数据始终一起保留。
function catSheetBody() {
  if (!catDraft) return null;
  captureCatDraft();
  const nameEl = document.getElementById('cg-name');
  const primaryEl = document.getElementById('cg-primary');
  const name = nameEl ? nameEl.value.trim() : '';
  const isPost = catDraft.kind === 'post';
  const body = {
    appliesTo: catDraft.kind,
    judgeMode: catDraft.judgeMode,
    llmPrompt: catDraft.llmPrompt.trim() || null,
    judgeConditions: catDraft.judgeConditions.map(function (condition) {
      return { ...condition, text: condition.text.trim() };
    }).filter(function (condition) { return condition.text !== ''; }),
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

function judgeConditionRowHtml(condition) {
  const isPass = condition.direction === 'pass';
  const label = isPass ? '通过条件' : '拒绝条件';
  return `<div class="judge-condition-row${condition.enabled ? '' : ' off'}" data-id="${esc(condition.id)}">` +
    '<div class="judge-condition-input-wrap">' +
      `<button type="button" class="judge-condition-toggle ${condition.direction}${condition.enabled ? ' on' : ''}"` +
        ` data-action="toggle-judge-condition" data-id="${esc(condition.id)}" aria-pressed="${condition.enabled ? 'true' : 'false'}"` +
        ` title="${condition.enabled ? '禁用' : '启用'}${label}" aria-label="${condition.enabled ? '禁用' : '启用'}${label}">${icon(isPass ? 'check' : 'xmark')}</button>` +
      `<input class="inp judge-condition-input" data-input="judge-condition-text" data-id="${esc(condition.id)}"` +
        ` value="${esc(condition.text)}" aria-label="${label}">` +
    '</div>' +
    `<button type="button" class="icon-btn judge-condition-delete" data-action="del-judge-condition" data-id="${esc(condition.id)}"` +
      ` title="删除${label}" aria-label="删除${label}">${icon('trash')}</button>` +
  '</div>';
}

function judgeConditionColumnHtml(direction, label) {
  const conditions = catDraft.judgeConditions.filter(function (condition) { return condition.direction === direction; });
  return `<section class="judge-condition-column"><label class="field-label">${label}</label>` +
    `<div class="judge-condition-list">${conditions.map(judgeConditionRowHtml).join('')}</div>` +
    `<button type="button" class="btn judge-condition-add ${direction}" data-action="add-judge-condition" data-direction="${direction}">${icon('plus')}添加</button>` +
  '</section>';
}

function judgeEditorHtml() {
  if (catDraft.judgeMode === 'simple') {
    return field('判定描述', '<textarea class="inp" id="cg-prompt" rows="4" placeholder="留空则不使用模型判定">' +
      esc(catDraft.llmPrompt) + '</textarea>');
  }
  return '<div class="judge-precise" id="cg-judge-precise">' +
    judgeConditionColumnHtml('pass', '通过条件') +
    judgeConditionColumnHtml('reject', '拒绝条件') +
  '</div>';
}

function renderJudgeEditor() {
  const editor = document.getElementById('cg-judge-editor');
  if (editor) editor.innerHTML = judgeEditorHtml();
}

ACTIONS['switch-cat-judge-mode'] = function (el) {
  const mode = el.getAttribute('data-value') === 'precise' ? 'precise' : 'simple';
  if (!catDraft || catDraft.judgeMode === mode) return;
  captureCatDraft();
  catDraft.judgeMode = mode;
  segnavSelect(el.closest('.segnav'), mode);
  renderJudgeEditor();
};

ACTIONS['toggle-judge-condition'] = function (el) {
  captureCatDraft();
  const condition = catDraft.judgeConditions.find(function (item) { return item.id === el.getAttribute('data-id'); });
  if (!condition) return;
  condition.enabled = !condition.enabled;
  renderJudgeEditor();
};

ACTIONS['add-judge-condition'] = function (el) {
  captureCatDraft();
  const condition = newJudgeCondition(el.getAttribute('data-direction') === 'reject' ? 'reject' : 'pass');
  catDraft.judgeConditions.push(condition);
  renderJudgeEditor();
  const inputs = document.querySelectorAll('#cg-judge-precise .judge-condition-input');
  inputs.forEach(function (input) { if (input.getAttribute('data-id') === condition.id) input.focus(); });
};

ACTIONS['del-judge-condition'] = function (el) {
  captureCatDraft();
  const id = el.getAttribute('data-id');
  catDraft.judgeConditions = catDraft.judgeConditions.filter(function (condition) { return condition.id !== id; });
  renderJudgeEditor();
};

INPUTS['judge-condition-text'] = function (el) {
  if (!catDraft) return;
  const condition = catDraft.judgeConditions.find(function (item) { return item.id === el.getAttribute('data-id'); });
  if (condition) condition.text = el.value;
};

function openCategorySheet(id, kind) {
  const c = id === null ? null : catById(id);
  if (id !== null && !c) { toast('分类数据未加载', true); return; }
  catDraft = {
    kind: c ? (c.appliesTo || 'live') : (kind || 'live'),
    judgeMode: c && c.judgeMode === 'precise' ? 'precise' : 'simple',
    llmPrompt: c && c.llmPrompt ? c.llmPrompt : '',
    judgeConditions: c ? normalizeJudgeConditions(c) : [newJudgeCondition('pass'), newJudgeCondition('reject')],
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
      field('名称', `<input class="inp" id="cg-name" value="` +
        (c ? esc(c.name) : '') + '">') +
      '<div class="field">' + checkRowHtml('id="cg-primary"', !!(c && c.primary), '主分类') + '</div>' +
    '</div>' +
    `<div class="field" id="cg-cond-area">${condAreaHtml()}</div>` +
    '<div class="cat-judge-mode">' + segnavHtml([
      { value: 'simple', label: '简单' },
      { value: 'precise', label: '精确' },
    ], catDraft.judgeMode, 'sm', 'switch-cat-judge-mode') + '</div>' +
    `<div id="cg-judge-editor">${judgeEditorHtml()}</div>` +
    '<div class="sheet-foot"><span id="category-err" class="form-err"></span>' +
    '<button class="btn" data-action="close-sheet" data-level="1">取消</button>' +
    `<button class="btn btn-primary" data-action="save-category" data-id="${c ? c.id : ''}">保存</button></div>`,
    1, null, catTestHtml);
  layoutSegnav(document.querySelector('#sheet-mask1 .cat-judge-mode .segnav'), false);
  sheetCleanups[1] = function () { catTestCleanup(); catDraft = null; };
}

// 中间小方钮切换两组条件的关系（且/或）；当前值在按钮 data-mode 上。
function condAreaHtml() {
  const d = catDraft;
  const toggle = `<button class="cond-toggle" id="cg-cond" data-action="toggle-cond" data-mode="${d.condMode}"` +
    ' title="各组条件的关系，点击切换 且/或">' + (d.condMode === 'or' ? '或' : '且') + '</button>';
  const kw = `<input class="inp" id="cg-kw" placeholder="关键词，逗号分隔" value="${esc(d.keywords)}">`;
  if (d.kind === 'live') {
    return '<label class="field-label">确定性条件</label><div class="cond-row">' +
      kw + toggle +
      `<input class="inp" id="cg-area" placeholder="分区，逗号分隔" value="${esc(d.areas)}">` +
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
    notifyRulesChanged();
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

// ---- 分类时机（只有直播分类卡带这个入口）：五个时机 × 三档判定 + 三条时间口径 ----
// 事实来源是 settings 的运行时参数（/api/advanced，NUM_SPECS / BOOL_SPECS）；
// 三档全关 = 该时机不判定。保存后热生效，无需重启。
var CLASSIFY_TIMINGS = ['start', 'startDelay', 'titleChange', 'titleDelay', 'periodic'];
var CLASSIFY_STAGES = [
  { key: 'rule', label: '规则' },
  { key: 'decision', label: '决策' },
  { key: 'llm', label: 'LLM' },
];
// 延迟 / 定时时机的行名跟着分钟输入实时变：标签与输入框是同一份口径，不另存一份文案
var ctTimes = { delay: 5, periodic: 20 };

function timingLabelHtml(timing, delay, periodic) {
  const num = function (n) { return '<span class="ct-num">' + esc(n) + '</span>'; };
  if (timing === 'startDelay') return '开播 ' + num(delay) + ' 分钟后';
  if (timing === 'titleDelay') return '变更 ' + num(delay) + ' 分钟后';
  if (timing === 'periodic') return '每直播 ' + num(periodic) + ' 分钟';
  return timing === 'start' ? '开播时' : '标题/分区变更时';
}

function refreshTimingLabels() {
  CLASSIFY_TIMINGS.forEach(function (timing) {
    const el = document.getElementById('ct-name-' + timing);
    if (el) el.innerHTML = timingLabelHtml(timing, ctTimes.delay, ctTimes.periodic);
  });
}

/** 时机 + 档位 → RuntimeConfig 字段名（与 core/runtime-config.ts 的 BOOL_SPECS 同形） */
function timingFieldName(timing, stage) {
  return 'liveClassify' + timing.charAt(0).toUpperCase() + timing.slice(1) +
    stage.charAt(0).toUpperCase() + stage.slice(1);
}
function timingInputId(timing, stage) { return 'ct-' + timing + '-' + stage; }

function timingRowHtml(adv, timing) {
  return '<div class="ct-row"><span class="ct-name" id="ct-name-' + timing + '">' +
    timingLabelHtml(timing, adv.liveClassifyDelayMin, adv.liveClassifyPeriodicMin) + '</span>' +
    CLASSIFY_STAGES.map(function (stage) {
      return '<span class="ct-cell">' + checkDotHtml(
        `id="${timingInputId(timing, stage.key)}"`,
        adv[timingFieldName(timing, stage.key)] === true) + '</span>';
    }).join('') + '</div>';
}

INPUTS['ct-time'] = function (el) {
  const n = parseInt(el.value, 10);
  if (!isNaN(n)) {
    if (el.id === 'ct-delay') ctTimes.delay = n;
    else ctTimes.periodic = n;
  }
  refreshTimingLabels();
};

ACTIONS['open-classify-timing'] = function () {
  api('/api/advanced').then(function (j) {
    ctTimes.delay = j.liveClassifyDelayMin;
    ctTimes.periodic = j.liveClassifyPeriodicMin;
    openSheet('分类时机',
      '<div class="ct-grid"><div class="ct-row ct-head"><span class="ct-name"></span>' +
        CLASSIFY_STAGES.map(function (stage) { return '<span class="ct-cell">' + esc(stage.label) + '</span>'; }).join('') +
        '</div>' +
        CLASSIFY_TIMINGS.map(function (timing) { return timingRowHtml(j, timing); }).join('') +
      '</div>' +
      '<div class="three">' +
        field('LLM 冷却时间（分钟）', `<input class="inp" type="number" id="ct-cooldown" value="${esc(j.liveClassifyLlmCooldownMin)}">`) +
        field('延迟时间（分钟）', `<input class="inp" type="number" id="ct-delay" data-input="ct-time" value="${esc(j.liveClassifyDelayMin)}">`) +
        field('定时时间（分钟）', `<input class="inp" type="number" id="ct-periodic" data-input="ct-time" value="${esc(j.liveClassifyPeriodicMin)}">`) +
      '</div>' +
      '<div class="sheet-foot"><span id="ct-err" class="form-err"></span>' +
      '<button class="btn" data-action="close-sheet" data-level="1">取消</button>' +
      '<button class="btn btn-primary" data-action="save-classify-timing">保存</button></div>',
      1);
  }).catch(function (e) { toast(e.message, true); });
};

ACTIONS['save-classify-timing'] = function () {
  const err = document.getElementById('ct-err');
  if (err) err.textContent = '';
  const cooldown = parseInt(document.getElementById('ct-cooldown').value, 10);
  const delay = parseInt(document.getElementById('ct-delay').value, 10);
  const periodic = parseInt(document.getElementById('ct-periodic').value, 10);
  if (isNaN(cooldown) || isNaN(delay) || isNaN(periodic)) {
    if (err) err.textContent = '时间请输入整数';
    return;
  }
  const body = {
    liveClassifyLlmCooldownMin: cooldown,
    liveClassifyDelayMin: delay,
    liveClassifyPeriodicMin: periodic,
  };
  CLASSIFY_TIMINGS.forEach(function (timing) {
    CLASSIFY_STAGES.forEach(function (stage) {
      const el = document.getElementById(timingInputId(timing, stage.key));
      body[timingFieldName(timing, stage.key)] = !!(el && el.checked);
    });
  });
  api('/api/advanced', 'PUT', body).then(function () {
    closeSheet(1);
    toast('已保存并生效');
  }).catch(function (e) { if (err) err.textContent = e.message; });
};

loadCategories();
onTableRefresh(['categories'], loadCategories);
