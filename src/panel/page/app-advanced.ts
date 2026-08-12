/**
 * 面板前端 · 卡片 高级设置：卡片本体只有「更多高级设置」按钮，点击开一个 sheet
 * 装全部运行时参数（settings 表唯一信源，保存即热生效）的一张表单。
 * 保存 = 一次性 PUT /api/advanced 全字段（服务端 NUM_SPECS/BOOL_SPECS 校验）；
 * 报错内联 .form-err（推送规则弹窗同惯例）。打开时先 GET /api/advanced 填现值。
 * 内嵌进页面 <script>，内容不得出现反引号与 ${，一律字符串拼接，禁用正则。依赖 icons / app-core 段。
 */
export const APP_ADVANCED = `
// 开关行：整行 label 点击切换（checkRowHtml，与规则弹窗多选同控件）
function advBoolRow(id, text, on) {
  return checkRowHtml('id="' + id + '"', on, '<span class="row-title">' + esc(text) + '</span>');
}

function advNum(id) {
  var v = parseInt(document.getElementById(id).value, 10);
  return isNaN(v) ? null : v;
}

ACTIONS['open-advanced'] = function () {
  api('/api/advanced').then(function (j) {
    openSheet('高级设置',
      field('直播轮询间隔（秒，20~3600）', '<input id="adv-poll" value="' + j.pollIntervalSec + '">') +
      field('轮询抖动（秒，0~120）', '<input id="adv-jitter" value="' + j.pollJitterSec + '">') +
      field('连续失败多少次后告警（1~100）', '<input id="adv-threshold" value="' + j.healthAlertAfterFailures + '">') +
      field('关注列表同步间隔（秒，≥300）', '<input id="adv-follows" value="' + j.followsSyncIntervalSec + '">') +
      field('空间动态抓取间隔（秒，≥120）', '<input id="adv-dynamic" value="' + j.dynamicIntervalSec + '">') +
      field('微博时间线抓取间隔（秒，≥120）', '<input id="adv-weibo" value="' + j.weiboIntervalSec + '">') +
      field('LLM 请求超时（秒，1~600）', '<input id="adv-llm-timeout" value="' + Math.round(j.llmRequestTimeoutMs / 1000) + '">') +
      field('LLM 熔断阈值（连续失败次数，1~20）', '<input id="adv-llm-threshold" value="' + j.llmCircuitThreshold + '">') +
      field('LLM 熔断冷却（秒，10~3600）', '<input id="adv-llm-cooldown" value="' + Math.round(j.llmCircuitCooldownMs / 1000) + '">') +
      field('关键帧缓存间隔（秒，60~3600）', '<input id="adv-keyframe" value="' + j.keyframeIntervalSec + '">') +
      '<div class="field"><label>开关</label>' +
      advBoolRow('adv-b-first', '启动时已在播也推送', j.notifyOnFirstRun) +
      advBoolRow('adv-b-newsub', '新增订阅在播即推送', j.notifyOnNewSubscription) +
      advBoolRow('adv-b-onebot', 'QQ 通道', j.notifierOnebotEnabled) +
      advBoolRow('adv-b-toast', '系统通知通道', j.notifierToastEnabled) +
      advBoolRow('adv-b-keyframe', '关键帧缓存', j.keyframeEnabled) +
      '</div>' +
      '<div class="sheet-foot"><span id="adv-err" class="form-err"></span>' +
      '<button class="btn" data-action="close-sheet" data-level="1">取消</button>' +
      '<button class="btn btn-primary" data-action="save-advanced">保存</button></div>');
  }).catch(function (e) { toast(e.message, true); });
};

ACTIONS['save-advanced'] = function () {
  var errEl = document.getElementById('adv-err');
  var ids = ['adv-poll', 'adv-jitter', 'adv-threshold', 'adv-follows', 'adv-dynamic',
    'adv-weibo', 'adv-llm-timeout', 'adv-llm-threshold', 'adv-llm-cooldown', 'adv-keyframe'];
  var vals = {};
  for (var i = 0; i < ids.length; i++) {
    var v = advNum(ids[i]);
    if (v === null) { errEl.textContent = '数值项请输入整数'; return; }
    vals[ids[i]] = v;
  }
  api('/api/advanced', 'PUT', {
    pollIntervalSec: vals['adv-poll'],
    pollJitterSec: vals['adv-jitter'],
    healthAlertAfterFailures: vals['adv-threshold'],
    followsSyncIntervalSec: vals['adv-follows'],
    dynamicIntervalSec: vals['adv-dynamic'],
    weiboIntervalSec: vals['adv-weibo'],
    llmRequestTimeoutMs: vals['adv-llm-timeout'] * 1000,
    llmCircuitThreshold: vals['adv-llm-threshold'],
    llmCircuitCooldownMs: vals['adv-llm-cooldown'] * 1000,
    keyframeIntervalSec: vals['adv-keyframe'],
    notifyOnFirstRun: document.getElementById('adv-b-first').checked,
    notifyOnNewSubscription: document.getElementById('adv-b-newsub').checked,
    notifierOnebotEnabled: document.getElementById('adv-b-onebot').checked,
    notifierToastEnabled: document.getElementById('adv-b-toast').checked,
    keyframeEnabled: document.getElementById('adv-b-keyframe').checked,
  }).then(function () {
    closeSheet(1);
    toast('已保存并生效');
  }).catch(function (e) { errEl.textContent = e.message; });
};
`;
