/**
 * QQ 回执渲染（P3）：**回执裁剪** + 上下文阈值附言 + 一组固定文案。
 * 依据 docs/plan/agent-access.md「渠道隔离 → QQ 侧配套政策」「待定项 2」（阈值动手时按 QQ 实际限制微调）。
 *
 * 裁剪口径：**正文优先**（留头不留尾——loop 的终答就是结论，尾巴多是客套与补充），
 * 截断处给一句明确说明，不做中间省略（模型回复不是日志，读者要能看出「被截了」）。
 * 工具细节折叠成一行摘要那半句在 P3 用不上：loop 的终答里本来就没有工具 JSON
 * （工具结果只回填给模型，见 agent/loop.ts），所以只有「长度」这一个裁剪维度。
 *
 * 阈值：`QQ_REPLY_MAX_CHARS = 450` 是保守值。QQ/NapCat 侧单条消息的实际上限远大于此
 * （数千字符级），取小值是刻意的——群里的自助回执本来就该短，长内容让对方面板看。
 * **按 QQ 实际限制微调**：真机跑通后若发现正常回复常被截，调大这一个常量即可。
 */
import type { ConversationKind } from './onebot-event.js';

/** 单条回执上限（字符数，按 QQ 实际限制微调） */
export const QQ_REPLY_MAX_CHARS = 450;
/** 截断标记（截断处明确告知，避免读者以为机器人只说了半句就没头没尾） */
export const QQ_TRUNCATED_SUFFIX = '…（内容较长已截断，详情请在面板查看）';

/** 上下文过长时附在回复末尾的提示（plan 原文；私聊改称「本会话」） */
export function resetHint(kind: ConversationKind): string {
  return kind === 'group'
    ? '（本群对话上下文已较长，发送 /reset 可清空）'
    : '（本会话对话上下文已较长，发送 /reset 可清空）';
}

/** 正文规整：去首尾空白、压缩连续空行（QQ 里裸换行很占屏） */
function normalize(text: string): string {
  return text.trim().replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
}

export interface RenderReplyOptions {
  kind: ConversationKind;
  /** 会话存储的 `usage().needsResetHint`（阈值 40 条消息 / 8k 字符，core/chat-store.ts） */
  needsResetHint?: boolean;
}

/**
 * 回执渲染：规整 → 按预算截断（预算已扣除附言，**附言永远不被截掉**）→ 追加 /reset 提示。
 */
export function renderReply(text: string, opts: RenderReplyOptions): string {
  const hint = opts.needsResetHint === true ? `\n${resetHint(opts.kind)}` : '';
  const budget = QQ_REPLY_MAX_CHARS - hint.length;
  let body = normalize(text);
  if (body.length > budget) {
    const cut = Math.max(0, budget - QQ_TRUNCATED_SUFFIX.length);
    body = body.slice(0, cut).trimEnd() + QQ_TRUNCATED_SUFFIX;
  }
  return body + hint;
}

/** 「本群/本私聊」措辞 */
function where(kind: ConversationKind): string {
  return kind === 'group' ? '本群' : '本会话';
}

/**
 * `/help`（确定性、不接 LLM）：能力简介。写给群友看——一屏内说完、不列工具名。
 */
export function helpText(kind: ConversationKind): string {
  return [
    `DD-claw 自助推送（${where(kind)}）`,
    `· 加推送：跟我说「把 XXX 的开播推到${where(kind)}」`,
    `· 停推送：说「别推 XXX 了」，或给出规则 id`,
    `· 看现状：说「${where(kind)}现在推哪些主播」`,
    '· 撤销上一次改动：说「撤销刚才那个」',
    '· /reset 清空本会话上下文；/help 再看这段',
    kind === 'group' ? '唤起方式：@我，或说「dd 想做什么」' : '直接说话即可（也能用 /reset、/help）',
  ].join('\n');
}

/** 未映射渠道：拒绝服务（渠道隔离第 1 条，绝不回落默认渠道） */
export function refusedText(kind: ConversationKind): string {
  return `这个${kind === 'group' ? '群' : '会话'}还没开通自助推送管理，请让主人在 DD-claw 面板配置渠道映射后再找我。`;
}

export function rateLimitedText(): string {
  return '说得有点快，我歇几秒再看——稍后再发一次吧。';
}

/** 被唤起了但没说要做什么 */
export function emptyPromptText(kind: ConversationKind): string {
  return `想做什么？比如「把 XXX 的开播推到${where(kind)}」；发 /help 看我能做什么。`;
}

export function resetDoneText(kind: ConversationKind): string {
  return `${where(kind)}的对话上下文已清空（推送规则等配置不受影响）。`;
}

/** LLM 不可用（未启用 / 未配 provider / 调用失败）：如实说，不装作听懂了 */
export function llmUnavailableText(): string {
  return '我这边的模型暂时用不了，没法处理这句话——请让主人检查面板里的 LLM 配置。';
}

export function errorText(): string {
  return '处理这条消息时出错了，稍后再试一次吧。';
}