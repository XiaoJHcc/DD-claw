import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { makeLogger } from '../../logger.js';
import { ConfigError } from '../../config/index.js';
import { BiliApiError, biliRequest, type BiliRequestFn } from './client.js';

const log = makeLogger('bili/auth');

// 实测：x/member/web/nav 已 404 下线；x/web-interface/nav 匿名返回 -101（归一化为未登录）
const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';

export interface SelfInfo {
  isLogin: boolean;
  mid: string | null;
}

/**
 * 读 cookies.json：完整一套字段（name→value），不要只挑「必需」字段 ——
 * 缺不起眼字段是间歇性 412 的元凶（docs/boundaries.md §5.8）。
 * 文件不存在返回 null（凭据功能停用，匿名功能照常）；
 * 文件存在但坏 = 用户明确想用它却坏了，启动即失败。
 */
export function loadCookies(path: string): Record<string, string> | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    // 同 config.json：Windows 记事本/PowerShell 常写 BOM，JSON.parse 不接受
    parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    throw new ConfigError(`cookies.json 不是合法 JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError('cookies.json 应是 {"字段名":"值"} 形式的 JSON 对象');
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'string') out[k] = v;
  }
  if (!out['SESSDATA']) {
    log.warn('cookies.json 缺少 SESSDATA，登录态接口大概率不可用（不拦截启动）');
  }
  return out;
}

/** 拼 Cookie 头。任何日志都不得输出这个返回值。 */
export function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * 扫码登录成功后落 cookies.json。已存在且是合法 JSON 对象时 merge ——
 * 新值覆盖、旧值兜底（扫码响应不发 buvid3 等风控字段，直接覆盖会丢）；
 * 文件不存在或坏 JSON 则直接写。cookie 值绝不进日志。
 */
export function saveCookies(path: string, cookies: Record<string, string>): void {
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
  log.info(`cookies.json 已更新（${Object.keys(cookies).length} 个字段）: ${path}`);
}

/**
 * 登录态心跳：nav 接口看 isLogin。code=-101（账号未登录）不算错误，
 * 归一化成 isLogin=false；其余 HTTP/业务错误按 client.ts 分层继续抛。
 */
export async function fetchSelf(cookie: string, req: BiliRequestFn = biliRequest): Promise<SelfInfo> {
  try {
    const data = await req<{ isLogin?: boolean; mid?: number }>(NAV_URL, { cookie });
    return {
      isLogin: data?.isLogin === true,
      mid: data?.mid != null ? String(data.mid) : null,
    };
  } catch (e) {
    if (e instanceof BiliApiError && e.code === -101) return { isLogin: false, mid: null };
    throw e;
  }
}
