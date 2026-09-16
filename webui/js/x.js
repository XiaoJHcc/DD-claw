// 面板前端 · X / 推特 分页（独立于 B站/微博的开播链路）。
// 卡片1「连接」：代理 / Nitter 实例 / 免登录回退 + 一键测试；
// 卡片2「监听」：监听开关 / 抓取间隔 / 数据来源与最近一轮；
// 卡片3「关注账号」：X 独立名单（不要求对应 B站主播，关联主播只是可选）。
// 纪律：GET 只读后端快照（后端绝不在读取路径打网络），探测一律由「测试」显式触发；
// 「测试」允许用输入框里还没保存的值（先测后存），否则用户得先存一个错配置才知道它错。
import { api, toast, ACTIONS, CHANGES, esc, field, checkRowHtml, dropdownHtml, openSheet, closeSheet, switchHtml, iconBtn } from './core.js';

let xState = null;
let listenState = null;
let accountCache = [];
let streamerCache = [];
let testing = false;

function stateRows() {
  const s = xState || {};
  return { cfg: s.config || {}, st: s.status || {} };
}

function dotFor(tested, ok) {
  return `<span class="dot ${!tested ? 'none' : ok ? 'ok' : 'bad'}"></span>`;
}

function rowHtml(dot, title, sub) {
  return '<div class="row row-2">' + dot +
    '<span class="row-main"><span class="row-line"><span class="row-title">' + esc(title) + '</span></span>' +
    '<span class="row-sub">' + esc(sub) + '</span></span></div>';
}

function fmtTime(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 加载：一次取连接快照 + 监听开关 + 账号名单 + 主播列表（关联主播下拉用） */
function loadX() {
  return Promise.all([
    api('/api/x'), api('/api/listen'), api('/api/x/accounts'), api('/api/streamers'),
  ]).then(function (rs) {
    xState = rs[0];
    listenState = rs[1];
    accountCache = rs[2].accounts || [];
    streamerCache = rs[3].streamers || [];
    renderConn();
    renderListen();
    renderAccounts();
  }).catch(function (e) { toast(e.message, true); });
}

function renderConn() {
  const { cfg, st } = stateRows();
  const proxy = st.proxy || {};
  const inst = st.instances || [];
  const okInst = inst.filter(function (i) { return i.ok; }).length;
  const instSub = (cfg.instances && cfg.instances.length)
    ? cfg.instances.join(', ') + (inst.length ? ' · ' + okInst + '/' + inst.length + ' 可用' : ' · 未测试')
    : '未配置（只剩免登录回退路线）';
  const conn = document.getElementById('x-conn-rows');
  if (!conn) return;
  conn.innerHTML = [
    rowHtml(dotFor(proxy.checkedAt, proxy.ok), '代理', (cfg.proxyUrl || '未配置') + ' · ' + (proxy.message || '尚未测试')),
    rowHtml(dotFor(inst.length > 0, okInst > 0), 'Nitter 实例', instSub),
    rowHtml('', '免登录回退', cfg.fallbackHtml ? '已开启（Nitter 全挂时用 x.com HTML）' : '已关闭'),
  ].join('');
}

function renderListen() {
  const { cfg, st } = stateRows();
  const feed = st.feed || {};
  const row = listenState && listenState.rows ? listenState.rows.twitter : null;
  const box = document.getElementById('x-listen-rows');
  if (!box) return;
  const viaText = feed.via === 'nitter' ? 'Nitter ' + (feed.host || '')
    : feed.via === 'web' ? '免登录回退' : '—';
  const runText = feed.accounts
    ? `${feed.okAccounts}/${feed.accounts} 个账号成功 · 数据来自 ${viaText}`
    : (feed.running ? '尚未跑完第一轮' : '源未运行');
  box.innerHTML = [
    '<div class="row"><span class="row-main"><span class="row-line"><span class="row-title">监听推特</span>' +
      '<span class="row-sub">' + (cfg.proxyUrl ? '代理已配置' : '先配置代理才会运行') + '</span></span></span>' +
      '<span class="row-end">' + switchHtml('data-change="toggle-x-listen"', row ? row.enabled : false) + '</span></div>',
    rowHtml(dotFor(feed.lastRunAt, feed.okAccounts > 0), '数据来源', runText),
    rowHtml('', '抓取间隔', (cfg.intervalSec || '—') + ' 秒'),
    rowHtml('', '最近一轮', (feed.lastRunAt ? fmtTime(feed.lastRunAt) : '尚未运行') +
      (feed.lastOkAt ? ' · 上次成功 ' + fmtTime(feed.lastOkAt) : '')),
    ...(feed.lastError ? [rowHtml('<span class="dot bad"></span>', '最近错误', feed.lastError)] : []),
  ].join('');
}

function streamerName(uid) {
  for (let i = 0; i < streamerCache.length; i++) {
    if (String(streamerCache[i].uid) === String(uid)) {
      return streamerCache[i].alias || streamerCache[i].uname || String(uid);
    }
  }
  return 'UID ' + uid;
}

function renderAccounts() {
  const box = document.getElementById('x-account-rows');
  if (!box) return;
  if (accountCache.length === 0) {
    box.innerHTML = '<p class="hint">名单为空——添加 X 账号后，新推文会按「图文帖规则」推送</p>';
    return;
  }
  box.innerHTML = accountCache.map(function (a) {
    const sub = (a.lastTweetAt ? '最近推文 ' + fmtTime(a.lastTweetAt) : '还没抓到推文') +
      (a.biliUid ? ' · 关联 ' + streamerName(a.biliUid) : '') +
      (a.lastOkAt ? '' : ' · 尚未成功抓取');
    return '<div class="row row-2" data-sid="' + a.id + '">' +
      '<span class="dot ' + (a.enabled ? (a.lastOkAt ? 'ok' : 'none') : 'none') + '"></span>' +
      '<span class="row-main"><span class="row-line"><span class="row-title">@' + esc(a.screenName) + '</span></span>' +
      '<span class="row-sub">' + esc(sub) + '</span></span>' +
      '<span class="row-end">' +
      iconBtn('edit-x-account', 'pencil', '编辑') +
      iconBtn('del-x-account', 'trash', '删除', true) +
      '</span></div>';
  }).join('');
}

// ---- 监听开关（复用 listen_<feature> 机制；X 的 auto 判据是「代理已配置」）----
CHANGES['toggle-x-listen'] = function (el) {
  const on = el.checked;
  api('/api/listen/twitter', 'PUT', { enabled: on }).then(function () {
    toast(on ? '已开启' : '已关闭');
    loadX();
  }).catch(function (e) { toast(e.message, true); loadX(); });
};

// ---- 测试结果就地渲染（sheet 内）----
function renderTestOut(title, lines) {
  const box = document.getElementById('x-test-out');
  if (!box) return;
  box.innerHTML = '<div class="adv-group">' + esc(title) + '</div>' +
    lines.map(function (l) {
      return '<div class="row"><span class="dot ' + (l.ok ? 'ok' : 'bad') + '"></span>' +
        '<span class="row-main"><span class="row-line"><span class="row-title">' + esc(l.label) + '</span></span>' +
        '<span class="row-sub">' + esc(l.message) + '</span></span></div>';
    }).join('');
}

function readSheetInputs() {
  const val = function (id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
  };
  return {
    proxyUrl: val('xs-proxy'),
    instances: val('xs-inst'),
    intervalSec: parseInt(val('xs-interval'), 10),
    fallbackHtml: document.getElementById('xs-fallback').checked,
  };
}

function runTest(target, label) {
  if (testing) return;
  testing = true;
  const box = document.getElementById('x-test-out');
  if (box) box.innerHTML = '<div class="adv-group">' + esc(label) + '…</div>';
  const inp = readSheetInputs();
  api('/api/x/test', 'POST', {
    target: target,
    proxyUrl: inp.proxyUrl,
    instances: inp.instances,
  }).then(function (r) {
    const lines = [];
    if (r.proxy) lines.push({ ok: r.proxy.ok, label: '代理', message: r.proxy.message });
    if (r.instances) {
      r.instances.forEach(function (i) {
        lines.push({ ok: i.ok, label: i.host, message: i.message });
      });
      if (r.instances.length === 0) lines.push({ ok: false, label: '实例', message: '列表为空' });
    }
    if (r.web) lines.push({ ok: r.web.ok, label: '免登录 @' + r.web.screenName, message: r.web.message });
    // 测的是没保存的输入值时，明说卡片状态不会跟着变（否则用户会以为按钮没生效）
    const { cfg } = stateRows();
    const adhoc = inp.proxyUrl !== ((cfg && cfg.proxyUrl) || '')
      || inp.instances !== ((cfg && cfg.instances) || []).join(',');
    renderTestOut(label + '结果' + (adhoc ? '（未保存的输入值 · 卡片状态不变）' : ''), lines);
    loadX(); // 状态快照已在后端更新，重取即可（不在前端维护第二份状态）
  }).catch(function (e) {
    const box2 = document.getElementById('x-test-out');
    if (box2) box2.innerHTML = '<div class="form-err">' + esc(e.message) + '</div>';
  }).then(function () { testing = false; });
}

ACTIONS['open-x-settings'] = function () {
  const { cfg } = stateRows();
  openSheet('X 源设置',
    field('HTTP 代理', `<input class="inp" id="xs-proxy" placeholder="http://127.0.0.1:7890（留空 = 不用代理）" value="${esc(cfg.proxyUrl || '')}">`) +
    field('Nitter 实例（逗号分隔）', `<input class="inp" id="xs-inst" placeholder="nitter.jaydenha.uk,x.n0g.xyz" value="${esc((cfg.instances || []).join(','))}">`) +
    field('抓取间隔（秒，120~86400）', `<input class="inp" type="number" id="xs-interval" value="${esc(String(cfg.intervalSec || 300))}">`) +
    field('回退路线', checkRowHtml('id="xs-fallback"', cfg.fallbackHtml !== false, 'Nitter 全挂时用免登录 x.com HTML')) +
    '<div id="x-test-out"></div>' +
    '<div class="add-row">' +
    '<button class="btn btn-line" data-action="test-x-proxy">测试代理</button>' +
    '<button class="btn btn-line" data-action="test-x-instances">测试实例</button>' +
    '</div>',
    1,
    '<span id="xs-err" class="form-err"></span>' +
    '<button class="btn" data-action="close-sheet" data-level="1">取消</button>' +
    '<button class="btn btn-primary" data-action="save-x-settings">保存</button>');
};

// 「先测后存」：保存前先把当前输入框的代理与实例跑一遍，结果落在按钮下方
ACTIONS['test-x-proxy'] = function () { runTest('proxy', '代理'); };
ACTIONS['test-x-instances'] = function () { runTest('instances', '实例'); };

ACTIONS['test-x-all'] = function () {
  if (testing) return;
  testing = true;
  api('/api/x/test', 'POST', { target: 'all' }).then(function (r) {
    const okInst = (r.instances || []).filter(function (i) { return i.ok; }).length;
    const usable = r.proxy && r.proxy.ok && (okInst > 0 || (r.web && r.web.ok));
    toast(usable
      ? '链路可用：' + (okInst > 0 ? okInst + ' 个实例' : '免登录回退') + '可用'
      : '链路不可用：' + ((r.proxy && r.proxy.message) || '见 X 源设置'), !usable);
    loadX();
  }).catch(function (e) { toast(e.message, true); }).then(function () { testing = false; });
};

ACTIONS['save-x-settings'] = function () {
  const err = document.getElementById('xs-err');
  if (err) err.textContent = '';
  const inp = readSheetInputs();
  if (!Number.isInteger(inp.intervalSec)) {
    if (err) err.textContent = '抓取间隔请填整数';
    return;
  }
  api('/api/x', 'PUT', inp).then(function () {
    closeSheet(1);
    toast('已保存');
    loadX();
  }).catch(function (e) { if (err) err.textContent = e.message; });
};

// ---- 关注账号：新增 / 编辑 / 删除 ----
function accountById(id) {
  for (let i = 0; i < accountCache.length; i++) if (String(accountCache[i].id) === String(id)) return accountCache[i];
  return null;
}

ACTIONS['add-x-account'] = function () { openAccountSheet(null); };
ACTIONS['edit-x-account'] = function (el) {
  openAccountSheet(accountById(el.closest('.row').getAttribute('data-sid')));
};

function openAccountSheet(a) {
  const opts = streamerCache.map(function (s) {
    return { value: String(s.uid), label: s.alias || s.uname || String(s.uid) };
  });
  openSheet(a ? '编辑 X 账号' : '添加 X 账号',
    field('X 账号', `<input class="inp" id="xa-name" placeholder="@Watase_Yuzuki（@ 可省）" value="${a ? esc(a.screenName) : ''}">`) +
    field('关联主播（可选）', dropdownHtml('xa-bili', [{ value: '', label: '不关联' }].concat(opts), a && a.biliUid ? String(a.biliUid) : '')) +
    '<p class="hint">X 账号是独立名单，不要求它对应某位 B站主播；关联只是为了让推送文案和列表更好认。</p>' +
    '<div id="xa-out"></div>',
    1,
    '<span id="xa-err" class="form-err"></span>' +
    '<button class="btn" data-action="close-sheet" data-level="1">取消</button>' +
    `<button class="btn btn-primary" data-action="save-x-account" data-id="${a ? a.id : ''}">保存</button>`);
}

ACTIONS['save-x-account'] = function (el) {
  const err = document.getElementById('xa-err');
  if (err) err.textContent = '';
  const name = document.getElementById('xa-name').value.trim();
  if (!name) { if (err) err.textContent = '请填 X 账号'; return; }
  const biliVal = document.getElementById('xa-bili').value;
  const body = { screenName: name, biliUid: biliVal === '' ? null : biliVal };
  const idAttr = el.getAttribute('data-id');
  const req = idAttr ? api('/api/x/accounts/' + idAttr, 'PUT', body) : api('/api/x/accounts', 'POST', body);
  req.then(function (r) {
    closeSheet(1);
    // 校验结果分三类：存在 / 账号不存在（已被后端 400 拦下）/ 链路不通（照收但要提示）
    if (!idAttr && r.verify && r.verify.checked && !r.verify.ok) {
      toast('已添加，但未能校验：' + r.verify.message, true);
    } else {
      toast(idAttr ? '已保存' : '已添加');
    }
    loadX();
  }).catch(function (e) {
    const box = document.getElementById('xa-out');
    if (box) box.innerHTML = '';
    if (err) err.textContent = e.message;
  });
};

ACTIONS['del-x-account'] = function (el) {
  const row = el.closest('.row');
  const a = accountById(row.getAttribute('data-sid'));
  if (!a) return;
  if (!confirm('从 X 名单里移除 @' + a.screenName + '？已归档的推文保留。')) return;
  api('/api/x/accounts/' + a.id, 'DELETE').then(function () {
    toast('已移除');
    loadX();
  }).catch(function (e) { toast(e.message, true); });
};

loadX();
setInterval(loadX, 60000);