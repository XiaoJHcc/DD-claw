// 面板前端 · 主播列表视图（每个主播一张独立卡片）+ 详情弹窗（全字段编辑 + 该主播的生效推送规则视图）。
// 规则的新增/编辑/排序收编在「推送」卡片；详情弹窗规则区为纯展示（不再勾选本主播是否生效——
// 避免取消勾选后规则从列表消失、以及「全部主播」规则被退化为显式名单），点击行直接打开该规则的编辑弹窗。
import { api, toast, ACTIONS, esc, openSheet, sheetCleanups, checkboxHtml, field, durSpan, ruleDeadReason } from './core.js';
import { icon } from './icons.js';

let streamers = [];
let modalUid = null;
let modalChannels = [];
let modalCats = [];
let modalRules = [];

export function avatarHtml(face, name, cls) {
  cls = cls || 'avatar';
  if (face) return `<img class="${cls}" referrerpolicy="no-referrer" src="${esc(face)}" alt="">`;
  return `<span class="${cls} avatar-ph">${esc(String(name || '?').charAt(0))}</span>`;
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
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  return Math.floor(diff / 86400) + ' 天前';
}
function postRow(p) {
  const inner =
    '<div class="post-body"><div class="post-head"><span class="tag">' + postTypeTag(p) + '</span>' +
    `<span class="post-time">${relTime(p.pubTs)}</span></div>` +
    `<div class="post-text">${esc(p.text || '(无文字)')}</div></div>` +
    (p.pics && p.pics[0]
      ? `<img class="post-thumb" referrerpolicy="no-referrer" src="${esc(p.pics[0])}" alt="">`
      : '');
  // 卡片整体点击是开详情弹窗；动态链接标 noop 吞掉卡片点击，新窗口打开
  if (p.url) {
    return `<a class="post" href="${esc(p.url)}" target="_blank" rel="noreferrer"` +
      ' data-action="noop">' + inner + '</a>';
  }
  return '<div class="post">' + inner + '</div>';
}
function postsColumn(s) {
  // 开播类型的动态（LIVE_RCMD）是自动生成的噪音，不展示；卡片固定高度，无小标题，溢出裁剪
  const all = s.posts || [];
  const posts = all.filter(function (p) { return p.type !== 'DYNAMIC_TYPE_LIVE_RCMD'; });
  const rows = posts.length
    ? posts.map(postRow).join('')
    : '<p class="hint">' + (all.length ? '暂无动态' : '暂无抓取') + '</p>';
  return '<div class="sc-posts">' + rows + '</div>';
}
function streamerCard(s) {
  // 卡片标题用原名（左栏宽度放得下；简称只留给真正空间受限处：规则行标签/时间表横条/推送文案）
  const name = s.uname || String(s.uid);
  const isLive = !!(s.live && s.live.isLive);
  const state = '监听中' + (s.notify ? '' : ' · 推送关') + (s.analyze ? ' · LLM分析' : '');
  const ruleTags = (s.rules && s.rules.names && s.rules.names.length)
    ? s.rules.names.map(function (n) { return `<span class="tag">${esc(n)}</span>`; }).join('')
    : '';
  const left = '<div class="sc-left">' + avatarHtml(s.face, name) +
    `<div class="sc-name">${esc(name)}</div>` +
    `<div class="meta">直播间 ${s.roomId ? esc(s.roomId) : '—'}</div>` +
    `<div class="meta">微博 ${s.weiboNick ? esc(s.weiboNick) : (s.weiboUid ? esc(s.weiboUid) : '—')}</div>` +
    '<div class="sc-state"><span class="meta"><span class="dot green"></span>' + esc(state) + '</span>' +
    ruleTags +
    '</div>' +
    '</div>';
  // 中栏：直播间关键帧在上（在播带「直播中」徽标），直播信息在关键帧下方
  let mid;
  if (isLive) {
    const img = s.live.keyframe || s.live.cover;
    const area = [s.live.parentAreaName, s.live.areaName].filter(Boolean).join(' / ');
    mid = '<div class="sc-mid"><div class="kf-wrap">' +
      (img ? `<img class="kf" referrerpolicy="no-referrer" src="${esc(img)}" alt="">`
           : '<div class="kf kf-empty">' + icon('video-off') + '</div>') +
      '<span class="live-badge">直播中</span></div>' +
      '<div class="live-info"><div class="live-title">' + esc(s.live.title || '') + '</div>' +
      (area ? `<div class="meta">${esc(area)}</div>` : '') +
      '<div class="meta">' + (s.live.liveTime ? durSpan(s.live.liveTime, '开播 ') : '开播 —') +
      ' · 在线 ' + (s.live.online == null ? '—' : s.live.online) + '</div></div></div>';
  } else {
    const off = (s.live && s.live.lastLiveAt) ? durSpan(s.live.lastLiveAt, '下播 ') : '未见开播';
    const prev = (s.live && s.live.title) ? `<div class="meta">上一场：${esc(s.live.title)}</div>` : '';
    mid = '<div class="sc-mid"><div class="kf-wrap"><div class="kf kf-empty">' + icon('video-off') + '</div></div>' +
      `<div class="live-info"><div class="off-dur">${off}</div>${prev}</div></div>`;
  }
  return `<div class="sc-card${isLive ? '' : ' off'}" data-action="open-streamer" data-uid="` +
    `${esc(s.uid)}">${left}<div class="sc-divide"></div>${mid}<div class="sc-divide"></div>${postsColumn(s)}</div>`;
}
export function loadStreamers() {
  return api('/api/streamers').then(function (j) {
    streamers = j.streamers || [];
    const active = streamers.filter(function (s) { return s.watch; });
    // 主列表只展示监听中的（watch=true）；关掉的回到「关注列表」等待重新加入
    document.getElementById('streamer-list').innerHTML =
      active.map(streamerCard).join('') || '<p class="hint">名单为空（从下方关注列表加入）。</p>';
  }).catch(function (e) { toast(e.message, true); });
}

// ---- 详情弹窗：上半区分段卡片表单（简称/微博/画像 + 三个勾选项），下半区生效规则视图 ----
// 弹窗标题用原名（uname）；alias 已正规化为「简称」，仅在空间受限处（卡片名/时间表横条/推送文案）优先
function formCheck(label, id, checked) {
  return checkboxHtml(`id="${id}"`, checked, false, label);
}
function fieldVal(id) { const v = document.getElementById(id).value.trim(); return v || null; }

ACTIONS['open-streamer'] = function (el) { openStreamer(el.getAttribute('data-uid')); };

function openStreamer(uid) {
  let s = null;
  for (let i = 0; i < streamers.length; i++) if (String(streamers[i].uid) === String(uid)) s = streamers[i];
  if (!s) { toast('主播数据未加载', true); return; }
  modalUid = s.uid;
  openSheet(String(s.uname || s.uid),
    field('简称', `<input id="f-alias" placeholder="如：阿梓" value="${esc(s.alias || '')}">`) +
    field('微博昵称', `<input id="f-weibo" placeholder="如：阿梓Official" value="${esc(s.weiboNick || '')}">`) +
    field('画像', `<textarea id="f-note" rows="3" placeholder="性格 / 直播风格 / 观众画像等">${esc(s.profileNote || '')}</textarea>`) +
    '<div class="row">' +
      formCheck('监听', 'f-watch', s.watch) +
      formCheck('LLM 分析', 'f-analyze', s.analyze) +
      formCheck('推送', 'f-notify', s.notify) +
    '</div>' +
    '<div class="sheet-foot"><button class="btn" data-action="close-sheet" data-level="1">关闭</button>' +
    '<button class="btn btn-primary" data-action="save-streamer">保存</button></div>' +
    '<div class="sheet-section"><div class="sheet-sub">生效的推送规则</div>' +
    '<div id="modal-rules">加载中…</div></div>');
  // 自动提取信息不属设置，追加到大标题右侧（openSheet 会对 title 转义，故事后把 meta 插进标题 DOM）
  const titleEl = document.querySelector('#sheet-mask1 .sheet-title');
  if (titleEl) titleEl.insertAdjacentHTML('beforeend',
    `<span class="sheet-head-meta">UID ${esc(s.uid)} · 直播间 ${s.roomId ? esc(s.roomId) : '—'}</span>`);
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

// ---- 生效的推送规则（纯展示：规则的增删改/生效主播都在「推送」卡片；点击行跳转过去） ----
function modalChannelById(id) {
  for (let k = 0; k < modalChannels.length; k++) if (modalChannels[k].id === id) return modalChannels[k];
  return null;
}

function modalCatName(categoryId) {
  if (categoryId == null) return '任意开播';
  for (let i = 0; i < modalCats.length; i++) if (modalCats[i].id === categoryId) return modalCats[i].name;
  return '分类已删除';
}

// 行序 = 全局 sort。不可达规则（ruleDeadReason）整行置灰划线、只留原因标签；
// 停用渠道的标签不显示（是否可用看渠道卡）
function modalRuleRowHtml(r) {
  const dead = ruleDeadReason(r, modalCats, modalChannels);
  const tags = dead
    ? `<span class="tag">${esc(dead)}</span>`
    : `<span class="tag">${esc(modalCatName(r.categoryId))}</span>` +
      (r.channels || []).map(function (cid) {
        const c = modalChannelById(cid);
        return c && c.enabled ? `<span class="tag">${esc(c.name)}</span>` : '';
      }).join('');
  return `<div class="row row-click${dead ? ' rule-dead' : ''}" data-action="goto-push-rule" data-rid="${r.id}">` +
    `<span class="row-title">${esc(r.name)}</span>` +
    tags +
    `<span class="row-end">${icon('chevron-right')}</span>` +
    '</div>';
}

function loadModalRules() {
  const box = document.getElementById('modal-rules');
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

// 点击规则行（data-action="goto-push-rule"）由 push.js 处理：关弹窗 → 切设置视图 → 直接打开编辑弹窗

// ---- 启动与轮询：监听卡 60s（listen.js），主播列表 30s（弹窗 DOM 不被重建） ----
loadStreamers();
setInterval(loadStreamers, 30000);
