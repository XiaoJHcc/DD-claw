/**
 * 监听功能开关（面板「监听」卡片）：动态（B站）/ 微博两个开关。
 * settings 存 `listen_<feature>`：缺省=auto（跟随登录态）、'1'/'0'=手动（手动为准）。
 */
import type { Db } from './db.js';

export type ListenFeature = 'dynamic' | 'weibo';

export function listenKey(feature: ListenFeature): string {
  return `listen_${feature}`;
}

/** 原始设置：null=auto（跟随登录）、'1'=手动开、'0'=手动关 */
export function listenSetting(db: Db, feature: ListenFeature): '1' | '0' | null {
  const v = db.getSetting(listenKey(feature));
  if (v === '1' || v === '0') return v;
  return null;
}

/** UI 有效态：config 关=false；手动开=true；手动关=false；auto=跟随登录态 */
export function isListenEnabled(
  db: Db,
  feature: ListenFeature,
  loggedIn: boolean,
  configEnabled = true,
): boolean {
  if (!configEnabled) return false;
  const s = listenSetting(db, feature);
  if (s === '1') return true;
  if (s === '0') return false;
  return loggedIn;
}

/** 源是否运行：config 开 && cookie 存在 &&（手动开 || auto）。auto 下登录过期不自动停，由源心跳跳过并告警。 */
export function shouldRunListen(
  db: Db,
  feature: ListenFeature,
  cookieExists: boolean,
  configEnabled = true,
): boolean {
  if (!configEnabled || !cookieExists) return false;
  const s = listenSetting(db, feature);
  return s !== '0';
}

/** 面板切换：与 auto 默认一致则回 auto（删除手动设置的 key），否则落手动值；返回切换后有效态 */
export function setListen(
  db: Db,
  feature: ListenFeature,
  want: boolean,
  loggedIn: boolean,
): boolean {
  const auto = loggedIn;
  if (want === auto) db.deleteSetting(listenKey(feature));
  else db.setSetting(listenKey(feature), want ? '1' : '0');
  return isListenEnabled(db, feature, loggedIn);
}
