// 面板前端 · 卡片 NapCat（v2 形态）：右上角「使用 NapCat 通道」总开关 + 状态行 /
// 路径 / 机器人QQ / 超时失败告警QQ号 / 失活自动拉起开关 五个主副双行（.row-2）。
// 状态行 = 状态点 + 主标题状态文案 + 副行端点；配置行整行可点（行尾 .row-afford
// 右箭头仅可点性提示，非按钮）；自动拉起行副行显示拉起能力状态（taskRegistered）。
// 编辑走 sheet（留空 = 清空该字段，settings 表是唯一信源，无 config 回落）。
// 「失活自动拉起」= 独立开关：开启时建拉起任务（Windows 弹一次 UAC，macOS 无任务
// 直接 open QQ），关闭时彻底移除任务。状态每 30s 重取（GET 是一次真实探测）。
// 配置不当守卫（configReady = NapCat 自己跑通过）：未填路径/QQ、NapCat 未跑通时
// 禁用「失活自动拉起」，原因与做法直接写进可见副行（不用 hover 浮窗）；
// 「手动拉起」始终可点——不行时服务端 400 透传中文原因 toast 出来。
import { api, toast, ACTIONS, CHANGES, esc, field, openSheet, closeSheet, switchHtml, onTableRefresh } from './core.js';
import { icon } from './icons.js';

let ncCache = null;

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
    const isWin = j.platform === 'win32';
    const hasUin = !!j.uin;
    const hasDir = !!j.dir; // macOS 未显式设置时回落自动检测路径，dir 恒非空
    const configReady = !!j.configReady;
    const runOnceSub = isWin
      ? '先跑通 NapCat：手动运行一次 launcher.bat 登录 QQ'
      : '先跑通 NapCat：打开一次 QQ 并登录';
    const ncSwitch = document.getElementById('napcat-enabled');
    // 没填机器人 QQ 号 = 无法装配 onebot（端点配置文件名含 uin），开关禁用并显示关闭
    ncSwitch.checked = hasUin && !!j.enabled;
    ncSwitch.disabled = !hasUin;
    const st = napcatStateHtml(j);
    // 未显式设置路径时 macOS 显示简短文案，显式路径靠 row-sub 的 ellipsis 截断
    const dirText = (j.source && j.source.dir === 'panel') ? j.dir : (j.platform === 'win32' ? '未设置' : '自动检测');
    const needUinEl = document.getElementById('napcat-need-uin');
    if (needUinEl) needUinEl.style.display = hasUin ? 'none' : '';
    const ar = !!j.autorestart;
    // 配置行（路径/QQ/告警QQ）同构：标题 + 值副行，整行可点
    const cfgRow = function (title, val, tip) {
      return '<div class="row row-2 row-click" data-action="edit-napcat">' +
        `<span class="row-main"><span class="row-line"><span class="row-title">${title}</span></span>` +
        `<span class="row-sub"${tip ? ` title="${esc(tip)}"` : ''}>${esc(val)}</span></span>` +
        `<span class="row-end"><span class="row-afford">${icon('chevron')}</span></span></div>`;
    };
    // 状态行副行：有端点显示端点（title 供截断时看全）；没端点时这一格空转，
    // 直接拿来放「怎么办」指引——没填路径 → 填什么；填了 → 先跑通 NapCat
    const stSub = j.endpoint || (!hasDir && isWin
      ? '先在「路径」填 NapCat 目录（launcher.bat 所在目录）'
      : runOnceSub);
    // 自动拉起行：配置不全 / NapCat 未跑通时禁用，原因与做法直接写进副行
    let arSub, arDisabled = false;
    if (!hasUin || (isWin && !hasDir)) {
      arSub = '先填路径与机器人 QQ'; arDisabled = true;
    } else if (!configReady) {
      arSub = '未跑通 · ' + (isWin ? '先手动跑一次 launcher.bat' : '先打开一次 QQ 登录'); arDisabled = true;
    } else {
      arSub = j.taskRegistered ? '拉起任务已就绪'
        : (isWin ? '未就绪 · 开启将创建任务（弹一次 UAC）' : '未就绪 · 未找到 QQ.app');
    }
    document.getElementById('napcat-rows').innerHTML =
      `<div class="row row-2"><span class="dot ${st.cls}"></span>` +
      `<span class="row-main"><span class="row-line"><span class="row-title">${st.text}</span></span>` +
      `<span class="row-sub"${j.endpoint ? ` title="${esc(j.endpoint)}"` : ''}>${esc(stSub)}</span></span></div>` +
      cfgRow('路径', dirText, j.dir || '') +
      cfgRow('机器人 QQ', j.uin || '未设置') +
      cfgRow('超时失败告警 QQ 号', j.alertQq || '不告警') +
      '<div class="row row-2"><span class="row-main"><span class="row-line">' +
      '<span class="row-title">失活自动拉起</span></span>' +
      `<span class="row-sub">${arSub}</span></span>` +
      '<span class="row-end">' +
      switchHtml('id="napcat-autorestart" data-change="toggle-napcat-autorestart"', ar, arDisabled) +
      '</span></div>';
    // 「手动拉起」始终可点：不行时服务端 400 透传中文原因，toast 出来即指引
  }).catch(function (e) { toast(e.message, true); });
}

CHANGES['toggle-napcat'] = function (el) {
  const on = el.checked;
  api('/api/napcat', 'PUT', { enabled: on })
    .then(function () { toast(on ? 'NapCat 通道已启用' : 'NapCat 通道已停用'); })
    .catch(function (e) { toast(e.message, true); loadNapcat(); });
};

CHANGES['toggle-napcat-autorestart'] = function (el) {
  const on = el.checked;
  if (on && ncCache && ncCache.platform === 'win32') toast('主机上将弹一次 UAC，请确认');
  api('/api/napcat', 'PUT', { autorestart: on })
    .then(function () { toast(on ? '失活自动拉起已开启' : '失活自动拉起已关闭（拉起任务已移除）'); loadNapcat(); })
    .catch(function (e) { toast(e.message, true); loadNapcat(); });
};

ACTIONS['edit-napcat'] = function () {
  if (!ncCache) { toast('状态未加载', true); return; }
  const isWin = ncCache.platform === 'win32';
  // 只有显式在面板填过的 dir 才回显；darwin 未填 = 自动检测（placeholder 里带出完整路径）
  const dirValue = (ncCache.source && ncCache.source.dir === 'panel') ? ncCache.dir : '';
  const dirPlaceholder = isWin ? '如 D:\\CLI\\NapCat.Shell' : '自动检测（' + ncCache.dir + '）';
  openSheet('NapCat 配置',
    field('目录', `<input id="nc-dir" autocomplete="off" value="${esc(dirValue)}"` +
      ` placeholder="${esc(dirPlaceholder)}">`) +
    field('机器人 QQ 号', `<input id="nc-uin" autocomplete="off" value="${esc(ncCache.uin || '')}"` +
      ` placeholder="${isWin ? '快速登录的 QQ 号' : '扫码登录的 QQ 号'}">`) +
    field('超时失败告警 QQ 号', `<input id="nc-alert-qq" autocomplete="off" value="${esc(ncCache.alertQq || '')}"` +
      ' placeholder="留空 = 不向 QQ 告警">') +
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
// NapCat 配置在 settings 表（napcat_*）——撤销后重拉本卡
onTableRefresh(['settings'], loadNapcat);
