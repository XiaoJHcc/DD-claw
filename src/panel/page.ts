/**
 * 控制面板的单页 HTML，以字符串内嵌（dist 只编译 TS，不拷贝静态文件）。
 * 原生 fetch 调 /api/*，无框架无 CDN，离线可用。
 * 本文件只是拼壳：样式与各脚本段在 page/ 目录下拆分维护。
 * 注意：内嵌脚本里不得出现反引号与 ${（page/qr-lib.ts 资源文件豁免），避免与外层模板字面量冲突。
 */
import { PANEL_CSS } from './page/style.js';
import { QR_LIB_B64 } from './page/qr-lib.js';
import { APP_CORE } from './page/app-core.js';
import { APP_STATUS } from './page/app-status.js';
import { APP_STREAMERS } from './page/app-streamers.js';
import { APP_PUSH } from './page/app-push.js';

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
<header class="top"><h1>DD-claw 控制面板</h1><div id="toast"></div></header>

<section class="card" id="card-status">
<h2>运行状态</h2>
<div class="status-flex">
<div class="status-info" id="status-info">加载中…</div>
<div class="status-platforms" id="status-platforms"></div>
</div>
</section>

<section class="card" id="card-schedule">
<h2>直播计划时间表</h2>
<p class="hint">预留：预告时间表（M3）</p>
</section>

<section class="card" id="card-streamers">
<h2>主播列表</h2>
<div id="streamer-list">加载中…</div>
<h3 class="follows-title">关注未监听</h3>
<div id="follow-list" class="follow-row"></div>
</section>

<section class="card" id="card-push">
<h2>推送</h2>
<h3 class="push-sub">默认推送词</h3>
<div id="push-template">加载中…</div>
<h3 class="push-sub">推送渠道</h3>
<div id="channel-list">加载中…</div>
<div id="channel-add"></div>
</section>

<div id="modal-mask" class="hidden"><div id="modal"></div></div>

<script>${QR_LIB}</script>
<script>
${APP_CORE}
${APP_STATUS}
${APP_STREAMERS}
${APP_PUSH}
</script>
</body>
</html>
`;
