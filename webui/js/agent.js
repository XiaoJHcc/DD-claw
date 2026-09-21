// 面板前端 · Agent 视图（P1 WebUI Agent 的用户面）：与进程内 agent loop 聊天，
// 用自然语言查数据 / 改设置（改设置走同一张能力面注册表，故撤销兜底与面板/MCP 一致）。
//
// 契约（后端 /api/chat*，逐字以此为准）：
//   GET  /api/chat/history → { messages:[{role:'user'|'assistant',content,at}], mode:'ask'|'auto',
//                              usage:{ messages, chars, needsResetHint } }
//   POST /api/chat         → { ok, reply, usage }（多轮 LLM + 工具调用，可能很慢；错误 = {error} + 状态码）
//   POST /api/chat/reset   → { ok }（清空上下文）
//   PUT  /api/chat/mode    → { ok, mode }（ask = 改设置前先问；auto = 直接改，可撤销兜底）
//
// 会话持久在服务端：UI 不做 localStorage 缓存，进视图即重拉历史（刷新页面同理）。
// 助手回复按**纯文本**渲染（esc + white-space:pre-wrap 保留换行），不做 markdown。
// 拉取时机 = 进入视图（app.js 的 switchView 调用）；不做常驻轮询——会话只在自己发消息时变。
import { api, toast, esc, ACTIONS, segnavHtml, layoutSegnav, segnavSelect } from './core.js';

// 写模式两态；语义说明写在 index.html 工具行的 .chat-mode-hint（与开关并排，静态文案不随态变）
const MODES = [
  { value: 'ask', label: '写前询问' },
  { value: 'auto', label: '自动修改' },
];

let messages = [];
let mode = 'ask';
let usage = null;
let listError = null;   // 历史加载失败的空态提示行（非 null 时压过消息列表渲染）
let busy = false;       // POST /api/chat 在途：输入与发送禁用 + 吞掉重复发送
// 进视图的 history 拉取与本地动作可能交叉（GET 带着「请求出发前」的旧快照回来）：
// loadSeq 在发出新消息时递增（旧响应的消息列表作废，否则会把刚发出去的气泡吞掉）；
// modeEpoch 在写模式被本地改过之后递增（旧响应里的 mode 不再覆盖，否则滑块会被拽回去）
let loadSeq = 0;
let modeEpoch = 0;

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

// 一条消息：用户靠右（浅蓝底）、助手靠左（浅灰底），各带一枚时间小字
function msgHtml(m) {
  const me = m.role === 'user';
  const at = clock(m.at);
  return `<div class="chat-msg ${me ? 'me' : 'ai'}">` +
    `<div class="chat-bubble">${esc(m.content)}</div>` +
    (at ? `<div class="chat-meta" title="${esc(fullTime(m.at))}">${esc(at)}</div>` : '') +
    '</div>';
}

// 在途态：助手侧一枚「思考中」气泡（真实一轮可能是多轮 LLM + 工具调用，等几十秒是常态）
function pendingHtml() {
  return '<div class="chat-msg ai"><div class="chat-bubble chat-thinking">思考中<i></i><i></i><i></i></div></div>';
}

function render() {
  const host = document.getElementById('chat-list');
  if (!host) return;
  if (listError) {
    host.innerHTML = `<div class="chat-empty">${esc(listError)}</div>`;
  } else if (!messages.length) {
    host.innerHTML = '<div class="chat-empty">还没有对话。直接说想改什么设置、或问当前状态即可。</div>';
  } else {
    host.innerHTML = messages.map(msgHtml).join('') + (busy ? pendingHtml() : '');
  }
  host.scrollTop = host.scrollHeight;
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
}

/** 拉历史并整页重渲（进视图时调用；调用方不必等它） */
export function loadChat() {
  // 发消息在途时不覆盖本地：历史是「本轮到请求出发前」的旧快照，照收会把刚发出去的气泡吞掉
  if (busy) return Promise.resolve();
  const seq = ++loadSeq;
  const epoch = modeEpoch;
  return api('/api/chat/history').then(function (j) {
    if (seq !== loadSeq) return;   // 期间又重拉过或已发出新消息：这次响应作废
    messages = Array.isArray(j.messages) ? j.messages : [];
    if (epoch === modeEpoch) mode = j.mode === 'auto' ? 'auto' : 'ask';
    usage = j.usage || null;
    listError = null;
    renderMode();
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
    messages.push({ role: 'assistant', content: String(j.reply || ''), at: Date.now() / 1000 });
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

// 多行输入：Enter 发送 / Shift+Enter 换行。输入法组字中的 Enter 是「选词」不能当发送
// （isComposing 在部分浏览器组字收尾时为 false，故一并看 keyCode 229 这个历史兜底）
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