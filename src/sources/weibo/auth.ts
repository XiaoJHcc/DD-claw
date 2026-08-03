/**
 * 微博 cookie 管理：weibo-cookies.json（项目根，已加入 .gitignore）。
 * 模子同 bili auth.ts：文件不存在返回 null（凭据功能停用）；存在但坏 =
 * 用户明确想用它却坏了，启动即失败；save 时 merge（新值覆盖、旧值兜底）。
 * cookie 值绝不进日志。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { makeLogger } from '../../logger.js';
import { ConfigError } from '../../config/index.js';
import type { FetchImpl } from './qrcode.js';

const log = makeLogger('weibo/auth');

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
// 登录态校验：响应头 X-Log-Uid 存在即已登录（值就是当前登录 uid）
const LOG_ACTION_URL = 'https://weibo.com/ajax/log/action';

export interface WeiboSelfInfo {
  loggedIn: boolean;
  uid: string | null;
}

/** 读 weibo-cookies.json：不存在返回 null；存在但坏 JSON / 非对象，启动即失败。 */
export function loadWeiboCookies(path: string): Record<string, string> | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    // 同 config.json：Windows 记事本/PowerShell 常写 BOM，JSON.parse 不接受
    parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    throw new ConfigError(`weibo-cookies.json 不是合法 JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError('weibo-cookies.json 应是 {"字段名":"值"} 形式的 JSON 对象');
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'string') out[k] = v;
  }
  if (!out['SUB']) {
    log.warn('weibo-cookies.json 缺少 SUB，登录态接口大概率不可用（不拦截启动）');
  }
  return out;
}

/** 拼 Cookie 头。任何日志都不得输出这个返回值。 */
export function weiboCookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * 扫码登录成功后落 weibo-cookies.json。已存在且是合法 JSON 对象时 merge ——
 * 新值覆盖、旧值兜底；文件不存在或坏 JSON 则直接写。cookie 值绝不进日志。
 */
export function saveWeiboCookies(path: string, cookies: Record<string, string>): void {
  let merged = { ...cookies };
  if (existsSync(path)) {
    try {
      const prev: unknown = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
      if (prev && typeof prev === 'object' && !Array.isArray(prev)) {
        const old: Record<string, string> = {};
        for (const [k, v] of Object.entries(prev)) {
          if (typeof v === 'string') old[k] = v;
        }
        merged = { ...old, ...cookies };
      }
    } catch {
      // 旧文件坏：直接覆盖
    }
  }
  writeFileSync(path, JSON.stringify(merged, null, 2));
  log.info(`weibo-cookies.json 已更新（${Object.keys(cookies).length} 个字段）: ${path}`);
}

/**
 * 登录态心跳：ajax/log/action 看响应头 X-Log-Uid。
 * 缺头 / 网络异常一律归一化为未登录（由调用方决定告警与跳过）。
 */
export async function fetchWeiboSelf(
  cookie: string, fetchImpl: FetchImpl = fetch,
): Promise<WeiboSelfInfo> {
  try {
    const res = await fetchImpl(LOG_ACTION_URL, {
      headers: { 'User-Agent': DESKTOP_UA, Cookie: cookie, Referer: 'https://weibo.com/' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { loggedIn: false, uid: null };
    const uid = res.headers.get('x-log-uid');
    return uid ? { loggedIn: true, uid } : { loggedIn: false, uid: null };
  } catch {
    return { loggedIn: false, uid: null };
  }
}
