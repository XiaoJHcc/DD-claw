// 面板前端 · 分类弹窗的两阶段测试工作区：常驻筛选 → 带图抽样 → 同一批样本图标化对照。
import { api, toast, ACTIONS, CHANGES, INPUTS, esc, dropdownHtml } from './core.js';
import { icon } from './icons.js';
import { accountName, loadRuleCard } from './rules.js';

const SOURCE_ORDER = ['rule', 'llm', 'decision'];
const PLATFORM_OF = { twitter: 'twitter', weibo: 'weibo', bili: 'bili_dynamic' };
const PLATFORM_LABEL = { twitter: 'X', weibo: '微博', bili: 'B站' };

const state = {
  kind: 'live', getBody: null, open: false,
  subject: '', from: '', to: '', limit: 10,
  subjects: [], seq: 0, phase: 'idle', samples: null,
};

function tsOf(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const pad = function (n) { return String(n).padStart(2, '0'); };
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function noun() { return state.kind === 'live' ? '主播' : '账号'; }
function busy() { return state.phase !== 'idle'; }
function allSubjectOption() { return { value: '', label: '全部' + noun() }; }

export function resetCatTest(kind, getBody) {
  state.kind = kind === 'post' ? 'post' : 'live';
  state.getBody = getBody;
  state.open = false;
  state.subject = '';
  state.from = '';
  state.to = '';
  state.limit = 10;
  state.subjects = [allSubjectOption()];
  state.seq += 1;
  state.phase = 'idle';
  state.samples = null;
}

export function catTestCleanup() {
  state.seq += 1;
  state.phase = 'idle';
  state.samples = null;
  state.getBody = null;
  const stack = document.querySelector('#sheet-mask1 .sheet-stack');
  if (stack) stack.classList.remove('cat-test-open');
}

export function catTestHtml(mainHtml) {
  return `<section class="cat-test${state.open ? ' is-open' : ''}">` + mainHtml +
    `<button type="button" class="cat-test-head" data-action="toggle-cat-test" aria-expanded="${state.open ? 'true' : 'false'}">` +
      '<b>真实数据测试</b>' +
      `<span class="cat-test-toggle-icon">${icon(state.open ? 'chevron-up' : 'chevron-down')}</span>` +
    '</button>' +
    `<div class="cat-test-panel"><div class="cat-test-panel-inner"><div class="cat-test-workspace">${workspaceHtml()}</div></div></div>` +
  '</section>';
}

function buildSubjects(data) {
  const list = [allSubjectOption()];
  if (state.kind === 'live') {
    (data.streamers || []).forEach(function (s) {
      list.push({ value: String(s.uid), label: s.alias || s.uname || 'UID ' + s.uid });
    });
    return list;
  }
  ['twitter', 'weibo', 'bili'].forEach(function (platform) {
    (data.accounts[platform] || []).forEach(function (a) {
      const key = platform === 'twitter' ? a.screenName : a.uid;
      list.push({ value: platform + ':' + key, label: PLATFORM_LABEL[platform] + ' · ' + accountName(platform, a) });
    });
  });
  return list;
}

function ensureSubjects() {
  const gen = state.seq;
  loadRuleCard().then(function (data) {
    if (gen !== state.seq || !state.open) return;
    state.subjects = buildSubjects(data);
    renderWorkspace();
  }).catch(function (e) { toast(e.message, true); });
}

ACTIONS['toggle-cat-test'] = function (el) {
  state.open = !state.open;
  el.setAttribute('aria-expanded', String(state.open));
  const toggleIcon = el.querySelector('.cat-test-toggle-icon');
  if (toggleIcon) toggleIcon.innerHTML = icon(state.open ? 'chevron-up' : 'chevron-down');
  el.closest('.cat-test').classList.toggle('is-open', state.open);
  el.closest('.sheet-stack').classList.toggle('cat-test-open', state.open);
  if (state.open) ensureSubjects();
};

function filtersChanged() {
  if (state.from && state.to && tsOf(state.from) >= tsOf(state.to)) {
    toast('起始时间需早于结束时间', true);
    renderWorkspace();
    return;
  }
  state.seq += 1;
  state.phase = 'idle';
  state.samples = null;
  renderWorkspace();
}

CHANGES['change-cat-test-subject'] = function (el) { state.subject = el.value; filtersChanged(); };
CHANGES['change-cat-test-from'] = function (el) { state.from = el.value; filtersChanged(); };
CHANGES['change-cat-test-to'] = function (el) { state.to = el.value; filtersChanged(); };

INPUTS['cat-test-limit'] = function (el) {
  state.limit = Number(el.value);
  const out = document.querySelector('#sheet-mask1 .cat-test-limit-value');
  if (out) out.textContent = String(state.limit);
  el.style.setProperty('--range-fill', ((state.limit - 1) / 19 * 100) + '%');
};

function buildFilter() {
  const filter = { kind: state.kind, limit: state.limit };
  if (state.subject) {
    if (state.kind === 'live') {
      filter.uid = state.subject;
    } else {
      const i = state.subject.indexOf(':');
      filter.platform = PLATFORM_OF[state.subject.slice(0, i)];
      filter.uid = state.subject.slice(i + 1);
    }
  }
  const from = tsOf(state.from);
  if (from != null) filter.fromTs = from;
  const to = tsOf(state.to);
  if (to != null) filter.toTs = to;
  return filter;
}

function sampleRecords() {
  if (busy()) return;
  const gen = ++state.seq;
  state.phase = 'sampling';
  renderWorkspace();
  const query = new URLSearchParams();
  const filter = buildFilter();
  Object.keys(filter).forEach(function (key) { query.set(key, String(filter[key])); });
  api('/api/categories/samples?' + query.toString()).then(function (j) {
    if (gen !== state.seq) return;
    state.phase = 'idle';
    state.samples = Array.isArray(j.samples) ? j.samples : [];
    renderWorkspace();
  }).catch(function (e) {
    if (gen !== state.seq) return;
    state.phase = 'idle';
    renderWorkspace();
    toast(e.message, true);
  });
}

ACTIONS['sample-cat-test'] = sampleRecords;
ACTIONS['refresh-cat-test'] = sampleRecords;

ACTIONS['run-cat-test'] = function () {
  if (busy() || !state.getBody || !state.samples || state.samples.length === 0) return;
  const body = state.getBody();
  if (!body) return;
  const gen = ++state.seq;
  state.phase = 'testing';
  state.samples = state.samples.map(function (sample) {
    const next = { ...sample };
    delete next.results;
    return next;
  });
  renderWorkspace();
  const sampleIds = state.samples.map(function (sample) { return sample.subjectId; });
  api('/api/categories/test', 'POST', { category: body, sampleIds }).then(function (j) {
    if (gen !== state.seq) return;
    const tested = {};
    (j.samples || []).forEach(function (sample) { tested[sample.subjectId] = sample; });
    state.samples = state.samples.map(function (sample) {
      return { ...sample, results: tested[sample.subjectId] ? tested[sample.subjectId].results : [] };
    });
    state.phase = 'idle';
    renderWorkspace();
  }).catch(function (e) {
    if (gen !== state.seq) return;
    state.phase = 'idle';
    renderWorkspace();
    toast(e.message, true);
  });
};

function sampleImage(sample) {
  if (!sample.image) return '';
  const image = String(sample.image);
  if (image.startsWith('data:image/')) return image;
  if (image.startsWith('demo/')) return '/' + image;
  if (sample.tags && sample.tags.platform === 'twitter') return '/api/category-sample-image?url=' + encodeURIComponent(image);
  if (sample.tags && sample.tags.platform === 'weibo') return '/api/weibo-image?url=' + encodeURIComponent(image);
  return /^https?:\/\//i.test(image) || image.startsWith('/') ? image : '';
}

function verdictMark(result) {
  if (state.phase === 'testing') return '<span class="cat-test-wait" aria-label="测试中"></span>';
  if (!result || result.status !== 'ok' || result.decided === false) {
    return `<span class="cat-test-mark unknown" title="未定案">${icon('question')}</span>`;
  }
  if (result.pass === true) return `<span class="cat-test-mark yes" title="属于">${icon('check')}</span>`;
  if (result.pass === false) return `<span class="cat-test-mark no" title="不属于">${icon('xmark')}</span>`;
  return `<span class="cat-test-mark unknown" title="未定案">${icon('question')}</span>`;
}

function resultCell(sample, source) {
  const results = sample.results || [];
  let result = null;
  for (let i = 0; i < results.length; i++) if (results[i].source === source) { result = results[i]; break; }
  const probability = state.phase !== 'testing' && result && result.confidence != null
    ? Number(result.confidence).toFixed(2) : '';
  const showEvidence = state.phase !== 'testing' && result && result.status === 'ok' && result.evidence
    && (source === 'llm' || (source === 'rule' && result.pass === true));
  const showReason = state.phase !== 'testing' && result && result.status !== 'ok' && result.reason;
  const detail = showEvidence ? result.evidence : showReason ? result.reason : '';
  const secondary = probability || detail;
  const secondaryClass = probability ? 'cat-test-prob' : 'cat-test-evidence' + (showReason ? ' reason' : '');
  return `<td class="cat-test-result"><div class="cat-test-result-inner">` +
    `<div class="cat-test-verdict">${verdictMark(result)}</div>` +
    `<div class="${secondaryClass}" title="${esc(secondary)}">${esc(secondary)}</div>` +
  '</div></td>';
}

function sampleRow(sample) {
  const image = sampleImage(sample);
  const title = state.kind === 'live' ? (sample.text || sample.authorName) : sample.authorName;
  const content = state.kind === 'live' ? '' : sample.text;
  const area = state.kind === 'live' && sample.tags ? sample.tags.area : '';
  return '<tr><td class="cat-test-sample"><div class="cat-test-sample-main">' +
    (image ? `<img class="cat-test-thumb" src="${esc(image)}" referrerpolicy="no-referrer" alt="">` : '<span class="cat-test-thumb cat-test-thumb-empty"></span>') +
    '<div class="cat-test-copy">' +
      `<div class="cat-test-title" title="${esc(title)}">${esc(title)}</div>` +
      (state.kind === 'live' ? `<div class="cat-test-author">${esc(sample.authorName)}</div>` : '') +
      (content ? `<div class="cat-test-text" title="${esc(content)}">${esc(content)}</div>` : '') +
      '<div class="cat-test-meta">' +
        (area ? `<span class="cat-test-area">${esc(area)}</span>` : '') +
        `<time>${esc(fmtTime(sample.ts))}</time>` +
      '</div></div></div></td>' +
    SOURCE_ORDER.map(function (source) { return resultCell(sample, source); }).join('') + '</tr>';
}

function sampleTableHtml() {
  const rows = state.samples && state.samples.length > 0 ? state.samples.map(sampleRow).join('') : '';
  const empty = state.samples === null ? '暂无样本' : state.samples.length === 0 ? '没有符合条件的带图记录' : '';
  return '<div class="cat-test-table-wrap"><table class="cat-test-table"><colgroup>' +
    '<col><col class="cat-test-result-col"><col class="cat-test-result-col"><col class="cat-test-result-col">' +
    '</colgroup><thead><tr><th>样本</th><th>规则</th><th>LLM</th><th>决策</th></tr></thead><tbody>' +
    rows + '</tbody></table>' + (empty ? `<div class="cat-test-placeholder">${empty}</div>` : '') + '</div>';
}

function workspaceHtml() {
  const hasSamples = state.samples !== null;
  const canTest = hasSamples && state.samples.length > 0;
  const disabled = busy() ? ' disabled' : '';
  const refreshClass = hasSamples ? 'btn-line' : 'btn-primary';
  const testLabel = state.phase === 'testing' ? '测试中' : '开始测试';
  return '<div class="cat-test-filterbar">' +
    `<div class="cat-test-subject">${dropdownHtml('ct-subject', state.subjects, state.subject, 'change-cat-test-subject')}</div>` +
    '<div class="cat-test-date-range">' +
      `<input class="inp cat-test-date" type="datetime-local" value="${esc(state.from)}" data-change="change-cat-test-from" aria-label="起始时间"${disabled}>` +
      '<span class="cat-test-date-sep">–</span>' +
      `<input class="inp cat-test-date" type="datetime-local" value="${esc(state.to)}" data-change="change-cat-test-to" aria-label="结束时间"${disabled}>` +
    '</div>' +
    '<div class="cat-test-count"><label for="ct-limit">数量</label>' +
      `<input id="ct-limit" type="range" min="1" max="20" step="1" value="${state.limit}" data-input="cat-test-limit"` +
        ` style="--range-fill:${(state.limit - 1) / 19 * 100}%"${disabled}>` +
      `<output class="cat-test-limit-value" for="ct-limit">${state.limit}</output></div>` +
  '</div>' + sampleTableHtml() + '<div class="cat-test-actions">' +
    `<button type="button" class="btn cat-test-icon-btn ${refreshClass}" data-action="refresh-cat-test" title="刷新样本" aria-label="刷新样本"${disabled}>${icon('rotate-ccw')}</button>` +
    `<button type="button" class="btn btn-primary cat-test-run-btn" data-action="run-cat-test"${disabled || !canTest ? ' disabled' : ''}>${testLabel}</button>` +
  '</div>';
}

function renderWorkspace() {
  const out = document.querySelector('#sheet-mask1 .cat-test-workspace');
  if (out) out.innerHTML = workspaceHtml();
}
