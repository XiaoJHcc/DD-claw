// app.js — 重设计 Demo 装配入口：冻结时间 → 加载数据 → 填图标 → 视图导航
import { freezeTime, fillIcons, ACTIONS } from './core.js';
import { loadData, DATA, liveCount } from './data.js';
import { mountSchedule, scheduleVisible } from './timeline.js';
import { renderStreamers } from './streamers.js';
import { renderSettings, renderFollows } from './settings.js';

const data = await loadData();
if (data.frozen) freezeTime(data.exportedAt);

fillIcons(document.body);

let curView = 'schedule';
function navTo(view) {
  if (view === curView) return;
  curView = view;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('on', b.getAttribute('data-view') === view));
  for (const v of ['schedule', 'streamers', 'settings']) {
    document.getElementById('view-' + v).hidden = v !== view;
  }
  if (view === 'schedule') scheduleVisible();
  if (view === 'streamers') renderStreamers();
  if (view === 'settings') { renderSettings(); renderFollows(); }
}
ACTIONS['nav-view'] = t => navTo(t.getAttribute('data-view'));

// 初始渲染（可用 #streamers / #settings 直达视图，便于设计走查）
document.querySelector('.nav-item[data-view="schedule"]').classList.add('on');
mountSchedule();
renderStreamers();
renderSettings();
renderFollows();
const hashView = location.hash.slice(1);
if (['schedule', 'streamers', 'settings'].includes(hashView)) navTo(hashView);

function refreshLiveCount() {
  document.querySelector('#side-live-count b').textContent = liveCount();
}
refreshLiveCount();

// 主播卡时长/相对时间保鲜（30s 重绘主播视图，时间表走自己的 60s 定时器）
setInterval(() => {
  if (curView === 'streamers') renderStreamers();
  refreshLiveCount();
}, 30000);
