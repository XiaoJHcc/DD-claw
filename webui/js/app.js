// 装配各卡模块：import 副作用即注册 ACTIONS/CHANGES/INPUTS 并启动各自轮询。
// core.js 是公共依赖，先 import 保证事件委托 / data-icon 填充 / sheet 等在卡模块之前就绪。
import { ACTIONS } from './core.js';
import './listen.js';
import './llm.js';
import './categories.js';
import './push.js';
import './napcat.js';
import './streamers.js';
import './follows.js';
import { schedRelayout } from './schedule.js';

// 边栏导航：切换视图（时间表 / 主播列表 / 设置），隐藏态视图的后台轮询照跑（数据保鲜）
ACTIONS['nav-view'] = function (el) {
  var v = el.getAttribute('data-view');
  var items = document.querySelectorAll('.nav-item');
  for (var i = 0; i < items.length; i++) items[i].classList.toggle('active', items[i] === el);
  var views = document.querySelectorAll('.view');
  for (var j = 0; j < views.length; j++) views[j].classList.toggle('hidden', views[j].id !== 'view-' + v);
  // 时间表在 display:none 下解算出的行高无效（clientHeight 0），切回时重排
  if (v === 'schedule') schedRelayout();
};
