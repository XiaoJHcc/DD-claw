import { pathToFileURL } from 'node:url';
import { makeLogger } from '../logger.js';
import type { PushMessage, PushTarget } from '../core/types.js';
import { isLocalImage } from './image-cache.js';
import { type Notifier, type NotifyResult } from './types.js';

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
    private baseUrl: string,
    private token: string,
  ) {}

  /** NapCat 看门狗热跟随：webui 改了端口/token 时免重启更新端点 */
  updateEndpoint(baseUrl: string, token: string): void {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
  }

  async send(msg: PushMessage): Promise<NotifyResult[]> {
    // 常规发送只看 msg.targets（dispatcher 已按选中渠道解析好），空数组 = 不发。
    // config 的 onebot.targets 不进这里，仅由装配处用作 push_channels 种子与
    // --test-notify 验证目标。
    const active = (msg.targets ?? [])
      .filter((t) => {
        if (/^\d+$/.test(t.id)) return true;
        // 目标号是人手填的，填错记日志跳过，不能炸掉整条推送
        log.warn(`跳过无效推送目标 ${t.type}:"${t.id}"（id 必须是纯数字QQ号/群号）`);
        return false;
      });
    const withImage = this.buildSegments(msg, true);

    return this.mapTargets(active, async (t) => {
      const label = `${t.type}:${t.id}`;
      const first = await this.post(t, withImage);
      if (first.ok) return { ...first, target: label };

      // 图片失败降级为纯文本重发一次 —— 预览图是锦上添花，通知本身不能丢。
      // 但只在请求真的到达了 NapCat 时才降级：连接层失败（reached=false）
      // 说明 NapCat 压根不通，去掉图片重试必然同样失败，白费一次请求。
      if ((msg.images?.length || msg.image) && first.reached) {
        log.warn(`${label} 带图失败，降级纯文本重试`, first.error);
        const retry = await this.post(t, this.buildSegments(msg, false));
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
    targets: PushTarget[],
    fn: (t: PushTarget) => Promise<NotifyResult>,
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

  private buildSegments(msg: PushMessage, withImage: boolean): Segment[] {
    // 段序：标题+正文 → 图片 → attribution（分区 · 开播时间 / 帖子的发布时间）+ 链接。
    // QQ 没有小灰字概念，attribution 拼成正文尾行；图片要在它之前，时间行才是消息的收尾。
    const segs: Segment[] = [{ type: 'text', data: { text: `${msg.title}\n${msg.body}` } }];
    const images = withImage ? (msg.images?.length ? msg.images : msg.image ? [msg.image] : []) : [];
    for (const img of images) {
      // B站 CDN 是公网可达的，直接给 URL 让 NapCat 自己拉，不落盘不 base64；
      // 本地路径（X 图经代理下载后的形态）转成 file:// —— NapCat 与本进程同机，只能取本地。
      segs.push({ type: 'image', data: { file: isLocalImage(img) ? pathToFileURL(img).href : img } });
    }
    const tail = (msg.attribution ? `\n${msg.attribution}` : '') + (msg.url ? `\n${msg.url}` : '');
    if (tail) segs.push({ type: 'text', data: { text: tail } });
    return segs;
  }

  private async post(target: PushTarget, message: Segment[]): Promise<PostResult> {
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
