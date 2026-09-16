// 面板前端 · X / 推特 分页（独立于 B站/微博的开播链路）。
// 卡片1「连接」：代理 / Nitter 实例 / 免登录回退 + 一键测试；
// 卡片2「监听」：抓取间隔 / 链路状态。
// P0 只有连接与探测——X 源（抓取、关注账号、图文帖规则）在 P1/P2 接进来。
// 纪律：GET /api/x 只读后端快照（后端绝不在读取路径打网络），探测一律由「测试」显式触发；
// 「测试」允许用输入框里还没保存的值（先测后存），否则用户得先存一个错配置才知道它错。
import { api, toast, ACTIONS, CHANGES, esc, field, checkRowHtml, openSheet, closeSheet } from './core.js';

let xState = null;
let testing = false;

function stateRows() {
  const s = xState || {};
  const cfg = s.config || {};
  const st = s.status || {};
  return { cfg, st };
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

function loadX() {
  return api('/api/x').then(function (s) {
    xState = s;
    const { cfg, st } = stateRows();
    const proxy = st.proxy || {};
    const inst = st.instances || [];
    const okInst = inst.filter(function (i) { return i.ok; }).length;
    const instSub = (cfg.instances && cfg.instances.length)
      ? cfg.instances.join(', ') + (inst.length ? ' · ' + okInst + '/' + inst.length + ' 可用' : ' · 未测试')
      : '未配置（只剩免登录回退路线）';
    const conn = document.getElementById('x-conn-rows');
    if (conn) {
      conn.innerHTML = [
        rowHtml(dotFor(proxy.checkedAt, proxy.ok), '代理', (cfg.proxyUrl || '未配置') + ' · ' + (proxy.message || '尚未测试')),
        rowHtml(dotFor(inst.length > 0, okInst > 0), 'Nitter 实例', instSub),
        rowHtml('', '免登录回退', cfg.fallbackHtml ? '已开启（Nitter 全挂时用 x.com HTML）' : '已关闭'),
      ].join('');
    }
    const listen = document.getElementById('x-listen-rows');
    if (listen) {
      const web = st.web || {};
      const stale = st.updatedAt ? '上次测试 ' + fmtTime(st.updatedAt) : '尚未测试';
      listen.innerHTML = [
        rowHtml('', '抓取间隔', (cfg.intervalSec || '—') + ' 秒'),
        rowHtml(dotFor(web.checkedAt, web.ok), '免登录路线', web.message || '尚未测试'),
        rowHtml('', '链路状态', stale),
      ].join('');
    }
  }).catch(function (e) { toast(e.message, true); });
}

// 测试结果就地渲染（sheet 内）：一行一个目标，成功/失败都写出可读原因
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

loadX();
setInterval(loadX, 60000);