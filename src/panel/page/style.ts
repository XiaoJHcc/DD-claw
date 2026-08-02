/**
 * 控制面板全部 CSS，内嵌字符串（dist 只编译 TS，不拷静态文件）。
 * 内容不得出现反引号与 ${，避免与外层模板字面量冲突。
 */
export const PANEL_CSS = `
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:1080px;margin:1.2rem auto;padding:0 1rem;color:#222;background:#f4f5f7}
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
.hint{color:#888;font-size:.82rem}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:.35rem;vertical-align:baseline}
.dot.green{background:#2ba245}.dot.yellow{background:#e0a800}.dot.red{background:#d43f3a}.dot.gray{background:#b7bcc4}
/* 卡片1 运行状态 */
.status-flex{display:flex;justify-content:space-between;gap:2rem;flex-wrap:wrap}
.srow{font-size:.88rem;margin:.18rem 0}
.slabel{display:inline-block;width:4.5em;color:#888}
.plat{font-size:.9rem;margin:.3rem 0;padding:.2rem .4rem;border-radius:6px}
.plat.clickable{cursor:pointer}
.plat.clickable:hover{background:#f0f2f5}
.pstate{color:#666;font-size:.82rem;margin-left:.3rem}
/* 卡片3 主播列表 */
.streamer-card{display:flex;gap:1rem;border:1px solid #e5e7eb;border-radius:10px;padding:.7rem .8rem;margin:.55rem 0;cursor:pointer}
.streamer-card:hover{border-color:#b9c2cf;box-shadow:0 1px 4px rgba(0,0,0,.08)}
.sc-left{width:180px;flex:none;min-width:0}
.avatar{width:56px;height:56px;border-radius:50%;object-fit:cover;display:block}
.avatar-ph{display:flex;align-items:center;justify-content:center;background:#dfe3ea;color:#5a6472;font-size:1.3rem}
.sc-name{font-weight:600;margin:.35rem 0 .2rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meta{font-size:.78rem;color:#777;margin:.12rem 0}
.sc-note{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sc-note.none{color:#b3b9c2}
.sc-right{flex:1;display:flex;gap:.8rem;min-width:0;align-items:flex-start}
.kf{width:250px;aspect-ratio:16/9;border-radius:8px;object-fit:cover;flex:none;background:#eceef1}
.kf-empty{display:flex;align-items:center;justify-content:center}
.live-info{min-width:0}
.live-title{font-size:.9rem;font-weight:600;margin-bottom:.25rem;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.off-dur{font-size:.9rem;color:#555}
/* 关注未监听 */
.follows-title{font-size:.88rem;color:#666;margin:.9rem 0 .4rem}
.follow-row{display:flex;flex-wrap:wrap;gap:.6rem}
.follow-card{width:110px;border:1px solid #e5e7eb;border-radius:8px;padding:.5rem .3rem;text-align:center}
.f-avatar{width:44px;height:44px;border-radius:50%;object-fit:cover;margin:0 auto}
.f-name{font-size:.78rem;margin:.3rem 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 弹窗 */
#modal-mask{position:fixed;inset:0;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;z-index:10}
#modal-mask.hidden{display:none}
#modal{background:#fff;border-radius:10px;max-width:680px;width:92%;max-height:86vh;overflow:auto;padding:1rem 1.2rem}
.mrow{margin:.45rem 0;display:flex;gap:.9rem;align-items:center;flex-wrap:wrap;font-size:.88rem}
.mrow input[type=text],.mrow input:not([type]){min-width:9rem}
.wfull{flex:1;width:100%}
.mfoot{margin-top:.8rem;color:#999;font-size:.76rem;border-top:1px solid #eee;padding-top:.5rem}
.qr-box{margin:.6rem 0;min-height:2rem}
.qr-box svg{width:220px;height:220px}
/* 子句表单（详情弹窗内） */
.clause{border:1px solid #ddd;border-radius:6px;padding:.45rem .6rem;margin:.45rem 0;font-size:.84rem}
.clause.add{background:#f7f9fc;border-style:dashed}
.clause label{white-space:nowrap;margin-right:.45rem}
.clause .row{margin:.25rem 0}
`;
