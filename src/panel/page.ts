/**
 * 控制面板的单页 HTML，以字符串内嵌（dist 只编译 TS，不拷贝静态文件）。
 * 原生 fetch 调 /api/*，无框架无 CDN，离线可用。
 * 本文件只是拼壳：样式、图标与各脚本段在 page/ 目录下拆分维护。
 * 壳里不写内联 on* 处理器：交互统一走 data-action / data-change / data-input 事件委托（app-core 段），
 * 静态图标位用 data-icon 属性由 app-core 统一填充。
 * 注意：内嵌脚本里不得出现反引号与 ${（page/qr-lib.ts 资源文件豁免），避免与外层模板字面量冲突。
 */
import { PANEL_CSS } from './page/style.js';
import { QR_LIB_B64 } from './page/qr-lib.js';
import { APP_ICONS } from './page/icons.js';
import { APP_CORE } from './page/app-core.js';
import { APP_LISTEN } from './page/app-listen.js';
import { APP_STREAMERS } from './page/app-streamers.js';
import { APP_PUSH } from './page/app-push.js';
import { APP_LLM } from './page/app-llm.js';
import { APP_CATEGORIES } from './page/app-categories.js';
import { APP_NAPCAT } from './page/app-napcat.js';
import { APP_FOLLOWS } from './page/app-follows.js';

const QR_LIB = Buffer.from(QR_LIB_B64, 'base64').toString('utf8');

export const PANEL_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DD-claw 控制面板</title>
<style>${PANEL_CSS}</style>
</head>
<body>
<div id="toasts" class="toast-host"></div>

<div class="page">
<header class="page-head"><h1>DD-claw 控制面板</h1></header>

<div class="row-top">
<section class="card" id="card-listen">
<div class="card-head"><h2>监听</h2></div>
<div id="listen-rows">加载中…</div>
</section>

<section class="card" id="card-llm">
<div class="card-head"><h2>LLM 分析</h2>
<label class="switch"><input type="checkbox" id="llm-enabled" data-change="toggle-llm"><span class="knob"></span></label>
</div>
<div id="llm-list">加载中…</div>
</section>

<section class="card" id="card-categories">
<div class="card-head"><h2>分类规则</h2></div>
<div id="category-list">加载中…</div>
</section>

<section class="card" id="card-push">
<div class="card-head"><h2>推送渠道</h2>
<label class="switch"><input type="checkbox" id="push-enabled" data-change="toggle-push"><span class="knob"></span></label>
</div>
<div id="channel-list">加载中…</div>
<div class="card-actions">
<button class="btn" data-action="add-channel"><span data-icon="plus"></span>新增渠道</button>
</div>
</section>

<section class="card" id="card-rules">
<div class="card-head"><h2>推送规则</h2></div>
<div id="rule-list">加载中…</div>
</section>

<section class="card" id="card-napcat">
<div class="card-head"><h2>NapCat</h2>
<label class="switch"><input type="checkbox" id="napcat-enabled" data-change="toggle-napcat"><span class="knob"></span></label>
</div>
<div id="napcat-rows">加载中…</div>
<div class="card-actions">
<button class="btn" data-action="napcat-launch"><span data-icon="bolt"></span>手动拉起</button>
<button class="btn" data-action="napcat-setup"><span data-icon="gear"></span>计划任务</button>
</div>
</section>
</div>

<section class="card" id="card-schedule">
<div class="card-head"><h2>直播计划时间表</h2></div>
<p class="hint">预留：预告时间表（M3）</p>
</section>

<section class="card" id="card-streamers">
<div class="card-head"><h2>主播列表</h2><span class="card-sub" id="streamer-count"></span></div>
<div id="streamer-list">加载中…</div>
</section>

<section class="card" id="card-follows">
<div class="card-head"><h2>关注列表</h2></div>
<div class="search-box"><span class="search-icon" data-icon="search"></span><input id="follow-search" data-input="follow-search" placeholder="搜索昵称 / UID"></div>
<div id="follow-list" class="follow-grid">加载中…</div>
</section>
</div>

<div id="sheet-mask1" class="sheet-mask hidden"><div class="sheet"></div></div>
<div id="sheet-mask2" class="sheet-mask hidden"><div class="sheet"></div></div>

<script>${QR_LIB}</script>
<script>
${APP_ICONS}
${APP_CORE}
${APP_LISTEN}
${APP_STREAMERS}
${APP_PUSH}
${APP_LLM}
${APP_CATEGORIES}
${APP_NAPCAT}
${APP_FOLLOWS}
</script>
</body>
</html>
`;
