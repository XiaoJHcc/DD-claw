import { execFile } from 'node:child_process';
import { makeLogger } from '../logger.js';
import type { PushMessage } from '../core/types.js';
import { localizeImage } from './image-cache.js';
import { type Notifier, type NotifyResult } from './types.js';
import { macNotifierArgs, spawnMacNotifier, type Runner, type SpawnMac } from './mac-notifier.js';

const log = makeLogger('notify/toast');

/**
 * 本机系统通知（跨平台）：
 * - Windows：powertoast v3 的 Toast 类 API（注册 DD-claw 的 Win32 AUMID，通知显示为
 *   「DD-claw」）；缺省时借用 Microsoft Store 身份，通知照发。Win32 身份不支持远程图
 *   （微软限制），所以 http 图先经 image-cache 本地化；失败按无图发送。
 * - macOS：DD-claw.app 原生 helper（Swift 编译，见 mac-notifier.ts）——正确的
 *   应用名 + 点击跳转 + 内容图；swiftc 不可用时回落 osascript（名字是「脚本编辑器」、
 *   无点击跳转、无图，仅兜底）。
 *
 * 它在 M1 里的真正作用不是「多一个通道」，而是**独立兜底**：
 * NapCat 掉线或 QQ 被踢时，QQ 通道本身就是坏的，没法告诉你「监听坏了」。
 * 这时只有本机系统通知能通知你。
 */
export interface ToastOptions {
  /** 平台（缺省 process.platform），注入用于测试 */
  platform?: NodeJS.Platform;
  /** macOS：已编译的 helper 二进制路径（null = 回落 osascript） */
  macHelper?: string | null;
  /** macOS helper 的 spawn（注入用于测试） */
  spawnMac?: SpawnMac;
  /** macOS osascript 执行器（注入用于测试） */
  runMac?: Runner;
}

export class ToastNotifier implements Notifier {
  readonly name = 'toast';
  readonly capabilities: { image: boolean; clickThrough: boolean };

  private readonly platform: NodeJS.Platform;
  private readonly macHelper: string | null;
  private readonly spawnMac: SpawnMac;
  private readonly runMac: Runner;

  constructor(
    private readonly aumid?: string,
    private readonly cacheDir?: string,
    opts: ToastOptions = {},
  ) {
    this.platform = opts.platform ?? process.platform;
    this.macHelper = opts.macHelper ?? null;
    this.spawnMac = opts.spawnMac ?? spawnMacNotifier;
    this.runMac = opts.runMac ?? defaultRunner;
    const macFull = this.platform === 'darwin' && this.macHelper !== null;
    this.capabilities = this.platform === 'win32'
      ? { image: true, clickThrough: true }
      : macFull ? { image: true, clickThrough: true } : { image: false, clickThrough: false };
  }

  async send(msg: PushMessage): Promise<NotifyResult[]> {
    return [await this.show(msg.title, msg.body, msg.image ?? '', msg.url ?? '', msg.icon ?? '', msg.attribution ?? '')];
  }

  async alert(title: string, body: string): Promise<void> {
    await this.show(`【告警】${title}`, body, '', '', '', '');
  }

  private async show(
    title: string, message: string, image: string, url: string,
    icon: string, attribution: string,
  ): Promise<NotifyResult> {
    if (this.platform === 'darwin') {
      return this.showMac(title, message, attribution, image, url);
    }
    if (this.platform !== 'win32') {
      log.warn(`本机系统通知不支持平台 ${this.platform}，跳过`);
      return { ok: false, error: `不支持的平台 ${this.platform}`, retryable: false };
    }

    // Win32 身份要本地图；没配缓存目录就放弃图，不阻塞通知
    if (image && /^https?:/i.test(image)) {
      image = this.cacheDir ? (await localizeImage(image, this.cacheDir)) ?? '' : '';
    }
    if (icon && /^https?:/i.test(icon)) {
      icon = this.cacheDir ? (await localizeImage(icon, this.cacheDir)) ?? '' : '';
    }
    const opts: Record<string, unknown> = {
      title: title || 'DD-claw',
      message,
      silent: false,
    };
    if (this.aumid) opts['aumid'] = this.aumid;
    // 左侧方形头像（appLogoOverride，默认不裁圆）：刚开播没有关键帧时通知也有图
    if (icon) opts['icon'] = icon;
    // heroImg 是顶部大图横幅，有直播关键帧时作预览
    if (image) opts['heroImg'] = image;
    // 底部小灰字行（分区 · 开播时间）
    if (attribution) opts['attribution'] = attribution;
    // 点击整条通知时用默认浏览器打开直播间
    if (url) opts['activation'] = url;

    try {
      const { Toast } = await import('powertoast');
      await new Toast(opts).show();
      return { ok: true, target: 'local' };
    } catch (e) {
      const msg = (e as Error).message;
      log.warn('Toast 弹出失败', msg);
      return { ok: false, error: msg, retryable: false };
    }
  }

  private async showMac(
    title: string, message: string, subtitle: string, image: string, url: string,
  ): Promise<NotifyResult> {
    if (this.macHelper) {
      // 内容图（http）先本地化给 contentImage；失败按无图，不阻塞通知
      let img = image;
      if (img && /^https?:/i.test(img)) {
        img = this.cacheDir ? (await localizeImage(img, this.cacheDir)) ?? '' : '';
      }
      const args = macNotifierArgs({ title, subtitle, message, url, image: img });
      try {
        await this.spawnMac(this.macHelper, args);
        return { ok: true, target: 'local' };
      } catch (e) {
        log.warn('系统通知 helper 启动失败，回落 osascript', (e as Error).message);
      }
    }

    // 回落 osascript（无应用名 / 无点击跳转 / 无图，仅兜底）
    const script = buildMacNotificationScript(title, message, subtitle);
    const r = await this.runMac('osascript', ['-e', script]);
    if (r.code !== 0) {
      log.warn('系统通知弹出失败', r.stderr);
      return { ok: false, error: r.stderr, retryable: false };
    }
    return { ok: true, target: 'local' };
  }
}

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

/**
 * 组装 macOS 的 osascript 通知脚本（回落路径）。内容直接内嵌进 AppleScript 字符串并转义，
 * 不经过 shell 层（execFile 数组传参），所以只需处理 AppleScript 一层转义：
 * 反斜杠、双引号，以及换行/回车/制表等会破坏字符串字面量的控制字符。
 * 注意替换顺序：先转义反斜杠，再转义引号与控制字符（它们产出的字面 `\x` 不得被二次转义）。
 */
export function buildMacNotificationScript(title: string, message: string, subtitle = ''): string {
  return 'display notification ' + appleScriptStr(message)
    + ' with title ' + appleScriptStr(title || 'DD-claw')
    + (subtitle ? ' subtitle ' + appleScriptStr(subtitle) : '');
}

function appleScriptStr(s: string): string {
  return '"' + s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t') + '"';
}
