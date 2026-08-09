/**
 * 面板前端 · 卡片5 主播列表 + 详情弹窗（全字段编辑 + 该主播的生效推送规则视图）。
 * 卡片4 时间表占位是静态 HTML，在 page.ts 壳里。
 * 规则的新增/编辑/排序收编在「推送」卡片；详情弹窗只勾选「该规则是否对本主播生效」。
 * 内嵌进页面 <script>，内容不得出现反引号与 ${，一律字符串拼接。依赖 icons / app-core 段。
 */
export const APP_STREAMERS = `
var streamers = [];
var modalUid = null;
var modalChannels = [];
var modalCats = [];
var modalRules = [];

function avatarHtml(face, name, cls) {
  cls = cls || 'avatar';
  if (face) return '<img class="' + cls + '" referrerpolicy="no-referrer" src="' + esc(face) + '" alt="">';
  return '<span class="' + cls + ' avatar-ph">' + esc(String(name || '?').charAt(0)) + '</span>';
}

// ---- 主播卡片列表 ----
// 动态类型 → 人话小标签（微博 = 平台标签）
function postTypeTag(p) {
  if (p.platform === 'weibo') return '微博';
  if (p.type === 'DYNAMIC_TYPE_AV') return '动态·视频';
  if (p.type === 'DYNAMIC_TYPE_DRAW') return '动态·图文';
  if (p.type === 'DYNAMIC_TYPE_FORWARD') return '动态·转发';
  if (p.type === 'DYNAMIC_TYPE_WORD') return '动态·文字';
  return '动态';
}
function relTime(ts) {
  if (!ts) return '';
  var diff = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  return Math.floor(diff / 86400) + ' 天前';
}
function postRow(p) {
  var inner =
    '<div class="post-body"><div class="post-head"><span class="tag">' + postTypeTag(p) + '</span>' +
    '<span class="post-time">' + relTime(p.pubTs) + '</span></div>' +
    '<div class="post-text">' + esc(p.text || '(无文字)') + '</div></div>' +
    (p.pics && p.pics[0]
      ? '<img class="post-thumb" referrerpolicy="no-referrer" src="' + esc(p.pics[0]) + '" alt="">'
      : '');
  // 卡片整体点击是开详情弹窗；动态链接标 noop 吞掉卡片点击，新窗口打开
  if (p.url) {
    return '<a class="post" href="' + esc(p.url) + '" target="_blank" rel="noreferrer"' +
      ' data-action="noop">' + inner + '</a>';
  }
  return '<div class="post">' + inner + '</div>';
}
function postsColumn(s) {
  // 开播类型的动态（LIVE_RCMD）是自动生成的噪音，不展示
  var all = s.posts || [];
  var posts = all.filter(function (p) { return p.type !== 'DYNAMIC_TYPE_LIVE_RCMD'; });
  var rows = posts.length
    ? posts.map(postRow).join('')
    : '<p class="hint">' + (all.length ? '暂无动态' : '暂无抓取') + '</p>';
  return '<div class="sc-posts"><div class="sc-posts-title">动态</div>' + rows + '</div>';
}
function streamerCard(s) {
  var name = s.alias || s.uname || String(s.uid);
  var isLive = !!(s.live && s.live.isLive);
  var state = '监听中' + (s.notify ? '' : ' · 推送关') + (s.analyze ? ' · LLM分析' : '');
  var ruleTags = (s.rules && s.rules.names && s.rules.names.length)
    ? s.rules.names.map(function (n) { return '<span class="tag">' + esc(n) + '</span>'; }).join('')
    : '';
  var left = '<div class="sc-left">' + avatarHtml(s.face, name) +
    '<div class="sc-name">' + esc(name) + '</div>' +
    '<div class="meta">UID ' + esc(s.uid) + '</div>' +
    '<div class="meta">直播间 ' + (s.roomId ? esc(s.roomId) : '—') + '</div>' +
    '<div class="meta">微博 ' + (s.weiboNick ? esc(s.weiboNick) : (s.weiboUid ? esc(s.weiboUid) : '—')) + '</div>' +
    '<div class="meta sc-note' + (s.profileNote ? '' : ' none') + '">' + esc(s.profileNote || '未填写') + '</div>' +
    '<div class="meta"><span class="dot green"></span>' + esc(state) + '</div>' +
    (ruleTags ? '<div class="meta rules-row">' + ruleTags + '</div>' : '') +
    '</div>';
  var right;
  if (isLive) {
    var img = s.live.keyframe || s.live.cover;
    var area = [s.live.parentAreaName, s.live.areaName].filter(Boolean).join(' / ');
    right = '<div class="sc-right"><div class="kf-wrap">' +
      (img ? '<img class="kf" referrerpolicy="no-referrer" src="' + esc(img) + '" alt="">'
           : '<div class="kf kf-empty">' + icon('bell') + '</div>') +
      '<span class="live-badge">直播中</span></div>' +
      '<div class="live-info"><div class="live-title">' + esc(s.live.title || '') + '</div>' +
      (area ? '<div class="meta">' + esc(area) + '</div>' : '') +
      '<div class="meta">' + (s.live.liveTime ? durSpan(s.live.liveTime, '开播 ') : '开播 —') +
      ' · 在线 ' + (s.live.online == null ? '—' : s.live.online) + '</div></div></div>';
  } else {
    var off = (s.live && s.live.lastLiveAt) ? durSpan(s.live.lastLiveAt, '下播 ') : '未见开播';
    var prev = (s.live && s.live.title) ? '<div class="meta">上一场：' + esc(s.live.title) + '</div>' : '';
    right = '<div class="sc-right"><div class="kf-wrap"><div class="kf kf-empty">' + icon('bell') + '</div></div>' +
      '<div class="live-info"><div class="off-dur">' + off + '</div>' + prev + '</div></div>';
  }
  return '<div class="sc-card' + (isLive ? '' : ' off') + '" data-action="open-streamer" data-uid="' +
    esc(s.uid) + '">' + left + right + postsColumn(s) + '</div>';
}
function loadStreamers() {
  return api('/api/streamers').then(function (j) {
    streamers = j.streamers || [];
    // 主列表只展示监听中的（watch=true）；关掉的回到「关注列表」等待重新加入
    var active = streamers.filter(function (s) { return s.watch; });
    var liveCount = active.filter(function (s) { return s.live && s.live.isLive; }).length;
    var cnt = document.getElementById('streamer-count');
    if (cnt) cnt.textContent = active.length ? '在播 ' + liveCount + ' · 共 ' + active.length : '';
    document.getElementById('streamer-list').innerHTML =
      active.map(streamerCard).join('') || '<p class="hint">名单为空（从下方关注列表加入）。</p>';
  }).catch(function (e) { toast(e.message, true); });
}

// ---- 详情弹窗：上半区分段卡片表单（别名/直播间号/微博/画像 + 三个勾选项），下半区生效规则视图 ----
function formCheck(label, id, checked) {
  return checkboxHtml('id="' + id + '"', checked, false, label);
}
function fieldVal(id) { var v = document.getElementById(id).value.trim(); return v || null; }

ACTIONS['open-streamer'] = function (el) { openStreamer(el.getAttribute('data-uid')); };

function openStreamer(uid) {
  var s = null;
  for (var i = 0; i < streamers.length; i++) if (String(streamers[i].uid) === String(uid)) s = streamers[i];
  if (!s) { toast('主播数据未加载', true); return; }
  modalUid = s.uid;
  openSheet(String(s.alias || s.uname || s.uid),
    '<div class="row-sub">UID ' + esc(s.uid) + '</div>' +
    '<div class="form-card">' +
      field('别名', '<input id="f-alias" value="' + esc(s.alias || '') + '">') +
      field('直播间号', '<div class="field-static">' + (s.roomId ? esc(s.roomId) : '—') + '</div>') +
      field('微博昵称', '<input id="f-weibo" value="' + esc(s.weiboNick || '') + '">') +
      field('画像', '<input id="f-note" value="' + esc(s.profileNote || '') + '">') +
    '</div>' +
    '<div class="row">' +
      formCheck('监听', 'f-watch', s.watch) +
      formCheck('LLM 分析', 'f-analyze', s.analyze) +
      formCheck('推送', 'f-notify', s.notify) +
    '</div>' +
    '<div class="sheet-foot"><button class="btn" data-action="close-sheet" data-level="1">关闭</button>' +
    '<button class="btn btn-primary" data-action="save-streamer">保存</button></div>' +
    '<div class="sheet-section"><div class="sheet-sub">生效的推送规则</div>' +
    '<div class="hint">勾选 = 该规则对本主播生效；规则的新增/编辑/排序在推送卡片中进行</div>' +
    '<div id="modal-rules">加载中…</div></div>');
  sheetCleanups[1] = function () { modalUid = null; modalChannels = []; modalCats = []; modalRules = []; };
  loadModalRules();
}

function runModal(p, okMsg) {
  p.then(function () {
    if (okMsg) toast(okMsg);
    loadStreamers();
    if (modalUid != null) loadModalRules(); // 只重建规则区，不动上方编辑表单
  }).catch(function (e) { toast(e.message, true); });
}

ACTIONS['save-streamer'] = function () {
  runModal(api('/api/streamers/' + modalUid, 'PUT', {
    alias: fieldVal('f-alias'),
    watch: document.getElementById('f-watch').checked,
    analyze: document.getElementById('f-analyze').checked,
    notify: document.getElementById('f-notify').checked,
    weiboNick: fieldVal('f-weibo'), profileNote: fieldVal('f-note'),
  }), '已保存');
};

// ---- 生效的推送规则（只读视图 + 勾选本主播是否生效；增删改/排序在「推送」卡片） ----
function modalChannelById(id) {
  for (var k = 0; k < modalChannels.length; k++) if (modalChannels[k].id === id) return modalChannels[k];
  return null;
}

function modalCatName(categoryId) {
  if (categoryId == null) return '任意开播';
  for (var i = 0; i < modalCats.length; i++) if (modalCats[i].id === categoryId) return modalCats[i].name;
  return '分类已删除';
}

// 勾选 = 该规则对本主播生效（uids 空 = 全部主播，勾上）；行序 = 全局 sort，不可拖拽
function modalRuleRowHtml(r) {
  var uid = String(modalUid);
  var checked = r.uids.length === 0 || r.uids.indexOf(uid) >= 0;
  var chanTags = (r.channels || []).map(function (cid) {
    var c = modalChannelById(cid);
    return c ? '<span class="tag">' + esc(c.name) + '</span>' : '';
  }).join('');
  return '<div class="row" data-rid="' + r.id + '">' +
    checkboxHtml('data-change="toggle-modal-rule"', checked, false, r.name) +
    (r.enabled ? '' : '<span class="tag">已停用</span>') +
    '<span class="tag">' + esc(modalCatName(r.categoryId)) + '</span>' +
    chanTags +
    '</div>';
}

function loadModalRules() {
  var box = document.getElementById('modal-rules');
  if (!box || modalUid == null) return;
  Promise.all([api('/api/channels'), api('/api/categories'), api('/api/rules?uid=' + modalUid)])
    .then(function (rs) {
      modalChannels = rs[0].channels || [];
      modalCats = rs[1].categories || [];
      modalRules = rs[2].rules || [];
      box.innerHTML = modalRules.map(modalRuleRowHtml).join('') ||
        '<p class="hint">还没有推送规则（在推送卡片中添加）。</p>';
    }).catch(function (e) { toast(e.message, true); });
}

// 勾选切换 = 把本主播加进/移出规则的 uids。
// 「全部主播」规则（uids 空）取消勾选 → 展开为「当前全部其他主播」的显式名单（PUT 并 toast 说明）；
// 再次勾回只把本主播加回名单，不再收拢回「全部」。
CHANGES['toggle-modal-rule'] = function (el) {
  var row = el.closest('.row');
  var id = Number(row.getAttribute('data-rid'));
  var r = null;
  for (var i = 0; i < modalRules.length; i++) if (modalRules[i].id === id) r = modalRules[i];
  if (!r || modalUid == null) return;
  var uid = String(modalUid);
  var on = el.checked;
  var uids;
  var msg = null;
  if (on) {
    if (r.uids.indexOf(uid) >= 0) return; // 已在名单内（全部主播规则的勾上态不会走到这里）
    uids = r.uids.slice();
    uids.push(uid);
  } else if (r.uids.length === 0) {
    uids = [];
    for (var k = 0; k < streamers.length; k++) {
      var su = String(streamers[k].uid);
      if (su !== uid) uids.push(su);
    }
    if (uids.length === 0) {
      // 空名单 = 全部主播：排除唯一一位主播无法表示，拒绝并还原勾选态
      toast('名单里只有这一位主播，无法单独排除', true);
      loadModalRules();
      return;
    }
    msg = '已转为显式主播名单';
  } else {
    uids = r.uids.filter(function (u) { return u !== uid; });
  }
  api('/api/rules/' + id, 'PUT', { uids: uids })
    .then(function () {
      if (msg) toast(msg);
      loadModalRules();
      loadStreamers(); // 主播卡的规则名标签
    })
    .catch(function (e) { toast(e.message, true); loadModalRules(); });
};

// ---- 启动与轮询：监听卡 60s（app-listen 段），主播列表 30s（弹窗 DOM 不被重建） ----
loadStreamers();
setInterval(loadStreamers, 30000);
`;
