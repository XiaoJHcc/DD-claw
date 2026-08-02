/**
 * 面板前端 · 卡片3 主播列表 + 详情弹窗（全字段编辑 + 该主播子句 CRUD）+ 关注未监听区。
 * 卡片2 时间表占位是静态 HTML，在 page.ts 壳里。
 * 内嵌进页面 <script>，内容不得出现反引号与 ${，一律字符串拼接。依赖 app-core 段。
 */
export const APP_STREAMERS = `
var streamers = [];
var modalUid = null;
var SCENES = ['chatting', 'singing', 'gaming', 'show', 'other'];
var SCENE_NAMES = { chatting: '杂谈', singing: '唱歌', gaming: '游戏', show: '演出', other: '其他' };
var MODE_STATE = { on: ['green', '监听中'], silent: ['yellow', '静默'], off: ['gray', '停用'] };

function avatarHtml(face, name, cls) {
  cls = cls || 'avatar';
  if (face) return '<img class="' + cls + '" referrerpolicy="no-referrer" src="' + esc(face) + '" alt="">';
  return '<span class="' + cls + ' avatar-ph">' + esc(String(name || '?').charAt(0)) + '</span>';
}

// ---- 主播卡片列表 ----
function streamerCard(s) {
  var name = s.alias || s.uname || String(s.uid);
  var ms = MODE_STATE[s.mode] || ['gray', s.mode];
  var csum = (s.clauses && s.clauses.count > 0)
    ? s.clauses.count + ' 条子句 · 最高 ' + s.clauses.maxPriority : '无子句';
  var left = '<div class="sc-left">' + avatarHtml(s.face, name) +
    '<div class="sc-name">' + esc(name) + '</div>' +
    '<div class="meta">UID ' + esc(s.uid) + '</div>' +
    '<div class="meta">直播间 ' + (s.roomId ? esc(s.roomId) : '—') + '</div>' +
    '<div class="meta">微博 ' + (s.weiboUid ? esc(s.weiboUid) : '—') + '</div>' +
    '<div class="meta sc-note' + (s.profileNote ? '' : ' none') + '">' + esc(s.profileNote || '未填写') + '</div>' +
    '<div class="meta"><span class="dot ' + ms[0] + '"></span>' + ms[1] + ' · ' + esc(csum) + '</div></div>';
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
    // 主列表只展示监听中的（mode != off）；off 的回到关注区等待重新加入
    var active = streamers.filter(function (s) { return s.mode !== 'off'; });
    document.getElementById('streamer-list').innerHTML =
      active.map(streamerCard).join('') || '<p class="hint">名单为空（从下方关注列表加入）。</p>';
  }).catch(function (e) { toast(e.message, true); });
}

// ---- 详情弹窗：全字段编辑 ----
function modeOpts(m) {
  var names = { off: 'off 不监听', silent: 'silent 追踪不推送', on: 'on 正常' };
  return ['off', 'silent', 'on'].map(function (v) {
    return '<option value="' + v + '"' + (v === m ? ' selected' : '') + '>' + names[v] + '</option>';
  }).join('');
}
function fieldVal(id) { var v = document.getElementById(id).value.trim(); return v || null; }
function openStreamer(uid) {
  var s = null;
  for (var i = 0; i < streamers.length; i++) if (String(streamers[i].uid) === String(uid)) s = streamers[i];
  if (!s) { toast('主播数据未加载', true); return; }
  modalUid = s.uid;
  openModal(
    '<h3>' + esc(s.alias || s.uname || s.uid) + ' <small>UID ' + esc(s.uid) + '</small></h3>' +
    '<div class="mrow"><label>别名 <input id="f-alias" value="' + esc(s.alias || '') + '"></label>' +
    '<label>模式 <select id="f-mode">' + modeOpts(s.mode) + '</select></label>' +
    '<label><input type="checkbox" id="f-analyze"' + (s.analyze ? ' checked' : '') + '> 分析</label></div>' +
    '<div class="mrow"><label>直播间号 <input id="f-room" value="' + esc(s.roomId || '') + '"></label>' +
    '<label>微博 uid <input id="f-weibo" value="' + esc(s.weiboUid || '') + '"></label></div>' +
    '<div class="mrow"><label class="wfull">画像 <input id="f-note" class="wfull" value="' +
      esc(s.profileNote || '') + '" placeholder="常见内容 / 语言风格 / 优先级经验"></label></div>' +
    '<div class="mrow"><button onclick="saveStreamer()">保存</button> ' +
    '<button onclick="closeModal()">关闭</button></div>' +
    '<h4>偏好子句</h4>' +
    '<p class="hint">条件之间是 AND；场景与关键词都留空 = 兜底子句。推送词变量 {alias} {uname} {title}；' +
    '目标格式 group:群号, private:QQ号，留空 = 各通道默认目标。</p>' +
    '<div id="modal-clauses">加载中…</div>');
  modalCleanup = function () { modalUid = null; };
  loadModalClauses();
}
function runModal(p, okMsg) {
  p.then(function () {
    if (okMsg) toast(okMsg);
    loadStreamers();
    if (modalUid != null) loadModalClauses(); // 只重建子句区，不动上方编辑表单
  }).catch(function (e) { toast(e.message, true); });
}
function saveStreamer() {
  runModal(api('/api/streamers/' + modalUid, 'PUT', {
    alias: fieldVal('f-alias'), mode: document.getElementById('f-mode').value,
    analyze: document.getElementById('f-analyze').checked,
    roomId: fieldVal('f-room'), weiboUid: fieldVal('f-weibo'), profileNote: fieldVal('f-note'),
  }), '已保存');
}

// ---- 子句 CRUD（uid 固定为 modalUid；表单逻辑沿用旧版） ----
function priOpts(p) {
  var names = { high: 'high 高', normal: 'normal 普通', low: 'low 低' };
  return ['high', 'normal', 'low'].map(function (v) {
    return '<option value="' + v + '"' + (v === p ? ' selected' : '') + '>' + names[v] + '</option>';
  }).join('');
}
function sceneBoxes(scenes) {
  return SCENES.map(function (sc) {
    return '<label><input type="checkbox" class="e-scene" value="' + sc + '"' +
      (scenes.indexOf(sc) >= 0 ? ' checked' : '') + '> ' + SCENE_NAMES[sc] + '</label>';
  }).join('');
}
function targetsText(ts) {
  return (ts || []).map(function (t) { return t.type + ':' + t.id; }).join(', ');
}
function parseTargetsText(v) {
  v = v.trim();
  if (!v) return null;
  return v.split(',').map(function (part) {
    var kv = part.trim().split(':');
    if (kv.length !== 2 || (kv[0] !== 'group' && kv[0] !== 'private') || !/^\\d+$/.test(kv[1])) {
      throw new Error('目标格式应为 group:群号, private:QQ号');
    }
    return { type: kv[0], id: kv[1] };
  });
}
function clauseFormRows(c) {
  return '<div class="row">场景 ' + sceneBoxes(c.scenes) +
    ' 置信度≥ <input class="e-conf" size="4" value="' + (c.minConfidence == null ? '' : c.minConfidence) + '" placeholder="0-1">' +
    ' 关键词 <input class="e-kw" size="12" value="' + esc(c.titleKeywords.join(', ')) + '" placeholder="逗号分隔">' +
    ' 优先级 <select class="e-pri">' + priOpts(c.priority) + '</select>' +
    ' <label><input type="checkbox" class="e-enabled"' + (c.enabled ? ' checked' : '') + '> 启用</label></div>' +
    '<div class="row">推送词 <input class="e-tpl" size="34" value="' + esc(c.messageTemplate) + '" placeholder="例：{alias} 开歌回了，速来">' +
    ' 目标 <input class="e-targets" size="24" value="' + esc(targetsText(c.targets)) + '" placeholder="group:123, private:789">';
}
function clauseRow(c) {
  return '<div class="clause" data-id="' + c.id + '">' + clauseFormRows(c) +
    ' <button onclick="saveClause(' + c.id + ')">保存</button>' +
    ' <button onclick="delClause(' + c.id + ')">删除</button></div></div>';
}
function addClauseRow() {
  return '<div class="clause add" id="clause-add">' +
    clauseFormRows({ scenes: [], minConfidence: null, titleKeywords: [], priority: 'normal',
      messageTemplate: '', targets: null, enabled: true }) +
    ' <button onclick="addClause()">新增子句</button></div></div>';
}
function loadModalClauses() {
  var box = document.getElementById('modal-clauses');
  if (!box || modalUid == null) return;
  api('/api/clauses').then(function (j) {
    var mine = (j.clauses || []).filter(function (c) { return String(c.uid) === String(modalUid); });
    box.innerHTML = mine.map(clauseRow).join('') + addClauseRow();
  }).catch(function (e) { toast(e.message, true); });
}
function readClauseForm(div) {
  var scenes = Array.prototype.slice.call(div.querySelectorAll('.e-scene'))
    .filter(function (x) { return x.checked; }).map(function (x) { return x.value; });
  var conf = div.querySelector('.e-conf').value.trim();
  var minConfidence = conf === '' ? null : Number(conf);
  if (minConfidence !== null && (isNaN(minConfidence) || minConfidence < 0 || minConfidence > 1)) {
    throw new Error('置信度必须是 0-1 的数字');
  }
  return {
    scenes: scenes, minConfidence: minConfidence,
    titleKeywords: div.querySelector('.e-kw').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
    priority: div.querySelector('.e-pri').value,
    messageTemplate: div.querySelector('.e-tpl').value,
    targets: parseTargetsText(div.querySelector('.e-targets').value),
    enabled: div.querySelector('.e-enabled').checked,
  };
}
function addClause() {
  try {
    var body = readClauseForm(document.getElementById('clause-add'));
    body.uid = modalUid;
    runModal(api('/api/clauses', 'POST', body), '已新增');
  } catch (e) { toast(e.message, true); }
}
function saveClause(id) {
  try {
    runModal(api('/api/clauses/' + id, 'PUT',
      readClauseForm(document.querySelector('.clause[data-id="' + id + '"]'))), '已保存');
  } catch (e) { toast(e.message, true); }
}
function delClause(id) {
  if (confirm('删除这条子句？')) runModal(api('/api/clauses/' + id, 'DELETE'), '已删除');
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
