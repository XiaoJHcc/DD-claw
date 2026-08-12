/**
 * 面板前端 · 卡片 高级设置：运行时参数（settings 表唯一信源，保存即热生效）。
 * 行 = 直播轮询 / 冷启动推送两开关 / 连续失败告警 / 抓取间隔 / LLM 高级 / 推送通道两开关。
 * 数值组点击行进 sheet 编辑；开关行用 checkdot 直改（data-change）。
 * 内嵌进页面 <script>，内容不得出现反引号与 ${，一律字符串拼接，禁用正则。依赖 icons / app-core 段。
 */
export const APP_ADVANCED = `
var advCache = null;

function advBoolRow(name, field, on) {
  return '<div class="row"><span class="row-title">' + name + '</span>' +
    '<span class="row-end">' +
    checkDotHtml('data-change="toggle-adv-bool" data-field="' + field + '"', on) +
    '</span></div>';
}

function loadAdvanced() {
  return api('/api/advanced').then(function (j) {
    advCache = j;
    document.getElementById('advanced-rows').innerHTML =
      '<div class="row row-click" data-action="edit-adv-poll">' +
      '<span class="row-title">直播轮询</span>' +
      '<span class="row-end"><span class="row-sub">间隔 ' + j.pollIntervalSec + 's · 抖动 ' + j.pollJitterSec + 's</span>' +
      icon('chevron-right') + '</span></div>' +
      advBoolRow('启动时已在播也推送', 'notifyOnFirstRun', j.notifyOnFirstRun) +
      advBoolRow('新增订阅在播即推送', 'notifyOnNewSubscription', j.notifyOnNewSubscription) +
      '<div class="row row-click" data-action="edit-adv-threshold">' +
      '<span class="row-title">连续失败告警</span>' +
      '<span class="row-end"><span class="row-sub">连续 ' + j.healthAlertAfterFailures + ' 次</span>' +
      icon('chevron-right') + '</span></div>' +
      '<div class="row row-click" data-action="edit-adv-intervals">' +
      '<span class="row-title">抓取间隔</span>' +
      '<span class="row-end"><span class="row-sub">关注 ' + j.followsSyncIntervalSec + 's · 动态 ' + j.dynamicIntervalSec + 's · 微博 ' + j.weiboIntervalSec + 's</span>' +
      icon('chevron-right') + '</span></div>' +
      '<div class="row row-click" data-action="edit-adv-llm">' +
      '<span class="row-title">LLM 高级</span>' +
      '<span class="row-end"><span class="row-sub">超时 ' + Math.round(j.llmRequestTimeoutMs / 1000) + 's · 熔断 ' + j.llmCircuitThreshold + ' 次 · 冷却 ' + Math.round(j.llmCircuitCooldownMs / 1000) + 's</span>' +
      icon('chevron-right') + '</span></div>' +
      advBoolRow('QQ 通道', 'notifierOnebotEnabled', j.notifierOnebotEnabled) +
      advBoolRow('系统通知通道', 'notifierToastEnabled', j.notifierToastEnabled);
  }).catch(function (e) { toast(e.message, true); });
}

CHANGES['toggle-adv-bool'] = function (el) {
  var body = {};
  body[el.getAttribute('data-field')] = el.checked;
  api('/api/advanced', 'PUT', body).then(function () {
    toast('已保存并生效');
  }).catch(function (e) { toast(e.message, true); });
  loadAdvanced();
};

function advNum(id) {
  var v = parseInt(document.getElementById(id).value, 10);
  return isNaN(v) ? null : v;
}

function advSheet(title, fieldsHtml, saveAction) {
  openSheet(title, fieldsHtml +
    '<div class="sheet-foot"><button class="btn" data-action="close-sheet" data-level="1">取消</button>' +
    '<button class="btn btn-primary" data-action="' + saveAction + '">保存</button></div>');
}

ACTIONS['edit-adv-poll'] = function () {
  if (!advCache) { toast('状态未加载', true); return; }
  advSheet('直播轮询',
    field('轮询间隔（秒，20~3600）', '<input id="adv-poll" value="' + advCache.pollIntervalSec + '">') +
    field('抖动（秒，0~120）', '<input id="adv-jitter" value="' + advCache.pollJitterSec + '">'),
    'save-adv-poll');
};

ACTIONS['save-adv-poll'] = function () {
  var poll = advNum('adv-poll'); var jitter = advNum('adv-jitter');
  if (poll === null || jitter === null) { toast('请输入整数', true); return; }
  api('/api/advanced', 'PUT', { pollIntervalSec: poll, pollJitterSec: jitter }).then(function () {
    closeSheet(1); toast('已保存并生效'); loadAdvanced();
  }).catch(function (e) { toast(e.message, true); });
};

ACTIONS['edit-adv-threshold'] = function () {
  if (!advCache) { toast('状态未加载', true); return; }
  advSheet('连续失败告警',
    field('连续失败多少次后告警（1~100）', '<input id="adv-threshold" value="' + advCache.healthAlertAfterFailures + '">'),
    'save-adv-threshold');
};

ACTIONS['save-adv-threshold'] = function () {
  var n = advNum('adv-threshold');
  if (n === null) { toast('请输入整数', true); return; }
  api('/api/advanced', 'PUT', { healthAlertAfterFailures: n }).then(function () {
    closeSheet(1); toast('已保存并生效'); loadAdvanced();
  }).catch(function (e) { toast(e.message, true); });
};

ACTIONS['edit-adv-intervals'] = function () {
  if (!advCache) { toast('状态未加载', true); return; }
  advSheet('抓取间隔',
    field('关注列表同步（秒，≥300）', '<input id="adv-follows" value="' + advCache.followsSyncIntervalSec + '">') +
    field('空间动态（秒，≥120）', '<input id="adv-dynamic" value="' + advCache.dynamicIntervalSec + '">') +
    field('微博时间线（秒，≥120）', '<input id="adv-weibo" value="' + advCache.weiboIntervalSec + '">'),
    'save-adv-intervals');
};

ACTIONS['save-adv-intervals'] = function () {
  var f = advNum('adv-follows'); var d = advNum('adv-dynamic'); var w = advNum('adv-weibo');
  if (f === null || d === null || w === null) { toast('请输入整数', true); return; }
  api('/api/advanced', 'PUT', { followsSyncIntervalSec: f, dynamicIntervalSec: d, weiboIntervalSec: w }).then(function () {
    closeSheet(1); toast('已保存并生效'); loadAdvanced();
  }).catch(function (e) { toast(e.message, true); });
};

ACTIONS['edit-adv-llm'] = function () {
  if (!advCache) { toast('状态未加载', true); return; }
  advSheet('LLM 高级',
    field('请求超时（秒，1~600）', '<input id="adv-llm-timeout" value="' + Math.round(advCache.llmRequestTimeoutMs / 1000) + '">') +
    field('熔断阈值（连续失败次数，1~20）', '<input id="adv-llm-threshold" value="' + advCache.llmCircuitThreshold + '">') +
    field('熔断冷却（秒，10~3600）', '<input id="adv-llm-cooldown" value="' + Math.round(advCache.llmCircuitCooldownMs / 1000) + '">'),
    'save-adv-llm');
};

ACTIONS['save-adv-llm'] = function () {
  var t = advNum('adv-llm-timeout'); var th = advNum('adv-llm-threshold'); var cd = advNum('adv-llm-cooldown');
  if (t === null || th === null || cd === null) { toast('请输入整数', true); return; }
  api('/api/advanced', 'PUT', {
    llmRequestTimeoutMs: t * 1000, llmCircuitThreshold: th, llmCircuitCooldownMs: cd * 1000,
  }).then(function () {
    closeSheet(1); toast('已保存并生效'); loadAdvanced();
  }).catch(function (e) { toast(e.message, true); });
};

loadAdvanced();
`;
