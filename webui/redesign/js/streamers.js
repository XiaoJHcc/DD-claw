// streamers.js — 主播列表视图（重设计版：竖向横幅卡片网格）
import { esc, icon, avatarHtml, fmtDur, relTime, openSheet, closeSheet, field, checkRowHtml, toast, ACTIONS } from './core.js';
import { DATA } from './data.js';

const PT_TAG = {
  weibo: ['微博', 'tag-amber'],
  DYNAMIC_TYPE_AV: ['视频', 'tag-blue'],
  DYNAMIC_TYPE_DRAW: ['图文', 'tag-mint'],
  DYNAMIC_TYPE_WORD: ['文字', 'tag-grey'],
  DYNAMIC_TYPE_FORWARD: ['转发', 'tag-purple'],
};
function postTag(p) {
  if (p.platform === 'weibo') return PT_TAG.weibo;
  return PT_TAG[p.type] || ['动态', 'tag-blue'];
}

function rulesOf(uid) {
  return DATA.rules.filter(r => r.uids.length === 0 || r.uids.map(String).includes(String(uid)));
}

function postRow(p) {
  const [label, cls] = postTag(p);
  const inner =
    `<span class="tag ${cls} pt-t">${label}</span>` +
    `<span class="pt-x"><p>${esc(p.text || '')}</p><small>${relTime(p.pubTs)}</small></span>` +
    (p.pics && p.pics[0] ? `<img class="pt-img" src="${esc(p.pics[0])}" referrerpolicy="no-referrer" onerror="this.remove()">` : '');
  return p.url
    ? `<a class="s-post" href="${esc(p.url)}" target="_blank" rel="noopener" data-action="noop">${inner}</a>`
    : `<div class="s-post">${inner}</div>`;
}

function cardHtml(s) {
  const live = s.live;
  const isLive = !!(live && live.isLive);
  const img = live && (live.keyframe || live.cover);
  const rules = rulesOf(s.uid);
  const now = Math.floor(Date.now() / 1000);

  // 横幅 = 纯视觉区（关键帧 + 在播徽章 + 在线人数），不再压文字
  let banner;
  if (isLive) {
    banner =
      (img ? `<img src="${esc(img)}" referrerpolicy="no-referrer">` : '') +
      `<span class="bn-shade" style="background:linear-gradient(180deg,rgba(30,15,30,.10),transparent 45%)"></span>` +
      `<span class="live-badge"><i class="dot-pulse" style="background:#fff"></i>LIVE</span>` +
      (live.online ? `<span class="online-pill">${icon('eye')}${live.online}</span>` : '');
  } else {
    banner = img
      ? `<img src="${esc(img)}" referrerpolicy="no-referrer" style="filter:grayscale(.45) opacity(.7)">`
      : `<span class="bn-off">${icon('video-off')}<span>暂无画面</span></span>`;
  }

  // 直播信息区：独立面板（在播 = 蓝底，下播 = 灰底）
  const livebox = isLive
    ? `<div class="s-livebox">
        <div class="lb-title">${esc(live.title || '')}</div>
        <div class="lb-meta">
          <span class="tag tag-blue">${esc([live.parentAreaName, live.areaName].filter(Boolean).join(' / ') || '—')}</span>
          <span class="dur">${icon('clock')}开播 ${fmtDur(now - live.liveTime)}</span>
        </div>
      </div>`
    : `<div class="s-livebox off">
        <div class="lb-off">${live && live.lastLiveAt ? `下播于 <b>${relTime(live.lastLiveAt)}</b>` : '<b>未见开播</b>'}</div>
        ${live && live.title ? `<div class="lb-off">上一场：${esc(live.title)}</div>` : ''}
      </div>`;

  const posts = (s.posts || []).filter(p => p.type !== 'DYNAMIC_TYPE_LIVE_RCMD').slice(0, 3);

  return `<div class="s-card${isLive ? ' is-live' : ''}" data-action="open-streamer" data-uid="${esc(s.uid)}">
    <div class="s-banner">${banner}</div>
    <div class="s-body">
      <div class="s-id">
        ${avatarHtml(s.face, s.uname, 'ava')}
        <div class="nm"><b>${esc(s.uname)}</b><small>直播间 ${esc(s.roomId)}${s.weiboNick ? ' · 微博 ' + esc(s.weiboNick) : ''}</small></div>
      </div>
      <div class="s-state">
        <span class="st-dot ${s.watch ? 'st-on' : 'st-off'}"></span>
        <span class="st-txt">${s.watch ? '监听中' : '未监听'}${s.notify ? '' : ' · 推送关'}${s.analyze ? ' · LLM分析' : ''}</span>
      </div>
      ${rules.length ? `<div class="s-rules"><span class="rl-t">规则</span>${rules.map(r => `<span class="tag${r.enabled ? '' : ' tag-off'}">${esc(r.name)}</span>`).join('')}</div>` : ''}
      ${livebox}
      <div class="s-posts"><div class="s-posts-head">最近动态</div>${posts.length ? posts.map(postRow).join('') : '<div class="s-posts-empty">最近没有动态</div>'}</div>
    </div>
  </div>`;
}

export function renderStreamers() {
  const grid = document.getElementById('streamers-grid');
  const list = DATA.streamers.filter(s => s.watch);
  // 在播优先
  list.sort((a, b) => ((b.live?.isLive ? 1 : 0) - (a.live?.isLive ? 1 : 0)) || (b.live?.lastLiveAt || 0) - (a.live?.lastLiveAt || 0));
  grid.innerHTML = list.map(cardHtml).join('');
}

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
  const s = DATA.streamers.find(x => String(x.uid) === String(t.getAttribute('data-uid')));
  if (!s) return;
  const rules = rulesOf(s.uid);
  const body =
    field('简称', `<input class="inp" value="${esc(s.alias || '')}" placeholder="留空 = 使用原名">`, '空间受限处（时间表横条、规则标签）优先使用') +
    field('微博昵称', `<input class="inp" value="${esc(s.weiboNick || '')}" placeholder="填写后自动解析 UID">`) +
    field('画像备注', `<textarea class="inp" placeholder="给 LLM 的额外描述（说话风格、常播内容……）">${esc(s.profileNote || '')}</textarea>`) +
    `<div class="field"><label>开关</label>` +
    checkRowHtml('', s.watch, '监听（纳入轮询）') +
    checkRowHtml('', s.analyze, 'LLM 分析（开播内容分类）') +
    checkRowHtml('', s.notify, '推送（命中规则时通知我）') + '</div>' +
    `<div class="sheet-section"><div class="sec-t">生效的推送规则</div>` +
    (rules.length ? rules.map(r => {
      const dead = ruleDeadReason(r);
      return `<div class="rule-row${dead ? ' dead' : ''}" data-action="goto-push-rule" data-id="${r.id}">` +
        `<span class="rr-nm">${esc(r.name)}</span>` +
        (dead ? `<span class="tag tag-off">${dead}</span>` : `<span class="tag">${esc(catName(r.categoryId))}</span>`) +
        r.channels.map(id => `<span class="tag tag-blue">${esc(chanName(id))}</span>`).join('') +
        `</div>`;
    }).join('') : '<div class="s-posts-empty">暂无命中规则</div>') + '</div>';
  openSheet(`${esc(s.uname)} <span class="head-meta">UID ${esc(s.uid)} · 直播间 ${esc(s.roomId)}</span>`, body, 1);
};

ACTIONS['noop'] = (t, e) => { e.stopPropagation(); };
ACTIONS['goto-push-rule'] = t => {
  closeSheet(1);
  toast('演示模式：这里会跳到「推送规则」卡并打开该规则的编辑弹窗');
};
