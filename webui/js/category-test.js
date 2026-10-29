// 面板前端 · 分类弹窗的两阶段测试工作区：常驻筛选 → 带图抽样 → 同一批样本图标化对照。
import { api, toast, ACTIONS, CHANGES, INPUTS, esc, dropdownHtml } from './core.js';
import { icon } from './icons.js';
import { accountName, loadRuleCard } from './rules.js';

const SOURCE_ORDER = ['rule', 'decision', 'llm'];
const PLATFORM_OF = { twitter: 'twitter', weibo: 'weibo', bili: 'bili_dynamic' };
const PLATFORM_LABEL = { twitter: 'X', weibo: '微博', bili: 'B站' };

const state = {
  kind: 'live', getBody: null, open: false,
  subject: '', from: '', to: '', limit: 10,
  sources: { rule: true, llm: true, decision: true },
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
function selectedSources() { return SOURCE_ORDER.filter(function (source) { return state.sources[source]; }); }

export function resetCatTest(kind, getBody) {
  state.kind = kind === 'post' ? 'post' : 'live';
  state.getBody = getBody;
  state.open = false;
  state.subject = '';
  state.from = '';
  state.to = '';
  state.limit = 10;
  state.sources = { rule: true, llm: true, decision: true };
  state.subjects = [allSubjectOption()];
  state.seq += 1;
  state.phase = 'idle';
  state.samples = null;
}

export function catTestCleanup() {
  hideDetailTooltip();
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
CHANGES['toggle-cat-test-source'] = function (el) {
  const source = el.getAttribute('data-source');
  if (!SOURCE_ORDER.includes(source) || busy()) return;
  state.sources[source] = el.checked;
  renderWorkspace();
};

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

ACTIONS['run-cat-test'] = async function () {
  const sources = selectedSources();
  if (busy() || !state.getBody || !state.samples || state.samples.length === 0 || sources.length === 0) return;
  const body = state.getBody();
  if (!body) return;
  const gen = ++state.seq;
  state.phase = 'testing';
  state.samples = state.samples.map(function (sample) {
    const next = { ...sample };
    delete next.results;
    return next;
  });
  renderWorkspace(true);
  const sampleIds = state.samples.map(function (sample) { return sample.subjectId; });
  try {
    for (const sampleId of sampleIds) {
      const j = await api('/api/categories/test', 'POST', { category: body, sampleIds: [sampleId], sources });
      if (gen !== state.seq) return;
      const tested = (j.samples || []).find(function (sample) { return sample.subjectId === sampleId; });
      state.samples = state.samples.map(function (sample) {
        return sample.subjectId === sampleId ? { ...sample, results: tested ? tested.results : [] } : sample;
      });
      renderWorkspace(true);
    }
  } catch (e) {
    if (gen === state.seq) toast(e.message, true);
  }
  if (gen !== state.seq) return;
  state.phase = 'idle';
  renderWorkspace(true);
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

function outcomeLabel(result) {
  if (!result || result.status !== 'ok' || result.decided === false) return '未定案';
  if (result.pass === true) return '通过';
  if (result.pass === false) return '拒绝';
  return '未定案';
}

function maxConditionProbability(result, direction) {
  const conditions = Array.isArray(result.conditionResults) ? result.conditionResults : [];
  const probabilities = conditions.filter(function (condition) {
    return condition.direction === direction && Number.isFinite(Number(condition.p));
  }).map(function (condition) { return Number(condition.p); });
  return probabilities.length > 0 ? Math.max.apply(null, probabilities) : null;
}

function decisionModelName(result) {
  const base = String(result.evidence || '').split('；')[0];
  const parts = base.split(' · ');
  return parts[parts.length - 1] || '';
}

function detailAttrs(result, source, label) {
  const detail = result && (result.evidence || result.reason);
  if (!detail) return '';
  let attrs = ` data-detail="${esc(detail)}" data-source="${source}" data-outcome="${esc(label)}"`;
  if (source === 'decision') {
    if (result.confidence != null) attrs += ` data-overall="${Number(result.confidence).toFixed(2)}"`;
    const pass = maxConditionProbability(result, 'pass');
    const reject = maxConditionProbability(result, 'reject');
    if (pass !== null) attrs += ` data-pass="${pass.toFixed(2)}"`;
    if (reject !== null) attrs += ` data-reject="${reject.toFixed(2)}"`;
    if (Array.isArray(result.conditionResults) && result.conditionResults.length > 0) {
      attrs += ` data-conditions="${esc(JSON.stringify(result.conditionResults))}"`;
    }
    const model = decisionModelName(result);
    if (model) attrs += ` data-model="${esc(model)}"`;
  }
  return attrs;
}

function verdictMark(result, source) {
  if (!result) {
    if (state.phase === 'testing' && state.sources[source]) {
      return '<span class="cat-test-wait" aria-label="测试中"></span>';
    }
    return '<span class="cat-test-empty" aria-label="未测试">—</span>';
  }
  const label = outcomeLabel(result);
  const kind = result.status !== 'ok' || result.decided === false
    ? 'unknown' : result.pass === true ? 'yes' : result.pass === false ? 'no' : 'unknown';
  const attrs = detailAttrs(result, source, label);
  const glyph = kind === 'yes' ? 'check' : kind === 'no' ? 'xmark' : 'question';
  return `<span class="cat-test-mark ${kind}${attrs ? ' cat-test-detail-trigger' : ''}"${attrs}` +
    ` aria-label="${esc(label)}"${attrs ? ' tabindex="0"' : ''}>${icon(glyph)}</span>`;
}

function decisionSummary(result) {
  if (result.confidence != null) return `p=${Number(result.confidence).toFixed(2)}`;
  const pass = maxConditionProbability(result, 'pass');
  const reject = maxConditionProbability(result, 'reject');
  if (pass === null) return '';
  const parts = [`通过 ${pass.toFixed(2)}`];
  if (reject !== null) parts.push(`拒绝 ${reject.toFixed(2)}`);
  return parts.join(' · ');
}

const BRIEF_REASONS = new Map([
  ['未填写判定描述', '无判定描述'],
  ['精确模式没有启用的通过条件', '无通过条件'],
  ['未配置 LLM provider，使用确定性条件', '未配置 LLM'],
  ['LLM 总开关关闭，使用确定性条件', 'LLM 已停用'],
  ['LLM 已停用', 'LLM 已停用'],
  ['LLM 不可用', 'LLM 不可用'],
  ['没有可用的 LLM 供应商', '无可用 LLM'],
  ['模型没有返回这个分类的结论', '未返回结论'],
  ['未配置决策模型供应商', '未配置决策模型'],
  ['决策模型总开关关闭', '决策模型已停用'],
  ['决策模型已停用', '决策模型已停用'],
  ['决策模型不可用', '决策模型不可用'],
  ['没有可用的决策模型供应商', '无可用决策模型'],
  ['决策模型没有返回这个分类的结论', '未返回结论'],
]);

function briefReason(reason, source) {
  const text = String(reason || '').trim();
  const brief = BRIEF_REASONS.get(text);
  if (brief) return brief;
  if (text.startsWith('决策模型档不可用：')) return '决策模型不可用';
  if (text.startsWith('决策模型判定失败：')) return '决策判定失败';
  return source === 'llm' ? 'LLM 判定失败' : '决策判定失败';
}

function briefEvidence(evidence) {
  return String(evidence || '').split(/[；。！？!?\r\n]/, 1)[0].trim();
}

let detailTooltip = null;
let detailTrigger = null;
let detailHideTimer = null;

function hideDetailTooltip() {
  if (detailHideTimer !== null) {
    clearTimeout(detailHideTimer);
    detailHideTimer = null;
  }
  if (detailTrigger) detailTrigger.removeAttribute('aria-describedby');
  if (detailTooltip) detailTooltip.remove();
  detailTooltip = null;
  detailTrigger = null;
}

function scheduleDetailTooltipHide() {
  if (detailHideTimer !== null) clearTimeout(detailHideTimer);
  detailHideTimer = setTimeout(hideDetailTooltip, 100);
}

function tooltipProbabilities(trigger) {
  const items = [];
  if (trigger.getAttribute('data-overall') !== null) items.push(['整体概率', trigger.getAttribute('data-overall')]);
  if (trigger.getAttribute('data-pass') !== null) items.push(['通过最高', trigger.getAttribute('data-pass')]);
  if (trigger.getAttribute('data-reject') !== null) items.push(['拒绝最高', trigger.getAttribute('data-reject')]);
  if (items.length === 0) return '';
  return '<div class="cat-test-tooltip-probs">' + items.map(function (item) {
    return `<div><span>${esc(item[0])}</span><b>${esc(item[1])}</b></div>`;
  }).join('') + '</div>';
}

function tooltipConditions(trigger) {
  const raw = trigger.getAttribute('data-conditions');
  if (!raw) return '';
  let conditions;
  try { conditions = JSON.parse(raw); } catch { return ''; }
  if (!Array.isArray(conditions) || conditions.length === 0) return '';
  const column = function (direction, label) {
    const rows = conditions.filter(function (condition) { return condition.direction === direction; });
    return `<section class="cat-test-tooltip-condition-col"><h3>${label}</h3>` +
      '<div class="cat-test-tooltip-condition-list">' + rows.map(function (condition) {
        const band = condition.band === 'high' || condition.band === 'low' ? condition.band : 'gray';
        const probability = Number(condition.p);
        return `<div class="cat-test-tooltip-condition ${direction} ${band}${condition.decisive ? ' decisive' : ''}">` +
          `<span>${esc(condition.text || '')}</span><b>${Number.isFinite(probability) ? probability.toFixed(2) : ''}</b>` +
        '</div>';
      }).join('') + '</div></section>';
  };
  return '<div class="cat-test-tooltip-conditions">' + column('pass', '通过') + column('reject', '拒绝') + '</div>';
}

function showDetailTooltip(trigger) {
  const detail = trigger.getAttribute('data-detail');
  if (!detail) return;
  if (detailTrigger === trigger && detailTooltip) {
    if (detailHideTimer !== null) clearTimeout(detailHideTimer);
    detailHideTimer = null;
    return;
  }
  hideDetailTooltip();
  detailTrigger = trigger;
  detailTrigger.setAttribute('aria-describedby', 'cat-test-tooltip');
  const source = trigger.getAttribute('data-source') || 'rule';
  const sourceLabel = source === 'decision' ? '决策模型' : source === 'llm' ? 'LLM' : '确定性规则';
  const sourceClass = source === 'decision' ? 'tag-purple' : source === 'llm' ? 'tag-blue' : 'tag-gray';
  const model = source === 'decision' ? trigger.getAttribute('data-model') || '' : '';
  const conditions = source === 'decision' ? tooltipConditions(trigger) : '';
  const showEvidence = !conditions && !model;
  const outcome = trigger.getAttribute('data-outcome') || '';
  const outcomeClass = outcome === '通过' ? 'pass' : outcome === '拒绝' ? 'reject' : 'pending';
  const tooltip = document.createElement('div');
  tooltip.id = 'cat-test-tooltip';
  tooltip.className = 'cat-test-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.innerHTML = '<div class="cat-test-tooltip-head">' +
      `<span class="tag ${sourceClass}">${sourceLabel}</span>` +
      (model ? `<span class="cat-test-tooltip-model">${esc(model)}</span>` : '') +
      `<b class="cat-test-tooltip-outcome ${outcomeClass}">${esc(outcome)}</b>` +
    '</div>' + (conditions || tooltipProbabilities(trigger)) +
    (showEvidence ? '<div class="cat-test-tooltip-evidence">' + detail.split('；').filter(Boolean).map(function (line) {
      return `<p>${esc(line)}</p>`;
    }).join('') + '</div>' : '');
  document.body.appendChild(tooltip);
  detailTooltip = tooltip;
  tooltip.addEventListener('pointerenter', function () {
    if (detailHideTimer !== null) clearTimeout(detailHideTimer);
    detailHideTimer = null;
  });
  tooltip.addEventListener('pointerleave', scheduleDetailTooltipHide);

  const width = Math.min(480, window.innerWidth - 24);
  tooltip.style.width = width + 'px';
  const rect = trigger.getBoundingClientRect();
  const height = tooltip.offsetHeight;
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.left + rect.width / 2 - width / 2));
  let top = rect.bottom + 8;
  if (top + height > window.innerHeight - 12 && rect.top - height - 8 >= 12) top = rect.top - height - 8;
  top = Math.max(12, Math.min(window.innerHeight - height - 12, top));
  tooltip.style.left = left + 'px';
  tooltip.style.top = top + 'px';
}

document.addEventListener('pointerover', function (event) {
  if (!(event.target instanceof Element)) return;
  const trigger = event.target.closest('.cat-test-detail-trigger');
  if (trigger && !trigger.contains(event.relatedTarget)) showDetailTooltip(trigger);
});
document.addEventListener('pointerout', function (event) {
  if (!(event.target instanceof Element)) return;
  const trigger = event.target.closest('.cat-test-detail-trigger');
  if (trigger && trigger === detailTrigger && !trigger.contains(event.relatedTarget)) scheduleDetailTooltipHide();
});
document.addEventListener('focusin', function (event) {
  if (event.target instanceof Element && event.target.matches('.cat-test-detail-trigger')) showDetailTooltip(event.target);
});
document.addEventListener('focusout', function (event) {
  if (event.target === detailTrigger) scheduleDetailTooltipHide();
});
document.addEventListener('scroll', function (event) {
  if (detailTooltip && !detailTooltip.contains(event.target)) hideDetailTooltip();
}, true);
window.addEventListener('resize', hideDetailTooltip);

function resultCell(sample, source) {
  const results = sample.results || [];
  let result = null;
  for (let i = 0; i < results.length; i++) if (results[i].source === source) { result = results[i]; break; }
  const ready = !!result;
  const probability = ready && result.confidence != null ? Number(result.confidence).toFixed(2) : '';
  const showEvidence = ready && result.status === 'ok'
    && (source === 'decision' || (result.evidence && (source === 'llm' || (source === 'rule' && result.pass === true))));
  const showReason = ready && result.status !== 'ok' && result.reason;
  const evidence = ready
    ? source === 'decision' ? decisionSummary(result) : source === 'llm' ? briefEvidence(result.evidence) : result.evidence
    : '';
  const detail = showEvidence ? evidence : showReason ? briefReason(result.reason, source) : '';
  const secondary = source === 'decision' ? detail : probability || detail;
  const secondaryClass = probability && source !== 'decision' ? 'cat-test-prob' : 'cat-test-evidence';
  const attrs = ready && (result.evidence || result.reason) ? detailAttrs(result, source, outcomeLabel(result)) : '';
  return `<td class="cat-test-result"><div class="cat-test-result-inner">` +
    `<div class="cat-test-verdict">${verdictMark(result, source)}</div>` +
    `<div class="${secondaryClass}${attrs ? ' cat-test-detail-trigger' : ''}"${attrs}>${esc(secondary)}</div>` +
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

function sourceHeader(source) {
  const label = source === 'rule' ? '规则' : source === 'llm' ? 'LLM' : '决策';
  const checked = state.sources[source];
  const disabled = busy();
  return `<th><label class="chip cat-test-source${checked ? ' on' : ''}${disabled ? ' is-disabled' : ''}">` +
    `<input type="checkbox" data-change="toggle-cat-test-source" data-source="${source}"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}>` +
    `<span class="chip-ic">${icon('check')}</span><span>${label}</span></label></th>`;
}

function sampleTableHtml() {
  const rows = state.samples && state.samples.length > 0 ? state.samples.map(sampleRow).join('') : '';
  const empty = state.samples === null ? '暂无样本' : state.samples.length === 0 ? '没有符合条件的带图记录' : '';
  return '<div class="cat-test-table-wrap"><table class="cat-test-table"><colgroup>' +
    '<col><col class="cat-test-result-col"><col class="cat-test-result-col"><col class="cat-test-result-col">' +
    `</colgroup><thead><tr><th>样本</th>${SOURCE_ORDER.map(sourceHeader).join('')}</tr></thead><tbody>` +
    rows + '</tbody></table>' + (empty ? `<div class="cat-test-placeholder">${empty}</div>` : '') + '</div>';
}

function workspaceHtml() {
  const hasSamples = state.samples !== null;
  const canTest = hasSamples && state.samples.length > 0 && selectedSources().length > 0;
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

function renderWorkspace(preserveScroll) {
  hideDetailTooltip();
  const out = document.querySelector('#sheet-mask1 .cat-test-workspace');
  if (!out) return;
  const table = preserveScroll ? out.querySelector('.cat-test-table-wrap') : null;
  const scroll = table ? { top: table.scrollTop, left: table.scrollLeft } : null;
  out.innerHTML = workspaceHtml();
  if (scroll) {
    const next = out.querySelector('.cat-test-table-wrap');
    if (next) {
      next.scrollTop = scroll.top;
      next.scrollLeft = scroll.left;
    }
  }
}
