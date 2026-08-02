/**
 * 控制面板的单页 HTML，以字符串内嵌（dist 只编译 TS，不拷贝静态文件）。
 * 原生 fetch 调 /api/*，无框架无 CDN，离线可用。
 * 注意：内嵌脚本里不得出现反引号与 ${，避免与外层模板字面量冲突。
 */
export const PANEL_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DD-claw 控制面板</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:1240px;margin:1.2rem auto;padding:0 1rem;color:#222}
h1{font-size:1.25rem}h2{font-size:1.05rem;border-bottom:1px solid #ddd;padding-bottom:.2rem}
table{border-collapse:collapse;width:100%;font-size:.88rem}
th,td{border:1px solid #ddd;padding:.3rem .45rem;text-align:left;vertical-align:middle}
input,select{font-size:.85rem;padding:.15rem .25rem;box-sizing:border-box}
td input{width:96%}
button{font-size:.85rem;padding:.2rem .6rem;cursor:pointer}
#toast{min-height:1.4em;font-size:.9rem;margin:.3rem 0}
#toast.ok{color:#177245}#toast.err{color:#c0392b}
.clause{border:1px solid #ddd;border-radius:4px;padding:.5rem .7rem;margin:.5rem 0}
.clause.add{background:#f7f9fc;border-style:dashed}
.clause label{white-space:nowrap;font-size:.85rem;margin-right:.5rem}
.clause .row{margin:.25rem 0}
.hint{color:#666;font-size:.83rem}
small{color:#888;font-weight:normal}
</style>
</head>
<body>
<h1>DD-claw 控制面板 <small>v0 · 改库即生效，无需重启</small></h1>
<div id="toast"></div>

<section id="sec-status">
<h2>系统状态</h2>
<table><tbody id="status-body"><tr><td>加载中…</td></tr></tbody></table>
</section>

<section id="sec-streamers">
<h2>监听名单</h2>
<p class="hint">模式：on 正常 / silent 追踪不推送 / off 不监听。画像是自由文本，喂给内容判定，建议写「常见内容/语言风格/优先级经验」。</p>
<table>
<thead><tr><th>uid</th><th>昵称</th><th>别名</th><th>模式</th><th>分析</th><th>room_id</th><th>微博 uid</th><th>主播画像</th><th></th></tr></thead>
<tbody id="streamer-body"></tbody>
</table>
</section>

<section id="sec-follows">
<h2>候选池（关注列表）</h2>
<p class="hint">来自 follows 同步；「加入监听」以 mode=on、source=follows 入库。</p>
<table>
<thead><tr><th>uid</th><th>昵称</th><th>状态</th><th></th></tr></thead>
<tbody id="follow-body"></tbody>
</table>
</section>

<section id="sec-clauses">
<h2>偏好子句</h2>
<p class="hint">一行 = 一个条件分支，条件之间是 AND：场景与标题关键词都留空 = 该主播的兜底子句。
推送词可用 {alias} {uname} {title} 变量；目标格式 group:群号, private:QQ号，留空 = 各通道默认目标。</p>
<div class="clause add" id="clause-add">
<div class="row">主播 <select class="c-uid" id="c-uid"></select>
场景 <label><input type="checkbox" class="e-scene" value="chatting"> 杂谈</label><label><input type="checkbox" class="e-scene" value="singing"> 唱歌</label><label><input type="checkbox" class="e-scene" value="gaming"> 游戏</label><label><input type="checkbox" class="e-scene" value="show"> 演出</label><label><input type="checkbox" class="e-scene" value="other"> 其他</label>
置信度≥ <input class="e-conf" size="4" placeholder="0-1 留空不限">
标题关键词 <input class="e-kw" size="16" placeholder="逗号分隔，留空不限">
优先级 <select class="e-pri"><option value="high">high 高</option><option value="normal" selected>normal 普通</option><option value="low">low 低</option></select>
<label><input type="checkbox" class="e-enabled" checked> 启用</label></div>
<div class="row">推送词 <input class="e-tpl" size="42" placeholder="例：{alias} 开歌回了，速来">
目标 <input class="e-targets" size="30" placeholder="group:123456, private:789（空=默认目标）">
<button onclick="addClause()">新增子句</button></div>
</div>
<div id="clause-list"></div>
</section>

<script>
var SCENES = ['chatting','singing','gaming','show','other'];
var SCENE_NAMES = { chatting:'杂谈', singing:'唱歌', gaming:'游戏', show:'演出', other:'其他' };
var streamers = [];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
  setTimeout(function () { t.textContent = ''; t.className = ''; }, 4000);
}
function run(p, okMsg) {
  p.then(function () { if (okMsg) toast(okMsg); loadAll(); })
   .catch(function (e) { toast(e.message, true); });
}

// ---- 系统状态 ----
function loadStatus() {
  api('/api/status').then(function (s) {
    var up = Math.max(0, Math.floor(Date.now() / 1000) - s.startedAt);
    document.getElementById('status-body').innerHTML =
      '<tr><td>Cookie</td><td>' + (s.cookieImported ? '已导入' : '未导入（关注同步等凭据功能停用）') + '</td></tr>' +
      '<tr><td>关注列表同步</td><td>' + (s.followsEnabled ? '启用' : '停用') + '</td></tr>' +
      '<tr><td>推送通道</td><td>' + esc(s.notifiers.join(', ') || '(无)') + '</td></tr>' +
      '<tr><td>监听中</td><td>' + s.watchedCount + ' 位主播</td></tr>' +
      '<tr><td>运行时长</td><td>' + Math.floor(up / 3600) + 'h ' + Math.floor(up % 3600 / 60) + 'm</td></tr>';
  }).catch(function (e) { toast(e.message, true); });
}

// ---- 监听名单 ----
function modeOpts(m) {
  var names = { off: 'off 不监听', silent: 'silent 追踪不推送', on: 'on 正常' };
  return ['off','silent','on'].map(function (v) {
    return '<option value="' + v + '"' + (v === m ? ' selected' : '') + '>' + names[v] + '</option>';
  }).join('');
}
function loadStreamers() {
  return api('/api/streamers').then(function (j) {
    streamers = j.streamers;
    var rows = streamers.map(function (s) {
      return '<tr data-uid="' + s.uid + '">' +
        '<td>' + s.uid + '</td><td>' + esc(s.uname) + '</td>' +
        '<td><input class="f-alias" value="' + esc(s.alias) + '" placeholder="别名"></td>' +
        '<td><select class="f-mode">' + modeOpts(s.mode) + '</select></td>' +
        '<td><input type="checkbox" class="f-analyze"' + (s.analyze ? ' checked' : '') + '></td>' +
        '<td><input class="f-room" value="' + esc(s.roomId) + '" placeholder="自动回填"></td>' +
        '<td><input class="f-weibo" value="' + esc(s.weiboUid) + '"></td>' +
        '<td><input class="f-note" value="' + esc(s.profileNote) + '" placeholder="常见内容/语言风格/优先级经验"></td>' +
        '<td><button onclick="saveStreamer(\\'' + s.uid + '\\')">保存</button></td></tr>';
    }).join('');
    document.getElementById('streamer-body').innerHTML =
      rows || '<tr><td colspan="9">名单为空（从候选池加入，或在 config.json 配种子）</td></tr>';
  });
}
function saveStreamer(uid) {
  var tr = document.querySelector('tr[data-uid="' + uid + '"]');
  var val = function (sel) { var v = tr.querySelector(sel).value.trim(); return v || null; };
  run(api('/api/streamers/' + uid, 'PUT', {
    alias: val('.f-alias'),
    mode: tr.querySelector('.f-mode').value,
    analyze: tr.querySelector('.f-analyze').checked,
    roomId: val('.f-room'),
    weiboUid: val('.f-weibo'),
    profileNote: val('.f-note'),
  }), '已保存');
}

// ---- 候选池 ----
function loadFollows() {
  return api('/api/follows').then(function (j) {
    var rows = j.follows.map(function (f) {
      return '<tr><td>' + f.uid + '</td><td>' + esc(f.uname) + '</td>' +
        '<td>' + (f.watched ? '已监听' : '未监听') + '</td>' +
        '<td>' + (f.watched ? '' : '<button onclick="watch(\\'' + f.uid + '\\')">加入监听</button>') + '</td></tr>';
    }).join('');
    document.getElementById('follow-body').innerHTML =
      rows || '<tr><td colspan="4">无关注数据（需导入 cookies.json 并启用 follows 同步）</td></tr>';
  });
}
function watch(uid) { run(api('/api/streamers/' + uid + '/watch', 'POST'), '已加入监听'); }

// ---- 偏好子句 ----
function priOpts(p) {
  var names = { high: 'high 高', normal: 'normal 普通', low: 'low 低' };
  return ['high','normal','low'].map(function (v) {
    return '<option value="' + v + '"' + (v === p ? ' selected' : '') + '>' + names[v] + '</option>';
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
function sceneBoxes(scenes) {
  return SCENES.map(function (sc) {
    return '<label><input type="checkbox" class="e-scene" value="' + sc + '"' +
      (scenes.indexOf(sc) >= 0 ? ' checked' : '') + '> ' + SCENE_NAMES[sc] + '</label>';
  }).join('');
}
function clauseRow(c) {
  return '<div class="clause" data-id="' + c.id + '">' +
    '<div class="row">场景 ' + sceneBoxes(c.scenes) +
    ' 置信度≥ <input class="e-conf" size="4" value="' + (c.minConfidence == null ? '' : c.minConfidence) + '" placeholder="0-1 留空不限">' +
    ' 标题关键词 <input class="e-kw" size="16" value="' + esc(c.titleKeywords.join(', ')) + '" placeholder="逗号分隔，留空不限">' +
    ' 优先级 <select class="e-pri">' + priOpts(c.priority) + '</select>' +
    ' <label><input type="checkbox" class="e-enabled"' + (c.enabled ? ' checked' : '') + '> 启用</label></div>' +
    '<div class="row">推送词 <input class="e-tpl" size="42" value="' + esc(c.messageTemplate) + '" placeholder="可用 {alias} {uname} {title} 变量">' +
    ' 目标 <input class="e-targets" size="30" value="' + esc(targetsText(c.targets)) + '" placeholder="group:123456, private:789（空=默认目标）">' +
    ' <button onclick="saveClause(' + c.id + ')">保存</button>' +
    ' <button onclick="delClause(' + c.id + ')">删除</button></div></div>';
}
function loadClauses() {
  return api('/api/clauses').then(function (j) {
    var nameOf = {};
    streamers.forEach(function (s) { nameOf[s.uid] = s.alias || s.uname || s.uid; });
    var byUid = {};
    j.clauses.forEach(function (c) { (byUid[c.uid] = byUid[c.uid] || []).push(c); });
    var html = Object.keys(byUid).map(function (uid) {
      return '<h4>' + esc(nameOf[uid] || uid) + ' <small>' + uid + '</small></h4>' +
        byUid[uid].map(clauseRow).join('');
    }).join('');
    document.getElementById('clause-list').innerHTML = html || '<p class="hint">还没有偏好子句。</p>';
    document.getElementById('c-uid').innerHTML = streamers.map(function (s) {
      return '<option value="' + s.uid + '">' + esc(s.alias || s.uname || s.uid) + ' (' + s.uid + ')</option>';
    }).join('');
  });
}
function readClauseForm(div) {
  var scenes = Array.prototype.slice.call(div.querySelectorAll('.e-scene'))
    .filter(function (x) { return x.checked; })
    .map(function (x) { return x.value; });
  var conf = div.querySelector('.e-conf').value.trim();
  var minConfidence = conf === '' ? null : Number(conf);
  if (minConfidence !== null && (isNaN(minConfidence) || minConfidence < 0 || minConfidence > 1)) {
    throw new Error('置信度必须是 0-1 的数字');
  }
  return {
    scenes: scenes,
    minConfidence: minConfidence,
    titleKeywords: div.querySelector('.e-kw').value.split(',')
      .map(function (s) { return s.trim(); }).filter(Boolean),
    priority: div.querySelector('.e-pri').value,
    messageTemplate: div.querySelector('.e-tpl').value,
    targets: parseTargetsText(div.querySelector('.e-targets').value),
    enabled: div.querySelector('.e-enabled').checked,
  };
}
function saveClause(id) {
  try {
    run(api('/api/clauses/' + id, 'PUT', readClauseForm(document.querySelector('.clause[data-id="' + id + '"]'))), '已保存');
  } catch (e) { toast(e.message, true); }
}
function delClause(id) {
  if (confirm('删除这条子句？')) run(api('/api/clauses/' + id, 'DELETE'), '已删除');
}
function addClause() {
  var div = document.getElementById('clause-add');
  try {
    var body = readClauseForm(div);
    body.uid = div.querySelector('.c-uid').value;
    if (!body.uid) throw new Error('监听名单为空，请先从候选池加入主播');
    run(api('/api/clauses', 'POST', body), '已新增');
  } catch (e) { toast(e.message, true); }
}

function loadAll() {
  loadStatus();
  loadStreamers().then(loadClauses).catch(function (e) { toast(e.message, true); });
  loadFollows().catch(function (e) { toast(e.message, true); });
}
loadAll();
setInterval(loadStatus, 60000);
</script>
</body>
</html>
`;
