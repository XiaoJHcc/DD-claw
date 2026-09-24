// 面板前端 · Agent 视图（P1 WebUI Agent 的用户面）：与进程内 agent loop 聊天，
// 用自然语言查数据 / 改设置（改设置走同一张能力面注册表，故撤销兜底与面板/MCP 一致）。
//
// 契约（后端 /api/chat*，逐字以此为准）：
//   GET  /api/chat/history → { messages:[{role:'user'|'assistant',content,at,provider}],
//                              mode:'ask'|'auto', provider:'', usage:{ messages, chars, needsResetHint } }
//     · provider = 当前选定的模型（'' = 自动路由）；assistant 消息带 provider = 该条回复实际由谁提供（持久化）
//   POST /api/chat         → { ok, reply, provider, usage }（多轮 LLM + 工具调用，可能很慢；错误 = {error} + 状态码）
//   POST /api/chat/reset   → { ok }（清空上下文）
//   PUT  /api/chat/mode    → { ok, mode }（ask = 改设置前先问；auto = 直接改，可撤销兜底）
//   PUT  /api/chat/provider→ { ok, provider }（'' = 自动路由；provider 不存在 400）
//
// 模型选择器的数据源 = GET /api/llm 的 providers 里 enabled 的那几个（显示「名字（模型 ID）」）。
//
// 会话持久在服务端：UI 不做 localStorage 缓存，进视图即重拉历史（刷新页面同理）。
// 助手回复按**纯文本**渲染（esc + white-space:pre-wrap 保留换行），不做 markdown。
// 拉取时机 = 进入视图（app.js 的 switchView 调用）；不做常驻轮询——会话只在自己发消息时变。
import { api, toast, esc, ACTIONS, CHANGES, segnavHtml, layoutSegnav, segnavSelect, dropdownHtml, ddSetValue, onTableRefresh } from './core.js';

// 写模式两态：语义进各按钮的 title（卡片头只留控件，说明不再占一行静态文案）
const MODES = [
  { value: 'ask', label: '写前询问', tip: '写前询问：agent 改设置前先问你确认' },
  { value: 'auto', label: '自动修改', tip: '自动修改：直接改，改动记进「变更历史」，可撤销兜底' },
];

let messages = [];
let mode = 'ask';
let usage = null;
let providers = [];      // GET /api/llm 里 enabled 的供应商（模型选择器的选项）
let curProvider = '';    // '' = 自动路由（服务端 /api/chat/history 的 provider）
let listError = null;    // 历史加载失败的空态提示行（非 null 时压过消息列表渲染）
let busy = false;        // POST /api/chat 在途：输入与发送禁用 + 吞掉重复发送
// 进视图的 history 拉取与本地动作可能交叉（GET 带着「请求出发前」的旧快照回来）：
// loadSeq 在发出新消息时递增（旧响应的消息列表作废，否则会把刚发出去的气泡吞掉）；
// modeEpoch / providerEpoch 在写模式 / 模型被本地改过之后递增（旧响应里的值不再覆盖，
// 否则滑块会被拽回去、模型选择器会跳回旧模型）
let loadSeq = 0;
let modeEpoch = 0;
let providerEpoch = 0;

function two(n) { return String(n).padStart(2, '0'); }

// 气泡时间：今天只到分钟（HH:MM），更早补月日；完整时刻进 title（不随页面存活时间变味）
function clock(ts) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '';
  const d = new Date(t * 1000);
  const now = new Date();
  const hm = two(d.getHours()) + ':' + two(d.getMinutes());
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? hm : (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
}

function fullTime(ts) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '';
  const d = new Date(t * 1000);
  return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' +
    two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
}

// 一条消息：用户靠右（浅蓝底）、助手靠左（浅灰底）；下方小字 = 归属（助手才有模型名，读该条**持久化**的
// provider——不是全局当前值，换模型后历史气泡仍标着当时的模型）+ 时间
function msgHtml(m) {
  const me = m.role === 'user';
  const at = clock(m.at);
  const prov = !me && m.provider ? String(m.provider) : '';
  const meta = (prov || at)
    ? `<div class="chat-meta" title="${esc(fullTime(m.at) || '')}">` +
      (prov ? `<span class="chat-prov">${esc(prov)}</span>` : '') +
      (prov && at ? '<span class="chat-meta-dot">·</span>' : '') +
      (at ? `<span>${esc(at)}</span>` : '') + '</div>'
    : '';
  return `<div class="chat-msg ${me ? 'me' : 'ai'}">` +
    `<div class="chat-bubble">${esc(m.content)}</div>` + meta + '</div>';
}

// 在途态：助手侧一枚「思考中」气泡（真实一轮可能是多轮 LLM + 工具调用，等几十秒是常态）
function pendingHtml() {
  return '<div class="chat-msg ai"><div class="chat-bubble chat-thinking">思考中<i></i><i></i><i></i></div></div>';
}

function render() {
  const host = document.getElementById('chat-msgs');
  const scroller = document.getElementById('chat-list');
  if (!host) return;
  if (listError) {
    host.innerHTML = `<div class="chat-empty">${esc(listError)}</div>`;
  } else if (!messages.length) {
    host.innerHTML = '<div class="chat-empty">还没有对话。直接说想改什么设置、或问当前状态即可。</div>';
  } else {
    host.innerHTML = messages.map(msgHtml).join('') + (busy ? pendingHtml() : '');
  }
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
  // 用量提示只在服务端说「上下文已长」时出现一行浅字（不自动裁剪、不阻断发送）
  const note = document.getElementById('chat-note');
  if (note) note.classList.toggle('hidden', !(usage && usage.needsResetHint));
}

function setBusy(v) {
  busy = v;
  const ta = document.getElementById('chat-input');
  const btn = document.querySelector('[data-action="chat-send"]');
  if (ta) ta.disabled = v;
  if (btn) btn.disabled = v;
}

function renderMode() {
  const host = document.getElementById('chat-mode-nav');
  if (!host) return;
  host.innerHTML = segnavHtml(MODES, mode, 'sm', 'chat-mode');
  layoutSegnav(host.querySelector('.segnav'), false);
  const items = host.querySelectorAll('.segnav-item');
  for (let i = 0; i < items.length; i++) items[i].title = MODES[i].tip;   // 语义说明挂在各按钮上
}

// ---- 模型选择器：选项 = 「自动路由」 + 各启用供应商（名字（模型 ID））----
// 选定的模型已被停用/删除时，把它作为一条划线选项补在末尾——绝不静默显示成「自动路由」
// （视觉上按当前值显示，提交时服务端会给出真实错误）
function providerOptions() {
  const opts = [{ value: '', label: '自动路由' }];
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    opts.push({ value: p.name, label: p.name + (p.model ? '（' + p.model + '）' : '') });
  }
  let found = !curProvider;
  for (let j = 0; j < opts.length; j++) if (String(opts[j].value) === String(curProvider)) found = true;
  if (!found) opts.push({ value: curProvider, label: curProvider + '（不可用）', off: true });
  return opts;
}

function renderProvider() {
  const host = document.getElementById('chat-provider-pick');
  if (!host) return;
  host.innerHTML = dropdownHtml('chat-provider', providerOptions(), curProvider, 'chat-provider');
}

// 切换模型：先打服务端的账，成功才认新值——失败把选择器拨回原值（不留「看着切了其实没切」）
CHANGES['chat-provider'] = function (el) {
  const next = String(el.value || '');
  if (next === curProvider) return;
  const prev = curProvider;
  api('/api/chat/provider', 'PUT', { provider: next }).then(function (j) {
    curProvider = (j && typeof j.provider === 'string') ? j.provider : next;
    providerEpoch += 1;   // 在途的 history 响应里是改之前的模型，别让它把选择器拨回去
    ddSetValue('chat-provider', curProvider);
    toast(curProvider ? '已切换到 ' + curProvider : '已切回自动路由');
  }).catch(function (e) {
    toast(e.message, true);
    ddSetValue('chat-provider', prev);
  });
};

/** 拉历史与模型清单并整页重渲（进视图时调用；调用方不必等它） */
export function loadChat() {
  // 发消息在途时不覆盖本地：历史是「本轮到请求出发前」的旧快照，照收会把刚发出去的气泡吞掉
  if (busy) return Promise.resolve();
  const seq = ++loadSeq;
  const epoch = modeEpoch;
  const pEpoch = providerEpoch;
  return Promise.all([
    api('/api/chat/history'),
    // 模型清单只用来填选择器：拉不到（如 LLM 面整体异常）不该连累对话历史
    api('/api/llm').catch(function () { return null; }),
  ]).then(function (rs) {
    const j = rs[0], l = rs[1];
    if (seq !== loadSeq) return;   // 期间又重拉过或已发出新消息：这次响应作废
    messages = Array.isArray(j.messages) ? j.messages : [];
    if (epoch === modeEpoch) mode = j.mode === 'auto' ? 'auto' : 'ask';
    if (pEpoch === providerEpoch) curProvider = typeof j.provider === 'string' ? j.provider : '';
    if (l) {
      const all = (l && l.providers) || [];
      providers = all.filter(function (p) { return p && p.enabled; });
    }
    usage = j.usage || null;
    listError = null;
    renderMode();
    renderProvider();
    render();
  }).catch(function (e) {
    toast(e.message, true);
    messages = [];
    listError = '对话历史加载失败';
    render();
  });
}

function send() {
  if (busy) return;   // 在途防重复发送
  const ta = document.getElementById('chat-input');
  if (!ta) return;
  const text = String(ta.value || '').trim();
  if (!text) return;  // 空消息后端会 400，前端直接不发
  ta.value = '';
  listError = null;
  loadSeq += 1;   // 在途的 history 响应从此作废（旧快照里没有这条消息，照收会把它抹掉）
  messages.push({ role: 'user', content: text, at: Date.now() / 1000 });
  setBusy(true);
  render();
  api('/api/chat', 'POST', { message: text }).then(function (j) {
    setBusy(false);
    // provider = 这条回复实际由谁提供（服务端持久化，用于气泡归属小字）
    messages.push({ role: 'assistant', content: String(j.reply || ''), at: Date.now() / 1000, provider: j.provider || null });
    if (j.usage) usage = j.usage;
    render();
    ta.focus();
  }).catch(function (e) {
    setBusy(false);
    // 失败照原样 toast（LLM 未配 400 / 调用失败 502 等文案由服务端给）；
    // 已渲染的用户气泡不静默删掉——不发消息是用户的决定，刷新页面即回到服务端的真实历史
    toast(e.message, true);
    render();
    ta.focus();
  });
}
ACTIONS['chat-send'] = function () { send(); };

// 多行输入：Enter 发送 / Shift+Enter 换行。输入法组字中的 Enter 是「选词」不能当发送：
// isComposing 是标准判据，keyCode 229 是 Safari 事件乱序（compositionend 先到）的兜底，
// 两者并列是 UI 最佳实践给出的推荐写法（只对 Enter 生效，不影响移动端键盘布局输入）
(function () {
  const ta = document.getElementById('chat-input');
  if (!ta) return;
  ta.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    send();
  });
})();

ACTIONS['chat-reset'] = function () {
  if (busy) return;
  if (!confirm('清空当前对话上下文？服务端会删除全部聊天记录。')) return;
  api('/api/chat/reset', 'POST').then(function () {
    messages = [];
    listError = null;
    usage = null;   // 重置即清空上下文，用量提示随之消失（下次响应带回真实值）
    render();
    toast('已重置对话上下文');
  }).catch(function (e) { toast(e.message, true); });
};

// 写模式：先打服务端的账，成功才滑滑块——失败只 toast，滑块留在原态（不留「看着切了其实没切」）
ACTIONS['chat-mode'] = function (el) {
  const value = el.getAttribute('data-value');
  if (value === mode) return;
  api('/api/chat/mode', 'PUT', { mode: value }).then(function (j) {
    mode = j.mode === 'auto' ? 'auto' : 'ask';
    modeEpoch += 1;   // 在途的 history 响应里是改之前的 mode，别让它把滑块拽回去
    segnavSelect(document.querySelector('#chat-mode-nav .segnav'), mode);
  }).catch(function (e) { toast(e.message, true); });
};

// 撤销改了 LLM 供应商（settings 表）后，模型选择器的选项也要回到真实态——重拉一次历史与清单
onTableRefresh(['settings'], loadChat);