/**
 * 面板前端 · 卡片1 监听：B站/微博登录行（点击开统一扫码弹窗）+ 动态/微博两个开关。
 * 直播间开播轮询不依赖登录，常开无开关，不在卡片里展示。
 * 内嵌进页面 <script>，内容不得出现反引号与 ${，一律字符串拼接。依赖 icons / app-core 段。
 */
export const APP_LISTEN = `
var PLAT_STATE = {
  ok: ['green', '已登录'], imported: ['green', '已导入'],
  expired: ['red', '已失效'], none: ['gray', '未导入'], reserved: ['gray', '预留'],
};
var listenState = null;

function platformByKey(key) {
  var ps = (listenState && listenState.platforms) || [];
  for (var i = 0; i < ps.length; i++) if (ps[i].key === key) return ps[i];
  return null;
}

function loadListen() {
  return api('/api/listen').then(function (s) {
    listenState = s;
    document.getElementById('listen-rows').innerHTML = [
      loginRow('B站 登录', platformByKey('bili'), 'bili'),
      featureRow('监听动态', s.rows.dynamic),
      loginRow('微博 登录', platformByKey('weibo'), 'weibo'),
      featureRow('监听微博', s.rows.weibo),
    ].join('');
  }).catch(function (e) { toast(e.message, true); });
}

function loginRow(name, plat, key) {
  var st = (plat && PLAT_STATE[plat.state]) || ['gray', '未导入'];
  return '<div class="row row-click" data-action="open-login" data-platform="' + key + '">' +
    '<span class="dot ' + st[0] + '"></span>' +
    '<span class="row-title">' + name + '</span>' +
    '<span class="row-end"><span class="row-sub">' + st[1] + '</span>' + icon('chevron-right') + '</span>' +
    '</div>';
}

function featureRow(name, f) {
  return '<div class="row"><span class="row-title">' + name + '</span>' +
    '<span class="row-end">' +
    switchHtml('data-change="toggle-listen" data-feature="' + f.feature + '"', f.enabled) +
    '</span></div>';
}

CHANGES['toggle-listen'] = function (el) {
  var on = el.checked;
  api('/api/listen/' + el.getAttribute('data-feature'), 'PUT', { enabled: on }).then(function () {
    toast(on ? '已开启' : '已关闭');
    loadListen();
  }).catch(function (e) { toast(e.message, true); loadListen(); });
};

// ---- 统一平台登录流程：两平台同构，差异全部参数化（id 标签 / 提示文案 / 二维码生成与轮询地址） ----
// B站二维码用内嵌 qr 库渲染 svg；微博是 png 直链，直接 <img> 显示，不用内嵌二维码库。
var LOGIN_PLATFORMS = {
  bili: {
    title: 'B站 登录态', idLabel: 'mid', scanHint: '请使用 B站 App 扫码',
    foot: '也可手动放置 cookies.json 后重启',
    generate: function () {
      return api('/api/auth/bili/qrcode', 'POST').then(function (j) {
        var qr = qrcode(0, 'M');
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
    foot: '也可手动放置 weibo-cookies.json 后重启',
    generate: function () {
      return api('/api/auth/weibo/qrcode', 'POST').then(function (j) {
        return {
          html: '<img src="' + esc(j.image) + '" width="200" height="200" alt="微博登录二维码">',
          poll: function () { return api('/api/auth/weibo/qrcode/poll'); },
        };
      });
    },
  },
};
var loginTimer = null, loginPoll = null, loginPlatform = null;

function stopLoginPoll() {
  if (loginTimer) { clearInterval(loginTimer); loginTimer = null; }
  loginPoll = null;
}

ACTIONS['open-login'] = function (el) {
  var key = el.getAttribute('data-platform');
  var conf = LOGIN_PLATFORMS[key];
  if (!conf) return;
  var p = platformByKey(key);
  var st = (p && PLAT_STATE[p.state]) || ['gray', '未知'];
  loginPlatform = key;
  openSheet(conf.title,
    '<div class="login-status"><span class="dot ' + st[0] + '"></span>' + st[1] +
      '<span class="row-sub">' + conf.idLabel + ' ' + esc((p && p.mid) || '—') + '</span></div>' +
    '<div class="qr-box" id="qr-box"><div class="qr-empty">' + icon('qrcode') +
      '<span class="hint">点击下方按钮生成二维码</span></div></div>' +
    '<div id="qr-msg" class="hint qr-msg"></div>' +
    '<div class="sheet-foot"><button class="btn btn-primary" data-action="start-qr">扫码登录</button></div>' +
    '<div class="mfoot">' + conf.foot + '</div>');
  sheetCleanups[1] = stopLoginPoll;
};

ACTIONS['start-qr'] = function () {
  var conf = LOGIN_PLATFORMS[loginPlatform];
  if (!conf) return;
  stopLoginPoll();
  conf.generate().then(function (g) {
    var box = document.getElementById('qr-box');
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
    var msg = document.getElementById('qr-msg');
    if (!msg) return; // 弹窗已关
    if (j.status === 'waiting') return;
    if (j.status === 'scanned') { msg.textContent = '已扫码，请在手机确认'; return; }
    stopLoginPoll();
    if (j.status === 'confirmed') { closeSheet(1); toast('登录成功'); loadListen(); return; }
    if (j.status === 'expired') msg.textContent = '二维码已过期，请重新点击「扫码登录」生成';
  }).catch(function () {});
}

loadListen();
setInterval(loadListen, 60000);
`;
