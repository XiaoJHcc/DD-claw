// 面板前端 · Agent 视图（P1 WebUI Agent 的用户面）：与进程内 agent loop 聊天，
// 用自然语言查数据 / 改设置（改设置走同一张能力面注册表，故撤销兜底与面板/MCP 一致）。
//
// 契约（后端 /api/chat*，逐字以此为准）：
//   GET  /api/chat/history → { messages:[{id, role:'user'|'assistant', content, at, provider, calls?}],
//                              mode:'ask'|'auto', provider:'', usage:{ messages, chars, needsResetHint } }
//     · id = chat_messages.id（进行中轮询的增量去重键）
//     · provider = 当前选定的模型（'' = 自动路由）；assistant 消息带 provider = 该条回复实际由谁提供（持久化）
//     · calls = 该条 assistant 消息携带的工具调用行（ToolCallView：{id, name, title, target, ok, args, output}），
//       中间轮（content 为空、只有工具调用）也作为独立消息出现
//   POST /api/chat         → { ok, reply, provider, usage, calls }（多轮 LLM + 工具调用，可能很慢；错误 = {error} + 状态码）
//     · calls = 本轮全部工具调用明细（同一 ToolCallView 形状），渲染在终答上方
//   POST /api/chat/reset   → { ok }（清空上下文）
//   PUT  /api/chat/mode    → { ok, mode }（ask = 改设置前先问；auto = 直接改，可撤销兜底）
//   PUT  /api/chat/provider→ { ok, provider }（'' = 自动路由；provider 不存在 400）
//
// 模型选择器的数据源 = GET /api/llm 的 providers 里 enabled 的那几个（显示「名字（模型 ID）」）。
//
// 会话持久在服务端：UI 不做 localStorage 缓存，进视图即重拉历史（刷新页面同理）。
// 助手回复按 **markdown** 渲染（js/markdown.js 的零依赖安全子集）；用户消息保持纯文本。
// 工具调用行 = kimi 式：图标 + 中文操作名 + 关键参数，点击展开参数/结果明细；
// 一轮在途时（POST 可能几十秒）每 1.5s 轮询 history，把已落库的工具行增量画到「思考中」上方。
// 拉取时机 = 进入视图（app.js 的 switchView 调用）；不做常驻轮询——会话只在自己发消息时变。
import { api, toast, esc, ACTIONS, CHANGES, ddSetValue, onTableRefresh, dropdownHtml } from './core.js';
import { icon } from './icons.js';
import { renderMd } from './markdown.js';

// 写模式两态：输入盒工具条上的一枚双态胶囊，点击即切换；语义进 title（不占静态文案行）
const MODES = [
  { value: 'ask', label: '写前询问', ic: 'shield', tip: '写前询问：agent 改设置前先问你确认。点击切换到自动修改' },
  { value: 'auto', label: '自动修改', ic: 'bolt', tip: '自动修改：直接改，改动记进「变更历史」，可撤销兜底。点击切换到写前询问' },
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
// 进行中轮询（在途一轮的工具行增量展示）：POST 可能几十秒，期间每 1.5s 拉一次 history，
// 把 baseId 之后新落库的工具调用行画到「思考中」上方；POST 落定后停表、整列重渲。
// liveCalls 按 call id 去重；它只进「实时区」，不污染 messages 本体（loadSeq 守卫管不到这里）
let pollTimer = null;
let liveCalls = [];

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

// 一枚工具调用行（kimi 式）：扳手图标 + 中文操作名 + 关键参数 + chevron；点击展开
// 「参数 / 结果」明细。失败行红字标记。展开态是 DOM class，重渲即折叠（接受）
function chatCallHtml(c) {
  return `<div class="chat-call${c.ok === false ? ' err' : ''}">` +
    `<button class="chat-call-head" type="button" data-action="chat-call-toggle">` +
    icon('wrench') +
    `<span class="chat-call-title">${esc(c.title || c.name)}</span>` +
    (c.target ? `<span class="chat-call-target">${esc(c.target)}</span>` : '') +
    (c.ok === false ? '<span class="chat-call-fail">失败</span>' : '') +
    `<span class="chat-call-chev">${icon('chevron-down')}</span></button>` +
    `<div class="chat-call-detail">` +
    (c.args ? `<div class="chat-call-sec"><b>参数</b><pre>${esc(c.args)}</pre></div>` : '') +
    `<div class="chat-call-sec"><b>结果</b><pre>${esc(c.output || '')}</pre></div>` +
    `</div></div>`;
}
ACTIONS['chat-call-toggle'] = function (el) {
  const row = el.closest('.chat-call');
  if (row) row.classList.toggle('open');
};

// 一条消息：codex 式——助手是无气泡底的整栏内容（正文按 markdown 渲染），用户靠右一枚
// 浅灰圆角泡；助手携带的工具调用行排在正文上方；下方小字 = 归属（助手才有模型名，读该条
// **持久化**的 provider——不是全局当前值，换模型后历史气泡仍标着当时的模型）+ 时间。
// 中间轮（content 为空、只有 calls）只渲染工具行，不出空气泡与 meta
function msgHtml(m) {
  const me = m.role === 'user';
  const at = clock(m.at);
  const prov = !me && m.provider ? String(m.provider) : '';
  const meta = (prov || at) && String(m.content || '').trim() !== ''
    ? `<div class="chat-meta" title="${esc(fullTime(m.at) || '')}">` +
      (prov ? `<span class="chat-prov">${esc(prov)}</span>` : '') +
      (prov && at ? '<span class="chat-meta-dot">·</span>' : '') +
      (at ? `<span>${esc(at)}</span>` : '') + '</div>'
    : '';
  if (me) {
    return `<div class="chat-msg me"><div class="chat-bubble">${esc(m.content)}</div>${meta}</div>`;
  }
  const calls = Array.isArray(m.calls) ? m.calls : [];
  const callsHtml = calls.length
    ? `<div class="chat-calls">${calls.map(chatCallHtml).join('')}</div>` : '';
  const body = String(m.content || '').trim() !== ''
    ? `<div class="chat-bubble chat-md">${renderMd(m.content)}</div>` : '';
  return `<div class="chat-msg ai">${callsHtml}${body}${meta}</div>`;
}

// 在途态：助手侧一枚「思考中」气泡（真实一轮可能是多轮 LLM + 工具调用，等几十秒是常态）；
// 上方是轮询到的已执行工具行（实时区），一轮落定后由整列重渲接管
function liveHtml() {
  if (!liveCalls.length) return '';
  return `<div class="chat-msg ai"><div class="chat-calls">${liveCalls.map(chatCallHtml).join('')}</div></div>`;
}

function pendingHtml() {
  return '<div class="chat-msg ai"><div class="chat-bubble chat-thinking">思考中<i></i><i></i><i></i></div></div>';
}

function startLivePoll(baseId) {
  stopLivePoll();
  liveCalls = [];
  pollTimer = setInterval(function () {
    api('/api/chat/history').then(function (j) {
      const msgs = Array.isArray(j.messages) ? j.messages : [];
      let added = false;
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (!(m.id > baseId) || m.role !== 'assistant' || !Array.isArray(m.calls)) continue;
        for (let k = 0; k < m.calls.length; k++) {
          const c = m.calls[k];
          if (liveCalls.some(function (x) { return x.id === c.id; })) continue;
          liveCalls.push(c);
          added = true;
        }
      }
      if (added) render();
    }).catch(function () { /* 轮询失败下轮再来，不影响在途 POST */ });
  }, 1500);
}

function stopLivePoll() {
  if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
  liveCalls = [];
}

// 空态 = codex 式居中 hero（爪印徽章 + 标题 + 一句引导）；加载失败退成一行浅字
function emptyHtml() {
  return '<div class="chat-empty">' +
    '<span class="chat-hero-logo">' + icon('paw') + '</span>' +
    '<b class="chat-hero-title">DD-claw Agent</b>' +
    '<span class="chat-hero-sub">问当前状态，或直接说想改什么设置</span></div>';
}

function render() {
  const host = document.getElementById('chat-msgs');
  const scroller = document.getElementById('chat-list');
  if (!host) return;
  if (listError) {
    host.innerHTML = `<div class="chat-empty chat-empty-err">${esc(listError)}</div>`;
  } else if (!messages.length) {
    host.innerHTML = emptyHtml();
  } else {
    host.innerHTML = messages.map(msgHtml).join('') + (busy ? liveHtml() + pendingHtml() : '');
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

// 写模式胶囊：一枚按钮呈现当前态（盾牌 = 写前询问 / 闪电 = 自动修改，后者琥珀色强调放权），
// 点击即切到另一态——先打服务端的账，成功才换皮（不留「看着切了其实没切」）
function renderMode() {
  const chip = document.getElementById('chat-mode-chip');
  if (!chip) return;
  const m = mode === 'auto' ? MODES[1] : MODES[0];
  chip.classList.toggle('auto', mode === 'auto');
  chip.innerHTML = icon(m.ic) + '<span>' + esc(m.label) + '</span>';
  chip.title = m.tip;
}

// ---- 模型选择器：选项 = 「自动路由」 + 各启用供应商（名字（模型 ID））----
// 选定的模型已被停用/删除时，把它作为一条划线选项补在末尾——绝不静默显示成「自动路由」
// （视觉上按当前值显示，提交时服务端会给出真实错误）
function providerOptions() {
  const opts = [{ value: '', label: '自动路由' }];
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    opts.push({ value: p.id, label: p.name + (p.model ? '（' + p.model + '）' : '') });
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
    const selected = providers.find(function (p) { return p.id === curProvider; });
    toast(curProvider ? '已切换到 ' + (selected ? selected.name : curProvider) : '已切回自动路由');
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
  resetComposer(ta);
  listError = null;
  loadSeq += 1;   // 在途的 history 响应从此作废（旧快照里没有这条消息，照收会把它抹掉）
  // 轮询增量的基准：只认本条消息之后落库的行（本地 user 气泡没有 id，不影响取 max）
  let baseId = 0;
  for (let i = 0; i < messages.length; i++) if (messages[i].id > baseId) baseId = messages[i].id;
  messages.push({ role: 'user', content: text, at: Date.now() / 1000 });
  setBusy(true);
  render();
  startLivePoll(baseId);
  api('/api/chat', 'POST', { message: text }).then(function (j) {
    stopLivePoll();
    setBusy(false);
    // provider = 这条回复实际由谁提供（服务端持久化，用于气泡归属小字）；
    // calls = 本轮工具调用明细（服务端返回全量，实时区那几枚由它接替定格）
    messages.push({
      role: 'assistant', content: String(j.reply || ''), at: Date.now() / 1000,
      provider: j.provider || null, calls: Array.isArray(j.calls) ? j.calls : [],
    });
    if (j.usage) usage = j.usage;
    render();
    ta.focus();
  }).catch(function (e) {
    stopLivePoll();
    setBusy(false);
    // 失败照原样 toast（LLM 未配 400 / 调用失败 502 等文案由服务端给）；
    // 已渲染的用户气泡不静默删掉——不发消息是用户的决定。
    // 实时区停表后对齐一次服务端真实历史（在途期间落库的工具行/半截轮次以服务端为准）
    toast(e.message, true);
    loadChat();
    ta.focus();
  });
}
ACTIONS['chat-send'] = function () { send(); };

// 多行输入：Enter 发送 / Shift+Enter 换行。输入法组字中的 Enter 是「选词」不能当发送：
// isComposing 是标准判据，keyCode 229 是 Safari 事件乱序（compositionend 先到）的兜底，
// 两者并列是 UI 最佳实践给出的推荐写法（只对 Enter 生效，不影响移动端键盘布局输入）
// 输入框随内容自动长高（codex 式：单行起步、上限 200px，超出内部滚）
(function () {
  const ta = document.getElementById('chat-input');
  if (!ta) return;
  ta.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    send();
  });
  ta.addEventListener('input', function () {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  });
})();

// 发出后清空并收回单行高度
function resetComposer(ta) {
  ta.value = '';
  ta.style.height = 'auto';
}

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

// 写模式双态切换：点击切到另一态（乐观不动皮——PUT 成功才 renderMode，失败只 toast）
ACTIONS['chat-mode-toggle'] = function () {
  const next = mode === 'auto' ? 'ask' : 'auto';
  api('/api/chat/mode', 'PUT', { mode: next }).then(function (j) {
    mode = j.mode === 'auto' ? 'auto' : 'ask';
    modeEpoch += 1;   // 在途的 history 响应里是改之前的 mode，别让它把胶囊拽回去
    renderMode();
  }).catch(function (e) { toast(e.message, true); });
};

// 撤销改了 LLM 供应商（settings 表）后，模型选择器的选项也要回到真实态——重拉一次历史与清单
onTableRefresh(['settings'], loadChat);