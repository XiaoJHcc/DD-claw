// 装配各卡模块：import 副作用即注册 ACTIONS/CHANGES/INPUTS 并启动各自轮询。
// core.js 是公共依赖，先 import 保证事件委托 / data-icon 填充 / sheet 等在卡模块之前就绪。
import './core.js';
import './listen.js';
import './llm.js';
import './categories.js';
import './push.js';
import './napcat.js';
import './streamers.js';
import './follows.js';
import './schedule.js';
