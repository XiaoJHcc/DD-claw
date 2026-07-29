import { makeLogger } from '../logger.js';
import type { LiveEvent } from '../core/types.js';
import { formatEventText, type Notifier, type NotifyResult } from './types.js';
import type { NotifyTarget } from '../config/schema.js';

const log = makeLogger('notify/onebot');

interface Segment {
  type: 'text' | 'image';
  data: Record<string, string>;
}

interface OneBotResponse {
  status?: string;
  retcode?: number;
  message?: string;
  wording?: string;
}

/** reached 表示请求是否真的到达了 NapCat（拿到了 HTTP 响应） */
type PostResult = NotifyResult & { reached: boolean };

export class OneBotNotifier implements Notifier {
  readonly name = 'onebot';
  readonly capabilities = { image: true, clickThrough: false };

  /** 同一目标两条消息之间的最小间隔 */
  private static readonly MIN_GAP_MS = 1_200;
  /** 每个目标一条串行链，key 是 `${type}:${id}` */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly targets: NotifyTarget[],
  ) {}

  async send(event: LiveEvent): Promise<NotifyResult[]> {
    const active = this.targets.filter((t) => t.enabled);
    const withImage = this.buildSegments(event, true);

    return this.mapTargets(active, async (t) => {
      const label = `${t.type}:${t.id}`;
      const first = await this.post(t, withImage);
      if (first.ok) return { ...first, target: label };

      // 图片失败降级为纯文本重发一次 —— 预览图是锦上添花，通知本身不能丢。
      // 但只在请求真的到达了 NapCat 时才降级：连接层失败（reached=false）
      // 说明 NapCat 压根不通，去掉图片重试必然同样失败，白费一次请求。
      if (event.keyframe && first.reached) {
        log.warn(`${label} 带图失败，降级纯文本重试`, first.error);
        const retry = await this.post(t, this.buildSegments(event, false));
        return { ...retry, target: label };
      }
      return { ...first, target: label };
    });
  }

  /**
   * 同一个目标（尤其是群）的消息串行发并留最小间隔。
   * 官方文档给的群聊主动推送上限是单群 20 条/分钟，多主播同时开播时
   * 并发轰同一个群很容易撞上。不同目标之间仍并行。
   */
  private async mapTargets(
    targets: NotifyTarget[],
    fn: (t: NotifyTarget) => Promise<NotifyResult>,
  ): Promise<NotifyResult[]> {
    const results = await Promise.all(targets.map(async (t) => {
      const key = `${t.type}:${t.id}`;
      const prior = this.chains.get(key) ?? Promise.resolve();
      const next = prior
        .then(() => fn(t))
        .catch((e) => ({ ok: false, error: String(e), retryable: true, target: key }));
      // 链上只保留「已完成」的信号，不保留结果，避免内存里挂住旧 payload
      this.chains.set(key, next.then(() => this.gap()));
      return next;
    }));
    return results;
  }

  private gap(): Promise<void> {
    return new Promise((r) => setTimeout(r, OneBotNotifier.MIN_GAP_MS));
  }

  async alert(title: string, body: string): Promise<void> {
    const seg: Segment[] = [{ type: 'text', data: { text: `⚠️ ${title}\n${body}` } }];
    await this.mapTargets(
      this.targets.filter((x) => x.enabled),
      async (t) => this.post(t, seg),
    );
  }

  private buildSegments(e: LiveEvent, withImage: boolean): Segment[] {
    const segs: Segment[] = [{ type: 'text', data: { text: formatEventText(e) + '\n' } }];
    if (withImage && e.keyframe) {
      // 直接用B站 CDN 的公网 URL，NapCat 自己去拉，我们不落盘不 base64
      segs.push({ type: 'image', data: { file: e.keyframe } });
    }
    segs.push({ type: 'text', data: { text: `\n${e.roomUrl}` } });
    return segs;
  }

  private async post(target: NotifyTarget, message: Segment[]): Promise<PostResult> {
    const action = target.type === 'private' ? 'send_private_msg' : 'send_group_msg';
    const body = target.type === 'private'
      ? { user_id: Number(target.id), message }
      : { group_id: Number(target.id), message };

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/${action}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      return {
        ok: false, reached: false, retryable: true,
        error: `连接 NapCat 失败: ${(e as Error).message}`,
      };
    }

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false, reached: true, retryable: false,
        error: `鉴权失败 HTTP ${res.status}，检查 NAPCAT_TOKEN`,
      };
    }
    if (!res.ok) {
      return {
        ok: false, reached: true, retryable: res.status >= 500,
        error: `HTTP ${res.status} ${res.statusText}`,
      };
    }

    let json: OneBotResponse;
    try {
      json = (await res.json()) as OneBotResponse;
    } catch {
      return { ok: false, reached: true, retryable: true, error: '响应不是合法 JSON' };
    }

    // status 为 ok 但 retcode != 0 也是失败
    if (json.retcode !== 0) {
      const detail = json.wording || json.message || '(无 message)';
      return {
        ok: false, reached: true, retryable: false,
        error: `retcode=${json.retcode} ${detail}`,
      };
    }
    return { ok: true, reached: true };
  }
}
