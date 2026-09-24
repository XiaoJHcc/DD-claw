// 面板前端 · 卡片「变更历史」（P0b 撤销的用户面）：设置页底部的只读列表 + 栈顶一条的撤销入口。
// 数据 = GET /api/undo/history（新→旧全量，只标 undone 不删行），撤销 = POST /api/undo（无 body）。
// 语义约束（计划定调，勿在 UI 上加花样）：撤销是栈式逆序——只有最新一条未撤销的记录带「撤销」按钮，
// 不做跳序撤销；写前不强制确认（撤销本身就是兜底，且撤销后可再撤下一条）。
// 冲突（409「该设置已被其他入口修改，无法撤销本次」）是预期内 UX 不是故障：原样提示 + 刷新列表，
// 并把该条标注「已被后续变更覆盖」。服务端契约里没有这个标记，故纯前端记「本会话遭遇过冲突的记录 id」；
// 按钮保留（先撤掉那条更新的记录后，本条的比对可能重新成立）。
// 文案全部来自服务端（逐字冻结契约）：title = 中文操作名 / detail = 行级中文明细 / undoNote = 撤销副作用
// 标记——前端不再维护「工具名 → 文案」映射（未知工具后端回原名）。
//
// 拉取时机（2026-09-22 重做：用户核心抱怨「同页操作后历史不更新、撤销后页面状态不还原」）：
//   ① 进入设置视图（app.js 的 switchView）；
//   ② **任何配置写成功后**——经 core.js 的 onConfigWrite 钩子（白名单口径见 core.js 的 isConfigWrite），
//      于是「在本页改个开关」历史立刻多一条，不必切视图；
//   ③ 每次撤销成功/失败后。
// 不做常驻轮询（历史只有配置写会变）。写密集场景（如批量保存账号）用「在途去重 + 尾随补拉」收敛请求。
import { api, toast, esc, relTime, ACTIONS, onConfigWrite, refreshTables } from './core.js';

// 行级动作 → 中文（detail[].action；未知值回原样）
const ACTION_NAMES = { created: '新增', updated: '修改', deleted: '删除' };
// 动作 tag 配色：新增=薄荷（正向） / 删除=中性灰（不借红色——红在本项目专属错误与危险） / 修改=蓝
const ACTION_TAG = { created: 'tag-mint', updated: 'tag-blue', deleted: '' };

// 来源入口（entry）→ 面板文案；未知值回退原样
const ENTRY_NAMES = { panel: '面板', mcp: 'MCP', agent: 'Agent' };

// 明细最多渲染几行（删分类这类级联写可能有十几行；超出折叠成一行「另有 N 条」）
const DETAIL_CAP = 6;

function two(n) { return String(n).padStart(2, '0'); }

// 人性化时间：一周内走 core 的相对时间（刚刚 / N 分钟前 / …），更早用「M月D日 HH:MM」
function fmtAt(ts) {
  const t = Number(ts);   // 契约是秒级数字时间戳，容一手字符串序列化
  if (!Number.isFinite(t) || t <= 0) return '—';
  const diff = Math.floor(Date.now() / 1000) - t;
  if (diff >= 0 && diff < 7 * 86400) return relTime(t);
  const d = new Date(t * 1000);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + two(d.getHours()) + ':' + two(d.getMinutes());
}

// hover 提示里的完整时刻（本机时区 YYYY-MM-DD HH:MM:SS）
function fullTime(ts) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '—';
  const d = new Date(t * 1000);
  return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' +
    two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
}

// 本会话遭遇过 409 的记录 id（键 = 变更记录 id）：仅前端会话内有效，刷新页面即清
const conflicts = {};
let busy = false;      // 撤销请求在途：吞掉重复点击
let lastList = [];     // 最近一次拉到的历史（撤销成功后按 id 找回受影响表，无需服务端在撤销响应里带 tables）

// ---- 行级明细：每条 = 「动作 tag + 中文 label（+ 改了：字段A、字段B）」一行 ----
function detailLineHtml(d) {
  const label = esc(d && d.label ? d.label : '（未提供明细）');
  const act = ACTION_NAMES[d && d.action] || (d && d.action) || '';
  const tag = act
    ? `<span class="tag ${ACTION_TAG[d && d.action] || ''}">${esc(act)}</span>`
    : '';
  const fields = d && d.fields && d.fields.length
    ? `<span class="undo-fields">改了：${esc(d.fields.join('、'))}</span>`
    : '';
  return `<span class="undo-detail-row">${tag}<span class="undo-detail-label">${label}</span>${fields}</span>`;
}

function detailHtml(c) {
  const list = Array.isArray(c.detail) ? c.detail : [];
  if (!list.length) return '';   // 服务端没给明细（旧记录）→ 不渲染这一块
  const shown = list.slice(0, DETAIL_CAP);
  let html = shown.map(detailLineHtml).join('');
  if (list.length > shown.length) {
    html += `<span class="undo-detail-row"><span class="undo-detail-label">另有 ${list.length - shown.length} 条</span></span>`;
  }
  return '<span class="undo-detail">' + html + '</span>';
}

// 单条记录：主行 = 操作名 + 来源 tag + 受影响摘要 tag + 状态 tag；明细 = 行级中文明细（新契约）；
// 副行 = 时间 · 操作者 · 表名（tooltip 里补完整时刻 / 工具原名 / 栈 / 表名清单）；
// 撤销按钮只在栈顶那条（最新未撤销）出现
function rowHtml(c, topId) {
  const tbl = c.tables || [];
  const entry = ENTRY_NAMES[c.entry] || c.entry || '未知来源';
  const entryTag = `<span class="tag ${c.entry === 'mcp' ? 'tag-purple' : 'tag-blue'}">${esc(entry)}</span>`;
  const sumText = tbl.length ? tbl.length + ' 张表 · ' + (c.rows || 0) + ' 行' : '无行变化';
  const sumTag = `<span class="tag" title="${esc(tbl.join(', ') || '无受影响表')}">${esc(sumText)}</span>`;
  const statusTag = c.undone ? '<span class="tag">已撤销</span>' : '';
  // 撤销会把 LLM 密钥清空（服务端 undoNote）——提前在条目上标记，别等撤完才发现要重填
  const refillTag = c.undoNote === 'refill'
    ? '<span class="tag tag-amber" title="这条记录含 LLM 密钥：撤销会清空密钥，需要重新填写">撤销将清空密钥需重填</span>'
    : '';
  const conflictTag = conflicts[c.id]
    ? '<span class="tag tag-amber" title="前像与当前值不一致（多由其他入口的后续修改造成），撤销会中止；' +
      '先撤销那条更新的记录再试">已被后续变更覆盖</span>'
    : '';
  const sub = [fmtAt(c.at), c.actor || '', tbl.join(', ')].filter(Boolean).join(' · ');
  const tip = [fullTime(c.at), '工具 ' + (c.tool || '未知'), '来源 ' + entry + (c.actor ? '（' + c.actor + '）' : ''),
    c.scope ? '栈 ' + c.scope : '', tbl.length ? '表 ' + tbl.join(', ') : ''].filter(Boolean).join(' · ');
  return `<div class="row row-2 undo-row${c.undone ? ' undo-off' : ''}">` +
    '<span class="row-main"><span class="row-line">' +
    `<span class="row-title">${esc(c.title || c.tool || '未知操作')}</span>` + entryTag + sumTag + refillTag + conflictTag + statusTag +
    `</span>${detailHtml(c)}<span class="row-sub" title="${esc(tip)}">${esc(sub)}</span></span>` +
    '<span class="row-end">' + (c.id === topId
      ? `<button class="btn btn-ghost" data-action="undo-change" data-id="${esc(c.id)}">撤销</button>`
      : '') + '</span></div>';
}

// 在途去重 + 尾随补拉：写密集时（一次保存发多个 PUT）只留一次在途请求，期间的新请求合并成收尾再拉一次
let inflight = null;
let dirty = false;

/** 拉取变更历史并重渲列表（进设置视图 / 配置写成功 / 每次撤销之后调用；调用方不必等它） */
export function loadUndoHistory() {
  if (inflight) { dirty = true; return inflight; }
  inflight = api('/api/undo/history').then(function (j) {
    const list = j.changes || [];
    lastList = list;
    const host = document.getElementById('undo-list');
    if (!host) return;
    if (!list.length) {
      host.innerHTML = '<div class="undo-empty">还没有变更记录（面板与 MCP 的配置写会记在这里）</div>';
      return;
    }
    // 服务端已按新→旧返回；第一个未撤销的就是栈顶（唯一可撤的那条）
    let topId = null;
    for (let i = 0; i < list.length; i++) {
      if (!list[i].undone) { topId = list[i].id; break; }
    }
    host.innerHTML = list.map(function (c) { return rowHtml(c, topId); }).join('');
  }).catch(function (e) {
    toast(e.message, true);
    const host = document.getElementById('undo-list');
    if (host) host.innerHTML = '<div class="undo-empty">变更历史加载失败</div>';
  }).then(function () {
    inflight = null;
    if (dirty) { dirty = false; loadUndoHistory(); }
  });
  return inflight;
}

// 任何配置写成功 → 刷历史（core.js 的白名单钩子；在设置视图外发生也无害，一次本地 GET）
onConfigWrite(function () { loadUndoHistory(); });

ACTIONS['undo-change'] = function (el) {
  if (busy) return;
  const id = Number(el.getAttribute('data-id'));
  busy = true;
  el.disabled = true;
  api('/api/undo', 'POST').then(function (res) {
    busy = false;
    delete conflicts[id];   // 该条已撤销，冲突标记无意义
    const title = (res && res.title) || (res && res.change && res.change.title) || titleOf(id);
    const refill = (res && res.refill) || [];
    if (refill.length) {
      toast('已撤销：' + title + '；请重新填写 LLM 密钥：' + refill.join('、'));
    } else {
      toast('已撤销：' + title);
    }
    reloadAffected(id);
    loadUndoHistory();
  }).catch(function (e) {
    busy = false;
    // api() 只抛 message（不透传状态码），故按 409 的固定文案判定冲突标记；其余（404 空栈等）同样原样提示
    if (e.message.indexOf('已被其他入口修改') >= 0) conflicts[id] = true;
    toast(e.message, true);
    loadUndoHistory();
  });
};

function titleOf(id) {
  for (let i = 0; i < lastList.length; i++) {
    if (lastList[i].id === id) return lastList[i].title || lastList[i].tool || '该变更';
  }
  return '该变更';
}

// 撤销成功后把页面状态拉回真实态：按该条记录的受影响表调各卡片的 loader。
// 表 → loader 的登记在各卡片模块（core.js 的 onTableRefresh），这里只负责查表名。
// 记录不在缓存列表里（历史没拉到 / 已被裁剪）时兜底 'settings'——它挂着所有设置面 loader。
// 记录在列表里但 tables 为空 = 那次写没动任何行，不必刷新。
function reloadAffected(id) {
  let rec = null;
  for (let i = 0; i < lastList.length; i++) if (lastList[i].id === id) rec = lastList[i];
  refreshTables(rec ? (rec.tables || []) : ['settings']);
}