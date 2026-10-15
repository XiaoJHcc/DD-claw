import { api, ACTIONS, esc, openSheet, sheetCleanups } from './core.js';

const STATUS = { pending: '处理中', done: '已分类', failed: '失败', skipped: '未推送',
  sent: '发送成功', partial: '部分发送成功', 'dry-run': '演练，未实际发送' };
const SOURCE = { llm: 'LLM', rule: '确定性条件', decision: '决策模型' };

function rows(items) {
  return items.length ? items.map(function (item) { return '<div class="audit-row">' + item + '</div>'; }).join('')
    : '<p class="hint">无记录</p>';
}

function render(data) {
  const audit = data.audit;
  const analysis = audit && audit.analysis;
  const push = audit && audit.push;
  const results = analysis ? analysis.results : (data.verdicts || []).map(function (entry) {
    return { name: entry.categoryName, pass: entry.pass, source: entry.source, confidence: entry.confidence, evidence: entry.evidence };
  });
  const categories = analysis ? analysis.categories : [];
  const classifications = rows(results.map(function (entry) {
    const category = categories.find(function (item) { return item.id === entry.categoryId; });
    const conditions = category ? [
      category.keywords.length ? '关键词：' + category.keywords.join('、') : '',
      category.areas.length ? '分区：' + category.areas.join('、') : '',
      category.postTypes.length ? '帖子类型：' + category.postTypes.map(function (kind) { return kind === 'original' ? '原创' : '转发'; }).join('、') : '',
      category.requireQuote ? '须引用' : '', category.requireMedia ? '须带图' : '',
    ].filter(Boolean).join(category.condMode === 'or' ? ' 或 ' : ' 且 ') : '';
    return '<div><strong>' + esc(entry.name) + '</strong> · ' + (entry.pass ? '属于' : '不属于') +
      ' · ' + esc(SOURCE[entry.source] || entry.source) +
      (entry.confidence != null ? ' · 置信度 ' + entry.confidence.toFixed(2) : '') + '</div>' +
      '<p>' + esc(entry.evidence || '未提供依据') + '</p>' +
      (category ? '<details><summary>当时的分类标准</summary>' +
        (category.llmPrompt ? '<p>LLM 提示词：' + esc(category.llmPrompt) + '</p>' : '') +
        (conditions ? '<p>确定性条件：' + esc(conditions) + '</p>' : '') + '</details>' : '');
  }));
  const attempts = analysis ? rows((analysis.attempts || []).map(function (attempt) {
    return esc(attempt.provider + ' / ' + attempt.model) + ' · ' +
      esc({ success: '成功', failed: '失败', skipped: '跳过' }[attempt.status]) +
      (attempt.error ? '<p>' + esc(attempt.error) + '</p>' : '');
  })) : '';
  return '<div class="audit-section"><h3>分类结论</h3><p class="hint">' +
    (analysis ? esc(STATUS[analysis.status]) + ' · 用时 ' + (analysis.durationMs ?? 0) + 'ms · 视觉输入 ' + (analysis.imageCount ?? 0) + ' 张'
      : '未记录分析过程；旧分类归档只保留部分结论') + '</p>' +
    (analysis && analysis.fallbackReason ? '<p class="audit-warning">回退确定性条件：' + esc(analysis.fallbackReason) + '</p>' : '') +
    (analysis && analysis.error ? '<p class="audit-warning">' + esc(analysis.error) + '</p>' : '') +
    classifications + (analysis && analysis.attempts && analysis.attempts.length ? '<details><summary>模型调用记录</summary>' + attempts + '</details>' : '') + '</div>' +
    '<div class="audit-section"><h3>推送结果</h3>' +
    (push ? '<p><strong>' + esc(STATUS[push.status]) + '</strong> · ' + esc(push.reason) + '</p>' +
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
