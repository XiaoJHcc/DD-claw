import { loadConfig, ConfigError, projectRoot } from './config/index.js';
import { dirname, join, resolve } from 'node:path';
import { makeLogger } from './logger.js';
import { Db } from './core/db.js';
import { Bus } from './core/bus.js';
import { Pipeline } from './core/pipeline.js';
import { toLiveEvent } from './core/types.js';
import { AnalysisQueue } from './analysis/queue.js';
import { RulesClassifier } from './analysis/classifier.js';
import { createLlmRouter, seedLlmProvidersIfEmpty, listLlmProviders, saveLlmProviders, isLlmEnabled, dbKeysOf, migrateLiteralKeys } from './analysis/providers.js';
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
import type { Server } from 'node:http';
import type { Notifier } from './notify/types.js';
import type { Source } from './sources/types.js';

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
    if (!app.napcat.enabled) {
      log.error('config.json 未启用 napcat 段（enabled/dir/uin），请先配置');
      process.exit(1);
    }
    const ep = await ensureNapcatEntry(app.napcat.dir, app.napcat.uin);
    if (ep) {
      log.info(`dd-claw 专属条目就绪: ${ep.baseUrl}（自动管理端口，其他服务条目不受影响）`);
    } else {
      log.warn(`无法在 ${app.napcat.dir} 读取/创建 onebot11 配置，请检查 NapCat 路径`);
    }
    if (await isNapcatTaskRegistered()) {
      log.info(`计划任务 "${NAPCAT_TASK_NAME}" 已存在，将重建以更新路径/uin`);
    }
    await setupNapcatTask(app.napcat.dir, app.napcat.uin, join(projectRoot, 'data'));
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
    // 口径与主流程一致：开库读面板覆盖（provider 名单 / 总开关 / key）
    const probeDb = new Db(secrets.dbPath);
    seedLlmProvidersIfEmpty(probeDb, app.llm.providers);
    migrateLiteralKeys(probeDb);
    if (!isLlmEnabled(probeDb, app.llm)) {
      log.error('LLM 未启用：在控制面板的 LLM 卡片打开总开关（或 config.json llm.enabled=true）');
      process.exit(1);
    }
    const router = createLlmRouter(
      { ...app.llm, providers: listLlmProviders(probeDb) },
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

  // LLM：provider 名单事实来源是 settings 表（面板增删改），config 仅作首次种子；
  // 路由由名单自动推导（顺序 = 优先级）。key 优先级：面板填写 > .env。
  // 面板改名单 → onProvidersChanged 重建 router；改 key → refreshKeys。均免重启。
  // 分析任务（scene-classify 等）后续从 llmDep.router 取
  const seededLlm = seedLlmProvidersIfEmpty(db, app.llm.providers);
  if (seededLlm > 0) {
    log.info(`已从 config.json 种子导入 ${seededLlm} 个 LLM provider 到 settings 表，之后由面板管理`);
  }
  // 早期面板误把 key 值填进 keyEnvs（变量名）字段的，挪进只写不读的 key 存储（一次性，值不进日志）
  const migratedKeys = migrateLiteralKeys(db);
  if (migratedKeys > 0) {
    log.info(`已把 ${migratedKeys} 个 provider 误填的 key 迁移到 key 存储（不再明文展示）`);
  }
  const llmKeysOf = dbKeysOf(db);
  const llmDep: NonNullable<PanelDeps['llm']> = {
    config: app.llm,
    store: {
      list: () => listLlmProviders(db),
      save: (ps) => saveLlmProviders(db, ps),
    },
  };
  llmDep.onProvidersChanged = () => {
    llmDep.router = createLlmRouter({ ...app.llm, providers: listLlmProviders(db) }, llmKeysOf);
  };
  llmDep.onProvidersChanged();

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
  let onebotNotifier: OneBotNotifier | null = null;
  if (app.notify.onebot.enabled) {
    // onebot 端点：napcat 生效配置（settings 面板覆盖 > config）enabled 时走 dd-claw
    // 专属条目（name=dd-claw，缺了启动时自动创建、端口被占自动换），
    // .env NAPCAT_BASE_URL 降为兜底
    const nc = getNapcatConfig(db, app.napcat);
    const discovered = nc.enabled && process.platform === 'win32'
      ? (readOnebotEndpoint(nc.dir, nc.uin) ?? await ensureNapcatEntry(nc.dir, nc.uin))
      : null;
    if (nc.enabled && process.platform === 'win32' && !discovered) {
      log.warn(`napcat.enabled=true 但未能从 ${nc.dir} 发现/创建 OneBot 端点，退回 .env NAPCAT_BASE_URL`);
    }
    const baseUrl = discovered?.baseUrl ?? secrets.napcatBaseUrl;
    const token = discovered?.token ?? secrets.napcatToken;
    if (!baseUrl) {
      throw new ConfigError('onebot 已启用，但 NapCat 端点发现失败且 .env 没有 NAPCAT_BASE_URL');
    }
    if (discovered) log.info(`onebot 端点跟随 NapCat 配置: ${baseUrl}`);
    onebotNotifier = new OneBotNotifier(baseUrl, token, app.notify.onebot.targets);
    notifiers.push(onebotNotifier);
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
      keyframe: 'https://i0.hdslb.com/bfs/live-key-frame/keyframe08052341000000080397it5906.jpg',
      face: 'https://i2.hdslb.com/bfs/face/bd4253b0eb80684a86efa0097935004527bcc773.jpg',
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
  // 分类器：router 用 getter 每轮取最新（面板改名单热重建），LLM 总开关读 settings 覆盖
  const bus = new Bus();
  const pipeline = new Pipeline({
    bus,
    db,
    config: app,
    queue: new AnalysisQueue(
      new RulesClassifier(db, () => llmDep.router ?? null, () => isLlmEnabled(db, app.llm)), 2,
    ),
    rule: new OncePerSessionRule(db),
    dispatcher,
  });
  pipeline.attach();

  // NapCat 看门狗：生效配置（settings 面板覆盖 > config）enabled 时周期探测（60s），
  // 不在线经计划任务自动拉起 + 快速登录；dir/uin 每 tick 重取（面板改了热生效）；
  // 端点热跟随 NapCat 自己的 onebot11 配置。告警走 bus health_alert →
  // alertAll（onebot 挂了自然由 toast 送达）
  let napcatTask: PeriodicTask | undefined;
  let napcatWatchdog: NapcatWatchdog | undefined;
  const reconcileNapcat = (): void => {
    const nc = getNapcatConfig(db, app.napcat);
    const shouldRun = nc.enabled && app.notify.onebot.enabled && onebotNotifier !== null
      && process.platform === 'win32';
    if (shouldRun === (napcatTask !== undefined)) return;
    if (shouldRun) {
      napcatWatchdog ??= new NapcatWatchdog({
        target: () => {
          const c = getNapcatConfig(db, app.napcat);
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
          log.warn('NapCat 计划任务未创建，自动拉起不可用：面板 NapCat 卡片点「计划任务」或跑 npm run napcat-setup 一次性设置');
        }
      });
    } else {
      napcatTask?.stop();
      napcatTask = undefined;
      log.info('NapCat 看门狗已停止（面板关闭 / onebot 停用）');
    }
  };
  if (getNapcatConfig(db, app.napcat).enabled && process.platform !== 'win32') {
    log.warn('napcat.enabled 目前仅支持 Windows，看门狗未启动');
  }
  reconcileNapcat();

  const sources: Source[] = [
    new LiveStatusSource({ forceUids: args.forceUids }),
  ];

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
    followsSrc.start({ bus, db, config: app });
  };
  const startDynamic = (cookieHdr: string): void => {
    dynamicSrc?.stop();
    // 登录态心跳在 DynamicSource 内部：follows.enabled=false 时这是 B站登录态唯一来源
    dynamicSrc = new DynamicSource({
      cookie: cookieHdr,
      onLoginState: (s) => { biliLogin = s; },
    });
    dynamicSrc.start({ bus, db, config: app });
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
    weiboFeedSrc.start({ bus, db, config: app });
  };
  const stopWeiboFeed = (): void => { weiboFeedSrc?.stop(); weiboFeedSrc = null; };
  const weiboLoggedIn = (): boolean =>
    weiboCookieImported && (weiboLogin === null ? true : weiboLogin.loggedIn);

  // 动态 / 微博 两个源的启停唯一入口：面板开关 + config 开关 + cookie 存在共同决定
  const reconcileListen = (): void => {
    if (shouldRunListen(db, 'dynamic', biliCookieHdr !== null, app.dynamic.enabled)) {
      if (!dynamicSrc) {
        log.info(`动态轮询：${db.listWatchedUids().length} 个监听对象，间隔 ${app.dynamic.intervalSec}s`);
        startDynamic(biliCookieHdr!);
      }
    } else if (dynamicSrc) {
      log.info('动态轮询已停止（面板开关关闭 / config 停用 / 无 cookie）');
      stopDynamic();
    }
    if (shouldRunListen(db, 'weibo', weiboCookieHdr !== null, app.weibo.enabled)) {
      if (!weiboFeedSrc) {
        log.info(`微博时间线：间隔 ${app.weibo.intervalSec}s`);
        startWeiboFeed(weiboCookieHdr!);
      }
    } else if (weiboFeedSrc) {
      log.info('微博时间线已停止（面板开关关闭 / config 停用 / 无 cookie）');
      stopWeiboFeed();
    }
  };

  // 凭据功能：cookies.json 不存在 → 停用并说明；坏 JSON → loadCookies 抛
  // ConfigError，启动即失败。cookie 值绝不进日志，只传拼好的 Cookie 头。
  const cookies = loadCookies(resolve(projectRoot, 'cookies.json'));
  cookieImported = cookies != null;
  if (!cookies) {
    log.info('未导入 cookies.json，关注列表同步 / 动态轮询等凭据功能停用（匿名开播监听不受影响）');
  } else {
    const cookieHdr = cookieHeader(cookies);
    biliCookieHdr = cookieHdr;
    if (app.follows.enabled) {
      startFollows(cookieHdr);
    } else {
      log.info('cookies.json 存在，但 config 里 follows.enabled=false，跳过关注列表同步');
    }
  }

  // 微博凭据：weibo-cookies.json 不存在 → 停用并说明（不阻塞启动）；
  // 坏 JSON → loadWeiboCookies 抛 ConfigError，启动即失败。cookie 值绝不进日志。
  const weiboCookies = loadWeiboCookies(resolve(projectRoot, 'weibo-cookies.json'));
  weiboCookieImported = weiboCookies != null;
  if (!weiboCookies) {
    log.info('未导入 weibo-cookies.json，微博时间线停用（可在面板扫码登录生成，其他功能不受影响）');
  } else {
    weiboCookieHdr = weiboCookieHeader(weiboCookies);
    if (!app.weibo.enabled) {
      log.info('weibo-cookies.json 存在，但 config 里 weibo.enabled=false，跳过微博时间线');
    }
  }

  for (const s of sources) s.start({ bus, db, config: app });
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
          if (app.follows.enabled) {
            log.info('扫码登录成功，热重启关注列表同步');
            startFollows(cookieHdr);
          }
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
        config: { dynamic: app.dynamic, weibo: app.weibo },
        login: () => ({ bili: biliLoggedIn(), weibo: weiboLoggedIn() }),
        onChanged: () => reconcileListen(),
      },
      napcat: {
        effective: () => getNapcatConfig(db, app.napcat),
        source: () => ({
          enabled: db.getSetting('napcat_enabled') !== null ? 'panel' as const : 'config' as const,
          dir: db.getSetting('napcat_dir') !== null ? 'panel' as const : 'config' as const,
          uin: db.getSetting('napcat_uin') !== null ? 'panel' as const : 'config' as const,
        }),
        save: (patch) => {
          saveNapcatConfig(db, patch);
          reconcileNapcat();
          // dir/uin 改了立即重探测/跟随端点，不等下个周期
          void napcatWatchdog?.tick();
        },
        state: async () => {
          const nc = getNapcatConfig(db, app.napcat);
          const ep = nc.dir ? readOnebotEndpoint(nc.dir, nc.uin) : null;
          const [probeResult, taskRegistered] = await Promise.all([
            ep ? probeNapCat(ep) : Promise.resolve(null),
            isNapcatTaskRegistered(),
          ]);
          return { endpoint: ep?.baseUrl ?? null, probe: probeResult, taskRegistered };
        },
        launch: async () => {
          const nc = getNapcatConfig(db, app.napcat);
          const ep = await ensureNapcatEntry(nc.dir, nc.uin);
          if (ep) onebotNotifier?.updateEndpoint(ep.baseUrl, ep.token);
          // 旧实例可能还在旧配置上跑（高权限进程只能经任务杀），先停再拉起让新配置生效
          await stopNapcatViaTask();
          await new Promise((r) => setTimeout(r, 3_000));
          const ok = await launchNapcatViaTask();
          if (!ok) throw new Error('拉起失败：计划任务未创建（先点「计划任务」一次性设置）');
          void napcatWatchdog?.tick();
        },
        setupTask: async () => {
          const nc = getNapcatConfig(db, app.napcat);
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
