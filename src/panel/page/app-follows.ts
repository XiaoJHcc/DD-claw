/**
 * 面板前端 · 卡片6 关注列表：B站关注候选池（含已监听标记）+ 搜索过滤 + 一键加入监听。
 * 内嵌进页面 <script>，内容不得出现反引号与 ${，一律字符串拼接。依赖 app-core / app-streamers 段。
 */
export const APP_FOLLOWS = `
var followAll = [];
var followSearch = '';
var followShowAll = false;
var followCap = 120;

function loadFollows() {
  return api('/api/follows').then(function (j) {
    followAll = j.follows || [];
    renderFollows();
  }).catch(function (e) { toast(e.message, true); });
}
function followMatches(f) {
  if (!followSearch) return true;
  var kw = followSearch.toLowerCase();
  return String(f.uname || '').toLowerCase().indexOf(kw) >= 0 ||
         String(f.uid).indexOf(kw) >= 0;
}
function followCard(f) {
  return '<div class="follow-card">' + avatarHtml(f.face, f.uname, 'f-avatar') +
    '<div class="f-name">' + esc(f.uname || f.uid) + '</div>' +
    (f.watched
      ? '<span class="tag">已监听</span>'
      : '<button onclick="watch(' + q(f.uid) + ')">+ 监听</button>') + '</div>';
}
function renderFollows() {
  var box = document.getElementById('follow-list');
  if (!box) return;
  var list = followAll.filter(followMatches);
  var shown = (followSearch || followShowAll) ? list : list.slice(0, followCap);
  var html = shown.map(followCard).join('');
  if (list.length === 0) {
    html = '<p class="hint">' + (followSearch ? '没有匹配的关注' : '无（或关注同步未启用）') + '</p>';
  } else if (shown.length < list.length) {
    html += '<div class="f-more"><span class="hint">共 ' + list.length + ' 条 · ' +
      '<a href="javascript:void(0)" onclick="followShowAll=true;renderFollows()">展开全部</a></span></div>';
  }
  box.innerHTML = html;
}
function onFollowSearch() {
  followSearch = document.getElementById('follow-search').value.trim();
  followShowAll = false;
  renderFollows();
}
function watch(uid) {
  api('/api/streamers/' + uid + '/watch', 'POST').then(function () {
    toast('已加入监听'); loadStreamers(); loadFollows();
  }).catch(function (e) { toast(e.message, true); });
}

loadFollows();
setInterval(loadFollows, 30000);
`;
