import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { makeLogger } from '../logger.js';
import type { Db } from '../core/db.js';

const log = makeLogger('notify/napcat');

/**
 * NapCat 通道配置（dir = 一键包/QQ 容器目录，uin = 快速登录的机器人 QQ 号）。
 * `enabled` = 「使用 NapCat 通道」开关；`autorestart` = 「失活自动拉起」开关，
 * 两者独立：通道关 = 完全不装配 onebot；自动拉起关 = 通道照常、但不在失活时拉起。
 */
export interface NapcatConfig {
  enabled: boolean;
  autorestart: boolean;
  dir: string;
  uin: string;
}

/**
 * 生效配置：settings 表是唯一信源（webui 管理）。
 * settings 键：napcat_enabled '1'/'0'、napcat_autorestart '1'/'0'（缺省关）、
 * napcat_dir、napcat_uin；缺省 = 未配置。
 */
export function getNapcatConfig(db: Db): NapcatConfig {
  return {
    enabled: db.getSetting('napcat_enabled') === '1',
    autorestart: db.getSetting('napcat_autorestart') === '1',
    dir: db.getSetting('napcat_dir') ?? '',
    uin: db.getSetting('napcat_uin') ?? '',
  };
}

/**
 * macOS 版 NapCat 的默认 workdir：NapCat 代码里 darwin 的配置目录固定为
 * `~/Library/Application Support/QQ/NapCat`，而 QQ 是沙盒 app，真实落盘在
 * `~/Library/Containers/com.tencent.qq/Data/...` 容器路径下。onebot11 配置
 * 在该目录的 config/ 下生成（非沙盒进程只能读容器真实路径）。
 */
export function defaultNapcatDir(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin'
    ? join(homedir(), 'Library', 'Containers', 'com.tencent.qq', 'Data', 'Library', 'Application Support', 'QQ', 'NapCat')
    : '';
}

/** 生效目录：settings 填了用它；macOS 上没填回落默认容器 workdir；其他平台空 = 未配置 */
export function effectiveNapcatDir(db: Db, platform: NodeJS.Platform = process.platform): string {
  return db.getSetting('napcat_dir') ?? defaultNapcatDir(platform);
}

/**
 * 面板保存：传空串 = 清空该字段（settings 是唯一信源，不存在 config 回落）。
 * 校验：uin/alertQq 非空时必须纯数字（路由层做）；落库后由装配处 onChanged 热生效。
 */
export function saveNapcatConfig(
  db: Db,
  patch: { enabled?: boolean; autorestart?: boolean; dir?: string; uin?: string; alertQq?: string },
): void {
  if (patch.enabled !== undefined) db.setSetting('napcat_enabled', patch.enabled ? '1' : '0');
  if (patch.autorestart !== undefined) db.setSetting('napcat_autorestart', patch.autorestart ? '1' : '0');
  if (patch.dir !== undefined) {
    if (patch.dir === '') db.deleteSetting('napcat_dir');
    else db.setSetting('napcat_dir', patch.dir);
  }
  if (patch.uin !== undefined) {
    if (patch.uin === '') db.deleteSetting('napcat_uin');
    else db.setSetting('napcat_uin', patch.uin);
  }
  if (patch.alertQq !== undefined) {
    if (patch.alertQq === '') db.deleteSetting('napcat_alert_qq');
    else db.setSetting('napcat_alert_qq', patch.alertQq);
  }
}

/**
 * 健康告警的 QQ 私聊目标（settings `napcat_alert_qq`，留空 = 不向 QQ 告警）。
 * settings 独立读写、不进 NapcatConfig/config 段：它只是告警路由，与托管配置无关。
 */
export function getNapcatAlertQq(db: Db): string {
  return db.getSetting('napcat_alert_qq') ?? '';
}

/** OneBot HTTP 端点（从 NapCat 自己的配置文件发现，DD-claw 只读跟随） */
export interface NapcatEndpoint {
  baseUrl: string;
  token: string;
}

/**
 * 探测三态：
 * - ok：NapCat 进程活着（拿到合法 OneBot JSON 响应；loggedIn 表示 QQ 是否已登录）
 * - down：连接被拒（端口空闲，可以拉起）
 * - conflict：TCP 通但响应不是 OneBot（端口被别的程序占用，拉起也 bind 不上）
 */
export type ProbeResult =
  | { state: 'ok'; loggedIn: boolean }
  | { state: 'down' }
  | { state: 'conflict' };

/** 看门狗常量：拉起冷却、每次拉起后的上线宽限、连续拉起失败放弃阈值、未登录宽限 */
export const WATCHDOG_DEFAULTS = {
  relaunchCooldownMs: 10 * 60_000,
  giveUpAfter: 3,
  notLoggedInGraceMs: 2 * 60_000,
} as const;

/** 计划任务名：一次性 --napcat-setup 创建（/rl highest /it），之后 schtasks /run 静默拉起 */
export const NAPCAT_TASK_NAME = 'DD-claw NapCat';
/** 配套的停止任务：NapCat 被 /rl highest 拉起后是高权限进程，非提权进程杀不掉，停止也得走任务 */
export const NAPCAT_STOP_TASK_NAME = 'DD-claw NapCat Stop';

/**
 * DD-claw 在 onebot11 httpServers 里的专属条目名（用户决策 2026-08-09：
 * 端口管理不靠「取第一个」，DD-claw 自建自管这一条，别的服务条目不受影响）
 */
export const NAPCAT_ENTRY_NAME = 'dd-claw';

/** 自动选端口扫描范围：高位冷门段，避开 3000/8080 等开发常用口 */
const PORT_SCAN_START = 41990;
const PORT_SCAN_COUNT = 50;

interface HttpServerEntry {
  name?: string;
  enable?: boolean;
  host?: string;
  port?: number;
  token?: string;
  [k: string]: unknown;
}

function entryEndpoint(srv: HttpServerEntry): NapcatEndpoint | null {
  if (!srv.port) return null;
  // 0.0.0.0 / :: 是监听地址，连接要走回环
  const host = !srv.host || srv.host === '0.0.0.0' || srv.host === '::' ? '127.0.0.1' : srv.host;
  return { baseUrl: `http://${host}:${srv.port}`, token: srv.token ?? '' };
}

function readOnebotConfig(dir: string, uin: string): { file: string; json: Record<string, unknown> } | null {
  const file = [
    join(dir, 'config', `onebot11_${uin}.json`),
    join(dir, 'config', 'onebot11.json'),
  ].find((f) => existsSync(f));
  if (!file) return null;
  try {
    return { file, json: JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> };
  } catch (e) {
    log.warn(`NapCat 配置 ${file} 不是合法 JSON: ${(e as Error).message}`);
    return null;
  }
}

function httpServersOf(json: Record<string, unknown>): HttpServerEntry[] {
  const network = json['network'] as { httpServers?: HttpServerEntry[] } | undefined;
  return network?.httpServers ?? [];
}

/**
 * 读 onebot11 配置拿 DD-claw 端点：**优先 name=dd-claw 的启用条目**（专属条目，
 * 不受其他服务条目排序影响），没有时回落第一个启用条目（兼容旧配置）。
 * 文件缺失/坏 JSON/无启用项 → null。
 */
export function readOnebotEndpoint(dir: string, uin: string): NapcatEndpoint | null {
  const cfg = readOnebotConfig(dir, uin);
  if (!cfg) return null;
  const servers = httpServersOf(cfg.json).filter((s) => s.enable && s.port);
  const srv = servers.find((s) => s.name === NAPCAT_ENTRY_NAME) ?? servers[0];
  return srv ? entryEndpoint(srv) : null;
}

/** 端口是否空闲（127.0.0.1 上能否 bind） */
async function portFree(port: number): Promise<boolean> {
  return new Promise((resolveP) => {
    const srv = net.createServer();
    srv.once('error', () => resolveP(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolveP(true)));
  });
}

/** 在高位冷门段扫一个空闲端口；全占 → null */
async function findFreePort(): Promise<number | null> {
  for (let p = PORT_SCAN_START; p < PORT_SCAN_START + PORT_SCAN_COUNT; p++) {
    if (await portFree(p)) return p;
  }
  return null;
}

// ---------- webui API（读 onebot 配置 + SetConfig 热重载） ----------

/** NapCat webui 的访问信息（baseUrl + 登录 token），来自 <configDir>/webui.json */
export interface WebuiInfo { baseUrl: string; token: string }

/**
 * 读 webui.json 拿 webui 地址与 token。webui.json 在 NapCat 的 configPath 下
 * （与 onebot11 配置同目录），host/port 为 webui 监听地址（`::`/0.0.0.0 归一化回环）。
 */
export function readWebuiInfo(dir: string): WebuiInfo | null {
  const file = join(dir, 'config', 'webui.json');
  if (!existsSync(file)) return null;
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as { host?: string; port?: number; token?: string };
    const host = !j.host || j.host === '::' || j.host === '0.0.0.0' ? '127.0.0.1' : j.host;
    return { baseUrl: `http://${host}:${j.port ?? 6099}`, token: j.token ?? '' };
  } catch (e) {
    log.warn(`webui.json 解析失败: ${(e as Error).message}`);
    return null;
  }
}

/** 登录 NapCat webui：hash = SHA256(token + ".napcat")，成功返回 Credential（Bearer token） */
export async function loginWebui(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const hash = createHash('sha256').update(token + '.napcat').digest('hex');
  try {
    const res = await fetchImpl(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash }),
      signal: AbortSignal.timeout(5_000),
    });
    const j = (await res.json()) as { code?: number; data?: { Credential?: string } };
    return j.code === 0 && j.data?.Credential ? j.data.Credential : null;
  } catch (e) {
    log.warn(`NapCat webui 登录失败: ${(e as Error).message}`);
    return null;
  }
}

/**
 * 把已落盘的 onebot11_<uin>.json 内容经 webui SetConfig 推给 NapCat，触发即时热重载
 * （用户在 webui 里「关闭再打开」开关生效的原理）。返回是否重载成功；任何一步失败
 * 都返回 false（调用方回落「重启 NapCat 加载文件」），不抛异常。
 */
export async function reloadOnebotConfig(
  dir: string,
  uin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const webui = readWebuiInfo(dir);
  if (!webui) return false;
  const cred = await loginWebui(webui.baseUrl, webui.token, fetchImpl);
  if (!cred) return false;
  const file = join(dir, 'config', `onebot11_${uin}.json`);
  let cfg: unknown;
  try {
    cfg = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  try {
    const res = await fetchImpl(`${webui.baseUrl}/api/OB11Config/SetConfig`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cred}` },
      body: JSON.stringify({ config: JSON.stringify(cfg) }),
      signal: AbortSignal.timeout(8_000),
    });
    const j = (await res.json()) as { code?: number };
    return j.code === 0;
  } catch (e) {
    log.warn(`NapCat onebot 配置热重载失败: ${(e as Error).message}`);
    return false;
  }
}

/**
 * 确保 onebot11 配置里有 name=dd-claw 的启用条目（DD-claw 自管，用户不手动改）：
 * - 没有 → 自动选空闲高位端口创建
 * - 有但被禁用 → 启用
 * - 有但端口被别的程序占用（探测=conflict）→ 换空闲端口
 * 只动 dd-claw 这一条，其他条目原样保留。写文件后经 webui SetConfig 热重载
 * （NapCat 在线时免重启生效；webui 不可用时退回「重启 NapCat 加载文件」）。
 * 返回条目端点；dir 不对/配置损坏/找不到空闲端口 → null。
 */
export async function ensureNapcatEntry(
  dir: string,
  uin: string,
  probe: (ep: NapcatEndpoint) => Promise<ProbeResult> = probeNapCat,
  reload: (dir: string, uin: string) => Promise<boolean> = reloadOnebotConfig,
): Promise<NapcatEndpoint | null> {
  const configDir = join(dir, 'config');
  const file = join(configDir, `onebot11_${uin}.json`);

  let json: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch (e) {
      log.warn(`NapCat 配置 ${file} 不是合法 JSON: ${(e as Error).message}`);
      return null;
    }
  } else if (!existsSync(configDir)) {
    return null; // config 目录都不存在 = dir 填错了，不乱建
  }

  const network = (json['network'] ??= {}) as Record<string, unknown>;
  const servers = (network['httpServers'] ??= []) as HttpServerEntry[];
  let entry = servers.find((s) => s.name === NAPCAT_ENTRY_NAME);
  let changed = false;

  if (!entry) {
    const port = await findFreePort();
    if (port === null) {
      log.warn(`找不到空闲端口（${PORT_SCAN_START}~${PORT_SCAN_START + PORT_SCAN_COUNT - 1} 全被占用）`);
      return null;
    }
    entry = {
      name: NAPCAT_ENTRY_NAME, enable: true, host: '127.0.0.1', port,
      enableCors: true, enableWebsocket: false, messagePostFormat: 'array', token: '', debug: false,
    };
    servers.push(entry);
    changed = true;
    log.info(`已创建 ${NAPCAT_ENTRY_NAME} 条目（端口 ${port}）`);
  } else {
    if (entry.enable !== true) {
      entry.enable = true;
      changed = true;
    }
    if (!entry.port || (await probe(entryEndpoint(entry)!)).state === 'conflict') {
      const oldPort = entry.port;
      const port = await findFreePort();
      if (port === null) {
        log.warn(`找不到空闲端口（${PORT_SCAN_START}~${PORT_SCAN_START + PORT_SCAN_COUNT - 1} 全被占用）`);
        return null;
      }
      entry.port = port;
      changed = true;
      log.info(
        oldPort
          ? `${NAPCAT_ENTRY_NAME} 条目端口 ${oldPort} 被其他程序占用，已改到 ${port}`
          : `${NAPCAT_ENTRY_NAME} 条目缺端口，已分配到 ${port}`,
      );
    }
  }

  if (changed) {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
    // 写盘后经 webui SetConfig 触发热重载（NapCat 在线时免重启；失败则退回重启加载文件）
    await reload(dir, uin);
  }
  return entryEndpoint(entry);
}

export type FetchLike = typeof fetch;

/** POST <baseUrl>/get_login_info 探测 NapCat 存活与登录态（3s 超时） */
export async function probeNapCat(
  endpoint: NapcatEndpoint,
  fetchImpl: FetchLike = fetch,
): Promise<ProbeResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (endpoint.token) headers['Authorization'] = `Bearer ${endpoint.token}`;

  let res: Response;
  try {
    res = await fetchImpl(`${endpoint.baseUrl}/get_login_info`, {
      method: 'POST',
      headers,
      body: '{}',
      signal: AbortSignal.timeout(3_000),
    });
  } catch (e) {
    // 超时 = TCP 通但对端不应答（别的程序占着端口）；连接失败 = 端口空闲
    const name = (e as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') return { state: 'conflict' };
    return { state: 'down' };
  }

  // 401/403 先判：NapCat token 不对时直接拒，响应可能不是 JSON
  if (res.status === 401 || res.status === 403) {
    log.warn(`NapCat 探测鉴权失败 HTTP ${res.status}，token 与 onebot11 配置不一致`);
    return { state: 'ok', loggedIn: false };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    // HTTP 通了但响应不是 JSON：不是 NapCat
    return { state: 'conflict' };
  }
  // OneBot 响应必有 retcode/status 字段
  if (json && typeof json === 'object' && ('retcode' in json || 'status' in json)) {
    const j = json as { retcode?: number; data?: { user_id?: number } };
    return { state: 'ok', loggedIn: j.retcode === 0 && typeof j.data?.user_id === 'number' };
  }
  return { state: 'conflict' };
}

// ---------- 计划任务（一次性提权 + 静默拉起） ----------

export interface RunResult { code: number; stdout: string; stderr: string }
export type Runner = (cmd: string, args: string[]) => Promise<RunResult>;

const defaultRunner: Runner = (cmd, args) =>
  new Promise((resolvePromise) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout, stderr) => {
      resolvePromise({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });

/** 计划任务是否已创建 */
export async function isNapcatTaskRegistered(run: Runner = defaultRunner): Promise<boolean> {
  const r = await run('schtasks', ['/query', '/tn', NAPCAT_TASK_NAME]);
  return r.code === 0;
}

/**
 * 一次性创建「最高权限」计划任务（弹一次 UAC）。
 * 踩过的坑：Start-Process -ArgumentList 数组不会给带空格的元素自动加引号
 * （'DD-claw NapCat' 被平铺拼断，schtasks 语法错误），所以不能经 PowerShell 拼参数。
 * 改为生成两个 .cmd（内容完全自控，引号只转义一层）：
 * - napcat-launch.cmd：任务 action 本体（任务长期引用，必须在稳定目录 = workDir），
 *   复用一键包 launcher.bat（环境变量准备/QQ 路径解析/管理员自检都在里面）
 * - napcat-setup.cmd：提权执行的 schtasks /create，stdout/stderr 落 napcat-setup.log，
 *   失败时把日志尾部带进错误信息
 * /it 让 QQ 跑在交互会话（行为与手动启动一致）。触发器无所谓，只靠 schtasks /run。
 */
export async function setupNapcatTask(
  dir: string,
  uin: string,
  workDir: string,
  run: Runner = defaultRunner,
): Promise<void> {
  mkdirSync(workDir, { recursive: true });
  const wrapper = join(workDir, 'napcat-launch.cmd');
  // launcher.bat 用 %cd% 拼 NAPCAT_* 路径（计划任务默认 cwd 是 System32），必须先 cd 进一键包目录
  writeFileSync(wrapper, `@echo off\r\ncd /d "${dir}"\r\n"launcher.bat" ${uin}\r\n`);

  const logPath = join(workDir, 'napcat-setup.log');
  const stopBat = join(workDir, 'napcat-stop.cmd');
  // NapCat 被高权限任务拉起后非提权进程杀不掉，停止同样做成任务（taskkill /T 连 QQ 子进程一起）
  writeFileSync(stopBat, '@echo off\r\ntaskkill /F /IM NapCatWinBootMain.exe /T\r\n');

  const setupBat = join(workDir, 'napcat-setup.cmd');
  // /tr 只转义一层（CommandLineToArgvW 的 \" 规则）：任务 action = "wrapper"（路径含空格也安全）
  writeFileSync(setupBat,
    `@echo off\r\n` +
    `schtasks /create /tn "${NAPCAT_TASK_NAME}" /tr "\\"${wrapper}\\""` +
    ` /sc once /st 00:00 /rl highest /it /f > "${logPath}" 2>&1\r\n` +
    `if errorlevel 1 exit /b 1\r\n` +
    `schtasks /create /tn "${NAPCAT_STOP_TASK_NAME}" /tr "\\"${stopBat}\\""` +
    ` /sc once /st 00:00 /rl highest /f >> "${logPath}" 2>&1\r\n` +
    `exit /b %ERRORLEVEL%\r\n`);

  // Start-Process 不设置 $LASTEXITCODE（那是会话内原生命令的变量），必须 -PassThru 拿 ExitCode
  const ps = `$p = Start-Process -FilePath '${setupBat}' -Verb runAs -Wait -PassThru; exit $p.ExitCode`;
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  const r = await run('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded]);
  if (r.code !== 0) {
    const tail = existsSync(logPath)
      ? readFileSync(logPath, 'utf8').trim().split(/\r?\n/).slice(-3).join(' | ')
      : '';
    throw new Error(
      `创建计划任务失败（UAC 被拒绝或 schtasks 出错）exit=${r.code}` + (tail ? `：${tail}` : ''),
    );
  }
  if (!(await isNapcatTaskRegistered(run))) {
    throw new Error('计划任务创建后校验失败（schtasks /query 找不到）');
  }
  if ((await run('schtasks', ['/query', '/tn', NAPCAT_STOP_TASK_NAME])).code !== 0) {
    // 停止任务缺失不阻塞：旧版本可能没有，重启 NapCat 能力降级为「仅拉起」
    log.warn('停止任务校验未通过（DD-claw NapCat Stop），重启 NapCat 能力降级为仅拉起');
  }
}

/** 通过计划任务拉起 NapCat（非管理员也可触发自己名下的最高权限任务） */
export async function launchNapcatViaTask(run: Runner = defaultRunner): Promise<boolean> {
  const r = await run('schtasks', ['/run', '/tn', NAPCAT_TASK_NAME]);
  return r.code === 0;
}

/** 通过停止任务杀掉 NapCat（进程树，含注入的 QQ 子进程）；任务不存在/本就停了 = false */
export async function stopNapcatViaTask(run: Runner = defaultRunner): Promise<boolean> {
  const r = await run('schtasks', ['/run', '/tn', NAPCAT_STOP_TASK_NAME]);
  return r.code === 0;
}

/** 彻底移除拉起任务（关闭「自动拉起」开关时调用）；/f 忽略「任务不存在」 */
export async function removeNapcatTask(run: Runner = defaultRunner): Promise<void> {
  await run('schtasks', ['/delete', '/tn', NAPCAT_TASK_NAME, '/f']);
  await run('schtasks', ['/delete', '/tn', NAPCAT_STOP_TASK_NAME, '/f']);
}

// ---------- macOS 拉起（无需提权：NapCat-Mac-Installer 已改 QQ，拉起只是 open） ----------

/** macOS 版 QQ 可执行文件（NapCat-Mac-Installer 改过 package.json 的版本） */
export const MAC_QQ_PATH = '/Applications/QQ.app/Contents/MacOS/QQ';

/** macOS 拉起能力就绪 = QQ.app 存在（安装器已注入 NapCat，无需 DD-claw 建任务） */
export function macNapcatInstalled(): boolean {
  return existsSync(MAC_QQ_PATH);
}

/**
 * macOS 拉起 NapCat（含快速登录）：`open -a QQ --args --no-sandbox --qq <uin>`。
 * --no-sandbox 是安装器要求；--qq 进 QQ 主进程 process.argv，由 NapCat shell/base.ts
 * 读取做快速登录（等价 Windows 的 launcher.bat <uin>）。经 open 走 LaunchServices，
 * QQ 获得正常 GUI 会话上下文。
 */
export async function launchMacNapcat(uin: string, run: Runner = defaultRunner): Promise<boolean> {
  const r = await run('open', ['-a', 'QQ', '--args', '--no-sandbox', '--qq', uin]);
  return r.code === 0;
}

/** macOS 停止 NapCat（配置变更需重启时用）：优雅退出 QQ */
export async function stopMacNapcat(run: Runner = defaultRunner): Promise<boolean> {
  const r = await run('osascript', ['-e', 'tell application "QQ" to quit']);
  return r.code === 0;
}

// ---------- 拉起能力抽象（Windows 计划任务 / macOS open QQ） ----------

export interface NapcatRelaunchDriver {
  platform: NodeJS.Platform;
  /** 拉起能力是否就绪：Windows = 计划任务已创建；macOS = QQ.app 存在（无持久任务） */
  available: () => Promise<boolean>;
  /** 一次性创建拉起能力：Windows = 弹一次 UAC 建计划任务；macOS = no-op（安装器已处理） */
  setup: (dir: string, uin: string, workDir: string) => Promise<void>;
  /** 彻底移除拉起能力：Windows = schtasks /delete；macOS = no-op（无持久任务） */
  remove: () => Promise<void>;
  /** 拉起（返回 false = 命令失败） */
  launch: (uin: string) => Promise<boolean>;
  /** 停止实例（配置变更需重启时用；返回 false = 命令失败/未运行） */
  stop: () => Promise<boolean>;
}

/** 按平台装配拉起能力：win32 = schtasks（一次 UAC 提权）；darwin = open QQ（无需提权） */
export function napcatRelaunchDriver(
  platform: NodeJS.Platform = process.platform,
  run: Runner = defaultRunner,
): NapcatRelaunchDriver {
  if (platform === 'win32') {
    return {
      platform: 'win32',
      available: () => isNapcatTaskRegistered(run),
      setup: (dir, uin, workDir) => setupNapcatTask(dir, uin, workDir, run),
      remove: () => removeNapcatTask(run),
      launch: () => launchNapcatViaTask(run),
      stop: () => stopNapcatViaTask(run),
    };
  }
  return {
    platform,
    available: async () => macNapcatInstalled(),
    setup: async () => {},
    remove: async () => {},
    launch: (uin) => launchMacNapcat(uin, run),
    stop: () => stopMacNapcat(run),
  };
}

// ---------- 看门狗 ----------

export interface NapcatWatchdogDeps {
  /** 生效的 dir/uin（每 tick 取一次：面板改了热生效） */
  target: () => { dir: string; uin: string };
  /** 「失活自动拉起」开关（每 tick 取，热生效）；缺省关 = 只探测/告警不拉起 */
  autoRestart?: () => boolean;
  /** 拉起能力驱动（平台装配）；缺省按 process.platform 装配 */
  driver?: NapcatRelaunchDriver;
  /** 探测（可注入假实现） */
  probe?: (endpoint: NapcatEndpoint) => Promise<ProbeResult>;
  /** 自建/修复 dd-claw 条目（可注入假实现）；缺省 = ensureNapcatEntry */
  ensure?: (dir: string, uin: string) => Promise<NapcatEndpoint | null>;
  /** 拉起能力是否就绪（可注入假实现）；缺省 = driver.available() */
  available?: () => Promise<boolean>;
  /** 拉起（可注入假实现）；返回 false = 拉起命令本身失败（如计划任务不存在）。缺省 = driver.launch(uin) */
  relaunch?: (uin: string) => Promise<boolean>;
  /** 停止旧实例（可注入假实现）；配置变更需要重启生效时用。缺省 = driver.stop() */
  stop?: () => Promise<boolean>;
  /** 等待（可注入假实现，测试免真实 sleep）。缺省 = setTimeout */
  wait?: (ms: number) => Promise<void>;
  /** 端点热跟随：onebot11 配置的端口/token 变了回调（接 OneBotNotifier.updateEndpoint） */
  onEndpoint?: (endpoint: NapcatEndpoint) => void;
  /** 告警（接 bus health_alert；message 为完整自定义文案） */
  alert?: (message: string) => void;
  now?: () => number;
}

/**
 * NapCat 看门狗状态机。每 tick 一轮（由 PeriodicTask 驱动）：
 * 读 dd-claw 专属条目（缺了自建）→ 探测 → ok 复位 / down（自动拉起开且能力就绪时
 * 冷却内拉起）/ conflict 自动换端口再拉起 / ok 但长时间未登录提示扫码。
 * 双平台共用：拉起能力由 driver 装配（Windows 计划任务 / macOS open QQ），
 * 自动拉起开关独立于「使用 NapCat 通道」——关 = 只探测/告警/热跟随，绝不拉起。
 */
export class NapcatWatchdog {
  private lastEndpointKey = '';
  private failCount = 0;
  private gaveUp = false;
  private lastLaunchAt = -Infinity;
  private lastState: ProbeResult['state'] | null = null;
  private notLoggedInSince = 0;
  private loginAlerted = false;
  private configAlerted = false;
  private unavailableAlerted = false;
  /** 最近一次 ok 的端点：配置变更后旧实例仍在新配置端口 down、旧端口 ok 时识别「陈旧实例」 */
  private lastOkEndpoint: NapcatEndpoint | null = null;

  private readonly driver: NapcatRelaunchDriver;

  constructor(private readonly deps: NapcatWatchdogDeps) {
    this.driver = this.deps.driver ?? napcatRelaunchDriver();
  }

  private readonly probe = (ep: NapcatEndpoint): Promise<ProbeResult> =>
    this.deps.probe ? this.deps.probe(ep) : probeNapCat(ep);

  private readonly ensure = (dir: string, uin: string): Promise<NapcatEndpoint | null> =>
    this.deps.ensure ? this.deps.ensure(dir, uin) : ensureNapcatEntry(dir, uin);

  private readonly wait = (ms: number): Promise<void> =>
    this.deps.wait ? this.deps.wait(ms) : new Promise((r) => setTimeout(r, ms));

  private readonly now = (): number => (this.deps.now ? this.deps.now() : Date.now());

  private readonly autoRestart = (): boolean => this.deps.autoRestart ? this.deps.autoRestart() : false;

  private readonly available = (): Promise<boolean> =>
    this.deps.available ? this.deps.available() : this.driver.available();

  private readonly relaunchCmd = (uin: string): Promise<boolean> =>
    this.deps.relaunch ? this.deps.relaunch(uin) : this.driver.launch(uin);

  private readonly stopCmd = (): Promise<boolean> =>
    this.deps.stop ? this.deps.stop() : this.driver.stop();

  private alert(message: string): void {
    log.warn(message);
    this.deps.alert?.(message);
  }

  private followEndpoint(ep: NapcatEndpoint): void {
    const key = `${ep.baseUrl}|${ep.token}`;
    if (key === this.lastEndpointKey) return;
    const first = this.lastEndpointKey === '';
    this.lastEndpointKey = key;
    if (!first) log.info(`NapCat 端点已变更，热跟随: ${ep.baseUrl}`);
    this.deps.onEndpoint?.(ep);
  }

  private async relaunch(): Promise<void> {
    this.lastLaunchAt = this.now();
    this.failCount++;
    const { uin } = this.deps.target();
    const fired = await this.relaunchCmd(uin);
    if (fired) {
      log.info(`NapCat 不在线，已拉起（第 ${this.failCount} 次）`);
    } else {
      log.warn('NapCat 拉起命令失败（拉起能力不可用？）');
    }
    if (this.failCount >= WATCHDOG_DEFAULTS.giveUpAfter) {
      this.gaveUp = true;
      this.alert(
        `NapCat 连续 ${this.failCount} 次拉起后仍不在线，已停止自动拉起。` +
        `请手动启动 NapCat 并确认 QQ 已登录（QQ 推送通道当前不可用，系统通知不受影响）。`,
      );
    }
  }

  async tick(): Promise<void> {
    const { dir, uin } = this.deps.target();
    let ep = readOnebotEndpoint(dir, uin);
    if (!ep) {
      // 缺 dd-claw 条目 → 自建（写 onebot11，NapCat 重启后生效，由后续 down 流程拉起）
      ep = await this.ensure(dir, uin);
      if (!ep) {
        if (!this.configAlerted) {
          this.configAlerted = true;
          this.alert(`无法在 ${dir} 读取/创建 NapCat onebot11 配置，请检查 NapCat 路径是否填对`);
        }
        return;
      }
    }
    this.configAlerted = false;
    this.followEndpoint(ep);

    let r = await this.probe(ep);

    if (r.state === 'conflict') {
      // 端口被别的程序占用：自动换端口（写 onebot11），再按 down 流程拉起使新端口生效
      const fixed = await this.ensure(dir, uin);
      if (!fixed) {
        if (this.lastState !== 'conflict') {
          this.alert(`NapCat 端口 ${new URL(ep.baseUrl).port} 被其他程序占用，且自动换端口失败，请检查 ${dir}`);
        }
        this.lastState = 'conflict';
        return;
      }
      if (fixed.baseUrl !== ep.baseUrl) {
        log.info(`端口冲突已自动修复: ${ep.baseUrl} → ${fixed.baseUrl}，重启 NapCat 使新端口生效`);
      }
      ep = fixed;
      this.followEndpoint(ep);
      r = { state: 'down' };
    }

    if (r.state === 'ok') {
      if (this.lastState && this.lastState !== 'ok') log.info('NapCat 已恢复');
      this.lastState = 'ok';
      this.lastOkEndpoint = ep;
      this.failCount = 0;
      this.gaveUp = false;
      this.lastLaunchAt = -Infinity;
      if (r.loggedIn) {
        this.notLoggedInSince = 0;
        this.loginAlerted = false;
      } else {
        if (this.notLoggedInSince === 0) this.notLoggedInSince = this.now();
        if (!this.loginAlerted && this.now() - this.notLoggedInSince >= WATCHDOG_DEFAULTS.notLoggedInGraceMs) {
          this.loginAlerted = true;
          this.alert('NapCat 已启动但 QQ 未登录。请打开 NapCat webui（默认 http://127.0.0.1:6099）扫码登录。');
        }
      }
      return;
    }

    // down：自动拉起开且能力就绪时，冷却内拉起，连续失败到阈值放弃并告警（保持探测，恢复自动复位）
    this.lastState = 'down';

    // 自动拉起关闭：只探测/告警/热跟随，绝不拉起；顺带复位计数（下次重开即全新起点）
    if (!this.autoRestart()) {
      this.gaveUp = false;
      this.failCount = 0;
      this.lastLaunchAt = -Infinity;
      return;
    }

    // 拉起能力不可用（计划任务被删 / macOS 上 QQ 不存在）：告警一次，不拉起
    if (!(await this.available())) {
      if (!this.unavailableAlerted) {
        this.unavailableAlerted = true;
        this.alert('NapCat 不在线且自动拉起能力不可用（拉起任务被移除？请重新开启「失活自动拉起」重建）。');
      }
      return;
    }
    this.unavailableAlerted = false;

    if (this.gaveUp) return;

    // 配置已变更但旧实例还在旧端口上跑（陈旧实例）→ 先停再拉起让新配置生效；
    // 这是配置生效重启，不受故障冷却限制
    const staleEp = this.lastOkEndpoint;
    if (staleEp && staleEp.baseUrl !== ep.baseUrl && (await this.probe(staleEp)).state === 'ok') {
      this.lastOkEndpoint = null;
      log.info(`NapCat 还在旧配置（${staleEp.baseUrl}）上运行，停止后重启以生效 ${ep.baseUrl}`);
      if (!(await this.stopCmd())) log.warn('停止旧 NapCat 实例失败，直接拉起');
      await this.wait(3_000);
      return this.relaunch();
    }

    if (this.now() - this.lastLaunchAt < WATCHDOG_DEFAULTS.relaunchCooldownMs) return;
    return this.relaunch();
  }
}
