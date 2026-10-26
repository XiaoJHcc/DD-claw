import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configSchema, defaultAppConfig, type AppConfig } from './schema.js';
import { setLogLevel, type LogLevel } from '../logger.js';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export interface Secrets {
  dbPath: string;
}

export interface LoadedConfig {
  app: AppConfig;
  secrets: Secrets;
}

/** 极简 .env 解析。不引 dotenv：只需要 KEY=VALUE 和注释。 */
function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

class ConfigError extends Error {}

/**
 * 剥掉 // 和 /* *\/ 注释，让 config.json 可以写注释（JSONC 风格）。
 * 必须跳过字符串内部，否则 "https://..." 里的 // 会被当成注释误删。
 */
function stripJsonComments(src: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    const next = src[i + 1];

    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') { inBlock = false; i++; }
      continue;
    }
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && next === '/') { inLine = true; i++; continue; }
    if (c === '/' && next === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  return out;
}

export function loadConfig(): LoadedConfig {
  loadDotEnv(resolve(projectRoot, '.env'));

  const level = (process.env.LOG_LEVEL ?? 'info') as LogLevel;
  if (['debug', 'info', 'warn', 'error'].includes(level)) setLogLevel(level);

  const cfgPath = resolve(projectRoot, 'config.json');
  // config.json 全程可选，且只有 panel 段是活配置（面板自举）；
  // 其余顶层字段一律无视（zod 非 strict 剥离），文件不存在 = 全部用默认值
  let parsedJson: unknown = {};
  if (existsSync(cfgPath)) {
    try {
      // 去掉 BOM：Windows 上记事本另存、PowerShell 的 Out-File -Encoding utf8
      // 都会写入 BOM，而 JSON.parse 不接受它
      const raw = readFileSync(cfgPath, 'utf8').replace(/^﻿/, '');
      parsedJson = JSON.parse(stripJsonComments(raw));
    } catch (e) {
      throw new ConfigError(`config.json 不是合法 JSON: ${(e as Error).message}`);
    }
  }

  const result = configSchema.safeParse(parsedJson);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  - ${i.path.length ? i.path.join('.') : '(根)'}: ${i.message}`,
    );
    throw new ConfigError(`config.json 校验失败:\n${lines.join('\n')}`);
  }

  return {
    app: { ...defaultAppConfig(), panel: result.data.panel },
    secrets: {
      dbPath: process.env.DB_PATH || resolve(projectRoot, 'data', 'dd-claw.db'),
    },
  };
}

export { ConfigError };
export { normalizeProviderBaseURL } from './schema.js';
/** 仅供测试。生产代码不要用。 */
export { stripJsonComments as __stripJsonCommentsForTest };
export type { AppConfig, DecisionProviderConfig, LlmProviderConfig } from './schema.js';
