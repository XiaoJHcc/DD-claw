/**
 * demo 夹具导出命令（npm run demo:fixtures）：从本机真实库导出**主播列表 + 关注列表 +
 * 时间表**三部分真实数据节选 → webui/demo/fixtures.json（随仓库发布，demo 模式
 * ?demo=1 的 mock-api 启动时 fetch 它）。
 *
 * 范围纪律（用户决策 2026-08-20）：
 * - 只导这三个数据型卡片；LLM / 分类规则 / 推送规则是手工维护的展示案例
 *   （webui/demo/defaults.json，同时是首启默认值），渠道 / NapCat / 监听态等设置卡片
 *   手写于 webui/demo/mock-data.js，一律不由本工具导出。
 * - 名单固定为下方 DEMO_STREAMER_UIDS（demo 主播 12 位）与 DEMO_FOLLOW_UIDS
 *   （关注列表 18 位 = 12 + 6）；导出是**一次性引导**，产物由人工删改节选后长期维护。
 * - 导出内容全是公开数据（直播间状态/动态/微博/头像），不含任何凭据与私密配置，
 *   无需脱敏。cookie 文件本工具绝不读取。
 * - 头像同时本地化到 `webui/demo/avatars/<uid>.<ext>`（随仓库发布，face 字段改写为
 *   站点相对路径）：时间表颜色条要拿头像进 canvas 取平均色，本地图天然同源不污染
 *   画布——demo 下替代生产端 /api/avatar 反代，纯静态托管/离线颜色也正确。
 * - 关键帧同样每位主播本地化一张到 `webui/demo/keyframes/<uid>.<ext>`，该主播所有
 *   场次的 keyframe/cover 字段统一改写指向它——demo 离线/纯静态也有画面看。
 * - **防覆盖**：fixtures.json 已存在且未传 --force 时拒绝写出（保护人工节选成果）。
 *
 * fixtures.json 带 meta.exportedAt（导出时刻，毫秒）：demo 模式把页面时间冻结在该
 * 时刻渲染（demo/freeze 见 mock-data.js freezeTime），无论哪天打开，时间表红线、
 * 在播时长、动态时间都按导出瞬间呈现。
 *
 * 形状契约：streamers 与 GET /api/streamers（enrich，去 rules 字段）同构、
 * schedule 与 GET /api/schedule 的 entry 同构，键名/嵌套层级前端按此消费。
 * 库定位/打开方式与入口守卫照抄 tools/migrate-snapshot-paths.ts。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/index.js';
import { makeLogger } from '../logger.js';
import { Db } from '../core/db.js';

const log = makeLogger('tools/demo-fixtures');

/** B站图床要 UA + Referer，否则 403（同 server.ts /api/avatar、notify/image-cache 口径） */
const AVATAR_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Referer: 'https://live.bilibili.com/',
};

// ---- demo 名单（2026-08-20 用户拍板）----
// demo 主播 12 位：七海 / 阿梓 / 星瞳 / 雫るる / 明前奶绿 / 永雏塔菲 / 栞栞 / 弥月 / 灰泽满 / 花礼 / 泽音 / 菫時
const DEMO_STREAMER_UIDS = [
  '434334701', // 七海Nana7mi
  '7706705', // 阿梓从小就很可爱
  '401315430', // 星瞳_Official
  '387636363', // 雫るる_Official
  '2132180406', // 明前奶绿
  '1265680561', // 永雏塔菲
  '1609526545', // 栞栞Shiori
  '1789460279', // 弥月Mizuki
  '1298779265', // 灰泽满Hazel
  '1048135385', // 花礼Harei
  '1203217682', // 泽音Melody
  '796556', // -菫時-
];
// 关注列表追加 6 位：米汀 / 岁己 / 巴老师 / 樱群 / 三理 / 雪烛
const DEMO_FOLLOW_UIDS = [
  ...DEMO_STREAMER_UIDS,
  '2124647716', // 米汀Nagisa
  '1954091502', // 岁己SUI
  '1588646945', // 巴老师的小号
  '548076', // 樱群
  '2030198123', // 三理Mit3uri
  '2039332008', // 雪烛Yukisyo
];

// ---- 北京 06:00 日界换算（与 panel/server.ts /api/schedule 同口径；server 未导出，此处复制）----
const DAY_SEC = 86400;

/** 日串 YYYY-MM-DD → 该日界日的起点 ts（当天北京时间 06:00） */
function scheduleDayStart(day: string): number {
  return Math.floor(Date.parse(day + 'T06:00:00+08:00') / 1000);
}

/** 北京时间今天（from/to 基准） */
function beijingToday(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 日串加减天数（按 UTC 正午换算，避开时区/夏令时坑） */
function addDays(day: string, n: number): string {
  return new Date(Date.parse(day + 'T12:00:00Z') + n * DAY_SEC * 1000).toISOString().slice(0, 10);
}

/**
 * 图片本地化：下载到 webui/demo/<subdir>/<uid>.<ext>（随仓库发布），返回 uid → 站点相对
 * 路径（'demo/<subdir>/<uid>.<ext>'，不带前导斜杠——GitHub Pages 项目页挂在子路径下也能
 * 解析）。头像本地化是因为时间表颜色条要拿头像进 canvas 取平均色，本地文件天然同源不
 * 污染画布，demo 下替代生产端的 /api/avatar 反代；关键帧本地化是让 demo 离线/纯静态
 * 也有画面看（每位主播一张，该主播所有场次的 keyframe/cover 共用）。下载失败保留
 * 远程 URL（在线时仍能显示，仅颜色/画面回退）。
 */
async function downloadMedia(
  root: string,
  subdir: string,
  uidUrls: Map<string, string>,
  label: string,
): Promise<Map<string, string>> {
  const dir = join(root, 'webui', 'demo', subdir);
  mkdirSync(dir, { recursive: true });
  const out = new Map<string, string>();
  for (const [uid, url] of uidUrls) {
    if (!/^https?:\/\//.test(url)) continue;
    try {
      const res = await fetch(url, { headers: AVATAR_HEADERS, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 5_000_000) throw new Error('超过 5MB 防御上限');
      const ext = (res.headers.get('content-type') ?? '').includes('png') ? '.png' : '.jpg';
      writeFileSync(join(dir, uid + ext), buf);
      out.set(uid, `demo/${subdir}/${uid}${ext}`);
    } catch (e) {
      log.warn(`${label}下载失败 uid=${uid}（${(e as Error).message}），保留远程 URL`);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const out = join(root, 'webui', 'demo', 'fixtures.json');
  const force = process.argv.includes('--force');
  if (existsSync(out) && !force) {
    log.error(
      `${out} 已存在，拒绝覆盖——fixtures.json 导出一次后由人工节选维护。` +
        `确认要用本机库重新导出再加 --force（会冲掉手工修改）`,
    );
    process.exitCode = 1;
    return;
  }

  const { secrets } = loadConfig();
  const db = new Db(secrets.dbPath);
  try {
    const streamerSet = new Set(DEMO_STREAMER_UIDS);

    // ---- 监听名单 enrich（对齐 GET /api/streamers 单元素形状，不含 rules——mock 会自己算）----
    const streamers = db.listStreamers().filter((s) => streamerSet.has(s.uid));
    for (const uid of DEMO_STREAMER_UIDS) {
      if (!streamers.some((s) => s.uid === uid)) log.warn(`demo 主播 uid ${uid} 不在 streamers 表，跳过`);
    }
    const roomStates = db.listRoomStatesFull();
    // 一次分组查询：每个 uid 最近 5 条动态（跨平台按 pub_ts 混排），raw 不导出
    const recentPosts = db.listRecentPosts(streamers.map((s) => s.uid), 5);
    const fixtureStreamers = streamers.map((s) => {
      const rs = roomStates.get(s.uid);
      return {
        uid: s.uid,
        uname: s.uname,
        alias: s.alias,
        roomId: s.roomId ?? rs?.roomId ?? null,
        face: s.face,
        watch: s.watch,
        analyze: s.analyze,
        notify: s.notify,
        weiboNick: s.weiboNick,
        weiboUid: s.weiboUid,
        profileNote: s.profileNote,
        // 与 GET /api/streamers 同构：有 room_state 行就带完整 live 对象（含 isLive
        // 与 lastLiveAt/上一场标题——非在播时前端靠它们渲染「下播 X / 上一场」），
        // 从未轮询到房间（无 room_state 行）才是 null
        live: rs
          ? {
              isLive: rs.isLive,
              title: rs.title,
              liveTime: rs.liveTime,
              roomId: s.roomId ?? rs.roomId,
              areaName: rs.areaName || null,
              parentAreaName: rs.parentAreaName || null,
              keyframe: rs.keyframe || null,
              cover: rs.cover || null,
              online: rs.online,
              lastLiveAt: rs.lastLiveAt,
              polledAt: rs.polledAt,
            }
          : null,
        posts: (recentPosts.get(s.uid) ?? []).map((p) => ({
          // platform 原样导出（'bili_dynamic' / 'weibo'），与面板 enrich 同口径——
          // 前端只判 === 'weibo'，其余按 B站动态处理
          platform: p.platform,
          type: p.type ?? null,
          text: p.text,
          pics: p.pics,
          pubTs: p.pubTs,
          url: p.url,
        })),
      };
    });

    // ---- 关注候选池（18 位；follows 表缺行时从 streamers 兜底合成）----
    const followsAll = db.listFollows(true);
    const streamerAll = db.listStreamers();
    const follows = DEMO_FOLLOW_UIDS.map((uid) => {
      const f = followsAll.find((x) => x.uid === uid);
      if (f) return { uid: f.uid, uname: f.uname, face: f.face };
      const s = streamerAll.find((x) => x.uid === uid);
      if (s) {
        log.warn(`uid ${uid}（${s.uname}）不在 follows 表，用 streamers 行兜底`);
        return { uid: s.uid, uname: s.uname, face: s.face };
      }
      log.warn(`关注 uid ${uid} 两表都找不到，跳过`);
      return null;
    }).filter((x) => x !== null);

    // ---- 时间表：近 14 天（北京 06:00 日界口径 今天-14 ~ 今天+1），只收 demo 主播场次 ----
    const today = beijingToday();
    const fromTs = scheduleDayStart(addDays(today, -14));
    const toTs = scheduleDayStart(addDays(today, 1));
    const schedule = db.listTimeline(fromTs, toTs + DAY_SEC)
      .filter((e) => streamerSet.has(e.uid))
      .map((e) => {
        // 在播/下播一律以 room_state 为准修正 listTimeline 的鲜度窗口误判：
        // - 导出瞬间仍在播：endTs 强制 null（含末段开口），demo 里时间条带透明过渡
        //   延伸到红线（last_seen 超窗会被 listTimeline 固化终点，须恢复开口）
        // - 刚下播 <10min：listTimeline 按鲜度窗口误判在播（endTs=null），以正常
        //   下播已收尾的末段终点回填（崩溃场次无末段终点则退化为零长不画）
        const rs = roomStates.get(e.uid);
        const liveNow = rs?.isLive === true && rs.liveTime === e.liveTime;
        const endTs = liveNow ? null : (e.endTs ?? e.segments.at(-1)?.endTs ?? e.startTs);
        return {
          kind: 'live' as const,
          roomId: e.roomId,
          liveTime: e.liveTime,
          uid: e.uid,
          name: e.name,
          face: e.face,
          startTs: e.startTs,
          endTs, // 在播 = null，语义照抄服务端
          keyframe: e.keyframe,
          cover: e.cover,
          segments: liveNow
            ? e.segments.map((g, i) => (i === e.segments.length - 1 ? { ...g, endTs: null } : g))
            : e.segments,
          verdicts: e.verdicts,
        };
      });

    // ---- 头像本地化（时间表颜色条取平均色要同源图；失败条目保留远程 URL）----
    const uidFaces = new Map<string, string>();
    for (const f of follows) if (f.face) uidFaces.set(f.uid, f.face);
    for (const s of fixtureStreamers) if (s.face) uidFaces.set(s.uid, s.face); // streamers 优先
    const localFaces = await downloadMedia(root, 'avatars', uidFaces, '头像');
    const localFace = (uid: string, face: string | null) => localFaces.get(uid) ?? face;
    for (const s of fixtureStreamers) s.face = localFace(s.uid, s.face);
    for (const f of follows) f.face = localFace(f.uid, f.face) ?? '';
    for (const e of schedule) e.face = localFace(e.uid, e.face);

    // ---- 关键帧本地化（每位主播一张，该主播所有场次的 keyframe/cover 共用同一张；
    // 取图优先级：当前 live.keyframe > live.cover > 最近一场 keyframe > cover）----
    const latestEntryByUid = new Map<string, (typeof schedule)[number]>();
    for (const e of schedule) {
      const prev = latestEntryByUid.get(e.uid);
      if (!prev || e.startTs > prev.startTs) latestEntryByUid.set(e.uid, e);
    }
    const uidKfs = new Map<string, string>();
    for (const s of fixtureStreamers) {
      const latest = latestEntryByUid.get(s.uid);
      const url = s.live?.keyframe || s.live?.cover || latest?.keyframe || latest?.cover;
      if (url) uidKfs.set(s.uid, url);
    }
    const localKfs = await downloadMedia(root, 'keyframes', uidKfs, '关键帧');
    for (const s of fixtureStreamers) {
      const kf = localKfs.get(s.uid);
      if (kf && s.live) { s.live.keyframe = kf; s.live.cover = kf; }
    }
    for (const e of schedule) {
      const kf = localKfs.get(e.uid);
      if (kf) { e.keyframe = kf; e.cover = kf; }
    }

    const fixtures = {
      meta: { exportedAt: Date.now() },
      streamers: fixtureStreamers,
      follows,
      schedule,
    };
    writeFileSync(out, JSON.stringify(fixtures, null, 2) + '\n', 'utf8');

    const liveCount = fixtureStreamers.filter((s) => s.live?.isLive).length;
    log.info(
      `demo 夹具已导出 → ${out}：` +
        `streamers ${fixtureStreamers.length}（在播 ${liveCount}）、follows ${follows.length}、` +
        `schedule ${schedule.length} 场（近 14 天）、头像本地化 ${localFaces.size}/${uidFaces.size}、` +
        `关键帧本地化 ${localKfs.size}/${uidKfs.size}`,
    );
  } finally {
    db.close();
  }
}

// 入口守卫：仅当作为 CLI 直接运行时执行 main（测试导入不触发）
const isDirectRun = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url).replace(/\\/g, '/') === process.argv[1].replace(/\\/g, '/');
if (isDirectRun) await main();
