import { loadConfig, ConfigError, projectRoot } from './config/index.js';
import { dirname, join, resolve } from 'node:path';
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
import { ensureToastAumid } from './notify/aumid.js';
import { liveEventToMessage } from './notify/message.js';
import { LiveStatusSource } from './sources/bili/live-status-source.js';
import { fetchLiveStatus } from './sources/bili/live-status.js';
import { loadCookies, cookieHeader, type SelfInfo } from './sources/bili/auth.js';
import { FollowsSource } from './sources/bili/follows.js';
import { DynamicSource } from './sources/bili/dynamic.js';
import { createPanelServer, type PlatformStatus } from './panel/server.js';
import { createWeiboResolver } from './sources/weibo/resolve.js';
import { loadWeiboCookies, weiboCookieHeader, type WeiboSelfInfo } from './sources/weibo/auth.js';
import { WeiboFeedSource } from './sources/weibo/feed.js';
import type { NewPushChannel } from './core/push.js';
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

  // 推送渠道事实来源是 push_channels 表；config 的 notify 目标仅作首次种子
  // （config 的 onebot.targets 之后仍作 alert 告警目标，zod 校验不变）
  const channelSeeds: NewPushChannel[] = [];
  if (app.notify.onebot.enabled) {
    for (const t of app.notify.onebot.targets) {
      if (!t.enabled) continue;
      channelSeeds.push({
        name: `${t.type === 'group' ? 'QQ群' : 'QQ私聊'} ${t.id}`,
        notifier: 'onebot', targetType: t.type, targetId: t.id, enabled: true,
      });
    }
  }
  if (app.notify.toast.enabled) {
    channelSeeds.push({ name: '系统通知', notifier: 'toast', targetType: null, targetId: null, enabled: true });
  }
  const seededChannels = db.seedPushChannelsIfEmpty(channelSeeds);
  if (seededChannels > 0) log.info(`已从 config 种子导入 ${seededChannels} 个推送渠道到 push_channels 表，之后由面板管理`);

  const notifiers: Notifier[] = [];
  if (app.notify.onebot.enabled) {
    notifiers.push(new OneBotNotifier(
      secrets.napcatBaseUrl, secrets.napcatToken, app.notify.onebot.targets,
    ));
  }
  if (app.notify.toast.enabled) {
    // Win32 AUMID 注册是幂等的，仅首次会调 PowerShell；失败回落系统默认身份
    const toastAumid = await ensureToastAumid();
    notifiers.push(new ToastNotifier(toastAumid, join(dirname(secrets.dbPath), 'cache', 'toast')));
  }

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
    // onebot 常规发送只看 msg.targets（渠道路由之外的兼容路径）：拿 config 的启用目标当测试目标
    fake.targets = app.notify.onebot.targets
      .filter((t) => t.enabled)
      .map((t) => ({ type: t.type, id: t.id }));
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

  // follows / dynamic source 单独持有（不放 sources 数组）：扫码登录后要热重启，
  // shutdown 时 stop 的必须是最新实例
  let followsSrc: FollowsSource | null = null;
  let dynamicSrc: DynamicSource | null = null;
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
  const startDynamic = (cookieHdr: string): void => {
    dynamicSrc?.stop();
    dynamicSrc = new DynamicSource({ cookie: cookieHdr });
    dynamicSrc.start({ bus, db, config: app });
  };

  // weibo feed source 同样单独持有：扫码登录后要热重启
  let weiboFeedSrc: WeiboFeedSource | null = null;
  // 最近一次微博登录态心跳结果（onLoginState 上报），面板状态展示用
  let weiboLogin: WeiboSelfInfo | null = null;
  let weiboCookieImported = false;
  const startWeiboFeed = (cookieHdr: string): void => {
    weiboFeedSrc?.stop();
    weiboFeedSrc = new WeiboFeedSource({
      cookie: cookieHdr,
      onLoginState: (s) => { weiboLogin = s; },
    });
    weiboFeedSrc.start({ bus, db, config: app });
  };

  // 凭据功能：cookies.json 不存在 → 停用并说明；坏 JSON → loadCookies 抛
  // ConfigError，启动即失败。cookie 值绝不进日志，只传拼好的 Cookie 头。
  const cookies = loadCookies(resolve(projectRoot, 'cookies.json'));
  cookieImported = cookies != null;
  if (!cookies) {
    log.info('未导入 cookies.json，关注列表同步 / 动态轮询等凭据功能停用（匿名开播监听不受影响）');
  } else {
    const cookieHdr = cookieHeader(cookies);
    if (!app.follows.enabled) {
      log.info('cookies.json 存在，但 config 里 follows.enabled=false，跳过关注列表同步');
    } else {
      startFollows(cookieHdr);
    }
    if (!app.dynamic.enabled) {
      log.info('cookies.json 存在，但 config 里 dynamic.enabled=false，跳过动态轮询');
    } else {
      log.info(`动态轮询：${db.listWatchedUids().length} 个监听对象，间隔 ${app.dynamic.intervalSec}s`);
      startDynamic(cookieHdr);
    }
  }

  // 微博凭据：weibo-cookies.json 不存在 → 停用并说明（不阻塞启动）；
  // 坏 JSON → loadWeiboCookies 抛 ConfigError，启动即失败。cookie 值绝不进日志。
  const weiboCookies = loadWeiboCookies(resolve(projectRoot, 'weibo-cookies.json'));
  weiboCookieImported = weiboCookies != null;
  if (!weiboCookies) {
    log.info('未导入 weibo-cookies.json，微博时间线停用（可在面板扫码登录生成，其他功能不受影响）');
  } else if (!app.weibo.enabled) {
    log.info('weibo-cookies.json 存在，但 config 里 weibo.enabled=false，跳过微博时间线');
  } else {
    log.info(`微博时间线：间隔 ${app.weibo.intervalSec}s`);
    startWeiboFeed(weiboCookieHeader(weiboCookies));
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
        const weiboState: PlatformStatus['state'] = !weiboCookieImported
          ? 'none'
          : weiboLogin === null ? 'imported' : weiboLogin.loggedIn ? 'ok' : 'expired';
        return {
          startedAt,
          notifiers: dispatcher.channels,
          watchedCount: db.listWatchedUids().length,
          liveCount: db.countLiveRooms(),
          platforms: [
            { key: 'bili', name: 'B站', state: biliState, mid: biliLogin?.mid ?? null },
            // mid 字段复用：微博存登录态心跳带出的 uid
            { key: 'weibo', name: '微博', state: weiboState, mid: weiboLogin?.uid ?? null },
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
          if (app.dynamic.enabled) {
            log.info('扫码登录成功，热重启动态轮询');
            startDynamic(cookieHdr);
          }
        },
      },
      weiboAuth: {
        cookiePath: resolve(projectRoot, 'weibo-cookies.json'),
        onCookiesSaved: (cookieHdr) => {
          weiboCookieImported = true;
          weiboLogin = null; // 新 cookie 还没心跳，先按 imported 展示
          if (app.weibo.enabled) {
            log.info('微博扫码登录成功，热重启微博时间线');
            startWeiboFeed(cookieHdr);
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
    dynamicSrc?.stop();
    weiboFeedSrc?.stop();
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
