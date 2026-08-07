/**
 * 控制面板全部 CSS，内嵌字符串（dist 只编译 TS，不拷静态文件）。
 * 苹果风格设计系统：CSS 变量令牌 + 浅色/深色双主题（prefers-color-scheme）+ 统一控件。
 * 内容不得出现反引号与 ${，避免与外层模板字面量冲突。
 */
export const PANEL_CSS = `
*{box-sizing:border-box}
:root{
  --bg:#f5f5f7;--card-bg:#ffffff;--text:#1d1d1f;--text-secondary:#86868b;
  --separator:rgba(0,0,0,.09);--accent:#007aff;--red:#ff3b30;--green:#34c759;
  --fill:rgba(120,120,128,.12);--fill-strong:rgba(120,120,128,.2);--switch-off:rgba(120,120,128,.32);
  --radius:14px;--shadow:0 1px 3px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.05);
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#000000;--card-bg:#1c1c1e;--text:#f5f5f7;--text-secondary:#98989d;
    --separator:rgba(255,255,255,.14);--fill:rgba(120,120,128,.22);--fill-strong:rgba(120,120,128,.3);
    --shadow:none;
  }
}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
  background:var(--bg);color:var(--text);font-size:15px;line-height:1.45}
.page{max-width:1060px;margin:0 auto;padding:24px 32px 64px}
.page-head{display:flex;align-items:center;margin:8px 0 20px}
h1{font-size:22px;font-weight:600;margin:0}
h2{font-size:17px;font-weight:600;margin:0}
.hint{color:var(--text-secondary);font-size:13px}
.hidden{display:none!important}
/* 卡片 */
.card{background:var(--card-bg);border-radius:var(--radius);padding:20px;margin-bottom:20px;box-shadow:var(--shadow)}
@media (prefers-color-scheme: dark){.card{border:0.5px solid var(--separator)}}
.card-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;min-height:26px}
.card-sub{font-size:13px;color:var(--text-secondary)}
/* 顶部三卡并列：监听 / LLM 分析 / 推送 */
.row-top{display:flex;gap:20px;align-items:stretch;margin-bottom:20px}
.row-top .card{flex:1;min-width:0;margin-bottom:0}
@media (max-width:900px){.row-top{flex-wrap:wrap}.row-top .card{flex:1 1 100%}}
.card-actions{display:flex;gap:10px;margin-top:14px}
.card-actions .btn{flex:1}
/* 通用列表行：44px 行高，行间 0.5px 分隔线（两端无） */
.row{display:flex;align-items:center;gap:10px;min-height:44px;padding:6px 0;font-size:15px}
.row + .row{border-top:0.5px solid var(--separator)}
.row-click{cursor:pointer;border-radius:8px;padding-left:8px;padding-right:8px;margin-left:-8px;margin-right:-8px}
.row-click:hover{background:var(--fill)}
.row-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row-sub{font-size:13px;color:var(--text-secondary)}
.row-end{margin-left:auto;display:flex;align-items:center;gap:6px;color:var(--text-secondary);flex:none}
.row-end svg{width:16px;height:16px}
.row.dragging{opacity:.4}
.grip{display:inline-flex;cursor:grab;color:var(--text-secondary);opacity:.55;user-select:none;flex:none}
.grip svg{width:14px;height:14px}
.add-row{margin-top:10px}
/* 图标按钮：28x28 圆角 6，hover 浅灰底，danger 红色 */
.icon-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;
  border:none;border-radius:6px;background:transparent;color:var(--text-secondary);cursor:pointer;padding:0;flex:none}
.icon-btn:hover{background:var(--fill);color:var(--text)}
.icon-btn.danger{color:var(--red)}
.icon-btn.danger:hover{background:rgba(255,59,48,.12)}
.icon-btn svg{width:17px;height:17px}
/* 按钮：胶囊；主按钮 accent 填充，次按钮灰填充 */
button{font-family:inherit}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;font-size:14px;line-height:20px;
  padding:5px 14px;border:none;border-radius:999px;background:var(--fill);color:var(--text);cursor:pointer;white-space:nowrap}
.btn:hover{background:var(--fill-strong)}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover{background:var(--accent);filter:brightness(1.08)}
.btn-sm{font-size:12px;line-height:18px;padding:2px 10px}
.btn-block{width:100%}
.btn svg{width:15px;height:15px}
/* 标签 pill */
.tag{display:inline-block;font-size:12px;line-height:18px;padding:0 8px;border-radius:9px;
  background:var(--fill);color:var(--text-secondary);white-space:nowrap}
/* 状态点 */
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;flex:none}
.dot.green{background:var(--green)}.dot.red{background:var(--red)}
.dot.gray{background:var(--text-secondary)}.dot.yellow{background:#ffcc00}
/* iOS 开关：44x26 滑块，全局统一 */
.switch{position:relative;display:inline-block;width:44px;height:26px;flex:none}
.switch input{position:absolute;opacity:0;width:0;height:0;margin:0}
.knob{position:absolute;inset:0;background:var(--switch-off);border-radius:13px;transition:background .2s;cursor:pointer}
.knob:before{content:"";position:absolute;width:22px;height:22px;left:2px;top:2px;background:#fff;
  border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .2s}
.switch input:checked + .knob{background:var(--green)}
.switch input:checked + .knob:before{transform:translateX(18px)}
.switch input:disabled + .knob{opacity:.45;cursor:default}
/* 表单控件：32px 高圆角 8，focus accent 描边；label 13px secondary */
input:not([type]),input[type=text],select{font:inherit;font-size:14px;height:32px;padding:0 10px;
  border:1px solid var(--separator);border-radius:8px;background:var(--card-bg);color:var(--text);outline:none;width:100%}
input:focus,select:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(0,122,255,.18)}
input:disabled{opacity:.5;background:var(--fill)}
.field{margin:10px 0}
.field>label{display:block;font-size:13px;color:var(--text-secondary);margin-bottom:4px}
.field input,.field select{width:100%}
.field-row{display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap}
.field-row .field{flex:1;min-width:110px}
.field-static{padding:7px 0;font-size:15px}
/* iOS 分组表单卡片 */
.form-card{border:1px solid var(--separator);border-radius:10px;padding:2px 14px;margin:12px 0}
.form-card .row{min-height:40px}
/* 弹窗 sheet：圆角 14，遮罩半透明黑 + 轻微模糊，两级层级同样式 */
.sheet-mask{position:fixed;inset:0;background:rgba(0,0,0,.4);backdrop-filter:blur(6px);
  -webkit-backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:20}
#sheet-mask2{z-index:21}
.sheet{background:var(--card-bg);border-radius:14px;width:560px;max-width:92vw;max-height:86vh;
  display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.25)}
.sheet-head{display:flex;align-items:center;justify-content:space-between;padding:16px 20px 4px}
.sheet-title{font-size:17px;font-weight:600}
.sheet-body{padding:8px 20px 20px;overflow-y:auto}
.sheet-foot{display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:16px}
.sheet-section{margin-top:18px;border-top:0.5px solid var(--separator);padding-top:12px}
.sheet-sub{font-size:15px;font-weight:600;margin-bottom:4px}
.form-err{color:var(--red);font-size:13px;margin-right:auto}
.mfoot{margin-top:14px;color:var(--text-secondary);font-size:12px;border-top:0.5px solid var(--separator);padding-top:10px}
/* toast：顶部居中浮动胶囊，成功绿 / 错误红，约 3s 淡出，多条纵向堆叠 */
.toast-host{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:50;
  display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none}
.toast-capsule{display:flex;align-items:center;gap:8px;background:var(--card-bg);color:var(--text);
  border-radius:999px;padding:8px 16px;font-size:14px;box-shadow:0 4px 16px rgba(0,0,0,.18);
  transition:opacity .3s,transform .3s}
.toast-capsule svg{width:16px;height:16px}
.toast-capsule.ok svg{color:var(--green)}
.toast-capsule.err svg{color:var(--red)}
.toast-capsule.out{opacity:0;transform:translateY(-6px)}
/* 监听卡 / 登录弹窗 */
.login-status{display:flex;align-items:center;gap:8px;font-size:15px}
.qr-box{display:flex;align-items:center;justify-content:center;min-height:120px;margin:14px 0;
  background:var(--fill);border-radius:10px;padding:14px}
.qr-box svg{width:200px;height:200px}
.qr-empty{display:flex;flex-direction:column;align-items:center;gap:8px;color:var(--text-secondary)}
.qr-empty svg{width:40px;height:40px}
.qr-msg{text-align:center;min-height:18px}
/* 主播卡片：三栏（基本信息 | 直播实况 | 动态时间线） */
.sc-card{display:flex;gap:20px;border:1px solid var(--separator);border-radius:12px;
  padding:16px;margin:12px 0;cursor:pointer;transition:border-color .15s}
.sc-card:hover{border-color:var(--text-secondary)}
.sc-left{width:180px;flex:none;min-width:0}
.avatar{width:56px;height:56px;border-radius:50%;object-fit:cover;display:block;background:var(--fill)}
.avatar-ph{display:flex;align-items:center;justify-content:center;color:var(--text-secondary);font-size:22px}
.sc-name{font-size:15px;font-weight:600;margin:8px 0 2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meta{font-size:13px;color:var(--text-secondary);margin:2px 0;display:flex;align-items:center;gap:6px;min-width:0}
.sc-note{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sc-note.none{opacity:.6}
.rules-row{display:flex;flex-wrap:wrap;gap:4px}
.sc-right{flex:1;display:flex;gap:14px;min-width:0;align-items:flex-start}
.kf-wrap{position:relative;flex:none}
.kf{width:250px;aspect-ratio:16/9;border-radius:10px;object-fit:cover;display:block;background:var(--fill)}
.kf-empty{display:flex;align-items:center;justify-content:center;color:var(--text-secondary)}
.kf-empty svg{width:28px;height:28px}
.sc-card.off .kf-wrap{opacity:.5}
.live-badge{position:absolute;left:8px;top:8px;display:inline-flex;align-items:center;gap:5px;
  background:var(--accent);color:#fff;font-size:12px;border-radius:999px;padding:2px 8px}
.live-badge:before{content:"";width:6px;height:6px;border-radius:50%;background:#fff}
.live-info{min-width:0}
.live-title{font-size:15px;font-weight:600;margin:2px 0 6px;overflow:hidden;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.off-dur{font-size:15px}
/* 主播卡片第三栏：动态时间线 */
.sc-posts{width:250px;flex:none;min-width:0;border-left:0.5px solid var(--separator);padding-left:16px}
.sc-posts-title{font-size:13px;color:var(--text-secondary);margin-bottom:4px}
.post{display:flex;gap:8px;padding:8px 4px;color:inherit;text-decoration:none;border-radius:8px}
.post + .post{border-top:0.5px solid var(--separator)}
a.post:hover{background:var(--fill)}
.post-thumb{width:52px;height:52px;border-radius:8px;object-fit:cover;flex:none;background:var(--fill)}
.post-body{flex:1;min-width:0}
.post-head{display:flex;gap:6px;align-items:center;margin-bottom:2px}
.post-time{font-size:12px;color:var(--text-secondary);white-space:nowrap}
.post-text{font-size:13px;color:var(--text);white-space:pre-line;overflow:hidden;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
/* 关注列表 */
.search-box{position:relative;margin-bottom:14px;width:280px}
.search-box input{width:100%;padding-left:32px}
.search-box .search-icon{position:absolute;left:10px;top:50%;transform:translateY(-50%);
  display:inline-flex;color:var(--text-secondary);pointer-events:none}
.search-box .search-icon svg{width:15px;height:15px}
.follow-grid{display:flex;flex-wrap:wrap;gap:10px}
.follow-card{width:112px;border:1px solid var(--separator);border-radius:12px;padding:12px 6px;text-align:center}
.f-avatar{width:44px;height:44px;border-radius:50%;object-fit:cover;margin:0 auto;background:var(--fill)}
.follow-card .avatar-ph{font-size:18px}
.f-name{font-size:13px;margin:6px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.follow-card .tag{display:block;margin:2px auto;width:fit-content}
.f-more{margin:10px 0;text-align:center}
.f-more a{color:var(--accent);cursor:pointer;text-decoration:none}
.f-more a:hover{text-decoration:underline}
`;
