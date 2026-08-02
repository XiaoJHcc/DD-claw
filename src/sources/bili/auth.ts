import { existsSync, readFileSync } from 'node:fs';
import { makeLogger } from '../../logger.js';
import { ConfigError } from '../../config/index.js';
import { BiliApiError, biliRequest, type BiliRequestFn } from './client.js';

const log = makeLogger('bili/auth');

const NAV_URL = 'https://api.bilibili.com/x/member/web/nav';

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
