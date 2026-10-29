// 面板前端 · 单份内容的判定与推送回看弹窗：分类结论（逐分类分组：生效结论 + 同组次要行）、
// 主分类（生效项 + 各来源非生效结论）、推送结果三区。判定契约见 docs/plan/decision-model.md「二」：
// 同一分类可有多档 / 多来源的结论，恰有一行 effective；confidence 只有决策模型有值（显示为「概率」）。
import { api, ACTIONS, esc, openSheet, sheetCleanups } from './core.js';

// 判定侧与推送侧的状态各有读法：判定 skipped = 整轮未执行（如只有 LLM 档且在冷却），
// 推送 skipped = 未推送——两者不是同一件事，不能共用一份文案。
const ANALYSIS_STATUS = { pending: '处理中', done: '已分类', failed: '失败', skipped: '未执行' };
const PUSH_STATUS = { pending: '处理中', skipped: '未推送',
  sent: '发送成功', partial: '部分发送成功', failed: '失败', 'dry-run': '演练，未实际发送' };
const SOURCE = { llm: 'LLM', rule: '确定性条件', decision: '决策模型' };
const CHANNEL = { llm: 'LLM', decision: '决策' };
/** 主分类的「其他」项：组内都不像，落库 category_id = 0 */
const PRIMARY_OTHER_ID = 0;

function rows(items) {
  return items.length ? items.map(function (item) { return '<div class="audit-row">' + item + '</div>'; }).join('')
    : '<p class="hint">无记录</p>';
}

function sourceName(source) {
  return SOURCE[source] || source;
}

/** 主分类结论的显示名：categoryId 0 = 「其他」，否则分类名 */
function primaryName(entry) {
  return entry.categoryId === PRIMARY_OTHER_ID ? '其他' : entry.name;
}

/** 概率分布按降序排成一行（仅决策模型有分布）：选项 0.xx · 选项 0.xx */
function distributionText(distribution) {
  return Object.keys(distribution).map(function (key) { return [key, Number(distribution[key])]; })
    .sort(function (a, b) { return b[1] - a[1]; })
    .map(function (pair) { return esc(pair[0]) + ' ' + pair[1].toFixed(2); }).join(' · ');
}

/** 当时的分类标准（启用模式的模型条件 + 确定性条件）折叠块 */
function standardsHtml(category) {
  if (!category) return '';
  const conditions = [
    category.keywords.length ? '关键词：' + category.keywords.join('、') : '',
    category.areas.length ? '分区：' + category.areas.join('、') : '',
    category.postTypes.length ? '帖子类型：' + category.postTypes.map(function (kind) { return kind === 'original' ? '原创' : '转发'; }).join('、') : '',
    category.requireQuote ? '须引用' : '', category.requireMedia ? '须带图' : '',
  ].filter(Boolean).join(category.condMode === 'or' ? ' 或 ' : ' 且 ');
  const precise = category.judgeMode === 'precise' && Array.isArray(category.judgeConditions);
  const judgeConditions = precise ? category.judgeConditions.map(function (condition) {
    return (condition.direction === 'reject' ? '拒绝' : '通过') + (condition.enabled === false ? '（已禁用）' : '') + '：' + condition.text;
  }).join('；') : '';
  return '<details><summary>当时的分类标准</summary>' +
    (precise
      ? (judgeConditions ? '<p>精确条件：' + esc(judgeConditions) + '</p>' : '')
      : (category.llmPrompt ? '<p>判定描述：' + esc(category.llmPrompt) + '</p>' : '')) +
    (conditions ? '<p>确定性条件：' + esc(conditions) + '</p>' : '') + '</details>';
}

/** 生效结论行：属于/不属于 · 来源 · 概率（decision 才有） · 依据 · 当时的分类标准 */
function verdictHtml(entry, category) {
  return '<div><strong>' + esc(entry.name) + '</strong> · ' + (entry.pass ? '属于' : '不属于') +
    ' · ' + esc(sourceName(entry.source)) +
    (entry.confidence != null ? ' · 概率 ' + entry.confidence.toFixed(2) : '') + '</div>' +
    '<p>' + esc(entry.evidence || '未提供依据') + '</p>' + standardsHtml(category);
}

/** 同组非生效结论：更淡更小的次要行（来源 · 结论 · 依据） */
function subVerdictHtml(entry, prefix) {
  return '<div class="hint">' + esc((prefix || '') + sourceName(entry.source) + ' · ' +
    (entry.pass ? '属于' : '不属于') + ' · ' + (entry.evidence || '未提供依据')) + '</div>';
}

/** 按分类分组：同组恰好一行生效（旧数据可能没有 effective，退化为首行当主行） */
function groupResults(results) {
  const groups = [];
  const byKey = {};
  results.forEach(function (entry) {
    const key = entry.categoryId != null ? 'id:' + entry.categoryId : 'name:' + entry.name;
    const group = byKey[key] || (byKey[key] = { entries: [] });
    if (group.entries.length === 0) groups.push(group);
    group.entries.push(entry);
  });
  return groups.map(function (group) {
    let main = group.entries[0];
    for (let i = 0; i < group.entries.length; i++) if (group.entries[i].effective) { main = group.entries[i]; break; }
    return { main: main, others: group.entries.filter(function (entry) { return entry !== main; }) };
  });
}

/** 主分类结论：优先 audit.analysis.primary，无审计时回退顶层 primary_verdicts 行 */
function primaryEntries(data, analysis) {
  if (analysis && analysis.primary) return analysis.primary;
  return (data.primary || []).map(function (row) {
    return { categoryId: row.categoryId, name: row.name ?? row.categoryName, source: row.source,
      distribution: row.distribution ?? null, evidence: row.evidence, effective: row.effective };
  });
}

function render(data) {
  const audit = data.audit;
  const analysis = audit && audit.analysis;
  const push = audit && audit.push;
  const results = analysis ? analysis.results : (data.verdicts || []).map(function (entry) {
    return { categoryId: entry.categoryId, name: entry.categoryName, pass: entry.pass, source: entry.source,
      confidence: entry.confidence, evidence: entry.evidence, effective: entry.effective };
  });
  const categories = analysis ? analysis.categories : [];
  const classifications = rows(groupResults(results).map(function (group) {
    const category = categories.find(function (item) { return item.id === group.main.categoryId; });
    return verdictHtml(group.main, category) +
      group.others.map(function (entry) { return subVerdictHtml(entry); }).join('');
  }));
  // 主分类区：生效项 + 分布（仅决策模型有），非生效结论作为次要行
  const primaries = primaryEntries(data, analysis);
  const primaryHtml = primaries.length === 0 ? '' : (function () {
    let main = primaries[0];
    for (let i = 0; i < primaries.length; i++) if (primaries[i].effective) { main = primaries[i]; break; }
    return rows(['<div><strong>主分类</strong> · ' + esc(primaryName(main)) + ' · ' + esc(sourceName(main.source)) + '</div>' +
      (main.distribution ? '<p>' + distributionText(main.distribution) + '</p>' : '') +
      (main.evidence ? '<p>' + esc(main.evidence) + '</p>' : '') +
      primaries.filter(function (entry) { return entry !== main; }).map(function (entry) {
        return '<div class="hint">' + esc(sourceName(entry.source) + ' · ' + primaryName(entry) +
          ' · ' + (entry.evidence || '未提供依据')) + '</div>';
      }).join('')]);
  })();
  const attempts = analysis ? rows((analysis.attempts || []).map(function (attempt) {
    const who = (attempt.channel ? CHANNEL[attempt.channel] + ' · ' : '') + attempt.provider + ' / ' + attempt.model;
    return esc(who) + ' · ' +
      esc({ success: '成功', failed: '失败', skipped: '跳过' }[attempt.status]) +
      (attempt.error ? '<p>' + esc(attempt.error) + '</p>' : '');
  })) : '';
  return '<div class="audit-section"><h3>分类结论</h3><p class="hint">' +
    (analysis ? esc(ANALYSIS_STATUS[analysis.status]) + ' · 用时 ' + (analysis.durationMs ?? 0) + 'ms · 视觉输入 ' + (analysis.imageCount ?? 0) + ' 张'
      : '未记录分析过程；旧分类归档只保留部分结论') + '</p>' +
    (analysis && analysis.fallbackReason ? '<p class="audit-warning">LLM 档不可用：' + esc(analysis.fallbackReason) + '</p>' : '') +
    (analysis && analysis.error ? '<p class="audit-warning">' + esc(analysis.error) + '</p>' : '') +
    (analysis && analysis.skippedImages && analysis.skippedImages.length ? '<p class="audit-warning">未送模型的图片：' +
      esc(analysis.skippedImages.map(function (s) { return s.ref + '（' + s.reason + '）'; }).join('、')) + '</p>' : '') +
    primaryHtml + classifications +
    (analysis && analysis.attempts && analysis.attempts.length ? '<details><summary>模型调用记录</summary>' + attempts + '</details>' : '') + '</div>' +
    '<div class="audit-section"><h3>推送结果</h3>' +
    (push ? '<p><strong>' + esc(PUSH_STATUS[push.status]) + '</strong> · ' + esc(push.reason) + '</p>' +
      (push.title ? '<p>推送词：' + esc(push.title) + '</p>' : '') +
      (push.imageWarning ? '<p class="audit-warning">' + esc(push.imageWarning) + '</p>' : '') +
      (push.translationWarning ? '<p class="audit-warning">译文：' + esc(push.translationWarning) + '</p>' : '') +
      rows(push.rules.map(function (rule) {
        const configuration = rule.configuration;
        return esc(rule.name) + ' · ' + esc(rule.reason) + (configuration ?
          '<details><summary>当时的推送规则</summary><p>分类引用：' +
          (configuration.categoryId == null ? '任意内容' : '#' + configuration.categoryId) +
          '</p><p>范围：' + esc(configuration.scope.length ? configuration.scope.join('、') : '全部（含未来新增）') +
          '</p><p>渠道 ID：' + esc(configuration.channels.join('、') || '未选渠道') +
          '</p><p>推送词：' + esc(configuration.messageTemplate || '内置默认') + '</p></details>' : '');
      })) +
      '<h4>渠道与发送</h4>' + rows(push.channels.map(function (channel) {
        return esc(channel.name) + (channel.enabled ? '' : ' · 已停用');
      })) + rows((push.deliveries || []).map(function (delivery) {
        return esc(delivery.channel + (delivery.target ? ' / ' + delivery.target : '')) + ' · ' +
          (delivery.ok ? '发送成功' : '发送失败') + (delivery.error ? '<p>' + esc(delivery.error) + '</p>' : '');
      })) : '<p class="hint">未记录推送过程，不能据此判断是否发送。旧内容或恢复轮静默归档的帖子可能没有记录。</p>') +
    '</div>' + (analysis && analysis.input ? '<details><summary>当时的内容输入</summary><div class="audit-row"><p>' +
      esc(analysis.input.authorName) + '</p><p>' + esc(analysis.input.text || '无正文') + '</p><p>' +
      esc(JSON.stringify(analysis.input.tags)) + '</p></div></details>' : '') +
    '<div class="hint">分类结论与推送结果分别记录；分类判否仍可能被任意内容规则推送。</div>';
}

export function openContentAudit(subjectType, subjectId, title, level = 1) {
  let closed = false;
  let timer = null;
  openSheet(title || '分类与推送记录', '<div id="content-audit-body">加载中…</div>', level);
  sheetCleanups[level] = function () { closed = true; clearTimeout(timer); };
  const load = function () {
    api('/api/content-audit?subjectType=' + encodeURIComponent(subjectType) + '&subjectId=' + encodeURIComponent(subjectId))
      .then(function (data) {
        if (closed) return;
        const body = document.getElementById('content-audit-body');
        if (!body) return;
        body.innerHTML = render(data);
        if (data.audit && (data.audit.analysis?.status === 'pending' || data.audit.push?.status === 'pending')) timer = setTimeout(load, 2000);
      }).catch(function (error) {
        if (!closed) document.getElementById('content-audit-body').textContent = error.message;
      });
  };
  load();
}

ACTIONS['open-content-audit'] = function (element) {
  const secondLevel = !!element.closest('#sheet-mask1');
  openContentAudit(element.getAttribute('data-kind'), element.getAttribute('data-subject'), '分类与推送记录', secondLevel ? 2 : 1);
};
