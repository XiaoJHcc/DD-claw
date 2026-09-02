// streamers.js — v2 主播列表视图：竖版严格三段式卡片
//   ① 关键帧横幅 = 独立卡片头（内嵌同心圆；在播粉色描边只描头部块）：粉底 LIVE 角标融开播时长、
//      右上在线人数次要胶囊；标题/分区叠在只包文字区域的磨砂圆角衬底上。
//   ② 主播信息段：头像 + 名称 + 直播间/微博 + 绿点「推送规则」标签行（三个勾已删——名单内即监听中）。
//   ③ 动态段：弱化的极浅灰内嵌容器，定高；默认展开第一条（三行 + 带图），hover 其余行互斥展开，
//      展开行 flex:1 此消彼长、容器总高恒定。
import { esc, icon, avatarHtml, relTime, fmtLiveDur, openSheet, field, toast, ACTIONS } from './core.js';
import { DATA } from './data.js';

const PT_TAG = {
  weibo: ['微博', 'tag-amber'],
  DYNAMIC_TYPE_AV: ['视频', 'tag-blue'],
  DYNAMIC_TYPE_DRAW: ['图文', 'tag-mint'],
  DYNAMIC_TYPE_WORD: ['文字', ''],
  DYNAMIC_TYPE_FORWARD: ['转发', 'tag-purple'],
};
function postTag(p) {
  if (p.platform === 'weibo') return PT_TAG.weibo;
  return PT_TAG[p.type] || ['动态', 'tag-blue'];
}

function rulesOf(uid) {
  return DATA.rules.filter(r => r.uids.length === 0 || r.uids.map(String).includes(String(uid)));
}

// 在线人数：次要信息，紧凑格式化（1.2万）
function fmtOnline(n) {
  if (n == null) return '';
  return n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + '万' : String(n);
}

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

// 动态行：默认收起 = 单行（标签 + 一行文 + 时间）；.open = 展开（缩略图 + 三行文定高）。
// 结构同一套，靠 CSS 重排：收起时 .pt-head display:contents（标签/时间摊平进行内）。
function postRow(p, open) {
  const [label, cls] = postTag(p);
  const inner =
    (p.pics && p.pics[0] ? `<img class="pt-img" src="${esc(p.pics[0])}" referrerpolicy="no-referrer" onerror="this.remove()">` : '') +
    `<span class="pt-main"><span class="pt-head"><span class="tag ${cls}">${label}</span>` +
    `<small class="pt-tm">${relTime(p.pubTs)}</small></span>` +
    `<span class="pt-x">${esc(p.text || '(无文字)')}</span></span>`;
  const clsAttr = `st-post${open ? ' open' : ''}`;
  return p.url
    ? `<a class="${clsAttr}" href="${esc(p.url)}" target="_blank" rel="noopener" data-action="noop">${inner}</a>`
    : `<div class="${clsAttr}">${inner}</div>`;
}

function cardHtml(s) {
  const live = s.live;
  const isLive = !!(live && live.isLive);
  const rules = rulesOf(s.uid);
  const posts = (s.posts || []).filter(p => p.type !== 'DYNAMIC_TYPE_LIVE_RCMD').slice(0, 3);
  const meta = `直播间 ${s.roomId ? esc(s.roomId) : '—'}` +
    (s.weiboNick ? ` · 微博 ${esc(s.weiboNick)}` : '');

  return `<div class="st-card${isLive ? ' is-live' : ''}" data-action="open-streamer" data-uid="${esc(s.uid)}">
    <div class="st-banner">${bannerHtml(s)}</div>
    <div class="st-mid">
      <div class="st-id">
        ${avatarHtml(s.face, s.uname)}
        <div class="nm"><b>${esc(s.uname || s.uid)}</b><small>${meta}</small></div>
      </div>
      <div class="st-rules"><span class="rl-dot"></span><span class="rl-t">推送规则</span>${
        rules.length
          ? rules.map(r => `<span class="tag${r.enabled ? '' : ' rl-off'}">${esc(r.name)}</span>`).join('')
          : '<span class="rl-none">未配置</span>'
      }</div>
    </div>
    <div class="st-posts">${
      posts.length ? posts.map((p, i) => postRow(p, i === 0)).join('') : '<div class="st-posts-empty">最近没有动态</div>'
    }</div>
  </div>`;
}

export function renderStreamers() {
  const grid = document.getElementById('streamers-grid');
  // 在播优先，其余按最近下播排序
  const list = [...DATA.streamers].sort((a, b) =>
    ((b.live?.isLive ? 1 : 0) - (a.live?.isLive ? 1 : 0)) || ((b.live?.lastLiveAt || 0) - (a.live?.lastLiveAt || 0)));
  grid.innerHTML = list.map(cardHtml).join('') || '<p class="hint">名单为空（从设置视图的关注列表加入）。</p>';
}

// ---- 详情弹窗：字段编辑 + 生效规则视图（三个勾已删——在名单内即监听中） ----
function chanName(id) { const c = DATA.channels.find(c => c.id === id); return c ? c.name : `#${id}`; }
function catName(id) { if (id == null) return '任意开播'; const c = DATA.categories.find(c => c.id === id); return c ? c.name : '分类已删除'; }
function ruleDeadReason(r) {
  if (!r.enabled) return '已停用';
  if (r.categoryId != null && !DATA.categories.find(c => c.id === r.categoryId)) return '分类已删除';
  const chans = r.channels.map(id => DATA.channels.find(c => c.id === id)).filter(Boolean);
  if (!r.channels.length || !chans.length) return '未选渠道';
  if (!chans.some(c => c.enabled)) return '渠道不可用';
  return null;
}

ACTIONS['open-streamer'] = t => {
  // ?open=open-streamer 审查钩子在 body 上触发、无 data-uid，回退取第一位主播
  const s = DATA.streamers.find(x => String(x.uid) === String(t.getAttribute('data-uid'))) || DATA.streamers[0];
  if (!s) return;
  const rules = rulesOf(s.uid);
  const body =
    field('简称', `<input class="inp" value="${esc(s.alias || '')}" placeholder="留空 = 使用原名">`) +
    field('微博昵称', `<input class="inp" value="${esc(s.weiboNick || '')}" placeholder="填写后自动解析 UID">`) +
    field('画像备注', `<textarea class="inp" placeholder="给 LLM 的额外描述（说话风格、常播内容……）">${esc(s.profileNote || '')}</textarea>`) +
    `<div class="adv-group">生效的推送规则</div>` +
    (rules.length ? '<div class="sheet-rules">' + rules.map(r => {
      const dead = ruleDeadReason(r);
      return `<div class="row row-click${dead ? ' rule-dead' : ''}" data-action="goto-push-rule" data-rid="${r.id}">` +
        `<span class="row-main"><span class="row-line"><span class="row-title">${esc(r.name)}</span>` +
        (dead ? `<span class="tag">${dead}</span>` : `<span class="tag tag-blue">${esc(catName(r.categoryId))}</span>` +
          r.channels.map(id => `<span class="tag">${esc(chanName(id))}</span>`).join('')) +
        `</span></span><span class="row-end"><span class="row-afford">${icon('chevron')}</span></span></div>`;
    }).join('') + '</div>' : '<p class="hint">暂无生效规则（在设置视图添加）。</p>');
  openSheet(`${esc(s.uname || s.uid)} <span class="hint" style="font-size:var(--fs-sm);font-weight:400">UID ${esc(s.uid)} · 直播间 ${esc(s.roomId || '—')}</span>`, body, 1);
};

ACTIONS['noop'] = (t, e) => { e.stopPropagation(); };
ACTIONS['goto-push-rule'] = () => { toast('演示模式：这里会跳到「推送规则」卡并打开该规则的编辑弹窗'); };

// 动态区 hover 展开：hover 到收起的行 → 该行展开、原展开行收起（互斥）。
// 容器定高 + 展开行 flex:1 吸收余量，两行 flex-grow 同步过渡、总高恒定不弹跳。
document.addEventListener('mouseover', e => {
  const p = e.target.closest('.st-post');
  if (!p || p.classList.contains('open')) return;
  const box = p.closest('.st-posts');
  if (!box) return;
  box.querySelector('.st-post.open')?.classList.remove('open');
  p.classList.add('open');
});
