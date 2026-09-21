/**
 * OneBot 11 事件解析（P3 NapCat 直连的入口层，docs/plan/agent-access.md「P3：NapCat 直连」）。
 *
 * 只认**消息事件**（`post_type === 'message'`，`message_type` = group/private），其余（心跳、
 * 通知、请求、其他平台的事件）一律返回 null 被忽略；**忽略自发消息**（`user_id === self_id`，
 * NapCat 侧 reportSelfMessage=false 已经挡一层，这里再挡一层——身份判定不能只靠对端配置）。
 *
 * 消息体两种格式都收：
 * - **数组格式**（NapCat 默认，也是本仓 onebot11 条目里 messagePostFormat='array' 的口径）：
 *   `message: [{type:'at',data:{qq:'10001'}},{type:'text',data:{text:' 加主播'}}]`
 * - **字符串格式**（CQ 码）：`message: '[CQ:at,qq=10001] 加主播'`——就地拆成同样的段，
 *   免得下层的触发判定要写两套。
 *
 * 安全口径（信任模型见 plan「信任模型」表）：`group_id` / `user_id` / `self_id` 是 NapCat 直接给的
 * **可信锚点**，只在这里读一次，之后一路以结构化字段往下传，**绝不进任何工具参数**；
 * 事件本身没有鉴权——上报地址绑 127.0.0.1（面板只监听回环），能 POST /onebot 的进程本来就能
 * 访问面板的 /api/*，故 v1 不做 HMAC 盖章（plan 明确「v2 的 HMAC 盖章不需要」）。
 *
 * 关键坑：数组格式的 text 段里，`[` `]` `&` 会被转义成 `&#91;` `&#93;` `&amp;`，必须还原，
 * 否则模型看到的是实体码。
 */

/** 会话类型：群 / 私聊（plan「群与私聊一视同仁」，身份都只是「来源渠道」） */
export type ConversationKind = 'group' | 'private';

export interface QqConversation {
  kind: ConversationKind;
  /** 群号 / 对方 QQ 号（纯数字字符串；来自 group_id / user_id） */
  id: string;
  /** 会话键：`group:123456` / `private:789`——settings `qq_channel_map` 的键，也是限流桶键 */
  key: string;
}

/** 消息段（数组格式原样保留；字符串格式拆出来的形状一致） */
export interface MessageSegment {
  type: string;
  data: Record<string, unknown>;
}

export interface IncomingMessage {
  conversation: QqConversation;
  /** 机器人自己的 QQ 号（事件 self_id），用来识别「@机器人」 */
  selfId: string;
  /** 发消息的人（user_id） */
  userId: string;
  segments: MessageSegment[];
  /** 剥掉 @段、还原实体、去首尾空白后的纯文本：触发判定与喂给 LLM 的都是它 */
  text: string;
  /** 原始 raw_message（日志/审计用，不进 LLM） */
  raw: string;
  /** 是否 @了机器人（数组段 at.qq == self_id，或字符串格式的 [CQ:at,qq=…]） */
  mentionedSelf: boolean;
}

/** 会话键（唯一构造点：映射与限流的键必须与它会话一致） */
export function conversationKey(kind: ConversationKind, id: string): string {
  return `${kind}:${id}`;
}

/** 只留纯数字 id：非数字（缺字段 / 形状不对）一律返回 null，不让脏 id 往下走 */
function digits(v: unknown): string | null {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return String(v);
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return v.trim();
  return null;
}

/** 数组格式 text 段的实体还原（OneBot 11 规定这三种） */
function unescapeText(s: string): string {
  return s.replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&amp;/g, '&');
}

/** 字符串格式（CQ 码）→ 段数组；`[CQ:type,k=v,…]` 之外的文本都是 text 段 */
function segmentsFromCqString(raw: string): MessageSegment[] {
  const segs: MessageSegment[] = [];
  let rest = raw;
  const re = /\[CQ:([a-zA-Z_]+)((?:,[^\]]*)?)\]/;
  for (;;) {
    const m = re.exec(rest);
    if (!m) break;
    const head = rest.slice(0, m.index);
    if (head !== '') segs.push({ type: 'text', data: { text: head } });
    const data: Record<string, unknown> = {};
    for (const pair of m[2]!.replace(/^,/, '').split(',')) {
      if (pair === '') continue;
      const i = pair.indexOf('=');
      const k = i === -1 ? pair : pair.slice(0, i);
      data[k] = i === -1 ? '' : pair.slice(i + 1);
    }
    segs.push({ type: m[1]!, data });
    rest = rest.slice(m.index + m[0].length);
  }
  if (rest !== '') segs.push({ type: 'text', data: { text: rest } });
  return segs;
}

function segmentsOf(message: unknown): MessageSegment[] {
  if (typeof message === 'string') return segmentsFromCqString(message);
  if (!Array.isArray(message)) return [];
  const out: MessageSegment[] = [];
  for (const item of message) {
    if (typeof item !== 'object' || item === null) continue;
    const seg = item as { type?: unknown; data?: unknown };
    if (typeof seg.type !== 'string') continue;
    const data = typeof seg.data === 'object' && seg.data !== null
      ? (seg.data as Record<string, unknown>)
      : {};
    out.push({ type: seg.type, data });
  }
  return out;
}

/** 段里 @ 的对象是不是机器人（`qq: 'all'` = @全体成员，不算） */
function mentionsSelf(segs: MessageSegment[], selfId: string): boolean {
  if (selfId === '') return false;
  return segs.some((s) => s.type === 'at' && digits(s.data.qq) === selfId);
}

/**
 * 解析一条 OneBot 上报事件。返回 null = 不接（非消息 / 形状不对 / 自发消息）——
 * 调用方据此静默忽略，不回话（回话会在别人群里刷屏）。
 */
export function parseOnebotMessage(raw: unknown): IncomingMessage | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const ev = raw as Record<string, unknown>;
  if (ev.post_type !== 'message') return null;

  const kind: ConversationKind | null =
    ev.message_type === 'group' ? 'group'
      : ev.message_type === 'private' ? 'private'
        : null;
  if (kind === null) return null;

  const selfId = digits(ev.self_id) ?? '';
  const userId = digits(ev.user_id);
  if (userId === null) return null;
  // 自发消息（机器人自己说的话）：绝不触发，否则会自己跟自己对话
  if (selfId !== '' && userId === selfId) return null;

  const peerId = kind === 'group' ? digits(ev.group_id) : userId;
  if (peerId === null) return null;

  const segments = segmentsOf(ev.message);
  const text = segments
    .filter((s) => s.type === 'text')
    .map((s) => unescapeText(typeof s.data.text === 'string' ? s.data.text : ''))
    .join('')
    .trim();

  return {
    conversation: { kind, id: peerId, key: conversationKey(kind, peerId) },
    selfId,
    userId,
    segments,
    text,
    raw: typeof ev.raw_message === 'string' ? ev.raw_message : text,
    mentionedSelf: mentionsSelf(segments, selfId),
  };
}