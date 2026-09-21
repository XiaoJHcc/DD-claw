// 装配各卡模块：import 副作用即注册 ACTIONS/CHANGES/INPUTS 并启动各自轮询。
// core.js 是公共依赖，先 import 保证事件委托 / data-icon 填充 / sheet 等在卡模块之前就绪。
import { ACTIONS } from './core.js';
import './listen.js';
import './llm.js';
import './categories.js';
import './push.js';
import './napcat.js';
import './x.js';
import './streamers.js';
import './follows.js';
import { schedRelayout } from './schedule.js';

// 边栏导航：切换视图（时间表 / 主播 / 图文 / 设置），隐藏态视图的后台轮询照跑（数据保鲜）
function switchView(v, activeEl) {
  var items = document.querySelectorAll('.nav-item');
  for (var i = 0; i < items.length; i++) items[i].classList.toggle('active', items[i] === (activeEl || document.querySelector('.nav-item[data-view="' + v + '"]')));
  var views = document.querySelectorAll('.view');
  for (var j = 0; j < views.length; j++) views[j].classList.toggle('hidden', views[j].id !== 'view-' + v);
  // 时间表在 display:none 下解算出的行高无效（clientHeight 0），切回时重排
  if (v === 'schedule') schedRelayout();
}
ACTIONS['nav-view'] = function (el) { switchView(el.getAttribute('data-view'), el); };

// #streamers / #schedule / #settings 直达视图（走查/调试入口）
var hashView = location.hash.slice(1);
if (hashView && document.getElementById('view-' + hashView)) switchView(hashView);

// 设计走查钩子：?open=<action> 直接打开某个弹窗（如 ?open=add-push-rule、?open=open-fetch-settings）。
// 只适用无参「新增/设置」类 action（edit-* 等要 data-* 参数的不行）；表单读模块缓存
// （渠道/分类/名单），故每 200ms 重试直到 sheet 真正打开（约 5s 上限），重复触发只是重渲同一弹窗。
var openAction = new URLSearchParams(location.search).get('open');
if (openAction && ACTIONS[openAction]) {
  var openTries = 0;
  var openTimer = setInterval(function () {
    ACTIONS[openAction](document.body);
    var opened = !document.getElementById('sheet-mask1').classList.contains('hidden');
    if (opened || ++openTries > 25) clearInterval(openTimer);
  }, 200);
}
