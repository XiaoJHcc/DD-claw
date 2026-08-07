/**
 * 控制面板全部 CSS，内嵌字符串（dist 只编译 TS，不拷静态文件）。
 * 内容不得出现反引号与 ${，避免与外层模板字面量冲突。
 */
export const PANEL_CSS = `
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:1280px;margin:1.2rem auto;padding:0 1rem;color:#222;background:#f4f5f7}
h1{font-size:1.2rem;margin:0}
h2{font-size:1rem;margin:0 0 .6rem}
h3{font-size:.95rem;margin:.2rem 0 .5rem}
h4{font-size:.88rem;margin:.8rem 0 .3rem}
small{color:#888;font-weight:normal}
button{font-size:.82rem;padding:.25rem .7rem;cursor:pointer;border:1px solid #c9ccd2;border-radius:6px;background:#fff}
button:hover{background:#f0f2f5}
input,select{font-size:.85rem;padding:.2rem .35rem;border:1px solid #c9ccd2;border-radius:5px}
.top{display:flex;align-items:center;gap:1rem;margin-bottom:.8rem}
#toast{min-height:1.3em;font-size:.88rem}
#toast.ok{color:#177245}#toast.err{color:#c0392b}
.card{background:#fff;border-radius:10px;padding:.9rem 1.1rem;margin-bottom:.9rem;box-shadow:0 1px 3px rgba(0,0,0,.07)}
.card-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:.6rem}
.card-head h2{margin:0}
/* 顶部三卡并列：监听 / LLM 分析 / 推送 */
.row-top{display:flex;gap:.9rem;align-items:flex-start}
.row-top .card{flex:1;min-width:0;margin-bottom:.9rem}
@media (max-width:1100px){.row-top{flex-wrap:wrap}}
@media (max-width:1100px){.row-top .card{flex:1 1 100%}}
.hint{color:#888;font-size:.82rem}
.hidden{display:none}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:.35rem;vertical-align:baseline}
.dot.green{background:#2ba245}.dot.yellow{background:#e0a800}.dot.red{background:#d43f3a}.dot.gray{background:#b7bcc4}
/* 卡片1 监听 */
#listen-rows{display:flex;flex-direction:column;gap:.15rem}
.lrow{display:flex;align-items:center;gap:.55rem;font-size:.88rem;padding:.3rem 0;border-bottom:1px solid #f0f2f5;min-width:0}
.lrow:last-child{border-bottom:none}
.lrow.clickable{cursor:pointer}
.lrow.clickable:hover{background:#f0f2f5}
.lname{font-weight:600;white-space:nowrap}
.lstate{color:#666;font-size:.8rem;white-space:nowrap}
.grow{flex:1}
/* 开关（checkbox 样式化为滑块） */
.switch{position:relative;display:inline-block;width:34px;height:19px;flex:none}
.switch input{opacity:0;width:0;height:0}
.slider{position:absolute;inset:0;background:#c9cdd4;border-radius:19px;transition:background .15s}
.slider:before{content:"";position:absolute;width:15px;height:15px;left:2px;top:2px;background:#fff;border-radius:50%;transition:transform .15s}
.switch input:checked + .slider{background:#2ba245}
.switch input:checked + .slider:before{transform:translateX(15px)}
.switch input:disabled + .slider{opacity:.5}
/* 卡片2 LLM 分析 */
.llm-row{display:flex;align-items:center;gap:.6rem;border:1px solid #e5e7eb;border-radius:6px;padding:.4rem .6rem;margin:.4rem 0;font-size:.85rem}
.llm-row.dragging{opacity:.45;border-style:dashed}
.llm-grip{cursor:grab;color:#b0b6bf;font-size:.9rem;user-select:none}
.llm-name{font-weight:600;white-space:nowrap}
.llm-add-row{margin:.5rem 0;text-align:center;border:1px dashed #e5e7eb;border-radius:6px;padding:.45rem}
/* 卡片5 主播列表 */
.streamer-card{display:flex;gap:1rem;border:1px solid #e5e7eb;border-radius:10px;padding:.7rem .8rem;margin:.55rem 0;cursor:pointer}
.streamer-card:hover{border-color:#b9c2cf;box-shadow:0 1px 4px rgba(0,0,0,.08)}
.sc-left{width:180px;flex:none;min-width:0}
.avatar{width:56px;height:56px;border-radius:50%;object-fit:cover;display:block}
.avatar-ph{display:flex;align-items:center;justify-content:center;background:#dfe3ea;color:#5a6472;font-size:1.3rem}
.sc-name{font-weight:600;margin:.35rem 0 .2rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meta{font-size:.78rem;color:#777;margin:.12rem 0}
.rules-row{display:flex;flex-wrap:wrap;gap:.3rem}
.sc-note{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sc-note.none{color:#b3b9c2}
.sc-right{flex:1;display:flex;gap:.8rem;min-width:0;align-items:flex-start}
.kf{width:250px;aspect-ratio:16/9;border-radius:8px;object-fit:cover;flex:none;background:#eceef1}
.kf-empty{display:flex;align-items:center;justify-content:center}
.live-info{min-width:0}
.live-title{font-size:.9rem;font-weight:600;margin-bottom:.25rem;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.off-dur{font-size:.9rem;color:#555}
/* 主播卡片第三栏：动态时间线 */
.sc-posts{width:250px;flex:none;min-width:0;border-left:1px solid #eef0f3;padding-left:.8rem}
.sc-posts-title{font-size:.82rem;color:#666;margin-bottom:.2rem}
.post{display:flex;gap:.5rem;padding:.3rem .2rem;color:inherit;text-decoration:none;border-radius:6px}
.post+.post{border-top:1px dashed #eef0f3}
a.post:hover{background:#f7f9fc}
.post-thumb{width:52px;height:52px;border-radius:6px;object-fit:cover;flex:none;background:#eceef1}
.post-body{flex:1;min-width:0}
.post-head{display:flex;gap:.4rem;align-items:center;margin-bottom:.1rem}
.post-time{font-size:.72rem;color:#999;white-space:nowrap}
.post-text{font-size:.78rem;color:#444;white-space:pre-line;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
/* 卡片6 关注列表 */
.follow-search{margin-bottom:.55rem}
.follow-search input{width:16rem}
.follow-row{display:flex;flex-wrap:wrap;gap:.6rem;align-items:flex-start}
.follow-card{width:110px;border:1px solid #e5e7eb;border-radius:8px;padding:.5rem .3rem;text-align:center}
.f-avatar{width:44px;height:44px;border-radius:50%;object-fit:cover;margin:0 auto}
.f-name{font-size:.78rem;margin:.3rem 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.follow-card .tag{display:block;margin:.1rem auto;width:fit-content}
.f-more{margin:.5rem 0;text-align:center}
.f-more a{color:#2b6cb0;cursor:pointer;text-decoration:none}
.f-more a:hover{text-decoration:underline}
/* 弹窗 */
#modal-mask,#modal-mask2{position:fixed;inset:0;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;z-index:10}
#modal-mask2{z-index:11}
#modal-mask.hidden,#modal-mask2.hidden{display:none}
#modal,#modal2{background:#fff;border-radius:10px;max-width:680px;width:92%;max-height:86vh;overflow:auto;padding:1rem 1.2rem}
.mrow{margin:.45rem 0;display:flex;gap:.9rem;align-items:center;flex-wrap:wrap;font-size:.88rem}
.mrow input[type=text],.mrow input:not([type]){min-width:9rem}
.wfull{flex:1;width:100%}
.mfoot{margin-top:.8rem;color:#999;font-size:.76rem;border-top:1px solid #eee;padding-top:.5rem}
.qr-box{margin:.6rem 0;min-height:2rem}
.qr-box svg{width:220px;height:220px}
/* 卡片3 推送 */
.push-actions{display:flex;gap:.6rem;margin-top:.6rem}
.push-actions button{flex:1}
.tag{display:inline-block;font-size:.72rem;padding:.05rem .4rem;border-radius:4px;background:#eef1f5;color:#556}
.rule-err{color:#c0392b;font-size:.82rem;margin-left:.3rem}
`;
