// 面板前端 · 主播分页（v2 竖版严格三段式卡片 .st-card）+ 详情弹窗（字段编辑 + 生效推送规则纯展示）。
//   ① 关键帧横幅 = 独立卡片头（16/9，在播粉色描边只描头部块）：粉底 LIVE 角标融开播时长、
//      右上在线人数次要胶囊；标题/分区叠在只包文字区域的磨砂圆角衬底上；
//      下播 = 压灰画面 + 底部一行下播时间，无画面 = video-off 占位。
//   ② 主播信息段：头像（3px 白描边环）+ 名称 + 直播间/微博 meta + 绿点「推送规则」标签行
//      （三个勾已删——名单内即监听中，无状态设计）。
//   ③ 动态段：弱化的极浅灰内嵌容器，定高 166px；默认第一条展开（三行 + 带图），
//      其余收起单行，hover 收起行互斥换展；展开行 flex:1 此消彼长、容器总高恒定。
// 卡序：在播优先、再按 lastLiveAt 倒序。规则的新增/编辑/排序收编在「推送规则」卡片；
// 详情弹窗规则区为纯展示，点击行关弹窗并直接打开该规则的编辑弹窗（push.js 的 goto-push-rule）。
import { api, toast, ACTIONS, esc, openSheet, sheetCleanups, field, ruleDeadReason, avatarHtml, relTime, fmtLiveDur, onTableRefresh } from './core.js';
import { icon } from './icons.js';

// follows.js / push.js / categories.js 在 import：loadStreamers 与 avatarHtml（core 的转发）
export { avatarHtml };
let streamers = [];
let modalUid = null;
let modalChannels = [];
let modalCats = [];
let modalRules = [];

// ---- 主播卡片列表 ----
// 动态类型 → 人话小标签（微博 = 平台标签）。'retweet' 是 source 归一后的三平台转发语义
// （B站 FORWARD 新行存它；旧行还是 DYNAMIC_TYPE_FORWARD，两个键都留着）。开播动态
// （LIVE_RCMD）已彻底舍弃：不再入库，旧库行由一次性迁移清理，这里无需再过滤
const PT_TAG = {
  weibo: ['微博', 'tag-amber'],
  retweet: ['转发', 'tag-purple'],
  DYNAMIC_TYPE_AV: ['视频', 'tag-blue'],
  DYNAMIC_TYPE_DRAW: ['图文', 'tag-mint'],
  DYNAMIC_TYPE_WORD: ['文字', ''],
  DYNAMIC_TYPE_FORWARD: ['转发', 'tag-purple'],
};
function postTag(p) {
  if (p.platform === 'weibo') return PT_TAG.weibo;
  return PT_TAG[p.type] || ['动态', 'tag-blue'];
}

// 在线人数：次要信息，紧凑格式化（1.2万）
function fmtOnline(n) {
  if (n == null) return '';
  return n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + '万' : String(n);
}

// ① 关键帧横幅
function bannerHtml(s) {
  const live = s.live;
  const isLive = !!(live && live.isLive);
  const img = live && (live.keyframe || live.cover);
  if (isLive) {
    const area = [live.parentAreaName, live.areaName].filter(Boolean).join(' / ');
    const dur = live.liveTime ? fmtLiveDur(Date.now() / 1000 - live.liveTime) : '';
    return (img ? `<img src="${esc(img)}" referrerpolicy="no-referrer" alt="">` : '') +
      `<span class="st-live-badge"><i class="pulse"></i>LIVE${dur ? `<em>${dur}</em>` : ''}</span>` +
      (live.online ? `<span class="st-online">${icon('eye')}${fmtOnline(live.online)}</span>` : '') +
      // 可读性收敛到文字区域本身：磨砂圆角衬底只包住标题/分区（无通宽遮罩层）
      `<div class="st-ov"><div class="st-title">${esc(live.title || '')}</div>` +
      (area ? `<span class="st-area">${esc(area)}</span>` : '') + '</div>';
  }
  const offTxt = live && live.lastLiveAt ? `下播于 ${relTime(live.lastLiveAt)}` : '未见开播';
  if (img) {
    return `<img src="${esc(img)}" referrerpolicy="no-referrer" alt="" style="filter:grayscale(.55) brightness(.92)">` +
      '<span class="st-shade st-shade-off"></span>' +
      `<div class="st-ov st-ov-off">${icon('clock')}${esc(offTxt)}</div>`;
  }
  return `<div class="st-off">${icon('video-off')}<span>${esc(offTxt)}</span></div>`;
}

// ③ 动态行：默认收起 = 单行（标签 + 一行文 + 时间）；.open = 展开（缩略图 + 三行文定高）。
// 结构同一套，靠 CSS 重排：收起时 .pt-head display:contents（标签/时间摊平进行内），
// 收起态 .pt-img display:none 彻底出流（否则 width:0 仍吃 flex gap 导致左缘不齐）。
function postRow(p, open) {
  const [label, cls] = postTag(p);
  // 微博图床防盗链（no-referrer 也 403）：帖子图经 /api/weibo-image 反代（服务端带 Referer + 落盘缓存）
  const pic = p.pics && p.pics[0]
    ? (p.platform === 'weibo' ? '/api/weibo-image?url=' + encodeURIComponent(p.pics[0]) : p.pics[0])
    : '';
  const inner =
    (pic ? `<img class="pt-img" src="${esc(pic)}" referrerpolicy="no-referrer" alt="">` : '') +
    `<span class="pt-main"><span class="pt-head"><span class="tag ${cls}">${label}</span>` +
    `<small class="pt-tm">${relTime(p.pubTs)}</small></span>` +
    `<span class="pt-x">${esc(p.text || '(无文字)')}</span></span>`;
  const clsAttr = `st-post${open ? ' open' : ''}`;
  // 卡片整体点击是开详情弹窗；动态链接标 noop 吞掉卡片点击，新窗口打开
  return p.url
    ? `<a class="${clsAttr}" href="${esc(p.url)}" target="_blank" rel="noopener" data-action="noop">${inner}</a>`
    : `<div class="${clsAttr}">${inner}</div>`;
}

function streamerCard(s) {
  // 卡片标题用原名（简称只留给真正空间受限处：规则行标签/时间表横条/推送文案）
  const name = s.uname || String(s.uid);
  const live = s.live;
  const isLive = !!(live && live.isLive);
  // 第三栏最多 3 条（容器定高 166px）；开播动态已彻底舍弃（不入库，旧行由迁移清理）
  const posts = (s.posts || []).slice(0, 3);
  // 生效规则标签：items 带 id/allScope（P3 作用域双向视图）——空范围规则显示为生效中，
  // hover 注明「该规则对全部主播生效」；非空范围 = 仅指定主播（本主播在范围内）。
  // 兼容旧形状（仅 names，items 缺失时回退：allScope 一律按 false 提示）
  const ruleItems = (s.rules && s.rules.items)
    || ((s.rules && s.rules.names) || []).map(function (n) { return { id: 0, name: n, allScope: false }; });
  const meta = `直播间 ${s.roomId ? esc(s.roomId) : '—'}` +
    ` · 微博 ${s.weiboNick ? esc(s.weiboNick) : (s.weiboUid ? esc(s.weiboUid) : '—')}`;

  return `<div class="st-card${isLive ? ' is-live' : ''}" data-action="open-streamer" data-uid="${esc(s.uid)}">
    <div class="st-banner">${bannerHtml(s)}</div>
    <div class="st-mid">
      <div class="st-id">
        ${avatarHtml(s.face, name)}
        <div class="nm"><b>${esc(name)}</b><small>${meta}</small></div>
      </div>
      <div class="st-rules"><span class="rl-dot"></span><span class="rl-t">推送规则</span>${
        ruleItems.length
          ? ruleItems.map(function (it) {
              const tip = it.allScope ? '该规则对全部主播生效' : '仅指定主播生效（本主播在范围内）';
              return `<span class="tag" title="${esc(tip)}">${esc(it.name)}</span>`;
            }).join('')
          : '<span class="rl-none">未配置</span>'
      }</div>
    </div>
    <div class="st-posts">${
      posts.length
        ? posts.map(function (p, i) { return postRow(p, i === 0); }).join('')
        : '<div class="st-posts-empty">最近没有动态</div>'
    }</div>
  </div>`;
}

export function loadStreamers() {
  return api('/api/streamers').then(function (j) {
    streamers = j.streamers || [];
    // 主列表只展示监听中的（watch=true）；关掉的回到「关注列表」等待重新加入
    const active = streamers.filter(function (s) { return s.watch; });
    // 在播优先，其余按最近下播（lastLiveAt）倒序
    active.sort(function (a, b) {
      return ((b.live && b.live.isLive ? 1 : 0) - (a.live && a.live.isLive ? 1 : 0)) ||
        (((b.live && b.live.lastLiveAt) || 0) - ((a.live && a.live.lastLiveAt) || 0));
    });
    document.getElementById('streamer-list').innerHTML =
      active.map(streamerCard).join('') || '<p class="hint">名单为空（从下方关注列表加入）。</p>';
    // 侧栏在播计数
    const cnt = document.getElementById('side-live-count');
    if (cnt) cnt.textContent = String(active.filter(function (s) { return s.live && s.live.isLive; }).length);
  }).catch(function (e) { toast(e.message, true); });
}

// 动态区 hover 展开：hover 到收起的行 → 该行展开、原展开行收起（互斥）。
// 容器定高 + 展开行 flex:1 吸收余量，两行 flex-grow 同步过渡、总高恒定不弹跳。
document.addEventListener('mouseover', function (e) {
  if (!(e.target instanceof Element)) return;
  const p = e.target.closest('.st-post');
  if (!p || p.classList.contains('open')) return;
  const box = p.closest('.st-posts');
  if (!box) return;
  const cur = box.querySelector('.st-post.open');
  if (cur) cur.classList.remove('open');
  p.classList.add('open');
});

// ---- 详情弹窗：字段编辑（简称/微博/画像）+ 生效规则视图 ----
// 弹窗标题用原名（uname）；alias 已正规化为「简称」，仅在空间受限处（规则行标签/时间表横条/推送文案）优先
function fieldVal(id) { const v = document.getElementById(id).value.trim(); return v || null; }

ACTIONS['open-streamer'] = function (el) { openStreamer(el.getAttribute('data-uid')); };

function openStreamer(uid) {
  let s = null;
  for (let i = 0; i < streamers.length; i++) if (String(streamers[i].uid) === String(uid)) s = streamers[i];
  if (!s) { toast('主播数据未加载', true); return; }
  modalUid = s.uid;
  openSheet(String(s.uname || s.uid),
    field('简称', `<input id="f-alias" placeholder="如：阿梓" value="${esc(s.alias || '')}">`) +
    field('微博昵称', `<input id="f-weibo" placeholder="如：阿梓Official" value="${esc(s.weiboNick || '')}">`) +
    field('画像', `<textarea id="f-note" rows="3" placeholder="性格 / 直播风格 / 观众画像等">${esc(s.profileNote || '')}</textarea>`) +
    '<div class="sheet-section"><div class="sheet-sub">生效的推送规则</div>' +
    '<div id="modal-rules" class="sheet-rules">加载中…</div></div>',
    1,
    '<span id="st-err" class="form-err"></span>' +
    '<button class="btn" data-action="close-sheet" data-level="1">关闭</button>' +
    '<button class="btn btn-primary" data-action="save-streamer">保存</button>');
  // 自动提取信息不属设置，追加到大标题右侧（openSheet 会对 title 转义，故事后把 meta 插进标题 DOM）
  const titleEl = document.querySelector('#sheet-mask1 .sheet-title');
  if (titleEl) titleEl.insertAdjacentHTML('beforeend',
    `<span class="sheet-head-meta">UID ${esc(s.uid)} · 直播间 ${s.roomId ? esc(s.roomId) : '—'}</span>`);
  sheetCleanups[1] = function () { modalUid = null; modalChannels = []; modalCats = []; modalRules = []; };
  loadModalRules();
}

ACTIONS['save-streamer'] = function () {
  const err = document.getElementById('st-err');
  if (err) err.textContent = '';
  // 三开关已删（名单内即监听中）：保存只带三个编辑字段
  api('/api/streamers/' + modalUid, 'PUT', {
    alias: fieldVal('f-alias'),
    weiboNick: fieldVal('f-weibo'), profileNote: fieldVal('f-note'),
  }).then(function () {
    toast('已保存');
    loadStreamers();
    if (modalUid != null) loadModalRules(); // 只重建规则区，不动上方编辑表单
  }).catch(function (e) {
    if (err) err.textContent = e.message; else toast(e.message, true); // 保存报错内联
  });
};

// ---- 生效的推送规则（纯展示：规则的增删改/生效主播都在「推送规则」卡片；点击行跳转过去） ----
function modalChannelById(id) {
  for (let k = 0; k < modalChannels.length; k++) if (modalChannels[k].id === id) return modalChannels[k];
  return null;
}

function modalCatName(categoryId) {
  if (categoryId == null) return '任意开播';
  for (let i = 0; i < modalCats.length; i++) if (modalCats[i].id === categoryId) return modalCats[i].name;
  return '分类已删除';
}

// 行序 = 全局 sort。不可达规则（ruleDeadReason）整行置灰划线、只留原因标签；
// 停用渠道的标签不显示（是否可用看渠道卡）。每行是 --bg-soft 圆角块（.sheet-rules .row）。
// hover 提示空范围语义（scope 空 = 对全部主播生效），与主播卡标签行同一口径
function modalRuleRowHtml(r) {
  const dead = ruleDeadReason(r, modalCats, modalChannels);
  const tip = dead || ((r.scope || []).length === 0
    ? '该规则对全部主播生效（空范围）' : '仅指定主播生效（本主播在范围内）');
  const tags = dead
    ? `<span class="tag">${esc(dead)}</span>`
    : `<span class="tag">${esc(modalCatName(r.categoryId))}</span>` +
      (r.channels || []).map(function (cid) {
        const c = modalChannelById(cid);
        return c && c.enabled ? `<span class="tag">${esc(c.name)}</span>` : '';
      }).join('');
  return `<div class="row row-click${dead ? ' rule-dead' : ''}" title="${esc(tip)}" data-action="goto-push-rule" data-rid="${r.id}">` +
    `<span class="row-title">${esc(r.name)}</span>` +
    tags +
    `<span class="row-end">${icon('chevron-right')}</span>` +
    '</div>';
}

function loadModalRules() {
  const box = document.getElementById('modal-rules');
  if (!box || modalUid == null) return;
  Promise.all([api('/api/channels'), api('/api/categories'), api('/api/rules?uid=' + modalUid)])
    .then(function (rs) {
      modalChannels = rs[0].channels || [];
      modalCats = rs[1].categories || [];
      modalRules = rs[2].rules || [];
      box.innerHTML = modalRules.map(modalRuleRowHtml).join('') ||
        '<p class="hint">还没有推送规则（在推送规则卡片中添加）。</p>';
    }).catch(function (e) { toast(e.message, true); });
}

// 点击规则行（data-action="goto-push-rule"）由 push.js 处理：关弹窗 → 切主播视图 → 直接打开编辑弹窗

// ---- 启动与轮询：监听卡 60s（listen.js），主播列表 30s（弹窗 DOM 不被重建） ----
loadStreamers();
setInterval(loadStreamers, 30000);
// 主播名单（含别名/watch）在 streamers 表——撤销后重拉本卡
onTableRefresh(['streamers'], loadStreamers);
