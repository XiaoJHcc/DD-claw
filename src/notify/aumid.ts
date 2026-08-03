import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { makeLogger } from '../logger.js';

const log = makeLogger('notify/aumid');

/**
 * Windows Toast 要显示自己的应用名（而不是借用的 Microsoft Store），
 * 必须有一个注册过的 Win32 AppUserModelID：开始菜单 .lnk + AppUserModel.ID 属性。
 * 注册逻辑在 scripts/register-aumid.ps1（幂等），这里只在 .lnk 缺失时调用一次。
 */
export const TOAST_AUMID = 'DD-claw';

const execFileAsync = promisify(execFile);
let cached: Promise<string | undefined> | null = null;

/** 项目根目录：src/notify 与 dist/notify 向上两级都是根，tsx 与构建产物通用 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function lnkPath(): string | null {
  const appData = process.env['APPDATA'];
  if (!appData) return null;
  return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${TOAST_AUMID}.lnk`);
}

/**
 * 确保本机已注册 DD-claw 的 AUMID，返回可用的 aumid。
 * 非 Windows 或注册失败返回 undefined —— powertoast 回落到默认身份（Microsoft Store），通知照发。
 */
export function ensureToastAumid(): Promise<string | undefined> {
  cached ??= doEnsure();
  return cached;
}

async function doEnsure(): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined;
  const lnk = lnkPath();
  if (!lnk) return undefined;
  if (existsSync(lnk)) return TOAST_AUMID;

  try {
    await execFileAsync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', join(ROOT, 'scripts', 'register-aumid.ps1'),
      '-Target', process.execPath,
      '-LnkPath', lnk,
      '-Arguments', `"${join(ROOT, 'dist', 'index.js')}"`,
      '-WorkingDir', ROOT,
      '-Aumid', TOAST_AUMID,
    ], { timeout: 30_000 });
  } catch (e) {
    log.warn('注册 Toast 应用身份失败，通知将显示为系统默认身份', (e as Error).message);
    return undefined;
  }

  if (existsSync(lnk)) {
    log.info(`已注册 Toast 应用身份 ${TOAST_AUMID}（通知不再显示为 Microsoft Store）`);
    return TOAST_AUMID;
  }
  return undefined;
}
