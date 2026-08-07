/**
 * 面板前端 · 卡片5 主播列表 + 详情弹窗（全字段编辑 + 该主播推送规则 CRUD）。
 * 卡片4 时间表占位是静态 HTML，在 page.ts 壳里。
 * 内嵌进页面 <script>，内容不得出现反引号与 ${，一律字符串拼接。依赖 app-core 段。
 */
export const APP_STREAMERS = `
var streamers = [];
var modalUid = null;
var modalChannels = [];

function avatarHtml(face, name, cls) {
  cls = cls || 'avatar';
  if (face) return '<img class="' + cls + '" referrerpolicy="no-referrer" src="' + esc(face) + '" alt="">';
  return '<span class="' + cls + ' avatar-ph">' + esc(String(name || '?').charAt(0)) + '</span>';
}

// ---- 主播卡片列表 ----
// 动态类型 → 人话小标签（微博预留）
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
  // 卡片整体点击是开详情弹窗；动态链接要新窗口打开，不能把点击冒泡上去
  if (p.url) {
    return '<a class="post" href="' + esc(p.url) + '" target="_blank" rel="noreferrer"' +
      ' onclick="event.stopPropagation()">' + inner + '</a>';
  }
  return '<div class="post">' + inner + '</div>';
}
function postsColumn(s) {
  // 开播类型的动态（LIVE_RCMD）是自动生成的噪音，不展示
  var all = s.posts || [];
  var posts = all.filter(function (p) { return p.type !== 'DYNAMIC_TYPE_LIVE_RCMD'; });
  var rows = posts.length
    ? posts.map(postRow).join('')
    : (all.length ? '' : '<p class="hint">暂无抓取</p>');
  return '<div class="sc-posts"><div class="sc-posts-title">动态</div>' + rows + '</div>';
}
function streamerCard(s) {
  var name = s.alias || s.uname || String(s.uid);
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
  if (s.live && s.live.isLive) {
    var img = s.live.keyframe || s.live.cover;
    var area = [s.live.parentAreaName, s.live.areaName].filter(Boolean).join(' / ');
    right = '<div class="sc-right">' +
      (img ? '<img class="kf" referrerpolicy="no-referrer" src="' + esc(img) + '" alt="">'
           : '<div class="kf kf-empty"></div>') +
      '<div class="live-info"><div class="live-title">' + esc(s.live.title || '') + '</div>' +
      (area ? '<div class="meta">' + esc(area) + '</div>' : '') +
      '<div class="meta">' + (s.live.liveTime ? durSpan(s.live.liveTime, '开播 ') : '开播 —') +
      ' · 在线 ' + (s.live.online == null ? '—' : s.live.online) + '</div></div></div>';
  } else {
    var off = (s.live && s.live.lastLiveAt) ? durSpan(s.live.lastLiveAt, '下播 ') : '未见开播';
    var prev = (s.live && s.live.title) ? '<div class="meta">上一场：' + esc(s.live.title) + '</div>' : '';
    right = '<div class="sc-right"><div class="kf kf-empty"></div>' +
      '<div class="live-info"><div class="off-dur">' + off + '</div>' + prev + '</div></div>';
  }
  return '<div class="streamer-card" onclick="openStreamer(' + q(s.uid) + ')">' +
    left + right + postsColumn(s) + '</div>';
}
function loadStreamers() {
  return api('/api/streamers').then(function (j) {
    streamers = j.streamers || [];
    // 主列表只展示监听中的（watch=true）；关掉的回到「关注列表」等待重新加入
    var active = streamers.filter(function (s) { return s.watch; });
    document.getElementById('streamer-list').innerHTML =
      active.map(streamerCard).join('') || '<p class="hint">名单为空（从下方关注列表加入）。</p>';
  }).catch(function (e) { toast(e.message, true); });
}

// ---- 详情弹窗：上半区（别名/三开关/直播间号/微博/画像），下半区推送规则 ----
function switchRow(id, checked, label) {
  return '<div class="wfull"><label><input type="checkbox" id="' + id + '"' +
    (checked ? ' checked' : '') + '> ' + label + '</label></div>';
}
function fieldVal(id) { var v = document.getElementById(id).value.trim(); return v || null; }
function openStreamer(uid) {
  var s = null;
  for (var i = 0; i < streamers.length; i++) if (String(streamers[i].uid) === String(uid)) s = streamers[i];
  if (!s) { toast('主播数据未加载', true); return; }
  modalUid = s.uid;
  openModal(
    '<h3>' + esc(s.alias || s.uname || s.uid) + ' <small>UID ' + esc(s.uid) + '</small></h3>' +
    '<div class="mrow"><label class="wfull">别名 <input id="f-alias" class="wfull" value="' +
      esc(s.alias || '') + '"></label></div>' +
    '<div class="mrow">' +
      switchRow('f-watch', s.watch, '监听') +
      switchRow('f-analyze', s.analyze, 'LLM 分析') +
      switchRow('f-notify', s.notify, '推送') +
    '</div>' +
    '<div class="mrow"><label class="wfull">直播间号 ' +
      (s.roomId ? esc(s.roomId) : '—') +
      '</label></div>' +
    '<div class="mrow"><label class="wfull">微博 <input id="f-weibo" class="wfull" value="' +
      esc(s.weiboNick || '') + '"></label></div>' +
    '<div class="mrow"><label class="wfull">画像 <input id="f-note" class="wfull" value="' +
      esc(s.profileNote || '') + '"></label></div>' +
    '<div class="mrow"><button onclick="saveStreamer()">保存</button> ' +
    '<button onclick="closeModal()">关闭</button></div>' +
    '<h4>推送规则</h4>' +
    '<div id="modal-rules">加载中…</div>');
  modalCleanup = function () { modalUid = null; modalChannels = []; };
  loadModalRules();
}
function runModal(p, okMsg) {
  p.then(function () {
    if (okMsg) toast(okMsg);
    loadStreamers();
    if (modalUid != null) loadModalRules(); // 只重建规则区，不动上方编辑表单
  }).catch(function (e) { toast(e.message, true); });
}
function saveStreamer() {
  runModal(api('/api/streamers/' + modalUid, 'PUT', {
    alias: fieldVal('f-alias'),
    watch: document.getElementById('f-watch').checked,
    analyze: document.getElementById('f-analyze').checked,
    notify: document.getElementById('f-notify').checked,
    weiboNick: fieldVal('f-weibo'), profileNote: fieldVal('f-note'),
  }), '已保存');
}

// ---- 推送规则（uid 固定为 modalUid；可排序勾选列表 + 弹窗编辑，默认推送在「推送」卡片全局配置） ----
function splitCsv(v) {
  return v.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}
var rulesCache = [];
var ruleDragId = null;

function channelById(id) {
  for (var k = 0; k < modalChannels.length; k++) if (modalChannels[k].id === id) return modalChannels[k];
  return null;
}
function ruleRow(r, i) {
  var tags = (r.channels || []).map(function (cid) {
    var c = channelById(cid);
    return c ? '<span class="tag">' + esc(c.name) + '</span>' : '';
  }).join('');
  return '<div class="llm-row" draggable="true" data-id="' + r.id + '"' +
    ' ondragstart="ruleDragStart(event)" ondragover="ruleDragOver(event)"' +
    ' ondrop="ruleDrop(event, ' + i + ')" ondragend="ruleDragEnd()">' +
    '<span class="llm-grip">☰</span>' +
    '<label><input type="checkbox" onchange="toggleRule(' + r.id + ', this.checked)"' +
    (r.enabled ? ' checked' : '') + '></label>' +
    '<span class="llm-name">' + esc(r.name) + '</span>' +
    tags +
    '<span class="grow"></span>' +
    '<button onclick="openRuleModal(' + i + ')">编辑</button>' +
    '<button onclick="delRule(' + r.id + ')">删除</button>' +
    '</div>';
}
function loadModalRules() {
  var box = document.getElementById('modal-rules');
  if (!box || modalUid == null) return;
  Promise.all([api('/api/channels'), api('/api/rules?uid=' + modalUid)]).then(function (rs) {
    modalChannels = rs[0].channels || [];
    rulesCache = rs[1].rules || [];
    box.innerHTML = rulesCache.map(ruleRow).join('') +
      '<div class="llm-add-row"><button onclick="openRuleModal(null)">添加规则</button></div>';
  }).catch(function (e) { toast(e.message, true); });
}
function toggleRule(id, on) {
  api('/api/rules/' + id, 'PUT', { enabled: on })
    .then(function () { toast(on ? '已启用' : '已停用'); loadModalRules(); loadStreamers(); })
    .catch(function (e) { toast(e.message, true); loadModalRules(); });
}
function delRule(id) {
  if (!confirm('删除这条规则？')) return;
  api('/api/rules/' + id, 'DELETE')
    .then(function () { toast('已删除'); loadModalRules(); loadStreamers(); })
    .catch(function (e) { toast(e.message, true); });
}

// ---- 规则 新增/编辑 弹窗（嵌套 modal2；i=null 新增） ----
function modal2CheckedChannels() {
  return Array.prototype.slice.call(document.getElementById('modal2').querySelectorAll('.e-ch'))
    .filter(function (x) { return x.checked; }).map(function (x) { return Number(x.value); });
}
function openRuleModal(i) {
  var r = i === null ? null : rulesCache[i];
  var chanBoxes = modalChannels.length === 0
    ? ''
    : modalChannels.map(function (c) {
        return '<label><input type="checkbox" class="e-ch" value="' + c.id + '"' +
          ((r && r.channels.indexOf(c.id) >= 0) ? ' checked' : '') + '> ' + esc(c.name) +
          ' <span class="tag">' + chanTypeName(c) + '</span></label>';
      }).join('');
  openModal2(
    '<h3>' + (r ? '编辑规则' : '添加规则') + '</h3>' +
    '<div class="mrow"><label class="wfull">名称 <input id="r-name" class="wfull" value="' +
      (r ? esc(r.name) : '') + '"></label></div>' +
    '<div class="mrow"><label class="wfull">关键词 <input id="r-kw" class="wfull" placeholder="逗号分隔" value="' +
      (r ? esc(r.keywords.join(', ')) : '') + '"></label></div>' +
    '<div class="mrow"><label class="wfull">分区 <input id="r-area" class="wfull" placeholder="逗号分隔" value="' +
      (r ? esc(r.areas.join(', ')) : '') + '"></label></div>' +
    '<div class="mrow">渠道 ' + (chanBoxes || '<span class="hint">还没有渠道</span>') + '</div>' +
    '<div class="mrow"><label class="wfull">推送词 <input id="r-tpl" class="wfull" placeholder="留空 = 全局默认" value="' +
      (r ? esc(r.messageTemplate || '') : '') + '"></label></div>' +
    '<div class="mrow"><button onclick="saveRuleModal(' + (i === null ? 'null' : i) + ')">保存</button>' +
    '<button onclick="closeModal2()">取消</button>' +
    '<span id="rule-err" class="rule-err"></span></div>'
  );
}
function saveRuleModal(i) {
  var err = document.getElementById('rule-err');
  if (err) err.textContent = '';
  var name = document.getElementById('r-name').value.trim();
  if (!name) { if (err) err.textContent = '请填写规则名称'; return; }
  var body = {
    name: name,
    keywords: splitCsv(document.getElementById('r-kw').value),
    areas: splitCsv(document.getElementById('r-area').value),
    channels: modal2CheckedChannels(),
    messageTemplate: document.getElementById('r-tpl').value.trim() || null,
  };
  var req = i === null
    ? api('/api/rules', 'POST', Object.assign({ uid: modalUid }, body))
    : api('/api/rules/' + rulesCache[i].id, 'PUT', body);
  req.then(function () {
    closeModal2();
    toast(i === null ? '已添加' : '已保存');
    loadModalRules();
    loadStreamers();
  }).catch(function (e) { if (err) err.textContent = e.message; });
}

// ---- 规则拖拽排序 ----
function ruleDragStart(e) {
  ruleDragId = Number(e.currentTarget.getAttribute('data-id'));
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(ruleDragId));
  e.currentTarget.classList.add('dragging');
}
function ruleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}
function ruleDrop(e, i) {
  e.preventDefault();
  if (ruleDragId == null) return;
  var from = -1;
  for (var k = 0; k < rulesCache.length; k++) if (rulesCache[k].id === ruleDragId) { from = k; break; }
  if (from < 0 || from === i) return;
  var ids = rulesCache.map(function (r) { return r.id; });
  var moved = ids.splice(from, 1)[0];
  ids.splice(i, 0, moved);
  api('/api/rules/order', 'PUT', { uid: modalUid, ids: ids })
    .then(function () { loadModalRules(); loadStreamers(); })
    .catch(function (err) { toast(err.message, true); loadModalRules(); });
}
function ruleDragEnd() {
  ruleDragId = null;
  var rows = document.querySelectorAll('.llm-row.dragging');
  for (var i = 0; i < rows.length; i++) rows[i].classList.remove('dragging');
}

// ---- 启动与轮询：监听卡 60s（app-status 段），主播列表 30s（弹窗 DOM 不被重建） ----
loadStreamers();
setInterval(loadStreamers, 30000);
`;
