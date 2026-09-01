// settings.js — v2 设置视图（六卡 + 关注列表）。双行只放真实信息，无注释性文字。
import { esc, icon, openSheet, field, checkRowHtml, switchHtml, checkDotHtml, iconBtn, gripHtml, toast, avatarHtml, ddHtml, makeSortable, ACTIONS, INPUTS } from './core.js';
import { DATA } from './data.js';

const PLAT_STATE = { ok: ['ok', '已登录'], expired: ['bad', '登录已失效'], none: ['none', '未登录'], imported: ['none', '已导入 Cookie'] };

// 整行可点的行（扫码登录 / NapCat 配置项）：行尾图标只是可点性提示（.row-afford），不是按钮
function platRow(plat, label) {
  const [cls, txt] = PLAT_STATE[DATA.platforms[plat]] || PLAT_STATE.none;
  return `<div class="row row-2 row-click" data-action="login-qr" data-plat="${plat}">
    <span class="dot ${cls}"></span>
    <span class="row-main"><span class="row-line"><span class="row-title">${label}</span></span><span class="row-sub">${txt}</span></span>
    <span class="row-end"><span class="row-afford">${icon('qrcode')}</span></span></div>`;
}
function switchRow(title, checked) {
  return `<div class="row"><span class="row-main"><span class="row-line"><span class="row-title">${title}</span></span></span>
    <span class="row-end">${switchHtml('data-action="demo-switch"', checked)}</span></div>`;
}

// 可排序列表：把手拖拽（makeSortable）→ 重排数据 → 重渲染
const SORTABLE = { providers: () => DATA.providers, categories: () => DATA.categories, channels: () => DATA.channels, rules: () => DATA.rules };
function bindSortable(root) {
  root.querySelectorAll('.set-rows[data-sort]').forEach(el => {
    const arr = SORTABLE[el.getAttribute('data-sort')]();
    makeSortable(el, (from, to) => {
      if (from === to) return;
      arr.splice(to, 0, arr.splice(from, 1)[0]);
      renderSettings();
      toast('顺序已调整（演示）');
    });
  });
}

export function renderSettings() {
  const g = document.getElementById('settings-grid');

  // 1. 监听
  const listen = `<section class="card set-card acc-pink">
    <div class="card-head"><span class="card-ic">${icon('headphone')}</span><h2>监听</h2></div>
    <div class="set-rows">
      ${platRow('bili', 'B站登录')}
      ${switchRow('监听动态', true)}
      ${platRow('weibo', '微博登录')}
      ${switchRow('监听微博', true)}
    </div>
    <div class="card-foot"><button class="btn btn-ghost" data-action="listen-adv">${icon('sliders')}抓取设置</button></div>
  </section>`;

  // 2. LLM 供应商（行：名称 + 模型 ID 副行，多模态标签；可拖拽排序 = 优先级）
  const llmRows = DATA.providers.map(pv => `<div class="row row-2">${gripHtml()}${checkDotHtml('data-action="demo-check"', pv.enabled)}
    <span class="row-main"><span class="row-line"><span class="row-title">${esc(pv.name)}</span>${pv.vision ? '<span class="tag tag-purple">多模态</span>' : ''}</span>
    <span class="row-sub">${esc(pv.model || pv.baseURL || '')}</span></span>
    <span class="row-end">${iconBtn('llm-test', 'bolt', '测试')}${iconBtn('llm-edit', 'pencil', '编辑')}${iconBtn('demo-del', 'trash', '删除', true)}</span></div>`).join('');
  const llm = `<section class="card set-card acc-purple">
    <div class="card-head"><span class="card-ic">${icon('sparkles')}</span><h2>LLM 供应商</h2>
    <div class="card-head-end">${switchHtml('', true)}</div></div>
    <div class="set-rows" data-sort="providers">${llmRows}</div>
    <div class="card-foot"><button class="btn btn-ghost" data-action="llm-new">${icon('plus')}新增供应商</button><button class="btn btn-line" data-action="llm-adv">高级</button></div>
  </section>`;

  // 3. 分类规则（行：名称 + 条件摘要标签；可拖拽排序）
  const catRows = DATA.categories.map(c => {
    const tags = [c.llmPrompt ? '<span class="tag tag-purple">LLM</span>' : '',
      c.keywords?.length ? `<span class="tag tag-blue">关键词 ${c.keywords.length}</span>` : '',
      c.areas?.length ? `<span class="tag tag-mint">分区 ${c.areas.length}</span>` : ''].join('');
    return `<div class="row">${gripHtml()}${checkDotHtml('data-action="demo-check"', c.enabled)}
    <span class="row-main"><span class="row-line"><span class="row-title">${esc(c.name)}</span>${tags}</span></span>
    <span class="row-end">${iconBtn('cat-edit', 'pencil', '编辑')}${iconBtn('demo-del', 'trash', '删除', true)}</span></div>`;
  }).join('');
  const cats = `<section class="card set-card acc-amber">
    <div class="card-head"><span class="card-ic">${icon('tag')}</span><h2>分类规则</h2></div>
    <div class="set-rows" data-sort="categories">${catRows}</div>
    <div class="card-foot"><button class="btn btn-ghost" data-action="cat-new">${icon('plus')}新增分类</button></div>
  </section>`;

  // 4. 推送渠道（行：名称 + 副行「类型 · 目标号」；可拖拽排序）
  const chanSub = c => c.notifier === 'toast' ? '本机系统通知'
    : c.notifier === 'onebot_group' ? `QQ群 · ${esc(c.targetId)}` : `QQ私聊 · ${esc(c.targetId)}`;
  const chanRows = DATA.channels.map(c => `<div class="row row-2">${gripHtml()}${checkDotHtml('data-action="demo-check"', c.enabled)}
    <span class="row-main"><span class="row-line"><span class="row-title">${esc(c.name)}</span></span><span class="row-sub">${chanSub(c)}</span></span>
    <span class="row-end">${iconBtn('chan-edit', 'pencil', '编辑')}${iconBtn('demo-del', 'trash', '删除', true)}</span></div>`).join('');
  const push = `<section class="card set-card acc-blue">
    <div class="card-head"><span class="card-ic">${icon('bell')}</span><h2>推送渠道</h2>
    <div class="card-head-end">${switchHtml('', true)}</div></div>
    <div class="set-rows" data-sort="channels">${chanRows}</div>
    <div class="card-foot"><button class="btn btn-ghost" data-action="chan-new">${icon('plus')}新增渠道</button><button class="btn btn-line" data-action="push-adv">推送设置</button></div>
  </section>`;

  // 5. 推送规则（行：名称 + 分类/生效主播标签；可拖拽排序 = 匹配优先级）
  const ruleRows = DATA.rules.map(r => {
    const cat = r.categoryId == null ? '<span class="tag tag-mint">任意开播</span>'
      : `<span class="tag tag-blue">${esc(DATA.categories.find(c => c.id === r.categoryId)?.name || '分类已删除')}</span>`;
    const uids = r.uids.length === 0 ? '<span class="tag">全部主播</span>'
      : r.uids.slice(0, 4).map(u => `<span class="tag">${esc(DATA.streamers.find(s => String(s.uid) === String(u))?.uname || u)}</span>`).join('');
    return `<div class="row">${gripHtml()}${checkDotHtml('data-action="demo-check"', r.enabled)}
    <span class="row-main"><span class="row-line"><span class="row-title">${esc(r.name)}</span>${cat}${uids}</span></span>
    <span class="row-end">${iconBtn('rule-edit', 'pencil', '编辑')}${iconBtn('demo-del', 'trash', '删除', true)}</span></div>`;
  }).join('');
  const rules = `<section class="card set-card acc-mint">
    <div class="card-head"><span class="card-ic">${icon('list')}</span><h2>推送规则</h2></div>
    <div class="set-rows" data-sort="rules">${ruleRows}</div>
    <div class="card-foot"><button class="btn btn-ghost" data-action="rule-new">${icon('plus')}添加规则</button></div>
  </section>`;

  // 6. NapCat（状态行 = 状态 + 端点副行；配置行 = 标题 + 值副行，整行可点）
  const n = DATA.napcat;
  const napState = n.state === 'ok' ? ['ok', '在线 · QQ 已登录'] : n.state === 'conflict' ? ['bad', '端口被占用'] : ['none', '不在线'];
  const napRow = (k, title, val) => `<div class="row row-2 row-click" data-action="napcat-edit" data-k="${k}">
    <span class="row-main"><span class="row-line"><span class="row-title">${title}</span></span><span class="row-sub">${esc(val || '未设置')}</span></span>
    <span class="row-end"><span class="row-afford">${icon('chevron')}</span></span></div>`;
  const napcat = `<section class="card set-card acc-cyan">
    <div class="card-head"><span class="card-ic">${icon('bot')}</span><h2>NapCat</h2>
    <div class="card-head-end">${switchHtml('', n.enabled)}</div></div>
    <div class="set-rows">
      <div class="row row-2"><span class="dot ${napState[0]}"></span>
        <span class="row-main"><span class="row-line"><span class="row-title">${napState[1]}</span></span><span class="row-sub">${esc(n.endpoint)}</span></span></div>
      ${napRow('dir', '路径', n.dir)}
      ${napRow('uin', '机器人 QQ', n.uin)}
      ${napRow('alertQq', '超时失败告警 QQ', n.alertQq)}
      <div class="row row-2"><span class="row-main"><span class="row-line"><span class="row-title">失活自动拉起</span></span><span class="row-sub">拉起任务已就绪</span></span>
        <span class="row-end">${switchHtml('data-action="demo-switch"', n.autorestart)}</span></div>
    </div>
    <div class="card-foot"><button class="btn btn-ghost" data-action="napcat-launch">${icon('send')}手动拉起</button></div>
  </section>`;

  g.innerHTML = listen + napcat + llm + push + cats + rules;
  bindSortable(g);
}

// ---------- 关注列表（已监听 hover 变「取消监听」） ----------
export function renderFollows(q) {
  const grid = document.getElementById('follow-grid');
  let list = DATA.follows;
  if (q) list = list.filter(f => f.uname.includes(q) || String(f.uid).includes(q));
  const shown = list.slice(0, 120);
  grid.innerHTML = shown.map(f => `<div class="follow-card">
    ${avatarHtml(f.face, f.uname)}
    <span class="f-name">${esc(f.uname)}</span>
    ${f.watched
      ? `<button class="f-watch fw-on" data-action="follow-unwatch" data-uid="${esc(f.uid)}"><span class="w-idle">${icon('check')} 已监听</span><span class="w-hover">取消监听</span></button>`
      : `<button class="f-watch fw-add" data-action="follow-watch" data-uid="${esc(f.uid)}">${icon('plus')}监听</button>`}
  </div>`).join('') + (list.length > 120 ? `<div class="follow-more">共 ${list.length} 条 · 已显示前 120 条</div>` : '');
}
INPUTS['follow-q'] = t => renderFollows(t.value.trim());
ACTIONS['follow-watch'] = t => {
  const f = DATA.follows.find(x => String(x.uid) === String(t.getAttribute('data-uid')));
  if (f) { f.watched = true; renderFollows(document.getElementById('follow-q').value.trim()); toast(`已把 ${f.uname} 加入监听（演示）`); }
};
ACTIONS['follow-unwatch'] = t => {
  const f = DATA.follows.find(x => String(x.uid) === String(t.getAttribute('data-uid')));
  if (f) { f.watched = false; renderFollows(document.getElementById('follow-q').value.trim()); toast(`已取消监听 ${f.uname}（演示）`); }
};

// ---------- 弹窗 ----------
let qrTimer = null;
ACTIONS['login-qr'] = t => {
  const plat = t.getAttribute('data-plat');
  openSheet(`${plat === 'bili' ? 'B站' : '微博'}扫码登录`,
    `<div class="qr-box"><button class="btn btn-primary" data-action="qr-start" data-plat="${plat}">获取二维码</button></div><div class="qr-status"></div>`, 1, null);
};
ACTIONS['qr-start'] = async t => {
  const plat = t.getAttribute('data-plat');
  const box = document.querySelector('#sheet1 .qr-box');
  const st = document.querySelector('#sheet1 .qr-status');
  let qrSvg = '';
  try {
    const qrcode = (await import('../../../js/qr-lib.js')).default;
    const qr = qrcode(0, 'M');
    qr.addData(plat === 'bili' ? 'https://passport.bilibili.com/h5-app/passport/login' : 'https://weibo.com/sso/demo');
    qr.make();
    qrSvg = qr.createSvgTag(4, 0);
  } catch { }
  box.innerHTML = qrSvg;
  const steps = ['等待扫码…', '已扫码，请在手机上确认', '登录成功'];
  let i = 0;
  st.textContent = steps[0];
  clearInterval(qrTimer);
  qrTimer = setInterval(() => {
    i++;
    if (i >= steps.length) { clearInterval(qrTimer); return; }
    st.textContent = steps[i];
    if (i === steps.length - 1) { clearInterval(qrTimer); setTimeout(() => toast('登录成功（演示）'), 400); }
  }, 1800);
};

const num = (l, v) => field(l, `<input class="inp" type="number" value="${v}">`);
// 抓取设置：分组与字段同旧版监听卡（关注列表 / 直播间轮询 / 动态，共 8 项，关键帧开关与间隔并排）
ACTIONS['listen-adv'] = () => openSheet('抓取设置',
  `<div class="adv-group">关注列表</div>${num('同步间隔（秒，≥300）', 1800)}` +
  `<div class="adv-group">直播间轮询</div><div class="two">${num('轮询间隔（秒，20~3600）', 45)}${num('轮询抖动（秒，0~120）', 8)}</div>` +
  num('连续失败多少次后告警（1~100）', 5) +
  `<div class="two">${field('关键帧缓存', checkRowHtml('', true, '缓存直播关键帧'))}${num('缓存间隔（秒，60~3600）', 300)}</div>` +
  `<div class="adv-group">动态</div><div class="two">${num('B站动态抓取间隔（秒，≥120）', 300)}${num('微博抓取间隔（秒，≥120）', 300)}</div>`);
ACTIONS['llm-adv'] = () => openSheet('LLM 高级',
  num('请求超时（秒）', 60) + `<div class="two">${num('熔断阈值', 3)}${num('熔断冷却（秒）', 300)}</div>`);
ACTIONS['push-adv'] = () => openSheet('推送设置',
  checkRowHtml('', true, '启动时已在播也推送') + checkRowHtml('', false, '新增订阅在播即推送'));

ACTIONS['llm-new'] = () => openSheet('供应商',
  field('名称', `<input class="inp" placeholder="例如 DeepSeek">`) +
  `<div class="two">${field('Base URL', `<input class="inp" placeholder="https://api.example.com/v1">`)}${field('协议', ddHtml('api', ['chat-completions', 'responses']))}</div>` +
  field('API Key', `<input class="inp" placeholder="sk-…（本机明文保存）">`) +
  `<div class="two">${field('模型 ID', `<input class="inp" placeholder="deepseek-v4-flash">`)}<div class="field"><label class="field-label">能力</label>${checkRowHtml('', false, '多模态（带图分类）')}</div></div>`);
ACTIONS['llm-edit'] = () => ACTIONS['llm-new']();
ACTIONS['llm-test'] = () => toast('可用（238ms）（演示）');

ACTIONS['cat-new'] = () => {
  const c = DATA.categories[0];
  openSheet('分类规则',
    field('名称', `<input class="inp" value="${esc(c?.name || '')}" placeholder="留空自动命名">`) +
    field('LLM 提示词', `<textarea class="inp">${esc(c?.llmPrompt || '')}</textarea>`) +
    `<div class="field"><label class="field-label">确定性条件</label><div class="cond-row"><input class="inp" value="${esc((c?.keywords || []).join('，'))}" placeholder="关键词，逗号分隔"><button class="cond-toggle" data-action="cond-toggle">或</button><input class="inp" value="${esc((c?.areas || []).join('，'))}" placeholder="分区，逗号分隔"></div></div>`);
};
ACTIONS['cat-edit'] = () => ACTIONS['cat-new']();
ACTIONS['cond-toggle'] = t => { t.textContent = t.textContent === '或' ? '且' : '或'; };

ACTIONS['chan-new'] = () => openSheet('推送渠道',
  field('名称', `<input class="inp" placeholder="例如：DD 情报群">`) +
  `<div class="two">${field('类型', ddHtml('type', ['系统通知', 'QQ群', 'QQ私聊']))}${field('目标', `<input class="inp" placeholder="群号 / QQ 号">`)}</div>`);
ACTIONS['chan-edit'] = () => ACTIONS['chan-new']();

ACTIONS['rule-new'] = () => {
  const body =
    field('规则名称', `<input class="inp" placeholder="留空自动命名">`) +
    field('分类', ddHtml('category', ['任意开播', ...DATA.categories.map(c => c.name)])) +
    field('生效主播', `<button class="btn btn-blue btn-block" data-action="rule-pick">${icon('users')}全部主播（点击挑选）</button>`) +
    `<div class="field"><label class="field-label">推送渠道</label><div class="chips">` +
    DATA.channels.map(c => `<button type="button" class="chip${c.enabled ? ' on' : ' chip-dis'}" data-action="demo-chip" ${c.enabled ? '' : 'title="该渠道已停用：勾选不会生效"'}><span class="chip-ic">${icon('check')}</span><span class="chip-txt">${esc(c.name)}</span></button>`).join('') +
    '</div></div>' +
    field('推送词', `<input class="inp" placeholder="{liver} 开播了">`);
  openSheet('推送规则', body, 1);
};
ACTIONS['rule-edit'] = () => ACTIONS['rule-new']();
ACTIONS['rule-pick'] = () => {
  const body = `<div class="pick-list">` + DATA.streamers.map(s =>
    `<label class="pick-row"><input type="checkbox" hidden>${avatarHtml(s.face, s.uname, 'ava ava-sm')}<span class="pick-name">${esc(s.uname)}</span><span class="pick-uid">${esc(s.uid)}</span>${checkDotHtml('', false)}</label>`).join('') + '</div>';
  openSheet('生效主播', body, 2);
};

const NAPCAT_EDIT = { dir: 'NapCat 路径', uin: '机器人 QQ', alertQq: '超时失败告警 QQ' };
ACTIONS['napcat-edit'] = t => {
  const k = t.getAttribute('data-k');
  openSheet(NAPCAT_EDIT[k], field(NAPCAT_EDIT[k], `<input class="inp" value="${esc(DATA.napcat[k] || '')}">`));
};
ACTIONS['napcat-launch'] = () => toast('已通过计划任务拉起 NapCat（演示）');
ACTIONS['demo-del'] = () => toast('演示模式：不能真的删除', true);
ACTIONS['demo-switch'] = () => toast('演示模式：开关不落库');
// 渠道胶囊可勾可取消；停用渠道（.chip-dis）勾了也置灰划线提示「勾上也没用」，但状态照常切换
ACTIONS['demo-chip'] = t => t.classList.toggle('on');
