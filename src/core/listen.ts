/**
 * 监听功能开关：微博 / 推特（X，独立分页）/ 动态账号（图文页 B站动态卡）。
 * settings 存 `listen_<feature>`：缺省=auto（跟随运行前提）、'1'/'0'=手动（手动为准）。
 *
 * 「运行前提」按 feature 不同而不同：微博=微博登录态、**推特=代理已配置**
 * （X 没有登录态，它的前提是出网链路，见 docs/research/twitter.md）。
 *
 * `dynamic` 的语义（2026-09-20 修订）：只管 **bili_accounts（图文页的动态账号名单）**
 * 的轮询——监听主播的空间动态归档**随 B站登录常开、无开关**（直播预告分析等要用它；
 * 添加监听直播永远附赠动态归档）。设置页监听卡不再有「监听动态」开关，开关只在
 * 图文页 B站动态卡；settings 里旧的 listen_dynamic 值语义随开关迁移。
 */
import type { Db } from './db.js';

export type ListenFeature = 'dynamic' | 'weibo' | 'twitter';

export function listenKey(feature: ListenFeature): string {
  return `listen_${feature}`;
}

/**
 * 三个 feature 的运行前提（由装配处提供）。X 没有登录态——它的前提是「代理已配置」，
 * 因为境内直连 x.com 不可达，没有代理就什么都做不了。
 */
export interface ListenReady {
  bili: boolean;
  weibo: boolean;
  twitter: boolean;
}

/** feature → 它的运行前提。面板与 MCP 共用这一份映射，避免两处各写一份三元式。 */
export function listenReadyFor(feature: ListenFeature, ready: ListenReady): boolean {
  if (feature === 'dynamic') return ready.bili;
  if (feature === 'weibo') return ready.weibo;
  return ready.twitter;
}

/** 原始设置：null=auto（跟随前提）、'1'=手动开、'0'=手动关 */
export function listenSetting(db: Db, feature: ListenFeature): '1' | '0' | null {
  const v = db.getSetting(listenKey(feature));
  if (v === '1' || v === '0') return v;
  return null;
}

/** UI 有效态：手动开=true；手动关=false；auto=跟随运行前提 */
export function isListenEnabled(db: Db, feature: ListenFeature, ready: boolean): boolean {
  const s = listenSetting(db, feature);
  if (s === '1') return true;
  if (s === '0') return false;
  return ready;
}

/**
 * 源是否运行：运行前提满足 &&（手动开 || auto）。
 * auto 下前提**运行中失效不自动停**——由源心跳跳过并告警（避免登录态抖动导致源反复启停）。
 */
export function shouldRunListen(db: Db, feature: ListenFeature, ready: boolean): boolean {
  if (!ready) return false;
  const s = listenSetting(db, feature);
  return s !== '0';
}

/** 面板切换：与 auto 默认一致则回 auto（删除手动设置的 key），否则落手动值；返回切换后有效态 */
export function setListen(
  db: Db,
  feature: ListenFeature,
  want: boolean,
  ready: boolean,
): boolean {
  // 手动关→手动开 = 主动暂停结束：该平台全部启用账号进入「恢复轮静默」——
  // 关闭期间的帖子不补推，与账号停用→重新启用同语义（「主动关闭意图：显然不推」，
  // 见 core/backlog.ts）。auto 或手动开状态下的启停不置位（那是「服务未运行期间」，
  // 走缺口轮语义：默认不推、backlog_push_enabled 开了才补推）。
  if (want && listenSetting(db, feature) === '0') {
    if (feature === 'dynamic') db.markBiliAccountsSilentNext();
    else if (feature === 'weibo') db.markWeiboAccountsSilentNext();
    else db.markXAccountsSilentNext();
  }
  if (want === ready) db.deleteSetting(listenKey(feature));
  else db.setSetting(listenKey(feature), want ? '1' : '0');
  return isListenEnabled(db, feature, ready);
}