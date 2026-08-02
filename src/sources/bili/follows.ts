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
}

/**
 * 关注列表同步：isLogin 心跳合并进同步周期 —— 每轮先查登录态，
 * 失效则发一次 health_alert 并跳过本轮（恢复后复位）；有效才分页拉取。
 * 整轮成功才落库：upsertFollows + markFollowsSynced；
 * 新出现的 uid 自动加入 streamers（mode='on', source='follows'），
 * 已在表里的不碰（用户手调的 mode/alias 优先）。
 */
export class FollowsSource implements Source {
  readonly name = 'bili/follows';

  private ctx?: SourceContext;
  private task?: PeriodicTask;
  /** 同一轮登录失效只告警一次，恢复后才复位（同 live-status 的告警模式） */
  private alerted = false;

  private readonly cookie: string;
  private readonly selfFetcher: SelfFetcher;
  private readonly listFetcher: FollowingsFetcher;

  constructor(opts: FollowsSourceOpts) {
    this.cookie = opts.cookie;
    this.selfFetcher = opts.selfFetcher ?? fetchSelf;
    this.listFetcher = opts.listFetcher ?? fetchFollowings;
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

    if (!self.isLogin) {
      if (!this.alerted) {
        this.alerted = true;
        ctx.bus.emit({
          source: this.name,
          kind: 'health_alert',
          uid: '',
          roomId: '',
          ts: Math.floor(Date.now() / 1000),
          payload: {
            message: 'B站 cookie 已失效或未登录（isLogin=false），关注列表同步已暂停。\n' +
              '请重新导出 cookies.json；匿名开播监听不受影响。',
          },
        });
      }
      log.warn('cookie 失效或未登录，跳过本轮同步');
      return false;
    }
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

    let added = 0;
    for (const f of list) {
      if (ctx.db.getStreamer(f.uid)) continue;
      ctx.db.upsertStreamer({ uid: f.uid, uname: f.uname, mode: 'on', source: 'follows' });
      added++;
      log.info(`新关注自动加入监听: ${f.uname}(${f.uid})`);
    }
    log.info(`同步完成：关注 ${list.length}，取关标记 ${removed}，新加入监听 ${added}`);
    return true;
  }
}
