/**
 * 控制面板全部 CSS，内嵌字符串（dist 只编译 TS，不拷静态文件）。
 * macOS 风格设计系统（观感对齐 macOS Sequoia 系统设置）：CSS 变量令牌 + 浅色/深色双主题
 * （prefers-color-scheme）+ 卡片式行布局（无分隔线）+ 圆角矩形控件（不用胶囊）。
 * 圆角两级 + 唯一三级例外：--r-lg 页面级（.card/.sheet）/ --r-md:8px 一级卡片内的所有元素
 * （行卡、分区卡、按钮、输入框同档）/ --r-sm:6px 二级元素内部（动态卡、关键帧、缩略图、tag、
 * 图标按钮、勾选框、直播中徽标）。正圆形（头像/状态点/开关/checkdot 圆环/徽标圆点）豁免。
 * 高度两档：--ctl-h:36px 单行控件（按钮 / 输入框 / 图标按钮等只含文本或 icon 的元素）；
 * --row-h:44px 单行卡片（排序列表行 / 多选行 / 监听登录行 / 三模块开关行等 .row 级卡片）。
 * 加粗只留给标题（h1/h2/.sheet-title/.sheet-sub），其余靠字号与颜色分层。
 * 内容不得出现反引号与 ${，避免与外层模板字面量冲突。
 */
export const PANEL_CSS = `
*{box-sizing:border-box}
:root{
  --bg:#f8f8fa;--card-bg:#ffffff;--row-bg:rgba(120,120,128,.055);--text:#1d1d1f;--text-secondary:#86868b;
  --separator:rgba(0,0,0,.09);--border-strong:rgba(0,0,0,.24);--accent:#007aff;--red:#ff3b30;--green:#34c759;
  --fill:rgba(120,120,128,.055);--hover:rgba(120,120,128,.08);--switch-off:rgba(120,120,128,.28);
  --r-lg:14px;--r-md:8px;--r-sm:6px;--ctl-h:36px;--row-h:44px;
  --shadow:0 1px 2px rgba(0,0,0,.05);
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#000000;--card-bg:#1c1c1e;--row-bg:#2c2c2e;--text:#f5f5f7;--text-secondary:#98989d;
    --separator:rgba(255,255,255,.14);--border-strong:rgba(255,255,255,.3);
    --fill:rgba(120,120,128,.22);--hover:rgba(0,0,0,.2);
    --shadow:none;
  }
}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
  background:var(--bg);color:var(--text);font-size:14px;line-height:1.45}
.page{max-width:1280px;margin:0 auto;padding:24px 32px 64px}
.page-head{display:flex;align-items:center;margin:8px 0 20px}
h1{font-size:22px;font-weight:600;margin:0}
h2{font-size:17px;font-weight:600;margin:0}
.hint{color:var(--text-secondary);font-size:12px}
.hidden{display:none!important}
/* 卡片 */
.card{background:var(--card-bg);border-radius:var(--r-lg);padding:20px;margin-bottom:20px;box-shadow:var(--shadow)}
@media (prefers-color-scheme: dark){.card{border:0.5px solid var(--separator)}}
.card-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;min-height:24px}
.card-sub{font-size:12px;color:var(--text-secondary)}
/* 顶部三卡并列：监听 / LLM 分析 / 推送 */
.row-top{display:flex;gap:20px;align-items:stretch;margin-bottom:20px}
.row-top .card{flex:1;min-width:0;margin-bottom:0}
@media (max-width:900px){.row-top{flex-wrap:wrap}.row-top .card{flex:1 1 100%}}
.card-actions{display:flex;gap:10px;margin-top:14px}
.card-actions .btn{flex:1}
/* 通用列表行（单行卡片）：每行一张小卡片（浅填充底、统一 --row-h 高、行间距 8），不用分隔线 */
.row{display:flex;align-items:center;gap:10px;min-height:var(--row-h);padding:6px 12px;margin:8px 0;
  font-size:14px;background:var(--row-bg);border-radius:var(--r-md)}
.row-click{cursor:pointer}
.row-click:hover{background:var(--hover)}
.row-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row-sub{font-size:12px;color:var(--text-secondary)}
.row-end{margin-left:auto;display:flex;align-items:center;gap:6px;color:var(--text-secondary);flex:none}
.row-end svg{width:16px;height:16px}
.row.dragging{opacity:.4}
.grip{display:inline-flex;cursor:grab;color:var(--text-secondary);opacity:.55;user-select:none;flex:none}
.grip svg{width:14px;height:14px}
.add-row{margin-top:10px}
/* 图标按钮：32x32（行内在 36 行高里留 2px 间隙自然居中），hover 变浅（--hover），danger 红色 */
.icon-btn{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;
  border:none;border-radius:var(--r-sm);background:transparent;color:var(--text-secondary);cursor:pointer;padding:0;flex:none}
.icon-btn:hover{background:var(--hover);color:var(--text)}
.icon-btn.danger{color:var(--red)}
.icon-btn.danger:hover{background:rgba(255,59,48,.12)}
.icon-btn svg{width:17px;height:17px}
/* 按钮：macOS push button 观感（二级圆角，与输入框同档），统一 --ctl-h 高（btn-sm 只缩字号），
   主按钮蓝底白字、次按钮浅灰底 */
button{font-family:inherit}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;font-size:12px;
  height:var(--ctl-h);padding:0 14px;border:none;border-radius:var(--r-md);
  background:var(--fill);color:var(--text);cursor:pointer;white-space:nowrap}
.btn:hover{background:var(--hover)}
.btn:active{filter:brightness(.96)}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover{background:var(--accent);filter:brightness(1.06)}
.btn-sm{font-size:11px;padding:0 12px}
.btn-block{width:100%}
.btn svg{width:14px;height:14px}
/* 标签：圆角矩形 */
.tag{display:inline-block;font-size:11px;line-height:18px;padding:0 7px;border-radius:var(--r-sm);
  background:var(--fill);color:var(--text-secondary);white-space:nowrap}
/* 状态点（正圆形，圆角豁免） */
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;flex:none}
.dot.green{background:var(--green)}.dot.red{background:var(--red)}
.dot.gray{background:var(--text-secondary)}.dot.yellow{background:#ffcc00}
/* macOS 主控开关：38x22 扁胶囊（开关形态圆角豁免），蓝色开启态、白色旋钮；
   只用于单个主控（监听两行 + LLM/推送卡总开关），行内垂直居中、行高以 --ctl-h 为准 */
.switch{position:relative;display:inline-block;width:38px;height:22px;flex:none}
.switch input{position:absolute;opacity:0;width:0;height:0;margin:0}
.knob{position:absolute;inset:0;background:var(--switch-off);border-radius:11px;transition:background .18s;cursor:pointer}
.knob:before{content:"";position:absolute;width:18px;height:18px;left:2px;top:2px;background:#fff;
  border-radius:50%;box-shadow:0 1px 2px rgba(0,0,0,.22);transition:transform .18s}
.switch input:checked + .knob{background:var(--accent)}
.switch input:checked + .knob:before{transform:translateX(16px)}
.switch input:disabled + .knob{opacity:.45;cursor:default}
/* macOS 勾选框：16x16 圆角小方块，选中 = 蓝底白勾，未选 = 浅底 + 细边框；用于并排多选 */
.checkbox{position:relative;display:inline-flex;align-items:center;gap:8px;flex:none;cursor:pointer}
.checkbox input{position:absolute;opacity:0;width:0;height:0;margin:0}
.checkbox .box{width:16px;height:16px;border-radius:var(--r-sm);border:1px solid var(--border-strong);
  background:var(--card-bg);position:relative;transition:background .12s,border-color .12s;flex:none}
.checkbox input:checked + .box{background:var(--accent);border-color:var(--accent)}
.checkbox input:checked + .box:after{content:"";position:absolute;left:4.5px;top:1.5px;width:4px;height:8px;
  border:solid #fff;border-width:0 1.8px 1.8px 0;transform:rotate(45deg)}
.checkbox input:disabled + .box{opacity:.45}
/* 勾选排序列表的启停勾：无方框，选中 = 蓝色勾，未选 = 浅灰空心圆环（正圆形豁免，占位对齐） */
.checkdot{position:relative;display:inline-flex;flex:none;cursor:pointer;width:22px;height:22px;align-items:center;justify-content:center}
.checkdot input{position:absolute;opacity:0;width:0;height:0;margin:0}
.checkdot .cd{width:18px;height:18px;border-radius:50%;border:1.5px solid var(--border-strong);
  opacity:.45;position:relative;transition:opacity .12s}
.checkdot:hover .cd{opacity:.8}
.checkdot input:checked + .cd{border:none;opacity:1}
.checkdot input:checked + .cd:after{content:"";position:absolute;left:4px;top:1px;width:6px;height:11px;
  border:solid var(--accent);border-width:0 2.2px 2.2px 0;transform:rotate(45deg)}
.checkdot input:disabled + .cd{opacity:.25}
/* 多选行（弹窗里的渠道勾选等）：与 .row 同高同底 */
.check-row{display:flex;align-items:center;gap:8px;min-height:var(--row-h);padding:6px 12px;margin:8px 0;
  background:var(--row-bg);border-radius:var(--r-md);cursor:pointer;font-size:14px}
/* 表单控件：--ctl-h 高（二级圆角，与按钮同档），focus accent 描边；label 13px secondary */
input:not([type]),input[type=text],select{font:inherit;font-size:14px;height:var(--ctl-h);padding:0 10px;
  border:1px solid var(--separator);border-radius:var(--r-md);background:var(--card-bg);color:var(--text);outline:none;width:100%}
input:focus,select:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(0,122,255,.18)}
input:disabled{opacity:.5;background:var(--fill)}
.field{margin:10px 0}
.field>label{display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px}
.field input,.field select{width:100%}
.field-row{display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap}
.field-row .field{flex:1;min-width:110px}
.field-static{padding:7px 0;font-size:14px}
/* 分段卡片：弹窗里多段内容各自成卡（浅填充底，无分隔线） */
.form-card{background:var(--row-bg);border-radius:var(--r-md);padding:8px 14px;margin:12px 0}
/* 弹窗 sheet：遮罩半透明黑 + 轻微模糊，两级层级同样式 */
.sheet-mask{position:fixed;inset:0;background:rgba(0,0,0,.4);backdrop-filter:blur(6px);
  -webkit-backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:20}
#sheet-mask2{z-index:21}
.sheet{background:var(--card-bg);border-radius:var(--r-lg);width:560px;max-width:92vw;max-height:86vh;
  display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.25)}
.sheet-head{display:flex;align-items:center;justify-content:space-between;padding:16px 20px 4px}
.sheet-title{font-size:17px;font-weight:600}
.sheet-body{padding:8px 20px 20px;overflow-y:auto}
.sheet-foot{display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:16px}
.sheet-section{margin-top:20px;padding-top:4px}
.sheet-sub{font-size:14px;font-weight:600;margin-bottom:4px}
.form-err{color:var(--red);font-size:12px;margin-right:auto}
.mfoot{margin-top:14px;color:var(--text-secondary);font-size:11px}
/* toast：顶部居中浮层圆角矩形，成功绿 / 错误红图标，约 3s 淡出 */
.toast-host{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:50;
  display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none}
.toast-capsule{display:flex;align-items:center;gap:8px;background:var(--card-bg);color:var(--text);
  border-radius:var(--r-md);padding:8px 14px;font-size:14px;box-shadow:0 4px 16px rgba(0,0,0,.16);
  transition:opacity .3s,transform .3s}
.toast-capsule svg{width:16px;height:16px}
.toast-capsule.ok svg{color:var(--green)}
.toast-capsule.err svg{color:var(--red)}
.toast-capsule.out{opacity:0;transform:translateY(-6px)}
/* 监听卡 / 登录弹窗 */
.login-status{display:flex;align-items:center;gap:8px;font-size:14px}
.qr-box{display:flex;align-items:center;justify-content:center;min-height:120px;margin:14px 0;
  background:var(--row-bg);border-radius:var(--r-md);padding:14px}
.qr-box svg{width:200px;height:200px}
.qr-empty{display:flex;flex-direction:column;align-items:center;gap:8px;color:var(--text-secondary)}
.qr-empty svg{width:40px;height:40px}
.qr-msg{text-align:center;min-height:18px}
/* 主播卡片：三栏（基本信息 | 直播实况 | 动态时间线） */
.sc-card{display:flex;gap:20px;background:var(--row-bg);border-radius:var(--r-md);
  padding:16px;margin:12px 0;cursor:pointer;transition:background .15s}
.sc-card:hover{background:var(--hover)}
.sc-left{width:180px;flex:none;min-width:0}
.avatar{width:56px;height:56px;border-radius:50%;object-fit:cover;display:block;background:var(--fill)}
.avatar-ph{display:flex;align-items:center;justify-content:center;color:var(--text-secondary);font-size:22px}
.sc-name{font-size:14px;margin:8px 0 2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meta{font-size:12px;color:var(--text-secondary);margin:2px 0;display:flex;align-items:center;gap:6px;min-width:0}
.sc-note{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sc-note.none{opacity:.6}
.rules-row{display:flex;flex-wrap:wrap;gap:4px}
.sc-right{flex:1;display:flex;gap:14px;min-width:0;align-items:flex-start}
.kf-wrap{position:relative;flex:none}
.kf{width:250px;aspect-ratio:16/9;border-radius:var(--r-sm);object-fit:cover;display:block;background:var(--fill)}
.kf-empty{display:flex;align-items:center;justify-content:center;color:var(--text-secondary)}
.kf-empty svg{width:28px;height:28px}
.sc-card.off .kf-wrap{opacity:.5}
.live-badge{position:absolute;left:8px;top:8px;display:inline-flex;align-items:center;gap:5px;
  background:var(--accent);color:#fff;font-size:11px;border-radius:var(--r-sm);padding:2px 7px}
.live-badge:before{content:"";width:6px;height:6px;border-radius:50%;background:#fff}
.live-info{min-width:0}
.live-title{font-size:14px;margin:2px 0 6px;overflow:hidden;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.off-dur{font-size:14px}
/* 主播卡片第三栏：动态时间线，每条动态一张小卡片 */
.sc-posts{width:250px;flex:none;min-width:0;padding-left:16px}
.sc-posts-title{font-size:12px;color:var(--text-secondary);margin-bottom:4px}
.post{display:flex;gap:8px;padding:8px 10px;margin:6px 0;color:inherit;text-decoration:none;
  background:var(--card-bg);border-radius:var(--r-sm)}
@media (prefers-color-scheme: dark){.post{background:rgba(255,255,255,.06)}}
a.post:hover{background:var(--hover)}
.post-thumb{width:52px;height:52px;border-radius:var(--r-sm);object-fit:cover;flex:none;background:var(--fill)}
.post-body{flex:1;min-width:0}
.post-head{display:flex;gap:6px;align-items:center;margin-bottom:2px}
.post-time{font-size:11px;color:var(--text-secondary);white-space:nowrap}
.post-text{font-size:12px;color:var(--text);white-space:pre-line;overflow:hidden;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
/* 关注列表 */
.search-box{position:relative;margin-bottom:14px;width:280px}
.search-box input{width:100%;padding-left:32px}
.search-box .search-icon{position:absolute;left:10px;top:50%;transform:translateY(-50%);
  display:inline-flex;color:var(--text-secondary);pointer-events:none}
.search-box .search-icon svg{width:15px;height:15px}
.follow-grid{display:flex;flex-wrap:wrap;gap:10px}
.follow-card{width:112px;background:var(--row-bg);border-radius:var(--r-md);padding:12px 6px;text-align:center}
.f-avatar{width:44px;height:44px;border-radius:50%;object-fit:cover;margin:0 auto;background:var(--fill)}
.follow-card .avatar-ph{font-size:18px}
.f-name{font-size:12px;margin:6px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.follow-card .tag{display:block;margin:2px auto;width:fit-content}
.f-more{margin:10px 0;text-align:center}
.f-more a{color:var(--accent);cursor:pointer;text-decoration:none}
.f-more a:hover{text-decoration:underline}
`;
