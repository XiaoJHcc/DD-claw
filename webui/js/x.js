// 面板前端 · 图文分页（X / 推特 + 微博 + B站动态；图文监听与直播监听是两种输入，共用推送渠道）。
// 上半 = 三张来源卡（监听开关都在卡片头右上角，一卡一开关，同 NapCat/LLM/推送渠道卡形态）
//   X 卡行区只显示连接可达性（出问题才多一行监听诊断）；代理/实例/间隔/回退全部收进「源设置」
//   二级弹窗，测试按钮是控件右侧的方 icon——结果并入按钮自身：转圈 → 绿勾/红叉，原因进 hover
//   提示，不往弹窗里插文字块、不动布局。微博卡 / B站动态卡 = 登录态行（扫码弹窗复用 listen.js，
//   微博抓取间隔收进「抓取设置」弹窗）——这两张卡保持原样，不加监听/抓取行。
// 下半 = **单墙混排的账号卡片墙**（三个平台的账号在同一张网格里，顶部大 segnav 切换
// 「全部 / X / 微博 / B站」，右端圆形按钮添加账号——与 segnav 同高呼应；卡面带平台角标——
// 三张名单的自增 id 会撞，用户必须一眼看出账号是哪个平台）：
// 卡面纯展示 = 身份段 + 规则摘要行 + 帖子段，整卡可点，账号字段在点击后的浮窗编辑
// （添加浮窗顶部小 segnav 切 X/微博/B站，表单随之切换；微博「昵称 / uid」并排，失焦即解析
// 纪律：GET 只读后端快照（后端绝不在读取路径打网络），探测一律由弹窗里的测试 icon 显式触发；
// 测试允许用输入框里还没保存的值（先测后存），未保存值的结果只动按钮、不污染卡片状态。
import { api, toast, ACTIONS, CHANGES, INPUTS, esc, field, checkRowHtml, dropdownHtml, openSheet, closeSheet, sheetCleanups, switchHtml, iconBtn, makeSortable, mergeVisibleOrder, avatarHtml, relTime, segnavHtml, layoutSegnav, segnavSelect, onTableRefresh } from './core.js';
import { icon } from './icons.js';
import { openPlatformLogin, PLAT_STATE, setLoginConfirmedHook } from './listen.js';
import { loadRuleCard, ruleRowHtml, openRuleSheet, onRulesChanged, accountRef, ruleAppliesTo, ruleSub, deadReason, scopeTitle } from './rules.js';

let xState = null;
let listenState = null;
let accountCache = [];
let weiboAccountCache = [];
let biliAccountCache = [];
let streamerCache = [];
/** 图文规则（= push_rules 里 subject_kind='post' 的行）；与直播规则同表，组件见 rules.js */
let postRuleCache = [];
/** 全部规则（含直播规则）——拖拽排序要给 /api/rules/order 交全排列 */
let allRuleCache = [];
let testing = false;
/** 账号墙的平台筛选：'all' | 'twitter' | 'weibo' | 'bili' */
let platFilter = 'all';

function acctBase(platform) {
  return platform === 'weibo' ? '/api/weibo/accounts/'
    : platform === 'bili' ? '/api/bili/accounts/'
    : '/api/x/accounts/';
}

function stateRows() {
  const s = xState || {};
  return { cfg: s.config || {}, st: s.status || {} };
}

function rowHtml(dot, title, sub) {
  return '<div class="row row-2">' + dot +
    '<span class="row-main"><span class="row-line"><span class="row-title">' + esc(title) + '</span></span>' +
    '<span class="row-sub">' + esc(sub) + '</span></span></div>';
}

/** 加载：连接快照 + 监听开关 + 共享规则数据（规则/分类/渠道/主播/三平台账号，rules.js 缓存） */
function loadX() {
  return Promise.all([api('/api/x'), api('/api/listen'), loadRuleCard()]).then(function (rs) {
    xState = rs[0];
    listenState = rs[1];
    const d = rs[2];
    accountCache = d.accounts.twitter;
    weiboAccountCache = d.accounts.weibo;
    biliAccountCache = d.accounts.bili;
    streamerCache = d.streamers;
    allRuleCache = d.rules;
    postRuleCache = allRuleCache.filter(function (r) { return r.subjectKind === 'post'; });
    renderXStatus();
    renderWeibo();
    renderBili();
    renderPostRules();
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
  // 诊断行只在出问题时出现：链路中断中说明在自动重试（canary 退避），其余显示最近错误
  const diag = feed.linkDown
    ? '链路中断，自动重试中：' + (feed.lastError || '全部账号拉取失败')
    : feed.lastError ? '最近错误：' + feed.lastError : '';
  box.innerHTML = rowHtml('<span class="dot ' + dot + '"></span>', '连接', sub) +
    (diag ? rowHtml('<span class="dot bad"></span>', '监听', diag) : '');
}

// ---- 微博卡 / B站动态卡：登录态（整行可点 → 扫码弹窗）+ 卡片头监听开关 ----
// 这两张卡保持同构：只有登录态一行。抓取运行状态不在这里显示。
// B站动态卡的开关只管「动态账号名单」（bili_accounts）的抓取与推送；监听主播的
// 动态归档随 B站登录常开（直播预告分析等要用），不受这个开关影响。
function platformByKey(key) {
  const ps = (listenState && listenState.platforms) || [];
  for (let i = 0; i < ps.length; i++) if (ps[i].key === key) return ps[i];
  return null;
}

function loginRowHtml(action, plat) {
  const st = (plat && PLAT_STATE[plat.state]) || ['none', '未登录'];
  return '<div class="row row-2 row-click" data-action="' + action + '">' +
      '<span class="dot ' + st[0] + '"></span>' +
      '<span class="row-main"><span class="row-line"><span class="row-title">登录态</span></span>' +
      '<span class="row-sub">' + esc(st[1]) + '</span></span>' +
      '<span class="row-end"><span class="row-afford">' + icon('qrcode') + '</span></span></div>';
}

function renderWeibo() {
  const box = document.getElementById('weibo-rows');
  if (!box || !listenState) return;
  const row = listenState.rows ? listenState.rows.weibo : null;
  // 监听开关在卡片头（静态 markup），这里只同步勾选态
  const sw = document.getElementById('weibo-listen-enabled');
  if (sw) sw.checked = !!(row && row.enabled);
  box.innerHTML = loginRowHtml('weibo-login', platformByKey('weibo'));
}

function renderBili() {
  const box = document.getElementById('bili-rows');
  if (!box || !listenState) return;
  const row = listenState.rows ? listenState.rows.dynamic : null;
  const sw = document.getElementById('bili-listen-enabled');
  if (sw) sw.checked = !!(row && row.enabled);
  box.innerHTML = loginRowHtml('bili-login', platformByKey('bili'));
}

ACTIONS['weibo-login'] = function () { openPlatformLogin('weibo', platformByKey('weibo')); };
ACTIONS['bili-login'] = function () { openPlatformLogin('bili', platformByKey('bili')); };
setLoginConfirmedHook(function () { loadX(); });

CHANGES['toggle-weibo-listen'] = function (el) {
  const on = el.checked;
  api('/api/listen/weibo', 'PUT', { enabled: on }).then(function () {
    toast(on ? '已开启' : '已关闭');
    loadX();
  }).catch(function (e) { toast(e.message, true); loadX(); });
};

CHANGES['toggle-bili-listen'] = function (el) {
  const on = el.checked;
  api('/api/listen/dynamic', 'PUT', { enabled: on }).then(function () {
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
    field('Nitter 实例（中英文逗号分隔）', '<div class="field-inline">' +
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

// ---- 「图文规则」卡（= push_rules 里 subject_kind='post' 的行）：行渲染与规则弹窗都走
// rules.js 统一组件（与主播页「推送规则」卡同一交互语言）；这里只管本卡的列表过滤与拖拽排序。
// 判定口径（原 filters/judgePrompt）已上移进分类（分类卡 applies_to=图文），规则只引用分类。
function renderPostRules() {
  const box = document.getElementById('post-rule-list');
  if (!box) return;
  box.innerHTML = postRuleCache.map(function (r) { return ruleRowHtml(r); }).join('');
}

// 拖拽排序：全局顺序 = 匹配优先级（live 与 post 同一张序）。
// 交全排列：图文规则按拖后顺序填进原图文槽位，直播规则相对位置不动。
makeSortable(document.getElementById('post-rule-list'), {
  items: function () { return postRuleCache; },
  getId: function (r) { return r.id; },
  onOrder: function (ids) {
    api('/api/rules/order', 'PUT', { ids: mergeVisibleOrder(allRuleCache, ids) })
      .then(loadX)
      .catch(function (err) { toast(err.message, true); loadX(); });
  },
});

// ---- 账号卡片墙（单墙混排：X / 微博 / B站同一张网格，卡面带平台角标，顶部筛选胶囊）----
// 与主播列表同一套三段式卡片；帖子段直接复用 .st-posts 结构与 hover 互斥展开。
function accountById(id, platform) {
  const list = platform === 'weibo' ? weiboAccountCache
    : platform === 'bili' ? biliAccountCache : accountCache;
  for (let i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i];
  return null;
}

/** 当前筛选下的账号（每一项带 platform，供卡片渲染与统计共用） */
function visibleAccounts() {
  const out = [];
  if (platFilter === 'all' || platFilter === 'twitter') {
    accountCache.forEach(function (a) { out.push({ platform: 'twitter', a: a }); });
  }
  if (platFilter === 'all' || platFilter === 'weibo') {
    weiboAccountCache.forEach(function (a) { out.push({ platform: 'weibo', a: a }); });
  }
  if (platFilter === 'all' || platFilter === 'bili') {
    biliAccountCache.forEach(function (a) { out.push({ platform: 'bili', a: a }); });
  }
  return out;
}

function renderFilter() {
  const box = document.getElementById('x-account-filter');
  if (!box) return;
  box.innerHTML = segnavHtml([
    { value: 'all', label: '全部 ' + (accountCache.length + weiboAccountCache.length + biliAccountCache.length) },
    { value: 'twitter', label: 'X ' + accountCache.length },
    { value: 'weibo', label: '微博 ' + weiboAccountCache.length },
    { value: 'bili', label: 'B站 ' + biliAccountCache.length },
  ], platFilter, 'lg', 'x-plat-filter');
  layoutSegnav(box.firstElementChild, false);
}

ACTIONS['x-plat-filter'] = function (el) {
  platFilter = el.getAttribute('data-value');
  segnavSelect(el.closest('.segnav'), platFilter);
  renderAccounts();
};

/** 卡的规则 = 对本账号生效的图文规则（scope 空 = 全部生效；非空 = 含本账号引用） */
function rulesFor(platform, a) {
  const ref = accountRef(platform, a);
  return postRuleCache.filter(function (r) { return ruleAppliesTo(r, ref); });
}

/** 该账号视角下规则是否生效（ruleAppliesTo，rules.js 统一语义：空 scope = 全部账号生效） */

// 帖子行：与主播动态同一套结构（.st-post），streamers.js 的全局 hover 委托直接生效。
// 「转发」三平台共用（type='retweet'：X/微博在抓取层折进、B站 FORWARD 在源归一）；
// B站的非转发帖统一标「动态」（细分标签 DYNAMIC_TYPE_* 在主播卡第三栏才有）。
// 判定标记（判定回看）：该帖每条判定行一个标记——pass=1 绿「推」/ pass=0 灰「不推」；
// hover/title 看 **分类名 + 理由**（P2 判定分类制：verdicts 落分类级，ruleName 字段实为
// 分类名，ruleId=0 哨兵——文案不再叫「规则名」以免误导）；无判定行（没跑过判定）不显示标记。
function verdictTagsHtml(verdicts) {
  return (verdicts || []).map(function (v) {
    const label = v.ruleName || '分类 #' + v.ruleId;
    const tip = '分类「' + label + '」' + (v.evidence ? '：' + v.evidence : '');
    return `<span class="tag ${v.pass ? 'tag-mint' : 'tag-gray'}" title="${esc(tip)}">${v.pass ? '推' : '不推'}</span>`;
  }).join('');
}

function postRowHtml(p, open) {
  const [label, cls] = p.type === 'retweet' ? ['转发', 'tag-purple']
    : p.platform === 'bili_dynamic' ? ['动态', 'tag-pink']
    : ['原创', 'tag-blue'];
  // 微博图床防盗链（no-referrer 也 403）：帖子图经 /api/weibo-image 反代（服务端带 Referer + 落盘缓存）
  const pic = p.pics && p.pics[0]
    ? (p.platform === 'weibo' ? '/api/weibo-image?url=' + encodeURIComponent(p.pics[0]) : p.pics[0])
    : '';
  const inner =
    (pic ? `<img class="pt-img" src="${esc(pic)}" referrerpolicy="no-referrer" alt="">` : '') +
    `<span class="pt-main"><span class="pt-head"><span class="tag ${cls}">${label}</span>` +
    verdictTagsHtml(p.verdicts) +
    `<small class="pt-tm">${p.pubTs ? relTime(p.pubTs) : ''}</small></span>` +
    `<span class="pt-x">${esc(p.text || '(无文字)')}</span></span>`;
  const clsAttr = `st-post${open ? ' open' : ''}`;
  return p.url
    ? `<a class="${clsAttr}" href="${esc(p.url)}" target="_blank" rel="noopener" data-action="noop">${inner}</a>`
    : `<div class="${clsAttr}">${inner}</div>`;
}

/** 账号卡规则标签行：对本账号生效的图文规则（空 scope = 全部生效）。hover 注明空 scope 语义；
 *  不可达（deadReason）= 划线降透明，与规则卡同一视觉语言 */
function rulesBlockHtml(platform, a) {
  const rules = rulesFor(platform, a);
  return '<div class="st-rules"><span class="rl-dot"></span><span class="rl-t">推送规则</span>' +
    (rules.length
      ? rules.map(function (r) {
          const tip = deadReason(r) || scopeTitle(r.scope, '账号');
          return `<span class="tag${deadReason(r) ? ' rl-off' : ''}" title="${esc(tip)}">${esc(r.name)}</span>`;
        }).join('')
      : '<span class="rl-none">没有生效规则</span>') +
    '</div>';
}

// ---- X 账号卡：身份段（头像 + 显示名/昵称 + @ID）+ 规则摘要 + 推文段 ----
// 账号级抓取故障标记：源连续失败达阈值落库 fetchError（长期问题不推送，只在这里显示）；
// 红字 + 悬停看完整原因，抓取恢复后源自动清库、标记消失
function failTagHtml(a) {
  if (!a.fetchError) return '';
  return `<small class="x-fail" title="${esc(a.fetchError)}">抓取失败${a.fetchFailSince ? ' · 始于 ' + relTime(a.fetchFailSince) : ''}</small>`;
}

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
          <div class="nm"><span class="x-plat-row"><span class="x-plat x-plat-x">X</span></span><b>${esc(name)}</b><small>${esc(meta)}</small>${failTagHtml(a)}</div>
        </div>
        ${switchHtml('data-change="toggle-x-account" title="抓取该账号的新推文"', a.enabled)}
      </div>
      ${rulesBlockHtml('twitter', a)}
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
          <div class="nm"><span class="x-plat-row"><span class="x-plat x-plat-weibo">微博</span></span><b>${esc(name)}</b><small>${esc(meta)}</small>${failTagHtml(a)}</div>
        </div>
        ${switchHtml('data-change="toggle-weibo-account" title="抓取该账号的新微博"', a.enabled)}
      </div>
      ${rulesBlockHtml('weibo', a)}
    </div>
    <div class="st-posts">${
      posts.length
        ? posts.map(function (p, i) { return postRowHtml(p, i === 0); }).join('')
        : '<div class="st-posts-empty">还没有抓到微博</div>'
    }</div>
  </div>`;
}

// ---- B站动态账号卡：身份段（头像 + 显示名/名称 + uid）+ 规则摘要 + 动态段 ----
// B站账号就是主播本人（uid 即主播 uid），没有「关联主播」字段；头像走本地缓存 /api/bili-avatar。
function biliCardHtml(a) {
  const name = a.displayName || a.uname || ('UID ' + a.uid);
  const face = a.avatar ? '/api/bili-avatar?file=' + encodeURIComponent(a.avatar) : '';
  const posts = (a.posts || []).slice(0, 3);
  const meta = 'uid ' + a.uid +
    (posts[0] && posts[0].pubTs ? ' · 动态 ' + relTime(posts[0].pubTs) : '') +
    (a.enabled ? '' : ' · 已停用');
  return `<div class="st-card x-card${a.enabled ? '' : ' x-off'}" data-action="open-bili-account" data-sid="${a.id}">
    <div class="st-mid">
      <div class="x-id-row">
        <div class="st-id">
          ${avatarHtml(face, name)}
          <div class="nm"><span class="x-plat-row"><span class="x-plat x-plat-bili">B站</span></span><b>${esc(name)}</b><small>${esc(meta)}</small>${failTagHtml(a)}</div>
        </div>
        ${switchHtml('data-change="toggle-bili-account" title="抓取该账号的新动态"', a.enabled)}
      </div>
      ${rulesBlockHtml('bili', a)}
    </div>
    <div class="st-posts">${
      posts.length
        ? posts.map(function (p, i) { return postRowHtml(p, i === 0); }).join('')
        : '<div class="st-posts-empty">还没有抓到动态</div>'
    }</div>
  </div>`;
}

function renderAccounts() {
  const box = document.getElementById('x-account-grid');
  if (!box) return;
  box.innerHTML = visibleAccounts().map(function (it) {
    return it.platform === 'weibo' ? weiboCardHtml(it.a)
      : it.platform === 'bili' ? biliCardHtml(it.a)
      : xCardHtml(it.a);
  }).join('');
}

let sheetAccountId = null;
let sheetPlatform = null;

function biliOptions() {
  return [{ value: '', label: '不关联' }].concat(streamerCache.map(function (s) {
    return { value: String(s.uid), label: s.alias || s.uname || String(s.uid) };
  }));
}

function rulesSectionHtml(a) {
  if (!a) return '';
  return '<div class="sheet-section"><div class="sheet-sub">生效规则</div>' +
    '<div id="xa-rules" class="sheet-rules"></div></div>';
}

ACTIONS['add-feed-account'] = function () {
  // 默认平台跟随当前筛选：筛「微博」/「B站」时打开就是对应表单，其余（全部/X）默认 X
  openAccountSheet(null, platFilter === 'all' ? 'twitter' : platFilter);
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
ACTIONS['open-bili-account'] = function (el, e) {
  if (e && e.target instanceof Element && e.target.closest('label, button')) return;
  openAccountSheet(accountById(el.getAttribute('data-sid'), 'bili'), 'bili');
};

// 卡片右上角的监听开关：即改即存（账号其余字段仍在浮窗里编辑）
function toggleAccount(platform, card, enabled) {
  api(acctBase(platform) + card.getAttribute('data-sid'), 'PUT', { enabled: enabled }).then(function () {
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
CHANGES['toggle-bili-account'] = function (el) {
  const card = el.closest('.x-card');
  if (card) toggleAccount('bili', card, el.checked);
};

/** 平台切换草稿：小 segnav 一切换表单就重渲，不存草稿会丢已填内容 */
let acctDraft = null;

function captureAcctDraft() {
  if (!acctDraft) return;
  const val = function (id) { const el = document.getElementById(id); return el ? el.value : null; };
  let v;
  if (sheetPlatform === 'weibo') {
    if ((v = val('wa-nick')) !== null) acctDraft.nick = v;
    if ((v = val('wa-uid')) !== null) acctDraft.uid = v;
  } else if (sheetPlatform === 'bili') {
    if ((v = val('ba-uid')) !== null) acctDraft.uid = v;
  } else {
    if ((v = val('xa-name')) !== null) acctDraft.name = v;
  }
  const dispId = sheetPlatform === 'weibo' ? 'wa-display' : sheetPlatform === 'bili' ? 'ba-display' : 'xa-display';
  if ((v = val(dispId)) !== null) acctDraft.display = v;
  const biliId = sheetPlatform === 'weibo' ? 'wa-bili' : 'xa-bili';
  if (sheetPlatform !== 'bili' && (v = val(biliId)) !== null) acctDraft.bili = v;
}

/**
 * 账号表单（X = ID / 显示名 / 关联主播；微博 = 昵称 + uid / 显示名 / 关联主播；
 *  B站 = uid / 显示名）。
 *  **ID 与平台昵称/用户名是平台事实**：编辑态一律只读回显（改它等于换账号，历史帖子会
 *  串到别人名下——要换就删了重加）；X 的昵称不收手填（添加时校验种入、抓取回写），
 *  B站的名称同理（抓到自动回写）。微博的「昵称」在**新建时**是解析键（填昵称 → 解析出
 *  uid），编辑态同样只读。自定义显示名 / 关联主播是用户自己的标注，随时可改。
 */
function acctFormHtml(a) {
  const d = acctDraft || {};
  if (sheetPlatform === 'weibo') {
    const uidInput = a
      ? `<input class="inp" id="wa-uid" value="${esc(a.uid)}" disabled>`
      : `<input class="inp" id="wa-uid" data-change="wa-uid-change" value="${esc(d.uid || '')}">`;
    // 昵称与 uid 并排（uid 在右）：两个独立 field，label 各在输入框上方（同抓取设置的 field 结构）；
    // 昵称框 placeholder 只放一个 @——@昵称 是微博 ID 的常规词头（后端 normalizeWeiboNick 会剥掉开头的 @）；
    // uid 框接受直接粘贴主页链接（失焦提取纯数字，见 wa-uid-change）
    const nickInput = a
      ? `<input class="inp" id="wa-nick" value="${esc(a.nickname || '')}" disabled title="平台昵称（抓取回写），不可手改">`
      : `<input class="inp" id="wa-nick" placeholder="@" data-change="wa-resolve-nick" value="${esc(d.nick || '')}">`;
    return '<div class="field-row">' +
        `<div class="field"><label class="field-label">昵称</label>${nickInput}</div>` +
        `<div class="field field-uid"><label class="field-label">UID（主页链接）</label>${uidInput}</div>` +
      '</div>' +
      field('显示名', `<input class="inp" id="wa-display" value="${esc(a ? (a.displayName || '') : (d.display || ''))}">`) +
      field('关联主播', dropdownHtml('wa-bili', biliOptions(), a && a.biliUid ? String(a.biliUid) : (d.bili || ''))) +
      rulesSectionHtml(a);
  }
  if (sheetPlatform === 'bili') {
    // uid 框接受直接粘贴主页链接（失焦提取纯数字，见 ba-uid-change）；
    // 名称（uname）是平台事实：抓到自动回写，不收手填——想立刻有可读名字就填「显示名」
    const uidInput = a
      ? `<input class="inp" id="ba-uid" value="${esc(a.uid)}" disabled>`
      : `<input class="inp" id="ba-uid" data-change="ba-uid-change" value="${esc(d.uid || '')}">`;
    const nameRow = a
      ? field('名称（抓取回写）', `<input class="inp" value="${esc(a.uname || '（还没抓到）')}" disabled title="B站用户名（抓取回写），不可手改">`)
      : '';
    return nameRow +
      field('UID（主页链接）', uidInput) +
      field('显示名', `<input class="inp" id="ba-display" value="${esc(a ? (a.displayName || '') : (d.display || ''))}">`) +
      rulesSectionHtml(a);
  }
  // X：ID（@handle，唯一标识）/ 显示名（自定义，卡片优先）/ 关联主播；
  // 昵称是平台事实（添加时校验种入 og:title 显示名、抓取回写），不收手填——编辑态只读回显
  const idInput = a
    ? `<input class="inp" id="xa-name" value="${esc(a.screenName)}" disabled title="X 的 ID 是身份锚点，不可改；要换账号就删除重加">`
    : `<input class="inp" id="xa-name" placeholder="@" value="${esc(d.name || '')}">`;
  const nickRow = a
    ? field('昵称（平台显示名）', `<input class="inp" value="${esc(a.nickname || '（还没抓到）')}" disabled title="X 的显示名（校验种入 / 抓取回写），不可手改">`)
    : '';
  return field('ID', idInput) +
    nickRow +
    field('显示名', `<input class="inp" id="xa-display" value="${esc(a ? (a.displayName || '') : (d.display || ''))}">`) +
    field('关联主播', dropdownHtml('xa-bili', biliOptions(), a && a.biliUid ? String(a.biliUid) : (d.bili || ''))) +
    rulesSectionHtml(a);
}

/**
 * 账号浮窗（整卡点击/圆形添加钮打开）：添加 = 顶部小 segnav 切 X/微博/B站、表单随之切换；
 */
function openAccountSheet(a, platform) {
  sheetAccountId = a ? a.id : null;
  sheetPlatform = platform;
  acctDraft = {};
  const title = a
    ? String(a.displayName || a.nickname || a.uname ||
        (platform === 'weibo' ? '微博 ' + a.uid : platform === 'bili' ? 'UID ' + a.uid : '@' + a.screenName))
    : '添加账号';
  openSheet(title,
    (a ? '' : '<div class="acct-platnav">' + segnavHtml([
        { value: 'twitter', label: 'X' },
        { value: 'weibo', label: '微博' },
        { value: 'bili', label: 'B站' },
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
// UID 框接受直接粘贴主页链接：失焦时提取纯数字 uid 回填
// （微博 weibo.com/u/<uid>、B站 space.bilibili.com/<uid>；保存时后端还各有一条归一化兜底）
function extractUid(el) {
  const m = el.value.match(/(?:weibo\.com\/(?:u\/)?|space\.bilibili\.com\/)(\d+)/);
  if (m) el.value = m[1];
}
CHANGES['wa-uid-change'] = function (el) { extractUid(el); runWeiboResolve('uid'); };
CHANGES['ba-uid-change'] = function (el) { extractUid(el); };
CHANGES['wa-resolve-nick'] = function () { runWeiboResolve('nick'); };

function pickRuleRowHtml(r) {
  const dead = deadReason(r);
  const tip = esc(dead || scopeTitle(r.scope, '账号'));
  return '<div class="row row-2 row-click' + (dead ? ' rule-dead' : '') + '"' +
    ' title="' + tip + '" data-action="goto-post-rule" data-sid="' + r.id + '">' +
    '<span class="row-main"><span class="row-line"><span class="row-title">' + esc(r.name) + '</span></span>' +
    '<span class="row-sub">' + esc(ruleSub(r)) + '</span></span>' +
    '<span class="row-end"><span class="row-afford">' + icon('chevron') + '</span></span></div>';
}

function renderSheetRules() {
  const box = document.getElementById('xa-rules');
  if (!box || sheetAccountId == null) return;
  const a = accountById(sheetAccountId, sheetPlatform);
  if (!a) return;
  const ref = accountRef(sheetPlatform, a);
  box.innerHTML = postRuleCache.filter(function (r) { return ruleAppliesTo(r, ref); })
    .map(pickRuleRowHtml).join('') || '<p class="hint">还没有推送规则（在推送规则卡片中添加）。</p>';
}

ACTIONS['goto-post-rule'] = function (el) {
  const id = Number(el.getAttribute('data-sid'));
  closeSheet(1);
  loadX().then(function () {
    const rule = postRuleById(id);
    if (rule) openRuleSheet(rule);
    else toast('规则已删除', true);
  });
};

ACTIONS['save-feed-account'] = function (el) {
  if (sheetPlatform === 'weibo') saveWeiboAccount(el);
  else if (sheetPlatform === 'bili') saveBiliAccount(el);
  else saveXAccount(el);
};

/** 添加账号后的即时首拉要几秒（心跳 + 抓取）：延迟补两枪刷新，首批帖子尽快上卡（不用手动刷） */
function reloadAfterAdd() {
  setTimeout(loadX, 3000);
  setTimeout(loadX, 9000);
}

function saveXAccount(el) {
  const err = document.getElementById('acct-err');
  if (err) err.textContent = '';
  const biliVal = document.getElementById('xa-bili').value;
  // enabled 不在浮窗编辑（卡片右上角开关即改即存），POST 新建走后端默认 true；
  // screenName 只在新建时提交（身份锚点不可改），昵称不提交（平台事实：verify 种入 / 抓取回写）
  const idAttr = el.getAttribute('data-id');
  const body = {
    displayName: document.getElementById('xa-display').value.trim() || null,
    biliUid: biliVal === '' ? null : biliVal,
  };
  if (!idAttr) {
    const name = document.getElementById('xa-name').value.trim();
    if (!name) { if (err) err.textContent = '请填 ID'; return; }
    body.screenName = name;
  }
  const req = idAttr ? api('/api/x/accounts/' + idAttr, 'PUT', body) : api('/api/x/accounts', 'POST', body);
  req.then(function (r) {
    if (idAttr) {
      closeSheet(1);
      toast('已保存');
    } else {
      closeSheet(1);
      reloadAfterAdd();
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
    : sheetPlatform === 'bili'
      ? '从 B站动态名单里移除 ' + (a.displayName || a.uname || a.uid) + '？已归档的动态保留。'
      : '从 X 名单里移除 @' + a.screenName + '？已归档的推文保留。';
  if (!confirm(noun)) return;
  api(acctBase(sheetPlatform) + a.id, 'DELETE').then(function () {
    closeSheet(1);
    toast('已移除');
    loadX();
  }).catch(function (e) { toast(e.message, true); });
};

// 微博账号保存：新建时 uid 与昵称至少填一个（浮窗里填一个通常会即时解析出另一个；
// 都没解析出来则由后端走匿名解析链补 uid，解析不到就地 400）。
// 编辑态昵称/uid 都只读（平台事实，抓取回写），不提交这两个字段
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
  if (!idAttr && nick) body.nickname = nick;
  const req = idAttr ? api('/api/weibo/accounts/' + idAttr, 'PUT', body) : api('/api/weibo/accounts', 'POST', body);
  req.then(function () {
    if (idAttr) {
      closeSheet(1);
      toast('已保存');
    } else {
      closeSheet(1);
      reloadAfterAdd();
      toast('已添加');
    }
    loadX();
  }).catch(function (e) { if (err) err.textContent = e.message; });
}

// B站动态账号保存：uid 可粘 space 链接（后端归一化）+ 显示名。名称（uname）是平台事实
// （抓到自动回写），不提交；编辑态 uid 只读（理由同微博）
function saveBiliAccount(el) {
  const err = document.getElementById('acct-err');
  if (err) err.textContent = '';
  const idAttr = el.getAttribute('data-id');
  const body = { displayName: document.getElementById('ba-display').value.trim() || null };
  if (!idAttr) {
    const uid = document.getElementById('ba-uid').value.trim();
    if (!uid) { if (err) err.textContent = '请填 uid 或空间链接'; return; }
    body.uid = uid;
  }
  const req = idAttr ? api('/api/bili/accounts/' + idAttr, 'PUT', body) : api('/api/bili/accounts', 'POST', body);
  req.then(function () {
    if (idAttr) {
      closeSheet(1);
      toast('已保存');
    } else {
      closeSheet(1);
      reloadAfterAdd();
      toast('已添加');
    }
    loadX();
  }).catch(function (e) { if (err) err.textContent = e.message; });
}

// ---- 图文规则：入口开统一规则弹窗（rules.js openRuleSheet，post 形态）；判定口径在分类卡
function postRuleById(id) {
  for (let i = 0; i < postRuleCache.length; i++) {
    if (String(postRuleCache[i].id) === String(id)) return postRuleCache[i];
  }
  return null;
}

ACTIONS['add-post-rule'] = function () { openRuleSheet(null, { kind: 'post' }); };

loadX();
setInterval(loadX, 60000);
onRulesChanged(function () { loadX().then(renderSheetRules); });
// 图文规则 + 三张账号名单 + 分类/规则（settings）一次性重拉——撤销后把图文页拉回真实态
onTableRefresh(['push_rules', 'categories', 'x_accounts', 'weibo_accounts', 'bili_accounts', 'settings'], loadX);
