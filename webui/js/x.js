// 面板前端 · 图文分页（X / 推特 + 微博；图文监听与直播监听是两种输入，共用推送渠道）。
// 上半 = 两张设置卡：监听开关都在卡片头右上角（一卡一开关，同 NapCat/LLM/推送渠道卡形态）。
// X 卡行区只显示连接可达性（出问题才多一行监听诊断）；代理/实例/间隔/回退全部收进「源设置」
// 二级弹窗，测试按钮是控件右侧的方 icon——结果并入按钮自身：转圈 → 绿勾/红叉，原因进 hover
// 提示，不往弹窗里插文字块、不动布局。微博卡 = 登录态行（扫码弹窗复用 listen.js，
// 抓取间隔收进「抓取设置」弹窗）——**这张卡保持原样，不加监听/抓取行**。
// 下半 = **单墙混排的账号卡片墙**（两个平台的账号在同一张网格里，顶部大 segnav 切换「全部 / X / 微博」，
// 右端圆形按钮添加账号——与 segnav 同高呼应；卡面带平台角标——两张名单的自增 id 会撞，
// 规则又按平台分流，用户必须一眼看出规则落在哪）：
// 卡面纯展示 = 身份段 + 规则摘要行 + 帖子段，整卡可点，账号字段与规则增删改全在点击后的浮窗
// （添加浮窗顶部小 segnav 切 X/微博，表单随之切换；微博「昵称 / uid」并排，失焦即解析回填另一个），
// 规则编辑开二级浮窗（规则带平台，从哪张卡进就是哪个平台）。
// 纪律：GET 只读后端快照（后端绝不在读取路径打网络），探测一律由弹窗里的测试 icon 显式触发；
// 测试允许用输入框里还没保存的值（先测后存），未保存值的结果只动按钮、不污染卡片状态。
import { api, toast, ACTIONS, CHANGES, INPUTS, esc, field, checkRowHtml, dropdownHtml, openSheet, closeSheet, sheetCleanups, switchHtml, iconBtn, checkDotHtml, avatarHtml, relTime, ruleDeadReason, segnavHtml, layoutSegnav, segnavSelect } from './core.js';
import { icon } from './icons.js';
import { openPlatformLogin, PLAT_STATE, setLoginConfirmedHook } from './listen.js';

let xState = null;
let listenState = null;
let accountCache = [];
let weiboAccountCache = [];
let streamerCache = [];
let postRuleCache = [];
let channelCache = [];
let testing = false;
/** 账号墙的平台筛选：'all' | 'twitter' | 'weibo' */
let platFilter = 'all';
/** 规则表单草稿（保存时才落库）：scope 固定为开弹窗的那张卡（存量全部/多账号规则保留原 scope） */
let ruleDraft = null;

function stateRows() {
  const s = xState || {};
  return { cfg: s.config || {}, st: s.status || {} };
}

function rowHtml(dot, title, sub) {
  return '<div class="row row-2">' + dot +
    '<span class="row-main"><span class="row-line"><span class="row-title">' + esc(title) + '</span></span>' +
    '<span class="row-sub">' + esc(sub) + '</span></span></div>';
}

/** 加载：连接快照 + 监听开关 + 两份账号名单 + 主播列表 + 渠道 + 图文帖规则 */
function loadX() {
  return Promise.all([
    api('/api/x'), api('/api/listen'), api('/api/x/accounts'),
    api('/api/post-rules'), api('/api/channels'), api('/api/streamers'),
    api('/api/weibo/accounts'),
  ]).then(function (rs) {
    xState = rs[0];
    listenState = rs[1];
    accountCache = rs[2].accounts || [];
    postRuleCache = rs[3].rules || [];
    channelCache = rs[4].channels || [];
    streamerCache = rs[5].streamers || [];
    weiboAccountCache = rs[6].accounts || [];
    renderXStatus();
    renderWeibo();
    renderFilter();
    renderAccounts();
  }).catch(function (e) { toast(e.message, true); });
}

// ---- X 状态卡：面板只两行（连接可达性 + 监听开关），其余全部收进源设置弹窗 ----
// 口径：抓取本身是最强的连通性证据——最近一轮抓成功就是「可用」，比手动探测更真；
// 进程重启后内存快照清零，回退到账号持久的 lastOkAt（上轮成功过的证据），
// 都不行才看手动探测快照。于是监听开着时卡片永远是真实状态，不会每次打开全灰。
function connState() {
  const { cfg, st } = stateRows();
  const feed = st.feed || {};
  // ⓪ 前提不存在：没配代理源根本不会跑，历史证据不算数
  if (!cfg.proxyUrl) return ['none', '未配置代理'];
  const nowSec = Date.now() / 1000;
  const freshSec = 2 * (cfg.intervalSec || 300) + 60;
  // ① 本轮进程抓成功且新鲜（两个间隔内）→ 可用，路线直接拿 feed 的
  if (feed.lastOkAt && nowSec - feed.lastOkAt < freshSec) {
    return ['ok', '可用 · ' + (feed.via === 'web' ? '免登录回退' : 'Nitter')];
  }
  // ② 最近一轮有报错 → 不可用（原因在下方的监听诊断行）
  if (feed.lastError) return ['bad', '不可用'];
  // ③ 重启后内存快照清零：账号的持久 lastOkAt 证明上轮成功过
  const accOk = accountCache.some(function (a) { return a.enabled && a.lastOkAt; });
  if (accOk) return ['ok', '可用'];
  // ④ 手动探测快照（重启且从没抓成功过的场景）
  const inst = st.instances || [];
  if (inst.some(function (i) { return i.ok; })) return ['ok', '可用 · Nitter'];
  if (st.web && st.web.ok) return ['ok', '可用 · 免登录回退'];
  const msg = (st.proxy && st.proxy.message) || '';
  if (msg && msg !== '尚未测试') return ['bad', msg]; // 失败原因或「配置已改，请重新测试」
  if (inst.length > 0) return ['bad', '不可用'];
  // ⑤ 源在跑但首轮还没出结果：瞬时态，不是「未测试」
  if (feed.running) return ['none', '首轮抓取中…'];
  return ['none', '未测试'];
}

function renderXStatus() {
  const { st } = stateRows();
  const feed = st.feed || {};
  const row = listenState && listenState.rows ? listenState.rows.twitter : null;
  const box = document.getElementById('x-status-rows');
  if (!box) return;
  // 监听开关在卡片头（静态 markup），这里只同步勾选态
  const sw = document.getElementById('x-listen-enabled');
  if (sw) sw.checked = !!(row && row.enabled);
  const [dot, sub] = connState();
  // 诊断行只在出问题时出现：轮询最近报错说原因（代理未配置已由连接行说明）
  const diag = feed.lastError ? '最近错误：' + feed.lastError : '';
  box.innerHTML = rowHtml('<span class="dot ' + dot + '"></span>', '连接', sub) +
    (diag ? rowHtml('<span class="dot bad"></span>', '监听', diag) : '');
}

// ---- 微博卡：登录态（整行可点 → 扫码弹窗）+ 监听开关 ----
// 这张卡保持原样：只有登录态一行。抓取运行状态不在这里显示（微博与 X 不同——它没有
// 代理/实例那套连接概念，卡片再加「监听」「抓取」行就与 X 卡不对称了）。
function weiboPlatform() {
  const ps = (listenState && listenState.platforms) || [];
  for (let i = 0; i < ps.length; i++) if (ps[i].key === 'weibo') return ps[i];
  return null;
}

function renderWeibo() {
  const box = document.getElementById('weibo-rows');
  if (!box || !listenState) return;
  const p = weiboPlatform();
  const st = (p && PLAT_STATE[p.state]) || ['none', '未登录'];
  const row = listenState.rows ? listenState.rows.weibo : null;
  // 监听开关在卡片头（静态 markup），这里只同步勾选态
  const sw = document.getElementById('weibo-listen-enabled');
  if (sw) sw.checked = !!(row && row.enabled);
  box.innerHTML =
    '<div class="row row-2 row-click" data-action="weibo-login">' +
      '<span class="dot ' + st[0] + '"></span>' +
      '<span class="row-main"><span class="row-line"><span class="row-title">登录态</span></span>' +
      '<span class="row-sub">' + esc(st[1]) + '</span></span>' +
      '<span class="row-end"><span class="row-afford">' + icon('qrcode') + '</span></span></div>';
}

ACTIONS['weibo-login'] = function () { openPlatformLogin('weibo', weiboPlatform()); };
setLoginConfirmedHook(function () { loadX(); });

CHANGES['toggle-weibo-listen'] = function (el) {
  const on = el.checked;
  api('/api/listen/weibo', 'PUT', { enabled: on }).then(function () {
    toast(on ? '已开启' : '已关闭');
    loadX();
  }).catch(function (e) { toast(e.message, true); loadX(); });
};

// ---- 监听开关（复用 listen_<feature> 机制；X 的 auto 判据是「代理已配置」）----
CHANGES['toggle-x-listen'] = function (el) {
  const on = el.checked;
  api('/api/listen/twitter', 'PUT', { enabled: on }).then(function () {
    toast(on ? '已开启' : '已关闭');
    loadX();
  }).catch(function (e) { toast(e.message, true); loadX(); });
};

// ---- 源设置弹窗：代理/实例输入框 + 间隔 + 回退开关，每个可测项右侧一枚方 icon 测试钮 ----
// 测试结果并入按钮自身：转圈 → 绿勾/红叉，逐条原因进按钮 hover 提示（title 支持换行）；
// 不往弹窗里插结果文字块——插入即布局跳动，违反「不乱蹦」纪律。输入框再改动时按钮复位。
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

function testBtn(action) {
  return document.querySelector('.sheet .icon-btn[data-action="' + action + '"]');
}

function resetTestBtn(btn) {
  if (!btn) return;
  btn.disabled = false;
  btn.classList.remove('testing', 'test-ok', 'test-bad');
  btn.innerHTML = icon('bolt');
}

/** 输入框再改动 → 同行测试钮复位（旧结论不能配着新输入值继续显示） */
INPUTS['x-test-dirty'] = function (el) {
  const row = el.closest('.field-inline');
  const btn = row && row.querySelector('.icon-btn');
  if (btn) { resetTestBtn(btn); btn.title = btn.getAttribute('data-tip') || ''; }
};

function runTest(target, action) {
  if (testing) return;
  testing = true;
  const btn = testBtn(action);
  if (btn) {
    btn.disabled = true;
    btn.classList.remove('test-ok', 'test-bad');
    btn.classList.add('testing');
  }
  const inp = readSheetInputs();
  api('/api/x/test', 'POST', {
    target: target,
    proxyUrl: inp.proxyUrl,
    instances: inp.instances,
  }).then(function (r) {
    const lines = [];
    if (r.proxy) lines.push({ ok: r.proxy.ok, text: r.proxy.message });
    if (r.instances) {
      r.instances.forEach(function (i) { lines.push({ ok: i.ok, text: i.host + '：' + i.message }); });
      if (r.instances.length === 0) lines.push({ ok: false, text: '实例列表为空' });
    }
    if (r.web) lines.push({ ok: r.web.ok, text: r.web.message });
    const ok = lines.length > 0 && lines.every(function (l) { return l.ok; });
    if (btn) {
      resetTestBtn(btn);
      btn.classList.add(ok ? 'test-ok' : 'test-bad');
      btn.innerHTML = icon(ok ? 'check' : 'xmark');
      btn.title = lines.map(function (l) { return l.text; }).join('\n');
    }
    loadX(); // 测的是已保存配置时快照已在后端更新，面板卡片重取即可
  }).catch(function (e) {
    if (btn) {
      resetTestBtn(btn);
      btn.classList.add('test-bad');
      btn.innerHTML = icon('xmark');
      btn.title = e.message;
    }
  }).then(function () { testing = false; });
}

ACTIONS['open-x-settings'] = function () {
  const { cfg } = stateRows();
  openSheet('X 源设置',
    field('HTTP 代理', '<div class="field-inline">' +
      `<input class="inp" id="xs-proxy" data-input="x-test-dirty" placeholder="http://127.0.0.1:7890（留空 = 不用代理）" value="${esc(cfg.proxyUrl || '')}">` +
      iconBtn('test-x-proxy', 'bolt', '测试代理') + '</div>') +
    field('Nitter 实例（逗号分隔）', '<div class="field-inline">' +
      `<input class="inp" id="xs-inst" data-input="x-test-dirty" placeholder="nitter.jaydenha.uk,x.n0g.xyz" value="${esc((cfg.instances || []).join(','))}">` +
      iconBtn('test-x-instances', 'bolt', '测试实例') + '</div>') +
    field('抓取间隔（秒，120~86400）', `<input class="inp" type="number" id="xs-interval" value="${esc(String(cfg.intervalSec || 300))}">`) +
    field('回退路线', '<div class="field-inline">' +
      checkRowHtml('id="xs-fallback"', cfg.fallbackHtml !== false, 'Nitter 全挂时用免登录 x.com HTML') +
      iconBtn('test-x-web', 'bolt', '测试回退路线') + '</div>'),
    1,
    '<span id="xs-err" class="form-err"></span>' +
    '<button class="btn" data-action="close-sheet" data-level="1">取消</button>' +
    '<button class="btn btn-primary" data-action="save-x-settings">保存</button>');
  // 默认 tip 存 data-tip：测试写 title 后，输入框改动复位时还能恢复原文案
  ['test-x-proxy', 'test-x-instances', 'test-x-web'].forEach(function (a) {
    const b = testBtn(a);
    if (b) b.setAttribute('data-tip', b.title);
  });
};

// 「先测后存」：测的就是当前输入框的值；结果只动按钮（已保存配置的测试会顺手更新面板快照）
ACTIONS['test-x-proxy'] = function () { runTest('proxy', 'test-x-proxy'); };
ACTIONS['test-x-instances'] = function () { runTest('instances', 'test-x-instances'); };
ACTIONS['test-x-web'] = function () { runTest('web', 'test-x-web'); };

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

// ---- 微博抓取设置（二级弹窗单字段；/api/advanced 是部分 patch）----
ACTIONS['open-weibo-settings'] = function () {
  api('/api/advanced').then(function (j) {
    openSheet('微博抓取设置',
      field('抓取间隔（秒，≥120）', `<input class="inp" type="number" id="wb-interval" value="${esc(String(j.weiboIntervalSec))}">`),
      1,
      '<span id="wb-err" class="form-err"></span>' +
      '<button class="btn" data-action="close-sheet" data-level="1">取消</button>' +
      '<button class="btn btn-primary" data-action="save-weibo-settings">保存</button>');
  }).catch(function (e) { toast(e.message, true); });
};

ACTIONS['save-weibo-settings'] = function () {
  const err = document.getElementById('wb-err');
  if (err) err.textContent = '';
  const v = parseInt(document.getElementById('wb-interval').value, 10);
  if (isNaN(v)) { if (err) err.textContent = '请输入整数'; return; }
  api('/api/advanced', 'PUT', { weiboIntervalSec: v }).then(function () {
    closeSheet(1);
    toast('已保存并生效');
  }).catch(function (e) { if (err) err.textContent = e.message; });
};

// ---- 账号卡片墙（单墙混排：X 与微博同一张网格，卡面带平台角标，顶部筛选胶囊）----
// 与主播列表同一套三段式卡片；推文段直接复用 .st-posts 结构与 hover 互斥展开。
function accountById(id, platform) {
  const list = platform === 'weibo' ? weiboAccountCache : accountCache;
  for (let i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i];
  return null;
}

/** 当前筛选下的账号（每一项带 platform，供卡片渲染与统计共用） */
function visibleAccounts() {
  const out = [];
  if (platFilter !== 'weibo') {
    accountCache.forEach(function (a) { out.push({ platform: 'twitter', a: a }); });
  }
  if (platFilter !== 'twitter') {
    weiboAccountCache.forEach(function (a) { out.push({ platform: 'weibo', a: a }); });
  }
  return out;
}

function renderFilter() {
  const box = document.getElementById('x-account-filter');
  if (!box) return;
  box.innerHTML = segnavHtml([
    { value: 'all', label: '全部 ' + (accountCache.length + weiboAccountCache.length) },
    { value: 'twitter', label: 'X ' + accountCache.length },
    { value: 'weibo', label: '微博 ' + weiboAccountCache.length },
  ], platFilter, 'lg', 'x-plat-filter');
  layoutSegnav(box.firstElementChild, false);
}

ACTIONS['x-plat-filter'] = function (el) {
  platFilter = el.getAttribute('data-value');
  segnavSelect(el.closest('.segnav'), platFilter);
  renderAccounts();
};

function channelName(id) {
  for (let i = 0; i < channelCache.length; i++) {
    if (String(channelCache[i].id) === String(id)) return channelCache[i].name;
  }
  return '渠道 ' + id;
}

/** 卡的规则 = 同平台、且 scope 含本账号的规则；「全部账号」（空）/ 多账号规则也显示，标出 scope */
function rulesFor(a, platform) {
  return postRuleCache.filter(function (r) {
    if (r.platform !== platform) return false;
    return r.accountIds.length === 0 || r.accountIds.map(String).indexOf(String(a.id)) >= 0;
  });
}

function filterSummary(f) {
  const kind = f.original && f.retweet ? '原创·转发' : f.retweet ? '转发' : '原创';
  const parts = [kind];
  if (f.media) parts.push('带图');
  if (f.quote) parts.push('引用');
  if (f.keywords && f.keywords.length) parts.push('词×' + f.keywords.length);
  return parts.join(' · ');
}

function llmSummary(r) {
  const parts = [];
  if (r.llmJudge) parts.push('LLM 判定');
  if (r.llmTranslate) parts.push('译文');
  return parts.length ? ' · ' + parts.join('+') : '';
}

function scopeSummary(r) {
  if (r.accountIds.length === 0) return ' · 全部账号';
  if (r.accountIds.length > 1) return ' · 多账号';
  return '';
}

function ruleSub(r) {
  const dead = ruleDeadReason(r, [], channelCache);
  return dead || (filterSummary(r.filters) +
    ' · ' + (r.channels.length ? r.channels.map(channelName).join('、') : '未选渠道') +
    llmSummary(r) + scopeSummary(r));
}

// 帖子行：与主播动态同一套结构（.st-post），streamers.js 的全局 hover 委托直接生效。
// 微博的「转发」在抓取层就折进 type='retweet'（正文带 //转发自 @原作者），标签语义一致。
function postRowHtml(p, open) {
  const [label, cls] = p.type === 'retweet' ? ['转发', 'tag-purple'] : ['原创', 'tag-blue'];
  const inner =
    (p.pics && p.pics[0] ? `<img class="pt-img" src="${esc(p.pics[0])}" referrerpolicy="no-referrer" alt="">` : '') +
    `<span class="pt-main"><span class="pt-head"><span class="tag ${cls}">${label}</span>` +
    `<small class="pt-tm">${p.pubTs ? relTime(p.pubTs) : ''}</small></span>` +
    `<span class="pt-x">${esc(p.text || '(无文字)')}</span></span>`;
  const clsAttr = `st-post${open ? ' open' : ''}`;
  return p.url
    ? `<a class="${clsAttr}" href="${esc(p.url)}" target="_blank" rel="noopener" data-action="noop">${inner}</a>`
    : `<div class="${clsAttr}">${inner}</div>`;
}

function rulesBlockHtml(a, platform) {
  const rules = rulesFor(a, platform);
  return '<div class="st-rules"><span class="rl-dot"></span><span class="rl-t">图文规则</span>' +
    (rules.length
      ? rules.map(function (r) {
          return `<span class="tag${ruleDeadReason(r, [], channelCache) ? ' rl-off' : ''}">${esc(r.name)}</span>`;
        }).join('')
      : '<span class="rl-none">未配置</span>') +
    '</div>';
}

// ---- X 账号卡：身份段（头像 + 显示名/昵称 + @ID）+ 规则摘要 + 推文段 ----
function xCardHtml(a) {
  const name = a.displayName || a.nickname || a.screenName;
  // 头像链：X 链路抓到的本地缓存 → 关联主播的 B站头像 → 首字占位圆（avatarHtml 加载失败也兜底成占位圆）
  const face = a.avatar
    ? '/api/x-avatar?file=' + encodeURIComponent(a.avatar)
    : (a.biliFace || '');
  const meta = '@' + a.screenName +
    (a.biliName ? ' · 关联 ' + a.biliName : '') +
    (a.lastTweetAt ? ' · 推文 ' + relTime(a.lastTweetAt) : '') +
    (a.enabled ? '' : ' · 已停用');
  const posts = (a.posts || []).slice(0, 3);
  return `<div class="st-card x-card${a.enabled ? '' : ' x-off'}" data-action="open-x-account" data-sid="${a.id}">
    <div class="st-mid">
      <div class="x-id-row">
        <div class="st-id">
          ${avatarHtml(face, name)}
          <div class="nm"><span class="x-plat-row"><span class="x-plat x-plat-x">X</span></span><b>${esc(name)}</b><small>${esc(meta)}</small></div>
        </div>
        ${switchHtml('data-change="toggle-x-account" title="抓取该账号的新推文"', a.enabled)}
      </div>
      ${rulesBlockHtml(a, 'twitter')}
    </div>
    <div class="st-posts">${
      posts.length
        ? posts.map(function (p, i) { return postRowHtml(p, i === 0); }).join('')
        : '<div class="st-posts-empty">还没有抓到推文</div>'
    }</div>
  </div>`;
}

// ---- 微博账号卡：身份段（头像 + 显示名/昵称 + uid）+ 规则摘要 + 微博段 ----
function weiboCardHtml(a) {
  const name = a.displayName || a.nickname || ('微博 ' + a.uid);
  // 头像链：微博链路抓到的本地缓存 → 关联主播的 B站头像 → 首字占位圆（与 X 卡同一条链）
  const face = a.avatar
    ? '/api/weibo-avatar?file=' + encodeURIComponent(a.avatar)
    : (a.biliFace || '');
  const meta = 'uid ' + a.uid +
    (a.biliName ? ' · 关联 ' + a.biliName : '') +
    (a.lastPostAt ? ' · 微博 ' + relTime(a.lastPostAt) : '') +
    (a.enabled ? '' : ' · 已停用');
  const posts = (a.posts || []).slice(0, 3);
  return `<div class="st-card x-card${a.enabled ? '' : ' x-off'}" data-action="open-weibo-account" data-sid="${a.id}">
    <div class="st-mid">
      <div class="x-id-row">
        <div class="st-id">
          ${avatarHtml(face, name)}
          <div class="nm"><span class="x-plat-row"><span class="x-plat x-plat-weibo">微博</span></span><b>${esc(name)}</b><small>${esc(meta)}</small></div>
        </div>
        ${switchHtml('data-change="toggle-weibo-account" title="抓取该账号的新微博"', a.enabled)}
      </div>
      ${rulesBlockHtml(a, 'weibo')}
    </div>
    <div class="st-posts">${
      posts.length
        ? posts.map(function (p, i) { return postRowHtml(p, i === 0); }).join('')
        : '<div class="st-posts-empty">还没有抓到微博</div>'
    }</div>
  </div>`;
}

function renderAccounts() {
  const box = document.getElementById('x-account-grid');
  if (!box) return;
  box.innerHTML = visibleAccounts().map(function (it) {
    return it.platform === 'weibo' ? weiboCardHtml(it.a) : xCardHtml(it.a);
  }).join('');
}

// ---- 账号浮窗（整卡点击打开）：字段编辑 + 本账号规则管理（规则编辑开二级浮窗）----
let sheetAccountId = null;
/** 当前浮窗的平台（'twitter' | 'weibo'）：规则的 scope 与平台都由它决定 */
let sheetPlatform = null;

function biliOptions() {
  return [{ value: '', label: '不关联' }].concat(streamerCache.map(function (s) {
    return { value: String(s.uid), label: s.alias || s.uname || String(s.uid) };
  }));
}

function rulesSectionHtml(a) {
  if (!a) return '';
  return '<div class="sheet-section"><div class="sheet-sub">图文规则</div>' +
    '<div id="xa-rules" class="sheet-rules"></div>' +
    `<button class="btn btn-ghost x-add-rule" data-action="add-post-rule">${icon('plus')}添加规则</button></div>`;
}

ACTIONS['add-feed-account'] = function () {
  // 默认平台跟随当前筛选：筛「微博」时打开就是微博表单，其余（全部/X）默认 X
  openAccountSheet(null, platFilter === 'weibo' ? 'weibo' : 'twitter');
};
ACTIONS['open-x-account'] = function (el, e) {
  // 卡面唯一的控件是右上角监听开关——点开关不触发整卡的「打开浮窗」
  if (e && e.target instanceof Element && e.target.closest('label, button')) return;
  openAccountSheet(accountById(el.getAttribute('data-sid'), 'twitter'), 'twitter');
};
ACTIONS['open-weibo-account'] = function (el, e) {
  if (e && e.target instanceof Element && e.target.closest('label, button')) return;
  openAccountSheet(accountById(el.getAttribute('data-sid'), 'weibo'), 'weibo');
};

// 卡片右上角的监听开关：即改即存（账号其余字段仍在浮窗里编辑）
function toggleAccount(platform, card, enabled) {
  const base = platform === 'weibo' ? '/api/weibo/accounts/' : '/api/x/accounts/';
  api(base + card.getAttribute('data-sid'), 'PUT', { enabled: enabled }).then(function () {
    toast(enabled ? '已开启' : '已停用');
    loadX();
  }).catch(function (e) { toast(e.message, true); loadX(); });
}

CHANGES['toggle-x-account'] = function (el) {
  const card = el.closest('.x-card');
  if (card) toggleAccount('twitter', card, el.checked);
};
CHANGES['toggle-weibo-account'] = function (el) {
  const card = el.closest('.x-card');
  if (card) toggleAccount('weibo', card, el.checked);
};

/** 平台切换草稿：小 segnav 一切换表单就重渲，不存草稿会丢已填内容（display/bili 两平台共用） */
let acctDraft = null;

function captureAcctDraft() {
  if (!acctDraft) return;
  const val = function (id) { const el = document.getElementById(id); return el ? el.value : null; };
  let v;
  if (sheetPlatform === 'weibo') {
    if ((v = val('wa-nick')) !== null) acctDraft.nick = v;
    if ((v = val('wa-uid')) !== null) acctDraft.uid = v;
  } else {
    if ((v = val('xa-name')) !== null) acctDraft.name = v;
    if ((v = val('xa-nick')) !== null) acctDraft.nick = v;
  }
  if ((v = val(sheetPlatform === 'weibo' ? 'wa-display' : 'xa-display')) !== null) acctDraft.display = v;
  if ((v = val(sheetPlatform === 'weibo' ? 'wa-bili' : 'xa-bili')) !== null) acctDraft.bili = v;
}

/** 账号表单（X = ID + 昵称 / 显示名 / 关联主播；微博 = 昵称 + uid / 显示名 / 关联主播）。
 *  编辑态 uid 只读回显：uid 是账号身份，改它等于换账号，历史微博会串到别人名下——要换就删了重加。 */
function acctFormHtml(a) {
  const d = acctDraft || {};
  if (sheetPlatform === 'weibo') {
    const uidInput = a
      ? `<input class="inp" id="wa-uid" value="${esc(a.uid)}" disabled>`
      : `<input class="inp" id="wa-uid" data-change="wa-resolve-uid" value="${esc(d.uid || '')}">`;
    // 昵称与 uid 并排（uid 在右）：两个独立 field，label 各在输入框上方（同抓取设置的 field 结构）；
    // 昵称框 placeholder 只放一个 @——@昵称 是微博 ID 的常规词头（后端 normalizeWeiboNick 会剥掉开头的 @）
    return '<div class="field-row">' +
        `<div class="field"><label class="field-label">昵称</label>` +
        `<input class="inp" id="wa-nick" placeholder="@" data-change="wa-resolve-nick" value="${esc(a ? (a.nickname || '') : (d.nick || ''))}"></div>` +
        `<div class="field field-uid"><label class="field-label">uid</label>${uidInput}</div>` +
      '</div>' +
      field('显示名', `<input class="inp" id="wa-display" value="${esc(a ? (a.displayName || '') : (d.display || ''))}">`) +
      field('关联主播', dropdownHtml('wa-bili', biliOptions(), a && a.biliUid ? String(a.biliUid) : (d.bili || ''))) +
      rulesSectionHtml(a);
  }
  // X 三段名称：ID（@handle，唯一标识）/ 昵称（X 的 display name，可手填）/ 显示名（自定义，卡片优先）；
  // ID 与昵称并排（同微博的「昵称 / uid」行结构：两个独立 field，label 各在输入框上方）；
  // ID 框的 placeholder 只放一个 @——格式提示（@ 可省，后端归一化会去掉），不是废话
  return '<div class="field-row">' +
      `<div class="field"><label class="field-label">ID</label>` +
      `<input class="inp" id="xa-name" placeholder="@" value="${esc(a ? a.screenName : (d.name || ''))}"></div>` +
      `<div class="field"><label class="field-label">昵称</label>` +
      `<input class="inp" id="xa-nick" value="${esc(a ? (a.nickname || '') : (d.nick || ''))}"></div>` +
    '</div>' +
    field('显示名', `<input class="inp" id="xa-display" value="${esc(a ? (a.displayName || '') : (d.display || ''))}">`) +
    field('关联主播', dropdownHtml('xa-bili', biliOptions(), a && a.biliUid ? String(a.biliUid) : (d.bili || ''))) +
    rulesSectionHtml(a);
}

/**
 * 账号浮窗（整卡点击/圆形添加钮打开）：添加 = 顶部小 segnav 切 X/微博、表单随之切换；
 * 编辑 = 平台固定（平台是账号 id 的解释域，不给换）。字段编辑 + 本账号规则管理（规则编辑开二级浮窗）。
 */
function openAccountSheet(a, platform) {
  sheetAccountId = a ? a.id : null;
  sheetPlatform = platform;
  acctDraft = {};
  const title = a
    ? String(a.displayName || a.nickname || (platform === 'weibo' ? '微博 ' + a.uid : '@' + a.screenName))
    : '添加账号';
  openSheet(title,
    (a ? '' : '<div class="acct-platnav">' + segnavHtml([
        { value: 'twitter', label: 'X' },
        { value: 'weibo', label: '微博' },
      ], platform, 'sm', 'acct-plat') + '</div>') +
    '<div id="acct-form">' + acctFormHtml(a) + '</div>',
    1,
    (a ? `<button class="btn" data-action="del-feed-account" data-id="${a.id}">删除</button><span class="sp"></span>` : '') +
    '<span id="acct-err" class="form-err"></span>' +
    '<button class="btn" data-action="close-sheet" data-level="1">取消</button>' +
    `<button class="btn btn-primary" data-action="save-feed-account" data-id="${a ? a.id : ''}">保存</button>`);
  if (!a) layoutSegnav(document.querySelector('#sheet-mask1 .segnav'), false);
  sheetCleanups[1] = function () {
    sheetAccountId = null; sheetPlatform = null; acctDraft = null;
    invalidateResolve();
  };
  if (a) renderSheetRules();
}

ACTIONS['acct-plat'] = function (el) {
  const v = el.getAttribute('data-value');
  if (v === sheetPlatform) return;
  captureAcctDraft();
  invalidateResolve();
  sheetPlatform = v;
  segnavSelect(el.closest('.segnav'), v);
  const box = document.getElementById('acct-form');
  if (box) box.innerHTML = acctFormHtml(null);
};

// 微博「昵称 / uid」互解析：失焦（change）时查 /api/weibo/resolve 回填另一框。
// 失败静默（保存时后端还会兜底校验并报错）；新输入作废旧结果（seq 防晚到的响应覆盖新输入）。
let resolveSeq = 0;
function invalidateResolve() { resolveSeq++; }
function runWeiboResolve(kind) {
  invalidateResolve();
  const seq = resolveSeq;
  const nickEl = document.getElementById('wa-nick');
  const uidEl = document.getElementById('wa-uid');
  if (!nickEl || !uidEl || uidEl.disabled) return;
  const v = (kind === 'nick' ? nickEl.value : uidEl.value).trim();
  if (!v) return;
  api('/api/weibo/resolve?' + (kind === 'nick' ? 'nick=' : 'uid=') + encodeURIComponent(v)).then(function (r) {
    if (seq !== resolveSeq) return;
    if (kind === 'nick') uidEl.value = r.uid;
    else nickEl.value = r.nickname || '';
  }).catch(function () {});
}
CHANGES['wa-resolve-nick'] = function () { runWeiboResolve('nick'); };
CHANGES['wa-resolve-uid'] = function () { runWeiboResolve('uid'); };

/** 浮窗里的规则区：行 = 勾选点（即改即存）+ 摘要，整行点开二级编辑浮窗（同主播详情规则行的跳法） */
function sheetRuleRowHtml(r) {
  return '<div class="row row-2 row-click' + (ruleDeadReason(r, [], channelCache) ? ' rule-dead' : '') +
    '" data-action="edit-post-rule" data-sid="' + r.id + '">' +
    checkDotHtml('data-change="toggle-post-rule"', r.enabled) +
    '<span class="row-main"><span class="row-line"><span class="row-title">' + esc(r.name) + '</span></span>' +
    '<span class="row-sub">' + esc(ruleSub(r)) + '</span></span>' +
    '<span class="row-end"><span class="row-afford">' + icon('chevron') + '</span></span></div>';
}

function renderSheetRules() {
  const box = document.getElementById('xa-rules');
  if (!box || sheetAccountId == null) return;
  const a = accountById(sheetAccountId, sheetPlatform);
  const rules = a ? rulesFor(a, sheetPlatform) : [];
  const noun = sheetPlatform === 'weibo' ? '微博' : '推文';
  box.innerHTML = rules.map(sheetRuleRowHtml).join('') ||
    `<p class="hint">没有规则——加一条，符合筛选的新${noun}就会推送</p>`;
}

ACTIONS['save-feed-account'] = function (el) {
  if (sheetPlatform === 'weibo') saveWeiboAccount(el); else saveXAccount(el);
};

function saveXAccount(el) {
  const err = document.getElementById('acct-err');
  if (err) err.textContent = '';
  const name = document.getElementById('xa-name').value.trim();
  if (!name) { if (err) err.textContent = '请填 ID'; return; }
  const biliVal = document.getElementById('xa-bili').value;
  // enabled 不在浮窗编辑（卡片右上角开关即改即存），POST 新建走后端默认 true
  const body = {
    screenName: name,
    nickname: document.getElementById('xa-nick').value.trim() || null,
    displayName: document.getElementById('xa-display').value.trim() || null,
    biliUid: biliVal === '' ? null : biliVal,
  };
  const idAttr = el.getAttribute('data-id');
  const req = idAttr ? api('/api/x/accounts/' + idAttr, 'PUT', body) : api('/api/x/accounts', 'POST', body);
  req.then(function (r) {
    if (idAttr) {
      toast('已保存'); // 编辑：浮窗留着（规则区还要用），同主播详情保存口径
    } else {
      closeSheet(1);
      // 校验结果分三类：存在 / 账号不存在（已被后端 400 拦下）/ 链路不通（照收但要提示）
      if (r.verify && r.verify.checked && !r.verify.ok) {
        toast('已添加，但未能校验：' + r.verify.message, true);
      } else {
        toast('已添加');
      }
    }
    loadX();
  }).catch(function (e) { if (err) err.textContent = e.message; });
}

ACTIONS['del-feed-account'] = function (el) {
  const a = accountById(el.getAttribute('data-id'), sheetPlatform);
  if (!a) return;
  const noun = sheetPlatform === 'weibo'
    ? '从微博名单里移除 ' + (a.displayName || a.nickname || a.uid) + '？已归档的微博保留。'
    : '从 X 名单里移除 @' + a.screenName + '？已归档的推文保留。';
  if (!confirm(noun)) return;
  const base = sheetPlatform === 'weibo' ? '/api/weibo/accounts/' : '/api/x/accounts/';
  api(base + a.id, 'DELETE').then(function () {
    closeSheet(1);
    toast('已移除');
    loadX();
  }).catch(function (e) { toast(e.message, true); });
};

// 微博账号保存：新建时 uid 与昵称至少填一个（浮窗里填一个通常会即时解析出另一个；
// 都没解析出来则由后端走匿名解析链补 uid，解析不到就地 400）
function saveWeiboAccount(el) {
  const err = document.getElementById('acct-err');
  if (err) err.textContent = '';
  const idAttr = el.getAttribute('data-id');
  const uidEl = document.getElementById('wa-uid');
  const uid = uidEl && !uidEl.disabled ? uidEl.value.trim() : '';
  const nick = document.getElementById('wa-nick').value.trim();
  const biliVal = document.getElementById('wa-bili').value;
  if (!idAttr && !uid && !nick) {
    if (err) err.textContent = 'uid 与昵称至少填一个';
    return;
  }
  const body = {
    displayName: document.getElementById('wa-display').value.trim() || null,
    biliUid: biliVal === '' ? null : biliVal,
  };
  if (!idAttr && uid) body.uid = uid;
  if (nick) body.nickname = nick;
  const req = idAttr ? api('/api/weibo/accounts/' + idAttr, 'PUT', body) : api('/api/weibo/accounts', 'POST', body);
  req.then(function () {
    if (idAttr) {
      toast('已保存'); // 编辑：浮窗留着（规则区还要用）
    } else {
      closeSheet(1);
      toast('已添加');
    }
    loadX();
  }).catch(function (e) { if (err) err.textContent = e.message; });
}

// ---- 图文帖规则：每条规则针对本账号（scope = 开浮窗的账号；名称后端自动命名）----
// 从账号浮窗进 = 二级浮窗（保存/删除后回账号浮窗，规则区就地刷新）；?open= 走查 = 一级。
function postRuleById(id) {
  for (let i = 0; i < postRuleCache.length; i++) {
    if (String(postRuleCache[i].id) === String(id)) return postRuleCache[i];
  }
  return null;
}

let ruleLevel = 1;

ACTIONS['add-post-rule'] = function () { openPostRuleSheet(null, sheetPlatform, sheetAccountId); };
ACTIONS['edit-post-rule'] = function (el, e) {
  // 行内的勾选点/按钮有自己的语义，不触发整行的「打开编辑」
  if (e && e.target instanceof Element && e.target.closest('label, button')) return;
  const row = el.closest('.row');
  if (row) openPostRuleSheet(postRuleById(row.getAttribute('data-sid')), null, null);
};

function chip(action, value, label, on) {
  return '<button type="button" class="chip' + (on ? ' on' : '') + '" data-action="' + action + '" ' +
    'data-value="' + esc(String(value)) + '">' +
    '<span class="chip-ic">' + icon('check') + '</span><span class="chip-txt">' + esc(label) + '</span></button>';
}

function renderRuleDraft() {
  const box = document.getElementById('pr-draft');
  if (!box || !ruleDraft) return;
  const f = ruleDraft.filters;
  const isWeibo = ruleDraft.platform === 'weibo';
  const chChips = channelCache.length === 0
    ? '<span class="hint">还没有渠道，去「设置 → 推送渠道」添加</span>'
    : channelCache.map(function (c) {
        return chip('rule-ch-toggle', c.id, c.name, ruleDraft.channels.indexOf(c.id) >= 0);
      }).join('');
  // 平台差异只体现在可用筛选：微博的「转发」在抓取层就折进 retweet（正文带 //转发自），
  // 没有独立的引用实体，也不存在需要翻译的外文正文 —— 不出这两枚胶囊（不出比放个永远不命中的勾诚实）
  const llmChips = chip('rule-llm-toggle', 'judge', '判定要不要推', ruleDraft.llmJudge) +
    (isWeibo ? '' : chip('rule-llm-toggle', 'translate', '附译文', ruleDraft.llmTranslate));
  box.innerHTML =
    '<div class="field"><label class="field-label">来源</label>' +
      `<span class="x-plat ${isWeibo ? 'x-plat-weibo' : 'x-plat-x'}">${isWeibo ? '微博' : 'X'}</span>` +
      '<span class="row-sub" style="margin-left:8px">规则只匹配该平台的帖子，改平台请另建一条</span></div>' +
    '<div class="field"><label class="field-label">筛选</label><div class="chips">' +
      chip('rule-filter-toggle', 'original', '原创', f.original) +
      chip('rule-filter-toggle', 'retweet', '转发', f.retweet) +
      chip('rule-filter-toggle', 'media', '必须带图', f.media) +
    '</div></div>' +
    '<div class="field"><label class="field-label">渠道</label><div class="chips">' + chChips + '</div></div>' +
    '<div class="field"><label class="field-label">LLM</label><div class="chips">' + llmChips + '</div></div>';
}

/** 「判定标准」只在开了判定时显示；用 hidden 而非重渲，保住已填内容（pr-draft 重渲会清输入） */
function syncJudgeField() {
  const jf = document.getElementById('pr-judge-field');
  if (jf) jf.hidden = !(ruleDraft && ruleDraft.llmJudge);
}

function openPostRuleSheet(r, platform, accountId) {
  ruleDraft = {
    id: r ? r.id : null,
    // 平台：新建 = 开浮窗那张卡（必填）；编辑 = 保留原平台（平台是账号 id 的解释域，编辑里不给换）
    platform: r ? r.platform : (platform || 'twitter'),
    // scope：新建 = 当前浮窗账号；编辑 = 保留原 scope（存量的全部/多账号规则不被收窄）
    accountIds: r ? r.accountIds.map(Number) : (accountId != null ? [accountId] : []),
    channels: (r ? r.channels : []).map(Number),
    filters: {
      original: r ? r.filters.original : true,
      retweet: r ? r.filters.retweet : false,
      media: r ? r.filters.media : false,
    },
    llmJudge: r ? r.llmJudge : false,
    llmTranslate: r ? r.llmTranslate : false,
  };
  ruleLevel = sheetAccountId != null ? 2 : 1;
  const isWeibo = ruleDraft.platform === 'weibo';
  const defaultTpl = isWeibo ? '{author} 发了新微博' : '{author} 发了新推文';
  const judgePlaceholder = isWeibo
    ? '如：只推与直播预告、新歌发布相关的微博'
    : '如：只推与直播预告、新曲发布相关的推文';
  openSheet(r ? '编辑图文帖规则' : '添加图文帖规则',
    '<div id="pr-draft"></div>' +
    `<div class="field" id="pr-judge-field"><label class="field-label">判定标准</label>` +
      `<input class="inp" id="pr-judge" placeholder="${judgePlaceholder}" value="${r && r.judgePrompt ? esc(r.judgePrompt) : ''}"></div>` +
    field('关键词（逗号分隔）', `<input class="inp" id="pr-kw" placeholder="留空 = 不限" value="${r && r.filters.keywords.length ? esc(r.filters.keywords.join(',')) : ''}">`) +
    field('推送词', `<input class="inp" id="pr-tpl" placeholder="留空 = 默认（${defaultTpl}）" value="${r && r.messageTemplate ? esc(r.messageTemplate) : ''}">`) +
    '<span class="row-sub">可用变量：{author} {text} {url} {liver}</span>',
    ruleLevel,
    (r ? `<button class="btn" data-action="del-post-rule" data-id="${r.id}">删除</button><span class="sp"></span>` : '') +
    '<span id="pr-err" class="form-err"></span>' +
    `<button class="btn" data-action="close-sheet" data-level="${ruleLevel}">取消</button>` +
    `<button class="btn btn-primary" data-action="save-post-rule" data-id="${r ? r.id : ''}">保存</button>`);
  renderRuleDraft();
  syncJudgeField();
}

ACTIONS['rule-llm-toggle'] = function (el) {
  if (el.getAttribute('data-value') === 'judge') ruleDraft.llmJudge = !ruleDraft.llmJudge;
  else ruleDraft.llmTranslate = !ruleDraft.llmTranslate;
  renderRuleDraft();
  syncJudgeField();
};

ACTIONS['rule-filter-toggle'] = function (el) {
  ruleDraft.filters[el.getAttribute('data-value')] = !ruleDraft.filters[el.getAttribute('data-value')];
  renderRuleDraft();
};

ACTIONS['rule-ch-toggle'] = function (el) {
  const id = Number(el.getAttribute('data-value'));
  const i = ruleDraft.channels.indexOf(id);
  if (i >= 0) ruleDraft.channels.splice(i, 1); else ruleDraft.channels.push(id);
  renderRuleDraft();
};

ACTIONS['save-post-rule'] = function (el) {
  const err = document.getElementById('pr-err');
  if (err) err.textContent = '';
  const kw = document.getElementById('pr-kw').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  const judgePrompt = document.getElementById('pr-judge').value.trim();
  const body = {
    platform: ruleDraft.platform,
    accountIds: ruleDraft.accountIds,
    channels: ruleDraft.channels,
    filters: {
      original: ruleDraft.filters.original,
      retweet: ruleDraft.filters.retweet,
      media: ruleDraft.filters.media,
      keywords: kw,
    },
    llmJudge: ruleDraft.llmJudge,
    judgePrompt: judgePrompt || null,
    llmTranslate: ruleDraft.platform === 'weibo' ? false : ruleDraft.llmTranslate,
    messageTemplate: document.getElementById('pr-tpl').value.trim() || null,
  };
  const idAttr = el.getAttribute('data-id');
  const req = idAttr ? api('/api/post-rules/' + idAttr, 'PUT', body) : api('/api/post-rules', 'POST', body);
  req.then(function () {
    closeSheet(ruleLevel);
    toast(idAttr ? '已保存' : '已添加');
    loadX().then(renderSheetRules); // 回账号浮窗：规则区就地刷新
  }).catch(function (e) { if (err) err.textContent = e.message; });
};

CHANGES['toggle-post-rule'] = function (el) {
  const row = el.closest('.row');
  if (!row) return;
  api('/api/post-rules/' + row.getAttribute('data-sid'), 'PUT', { enabled: el.checked }).then(function () {
    toast(el.checked ? '已启用' : '已停用');
    loadX().then(renderSheetRules);
  }).catch(function (e) { toast(e.message, true); loadX().then(renderSheetRules); });
};

ACTIONS['del-post-rule'] = function (el) {
  const r = postRuleById(el.getAttribute('data-id'));
  if (!r) return;
  if (!confirm('删除规则「' + r.name + '」？')) return;
  api('/api/post-rules/' + r.id, 'DELETE').then(function () {
    closeSheet(ruleLevel);
    toast('已删除');
    loadX().then(renderSheetRules);
  }).catch(function (e) { toast(e.message, true); });
};

loadX();
setInterval(loadX, 60000);
