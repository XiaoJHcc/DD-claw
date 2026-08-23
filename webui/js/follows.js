// 面板前端 · 卡片6 关注列表：B站关注候选池（头像网格 + 已监听标记 + 搜索过滤 + 一键加入监听）。
import { api, toast, ACTIONS, INPUTS, esc } from './core.js';
import { icon } from './icons.js';
import { avatarHtml, loadStreamers } from './streamers.js';

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
  return '<div class="follow-card">' + avatarHtml(f.face, f.uname, 'f-avatar') +
    `<div class="f-name">${esc(f.uname || f.uid)}</div>` +
    (f.watched
      ? '<button class="btn" disabled>已监听</button>'
      : `<button class="btn btn-primary" data-action="watch" data-uid="${esc(f.uid)}">` +
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

loadFollows();
setInterval(loadFollows, 30000);
