// 面板前端 · 卡片「变更历史」（P0b 撤销的用户面）：设置页底部的只读列表 + 栈顶一条的撤销入口。
// 数据 = GET /api/undo/history（新→旧全量，只标 undone 不删行），撤销 = POST /api/undo（无 body）。
// 语义约束（计划定调，勿在 UI 上加花样）：撤销是栈式逆序——只有最新一条未撤销的记录带「撤销」按钮，
// 不做跳序撤销；写前不强制确认（撤销本身就是兜底，且撤销后可再撤下一条）。
// 冲突（409「该设置已被其他入口修改，无法撤销本次」）是预期内 UX 不是故障：原样提示 + 刷新列表，
// 并把该条标注「已被后续变更覆盖」。服务端契约里没有这个标记，故纯前端记「本会话遭遇过冲突的记录 id」；
// 按钮保留（先撤掉那条更新的记录后，本条的比对可能重新成立）。
// 拉取时机 = 进入设置视图（app.js 的 switchView 调用）+ 每次撤销成功/失败后，不做常驻轮询。
import { api, toast, esc, relTime, ACTIONS } from './core.js';

// ---- 注册表工具名 → 面板文案（文案可由后续迭代调整；未知工具回退原名，不留空）----
const TOOL_NAMES = {
  // 开关与运行时参数
  set_push_enabled: '开关推送',
  set_llm_enabled: '开关 LLM',
  set_listen: '监听开关',
  update_runtime_config: '修改运行时参数',
  set_llm_key: '设置 LLM 密钥',
  // 主播与图文/微博/B站账号名单
  watch_streamer: '加入监听',
  unwatch_streamer: '取消监听',
  set_streamer: '修改主播设置',
  upsert_x_account: '保存 X 账号',
  delete_x_account: '删除 X 账号',
  upsert_weibo_account: '保存微博账号',
  delete_weibo_account: '删除微博账号',
  upsert_bili_account: '保存 B站动态账号',
  delete_bili_account: '删除 B站动态账号',
  // 分类 / 推送规则 / 渠道 / 图文规则
  upsert_category: '保存分类',
  delete_category: '删除分类',
  upsert_push_rule: '保存推送规则',
  delete_push_rule: '删除推送规则',
  upsert_channel: '保存推送渠道',
  delete_channel: '删除推送渠道',
  upsert_post_rule: '保存图文规则',
  delete_post_rule: '删除图文规则',
  // 拖拽排序（四个 reorder_* 是拖拽落库的唯一入口）
  reorder_channels: '调整渠道顺序',
  reorder_categories: '调整分类顺序',
  reorder_push_rules: '调整推送规则顺序',
  reorder_post_rules: '调整图文规则顺序',
  // LLM 供应商与 X 连接
  upsert_llm_provider: '保存 LLM 供应商',
  delete_llm_provider: '删除 LLM 供应商',
  reorder_llm_providers: '调整供应商顺序',
  update_x_config: '修改 X 连接设置',
  // 群自助规则（gateway 令牌；名字里带「群自助」以免与面板规则混淆）
  add_group_push_rule: '群自助加推送规则',
  remove_group_push_rule: '群自助删推送规则',
  // 测试类（有对外副作用、不入撤销；列全只是万一落进历史也能读）
  test_push: '测试推送',
  test_llm_provider: '测试 LLM 供应商',
  test_x_connection: '测试 X 连接',
};
function toolName(t) { return TOOL_NAMES[t] || t || '未知操作'; }

// 来源入口（entry）→ 面板文案；未知值回退原样
const ENTRY_NAMES = { panel: '面板', mcp: 'MCP' };

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
let busy = false;   // 撤销请求在途：吞掉重复点击

// 单条记录：主行 = 操作名 + 来源 tag + 受影响摘要 tag + 状态 tag；副行 = 时间 · 操作者 · 表名
// （tooltip 里补完整时刻 / 工具原名 / 栈 / 表名清单）；撤销按钮只在栈顶那条（最新未撤销）出现
function rowHtml(c, topId) {
  const tbl = c.tables || [];
  const entry = ENTRY_NAMES[c.entry] || c.entry || '未知来源';
  const entryTag = `<span class="tag ${c.entry === 'mcp' ? 'tag-purple' : 'tag-blue'}">${esc(entry)}</span>`;
  const sumText = tbl.length ? tbl.length + ' 张表 · ' + (c.rows || 0) + ' 行' : '无行变化';
  const sumTag = `<span class="tag" title="${esc(tbl.join(', ') || '无受影响表')}">${esc(sumText)}</span>`;
  const statusTag = c.undone ? '<span class="tag">已撤销</span>' : '';
  const conflictTag = conflicts[c.id]
    ? '<span class="tag tag-amber" title="前像与当前值不一致（多由其他入口的后续修改造成），撤销会中止；' +
      '先撤销那条更新的记录再试">已被后续变更覆盖</span>'
    : '';
  const sub = [fmtAt(c.at), c.actor || '', tbl.join(', ')].filter(Boolean).join(' · ');
  const tip = [fullTime(c.at), '工具 ' + (c.tool || '未知'), '来源 ' + entry + (c.actor ? '（' + c.actor + '）' : ''),
    c.scope ? '栈 ' + c.scope : '', tbl.length ? '表 ' + tbl.join(', ') : ''].filter(Boolean).join(' · ');
  return `<div class="row row-2 undo-row${c.undone ? ' undo-off' : ''}">` +
    '<span class="row-main"><span class="row-line">' +
    `<span class="row-title">${esc(toolName(c.tool))}</span>` + entryTag + sumTag + conflictTag + statusTag +
    `</span><span class="row-sub" title="${esc(tip)}">${esc(sub)}</span></span>` +
    '<span class="row-end">' + (c.id === topId
      ? `<button class="btn btn-ghost" data-action="undo-change" data-id="${esc(c.id)}">撤销</button>`
      : '') + '</span></div>';
}

/** 拉取变更历史并重渲列表（进设置视图 / 每次撤销之后调用；调用方不必等它） */
export function loadUndoHistory() {
  return api('/api/undo/history').then(function (j) {
    const list = j.changes || [];
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
  });
}

ACTIONS['undo-change'] = function (el) {
  if (busy) return;
  const id = Number(el.getAttribute('data-id'));
  busy = true;
  el.disabled = true;
  api('/api/undo', 'POST').then(function (res) {
    busy = false;
    delete conflicts[id];   // 该条已撤销，冲突标记无意义
    toast('已撤销：' + toolName(res && res.change ? res.change.tool : null));
    loadUndoHistory();
  }).catch(function (e) {
    busy = false;
    // api() 只抛 message（不透传状态码），故按 409 的固定文案判定冲突标记；其余（404 空栈等）同样原样提示
    if (e.message.indexOf('已被其他入口修改') >= 0) conflicts[id] = true;
    toast(e.message, true);
    loadUndoHistory();
  });
};