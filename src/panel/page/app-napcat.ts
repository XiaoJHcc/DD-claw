/**
 * 面板前端 · 卡片 NapCat：右上角「使用 NapCat 通道」总开关 + 状态行 / 路径 /
 * 机器人QQ / 超时失败告警QQ号 / 失活自动拉起开关 五行 + 底部「手动拉起」按钮。
 * 编辑走 sheet（留空 = 清空该字段，settings 表是唯一信源，无 config 回落）。
 * 「失活自动拉起」= 独立开关：开启时建拉起任务（Windows 弹一次 UAC，macOS 无任务
 * 直接 open QQ），关闭时彻底移除任务。状态每 30s 重取（GET 是一次真实探测）。
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
    var hasUin = !!j.uin;
    var ncSwitch = document.getElementById('napcat-enabled');
    // 没填机器人 QQ 号 = 无法装配 onebot（端点配置文件名含 uin），开关禁用并显示关闭
    ncSwitch.checked = hasUin && !!j.enabled;
    ncSwitch.disabled = !hasUin;
    var st = napcatStateHtml(j);
    // 未显式设置路径时 macOS 显示简短文案，显式路径靠 row-sub 的 ellipsis 截断
    var dirText = (j.source && j.source.dir === 'panel') ? j.dir : (j.platform === 'win32' ? '未设置' : '自动检测');
    var needUinEl = document.getElementById('napcat-need-uin');
    if (needUinEl) needUinEl.style.display = hasUin ? 'none' : '';
    var ar = !!j.autorestart;
    document.getElementById('napcat-rows').innerHTML =
      '<div class="row"><span class="dot ' + st.cls + '"></span>' +
      '<span class="row-title">' + st.text + '</span>' +
      '<span class="row-end"><span class="row-sub" title="' + esc(j.endpoint || '') + '">' + esc(j.endpoint || '') + '</span></span></div>' +
      '<div class="row row-click" data-action="edit-napcat">' +
      '<span class="row-title">路径</span>' +
      '<span class="row-end"><span class="row-sub" title="' + esc(j.dir || '') + '">' + esc(dirText) + '</span>' +
      icon('chevron-right') + '</span></div>' +
      '<div class="row row-click" data-action="edit-napcat">' +
      '<span class="row-title">机器人 QQ</span>' +
      '<span class="row-end"><span class="row-sub">' + esc(j.uin || '未设置') + '</span>' +
      icon('chevron-right') + '</span></div>' +
      '<div class="row row-click" data-action="edit-napcat">' +
      '<span class="row-title">超时失败告警 QQ 号</span>' +
      '<span class="row-end"><span class="row-sub">' + esc(j.alertQq || '不告警') + '</span>' +
      icon('chevron-right') + '</span></div>' +
      '<div class="row"><span class="row-title">失活自动拉起</span>' +
      '<span class="row-end"><label class="switch"><input type="checkbox" id="napcat-autorestart" data-change="toggle-napcat-autorestart"' +
      (ar ? ' checked' : '') + (hasUin ? '' : ' disabled') + '><span class="knob"></span></label></span></div>';
  }).catch(function (e) { toast(e.message, true); });
}

CHANGES['toggle-napcat'] = function (el) {
  var on = el.checked;
  api('/api/napcat', 'PUT', { enabled: on })
    .then(function () { toast(on ? 'NapCat 通道已启用' : 'NapCat 通道已停用'); })
    .catch(function (e) { toast(e.message, true); loadNapcat(); });
};

CHANGES['toggle-napcat-autorestart'] = function (el) {
  var on = el.checked;
  if (on && ncCache && ncCache.platform === 'win32') toast('主机上将弹一次 UAC，请确认');
  api('/api/napcat', 'PUT', { autorestart: on })
    .then(function () { toast(on ? '失活自动拉起已开启' : '失活自动拉起已关闭（拉起任务已移除）'); loadNapcat(); })
    .catch(function (e) { toast(e.message, true); loadNapcat(); });
};

ACTIONS['edit-napcat'] = function () {
  if (!ncCache) { toast('状态未加载', true); return; }
  var isWin = ncCache.platform === 'win32';
  // 只有显式在面板填过的 dir 才回显；darwin 未填 = 自动检测（placeholder 里带出完整路径）
  var dirValue = (ncCache.source && ncCache.source.dir === 'panel') ? ncCache.dir : '';
  var dirPlaceholder = isWin ? '如 D:\\\\CLI\\\\NapCat.Shell' : '自动检测（' + ncCache.dir + '）';
  openSheet('NapCat 配置',
    field('目录', '<input id="nc-dir" autocomplete="off" value="' + esc(dirValue) +
      '" placeholder="' + esc(dirPlaceholder) + '">') +
    field('机器人 QQ 号', '<input id="nc-uin" autocomplete="off" value="' + esc(ncCache.uin || '') +
      '" placeholder="' + (isWin ? '快速登录的 QQ 号' : '扫码登录的 QQ 号') + '">') +
    field('超时失败告警 QQ 号', '<input id="nc-alert-qq" autocomplete="off" value="' + esc(ncCache.alertQq || '') +
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
      toast('已拉起 NapCat');
      setTimeout(loadNapcat, 5000);
    })
    .catch(function (e) { toast(e.message, true); });
};

setInterval(loadNapcat, 30000);
loadNapcat();
`;
