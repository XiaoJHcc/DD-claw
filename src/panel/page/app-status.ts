/**
 * 面板前端 · 卡片1 运行状态 + B站/微博登录弹窗 + 扫码登录流程。
 * 内嵌进页面 <script>，内容不得出现反引号与 ${，一律字符串拼接。依赖 app-core 段。
 */
export const APP_STATUS = `
var PLAT_STATE = {
  ok: ['green', '已登录'], imported: ['green', '已导入'],
  expired: ['red', '已失效'], none: ['gray', '未导入'], reserved: ['gray', '预留'],
};
var lastStatus = null;

function loadStatus() {
  return api('/api/status').then(function (s) {
    lastStatus = s;
    document.getElementById('status-info').innerHTML =
      '<div class="srow"><span class="slabel">运行时长</span>' + durSpan(s.startedAt, '') + '</div>' +
      '<div class="srow"><span class="slabel">推送通道</span>' + esc((s.notifiers || []).join(', ') || '(无)') + '</div>' +
      '<div class="srow"><span class="slabel">监听数</span>' + (s.watchedCount || 0) + '</div>' +
      '<div class="srow"><span class="slabel">在播数</span>' + (s.liveCount || 0) + '</div>';
    document.getElementById('status-platforms').innerHTML = (s.platforms || []).map(function (p) {
      var st = PLAT_STATE[p.state] || ['gray', p.state];
      var clickable = p.key === 'bili' || p.key === 'weibo';
      return '<div class="plat' + (clickable ? ' clickable' : '') + '"' +
        (clickable ? ' onclick="openPlatformLogin(' + q(p.key) + ')"' : '') + '>' +
        '<span class="dot ' + st[0] + '"></span>' + esc(p.name) +
        '<span class="pstate">' + st[1] + '</span></div>';
    }).join('');
  }).catch(function (e) { toast(e.message, true); });
}

function platformByKey(key) {
  var ps = (lastStatus && lastStatus.platforms) || [];
  for (var i = 0; i < ps.length; i++) if (ps[i].key === key) return ps[i];
  return null;
}
function openPlatformLogin(key) {
  if (key === 'weibo') return openWeiboLogin();
  return openBiliLogin();
}

// ---- B站 登录弹窗 + 扫码 ----
var qrTimer = null, qrKey = null;
function openBiliLogin() {
  var p = platformByKey('bili');
  var st = (p && PLAT_STATE[p.state]) || ['gray', '未知'];
  openModal(
    '<h3>B站 登录态</h3>' +
    '<div class="mrow">状态：<span class="dot ' + st[0] + '"></span>' + st[1] + '</div>' +
    '<div class="mrow">mid：' + esc((p && p.mid) || '—') + '</div>' +
    '<div class="mrow"><button onclick="startQr()">扫码登录</button></div>' +
    '<div id="qr-box" class="qr-box"></div>' +
    '<div id="qr-msg" class="hint"></div>' +
    '<div class="mrow"><button onclick="closeModal()">关闭</button></div>' +
    '<div class="mfoot">也可手动放置 cookies.json 后重启</div>');
  modalCleanup = function () { if (qrTimer) { clearInterval(qrTimer); qrTimer = null; } qrKey = null; };
}
function startQr() {
  api('/api/auth/bili/qrcode', 'POST').then(function (j) {
    qrKey = j.key;
    var qr = qrcode(0, 'M');
    qr.addData(j.url);
    qr.make();
    document.getElementById('qr-box').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2 });
    document.getElementById('qr-msg').textContent = '请使用 B站 App 扫码';
    if (qrTimer) clearInterval(qrTimer);
    qrTimer = setInterval(pollQr, 2000);
  }).catch(function (e) { toast(e.message, true); });
}
function pollQr() {
  if (!qrKey) return;
  api('/api/auth/bili/qrcode/poll?key=' + encodeURIComponent(qrKey)).then(function (j) {
    var msg = document.getElementById('qr-msg');
    if (!msg) return; // 弹窗已关
    if (j.status === 'waiting') return;
    if (j.status === 'scanned') { msg.textContent = '已扫码，请在手机确认'; return; }
    if (qrTimer) { clearInterval(qrTimer); qrTimer = null; }
    qrKey = null;
    if (j.status === 'confirmed') { closeModal(); toast('登录成功'); loadStatus(); return; }
    if (j.status === 'expired') msg.textContent = '二维码已过期，请重新点击「扫码登录」生成';
  }).catch(function () {});
}

// ---- 微博 登录弹窗 + 扫码（与 B 站同构；二维码是 png 直链，直接 <img> 显示，不用内嵌二维码库）----
var wqrTimer = null;
function openWeiboLogin() {
  var p = platformByKey('weibo');
  var st = (p && PLAT_STATE[p.state]) || ['gray', '未知'];
  openModal(
    '<h3>微博 登录态</h3>' +
    '<div class="mrow">状态：<span class="dot ' + st[0] + '"></span>' + st[1] + '</div>' +
    '<div class="mrow">uid：' + esc((p && p.mid) || '—') + '</div>' +
    '<div class="mrow"><button onclick="startWeiboQr()">扫码登录</button></div>' +
    '<div id="qr-box" class="qr-box"></div>' +
    '<div id="qr-msg" class="hint"></div>' +
    '<div class="mrow"><button onclick="closeModal()">关闭</button></div>' +
    '<div class="mfoot">也可手动放置 weibo-cookies.json 后重启</div>');
  modalCleanup = function () { if (wqrTimer) { clearInterval(wqrTimer); wqrTimer = null; } };
}
function startWeiboQr() {
  api('/api/auth/weibo/qrcode', 'POST').then(function (j) {
    document.getElementById('qr-box').innerHTML =
      '<img src="' + esc(j.image) + '" width="180" height="180" alt="微博登录二维码">';
    document.getElementById('qr-msg').textContent = '请使用微博 App 扫码';
    if (wqrTimer) clearInterval(wqrTimer);
    wqrTimer = setInterval(pollWeiboQr, 2000);
  }).catch(function (e) { toast(e.message, true); });
}
function pollWeiboQr() {
  api('/api/auth/weibo/qrcode/poll').then(function (j) {
    var msg = document.getElementById('qr-msg');
    if (!msg) return; // 弹窗已关
    if (j.status === 'waiting') return;
    if (j.status === 'scanned') { msg.textContent = '已扫码，请在手机确认'; return; }
    if (wqrTimer) { clearInterval(wqrTimer); wqrTimer = null; }
    if (j.status === 'confirmed') { closeModal(); toast('微博登录成功'); loadStatus(); return; }
    if (j.status === 'expired') msg.textContent = '二维码已过期，请重新点击「扫码登录」生成';
  }).catch(function () {});
}
`;
