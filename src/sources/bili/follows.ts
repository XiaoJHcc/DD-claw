import { makeLogger } from '../../logger.js';
import { PeriodicTask } from '../../core/scheduler.js';
import type { Source, SourceContext } from '../types.js';
import { fetchSelf, type SelfInfo } from './auth.js';
import { fetchFollowings, type Following } from './followings.js';

const log = makeLogger('bili/follows');

/** 注入点：便于单测登录态失效、单页失败等路径，生产环境用真实实现 */
export type SelfFetcher = (cookie: string) => Promise<SelfInfo>;
export type FollowingsFetcher = (cookie: string, mid: string) => Promise<Following[]>;

export interface FollowsSourceOpts {
  /** 完整 Cookie 头（cookieHeader 的产物），绝不进日志 */
  cookie: string;
  selfFetcher?: SelfFetcher;
  listFetcher?: FollowingsFetcher;
  /** 每轮心跳拿到 self 后上报一次（无论 isLogin 真假），供面板展示登录态 */
  onLoginState?: (s: SelfInfo) => void;
}

/**
 * 关注列表同步：isLogin 心跳合并进同步周期 —— 每轮先查登录态，
 * 运行中发现意外失效（本进程内此前成功登录过）才发一次 health_alert 并跳过本轮
 * （恢复后复位）；本来就没登录（启动起从未成功）只记日志不告警；有效才分页拉取。
 * 整轮成功才落库：upsertFollows + markFollowsSynced。
 * 关注不再自动入监听 —— follows 表只是面板上「方便添加」的候选池，
 * 监听名单完全由用户在面板管理；同步只对已有 streamer 条目做空 face 回填。
 */
export class FollowsSource implements Source {
  readonly name = 'bili/follows';

  private ctx?: SourceContext;
  private task?: PeriodicTask;
  /** 同一轮登录失效只告警一次，恢复后才复位（同 live-status 的告警模式） */
  private alerted = false;
  /** 本进程内是否成功登录过：没成功过 = 本来就没登录，只记日志不告警 */
  private hadOkLogin = false;

  private readonly cookie: string;
  private readonly selfFetcher: SelfFetcher;
  private readonly listFetcher: FollowingsFetcher;
  private readonly onLoginState?: (s: SelfInfo) => void;

  constructor(opts: FollowsSourceOpts) {
    this.cookie = opts.cookie;
    this.selfFetcher = opts.selfFetcher ?? fetchSelf;
    this.listFetcher = opts.listFetcher ?? fetchFollowings;
    this.onLoginState = opts.onLoginState;
  }

  start(ctx: SourceContext): void {
    this.bind(ctx);
    this.task = new PeriodicTask({
      name: this.name,
      intervalSec: ctx.config.follows.syncIntervalSec,
      jitterSec: ctx.config.pollJitterSec,
      run: async () => { await this.syncOnce(); },
    });
    this.task.start();
  }

  stop(): void {
    this.task?.stop();
  }

  /** start 中除周期调度外的部分。测试可 bind 后直接驱动 syncOnce。 */
  bind(ctx: SourceContext): void {
    this.ctx = ctx;
    log.info(`启动：关注列表同步，间隔 ${ctx.config.follows.syncIntervalSec}s`);
  }

  /** 同步一轮。返回是否完成（失败 = 保留旧数据，什么都不写）。 */
  async syncOnce(): Promise<boolean> {
    const ctx = this.ctx!;

    let self: SelfInfo;
    try {
      self = await this.selfFetcher(this.cookie);
    } catch (e) {
      // 心跳本身网络失败 ≠ cookie 失效，不告警，只跳过本轮
      log.error('登录态查询失败，跳过本轮同步', e);
      return false;
    }
    this.onLoginState?.(self);

    if (!self.isLogin) {
      if (this.hadOkLogin && !this.alerted) {
        this.alerted = true;
        ctx.bus.emit({
          source: this.name,
          kind: 'health_alert',
          uid: '',
          roomId: '',
          ts: Math.floor(Date.now() / 1000),
          payload: {
            alertKind: 'login_drop',
            message: 'B站 cookie 运行中失效（isLogin=false），关注列表同步已暂停。\n' +
              '请重新导出 cookies.json；匿名开播监听不受影响。',
          },
        });
      }
      log.warn(this.hadOkLogin ? 'cookie 失效，跳过本轮同步' : '未登录，跳过本轮同步（不告警）');
      return false;
    }
    this.hadOkLogin = true;
    if (!self.mid) {
      log.error('已登录但 nav 未返回 mid（接口异常？），跳过本轮同步');
      return false;
    }
    if (this.alerted) {
      this.alerted = false;
      log.info('登录态已恢复，继续同步');
    }

    let list: Following[];
    try {
      list = await this.listFetcher(this.cookie, self.mid);
    } catch (e) {
      // 关键：单页失败即整轮放弃 —— 保留 follows 旧数据，绝不清空
      log.error('关注列表拉取失败，保留旧数据，跳过本轮', e);
      return false;
    }

    ctx.db.upsertFollows(list);
    const removed = ctx.db.markFollowsSynced(list.map((f) => f.uid), Math.floor(Date.now() / 1000));

    // 关注不自动入监听（关注列表只是候选池）；仅给已在名单、face 为空的条目补头像
    let faceBackfilled = 0;
    for (const f of list) {
      const existing = ctx.db.getStreamer(f.uid);
      if (existing && !existing.face && f.face) {
        ctx.db.upsertStreamer({ uid: f.uid, face: f.face });
        faceBackfilled++;
      }
    }
    log.info(`同步完成：关注 ${list.length}，取关标记 ${removed}，头像回填 ${faceBackfilled}`);
    return true;
  }
}
