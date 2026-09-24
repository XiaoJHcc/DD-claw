// 面板前端 · 主播分页 · 关注列表卡：B站关注候选池（头像卡网格 + 已监听标记 + 搜索过滤 + 一键加入监听）。
// 视觉 = UI 重设计 v2（白底浅底卡片 hover 上浮 + 30px 三态监听胶囊），行为与改版前 1:1。
import { api, toast, ACTIONS, INPUTS, esc, avatarHtml, onTableRefresh } from './core.js';
import { icon } from './icons.js';
import { loadStreamers } from './streamers.js';

let followAll = [];
let followSearch = '';
let followShowAll = false;
const followCap = 120;

function loadFollows() {
  return api('/api/follows').then(function (j) {
    followAll = j.follows || [];
    renderFollows();
  }).catch(function (e) { toast(e.message, true); });
}
function followMatches(f) {
  if (!followSearch) return true;
  const kw = followSearch.toLowerCase();
  return String(f.uname || '').toLowerCase().indexOf(kw) >= 0 ||
         String(f.uid).indexOf(kw) >= 0;
}
function followCard(f) {
  return '<div class="follow-card">' + avatarHtml(f.face, f.uname) +
    `<span class="f-name">${esc(f.uname || f.uid)}</span>` +
    (f.watched
      // 已监听：胶囊可点取消监听（PUT watch:false，回到候选池等重新加入）；
      // hover 红调「取消监听」文案为 v2 三态胶囊的视觉形态（纯 CSS 双 span 切换）。
      ? `<button class="f-watch fw-on" data-action="unwatch" data-uid="${esc(f.uid)}"><span class="w-idle">${icon('check')} 已监听</span><span class="w-hover">取消监听</span></button>`
      : `<button class="f-watch fw-add" data-action="watch" data-uid="${esc(f.uid)}">` +
        icon('plus') + '监听</button>') + '</div>';
}
function renderFollows() {
  const box = document.getElementById('follow-list');
  if (!box) return;
  const list = followAll.filter(followMatches);
  const shown = (followSearch || followShowAll) ? list : list.slice(0, followCap);
  let html = shown.map(followCard).join('');
  if (list.length === 0) {
    html = '<p class="hint">' + (followSearch ? '没有匹配的关注' : '无（或关注同步未启用）') + '</p>';
  } else if (shown.length < list.length) {
    html += '<div class="f-more"><span class="hint">共 ' + list.length + ' 条 · ' +
      '<a data-action="follow-expand">展开全部</a></span></div>';
  }
  box.innerHTML = html;
}

INPUTS['follow-search'] = function (el) {
  followSearch = el.value.trim();
  followShowAll = false;
  renderFollows();
};
ACTIONS['follow-expand'] = function () {
  followShowAll = true;
  renderFollows();
};
ACTIONS['watch'] = function (el) {
  api('/api/streamers/' + el.getAttribute('data-uid') + '/watch', 'POST').then(function () {
    toast('已加入监听'); loadStreamers(); loadFollows();
  }).catch(function (e) { toast(e.message, true); });
};
ACTIONS['unwatch'] = function (el) {
  api('/api/streamers/' + el.getAttribute('data-uid'), 'PUT', { watch: false }).then(function () {
    toast('已取消监听'); loadStreamers(); loadFollows();
  }).catch(function (e) { toast(e.message, true); });
};

loadFollows();
setInterval(loadFollows, 30000);
// 加入/取消监听写的是 streamers 表：撤销后「已监听」标记要跟着回去（卡片本身 30s 一轮自愈，这里即时）
onTableRefresh(['streamers'], loadFollows);
