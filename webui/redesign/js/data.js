// data.js — Demo 数据层：真实夹具（../demo/fixtures.json + defaults.json）+ 失败时合成兜底
import { bjDayKey, bjAddDays, bjToday } from './core.js';

// 夹具内的站点相对路径（demo/avatars/x.jpg）相对 webui 根；本页面在 /redesign/ 下，需上跳一级
function fixPath(p) {
  if (!p) return p;
  if (/^https?:/.test(p)) return p;
  if (p.startsWith('demo/')) return '../' + p;
  return p;
}

export const DATA = {
  frozen: false,
  exportedAt: 0,
  streamers: [],   // enrich 形状（face/keyframe 已改写到 ../demo/）
  follows: [],     // {uid, uname, face, watched}
  scheduleDays: {}, // date → entries[]
  categories: [],
  rules: [],
  channels: [],
  providers: [],
  napcat: null,
  platforms: { bili: 'ok', weibo: 'ok' },
};

export async function loadData() {
  let fx = null, df = null;
  try { const r = await fetch('../demo/fixtures.json'); if (r.ok) fx = await r.json(); } catch { }
  try { const r = await fetch('../demo/defaults.json'); if (r.ok) df = await r.json(); } catch { }
  if (!fx) fx = fallbackFixtures();
  if (!df) df = fallbackDefaults();

  DATA.exportedAt = fx.meta?.exportedAt || Date.now();
  DATA.frozen = !!fx.meta?.exportedAt;

  DATA.streamers = (fx.streamers || []).map(s => ({
    ...s,
    face: fixPath(s.face),
    live: s.live ? { ...s.live, keyframe: fixPath(s.live.keyframe), cover: fixPath(s.live.cover) } : null,
    posts: (s.posts || []).map(p => ({ ...p })),
  }));

  const watched = new Set(DATA.streamers.map(s => String(s.uid)));
  DATA.follows = (fx.follows || []).map(f => ({ ...f, face: fixPath(f.face), watched: watched.has(String(f.uid)) }));

  // schedule 扁平 entry → 按北京 06:00 日界归组
  const days = {};
  for (const e of (fx.schedule || [])) {
    const key = bjDayKey(e.startTs);
    (days[key] || (days[key] = [])).push({
      ...e,
      face: fixPath(e.face),
      keyframe: fixPath(e.keyframe),
      cover: fixPath(e.cover),
      uname: e.uname || e.name,
    });
  }
  for (const k in days) days[k].sort((a, b) => a.startTs - b.startTs);
  DATA.scheduleDays = days;

  // 设置卡片数据：defaults.json 三卡片 + 手写渠道/NapCat 最简态
  DATA.categories = (df.categories || []).map((c, i) => ({ id: i + 1, sort: i, enabled: true, ...c }));
  const allChanIds = [1, 2, 3];
  DATA.channels = [
    { id: 1, name: '系统通知', notifier: 'toast', targetId: null, enabled: true, sort: 0 },
    { id: 2, name: 'DD 情报群', notifier: 'onebot_group', targetId: '10001', enabled: true, sort: 1 },
    { id: 3, name: '私聊我自己', notifier: 'onebot_private', targetId: '10002', enabled: true, sort: 2 },
    { id: 4, name: '备用群（已停用）', notifier: 'onebot_group', targetId: '10003', enabled: false, sort: 3 },
  ];
  DATA.rules = (df.rules || []).map((r, i) => ({
    id: i + 1, sort: i, enabled: true,
    name: r.name,
    categoryId: r.category ? (DATA.categories.find(c => c.name === r.category)?.id ?? null) : null,
    uids: [], channels: allChanIds.slice(),
    messageTemplate: r.messageTemplate || null,
  }));
  DATA.providers = (df.llmProviders || []).map(p => ({ ...p }));
  DATA.napcat = { enabled: true, autorestart: true, dir: 'D:\\Apps\\NapCat', uin: '10001', alertQq: '10002', state: 'ok', endpoint: 'http://127.0.0.1:41990' };
  DATA.platforms = { bili: 'ok', weibo: 'ok' };
  return DATA;
}

/** 时间表窗口数据：center ±2 天，空日补空数组 */
export function scheduleWindow(center) {
  const out = [];
  for (let n = -2; n <= 2; n++) {
    const date = bjAddDays(center, n);
    out.push({ date, entries: DATA.scheduleDays[date] || [] });
  }
  return out;
}

export function liveCount() { return DATA.streamers.filter(s => s.live?.isLive).length; }

// ---- 兜底合成数据（夹具取不到时，例如 file:// 直开）----
function svgAvatar(color) {
  return 'data:image/svg+xml,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="${color}"/><circle cx="48" cy="38" r="16" fill="#fff" opacity=".92"/><ellipse cx="48" cy="82" rx="26" ry="18" fill="#fff" opacity=".92"/></svg>`);
}
function svgKeyframe(color, label) {
  return 'data:image/svg+xml,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="#7AA5FF"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><text x="320" y="188" font-size="34" fill="#fff" text-anchor="middle" font-family="sans-serif" font-weight="bold">${label}</text></svg>`);
}
function fallbackFixtures() {
  const now = Math.floor(Date.now() / 1000);
  const names = [['阿梓从小就很可爱', '1'], ['七海Nana7mi', '2'], ['星瞳_Official', '3'], ['永雏塔菲', '4']];
  const colors = ['#FF8FB0', '#7AA5FF', '#B39DFF', '#4ADFB2'];
  const streamers = names.map(([uname, uid], i) => ({
    uid, uname, alias: null, roomId: '1000' + uid, face: svgAvatar(colors[i]),
    watch: true, analyze: i % 2 === 0, notify: true, weiboNick: uname, weiboUid: '2000' + uid, profileNote: null,
    live: {
      isLive: i < 2, title: ['歌回！唱到爽！', '随便聊聊天～', '【B限】新衣装发表', '打游戏'][i],
      liveTime: now - 3600 * (i + 1), roomId: '1000' + uid,
      areaName: ['虚拟Singer', '虚拟日常', '虚拟Gamer', '网游'][i], parentAreaName: '虚拟主播',
      keyframe: svgKeyframe(colors[i], uname), cover: svgKeyframe(colors[i], uname),
      online: 1200 - i * 230, lastLiveAt: now - 7200 * (i + 1), polledAt: now,
    },
    posts: [
      { platform: 'bili_dynamic', type: 'DYNAMIC_TYPE_DRAW', text: '今晚八点记得来看我！有新衣服哦', pics: [], pubTs: now - 1800 - i * 900, url: 'https://t.bilibili.com/' },
      { platform: 'weibo', type: 'word', text: '大家好呀，这周也要元气满满', pics: [], pubTs: now - 5400 - i * 1200, url: 'https://weibo.com/' },
    ],
  }));
  const schedule = [];
  for (let d = -6; d <= 0; d++) {
    for (let i = 0; i < names.length; i++) {
      if ((i + d + 7) % 3 === 0) continue;
      const start = now + d * 86400 - (now % 86400) + 12 * 3600 + i * 1500;
      schedule.push({
        kind: 'live', roomId: '1000' + names[i][1], liveTime: start, uid: names[i][1],
        name: names[i][0], face: svgAvatar(colors[i]),
        startTs: start, endTs: d === 0 && i < 2 ? null : start + 5400,
        keyframe: svgKeyframe(colors[i], names[i][0]), cover: svgKeyframe(colors[i], names[i][0]),
        segments: [{ startTs: start, endTs: d === 0 && i < 2 ? null : start + 5400, title: '直播标题 ' + (i + 1), areaName: '虚拟日常', parentAreaName: '虚拟主播' }],
        verdicts: i === 0 ? [{ categoryName: '歌回', source: 'rule', confidence: null, evidence: '命中关键词「歌」' }] : [],
      });
    }
  }
  return { meta: { exportedAt: 0 }, streamers, follows: streamers.map(s => ({ uid: s.uid, uname: s.uname, face: s.face })), schedule };
}
function fallbackDefaults() {
  return {
    llmProviders: [{ name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash', vision: false, enabled: true, structuredOutput: 'schema', api: 'chat-completions' }],
    categories: [{ name: '歌回', llmPrompt: '判断是否歌回……', keywords: ['唱', '歌', '音乐'], areas: [], condMode: 'or' }],
    rules: [{ name: '歌回', category: '歌回', messageTemplate: '【歌回】{liver} 正在唱歌' }, { name: '全部', category: null, messageTemplate: null }],
  };
}
