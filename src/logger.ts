import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

let threshold: number = LEVELS.info;

export function setLogLevel(level: LogLevel): void {
  threshold = LEVELS[level];
}

// ---- 文件 sink：进程后台运行时 console 输出会蒸发，失败原因必须能事后追查 ----

let sinkDir: string | null = null;

const RETENTION_DAYS = 7;
const LOG_FILE_RE = /^dd-claw-(\d{4}-\d{2}-\d{2})\.log$/;

function dateStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 初始化文件 sink：日志按天滚动写 dir/dd-claw-YYYY-MM-DD.log，保留 7 天。失败静默（日志绝不影响主流程） */
export function initFileSink(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
    const cutoffStr = dateStr(cutoff);
    for (const f of readdirSync(dir)) {
      const m = LOG_FILE_RE.exec(f);
      if (m && m[1]! < cutoffStr) {
        try { rmSync(join(dir, f)); } catch { /* 删不动就留着 */ }
      }
    }
    sinkDir = dir;
  } catch { /* sink 初始化失败不影响主流程 */ }
}

/** 关闭文件 sink（测试用：重置模块级状态，避免用例间串扰） */
export function closeFileSink(): void {
  sinkDir = null;
}

function ts(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${dateStr(d)} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function emit(level: LogLevel, mod: string, msg: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const line = `${ts()} ${level.toUpperCase().padEnd(5)} [${mod}] ${msg}`;
  const sink = level === 'error' || level === 'warn' ? console.error : console.log;
  if (extra === undefined) sink(line);
  else sink(line, typeof extra === 'string' ? extra : inspect(extra));
  if (sinkDir) {
    const full = extra === undefined ? line : `${line} ${typeof extra === 'string' ? extra : inspect(extra)}`;
    try {
      // 同步 append：日志量小、崩溃安全、跨天天然换文件；写盘异常静默忽略
      appendFileSync(join(sinkDir, `dd-claw-${dateStr(new Date())}.log`), full + '\n');
    } catch { /* 写盘失败不报警（没法用日志报告日志故障） */ }
  }
}

function inspect(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

export function makeLogger(mod: string): Logger {
  return {
    debug: (m, e) => emit('debug', mod, m, e),
    info: (m, e) => emit('info', mod, m, e),
    warn: (m, e) => emit('warn', mod, m, e),
    error: (m, e) => emit('error', mod, m, e),
  };
}
