import { loadConfig, ConfigError } from './config/index.js';
import { makeLogger } from './logger.js';
import { Db } from './core/db.js';
import { Scheduler } from './core/scheduler.js';
import { toLiveEvent } from './core/types.js';
import { NoopAnalyzer } from './analysis/noop.js';
import { OncePerSessionRule } from './rules/once-per-session.js';
import { NotifyDispatcher } from './notify/dispatcher.js';
import { OneBotNotifier } from './notify/onebot.js';
import { ToastNotifier } from './notify/toast.js';
import { fetchLiveStatus } from './sources/bili/live-status.js';
import type { Notifier } from './notify/types.js';

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

  // --probe 只查一次开播状态，不碰 DB、不推送。用来确认接口通不通。
  if (args.probe) {
    const uids = args.forceUids.length > 0
      ? args.forceUids
      : app.subscriptions.filter((s) => s.enabled).map((s) => s.uid);
    log.info(`探测 ${uids.length} 个 uid: ${uids.join(', ')}`);
    const res = await fetchLiveStatus(uids);
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

  // --test-notify 用一条假事件走完整推送链路，验证 NapCat 配置与消息格式
  if (args.testNotify) {
    const fake = toLiveEvent({
      uid: '7706705', roomId: '80397', uname: '阿梓从小就很可爱',
      title: '[DD-claw 测试] 这是一条测试通知', isLive: true, rawLiveStatus: 1,
      liveTime: Math.floor(Date.now() / 1000), areaName: '虚拟主播',
      parentAreaName: '虚拟主播', cover: '',
      keyframe: 'https://i0.hdslb.com/bfs/live-key-frame/keyframe072918300018143727685jhbin.jpg',
    }, '测试');
    await dispatcher.broadcast(fake);
    db.close();
    return;
  }

  const scheduler = new Scheduler({
    config: app,
    db,
    analyzer: new NoopAnalyzer(),
    rule: new OncePerSessionRule(db),
    dispatcher,
    forceUids: args.forceUids,
  });

  const shutdown = (sig: string) => {
    log.info(`收到 ${sig}，停止中`);
    scheduler.stop();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await scheduler.start();
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
