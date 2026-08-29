// settings.js — 设置视图（六卡 + 关注列表），重设计版；写入均为演示态
import { esc, icon, openSheet, field, checkRowHtml, switchHtml, checkDotHtml, iconBtn, gripHtml, toast, ACTIONS, INPUTS } from './core.js';
import { DATA } from './data.js';
import { avatarHtml } from './core.js';

function statusDot(state) {
  return `<span class="status-dot ${state === 'ok' ? 'sd-ok' : state === 'expired' ? 'sd-bad' : 'sd-none'}"></span>`;
}
const PLAT_STATE_TXT = { ok: '已登录', expired: '已失效', none: '未登录', imported: '已导入' };

function chanTypeTag(c) {
  if (c.notifier === 'toast') return '<span class="tag tag-mint">系统通知</span>';
  if (c.notifier === 'onebot_group') return `<span class="tag tag-blue">QQ群 ${esc(c.targetId)}</span>`;
  return `<span class="tag tag-purple">QQ私聊 ${esc(c.targetId)}</span>`;
}

export function renderSettings() {
  const g = document.getElementById('settings-grid');
  const p = DATA.platforms;

  // 1. 监听
  const listen = `<div class="card set-card">
    <div class="card-head"><span class="head-chip chip-pink">${icon('headphone')}</span>
      <div class="head-txt"><b>监听</b><small>登录态与动态/微博抓取</small></div></div>
    <div class="set-rows">
      <div class="row" data-action="login-qr" data-plat="bili"><span class="row-main">${statusDot(p.bili)}<span class="row-title">B站 登录<span class="row-sub">${PLAT_STATE_TXT[p.bili] || '未登录'}</span></span></span>${iconBtn('', 'qrcode', '扫码登录')}</div>
      <div class="row"><span class="row-main"><span class="row-title">监听动态<span class="row-sub">B站空间动态归档</span></span></span>${switchHtml('', true)}</div>
      <div class="row" data-action="login-qr" data-plat="weibo"><span class="row-main">${statusDot(p.weibo)}<span class="row-title">微博 登录<span class="row-sub">${PLAT_STATE_TXT[p.weibo] || '未登录'}</span></span></span>${iconBtn('', 'qrcode', '扫码登录')}</div>
      <div class="row"><span class="row-main"><span class="row-title">监听微博<span class="row-sub">微博时间线归档</span></span></span>${switchHtml('', true)}</div>
    </div>
    <div class="set-foot"><button class="btn btn-ghost btn-sm" data-action="listen-adv">${icon('sliders')}抓取设置</button></div>
  </div>`;

  // 2. LLM 分析
  const llmRows = DATA.providers.map(pv => `<div class="row">${gripHtml()}${checkDotHtml('', pv.enabled)}
    <span class="row-main"><span class="row-title">${esc(pv.name)}</span>${pv.vision ? '<span class="tag tag-purple">多模态</span>' : '<span class="tag tag-grey">文本</span>'}</span>
    ${iconBtn('llm-test', 'bolt', '测试')}${iconBtn('llm-edit', 'pencil', '编辑')}${iconBtn('demo-del', 'trash', '删除', true)}</div>`).join('');
  const llm = `<div class="card set-card">
    <div class="card-head"><span class="head-chip chip-purple">${icon('sparkles')}</span>
      <div class="head-txt"><b>LLM 分析</b><small>开播内容分类 · 按名单顺序降级</small></div>${switchHtml('', true)}</div>
    <div class="set-rows">${llmRows}</div>
    <div class="set-foot"><button class="btn btn-ghost btn-sm" data-action="llm-new">${icon('plus')}新增供应商</button><button class="btn btn-line btn-sm" data-action="llm-adv">高级</button></div>
  </div>`;

  // 3. 分类规则
  const catRows = DATA.categories.map(c => {
    const tags = [c.llmPrompt ? '<span class="tag tag-purple">LLM</span>' : '', c.keywords?.length ? `<span class="tag tag-blue">关键词 ${c.keywords.length}</span>` : '', c.areas?.length ? `<span class="tag tag-mint">分区 ${c.areas.length}</span>` : ''].join('');
    return `<div class="row">${gripHtml()}${checkDotHtml('', c.enabled)}<span class="row-main"><span class="row-title">${esc(c.name)}</span>${tags}</span>${iconBtn('cat-edit', 'pencil', '编辑')}${iconBtn('demo-del', 'trash', '删除', true)}</div>`;
  }).join('');
  const cats = `<div class="card set-card">
    <div class="card-head"><span class="head-chip chip-blue">${icon('tag')}</span>
      <div class="head-txt"><b>分类规则</b><small>LLM 提示词 + 确定性条件兜底</small></div></div>
    <div class="set-rows">${catRows}</div>
    <div class="set-foot"><button class="btn btn-ghost btn-sm" data-action="cat-new">${icon('plus')}新增分类</button></div>
  </div>`;

  // 4. 推送渠道
  const chanRows = DATA.channels.map(c => `<div class="row">${gripHtml()}${checkDotHtml('', c.enabled)}
    <span class="row-main"><span class="row-title">${esc(c.name)}</span>${chanTypeTag(c)}</span>
    ${iconBtn('chan-edit', 'pencil', '编辑')}${iconBtn('demo-del', 'trash', '删除', true)}</div>`).join('');
  const push = `<div class="card set-card">
    <div class="card-head"><span class="head-chip chip-mint">${icon('bell')}</span>
      <div class="head-txt"><b>推送渠道</b><small>通知发到哪里去</small></div>${switchHtml('', true)}</div>
    <div class="set-rows">${chanRows}</div>
    <div class="set-foot"><button class="btn btn-ghost btn-sm" data-action="chan-new">${icon('plus')}新增渠道</button><button class="btn btn-line btn-sm" data-action="push-adv">推送设置</button></div>
  </div>`;

  // 5. 推送规则
  const ruleRows = DATA.rules.map(r => {
    const cat = r.categoryId == null ? '<span class="tag tag-mint">任意开播</span>' : `<span class="tag">${esc(DATA.categories.find(c => c.id === r.categoryId)?.name || '分类已删除')}</span>`;
    const uids = r.uids.length === 0 ? '<span class="tag tag-blue">全部主播</span>' : r.uids.slice(0, 4).map(u => `<span class="tag tag-blue">${esc(DATA.streamers.find(s => String(s.uid) === String(u))?.alias || DATA.streamers.find(s => String(s.uid) === String(u))?.uname || u)}</span>`).join('');
    return `<div class="row">${gripHtml()}${checkDotHtml('', r.enabled)}<span class="row-main"><span class="row-title">${esc(r.name)}</span>${cat}${uids}</span>${iconBtn('rule-edit', 'pencil', '编辑')}${iconBtn('demo-del', 'trash', '删除', true)}</div>`;
  }).join('');
  const rules = `<div class="card set-card">
    <div class="card-head"><span class="head-chip chip-amber">${icon('list')}</span>
      <div class="head-txt"><b>推送规则</b><small>分类 × 主播集合 → 渠道 + 推送词</small></div></div>
    <div class="set-rows">${ruleRows}</div>
    <div class="set-foot"><button class="btn btn-ghost btn-sm" data-action="rule-new">${icon('plus')}添加规则</button></div>
  </div>`;

  // 6. NapCat
  const n = DATA.napcat;
  const napState = n.state === 'ok' ? ['sd-ok', '在线 · QQ 已登录'] : n.state === 'conflict' ? ['sd-bad', '端口被其他程序占用'] : ['sd-none', '不在线'];
  const napcat = `<div class="card set-card">
    <div class="card-head"><span class="head-chip chip-cyan">${icon('bot')}</span>
      <div class="head-txt"><b>NapCat</b><small>QQ 机器人通道</small></div>${switchHtml('', n.enabled)}</div>
    <div class="set-rows">
      <div class="row"><span class="row-main"><span class="status-dot ${napState[0]}"></span><span class="row-title">${napState[1]}<span class="row-sub">${esc(n.endpoint)}</span></span></span></div>
      <div class="row" data-action="napcat-edit" data-k="dir"><span class="row-main"><span class="row-title">路径<span class="row-sub">${esc(n.dir)}</span></span></span>${iconBtn('', 'chevron', '')}</div>
      <div class="row" data-action="napcat-edit" data-k="uin"><span class="row-main"><span class="row-title">机器人 QQ<span class="row-sub">${esc(n.uin)}</span></span></span>${iconBtn('', 'chevron', '')}</div>
      <div class="row" data-action="napcat-edit" data-k="alertQq"><span class="row-main"><span class="row-title">超时失败告警 QQ 号<span class="row-sub">${esc(n.alertQq || '留空 = 不报')}</span></span></span>${iconBtn('', 'chevron', '')}</div>
      <div class="row"><span class="row-main"><span class="row-title">失活自动拉起<span class="row-sub">掉线时自动重新启动</span></span></span>${switchHtml('', n.autorestart)}</div>
    </div>
    <div class="set-foot"><button class="btn btn-ghost btn-sm" data-action="napcat-launch">${icon('send')}手动拉起</button></div>
  </div>`;

  g.innerHTML = listen + llm + cats + push + rules + napcat;
}

// ---------- 关注列表 ----------
export function renderFollows(q) {
  const grid = document.getElementById('follow-grid');
  let list = DATA.follows;
  if (q) list = list.filter(f => f.uname.includes(q) || String(f.uid).includes(q));
  const shown = list.slice(0, 120);
  grid.innerHTML = shown.map(f => `<div class="follow-card">
    ${avatarHtml(f.face, f.uname)}
    <span class="f-name">${esc(f.uname)}</span>
    ${f.watched
      ? `<button class="btn btn-line btn-sm" disabled>${icon('check')}已监听</button>`
      : `<button class="btn btn-primary btn-sm" data-action="follow-watch" data-uid="${esc(f.uid)}">${icon('plus')}监听</button>`}
  </div>`).join('') + (list.length > 120 ? `<div class="follow-more">共 ${list.length} 条 · 已显示前 120 条</div>` : '');
}
INPUTS['follow-q'] = t => renderFollows(t.value.trim());
ACTIONS['follow-watch'] = t => {
  const f = DATA.follows.find(x => String(x.uid) === String(t.getAttribute('data-uid')));
  if (f) { f.watched = true; renderFollows(document.getElementById('follow-q').value.trim()); toast(`已把 ${f.uname} 加入监听（演示）`); }
};

// ---------- 各卡弹窗（演示态：表单齐全，保存不落库） ----------
ACTIONS['login-qr'] = async t => {
  const plat = t.getAttribute('data-plat');
  const name = plat === 'bili' ? 'B站' : '微博';
  openSheet(`${name}扫码登录`, `<div class="qr-box"><span class="qr-ic">${icon('qrcode')}</span><button class="btn btn-primary btn-sm" data-action="qr-start" data-plat="${plat}">获取二维码</button></div><div class="qr-status">点击下方按钮生成登录二维码</div>`, 1, null);
};
let qrTimer = null;
ACTIONS['qr-start'] = async t => {
  const plat = t.getAttribute('data-plat');
  const box = document.querySelector('#sheet1 .qr-box');
  const st = document.querySelector('#sheet1 .qr-status');
  let qrSvg = '';
  try {
    const mod = await import('../../js/qr-lib.js');
    const qrcode = mod.default;
    const qr = qrcode(0, 'M');
    qr.addData(plat === 'bili' ? 'https://passport.bilibili.com/h5-app/passport/login' : 'https://weibo.com/sso/demo');
    qr.make();
    qrSvg = qr.createSvgTag(4, 0);
  } catch { }
  box.innerHTML = qrSvg || `<span class="qr-ic">${icon('qrcode')}</span>`;
  const steps = [['等待扫码…', ''], ['已扫码，请在手机上确认', ''], ['登录成功', 'ok']];
  let i = 0;
  st.innerHTML = steps[0][0];
  clearInterval(qrTimer);
  qrTimer = setInterval(() => {
    i++;
    if (i >= steps.length) { clearInterval(qrTimer); return; }
    st.innerHTML = steps[i][0];
    if (steps[i][1] === 'ok') { clearInterval(qrTimer); setTimeout(() => { toast('登录成功（演示）'); }, 400); }
  }, 1800);
};

ACTIONS['listen-adv'] = () => {
  const num = (l, v) => field(l, `<input class="inp" type="number" value="${v}">`);
  openSheet('抓取设置',
    `<div class="two">${num('轮询间隔（秒）', 60)}${num('轮询抖动（秒）', 10)}</div>` +
    num('连续失败告警阈值', 5) +
    `<div class="two">${num('关注列表同步（秒）', 600)}${num('空间动态（秒）', 300)}</div>` +
    `<div class="two">${num('微博（秒）', 300)}${num('关键帧间隔（秒）', 300)}</div>` +
    checkRowHtml('', true, '在播关键帧缓存'));
};
ACTIONS['llm-adv'] = () => openSheet('LLM 高级',
  field('请求超时（秒）', `<input class="inp" type="number" value="60">`) +
  `<div class="two">${field('熔断阈值', `<input class="inp" type="number" value="3">`)}${field('熔断冷却（秒）', `<input class="inp" type="number" value="300">`)}</div>`);
ACTIONS['push-adv'] = () => openSheet('推送设置',
  checkRowHtml('', true, '启动时已在播也推送') +
  checkRowHtml('', false, '新增订阅在播即推送') +
  `<div style="margin-top:12px"><button class="btn btn-blue btn-block" data-action="push-test">${icon('bell')}测试推送渠道</button></div>`);
ACTIONS['push-test'] = () => toast('已发送测试通知（演示）');

ACTIONS['llm-new'] = () => openSheet('新增供应商',
  field('名称', `<input class="inp" placeholder="例如 DeepSeek">`) +
  `<div class="two">${field('Base URL', `<input class="inp" placeholder="https://api.example.com/v1">`)}${field('协议', `<input class="inp" value="chat-completions">`)}</div>` +
  field('API Key', `<input class="inp" placeholder="sk-…（本机明文保存）">`) +
  `<div class="two">${field('模型 ID', `<input class="inp" placeholder="deepseek-v4-flash">`)}<div class="field"><label>能力</label>${checkRowHtml('', false, '多模态（带图分类）')}</div></div>`);
ACTIONS['llm-edit'] = () => ACTIONS['llm-new']();
ACTIONS['llm-test'] = () => toast('可用（238ms）（演示）');

ACTIONS['cat-new'] = () => {
  const c = DATA.categories[0];
  openSheet('分类规则',
    field('名称', `<input class="inp" value="${esc(c?.name || '')}" placeholder="留空自动命名">`) +
    field('LLM 提示词', `<textarea class="inp">${esc(c?.llmPrompt || '')}</textarea>`, '配了提示词且 LLM 可用时以 LLM 判定为准') +
    `<div class="two">${field('关键词', `<input class="inp" value="${esc((c?.keywords || []).join('，'))}" placeholder="逗号分隔">`)}${field('分区', `<input class="inp" value="${esc((c?.areas || []).join('，'))}" placeholder="逗号分隔">`)}</div>` +
    `<div class="hint" style="margin-top:-6px;margin-bottom:10px">关键词与分区两组之间可用「且 / 或」组合（演示版从简）</div>`);
};
ACTIONS['cat-edit'] = () => ACTIONS['cat-new']();

ACTIONS['chan-new'] = () => openSheet('推送渠道',
  field('名称', `<input class="inp" placeholder="例如：DD 情报群">`) +
  field('类型', `<input class="inp" value="系统通知 / QQ群 / QQ私聊" disabled>`, '正式版为下拉选择，选 QQ 类型后需填群号 / QQ 号') +
  field('目标', `<input class="inp" placeholder="群号 / QQ 号">`));
ACTIONS['chan-edit'] = () => ACTIONS['chan-new']();

ACTIONS['rule-new'] = () => {
  const body =
    field('规则名称', `<input class="inp" placeholder="留空自动命名">`) +
    field('分类', `<input class="inp" value="任意开播 / ${DATA.categories.map(c => esc(c.name)).join(' / ')}" disabled>`, '正式版为下拉；选「任意开播」= 只要开播就命中') +
    field('生效主播', `<button class="btn btn-blue btn-block btn-sm" data-action="rule-pick">${icon('users')}全部主播（点击挑选）</button>`, '全部不勾 = 对全部主播生效（含未来新增）') +
    `<div class="field"><label>推送渠道</label>` + DATA.channels.map(c => checkRowHtml('', c.enabled, `${esc(c.name)}`)).join('') + '</div>' +
    field('推送词', `<input class="inp" placeholder="{liver} 开播了">`, '支持 {liver} {uname} {title}，留空 = 默认模板');
  openSheet('推送规则', body, 1);
};
ACTIONS['rule-edit'] = () => ACTIONS['rule-new']();
ACTIONS['rule-pick'] = () => {
  const body = `<div class="pick-list">` + DATA.streamers.filter(s => s.watch).map(s =>
    `<label class="pick-row"><input type="checkbox" hidden>${avatarHtml(s.face, s.uname)}<span class="pk-name">${esc(s.uname)}</span><span class="pk-uid">${esc(s.uid)}</span>${checkDotHtml('', false)}</label>`).join('') + '</div>' +
    `<div class="hint" style="margin-top:10px">全部不勾 = 对全部主播生效（含未来新增）</div>`;
  openSheet('生效主播', body, 2);
};

const NAPCAT_EDIT = { dir: 'NapCat 路径', uin: '机器人 QQ', alertQq: '超时失败告警 QQ 号' };
ACTIONS['napcat-edit'] = t => {
  const k = t.getAttribute('data-k');
  openSheet(NAPCAT_EDIT[k], field(NAPCAT_EDIT[k], `<input class="inp" value="${esc(DATA.napcat[k] || '')}">`));
};
ACTIONS['napcat-launch'] = () => toast('已通过计划任务拉起 NapCat（演示）');
ACTIONS['demo-del'] = () => toast('演示模式：不能真的删除', true);
