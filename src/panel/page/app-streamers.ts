/**
 * 面板前端 · 卡片5 主播列表 + 详情弹窗（全字段编辑 + 该主播推送规则 CRUD，规则编辑是二级 sheet）。
 * 卡片4 时间表占位是静态 HTML，在 page.ts 壳里。
 * 内嵌进页面 <script>，内容不得出现反引号与 ${，一律字符串拼接。依赖 icons / app-core 段。
 */
export const APP_STREAMERS = `
var streamers = [];
var modalUid = null;
var modalChannels = [];
var rulesCache = [];

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

// ---- 详情弹窗：上半区 iOS 分组表单（别名/直播间号/微博/画像 + 三开关），下半区推送规则 ----
function formSwitch(label, id, checked) {
  return '<div class="row"><span class="row-title">' + label + '</span><span class="row-end">' +
    switchHtml('id="' + id + '"', checked) + '</span></div>';
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
    '<div class="form-card">' +
      formSwitch('监听', 'f-watch', s.watch) +
      formSwitch('LLM 分析', 'f-analyze', s.analyze) +
      formSwitch('推送', 'f-notify', s.notify) +
    '</div>' +
    '<div class="sheet-foot"><button class="btn" data-action="close-sheet" data-level="1">关闭</button>' +
    '<button class="btn btn-primary" data-action="save-streamer">保存</button></div>' +
    '<div class="sheet-section"><div class="sheet-sub">推送规则</div>' +
    '<div class="hint">命中即推，同渠道去重；顺序决定同渠道推送词取舍</div>' +
    '<div id="modal-rules">加载中…</div></div>');
  sheetCleanups[1] = function () { modalUid = null; modalChannels = []; rulesCache = []; };
  // modal-rules 容器每次开窗都是新元素，sortable 在开窗时绑定一次
  makeSortable(document.getElementById('modal-rules'), {
    items: function () { return rulesCache; },
    getId: function (r) { return r.id; },
    onOrder: function (ids) {
      api('/api/rules/order', 'PUT', { uid: modalUid, ids: ids })
        .then(function () { loadModalRules(); loadStreamers(); })
        .catch(function (err) { toast(err.message, true); loadModalRules(); });
    },
  });
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

// ---- 推送规则（uid 固定为 modalUid；可排序开关列表 + 二级 sheet 编辑，默认推送在「推送」卡片全局配置） ----
function splitCsv(v) {
  return v.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

function modalChannelById(id) {
  for (var k = 0; k < modalChannels.length; k++) if (modalChannels[k].id === id) return modalChannels[k];
  return null;
}
function ruleRowHtml(r) {
  var tags = (r.channels || []).map(function (cid) {
    var c = modalChannelById(cid);
    return c ? '<span class="tag">' + esc(c.name) + '</span>' : '';
  }).join('');
  return '<div class="row" draggable="true" data-sid="' + r.id + '">' +
    gripHtml() +
    switchHtml('data-change="toggle-rule"', r.enabled) +
    '<span class="row-title">' + esc(r.name) + '</span>' + tags +
    '<span class="row-end">' +
    iconBtn('edit-rule', 'pencil', '编辑') +
    iconBtn('del-rule', 'trash', '删除', true) +
    '</span></div>';
}
function loadModalRules() {
  var box = document.getElementById('modal-rules');
  if (!box || modalUid == null) return;
  Promise.all([api('/api/channels'), api('/api/rules?uid=' + modalUid)]).then(function (rs) {
    modalChannels = rs[0].channels || [];
    rulesCache = rs[1].rules || [];
    box.innerHTML = rulesCache.map(ruleRowHtml).join('') +
      '<div class="add-row"><button class="btn btn-block" data-action="add-rule">' +
      icon('plus') + ' 添加规则</button></div>';
  }).catch(function (e) { toast(e.message, true); });
}

CHANGES['toggle-rule'] = function (el) {
  var id = el.closest('.row').getAttribute('data-sid');
  var on = el.checked;
  api('/api/rules/' + id, 'PUT', { enabled: on })
    .then(function () { toast(on ? '已启用' : '已停用'); loadModalRules(); loadStreamers(); })
    .catch(function (e) { toast(e.message, true); loadModalRules(); });
};

ACTIONS['del-rule'] = function (el) {
  var id = el.closest('.row').getAttribute('data-sid');
  if (!confirm('删除这条规则？')) return;
  api('/api/rules/' + id, 'DELETE')
    .then(function () { toast('已删除'); loadModalRules(); loadStreamers(); })
    .catch(function (e) { toast(e.message, true); });
};

// ---- 规则 新增/编辑 弹窗（二级 sheet；id=null 新增）；保存报错内联在按钮行 ----
ACTIONS['add-rule'] = function () { openRuleSheet(null); };
ACTIONS['edit-rule'] = function (el) {
  openRuleSheet(Number(el.closest('.row').getAttribute('data-sid')));
};

function openRuleSheet(id) {
  var r = null;
  if (id !== null) {
    for (var i = 0; i < rulesCache.length; i++) if (rulesCache[i].id === id) r = rulesCache[i];
    if (!r) { toast('规则数据未加载', true); return; }
  }
  var chanRows = modalChannels.length === 0
    ? ''
    : modalChannels.map(function (c) {
        return '<div class="row"><span class="row-title">' + esc(c.name) + '</span>' +
          '<span class="tag">' + esc(chanTypeName(c)) + '</span>' +
          '<span class="row-end">' +
          switchHtml('class="e-ch" value="' + c.id + '"', !!(r && (r.channels || []).indexOf(c.id) >= 0)) +
          '</span></div>';
      }).join('');
  openSheet(r ? '编辑规则' : '添加规则',
    field('名称', '<input id="r-name" value="' + (r ? esc(r.name) : '') + '">') +
    field('关键词', '<input id="r-kw" placeholder="逗号分隔，留空 = 任意匹配" value="' +
      (r ? esc(r.keywords.join(', ')) : '') + '">') +
    field('分区', '<input id="r-area" placeholder="逗号分隔，留空 = 任意匹配" value="' +
      (r ? esc(r.areas.join(', ')) : '') + '">') +
    '<div class="field"><label>渠道</label>' + (chanRows || '<span class="hint">还没有渠道</span>') + '</div>' +
    field('推送词', '<input id="r-tpl" placeholder="留空 = 全局默认推送词" value="' +
      (r ? esc(r.messageTemplate || '') : '') + '">') +
    '<div class="sheet-foot"><span id="rule-err" class="form-err"></span>' +
    '<button class="btn" data-action="close-sheet" data-level="2">取消</button>' +
    '<button class="btn btn-primary" data-action="save-rule" data-id="' + (r ? r.id : '') + '">保存</button></div>',
    2);
}

ACTIONS['save-rule'] = function (el) {
  var err = document.getElementById('rule-err');
  if (err) err.textContent = '';
  var name = document.getElementById('r-name').value.trim();
  if (!name) { if (err) err.textContent = '请填写规则名称'; return; }
  var body = {
    name: name,
    keywords: splitCsv(document.getElementById('r-kw').value),
    areas: splitCsv(document.getElementById('r-area').value),
    channels: Array.prototype.slice.call(document.querySelectorAll('#sheet-mask2 .e-ch'))
      .filter(function (x) { return x.checked; }).map(function (x) { return Number(x.value); }),
    messageTemplate: document.getElementById('r-tpl').value.trim() || null,
  };
  var idAttr = el.getAttribute('data-id');
  var req = idAttr
    ? api('/api/rules/' + idAttr, 'PUT', body)
    : api('/api/rules', 'POST', Object.assign({ uid: modalUid }, body));
  req.then(function () {
    closeSheet(2);
    toast(idAttr ? '已保存' : '已添加');
    loadModalRules();
    loadStreamers();
  }).catch(function (e) { if (err) err.textContent = e.message; });
};

// ---- 启动与轮询：监听卡 60s（app-listen 段），主播列表 30s（弹窗 DOM 不被重建） ----
loadStreamers();
setInterval(loadStreamers, 30000);
`;
