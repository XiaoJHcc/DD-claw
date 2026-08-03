/**
 * 面板前端公共段：esc / api / toast / 弹窗开关 / 时长格式化与每秒重算。
 * 内嵌进页面 <script>，内容不得出现反引号与 ${（外层是模板字面量），一律字符串拼接。
 */
export const APP_CORE = `
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function q(s) { return "'" + String(s) + "'"; } // 生成内联 onclick 里的字符串实参
// 渠道类型 → 人话标签（推送卡片与主播弹窗共用）
function chanTypeName(c) {
  if (c.notifier === 'toast') return '系统通知';
  return c.targetType === 'group' ? 'QQ群' : 'QQ私聊';
}
function api(path, method, body) {
  return fetch(path, {
    method: method || 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(function (r) {
    return r.json().then(function (j) {
      if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
      return j;
    });
  });
}
function toast(msg, isErr) {
  var t = document.getElementById('toast');
  t.textContent = msg; t.className = isErr ? 'err' : 'ok';
  clearTimeout(t._tm);
  t._tm = setTimeout(function () { t.textContent = ''; t.className = ''; }, 4000);
}

// ---- 弹窗（mask 点击空白处关闭；modalCleanup 由打开方注册清理逻辑） ----
var modalCleanup = null;
function openModal(html) {
  document.getElementById('modal').innerHTML = html;
  document.getElementById('modal-mask').classList.remove('hidden');
}
function closeModal() {
  if (modalCleanup) { try { modalCleanup(); } catch (e) {} modalCleanup = null; }
  document.getElementById('modal-mask').classList.add('hidden');
  document.getElementById('modal').innerHTML = '';
}
document.getElementById('modal-mask').addEventListener('click', function (e) {
  if (e.target === this) closeModal();
});

// ---- 时长：.dur 元素带 data-ts（秒级时间戳）+ data-prefix，每秒本地重算，不打接口 ----
function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec));
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
}
function durSpan(ts, prefix) {
  return '<span class="dur" data-ts="' + ts + '" data-prefix="' + esc(prefix) + '">' +
    esc(prefix) + fmtDur(Date.now() / 1000 - ts) + '</span>';
}
setInterval(function () {
  var now = Date.now() / 1000;
  var els = document.querySelectorAll('.dur');
  for (var i = 0; i < els.length; i++) {
    var ts = Number(els[i].getAttribute('data-ts'));
    if (ts > 0) els[i].textContent = els[i].getAttribute('data-prefix') + fmtDur(now - ts);
  }
}, 1000);
`;
