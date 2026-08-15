import { loadConfig, ConfigError, projectRoot } from './config/index.js';
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
  ensureNapcatEntry,
  isNapcatTaskRegistered, setupNapcatTask, launchNapcatViaTask, stopNapcatViaTask, NAPCAT_TASK_NAME,
} from './notify/napcat.js';
import { ToastNotifier } from './notify/toast.js';
import { ensureToastAumid } from './notify/aumid.js';
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
import type { NewPushChannel } from './core/push.js';
import { shouldRunListen } from './core/listen.js';
import { getRuntimeConfig, withRuntimeConfig } from './core/runtime-config.js';
import type { Server } from 'node:http';
import type { Notifier } from './notify/types.js';

const log = makeLogger('main');

interface Args {
  dryRun: boolean;
  testNotify: boolean;
  probe: boolean;
  probeLlm: boolean;
  napcatSetup: boolean;
  forceUids: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, testNotify: false, probe: false, probeLlm: false, napcatSetup: false, forceUids: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--test-notify') args.testNotify = true;
    else if (a === '--probe') args.probe = true;
    else if (a === '--probe-llm') args.probeLlm = true;
    else if (a === '--napcat-setup') args.napcatSetup = true;
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

  // --napcat-setup 一次性提权设置：创建「最高权限」计划任务（弹一次 UAC），
  // 之后看门狗用 schtasks /run 静默拉起 NapCat。做完即退出，不启动主流程。
  if (args.napcatSetup) {
    if (process.platform !== 'win32') {
      log.error('--napcat-setup 目前仅支持 Windows');
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
    log.info(`计划任务 "${NAPCAT_TASK_NAME}" 创建成功（UAC 只弹这一次，之后自动拉起静默）`);
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
    const discovered = nc.enabled && process.platform === 'win32'
      ? (readOnebotEndpoint(nc.dir, nc.uin) ?? await ensureNapcatEntry(nc.dir, nc.uin))
      : null;
    if (!discovered) {
      log.error('未能从 NapCat 配置发现端点（面板 NapCat 卡片未配置？），QQ 推送暂不装配');
      return null;
    }
    log.info(`onebot 端点跟随 NapCat 配置: ${discovered.baseUrl}`);
    return new OneBotNotifier(discovered.baseUrl, discovered.token);
  };
  let toastAumid: string | undefined; // ensureToastAumid 幂等，热切换复用
  const buildToast = async (): Promise<ToastNotifier> => {
    toastAumid ??= await ensureToastAumid();
    return new ToastNotifier(toastAumid, join(dirname(secrets.dbPath), 'cache', 'toast'));
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

  // --test-notify 用一条假消息走完整推送链路，验证 NapCat 配置与消息格式
  if (args.testNotify) {
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
    await dispatcher.broadcast(fake);
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
  });
  pipeline.attach();

  // NapCat 看门狗：生效配置（settings 唯一信源）enabled 时周期探测（60s），
  // 不在线经计划任务自动拉起 + 快速登录；dir/uin 每 tick 重取（面板改了热生效）；
  // 端点热跟随 NapCat 自己的 onebot11 配置。告警走 bus health_alert →
  // alertAll（toast 本机通知；登录掉线/持续失败超 10 分钟另报告警 QQ）
  let napcatTask: PeriodicTask | undefined;
  let napcatWatchdog: NapcatWatchdog | undefined;
  const reconcileNapcat = (): void => {
    const nc = getNapcatConfig(db);
    const shouldRun = nc.enabled && onebotNotifier !== null && process.platform === 'win32';
    if (shouldRun === (napcatTask !== undefined)) return;
    if (shouldRun) {
      napcatWatchdog ??= new NapcatWatchdog({
        target: () => {
          const c = getNapcatConfig(db);
          return { dir: c.dir, uin: c.uin };
        },
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
      log.info(`NapCat 看门狗已启动（${nc.dir}，快速登录 ${nc.uin}）`);
      void isNapcatTaskRegistered().then((ok) => {
        if (!ok) {
          log.warn('NapCat 计划任务未创建，自动拉起不可用：面板 NapCat 卡片点「添加自动拉起任务」或跑 npm run napcat-setup 一次性设置');
        }
      });
    } else {
      napcatTask?.stop();
      napcatTask = undefined;
      log.info('NapCat 看门狗已停止（面板关闭 / onebot 停用）');
    }
  };
  if (getNapcatConfig(db).enabled && process.platform !== 'win32') {
    log.warn('napcat.enabled 目前仅支持 Windows，看门狗未启动');
  }
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
  const startDynamic = (cookieHdr: string): void => {
    dynamicSrc?.stop();
    // 登录态心跳在 DynamicSource 内部：关注同步未运行时这是 B站登录态来源之一
    dynamicSrc = new DynamicSource({
      cookie: cookieHdr,
      onLoginState: (s) => { biliLogin = s; },
    });
    dynamicSrc.start({ bus, db, config: eff });
  };
  const stopDynamic = (): void => { dynamicSrc?.stop(); dynamicSrc = null; };
  // 有 cookie 未心跳先按已登录（源会自校正），心跳后按真实值
  const biliLoggedIn = (): boolean => cookieImported && (biliLogin === null ? true : biliLogin.isLogin);

  // weibo feed source 同样单独持有：扫码登录后要热重启
  let weiboFeedSrc: WeiboFeedSource | null = null;
  let weiboLogin: WeiboSelfInfo | null = null;
  let weiboCookieImported = false;
  let weiboCookieHdr: string | null = null;
  const startWeiboFeed = (cookieHdr: string): void => {
    weiboFeedSrc?.stop();
    weiboFeedSrc = new WeiboFeedSource({
      cookie: cookieHdr,
      onLoginState: (s) => { weiboLogin = s; },
    });
    weiboFeedSrc.start({ bus, db, config: eff });
  };
  const stopWeiboFeed = (): void => { weiboFeedSrc?.stop(); weiboFeedSrc = null; };
  const weiboLoggedIn = (): boolean =>
    weiboCookieImported && (weiboLogin === null ? true : weiboLogin.loggedIn);

  // 动态 / 微博 两个源的启停唯一入口：面板监听开关 + cookie 存在共同决定
  const reconcileListen = (): void => {
    if (shouldRunListen(db, 'dynamic', biliCookieHdr !== null)) {
      if (!dynamicSrc) {
        log.info(`动态轮询：${db.listWatchedUids().length} 个监听对象，间隔 ${eff.dynamic.intervalSec}s`);
        startDynamic(biliCookieHdr!);
      }
    } else if (dynamicSrc) {
      log.info('动态轮询已停止（面板开关关闭 / 无 cookie）');
      stopDynamic();
    }
    if (shouldRunListen(db, 'weibo', weiboCookieHdr !== null)) {
      if (!weiboFeedSrc) {
        log.info(`微博时间线：间隔 ${eff.weibo.intervalSec}s`);
        startWeiboFeed(weiboCookieHdr!);
      }
    } else if (weiboFeedSrc) {
      log.info('微博时间线已停止（面板开关关闭 / 无 cookie）');
      stopWeiboFeed();
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
    log.info('未导入 cookies.json，关注列表同步 / 动态轮询等凭据功能停用（匿名开播监听不受影响）');
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
    log.info('未导入 weibo-cookies.json，微博时间线停用（可在面板扫码登录生成，其他功能不受影响）');
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
        login: () => ({ bili: biliLoggedIn(), weibo: weiboLoggedIn() }),
        onChanged: () => reconcileListen(),
      },
      advanced: {
        onChanged: () => reconcileRuntime(),
      },
      snapshots: { dir: keyframeDir },
      napcat: {
        effective: () => getNapcatConfig(db),
        source: () => ({
          enabled: db.getSetting('napcat_enabled') !== null ? 'panel' as const : 'config' as const,
          dir: db.getSetting('napcat_dir') !== null ? 'panel' as const : 'config' as const,
          uin: db.getSetting('napcat_uin') !== null ? 'panel' as const : 'config' as const,
        }),
        save: (patch) => {
          saveNapcatConfig(db, patch);
          // 配置变了重装配一次：开 NapCat 才建的 onebot notifier 立即生效，
          // 关掉则移除（通道启停不再有独立开关）
          void rebuildNotifiers();
          void napcatWatchdog?.tick();
        },
        state: async () => {
          const nc = getNapcatConfig(db);
          const ep = nc.dir ? readOnebotEndpoint(nc.dir, nc.uin) : null;
          const [probeResult, taskRegistered] = await Promise.all([
            ep ? probeNapCat(ep) : Promise.resolve(null),
            isNapcatTaskRegistered(),
          ]);
          return { endpoint: ep?.baseUrl ?? null, probe: probeResult, taskRegistered };
        },
        launch: async () => {
          const nc = getNapcatConfig(db);
          const ep = await ensureNapcatEntry(nc.dir, nc.uin);
          if (ep) onebotNotifier?.updateEndpoint(ep.baseUrl, ep.token);
          // 旧实例可能还在旧配置上跑（高权限进程只能经任务杀），先停再拉起让新配置生效
          await stopNapcatViaTask();
          await new Promise((r) => setTimeout(r, 3_000));
          const ok = await launchNapcatViaTask();
          if (!ok) throw new Error('拉起失败：计划任务未创建（先点「添加自动拉起任务」一次性设置）');
          void napcatWatchdog?.tick();
        },
        setupTask: async () => {
          const nc = getNapcatConfig(db);
          if (!nc.dir || !nc.uin) throw new Error('先填好路径与机器人 QQ 号');
          const ep = await ensureNapcatEntry(nc.dir, nc.uin);
          if (!ep) throw new Error('onebot11 配置读取/创建失败，请检查 NapCat 路径');
          onebotNotifier?.updateEndpoint(ep.baseUrl, ep.token);
          await setupNapcatTask(nc.dir, nc.uin, join(projectRoot, 'data'));
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
