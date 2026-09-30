import { loadConfig, ConfigError, projectRoot } from './config/index.js';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { makeLogger } from './logger.js';
import { Db } from './core/db.js';
import { Bus } from './core/bus.js';
import { Pipeline } from './core/pipeline.js';
import { toLiveEvent } from './core/types.js';
import { AnalysisQueue } from './analysis/queue.js';
import { RulesClassifier } from './analysis/classifier.js';
import { createLlmRouter, listLlmProviders, saveLlmProviders, isLlmEnabled, dbKeysOf } from './analysis/providers.js';
import { OncePerSessionRule } from './rules/once-per-session.js';
import { NotifyDispatcher } from './notify/dispatcher.js';
import { OneBotNotifier } from './notify/onebot.js';
import {
  NapcatWatchdog, readOnebotEndpoint, probeNapCat, getNapcatConfig, saveNapcatConfig,
  effectiveNapcatDir, defaultNapcatDir,
  ensureNapcatEntry,
  napcatRelaunchDriver, isNapcatTaskRegistered, setupNapcatTask, launchNapcatViaTask, NAPCAT_TASK_NAME,
} from './notify/napcat.js';
import { ToastNotifier } from './notify/toast.js';
import { ensureToastAumid } from './notify/aumid.js';
import { ensureMacNotifier } from './notify/mac-notifier.js';
import { liveEventToMessage } from './notify/message.js';
import { LiveStatusSource } from './sources/bili/live-status-source.js';
import { fetchLiveStatus } from './sources/bili/live-status.js';
import { KeyframeCache } from './sources/media/keyframe.js';
import { PeriodicTask } from './core/scheduler.js';
import { loadCookies, cookieHeader, type SelfInfo } from './sources/bili/auth.js';
import { FollowsSource } from './sources/bili/follows.js';
import { DynamicSource } from './sources/bili/dynamic.js';
import { createPanelServer, type PlatformStatus, type PanelDeps } from './panel/server.js';
import { createWeiboResolver } from './sources/weibo/resolve.js';
import { loadWeiboCookies, weiboCookieHeader, type WeiboSelfInfo } from './sources/weibo/auth.js';
import { WeiboFeedSource } from './sources/weibo/feed.js';
import {
  emptyWeiboFeedSnapshot, type WeiboFeedSnapshot,
} from './core/weibo-accounts.js';
import type { NewPushChannel } from './core/push.js';
import { isListenEnabled, shouldRunListen } from './core/listen.js';
import { getRuntimeConfig, withRuntimeConfig } from './core/runtime-config.js';
import { seedOnboardingDefaults } from './core/onboarding.js';
import type { Server } from 'node:http';
import type { Notifier } from './notify/types.js';
import {
  emptyXStatus, getXConfig, invalidateXStatus, isSavedConfigTest, saveXConfig, type XStatus,
} from './core/x-config.js';
import { parseInstanceList } from './core/proxy.js';
import {
  DEFAULT_PROBE_SCREEN, probeAll, probeInstances, probeProxy, probeVerdict, probeWeb,
  type InstanceProbe, type ProxyProbe, type WebProbe,
} from './sources/twitter/probe.js';
import { TwitterFeedSource } from './sources/twitter/feed.js';
import { PostAnalyzer } from './analysis/post-analyzer.js';
import { verifyAccount } from './sources/twitter/web.js';
import { emptyXFeedSnapshot } from './core/x-config.js';

const log = makeLogger('main');

interface Args {
  dryRun: boolean;
  testNotify: boolean;
  probe: boolean;
  probeLlm: boolean;
  probeX: boolean;
  /** --probe-x 的探测账号（免登录路线用），缺省用调研基准账号 */
  probeScreen: string;
  napcatSetup: boolean;
  forceUids: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dryRun: false, testNotify: false, probe: false, probeLlm: false, probeX: false,
    probeScreen: DEFAULT_PROBE_SCREEN, napcatSetup: false, forceUids: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--test-notify') args.testNotify = true;
    else if (a === '--probe') args.probe = true;
    else if (a === '--probe-llm') args.probeLlm = true;
    else if (a === '--probe-x') args.probeX = true;
    else if (a === '--x-screen') {
      const v = argv[++i];
      if (v) args.probeScreen = v.trim().replace(/^@+/, '');
    } else if (a === '--napcat-setup') args.napcatSetup = true;
    else if (a === '--force-uid') {
      const v = argv[++i];
      if (v) args.forceUids.push(...v.split(',').map((s) => s.trim()).filter(Boolean));
    }
  }
  return args;
}

/**
 * X 链路上次探测快照：`GET /api/x` 只读它，绝不在读取路径上打网络
 * （面板会周期轮询这张卡，探测必须由「测试」按钮或 CLI 显式触发）。
 */
let xStatus: XStatus = emptyXStatus();

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { app, secrets } = loadConfig();

  // --napcat-setup 一次性提权设置：创建「最高权限」计划任务（弹一次 UAC），
  // 之后看门狗用 schtasks /run 静默拉起 NapCat。与面板「失活自动拉起」开关等效
  // （会一并把 napcat_autorestart 置 1）。做完即退出，不启动主流程。
  if (args.napcatSetup) {
    if (process.platform !== 'win32') {
      log.error('--napcat-setup 目前仅支持 Windows（macOS 无需提权任务，直接开「失活自动拉起」即可）');
      process.exit(1);
    }
    // 生效配置在 settings 表（面板 NapCat 卡片）
    const setupDb = new Db(secrets.dbPath);
    const nc = getNapcatConfig(setupDb);
    if (!nc.enabled || !nc.dir || !/^\d+$/.test(nc.uin)) {
      log.error('NapCat 未配置：请在面板 NapCat 卡片启用并填写一键包目录与机器人 QQ');
      process.exit(1);
    }
    const ep = await ensureNapcatEntry(nc.dir, nc.uin);
    if (ep) {
      log.info(`dd-claw 专属条目就绪: ${ep.baseUrl}（自动管理端口，其他服务条目不受影响）`);
    } else {
      log.warn(`无法在 ${nc.dir} 读取/创建 onebot11 配置，请检查 NapCat 路径`);
    }
    if (await isNapcatTaskRegistered()) {
      log.info(`计划任务 "${NAPCAT_TASK_NAME}" 已存在，将重建以更新路径/uin`);
    }
    await setupNapcatTask(nc.dir, nc.uin, join(projectRoot, 'data'));
    saveNapcatConfig(setupDb, { autorestart: true });
    log.info(`计划任务 "${NAPCAT_TASK_NAME}" 创建成功，失活自动拉起已开启（UAC 只弹这一次）`);
    // 试拉验证：当前不在线就触发一次
    const probe = ep ? await probeNapCat(ep) : null;
    if (probe?.state === 'ok') {
      log.info(`NapCat 当前在线（QQ ${probe.loggedIn ? '已登录' : '未登录'}），无需拉起`);
    } else if (probe?.state === 'down') {
      if (await launchNapcatViaTask()) log.info('已通过计划任务试拉起 NapCat，请稍候确认 QQ 登录');
      else log.error('试拉起失败');
    } else if (probe?.state === 'conflict' && ep) {
      log.warn(`端口 ${new URL(ep.baseUrl).port} 被其他程序占用，请在 NapCat webui 改端口（DD-claw 会自动跟随）`);
    }
    setupDb.close();
    return;
  }

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

  // --probe-x 验证 X/推特 这条独立链路：代理 → Nitter 实例 → 免登录回退路线。
  // 只探测、不落库、不发信号。它是 docs/research/twitter.md §7 待验证清单的执行器：
  // 实例存活与页面结构是本方案最大的时效性风险，「今天还能不能用」必须能一条命令回答。
  if (args.probeX) {
    const probeDb = new Db(secrets.dbPath);
    const cfg = getXConfig(probeDb);
    probeDb.close();
    log.info(`X 探测：代理 ${cfg.proxyUrl || '(未配置)'} · 实例 ${cfg.instances.join(', ') || '(空)'} · 账号 @${args.probeScreen}`);
    const report = await probeAll(cfg, args.probeScreen);
    log.info(`  [代理]   ${report.proxy.ok ? 'OK  ' : 'FAIL'} ${report.proxy.message}`);
    for (const i of report.instances) log.info(`  [实例]   ${i.ok ? 'OK  ' : 'FAIL'} ${i.host} — ${i.message}`);
    if (report.web) log.info(`  [免登录] ${report.web.ok ? 'OK  ' : 'FAIL'} ${report.web.message}`);
    else log.info('  [免登录] SKIP（x.com 经代理不通；该路线整条压在 x.com 上，与实例路线相互独立）');
    const verdict = probeVerdict(report);
    log.info(`结论：${verdict.message}`);
    if (!verdict.usable) process.exitCode = 1;
    return;
  }

  // --probe-llm 验证 LLM 接线：列出 provider 状态 + 向 text 路由发一个 ping。
  // vision 路由只报可用性（没有真实图就不消耗多模态额度），填了 key 后跑这个确认链路
  if (args.probeLlm) {
    // 口径与主流程一致：开库读面板配置（provider 名单 / 总开关 / key / 超时熔断参数）
    const probeDb = new Db(secrets.dbPath);
    if (!isLlmEnabled(probeDb)) {
      log.error('LLM 未启用：在控制面板的 LLM 卡片打开总开关');
      process.exit(1);
    }
    const router = createLlmRouter(
      { ...withRuntimeConfig(app, getRuntimeConfig(probeDb)).llm, providers: listLlmProviders(probeDb) },
      dbKeysOf(probeDb),
    );
    probeDb.close();
    log.info('LLM provider 状态:');
    for (const s of router.describe()) {
      log.info(
        `  ${s.name} (${s.model}${s.vision ? ', 多模态' : ''}) ` +
        `路由=[${s.routes.join(',') || '无'}] ${s.status}`,
      );
    }
    try {
      const raw = await router.completeJson({
        messages: [{ role: 'user', content: '只回复这个 JSON：{"pong": true}' }],
        maxTokens: 64,
        jsonSchema: {
          name: 'pong',
          schema: {
            type: 'object',
            properties: { pong: { type: 'boolean' } },
            required: ['pong'],
            additionalProperties: false,
          },
        },
      });
      log.info(`text 路由 ping 成功: ${JSON.stringify(raw)}`);
    } catch (e) {
      log.error('text 路由 ping 失败', e);
      process.exit(1);
    }
    return;
  }

  const db = new Db(secrets.dbPath);

  // 发布后首启默认值：空表才种入分类/推送规则/「系统通知」渠道（settings 一次性闸门，
  // 用户清空后不复活）。默认值由 npm run demo:fixtures 归一化生成。
  seedOnboardingDefaults(db);

  // LLM：provider 名单与 key 的唯一信源是 settings 表（面板 LLM 卡片管理）；
  // 路由由名单自动推导（顺序 = 优先级）。超时/熔断参数读 settings（面板 LLM 卡「高级」）。
  // 面板改名单 → onProvidersChanged 重建 router；改 key → refreshKeys。均免重启。
  const llmKeysOf = dbKeysOf(db);
  const llmDep: NonNullable<PanelDeps['llm']> = {
    store: {
      list: () => listLlmProviders(db),
      save: (ps) => saveLlmProviders(db, ps),
    },
  };
  llmDep.onProvidersChanged = () => {
    llmDep.router = createLlmRouter(
      { ...withRuntimeConfig(app, getRuntimeConfig(db)).llm, providers: listLlmProviders(db) },
      llmKeysOf,
    );
  };
  llmDep.onProvidersChanged();

  // 运行时参数（轮询间隔/告警阈值/冷启动推送/LLM 超时熔断）：
  // settings 表唯一信源（面板各模块卡：监听「抓取设置」/ LLM「高级」/ 推送渠道「推送设置」）；
  // eff = 代码默认值叠加 settings 后的生效配置，sources/router/装配闸门都消费它
  let eff = withRuntimeConfig(app, getRuntimeConfig(db));

  // 通道装配：没有通道级开关（原 QQ/系统通知 两开关已删除——想关走推送渠道卡的
  // 渠道启停，见 push_channels.enabled）；装配恒尝试：onebot 端点只读跟随 NapCat
  // 自己的 onebot11 配置（dd-claw 专属条目，缺了自动创建、被占自动换），发现失败 =
  // 降级不装配（没配 QQ 是正常状态）；toast 恒装配。不阻塞主流程
  let onebotNotifier: OneBotNotifier | null = null;
  const buildOnebot = async (): Promise<OneBotNotifier | null> => {
    const nc = getNapcatConfig(db);
    const dir = effectiveNapcatDir(db);
    // 端点只读跟随 NapCat 自己的 onebot11 配置（dd-claw 专属条目，缺了自动创建）；
    // macOS 与 Windows 共用同一套发现逻辑（NapCat Mac 版配置结构一致）。
    // 看门狗双平台运行（热跟随 + 探测 + 自动拉起由「失活自动拉起」开关与 driver 决定）
    const discovered = nc.enabled && dir && nc.uin
      ? (readOnebotEndpoint(dir, nc.uin) ?? await ensureNapcatEntry(dir, nc.uin))
      : null;
    if (!discovered) {
      log.error('未能从 NapCat 配置发现端点（面板 NapCat 卡片未配置？），QQ 推送暂不装配');
      return null;
    }
    log.info(`onebot 端点跟随 NapCat 配置: ${discovered.baseUrl}`);
    return new OneBotNotifier(discovered.baseUrl, discovered.token);
  };
  let toastAumid: string | undefined; // ensureToastAumid 幂等，热切换复用
  const macNotifierDir = join(dirname(secrets.dbPath), 'cache', 'mac-notify');
  let macHelper: string | null | undefined; // undefined = 尚未尝试编译
  const buildToast = async (): Promise<ToastNotifier> => {
    toastAumid ??= await ensureToastAumid();
    if (macHelper === undefined) {
      macHelper = process.platform === 'darwin' ? await ensureMacNotifier(macNotifierDir) : null;
    }
    return new ToastNotifier(toastAumid, join(dirname(secrets.dbPath), 'cache', 'toast'), { macHelper });
  };
  const buildNotifiers = async (): Promise<Notifier[]> => {
    const list: Notifier[] = [];
    onebotNotifier = await buildOnebot();
    if (onebotNotifier) list.push(onebotNotifier);
    list.push(await buildToast());
    return list;
  };

  const notifiers = await buildNotifiers();
  if (notifiers.length === 0) {
    log.warn('当前没有任何推送通道可用（面板推送渠道卡可配置通道）；追踪与分析照常');
  }

  const dispatcher = new NotifyDispatcher(notifiers, db, args.dryRun);
  log.info(`推送通道: ${dispatcher.channels.join(', ')}${args.dryRun ? '  [dry-run]' : ''}`);

  // 测试推送：假消息走完整推送链路（--test-notify 与面板「测试推送渠道」共用）
  const sendTestPush = async (): Promise<{ total: number; succeeded: number }> => {
    const fake = liveEventToMessage(toLiveEvent({
      uid: '7706705', roomId: '80397', uname: '阿梓从小就很可爱',
      title: '[DD-claw 测试] 这是一条测试通知', isLive: true,
      liveTime: Math.floor(Date.now() / 1000), areaName: '虚拟主播',
      parentAreaName: '虚拟主播', cover: '',
      keyframe: 'https://i0.hdslb.com/bfs/live-key-frame/keyframe08052341000000080397it5906.jpg',
      face: 'https://i2.hdslb.com/bfs/face/bd4253b0eb80684a86efa0097935004527bcc773.jpg',
    }, '测试'));
    // onebot 常规发送只看 msg.targets：测试目标取 push_channels 表里的启用 QQ 渠道
    fake.targets = db.listPushChannels()
      .filter((c) => c.notifier === 'onebot' && c.enabled && c.targetType && c.targetId)
      .map((c) => ({ type: c.targetType!, id: c.targetId! }));
    const r = await dispatcher.broadcast(fake);
    return { total: r.total, succeeded: r.succeeded };
  };

  // --test-notify 用一条假消息走完整推送链路，验证 NapCat 配置与消息格式
  if (args.testNotify) {
    await sendTestPush();
    db.close();
    return;
  }

  // 装配：bus → pipeline（编排唯一入口）→ sources（只产信号）
  // 分类器：router 用 getter 每轮取最新（面板改名单热重建），LLM 总开关读 settings
  const bus = new Bus();
  const pipeline = new Pipeline({
    bus,
    db,
    config: eff,
    queue: new AnalysisQueue(
      new RulesClassifier(db, () => llmDep.router ?? null, () => isLlmEnabled(db)), 2,
    ),
    rule: new OncePerSessionRule(db),
    dispatcher,
    // X 图必须先经代理落到本地（NapCat 在同一墙内网络里拉不到 pbs.twimg.com）——
    // 与 toast 的自有缓存分开，避免两边的过期策略互相打架
    imageCacheDir: join(dirname(secrets.dbPath), 'cache', 'images'),
    // 图文帖的 LLM 判定/翻译：与分类器共用同一个 router getter 与总开关
    postAnalyzer: new PostAnalyzer(() => llmDep.router ?? null, () => isLlmEnabled(db)),
  });
  pipeline.attach();

  // NapCat 是否自己跑通过：<dir>/config 存在 = 至少成功启动过一次（onebot11/webui 配置
  // 由 NapCat 自己生成，DD-claw 只读改）。没跑通时拉起是空头支票（QQ 从未登录，快速登录
  // 无从谈起），自动拉起与手动拉起都在此闸住并给出指引
  const napcatConfigReady = (dir: string): boolean => dir !== '' && existsSync(join(dir, 'config'));
  const napcatNotReadyMessage = (platform: NodeJS.Platform): string =>
    platform === 'win32'
      ? 'NapCat 尚未跑通：先在该目录手动运行一次 launcher.bat 并登录 QQ'
      : 'NapCat 尚未跑通：先打开一次 QQ 并登录';

  // NapCat 看门狗：双平台运行（Windows 计划任务 / macOS open QQ）。生效配置
  // （settings 唯一信源）「使用 NapCat 通道」开时周期探测（60s）；「失活自动拉起」
  // 开关每 tick 重取（面板改了热生效），关 = 只探测/告警/热跟随绝不拉起。
  // dir/uin 每 tick 重取；端点热跟随 NapCat 自己的 onebot11 配置。告警走 bus
  // health_alert → alertAll（toast 本机通知；登录掉线/持续失败超 10 分钟另报告警 QQ）
  let napcatTask: PeriodicTask | undefined;
  let napcatWatchdog: NapcatWatchdog | undefined;
  const napcatDriver = napcatRelaunchDriver();
  const reconcileNapcat = (): void => {
    const nc = getNapcatConfig(db);
    const shouldRun = nc.enabled && onebotNotifier !== null;
    if (shouldRun === (napcatTask !== undefined)) return;
    if (shouldRun) {
      napcatWatchdog ??= new NapcatWatchdog({
        target: () => {
          const c = getNapcatConfig(db);
          return { dir: c.dir, uin: c.uin };
        },
        autoRestart: () => getNapcatConfig(db).autorestart,
        driver: napcatDriver,
        onEndpoint: (ep) => onebotNotifier!.updateEndpoint(ep.baseUrl, ep.token),
        alert: (message) => bus.emit({
          source: 'napcat', kind: 'health_alert', uid: '', roomId: '',
          ts: Math.floor(Date.now() / 1000), payload: { message },
        }),
      });
      napcatTask = new PeriodicTask({
        name: 'napcat-watchdog', intervalSec: 60, jitterSec: 10,
        run: () => napcatWatchdog!.tick(),
      });
      napcatTask.start();
      log.info(
        `NapCat 看门狗已启动（${nc.dir}，快速登录 ${nc.uin}，` +
        `自动拉起 ${nc.autorestart ? '开' : '关'}）`,
      );
    } else {
      napcatTask?.stop();
      napcatTask = undefined;
      log.info('NapCat 看门狗已停止（「使用 NapCat 通道」关闭 / onebot 停用）');
    }
  };
  reconcileNapcat();

  // live-status source 单独持有：轮询参数热更新时整体重启（restore 从库恢复状态，不丢轨迹）
  // 在播关键帧定时缓存：目录跟随 data 约定（与 toast 缓存同法拼）；开关/间隔事实来源
  // 是 settings（RuntimeConfig，面板监听卡「抓取设置」），初始与热更新都走 configure；
  // 实例总是创建并跨 liveSrc 重启复用（source 重建不丢间隔/去重记忆）
  const keyframeDir = join(dirname(secrets.dbPath), 'cache', 'keyframes');
  const keyframeCache = new KeyframeCache(db, {
    dir: keyframeDir,
    intervalMs: eff.keyframe.intervalSec * 1000,
  });
  keyframeCache.configure({ enabled: eff.keyframe.enabled, intervalMs: eff.keyframe.intervalSec * 1000 });
  let liveSrc = new LiveStatusSource({ forceUids: args.forceUids, keyframeCache });
  const startLiveStatus = (): void => {
    liveSrc.start({ bus, db, config: eff });
  };
  const restartLiveStatus = (): void => {
    liveSrc.stop();
    liveSrc = new LiveStatusSource({ forceUids: args.forceUids, keyframeCache });
    startLiveStatus();
  };

  // follows / dynamic source 单独持有（不放 sources 数组）：扫码登录后要热重启，
  // shutdown 时 stop 的必须是最新实例
  let followsSrc: FollowsSource | null = null;
  let dynamicSrc: DynamicSource | null = null;
  let biliLogin: SelfInfo | null = null;
  let cookieImported = false;
  let biliCookieHdr: string | null = null;
  const startFollows = (cookieHdr: string): void => {
    followsSrc?.stop();
    followsSrc = new FollowsSource({
      cookie: cookieHdr,
      onLoginState: (s) => { biliLogin = s; },
    });
    followsSrc.start({ bus, db, config: eff });
  };
  const biliAvatarDir = join(dirname(secrets.dbPath), 'cache', 'bili-avatars');
  const startDynamic = (cookieHdr: string): void => {
    dynamicSrc?.stop();
    // 登录态心跳在 DynamicSource 内部：关注同步未运行时这是 B站登录态来源之一。
    // 图文页「监听动态」开关只管 bili_accounts（动态账号）部分：源内每轮读取、热切换免重启；
    // 监听主播的空间动态归档随登录常开（预告分析等要用），装配处不再看 listen_dynamic
    dynamicSrc = new DynamicSource({
      cookie: cookieHdr,
      avatarDir: biliAvatarDir,
      onLoginState: (s) => { biliLogin = s; },
      biliAccountsEnabled: () => isListenEnabled(db, 'dynamic', true),
    });
    dynamicSrc.start({ bus, db, config: eff });
  };
  const stopDynamic = (): void => { dynamicSrc?.stop(); dynamicSrc = null; };
  // 有 cookie 未心跳先按已登录（源会自校正），心跳后按真实值
  const biliLoggedIn = (): boolean => cookieImported && (biliLogin === null ? true : biliLogin.isLogin);

  // weibo feed source 同样单独持有：扫码登录后要热重启；名单/间隔变了也要（新增账号立刻抓）
  let weiboFeedSrc: WeiboFeedSource | null = null;
  let weiboLogin: WeiboSelfInfo | null = null;
  let weiboCookieImported = false;
  let weiboCookieHdr: string | null = null;
  let weiboStatus: WeiboFeedSnapshot = emptyWeiboFeedSnapshot();
  let weiboFeedKey = '';
  const weiboAvatarDir = join(dirname(secrets.dbPath), 'cache', 'weibo-avatars');
  const weiboImageDir = join(dirname(secrets.dbPath), 'cache', 'weibo-images');
  const weiboFeedKeyNow = (): string =>
    [String(eff.weibo.intervalSec), db.listWeiboAccounts(true).map((a) => a.uid).join(',')].join('|');
  const startWeiboFeed = (cookieHdr: string): void => {
    weiboFeedSrc?.stop();
    weiboFeedSrc = new WeiboFeedSource({
      cookie: cookieHdr,
      avatarCacheDir: weiboAvatarDir,
      onLoginState: (s) => { weiboLogin = s; },
      onStatus: (s) => { weiboStatus = s; },
    });
    weiboFeedSrc.start({ bus, db, config: eff });
    weiboFeedKey = weiboFeedKeyNow();
  };
  const stopWeiboFeed = (): void => {
    weiboFeedSrc?.stop();
    weiboFeedSrc = null;
    weiboFeedKey = '';
    weiboStatus = { ...emptyWeiboFeedSnapshot(), running: false };
  };
  const weiboLoggedIn = (): boolean =>
    weiboCookieImported && (weiboLogin === null ? true : weiboLogin.loggedIn);

  // X/推特源（独立分页 + 独立名单）：X 没有登录态，它的运行前提是「代理已配置」。
  // 参数指纹一变就重启——代理/实例/回退/间隔/名单任何一项改动都要立刻生效。
  // 头像缓存目录跟随 data 约定（与 toast/关键帧缓存同法拼），面板经 /api/x-avatar 读
  const xAvatarDir = join(dirname(secrets.dbPath), 'cache', 'x-avatars');
  let xFeedSrc: TwitterFeedSource | null = null;
  let xFeedKey = '';
  const xProxyConfigured = (): boolean => getXConfig(db).proxyUrl.trim() !== '';
  const xConfigKey = (): string => {
    const c = getXConfig(db);
    // 名单（启用账号的 screen name）也在指纹里：加/删/停用账号 → 重启源，PeriodicTask 首轮立即跑
    const accounts = db.listXAccounts(true).map((a) => a.screenName).join(',');
    return [c.proxyUrl, c.instances.join(','), String(c.fallbackHtml), String(c.intervalSec), accounts].join('|');
  };
  const startXFeed = (): void => {
    const cfg = getXConfig(db);
    xFeedSrc?.stop();
    xFeedSrc = new TwitterFeedSource({
      proxyUrl: cfg.proxyUrl,
      instances: cfg.instances,
      fallbackHtml: cfg.fallbackHtml,
      intervalSec: cfg.intervalSec,
      jitterSec: eff.pollJitterSec,
      healthAlertAfterFailures: eff.healthAlertAfterFailures,
      avatarCacheDir: xAvatarDir,
      onStatus: (s) => { xStatus = { ...xStatus, feed: s }; },
    });
    xFeedSrc.start({ bus, db, config: eff });
    xFeedKey = xConfigKey();
  };
  const stopXFeed = (): void => {
    xFeedSrc?.stop();
    xFeedSrc = null;
    xFeedKey = '';
    xStatus = { ...xStatus, feed: { ...emptyXFeedSnapshot(), running: false } };
  };

  // 动态 / 微博 / X 三个源的启停唯一入口：面板监听开关 + 各自运行前提共同决定
  const reconcileListen = (): void => {
    // 动态源：B站登录即常开——添加监听直播永远附赠主播动态归档（直播预告分析等要用它，
    // 2026-09-20 拆分决策）；「监听动态」开关（listen_dynamic）只管 bili_accounts 的轮询，
    // 由源内 biliAccountsEnabled 回调每轮读取，这里无需启停
    if (biliCookieHdr !== null) {
      if (!dynamicSrc) {
        log.info(`动态轮询：${db.listWatchedUids().length} 个监听对象，间隔 ${eff.dynamic.intervalSec}s`);
        startDynamic(biliCookieHdr);
      }
    } else if (dynamicSrc) {
      log.info('动态轮询已停止（无 cookie）');
      stopDynamic();
    }
    // 微博：开关 × 有 cookie × 名单非空；名单/间隔变了就地重启（新增账号要立刻抓）
    const weiboAccounts = db.listWeiboAccounts(true).length;
    if (shouldRunListen(db, 'weibo', weiboCookieHdr !== null) && weiboAccounts > 0) {
      if (!weiboFeedSrc) {
        log.info(`微博时间线：${weiboAccounts} 个账号，间隔 ${eff.weibo.intervalSec}s`);
        startWeiboFeed(weiboCookieHdr!);
      } else if (weiboFeedKey !== weiboFeedKeyNow()) {
        log.info('微博时间线参数已热更新（间隔 / 名单）');
        startWeiboFeed(weiboCookieHdr!);
      }
    } else if (weiboFeedSrc) {
      log.info('微博时间线已停止（面板开关关闭 / 无 cookie / 名单为空）');
      stopWeiboFeed();
    }
    // X：开关 × 代理已配置 × 名单非空；参数变了就地重启
    const xAccounts = db.listXAccounts(true).length;
    if (shouldRunListen(db, 'twitter', xProxyConfigured()) && xAccounts > 0) {
      if (!xFeedSrc) {
        log.info(`X 时间线：${xAccounts} 个账号，间隔 ${getXConfig(db).intervalSec}s`);
        startXFeed();
      } else if (xFeedKey !== xConfigKey()) {
        log.info('X 时间线参数已热更新（代理 / 实例 / 回退 / 间隔 / 名单）');
        startXFeed();
      }
    } else if (xFeedSrc) {
      log.info('X 时间线已停止（面板开关关闭 / 未配置代理 / 名单为空）');
      stopXFeed();
    }
  };

  // 高级设置热生效（面板 /api/advanced 保存后回调）：间隔/阈值变化重启对应源，
  // LLM 超时熔断变化重建 router，关键帧开关/间隔走 configure。开关类（冷启动推送）
  // 由 pipeline 直读 settings，无需这里处理。无通道开关——装配恒定，通道启停走渠道卡
  const reconcileRuntime = (): void => {
    const prev = eff;
    eff = withRuntimeConfig(app, getRuntimeConfig(db));
    if (prev.keyframe.enabled !== eff.keyframe.enabled
      || prev.keyframe.intervalSec !== eff.keyframe.intervalSec) {
      keyframeCache.configure({
        enabled: eff.keyframe.enabled,
        intervalMs: eff.keyframe.intervalSec * 1000,
      });
      log.info(`关键帧缓存参数已热更新（${eff.keyframe.enabled ? '开' : '关'}，间隔 ${eff.keyframe.intervalSec}s）`);
    }
    const thresholdChanged = prev.healthAlertAfterFailures !== eff.healthAlertAfterFailures;
    if (prev.pollIntervalSec !== eff.pollIntervalSec || prev.pollJitterSec !== eff.pollJitterSec || thresholdChanged) {
      log.info(`直播轮询参数已热更新（间隔 ${eff.pollIntervalSec}s + 抖动 ${eff.pollJitterSec}s，阈值 ${eff.healthAlertAfterFailures}）`);
      restartLiveStatus();
    }
    if (prev.follows.syncIntervalSec !== eff.follows.syncIntervalSec && followsSrc && biliCookieHdr) {
      log.info(`关注列表同步间隔已热更新（${eff.follows.syncIntervalSec}s）`);
      startFollows(biliCookieHdr);
    }
    if ((prev.dynamic.intervalSec !== eff.dynamic.intervalSec || thresholdChanged) && dynamicSrc) {
      log.info(`动态轮询参数已热更新（间隔 ${eff.dynamic.intervalSec}s）`);
      startDynamic(biliCookieHdr!);
    }
    if ((prev.weibo.intervalSec !== eff.weibo.intervalSec || thresholdChanged) && weiboFeedSrc) {
      log.info(`微博轮询参数已热更新（间隔 ${eff.weibo.intervalSec}s）`);
      startWeiboFeed(weiboCookieHdr!);
    }
    // X 源的告警阈值是构造时快照（startXFeed 传 opts），阈值变了也要重启它才能生效
    if (thresholdChanged && xFeedSrc) {
      log.info('X 时间线告警阈值已热更新');
      startXFeed();
    }
    if (prev.llm.requestTimeoutMs !== eff.llm.requestTimeoutMs
      || prev.llm.circuitThreshold !== eff.llm.circuitThreshold
      || prev.llm.circuitCooldownMs !== eff.llm.circuitCooldownMs) {
      llmDep.onProvidersChanged!();
      log.info('LLM 超时/熔断参数已热更新（router 已重建）');
    }
  };

  // 装配级重建：NapCat 配置热更新（面板保存）后重跑一次，让 onebot notifier 跟随
  const rebuildNotifiers = (): Promise<void> => buildNotifiers().then((list) => {
    dispatcher.setNotifiers(list);
    reconcileNapcat();
    log.info(`推送通道已热更新：${dispatcher.channels.join('/') || '无'}`);
  });

  // 凭据功能：cookies.json 不存在 → 停用并说明；坏 JSON → loadCookies 抛
  // ConfigError，启动即失败。cookie 值绝不进日志，只传拼好的 Cookie 头。
  const cookies = loadCookies(resolve(projectRoot, 'cookies.json'));
  cookieImported = cookies != null;
  if (!cookies) {
    log.info('未登录 B站，关注列表同步 / 动态轮询等凭据功能停用（匿名开播监听不受影响）');
  } else {
    const cookieHdr = cookieHeader(cookies);
    biliCookieHdr = cookieHdr;
    startFollows(cookieHdr); // 有 cookie 即跑（无单独开关；间隔在监听卡「抓取设置」）
  }

  // 微博凭据：weibo-cookies.json 不存在 → 停用并说明（不阻塞启动）；
  // 坏 JSON → loadWeiboCookies 抛 ConfigError，启动即失败。cookie 值绝不进日志。
  const weiboCookies = loadWeiboCookies(resolve(projectRoot, 'weibo-cookies.json'));
  weiboCookieImported = weiboCookies != null;
  if (!weiboCookies) {
    log.info('未登录微博，微博时间线停用（可在面板扫码登录，其他功能不受影响）');
  } else {
    weiboCookieHdr = weiboCookieHeader(weiboCookies);
  }

  startLiveStatus();
  reconcileListen();

  // 控制面板：辅助设施。EADDRINUSE 等错误走 'error' 事件，只记日志不影响主流程
  const startedAt = Math.floor(Date.now() / 1000);
  let panel: Server | undefined;
  if (app.panel.enabled) {
    panel = createPanelServer({
      db,
      weiboResolver: createWeiboResolver(),
      llm: llmDep,
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
          biliCookieHdr = cookieHdr;
          log.info('扫码登录成功，热重启关注列表同步');
          startFollows(cookieHdr);
          // 动态源由 reconcileListen 统一启停（startDynamic 内部会先停旧实例）
          reconcileListen();
        },
      },
      weiboAuth: {
        cookiePath: resolve(projectRoot, 'weibo-cookies.json'),
        onCookiesSaved: (cookieHdr) => {
          weiboCookieImported = true;
          weiboLogin = null; // 新 cookie 还没心跳，先按 imported 展示
          weiboCookieHdr = cookieHdr;
          // 微博源由 reconcileListen 统一启停（startWeiboFeed 内部会先停旧实例）
          reconcileListen();
        },
      },
      listen: {
        login: () => ({ bili: biliLoggedIn(), weibo: weiboLoggedIn(), twitter: xProxyConfigured() }),
        onChanged: () => reconcileListen(),
      },
      advanced: {
        onChanged: () => reconcileRuntime(),
      },
      // X / 推特 独立分页：连接设置 + 连通性测试（P0 无源，故 onChanged 暂无热生效对象）
      x: {
        info: () => ({ config: getXConfig(db), status: xStatus }),
        save: (patch) => {
          const prev = getXConfig(db);
          saveXConfig(db, patch);
          const next = getXConfig(db);
          // 配置变了 → 相关旧结论失效（否则改好代理地址后，卡片仍配着上一轮的红点）
          xStatus = invalidateXStatus(xStatus, prev, next);
          return next;
        },
        test: async (testReq) => {
          const cfg = getXConfig(db);
          // 覆盖值优先：面板允许「先测后存」，输入框内容可以先验证再落库
          const proxyUrl = testReq.proxyUrl !== undefined ? testReq.proxyUrl : cfg.proxyUrl;
          const instances = testReq.instances !== undefined ? parseInstanceList(testReq.instances) : cfg.instances;
          const screen = testReq.screenName ? testReq.screenName : DEFAULT_PROBE_SCREEN;
          const want = testReq.target;
          const proxyResult: ProxyProbe | null = want === 'all' || want === 'proxy' ? await probeProxy(proxyUrl) : null;
          const instanceResults: InstanceProbe[] | null =
            want === 'all' || want === 'instances' ? await probeInstances(instances, proxyUrl, screen) : null;
          const webResult: WebProbe | null =
            want === 'all' || want === 'web' ? await probeWeb(screen, proxyUrl) : null;

          const nowSec = Math.floor(Date.now() / 1000);
          // 只有「测的就是已保存配置」才更新卡片快照；未保存值的测试结果只在弹窗里就地显示
          if (!isSavedConfigTest(testReq, cfg)) {
            return { proxy: proxyResult, instances: instanceResults, web: webResult, status: xStatus };
          }
          const next: XStatus = { ...xStatus, updatedAt: nowSec };
          if (proxyResult) next.proxy = { ok: proxyResult.ok, message: proxyResult.message, checkedAt: nowSec };
          if (instanceResults) {
            next.instances = instanceResults.map((i) => ({ host: i.host, ok: i.ok, message: i.message }));
          }
          if (webResult) next.web = { ok: webResult.ok, message: webResult.message, checkedAt: nowSec };
          xStatus = next;

          return {
            proxy: proxyResult,
            instances: instanceResults,
            web: webResult,
            status: next,
          };
        },
        onChanged: () => {
          // 连接设置或账号名单变了 → 走同一个启停入口（参数指纹变化会就地重启源）
          reconcileListen();
        },
        // 添加账号后的即时首拉（全量轮要排队，单账号先拉一次；去重靠 posts UNIQUE 兜底）
        kickAccount: async (screenName) => { await xFeedSrc?.kickAccount(screenName); },
        verify: (screenName) => verifyAccount(screenName, getXConfig(db).proxyUrl),
      },
      snapshots: { dir: keyframeDir },
      xAvatars: { dir: xAvatarDir },
      weiboAvatars: { dir: weiboAvatarDir },
      biliAvatars: { dir: biliAvatarDir },
      weiboImages: { dir: weiboImageDir },
      biliFeed: {
        // 添加动态账号后即时首拉（动态源间隔默认 300s，等下一轮太久）；
        // 源没在跑（无 cookie / 开关关）时跳过，等 reconcileListen 启停后的首轮
        kickAccount: async (uid) => { await dynamicSrc?.kickAccount(uid); },
      },
      weibo: {
        // GET 只读快照（面板每分钟轮询这张卡，绝不打网络）；间隔取自 settings（与 /api/advanced 同一份）
        info: () => ({
          config: { intervalSec: getRuntimeConfig(db).weiboIntervalSec },
          status: { feed: weiboStatus, accounts: db.listWeiboAccounts(true).length },
        }),
        onChanged: () => reconcileListen(),
        // 添加账号后的即时首拉（全量轮要排队，单账号先拉一次；去重靠 posts UNIQUE 兜底）
        kickAccount: async (uid) => { await weiboFeedSrc?.kickAccount(uid); },
      },
      testPush: () => sendTestPush(),
      napcat: {
        effective: () => ({ ...getNapcatConfig(db), dir: effectiveNapcatDir(db) }),
        platform: process.platform,
        source: () => ({
          enabled: db.getSetting('napcat_enabled') !== null ? 'panel' as const : 'config' as const,
          autorestart: db.getSetting('napcat_autorestart') !== null ? 'panel' as const : 'config' as const,
          dir: db.getSetting('napcat_dir') !== null ? 'panel' as const : (process.platform === 'darwin' ? 'default' as const : 'config' as const),
          uin: db.getSetting('napcat_uin') !== null ? 'panel' as const : 'config' as const,
        }),
        save: async (patch) => {
          const prev = getNapcatConfig(db);
          const prevDir = effectiveNapcatDir(db);
          // 合并 patch 后的生效值（patch.dir='' = 清空回落默认）。计划任务里钉死的是
          // 建任务那一刻的路径/QQ，所以下面两处「建/重建」都必须用合并值，
          // 不能读落库前的 settings（否则同一笔保存里改 dir + 开开关会钉旧路径）
          const nextDir = patch.dir !== undefined ? (patch.dir || defaultNapcatDir()) : prevDir;
          const nextUin = patch.uin !== undefined ? patch.uin : prev.uin;
          // 「失活自动拉起」开关：开启先建拉起能力（Windows 弹 UAC，macOS no-op），
          // 失败不落开关；关闭先落开关再彻底移除拉起任务。
          if (patch.autorestart === true && prev.autorestart !== true) {
            if (!nextDir || !/^\d+$/.test(nextUin)) throw new Error('先填好路径与机器人 QQ 号再开启自动拉起');
            if (!napcatConfigReady(nextDir)) throw new Error(napcatNotReadyMessage(napcatDriver.platform) + '，再开启自动拉起');
            await napcatDriver.setup(nextDir, nextUin, join(projectRoot, 'data'));
          } else if (prev.autorestart && patch.autorestart !== false
            && (nextDir !== prevDir || nextUin !== prev.uin)) {
            // 自动拉起已开时改路径/QQ：自动重建拉起任务（Windows 再弹一次 UAC），
            // 否则任务仍钉旧路径（失活拉起静默失败的来源）。新值不完整（清空中）
            // 则不重建，任务留旧配置，补全后再次保存时再触发
            if (nextDir && /^\d+$/.test(nextUin)) {
              await napcatDriver.setup(nextDir, nextUin, join(projectRoot, 'data'));
              log.info(`NapCat 路径/QQ 已变更，拉起任务已按新配置重建（${nextDir}，${nextUin}）`);
            } else {
              log.warn('NapCat 路径/QQ 变更后不完整，拉起任务保留旧配置（补全后再次保存会重建）');
            }
          }
          saveNapcatConfig(db, patch);
          if (patch.autorestart === false && prev.autorestart !== false) {
            await napcatDriver.remove();
          }
          // 配置变了重装配一次：开 NapCat 才建的 onebot notifier 立即生效，
          // 关掉则移除（通道启停不再有独立开关）
          void rebuildNotifiers();
          void napcatWatchdog?.tick();
        },
        state: async () => {
          const nc = getNapcatConfig(db);
          const dir = effectiveNapcatDir(db);
          const ep = dir && nc.uin ? readOnebotEndpoint(dir, nc.uin) : null;
          const [probeResult, taskRegistered] = await Promise.all([
            ep ? probeNapCat(ep) : Promise.resolve(null),
            napcatDriver.available(),
          ]);
          return { endpoint: ep?.baseUrl ?? null, probe: probeResult, taskRegistered, configReady: napcatConfigReady(dir) };
        },
        launch: async () => {
          const nc = getNapcatConfig(db);
          const dir = effectiveNapcatDir(db);
          if (!dir || !nc.uin) throw new Error('先填好路径与机器人 QQ 号');
          if (!napcatConfigReady(dir)) throw new Error(napcatNotReadyMessage(napcatDriver.platform));
          const ep = await ensureNapcatEntry(dir, nc.uin);
          if (ep) onebotNotifier?.updateEndpoint(ep.baseUrl, ep.token);
          // Windows：旧实例可能还在旧配置上跑（高权限进程只能经任务杀），先停再拉起；
          // macOS：open 拉起（QQ 已在跑则只是聚焦，无副作用）
          if (napcatDriver.platform === 'win32') {
            await napcatDriver.stop();
            await new Promise((r) => setTimeout(r, 3_000));
          }
          const ok = await napcatDriver.launch(nc.uin);
          if (!ok) {
            throw new Error(napcatDriver.platform === 'win32'
              ? '拉起失败：拉起任务未创建（开启「失活自动拉起」一次性创建，或跑 npm run napcat-setup）'
              : '拉起失败：open QQ 未成功（确认 /Applications/QQ.app 存在）');
          }
          void napcatWatchdog?.tick();
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
    napcatTask?.stop();
    liveSrc.stop();
    followsSrc?.stop();
    dynamicSrc?.stop();
    weiboFeedSrc?.stop();
    xFeedSrc?.stop();
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
