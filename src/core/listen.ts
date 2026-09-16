/**
 * 监听功能开关（面板各页的开关）：动态（B站）/ 微博 / 推特（X，独立分页）。
 * settings 存 `listen_<feature>`：缺省=auto（跟随运行前提）、'1'/'0'=手动（手动为准）。
 *
 * 「运行前提」按 feature 不同而不同：动态=B站登录态、微博=微博登录态、
 * **推特=代理已配置**（X 没有登录态，它的前提是出网链路，见 docs/research/twitter.md）。
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
  if (want === ready) db.deleteSetting(listenKey(feature));
  else db.setSetting(listenKey(feature), want ? '1' : '0');
  return isListenEnabled(db, feature, ready);
}