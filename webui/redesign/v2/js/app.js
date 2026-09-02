// app.js — v2 Demo 入口：数据 → 渲染 → 视图切换
import { loadData, liveCount, DATA } from './data.js';
import { fillIcons, freezeTime, ACTIONS } from './core.js';
import { renderSettings, renderFollows } from './settings.js';
import { renderStreamers } from './streamers.js';

await loadData();
if (DATA.frozen) freezeTime(DATA.exportedAt);
renderSettings();
renderFollows('');
renderStreamers();
fillIcons(document);
document.getElementById('side-live-count').textContent = liveCount();

ACTIONS['nav-view'] = t => {
  const v = t.getAttribute('data-view');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n === t));
  document.querySelectorAll('.view').forEach(s => { s.hidden = s.id !== 'view-' + v; });
};

// #streamers / #schedule / #settings 直达视图
const hashView = location.hash.slice(1);
if (hashView && document.getElementById('view-' + hashView)) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.getAttribute('data-view') === hashView));
  document.querySelectorAll('.view').forEach(s => { s.hidden = s.id !== 'view-' + hashView; });
}

// 设计审查钩子：?open=<action> 直接打开某个弹窗（如 ?open=rule-new）
const openAction = new URLSearchParams(location.search).get('open');
if (openAction && ACTIONS[openAction]) ACTIONS[openAction](document.body);
