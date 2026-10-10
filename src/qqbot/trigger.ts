/**
 * 触发纪律（P3）：**确定性命令** 与 **LLM 对话** 两条路共存（plan「触发纪律」——斜杠命令不是
 * 降级替代），未被触发的消息一律静默忽略（群里刷屏比不响应更糟）。
 *
 * 判定顺序：
 * 1. 空文本（纯图片/表情等）：@了机器人 → empty（回一句「想做什么」）；否则忽略。
 * 2. `/` 开头 → 确定性命令，**不进 LLM**：`/reset`（清本会话上下文）、`/help`（能力简介）；
 *    其余 `/xxx` 忽略（不猜、不喂模型——斜杠是确定性通道，未知命令就是未知）。
 * 3. 群聊：@机器人 或前缀命中（`qqbot_trigger_prefix`，缺省 `dd`）→ 进 LLM。
 * 4. 私聊：**无需 @ 也无需前缀**（一对一对话本身就是对着机器人说的，没有群噪音；
 *    渠道是否开通由 `qq_channel_map` 把关）→ 进 LLM。带前缀/@ 时一样剥掉。
 * 5. 其余 → 忽略。
 *
 * 进 LLM 的正文是**剥掉 @段与前缀之后**的文本（模型不需要看到唤起手法）。
 */
import type { IncomingMessage } from './onebot-event.js';
import { matchTriggerPrefix } from './settings.js';

/** 确定性命令（斜杠开头、大小写不敏感） */
export const QQ_COMMANDS = ['/reset', '/help'] as const;
export type QqCommand = (typeof QQ_COMMANDS)[number];

export type QqTrigger =
  /** 静默忽略（reason 只进日志） */
  | { kind: 'ignore'; reason: string }
  /** 确定性命令：不接 LLM */
  | { kind: 'command'; command: 'reset' | 'help' }
  /** 被唤起了但没说要做什么（@机器人 后面没内容） */
  | { kind: 'empty' }
  /** 进 agent loop；prompt 是剥掉唤起手法后的正文 */
  | { kind: 'agent'; prompt: string };

export function decideTrigger(msg: IncomingMessage, prefix: string): QqTrigger {
  const text = msg.text;

  if (text === '') {
    return msg.mentionedSelf ? { kind: 'empty' } : { kind: 'ignore', reason: '空消息（或无正文的段）' };
  }

  if (text.startsWith('/')) {
    const cmd = text.split(/\s+/)[0]!.toLowerCase();
    if (cmd === '/reset' || cmd === '/help') return { kind: 'command', command: cmd === '/reset' ? 'reset' : 'help' };
    return { kind: 'ignore', reason: `未知斜杠命令 ${cmd}` };
  }

  if (msg.conversation.kind === 'private') {
    // 私聊直通：前缀/@ 仍然剥掉，剩下的正文就是 prompt
    const stripped = matchTriggerPrefix(text, prefix);
    return { kind: 'agent', prompt: stripped === null ? text : stripped };
  }

  if (msg.mentionedSelf) return { kind: 'agent', prompt: text };
  const stripped = matchTriggerPrefix(text, prefix);
  if (stripped !== null) {
    return stripped === '' ? { kind: 'empty' } : { kind: 'agent', prompt: stripped };
  }
  return { kind: 'ignore', reason: '未 @机器人 且前缀不匹配' };
}