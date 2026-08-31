// data.js — v2 Demo 数据层：设置页所需的真实夹具（../../demo/fixtures.json + defaults.json）
// v2 只定调设置页：时间表/主播视图用不到的数据不加载。

// 夹具内的站点相对路径（demo/avatars/x.jpg）相对 webui 根；本页面在 /redesign/v2/ 下，需上跳两级
function fixPath(p) {
  if (!p) return p;
  if (/^https?:/.test(p)) return p;
  if (p.startsWith('demo/')) return '../../' + p;
  return p;
}

export const DATA = {
  streamers: [],
  follows: [],
  categories: [],
  rules: [],
  channels: [],
  providers: [],
  napcat: null,
  platforms: { bili: 'ok', weibo: 'ok' },
};

export async function loadData() {
  let fx = null, df = null;
  try { const r = await fetch('../../demo/fixtures.json'); if (r.ok) fx = await r.json(); } catch { }
  try { const r = await fetch('../../demo/defaults.json'); if (r.ok) df = await r.json(); } catch { }
  if (!df) df = { llmProviders: [], categories: [], rules: [] };

  DATA.streamers = ((fx && fx.streamers) || []).map(s => ({ ...s, face: fixPath(s.face) }));
  const watched = new Set(DATA.streamers.map(s => String(s.uid)));
  DATA.follows = (((fx && fx.follows)) || DATA.streamers.map(s => ({ uid: s.uid, uname: s.uname, face: s.face })))
    .map(f => ({ ...f, face: fixPath(f.face), watched: watched.has(String(f.uid)) }));

  DATA.categories = (df.categories || []).map((c, i) => ({ id: i + 1, sort: i, enabled: true, ...c }));
  DATA.channels = [
    { id: 1, name: '系统通知', notifier: 'toast', targetId: null, enabled: true, sort: 0 },
    { id: 2, name: 'DD 情报群', notifier: 'onebot_group', targetId: '10001', enabled: true, sort: 1 },
    { id: 3, name: '私聊我自己', notifier: 'onebot_private', targetId: '10002', enabled: true, sort: 2 },
    { id: 4, name: '备用群', notifier: 'onebot_group', targetId: '10003', enabled: false, sort: 3 },
  ];
  DATA.rules = (df.rules || []).map((r, i) => ({
    id: i + 1, sort: i, enabled: true,
    name: r.name,
    categoryId: r.category ? (DATA.categories.find(c => c.name === r.category)?.id ?? null) : null,
    uids: [], channels: [1, 2, 3],
    messageTemplate: r.messageTemplate || null,
  }));
  DATA.providers = (df.llmProviders || []).map(p => ({ ...p }));
  DATA.napcat = { enabled: true, autorestart: true, dir: 'D:\\Apps\\NapCat', uin: '10001', alertQq: '10002', state: 'ok', endpoint: 'http://127.0.0.1:41990' };
  DATA.platforms = { bili: 'ok', weibo: 'ok' };
  return DATA;
}

export function liveCount() { return DATA.streamers.filter(s => s.live?.isLive).length; }
