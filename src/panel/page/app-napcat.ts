/**
 * 面板前端 · 卡片 NapCat 托管：总开关（右上角）+ 状态行 / 路径 / 机器人QQ /
 * 超时失败告警QQ号 四行 + 底部「手动拉起 / 添加自动拉起任务」按钮。编辑走 sheet
 *（留空 = 清空该字段，settings 表是唯一信源，无 config 回落）。状态每 30s 重取
 *（GET 是一次真实探测）。
 * 内嵌进页面 <script>，内容不得出现反引号与 ${，一律字符串拼接。依赖 icons / app-core 段。
 */
export const APP_NAPCAT = `
var ncCache = null;

function napcatStateHtml(j) {
  if (!j.endpoint) return { cls: 'gray', text: '未发现 onebot11 配置' };
  if (!j.probe) return { cls: 'gray', text: '未探测' };
  if (j.probe.state === 'ok') {
    return j.probe.loggedIn
      ? { cls: 'green', text: '在线 · QQ 已登录' }
      : { cls: 'yellow', text: '在线 · QQ 未登录（需扫码）' };
  }
  if (j.probe.state === 'conflict') return { cls: 'red', text: '端口被其他程序占用' };
  return { cls: 'red', text: '不在线' };
}

function loadNapcat() {
  return api('/api/napcat').then(function (j) {
    ncCache = j;
    document.getElementById('napcat-enabled').checked = !!j.enabled;
    var st = napcatStateHtml(j);
    document.getElementById('napcat-rows').innerHTML =
      '<div class="row"><span class="dot ' + st.cls + '"></span>' +
      '<span class="row-title">' + st.text + '</span>' +
      '<span class="row-end"><span class="row-sub">' + esc(j.endpoint || '') + '</span></span></div>' +
      '<div class="row row-click" data-action="edit-napcat">' +
      '<span class="row-title">路径</span>' +
      '<span class="row-end"><span class="row-sub">' + esc(j.dir || '未设置') + '</span>' +
      icon('chevron-right') + '</span></div>' +
      '<div class="row row-click" data-action="edit-napcat">' +
      '<span class="row-title">机器人 QQ</span>' +
      '<span class="row-end"><span class="row-sub">' + esc(j.uin || '未设置') + '</span>' +
      icon('chevron-right') + '</span></div>' +
      '<div class="row row-click" data-action="edit-napcat">' +
      '<span class="row-title">超时失败告警 QQ 号</span>' +
      '<span class="row-end"><span class="row-sub">' + esc(j.alertQq || '不告警') + '</span>' +
      icon('chevron-right') + '</span></div>' +
      (j.taskRegistered ? '' :
        '<div class="hint">计划任务未创建：点下方「添加自动拉起任务」一次性设置（主机弹一次 UAC），否则自动拉起不可用</div>');
  }).catch(function (e) { toast(e.message, true); });
}

CHANGES['toggle-napcat'] = function (el) {
  var on = el.checked;
  api('/api/napcat', 'PUT', { enabled: on })
    .then(function () { toast(on ? 'NapCat 托管已启用' : 'NapCat 托管已停用'); })
    .catch(function (e) { toast(e.message, true); loadNapcat(); });
};

ACTIONS['edit-napcat'] = function () {
  if (!ncCache) { toast('状态未加载', true); return; }
  openSheet('NapCat 配置',
    field('一键包目录', '<input id="nc-dir" value="' + esc(ncCache.dir || '') +
      '" placeholder="如 D:\\\\CLI\\\\NapCat.Shell">') +
    field('机器人 QQ 号', '<input id="nc-uin" value="' + esc(ncCache.uin || '') +
      '" placeholder="快速登录的 QQ 号">') +
    field('超时失败告警 QQ 号', '<input id="nc-alert-qq" value="' + esc(ncCache.alertQq || '') +
      '" placeholder="留空 = 不向 QQ 告警">') +
    '<div class="sheet-foot"><button class="btn" data-action="close-sheet" data-level="1">取消</button>' +
    '<button class="btn btn-primary" data-action="save-napcat">保存</button></div>');
};

ACTIONS['save-napcat'] = function () {
  api('/api/napcat', 'PUT', {
    dir: document.getElementById('nc-dir').value.trim(),
    uin: document.getElementById('nc-uin').value.trim(),
    alertQq: document.getElementById('nc-alert-qq').value.trim(),
  }).then(function () {
    closeSheet(1);
    toast('已保存');
    loadNapcat();
  }).catch(function (e) { toast(e.message, true); });
};

ACTIONS['napcat-launch'] = function () {
  api('/api/napcat/launch', 'POST')
    .then(function () {
      toast('已通过计划任务拉起 NapCat');
      setTimeout(loadNapcat, 5000);
    })
    .catch(function (e) { toast(e.message, true); });
};

ACTIONS['napcat-setup'] = function () {
  toast('主机上将弹一次 UAC，请确认');
  api('/api/napcat/setup', 'POST')
    .then(function () { toast('计划任务已创建'); loadNapcat(); })
    .catch(function (e) { toast(e.message, true); });
};

setInterval(loadNapcat, 30000);
loadNapcat();
`;
