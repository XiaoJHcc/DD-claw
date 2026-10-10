/**
 * NapCat 侧的「事件上报地址」注册（P3）：让 NapCat 把 QQ 消息推到 DD-claw 的 `POST /onebot`。
 *
 * NapCat 的 OneBot 11 配置里，**上报**属于 `network.httpClients`（NapCat 作为 HTTP 客户端主动
 * 把事件 POST 给我们的地址），与 `httpServers`（我们调 `send_group_msg` 的那条）是两个方向。
 * 本仓 `src/notify/napcat.ts` 早已自管 `httpServers` 里 `name=dd-claw` 的条目（端口自选、热重载），
 * 这里**顺着同一个机制**自管 `httpClients` 里 `name=dd-claw-qqbot` 的条目：
 * 只动这一条，别的条目原样保留；写完经 NapCat webui 的 SetConfig 热重载（复用
 * `reloadOnebotConfig`），热重载失败则下次重启 NapCat 生效。
 *
 * 不硬来的地方：路径读不到（dir 填错 / 配置不存在）、JSON 坏、reload 失败都**不抛**，
 * 一律返回 `failed`/`reloaded:false`，由装配根打日志并提示手工配置步骤（见 docs/modules/qqbot.md）。
 *
 * 为什么自管是安全的：这条 entry 的名字是 DD-claw 专属（`dd-claw-qqbot`），与主人手建的
 * HTTP 客户端条目互不影响；NapCat 配置文件的读写方式与 `ensureNapcatEntry` 完全同源。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeLogger } from '../logger.js';
import { reloadOnebotConfig } from '../notify/napcat.js';

const log = makeLogger('qqbot/napcat');

/** DD-claw 在 `network.httpClients` 里的专属条目名（与 httpServers 的 `dd-claw` 区分开） */
export const QQ_POST_ENTRY_NAME = 'dd-claw-qqbot';
/** 面板上事件接收路由的路径（**不在 /api 下**：它是消息入口，不是主人能力面） */
export const QQ_POST_PATH = '/onebot';

export interface HttpClientEntry {
  name?: string;
  enable?: boolean;
  url?: string;
  messagePostFormat?: string;
  reportSelfMessage?: boolean;
  token?: string;
  debug?: boolean;
  [k: string]: unknown;
}

/** 事件上报地址：面板只监听回环，NapCat 与本进程同机（主机名固定 127.0.0.1） */
export function qqPostUrl(panelPort: number): string {
  return `http://127.0.0.1:${panelPort}${QQ_POST_PATH}`;
}

export interface EnsurePostEntryResult {
  status: 'created' | 'updated' | 'unchanged' | 'failed';
  /** 人类可读的细节（进日志） */
  detail: string;
  /** 写盘后是否经 webui 热重载成功（false = 需重启 NapCat 才生效） */
  reloaded?: boolean;
}

function configFile(dir: string, uin: string): string | null {
  return [
    join(dir, 'config', `onebot11_${uin}.json`),
    join(dir, 'config', 'onebot11.json'),
  ].find((f) => existsSync(f)) ?? null;
}

/**
 * 确保 `network.httpClients` 里有指向 `url` 的 `dd-claw-qqbot` 条目。
 * 幂等：地址与开关都一致时**不写盘、不重载**（避免每次启动都触发 NapCat 热重载）。
 *
 * @param reload 热重载注入点（测试用）；缺省 = `reloadOnebotConfig`（NapCat webui SetConfig）
 */
export async function ensureNapcatHttpClient(
  dir: string,
  uin: string,
  url: string,
  reload: (dir: string, uin: string) => Promise<boolean> = reloadOnebotConfig,
): Promise<EnsurePostEntryResult> {
  if (!dir || !uin) return { status: 'failed', detail: 'NapCat 目录/QQ 号未配置' };
  const file = configFile(dir, uin);
  if (file === null) return { status: 'failed', detail: `未找到 ${join(dir, 'config')} 下的 onebot11 配置` };

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    return { status: 'failed', detail: `${file} 不是合法 JSON：${(e as Error).message}` };
  }

  const network = (json['network'] ??= {}) as Record<string, unknown>;
  const clients = (network['httpClients'] ??= []) as HttpClientEntry[];
  if (!Array.isArray(clients)) return { status: 'failed', detail: 'network.httpClients 不是数组（配置形状不对）' };

  let entry = clients.find((c) => c.name === QQ_POST_ENTRY_NAME);
  let status: EnsurePostEntryResult['status'] = 'unchanged';
  if (!entry) {
    entry = {
      name: QQ_POST_ENTRY_NAME, enable: true, url,
      messagePostFormat: 'array', reportSelfMessage: false, token: '', debug: false,
    };
    clients.push(entry);
    status = 'created';
  } else {
    // 只强制我们自己在意的四个字段，其余（token/debug 等主人手改过的值）保持原样
    if (entry.enable !== true) { entry.enable = true; status = 'updated'; }
    if (entry.url !== url) { entry.url = url; status = 'updated'; }
    if (entry.messagePostFormat !== 'array') { entry.messagePostFormat = 'array'; status = 'updated'; }
    if (entry.reportSelfMessage !== false) { entry.reportSelfMessage = false; status = 'updated'; }
  }

  if (status === 'unchanged') return { status, detail: `已就绪 ${url}` };

  try {
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
  } catch (e) {
    return { status: 'failed', detail: `写 ${file} 失败：${(e as Error).message}` };
  }
  // 写盘后经 webui SetConfig 热重载；NapCat 不在线/失败也无所谓（下次启动读文件即生效）
  let reloaded = false;
  try {
    reloaded = await reload(dir, uin);
  } catch (e) {
    log.warn(`onebot 配置热重载失败：${(e as Error).message}`);
  }
  return { status, detail: `${file} 的 ${QQ_POST_ENTRY_NAME} 条目已${status === 'created' ? '创建' : '更新'}为 ${url}`, reloaded };
}