// 面板前端 · 卡片「变更历史」（P0b 撤销的用户面）：设置页底部的操作历史列表 + 栈顶一条的撤销入口。
// 数据 = GET /api/undo/history（新→旧全量，只标 undone 不删行），撤销 = POST /api/undo（无 body）。
// 语义约束（计划定调，勿在 UI 上加花样）：撤销是栈式逆序——只有最新一条未撤销的记录带「撤销」按钮，
// 不做跳序撤销；写前不强制确认（撤销本身就是兜底，且撤销后可再撤下一条）。
// 冲突（409「该设置已被其他入口修改，无法撤销本次」）是预期内 UX 不是故障：原样提示 + 刷新列表，
// 并把该条标注「已被后续变更覆盖」。服务端契约里没有这个标记，故纯前端记「本会话遭遇过冲突的记录 id」；
// 按钮保留（先撤掉那条更新的记录后，本条的比对可能重新成立）。
//
// 内容契约（2026-09-23 定，逐字冻结；文案全部来自服务端，前端不维护「工具名/列名 → 文案」映射）：
//   headline  一句话操作描述（值感知：「停用了推送规则「杂谈-开播」」「设置了 DeepSeek 的 LLM 密钥」）
//   detail[]  { label 中文对象名, action: created|updated|deleted,
//               changes: [{ field, from, to, bool? }] —— 值已格式化（布尔=开/关、JSON 数组=顿号、数值带单位）；
//               值不可示人（LLM key / MCP 令牌）= { field, redacted: true } }
//   undoneAt  撤销时刻（秒，可空）→ meta 显示「已于 HH:MM 撤销」
// 展示纪律：数据库实现细节（N 张表 · M 行、表名）不进界面——表名只留撤销后的刷新路由。
//
// 布局（2026-09-24 重排、2026-09-25 结构修复，与 style.css「变更历史卡」段互为信源）：
//   条目 = 顶行 + 可选明细块两段式，条目体顶锚定、顶行上下边距恒定 --sp-1——展开/收起
//   两种形态首行位置严格一致。
//   顶行（恒单行，全项 align-items:center 收在同一中线——圆点 8 / 各字号文本 / 按钮 32
//   的高差不产生错位，按钮槽内按钮压到 32 使全列表顶行等高）：圆点 + headline + 冲突警告
//   （琥珀小字）+ 变化段（前 LINE_CAP 项自然宽度横排、右端渐隐裁切，逐项 title 兜底全文）+
//   折叠开关 + meta（来源 · 操作者 · 时间 · 撤销时刻）+ 恒宽撤销按钮槽（没按钮也预留，
//   各条 meta 右缘对齐同一竖线）。
//   展开：变化段内容换成整宽明细块（全部变化逐行平铺、左缘与 headline 对齐），顶行元素位置
//   纹丝不动（变化段容器留作占位）；展开状态信源 = 前端 expanded（按记录 id），重拉历史不丢，
//   展开/收起由同一渲染路径产出，不存在状态与按钮文案脱节。
// refill 注记（「撤销将清空密钥，需重填」）不是警告标记——它是密钥更新事件自身的解释，
// 收作变化行末尾一项（琥珀），已撤销后不再显示。
//
// 拉取时机：① 进入设置视图（app.js 的 switchView）；② 任何配置写成功后（core.js 的 onConfigWrite 钩子）；
// ③ 每次撤销成功/失败后。不做常驻轮询。写密集场景用「在途去重 + 尾随补拉」收敛请求。
import { api, toast, esc, relTime, ACTIONS, onConfigWrite, refreshTables } from './core.js';
import { icon } from './icons.js';

// 来源入口（entry）→ 面板文案与圆点配色；未知值文案回退原样、圆点用中性灰
const ENTRY_NAMES = { panel: '面板', mcp: 'MCP', agent: 'Agent', cli: 'CLI' };
const ENTRY_DOTS = { panel: 'undo-dot-blue', mcp: 'undo-dot-purple', agent: 'undo-dot-mint' };

// 顶行变化段横排几项；超出的折叠成「展开其余 N 条」（reorder 这类整表重写可能有十几行）
const LINE_CAP = 3;

function two(n) { return String(n).padStart(2, '0'); }

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// 行尾时间：今天的条目用相对时间（刚刚 / N 分钟前），更早的给 HH:MM（日期由分组标题承担）
function fmtAt(ts) {
  const t = Number(ts);   // 契约是秒级数字时间戳，容一手字符串序列化
  if (!Number.isFinite(t) || t <= 0) return '—';
  const d = new Date(t * 1000);
  if (sameDay(d, new Date())) return relTime(t);
  return two(d.getHours()) + ':' + two(d.getMinutes());
}

// 分组标题：今天 / 昨天 / M月D日
function dayLabel(ts) {
  const d = new Date(Number(ts) * 1000);
  const now = new Date();
  if (sameDay(d, now)) return '今天';
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(d, y)) return '昨天';
  return (d.getMonth() + 1) + '月' + d.getDate() + '日';
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
let lastList = [];     // 最近一次拉到的历史（渲染的唯一数据源；撤销成功后按 id 找回受影响表）
// 展开态（键 = 变更记录 id）：展开/收起的唯一信源——渲染读它、折叠开关写它，重拉历史不丢
const expanded = {};

// ---- 变化行组装 ----
// 单字段变化 → { h: 内层 HTML, t: 值段纯文本（不含字段名，tooltip 由调用方拼） }。
// mode = 字段名的给法：'colon' = 「字段：」（独立成行）/ 'bare' = 「字段 」（对象名后的修饰词，
// 不重复冒号）/ 'none' = 省字段名（布尔单列或字段名与对象同名时已自明）。
// redacted 只报「已更新（值不落库）」（colon 态仍带字段标签）；只有新值（demo 写路径）给「新值」。
function pair(ch, mode) {
  const field = ch && ch.field ? String(ch.field) : '';
  const label = mode === 'colon' ? `<span class="undo-ch-f">${esc(field)}</span>`
    : mode === 'bare' ? `<span class="undo-ch-f2">${esc(field)}</span> ` : '';
  if (ch && ch.redacted) {
    return { h: label + '已更新（值不落库）', t: '已更新（值不落库）' };
  }
  const onlyTo = ch && ch.from === undefined && ch.to !== undefined;
  const h = onlyTo
    ? `<span class="undo-ch-to">${esc(ch.to)}</span>`
    : `<span class="undo-ch-from">${esc(ch && ch.from !== undefined ? ch.from : '')}</span>` +
      '<span class="undo-ch-arr">→</span>' +
      `<span class="undo-ch-to">${esc(ch && ch.to !== undefined ? ch.to : '')}</span>`;
  const t = onlyTo
    ? String(ch.to)
    : (ch && ch.from !== undefined ? ch.from : '') + ' → ' + (ch && ch.to !== undefined ? ch.to : '');
  return { h: label + h, t: t };
}

// 多行记录里的对象短标签：「杂谈-开播」（剥掉表前缀）；无书名号（settings 名）用整名
function shortLabel(label) {
  const m = /「(.+)」/.exec(label);
  return m ? m[1] : label;
}

// 一条记录的全部变化行（[{ h: 内层 HTML, t: 整行纯文本 tooltip }]，折叠在 rowHtml 做）。行数压缩规则：
// - 新增/删除主体：headline 已表达（「删除了分类「杂谈」」），不产变化行
// - 单行布尔变化：headline 值感知句已表达（「关闭了推送总开关」），不产变化行
// - 单行单字段、字段名与对象同名（settings kv）：只给「旧 → 新」
// - 多行级联：逐对象一行（「杂谈-开播：开 → 关」），bool 单列变化省略字段名；
//   被删/被建的附带行没有 changes，用动作词收一句
function changeLines(c) {
  const list = Array.isArray(c.detail) ? c.detail : [];
  const lines = [];
  const structuralIdx = list.findIndex((d) => d && d.action !== 'updated');
  const primaryIdx = structuralIdx >= 0 ? structuralIdx : list.length === 1 ? 0 : -1;
  list.forEach(function (d, i) {
    if (!d) return;
    const chs = Array.isArray(d.changes) ? d.changes : [];
    if (i === primaryIdx && d.action !== 'updated') return;
    if (list.length === 1) {
      if (chs.length === 1 && chs[0] && chs[0].bool) return;
      for (const ch of chs) {
        const same = chs.length === 1 && ch && !ch.redacted && ch.field === shortLabel(d.label || '');
        const p = pair(ch, same ? 'none' : 'colon');
        // 单行记录的 tooltip 恒带字段名
        lines.push({ h: p.h, t: (ch && ch.field ? ch.field + '：' : '') + p.t });
      }
      return;
    }
    const obj = shortLabel(d.label || '');
    if (chs.length > 0) {
      const parts = [];
      const tips = [];
      for (const ch of chs) {
        const none = chs.length === 1 && ch && (ch.bool || ch.field === obj);
        const p = pair(ch, none ? 'none' : 'bare');
        parts.push(p.h);
        tips.push(!none && ch && ch.field && !ch.redacted ? ch.field + '：' + p.t : p.t);
      }
      lines.push({ h: `<span class="undo-ch-obj">${esc(obj)}</span>${parts.join('；')}`, t: obj + '：' + tips.join('；') });
    } else if (d.action === 'deleted') {
      lines.push({ h: `<span class="undo-ch-obj">${esc(obj)}</span>已一并删除`, t: obj + '：已一并删除' });
    } else if (d.action === 'created') {
      lines.push({ h: `<span class="undo-ch-obj">${esc(obj)}</span>一并新增`, t: obj + '：一并新增' });
    }
  });
  return lines;
}

// 单条记录：顶行（恒单行）+ 展开时追加整宽明细块。
// 顶行 = 圆点 + headline + 冲突警告 + 变化段（收起态装前 LINE_CAP 项；展开态留空作占位，
// 顶行各元素位置不变）+ 折叠开关 + meta + 恒宽撤销按钮槽（只栈顶有按钮）；
// 明细块 = 全部变化逐行平铺（仅展开态渲染）
function rowHtml(c, topId) {
  const entry = ENTRY_NAMES[c.entry] || c.entry || '未知来源';
  const dotCls = ENTRY_DOTS[c.entry] || '';
  const headline = esc(c.headline || c.title || c.tool || '未知操作');
  const lines = changeLines(c);
  // refill 注记 = 密钥更新事件的解释，作为变化行末尾一项（已撤销的条目不再提示——撤销已发生）
  if (!c.undone && c.undoNote === 'refill') {
    lines.push({ h: '<span class="undo-note">撤销将清空密钥，需重填</span>', t: '撤销将清空密钥，需重填' });
  }
  const open = !!expanded[c.id] && lines.length > LINE_CAP;
  const changesHtml = lines.length
    ? '<span class="undo-changes">' +
      (open ? '' : lines.slice(0, LINE_CAP).map((l) => `<span class="undo-ch" title="${esc(l.t)}">${l.h}</span>`).join('')) +
      '</span>'
    : '';
  const detailHtml = open
    ? '<div class="undo-detail">' +
      lines.map((l) => `<div class="undo-dl" title="${esc(l.t)}">${l.h}</div>`).join('') +
      '</div>'
    : '';
  const moreHtml = lines.length > LINE_CAP
    ? `<button class="undo-more" data-action="undo-expand" data-id="${esc(c.id)}">` +
      (open ? '收起' : '展开其余 ' + (lines.length - LINE_CAP) + ' 条') + '</button>'
    : '';
  // 冲突警告（「已被后续变更覆盖」）：headline 后的琥珀小字；已撤销的条目不再提示（撤销已发生）
  const warnsHtml = (!c.undone && conflicts[c.id]) ? '<span class="undo-warn">已被后续变更覆盖</span>' : '';
  // meta：来源 · 操作者（面板本人省略）· 时间 · 已撤销时刻（时间序，撤销注记收尾）
  const meta = [entry];
  if (c.actor && c.actor !== 'panel' && c.actor !== c.entry) meta.push(c.actor);
  meta.push(fmtAt(c.at));
  if (c.undone && c.undoneAt) meta.push('已于 ' + fmtAt(c.undoneAt) + ' 撤销');
  // 整行 tooltip 说人话：完整时刻 + 谁从哪操作的
  const tip = fullTime(c.at) + ' · ' + (c.actor && c.actor !== c.entry
    ? c.actor + ' 通过 ' + entry + ' 操作'
    : entry + ' 操作');
  return `<div class="row undo-entry${c.undone ? ' undo-off' : ''}${open ? ' undo-open' : ''}" title="${esc(tip)}">` +
    '<div class="undo-body"><div class="undo-top">' +
    `<span class="undo-dot ${dotCls}"></span>` +
    `<span class="undo-headline">${headline}</span>${warnsHtml}` +
    changesHtml + moreHtml +
    `<span class="undo-meta">${esc(meta.join(' · '))}</span>` +
    '<span class="undo-act">' +
    (c.id === topId
      ? `<button class="btn btn-ghost" data-action="undo-change" data-id="${esc(c.id)}">${icon('rotate-ccw')}撤销</button>`
      : '') +
    '</span></div>' + detailHtml + '</div></div>';
}

// 渲染列表（唯一渲染路径：拉取成功、展开/收起都走这里；数据源 = lastList）
function renderList() {
  const host = document.getElementById('undo-list');
  if (!host) return;
  if (!lastList.length) {
    host.innerHTML = '<div class="undo-empty">还没有变更记录（面板与 MCP 的配置写会记在这里）</div>';
    return;
  }
  // 服务端已按新→旧返回；第一个未撤销的就是栈顶（唯一可撤的那条）
  let topId = null;
  for (let i = 0; i < lastList.length; i++) {
    if (!lastList[i].undone) { topId = lastList[i].id; break; }
  }
  // 按日分组（新→旧）：今天 / 昨天 / M月D日
  let html = '';
  let lastDay = null;
  for (const c of lastList) {
    const day = dayLabel(c.at);
    if (day !== lastDay) {
      html += `<div class="undo-day">${esc(day)}</div>`;
      lastDay = day;
    }
    html += rowHtml(c, topId);
  }
  host.innerHTML = html;
}

// 在途去重 + 尾随补拉：写密集时（一次保存发多个 PUT）只留一次在途请求，期间的新请求合并成收尾再拉一次
let inflight = null;
let dirty = false;

/** 拉取变更历史并重渲列表（进设置视图 / 配置写成功 / 每次撤销之后调用；调用方不必等它） */
export function loadUndoHistory() {
  if (inflight) { dirty = true; return inflight; }
  inflight = api('/api/undo/history').then(function (j) {
    lastList = j.changes || [];
    renderList();
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

// 展开/收起：翻转 expanded 状态后就地重渲（不重新拉取）
ACTIONS['undo-expand'] = function (el) {
  const id = el.getAttribute('data-id');
  if (expanded[id]) delete expanded[id]; else expanded[id] = true;
  renderList();
};

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
