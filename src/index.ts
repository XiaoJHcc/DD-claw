import { loadConfig, ConfigError, projectRoot } from './config/index.js';
import { resolve } from 'node:path';
import { makeLogger } from './logger.js';
import { Db } from './core/db.js';
import { Bus } from './core/bus.js';
import { Pipeline } from './core/pipeline.js';
import { toLiveEvent } from './core/types.js';
import { NoopAnalyzer } from './analysis/noop.js';
import { AnalysisQueue } from './analysis/queue.js';
import { OncePerSessionRule } from './rules/once-per-session.js';
import { NotifyDispatcher } from './notify/dispatcher.js';
import { OneBotNotifier } from './notify/onebot.js';
import { ToastNotifier } from './notify/toast.js';
import { liveEventToMessage } from './notify/message.js';
import { LiveStatusSource } from './sources/bili/live-status-source.js';
import { fetchLiveStatus } from './sources/bili/live-status.js';
import { loadCookies, cookieHeader, type SelfInfo } from './sources/bili/auth.js';
import { FollowsSource } from './sources/bili/follows.js';
import { createPanelServer, type PlatformStatus } from './panel/server.js';
import { createWeiboResolver } from './sources/weibo/resolve.js';
import type { Server } from 'node:http';
import type { Notifier } from './notify/types.js';
import type { Source } from './sources/types.js';

const log = makeLogger('main');

interface Args {
  dryRun: boolean;
  testNotify: boolean;
  probe: boolean;
  forceUids: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, testNotify: false, probe: false, forceUids: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--test-notify') args.testNotify = true;
    else if (a === '--probe') args.probe = true;
    else if (a === '--force-uid') {
      const v = argv[++i];
      if (v) args.forceUids.push(...v.split(',').map((s) => s.trim()).filter(Boolean));
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { app, secrets } = loadConfig();

  // --probe 只查一次开播状态，不推送。用来确认接口通不通。
  // 无 --force-uid 时开 DB 只读监听名单（streamers 表），用完即关。
  if (args.probe) {
    let uids = args.forceUids;
    let probeDb: Db | undefined;
    if (uids.length === 0) {
      probeDb = new Db(secrets.dbPath);
      uids = probeDb.listWatchedUids();
    }
    log.info(`探测 ${uids.length} 个 uid: ${uids.join(', ')}`);
    const res = await fetchLiveStatus(uids);
    probeDb?.close();
    for (const uid of uids) {
      const s = res.get(uid);
      if (!s) { log.info(`  ${uid}: 返回中无此 uid（未开播）`); continue; }
      log.info(
        `  ${uid} ${s.uname} room=${s.roomId} live_status=${s.rawLiveStatus}` +
        `${s.isLive ? ' 直播中' : ''} 「${s.title}」 ${s.parentAreaName}/${s.areaName}`,
      );
      log.info(`    keyframe: ${s.keyframe || '(无)'}`);
    }
    return;
  }

  const db = new Db(secrets.dbPath);

  // 监听名单事实来源是 streamers 表；config.json 的 subscriptions 仅作首次种子
  const seeded = db.seedStreamersIfEmpty(app.subscriptions);
  if (seeded > 0) log.info(`已从 config.json 种子导入 ${seeded} 个主播到 streamers 表，之后由面板管理`);

  const notifiers: Notifier[] = [];
  if (app.notify.onebot.enabled) {
    notifiers.push(new OneBotNotifier(
      secrets.napcatBaseUrl, secrets.napcatToken, app.notify.onebot.targets,
    ));
  }
  if (app.notify.toast.enabled) notifiers.push(new ToastNotifier());

  if (notifiers.length === 0) {
    log.error('没有启用任何推送通道，退出');
    process.exit(1);
  }

  const dispatcher = new NotifyDispatcher(notifiers, db, args.dryRun);
  log.info(`推送通道: ${dispatcher.channels.join(', ')}${args.dryRun ? '  [dry-run]' : ''}`);

  // --test-notify 用一条假消息走完整推送链路，验证 NapCat 配置与消息格式
  if (args.testNotify) {
    const fake = liveEventToMessage(toLiveEvent({
      uid: '7706705', roomId: '80397', uname: '阿梓从小就很可爱',
      title: '[DD-claw 测试] 这是一条测试通知', isLive: true,
      liveTime: Math.floor(Date.now() / 1000), areaName: '虚拟主播',
      parentAreaName: '虚拟主播', cover: '',
      keyframe: 'https://i0.hdslb.com/bfs/live-key-frame/keyframe072918300018143727685jhbin.jpg',
    }, '测试'));
    await dispatcher.broadcast(fake);
    db.close();
    return;
  }

  // 装配：bus → pipeline（编排唯一入口）→ sources（只产信号）
  const bus = new Bus();
  const pipeline = new Pipeline({
    bus,
    db,
    config: app,
    queue: new AnalysisQueue(new NoopAnalyzer()),
    rule: new OncePerSessionRule(db),
    dispatcher,
  });
  pipeline.attach();

  const sources: Source[] = [
    new LiveStatusSource({ forceUids: args.forceUids }),
  ];

  // follows source 单独持有（不放 sources 数组）：扫码登录后要热重启，
  // shutdown 时 stop 的必须是最新实例
  let followsSrc: FollowsSource | null = null;
  // 最近一次登录态心跳结果（onLoginState 上报），面板状态展示用
  let biliLogin: SelfInfo | null = null;
  let cookieImported = false;
  const startFollows = (cookieHdr: string): void => {
    followsSrc?.stop();
    followsSrc = new FollowsSource({
      cookie: cookieHdr,
      onLoginState: (s) => { biliLogin = s; },
    });
    followsSrc.start({ bus, db, config: app });
  };

  // 凭据功能：cookies.json 不存在 → 停用并说明；坏 JSON → loadCookies 抛
  // ConfigError，启动即失败。cookie 值绝不进日志，只传拼好的 Cookie 头。
  const cookies = loadCookies(resolve(projectRoot, 'cookies.json'));
  cookieImported = cookies != null;
  if (!cookies) {
    log.info('未导入 cookies.json，关注列表同步等凭据功能停用（匿名开播监听不受影响）');
  } else if (!app.follows.enabled) {
    log.info('cookies.json 存在，但 config 里 follows.enabled=false，跳过关注列表同步');
  } else {
    startFollows(cookieHeader(cookies));
  }

  for (const s of sources) s.start({ bus, db, config: app });

  // 控制面板：辅助设施。EADDRINUSE 等错误走 'error' 事件，只记日志不影响主流程
  const startedAt = Math.floor(Date.now() / 1000);
  let panel: Server | undefined;
  if (app.panel.enabled) {
    panel = createPanelServer({
      db,
      weiboResolver: createWeiboResolver(),
      status: () => {
        // state 推导：无 cookie=none；有 cookie 还没心跳=imported；
        // isLogin true=ok / false=expired（mid 随心跳带出）
        const biliState: PlatformStatus['state'] = !cookieImported
          ? 'none'
          : biliLogin === null ? 'imported' : biliLogin.isLogin ? 'ok' : 'expired';
        return {
          startedAt,
          notifiers: dispatcher.channels,
          watchedCount: db.listWatchedUids().length,
          liveCount: db.countLiveRooms(),
          platforms: [
            { key: 'bili', name: 'B站', state: biliState, mid: biliLogin?.mid ?? null },
            { key: 'weibo', name: '微博', state: 'reserved' },
          ],
        };
      },
      auth: {
        cookiePath: resolve(projectRoot, 'cookies.json'),
        onCookiesSaved: (cookieHdr) => {
          cookieImported = true;
          biliLogin = null; // 新 cookie 还没心跳，先按 imported 展示
          if (app.follows.enabled) {
            log.info('扫码登录成功，热重启关注列表同步');
            startFollows(cookieHdr);
          }
        },
      },
    });
    panel.on('error', (e) => log.error('控制面板启动失败（不影响主流程）', e));
    panel.listen(app.panel.port, '127.0.0.1', () => {
      log.info(`控制面板: http://127.0.0.1:${app.panel.port}`);
    });
  }

  const watched = args.forceUids.length > 0 ? args.forceUids.length : db.listWatchedUids().length;
  if (watched === 0) {
    log.warn('监听名单为空（streamers 表中没有 watch=1 的主播），不会产生任何开播信号');
  }

  const shutdown = (sig: string) => {
    log.info(`收到 ${sig}，停止中`);
    for (const s of sources) s.stop();
    followsSrc?.stop();
    panel?.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  if (e instanceof ConfigError) {
    log.error(`配置错误\n${e.message}`);
  } else {
    log.error('启动失败', e);
    if (e instanceof Error && e.stack) console.error(e.stack);
  }
  process.exit(1);
});
