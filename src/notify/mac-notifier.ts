import { spawn, execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLogger } from '../logger.js';

const log = makeLogger('notify/mac-notifier');

/**
 * macOS 通知 helper（Swift 编译成 DD-claw.app）：
 * osascript 的 `display notification` 身份固定为「脚本编辑器」且无点击回调，
 * 无法满足产品化（应用名 + 点击跳转 + 内容图）。改用系统自带 swiftc 编译一个
 * 原生 helper，包成 .app bundle 以获得 DD-claw 身份；helper 发出通知后常驻
 * runloop 等待点击（点击打开 --url），超时退出避免僵尸进程。
 *
 * 编译产物落在 data 目录（每台机器一次，幂等缓存）；swiftc 不可用 / 编译失败
 * 时回落 osascript（见 toast.ts）。macOS 自带 CommandLineTools 才有 swiftc。
 */

/** 项目根目录：src/notify 与 dist/notify 向上两级都是根，tsx 与构建产物通用 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SWIFT_SOURCE = join(ROOT, 'scripts', 'mac-notify.swift');
const APP_NAME = 'DD-claw';

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>DD-claw</string>
	<key>CFBundleDisplayName</key><string>DD-claw</string>
	<key>CFBundleIdentifier</key><string>com.ddclaw.notifier</string>
	<key>CFBundleVersion</key><string>1.0</string>
	<key>CFBundleShortVersionString</key><string>1.0</string>
	<key>CFBundleExecutable</key><string>DD-claw</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>LSMinimumSystemVersion</key><string>11.0</string>
	<key>LSUIElement</key><true/>
</dict>
</plist>
`;

export interface MacRunResult { code: number; stdout: string; stderr: string }
/** execFile 风格的命令执行器（swiftc 编译 / osascript 回落），可注入用于测试 */
export type Runner = (cmd: string, args: string[]) => Promise<MacRunResult>;

const defaultRunner: Runner = (cmd, args) =>
  new Promise((resolvePromise) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      resolvePromise({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });

/** DD-claw.app 的可执行文件路径（编译产物，落 data 目录） */
export function macNotifierBinaryPath(dir: string): string {
  return join(dir, `${APP_NAME}.app`, 'Contents', 'MacOS', APP_NAME);
}

/**
 * 确保 helper 已编译：产物存在直接返回；否则建 .app bundle（Info.plist 定身份）
 * + swiftc 编译。编译失败返回 null（调用方回落 osascript），不抛异常。
 */
export async function ensureMacNotifier(dir: string, run: Runner = defaultRunner): Promise<string | null> {
  const bin = macNotifierBinaryPath(dir);
  if (existsSync(bin)) return bin;
  try {
    const appDir = join(dir, `${APP_NAME}.app`);
    mkdirSync(join(appDir, 'Contents', 'MacOS'), { recursive: true });
    mkdirSync(join(appDir, 'Contents', 'Resources'), { recursive: true });
    writeFileSync(join(appDir, 'Contents', 'Info.plist'), INFO_PLIST);
    const r = await run('swiftc', ['-O', SWIFT_SOURCE, '-o', bin]);
    if (r.code !== 0) {
      log.warn(`macOS 通知 helper 编译失败: ${r.stderr}`);
      return null;
    }
    return bin;
  } catch (e) {
    log.warn('macOS 通知 helper 编译失败，回落 osascript', (e as Error).message);
    return null;
  }
}

/** 拼 helper 的启动参数（数组传参，不经 shell，无引号转义问题） */
export function macNotifierArgs(opts: {
  title: string; subtitle: string; message: string; url: string; image: string;
}): string[] {
  const args = ['--title', opts.title, '--message', opts.message];
  if (opts.subtitle) args.push('--subtitle', opts.subtitle);
  if (opts.url) args.push('--url', opts.url);
  if (opts.image) args.push('--image', opts.image);
  return args;
}

export type SpawnMac = (bin: string, args: string[]) => Promise<void>;

/** 脱离父进程发通知：helper 自己常驻 runloop 等点击（+ 超时退出），不阻塞 DD-claw */
export const spawnMacNotifier: SpawnMac = (bin, args) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolvePromise();
    });
  });
