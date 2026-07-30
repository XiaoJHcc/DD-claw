import { makeLogger } from '../logger.js';
import type { PushMessage } from '../core/types.js';
import { type Notifier, type NotifyResult } from './types.js';

const log = makeLogger('notify/toast');

/**
 * 本机 Windows Toast（powertoast v3 的 Toast 类 API）。
 *
 * 它在 M1 里的真正作用不是「多一个通道」，而是**独立兜底**：
 * NapCat 掉线或 QQ 被踢时，QQ 通道本身就是坏的，没法告诉你「监听坏了」。
 * 这时只有 Toast 能通知你。
 */
export class ToastNotifier implements Notifier {
  readonly name = 'toast';
  readonly capabilities = { image: true, clickThrough: true };

  async send(msg: PushMessage): Promise<NotifyResult[]> {
    return [await this.show(msg.title, msg.body, msg.image ?? '', msg.url ?? '')];
  }

  async alert(title: string, body: string): Promise<void> {
    await this.show(`⚠️ ${title}`, body, '', '');
  }

  private async show(title: string, message: string, image: string, url: string): Promise<NotifyResult> {
    const opts: Record<string, unknown> = {
      title: title || 'DD-claw',
      message,
      silent: false,
    };
    // heroImg 是顶部大图横幅，比 icon 的小缩略图更适合直播预览
    if (image) opts['heroImg'] = image;
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
}
