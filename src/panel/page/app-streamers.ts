/**
 * 面板前端 · 卡片3 主播列表 + 详情弹窗（全字段编辑 + 该主播推送规则 CRUD）+ 关注未监听区。
 * 卡片2 时间表占位是静态 HTML，在 page.ts 壳里。
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
function streamerCard(s) {
  var name = s.alias || s.uname || String(s.uid);
  var rsum = (s.rules && s.rules.count > 0) ? s.rules.count + ' 条规则' : '无规则';
  var state = '监听中' + (s.notify ? '' : ' · 推送关') + (s.analyze ? ' · LLM分析' : '');
  var left = '<div class="sc-left">' + avatarHtml(s.face, name) +
    '<div class="sc-name">' + esc(name) + '</div>' +
    '<div class="meta">UID ' + esc(s.uid) + '</div>' +
    '<div class="meta">直播间 ' + (s.roomId ? esc(s.roomId) : '—') + '</div>' +
    '<div class="meta">微博 ' + (s.weiboNick ? esc(s.weiboNick) : (s.weiboUid ? esc(s.weiboUid) : '—')) + '</div>' +
    '<div class="meta sc-note' + (s.profileNote ? '' : ' none') + '">' + esc(s.profileNote || '未填写') + '</div>' +
    '<div class="meta"><span class="dot green"></span>' + esc(state) + ' · ' + esc(rsum) + '</div></div>';
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
  return '<div class="streamer-card" onclick="openStreamer(' + q(s.uid) + ')">' + left + right + '</div>';
}
function loadStreamers() {
  return api('/api/streamers').then(function (j) {
    streamers = j.streamers || [];
    // 主列表只展示监听中的（watch=true）；关掉的回到关注区等待重新加入
    var active = streamers.filter(function (s) { return s.watch; });
    document.getElementById('streamer-list').innerHTML =
      active.map(streamerCard).join('') || '<p class="hint">名单为空（从下方关注列表加入）。</p>';
  }).catch(function (e) { toast(e.message, true); });
}

// ---- 详情弹窗：上半区（别名/三开关/直播间号/微博/画像），下半区推送规则 ----
function switchRow(id, checked, label, hint) {
  return '<div class="wfull"><label><input type="checkbox" id="' + id + '"' +
    (checked ? ' checked' : '') + '> ' + label + '</label>' +
    '<div class="hint">' + hint + '</div></div>';
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
      switchRow('f-watch', s.watch, '监听', '抓取开播状态和动态（关闭后此主播移出主列表，回到关注区）') +
      switchRow('f-analyze', s.analyze, 'LLM 分析', '开播后对直播内容做归类（功能未接入，先存设置）') +
      switchRow('f-notify', s.notify, '推送', '命中规则时发通知（关闭 = 只记录不打扰）') +
    '</div>' +
    '<div class="mrow"><label class="wfull">直播间号 <span>' +
      (s.roomId ? esc(s.roomId) : '<span class="hint">获取中…（轮询回填后自动出现）</span>') +
      '</span></label></div>' +
    '<div class="mrow"><label class="wfull">微博 <input id="f-weibo" class="wfull" value="' +
      esc(s.weiboNick || '') + '" placeholder="微博昵称">' +
      (s.weiboUid ? '<span class="hint">已解析 UID：' + esc(s.weiboUid) + '</span>' : '') +
      '</label></div>' +
    '<p class="hint">填微博昵称，保存时自动解析为 UID；改名后重新填一次即可</p>' +
    '<div class="mrow"><label class="wfull">画像 <input id="f-note" class="wfull" value="' +
      esc(s.profileNote || '') + '" placeholder="常见内容 / 语言风格 / 优先级经验"></label></div>' +
    '<div class="mrow"><button onclick="saveStreamer()">保存</button> ' +
    '<button onclick="closeModal()">关闭</button></div>' +
    '<h4>推送规则</h4>' +
    '<p class="hint">关键词和分区都填 = 都要满足；都不填 = 默认推送；从上往下第一条命中的规则生效</p>' +
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

// ---- 推送规则 CRUD（uid 固定为 modalUid；渠道勾选来自「推送」卡片） ----
function splitCsv(v) {
  return v.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}
function ruleChannelBoxes(selected) {
  if (modalChannels.length === 0) return '<span class="hint">还没有渠道，先到「推送」卡片新增</span>';
  return modalChannels.map(function (c) {
    return '<label><input type="checkbox" class="e-ch" value="' + c.id + '"' +
      (selected.indexOf(c.id) >= 0 ? ' checked' : '') + '> ' + esc(c.name) +
      ' <span class="tag">' + chanTypeName(c) + '</span></label>';
  }).join('');
}
function checkedChannelIds(div) {
  return Array.prototype.slice.call(div.querySelectorAll('.e-ch'))
    .filter(function (x) { return x.checked; }).map(function (x) { return Number(x.value); });
}
// 第一行固定「默认推送」（空条件规则；还没有时此行就是它的新建表单）
function defaultRuleRow(r) {
  return '<div class="clause" data-id="' + (r ? r.id : '') + '" data-default="1">' +
    '<div class="row"><b>默认推送</b> <span class="hint">条件规则都不命中时走这里</span></div>' +
    '<div class="row">渠道 ' + ruleChannelBoxes(r ? r.channels : []) + '</div>' +
    '<div class="row">推送词 <input class="e-tpl" size="34" value="' +
      esc(r && r.messageTemplate ? r.messageTemplate : '') + '" placeholder="留空 = 用全局默认模板">' +
    ' <label><input type="checkbox" class="e-enabled"' + (!r || r.enabled ? ' checked' : '') + '> 启用</label>' +
    ' <button onclick="saveDefaultRule()">保存</button></div></div>';
}
function ruleFormRows(r) {
  return '<div class="row">关键词 <input class="e-kw" size="14" value="' + esc(r.keywords.join(', ')) +
      '" placeholder="标题含任一，逗号分隔">' +
    ' 分区 <input class="e-area" size="12" value="' + esc(r.areas.join(', ')) +
      '" placeholder="分区含任一，逗号分隔"></div>' +
    '<div class="row">渠道 ' + ruleChannelBoxes(r.channels) + '</div>' +
    '<div class="row">推送词 <input class="e-tpl" size="34" value="' + esc(r.messageTemplate || '') +
      '" placeholder="留空 = 用全局默认模板">' +
    ' <label><input type="checkbox" class="e-enabled"' + (r.enabled ? ' checked' : '') + '> 启用</label>';
}
function ruleRow(r) {
  return '<div class="clause" data-id="' + r.id + '">' + ruleFormRows(r) +
    ' <button onclick="saveRule(' + r.id + ')">保存</button>' +
    ' <button onclick="delRule(' + r.id + ')">删除</button></div></div>';
}
function addRuleRow() {
  return '<div class="clause add" id="rule-add">' +
    ruleFormRows({ keywords: [], areas: [], channels: [], messageTemplate: null, enabled: true }) +
    ' <button onclick="addRule()">新增规则</button></div></div>';
}
function loadModalRules() {
  var box = document.getElementById('modal-rules');
  if (!box || modalUid == null) return;
  Promise.all([api('/api/channels'), api('/api/rules?uid=' + modalUid)]).then(function (rs) {
    modalChannels = rs[0].channels || [];
    var rules = rs[1].rules || [];
    var def = null, cond = [];
    for (var i = 0; i < rules.length; i++) {
      // 空条件规则 = 默认推送，固定在渲染第一行（其余按 id 从上到下）
      if (!def && rules[i].keywords.length === 0 && rules[i].areas.length === 0) def = rules[i];
      else cond.push(rules[i]);
    }
    box.innerHTML = defaultRuleRow(def) + cond.map(ruleRow).join('') + addRuleRow();
  }).catch(function (e) { toast(e.message, true); });
}
function readRuleForm(div) {
  return {
    keywords: splitCsv(div.querySelector('.e-kw').value),
    areas: splitCsv(div.querySelector('.e-area').value),
    channels: checkedChannelIds(div),
    messageTemplate: div.querySelector('.e-tpl').value.trim() || null,
    enabled: div.querySelector('.e-enabled').checked,
  };
}
function saveDefaultRule() {
  var div = document.querySelector('.clause[data-default="1"]');
  var body = {
    keywords: [], areas: [],
    channels: checkedChannelIds(div),
    messageTemplate: div.querySelector('.e-tpl').value.trim() || null,
    enabled: div.querySelector('.e-enabled').checked,
  };
  var id = div.getAttribute('data-id');
  if (id) runModal(api('/api/rules/' + id, 'PUT', body), '已保存');
  else { body.uid = modalUid; runModal(api('/api/rules', 'POST', body), '已保存'); }
}
function addRule() {
  var body = readRuleForm(document.getElementById('rule-add'));
  body.uid = modalUid;
  runModal(api('/api/rules', 'POST', body), '已新增');
}
function saveRule(id) {
  runModal(api('/api/rules/' + id, 'PUT',
    readRuleForm(document.querySelector('.clause[data-id="' + id + '"]'))), '已保存');
}
function delRule(id) {
  if (confirm('删除这条规则？')) runModal(api('/api/rules/' + id, 'DELETE'), '已删除');
}

// ---- 关注未监听 ----
function loadFollows() {
  return api('/api/follows').then(function (j) {
    var rows = (j.follows || []).filter(function (f) { return !f.watched; });
    document.getElementById('follow-list').innerHTML = rows.map(function (f) {
      return '<div class="follow-card">' + avatarHtml(f.face, f.uname, 'f-avatar') +
        '<div class="f-name">' + esc(f.uname || f.uid) + '</div>' +
        '<button onclick="watch(' + q(f.uid) + ')">+ 监听</button></div>';
    }).join('') || '<p class="hint">无（或关注同步未启用）</p>';
  }).catch(function (e) { toast(e.message, true); });
}
function watch(uid) {
  api('/api/streamers/' + uid + '/watch', 'POST').then(function () {
    toast('已加入监听'); loadStreamers(); loadFollows();
  }).catch(function (e) { toast(e.message, true); });
}

// ---- 启动与轮询：status 60s，streamers/follows 30s（弹窗 DOM 不被重建） ----
loadStatus();
loadStreamers();
loadFollows();
setInterval(loadStatus, 60000);
setInterval(function () { loadStreamers(); loadFollows(); }, 30000);
`;
