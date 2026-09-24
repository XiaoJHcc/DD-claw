// 面板前端 · 主播分页 · 监听卡：B站登录行（点击开统一扫码弹窗）。直播间开播轮询不依赖登录，
// 常开无开关；监听主播的空间动态归档随 B站登录常开（预告分析等要用，2026-09-20 拆分决策）
// ——「监听动态」开关已搬去「图文」分页的 B站动态卡，且只管动态账号名单（bili_accounts）。
// 微博行也在「图文」分页（x.js），扫码登录流程经 openPlatformLogin 导出复用（两平台同构，差异参数化）。
// 视觉 = v2：行 = 内嵌圆角矩形（白底 hover 浅底，主副双行 .row-2 恒 66）；
// 登录行整行可点（.row-click），行尾二维码图标只是可点性提示（.row-afford），不是按钮。
import { api, toast, ACTIONS, CHANGES, openSheet, closeSheet, sheetCleanups, checkRowHtml, esc, field, onTableRefresh } from './core.js';
import { icon } from './icons.js';
import qrcode from './qr-lib.js';

export const PLAT_STATE = {
  ok: ['ok', '已登录'], imported: ['ok', '已登录'],
  expired: ['bad', '已失效'], none: ['none', '未登录'], reserved: ['none', '预留'],
};
let listenState = null;

function platformByKey(key) {
  const ps = (listenState && listenState.platforms) || [];
  for (let i = 0; i < ps.length; i++) if (ps[i].key === key) return ps[i];
  return null;
}

function loadListen() {
  return api('/api/listen').then(function (s) {
    listenState = s;
    document.getElementById('listen-rows').innerHTML = loginRow('B站 登录', platformByKey('bili'), 'bili');
  }).catch(function (e) { toast(e.message, true); });
}

// 登录行：整行可点（开扫码弹窗），状态进副行，行尾二维码 = .row-afford 可点性提示
function loginRow(name, plat, key) {
  const st = (plat && PLAT_STATE[plat.state]) || ['none', '未登录'];
  return `<div class="row row-2 row-click" data-action="open-login" data-platform="${key}">` +
    `<span class="dot ${st[0]}"></span>` +
    `<span class="row-main"><span class="row-line"><span class="row-title">${name}</span></span>` +
    `<span class="row-sub">${st[1]}</span></span>` +
    `<span class="row-end"><span class="row-afford">${icon('qrcode')}</span></span>` +
    '</div>';
}

// 「监听动态」等各监听开关统一在「图文」分页（x.js 的 toggle-*-listen）；本卡只有登录行

// ---- 统一平台登录流程：两平台同构，差异全部参数化（id 标签 / 提示文案 / 二维码生成与轮询地址） ----
// B站二维码用内嵌 qr 库渲染 svg；微博是 png 直链，直接 <img> 显示，不用内嵌二维码库。
// 二维码舱（.qr-box）固定高度 + 固定二维码尺寸：初始为空态（居中「扫码登录」按钮），
// 生成后 innerHTML 换成二维码，容器大小不变；过期时把按钮换回来便于重新生成。
function qrEmptyHtml() {
  return `<button class="btn btn-primary" data-action="start-qr">${icon('qrcode')}扫码登录</button>`;
}
const LOGIN_PLATFORMS = {
  bili: {
    title: 'B站 登录态', idLabel: 'mid', scanHint: '请使用 B站 App 扫码',
    generate: function () {
      return api('/api/auth/bili/qrcode', 'POST').then(function (j) {
        const qr = qrcode(0, 'M');
        qr.addData(j.url);
        qr.make();
        return {
          html: qr.createSvgTag({ cellSize: 4, margin: 2 }),
          poll: function () { return api('/api/auth/bili/qrcode/poll?key=' + encodeURIComponent(j.key)); },
        };
      });
    },
  },
  weibo: {
    title: '微博 登录态', idLabel: 'uid', scanHint: '请使用微博 App 扫码',
    generate: function () {
      return api('/api/auth/weibo/qrcode', 'POST').then(function (j) {
        return {
          html: `<img src="${esc(j.image)}" width="176" height="176" alt="微博登录二维码">`,
          poll: function () { return api('/api/auth/weibo/qrcode/poll'); },
        };
      });
    },
  },
};
let loginTimer = null, loginPoll = null, loginPlatform = null;

function stopLoginPoll() {
  if (loginTimer) { clearInterval(loginTimer); loginTimer = null; }
  loginPoll = null;
}

/** 统一扫码登录弹窗：B站行（本卡）与微博行（图文分页）共用；plat = /api/listen platforms 里的对应项 */
export function openPlatformLogin(key, plat) {
  const conf = LOGIN_PLATFORMS[key];
  if (!conf) return;
  const st = (plat && PLAT_STATE[plat.state]) || ['none', '未知'];
  loginPlatform = key;
  openSheet(conf.title,
    `<div class="login-status"><span class="dot ${st[0]}"></span>${st[1]}` +
      `<span class="row-sub">${conf.idLabel} ${esc((plat && plat.mid) || '—')}</span></div>` +
    `<div class="qr-box" id="qr-box">${qrEmptyHtml()}</div>` +
    `<div id="qr-msg" class="qr-status"></div>`);
  sheetCleanups[1] = stopLoginPoll;
}

ACTIONS['open-login'] = function (el) {
  openPlatformLogin(el.getAttribute('data-platform'), platformByKey(el.getAttribute('data-platform')));
};

ACTIONS['start-qr'] = function () {
  const conf = LOGIN_PLATFORMS[loginPlatform];
  if (!conf) return;
  stopLoginPoll();
  conf.generate().then(function (g) {
    const box = document.getElementById('qr-box');
    if (!box) return; // 弹窗已关
    box.innerHTML = g.html;
    document.getElementById('qr-msg').textContent = conf.scanHint;
    loginPoll = g.poll;
    loginTimer = setInterval(pollLoginQr, 2000);
  }).catch(function (e) { toast(e.message, true); });
};

function pollLoginQr() {
  if (!loginPoll) return;
  loginPoll().then(function (j) {
    const msg = document.getElementById('qr-msg');
    if (!msg) return; // 弹窗已关
    if (j.status === 'waiting') return;
    if (j.status === 'scanned') { msg.textContent = '已扫码，请在手机确认'; return; }
    stopLoginPoll();
    if (j.status === 'confirmed') {
      closeSheet(1); toast('登录成功'); loadListen();
      if (loginConfirmedHook) loginConfirmedHook(); // 微博行在「图文」分页，登录成功同步刷新那边
      return;
    }
    if (j.status === 'expired') {
      msg.textContent = '二维码已过期，请重新点击「扫码登录」生成';
      const box = document.getElementById('qr-box');
      if (box) box.innerHTML = qrEmptyHtml(); // 把按钮换回来便于重新生成
    }
  }).catch(function () {});
}

// ---- 抓取设置（监听卡底部按钮）：关注列表 / 直播间轮询 / 关键帧 / 空间动态 7 项 ----
// （微博抓取间隔随微博两行搬到「图文」分页的微博卡弹窗）
// v2 表单观感：分组标题 .adv-group + .field 纵向 16 间距 + 并排 .two，范围写进字段标签小字
/** 微博扫码登录成功后的额外刷新回调（x.js 注册，刷新图文分页的微博行） */
var loginConfirmedHook = null;
export function setLoginConfirmedHook(fn) { loginConfirmedHook = fn; }
function advNum(id) {
  const v = parseInt(document.getElementById(id).value, 10);
  return isNaN(v) ? null : v;
}
function advGroup(text) {
  return `<div class="adv-group">${esc(text)}</div>`;
}
function advField(label, id, value) {
  return field(label, `<input class="inp" type="number" id="${id}" value="${value}">`);
}

ACTIONS['open-fetch-settings'] = function () {
  api('/api/advanced').then(function (j) {
    openSheet('抓取设置',
      advGroup('关注列表') +
      advField('同步间隔（秒，≥300）', 'ft-follows', j.followsSyncIntervalSec) +
      advGroup('直播间轮询') +
      '<div class="two">' +
      advField('轮询间隔（秒，20~3600）', 'ft-poll', j.pollIntervalSec) +
      advField('轮询抖动（秒，0~120）', 'ft-jitter', j.pollJitterSec) +
      '</div>' +
      advField('连续失败多少次后告警（1~100）', 'ft-threshold', j.healthAlertAfterFailures) +
      '<div class="two">' +
      field('关键帧缓存', checkRowHtml('id="ft-b-keyframe"', j.keyframeEnabled, '缓存直播关键帧')) +
      advField('缓存间隔（秒，60~3600）', 'ft-keyframe', j.keyframeIntervalSec) +
      '</div>' +
      advGroup('动态') +
      advField('B站动态抓取间隔（秒，≥120）', 'ft-dynamic', j.dynamicIntervalSec),
      1,
      `<span id="ft-err" class="form-err"></span>` +
      `<button class="btn" data-action="close-sheet" data-level="1">取消</button>` +
      `<button class="btn btn-primary" data-action="save-fetch-settings">保存</button>`);
  }).catch(function (e) { toast(e.message, true); });
};

ACTIONS['save-fetch-settings'] = function () {
  const errEl = document.getElementById('ft-err');
  const ids = ['ft-poll', 'ft-jitter', 'ft-threshold', 'ft-follows', 'ft-dynamic', 'ft-keyframe'];
  const vals = {};
  for (let i = 0; i < ids.length; i++) {
    const v = advNum(ids[i]);
    if (v === null) { errEl.textContent = '数值项请输入整数'; return; }
    vals[ids[i]] = v;
  }
  api('/api/advanced', 'PUT', {
    pollIntervalSec: vals['ft-poll'],
    pollJitterSec: vals['ft-jitter'],
    healthAlertAfterFailures: vals['ft-threshold'],
    followsSyncIntervalSec: vals['ft-follows'],
    dynamicIntervalSec: vals['ft-dynamic'],
    keyframeIntervalSec: vals['ft-keyframe'],
    keyframeEnabled: document.getElementById('ft-b-keyframe').checked,
  }).then(function () {
    closeSheet(1);
    toast('已保存并生效');
  }).catch(function (e) { errEl.textContent = e.message; });
};

loadListen();
setInterval(loadListen, 60000);
// 监听开关与运行参数都在 settings 表——撤销（含撤销一号登录态相关开关）后重拉本卡
onTableRefresh(['settings'], loadListen);
