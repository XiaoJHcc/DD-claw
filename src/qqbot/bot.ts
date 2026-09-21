/**
 * QQ 自助入口的编排（P3 NapCat 直连，docs/plan/agent-access.md「P3：NapCat 直连」「渠道隔离」）。
 *
 * 一条上报进来的消息走这条链（每步都可能「到此为止」）：
 * ```
 * 开关 qqbot_enabled → OneBot 事件解析 → 触发判定 → 对话限流 → 会话→渠道映射 → 确定性命令/LLM loop → 回执
 * ```
 * 三个硬口径（plan「渠道隔离」表）：
 * 1. **映射查不到就拒绝服务**（第 1 条），绝不回落默认渠道；「拒绝」也只对**被唤起**的消息回
 *    ——没开通的群里不能对每条聊天都插一句「本群未开通」，那比不响应更糟。
 * 2. **会话键 = 来源渠道**（第 4 条）：scope 用 `channelScope(channelId)`，与撤销栈同一套字符串，
 *    所以 A 群的上下文与撤销栈对 B 群**完全不可见**（本文件自己不做任何过滤，隔离靠 scope 贯穿）。
 * 3. **身份只从事件来**（信任模型表）：`channelId` 由映射解析后经 `opts.channelId` 注入 loop 的
 *    调用域，**永不进工具参数**；LLM 生成的一切都不参与身份判定。
 *
 * 其余口径：
 * - **限流按来源渠道分桶**（`QQ_TURNS_PER_MINUTE` 轮/分钟）——一个吵的群不该拖累别的群；
 *   超限回一句缓和文案，且只对被唤起的消息回（同样避免刷屏）。
 * - **恒不抛给调用方**：事件路由返回 200 + 动作摘要（NapCat 侧对非 2xx 只会记错/重试，
 *   而「这条消息没被处理」是正常业务结果，不是传输错误）。
 * - **回执走注入的 send**：装配根接到 `OneBotNotifier.sendText`（与推送共用同一条串行链），
 *   测试注入假实现——本模块不碰 HTTP，也不认识 NapCat 端点。
 */
import type { ChatCompletion, LlmRequest } from '../analysis/providers.js';
import { makeLogger } from '../logger.js';
import type { Db } from '../core/db.js';
import { channelScope } from '../core/undo.js';
import { runAgentTurn } from '../agent/loop.js';
import { buildQqbotSystemPrompt } from '../agent/system-prompt.js';
import { HttpError } from '../panel/http-util.js';
import type { PanelDeps } from '../panel/server.js';
import { RateLimiter } from '../mcp/rate-limit.js';
import { parseOnebotMessage, type IncomingMessage, type QqConversation } from './onebot-event.js';
import { channelIdForConversation, getTriggerPrefix, isQqbotEnabled } from './settings.js';
import {
  emptyPromptText, errorText, helpText, llmUnavailableText, rateLimitedText, refusedText, renderReply, resetDoneText,
} from './reply.js';
import { decideTrigger } from './trigger.js';

const log = makeLogger('qqbot');

/** 对话限流：每来源渠道 10 轮 / 分钟（防群友 prompt injection 诱导刷 LLM/写接口；不是精确配额） */
export const QQ_TURNS_PER_MINUTE = 10;

/** 进程内单例限流器（跨事件生效）；测试通过 deps.limiter 注入自己的桶 */
export const qqConversationLimiter = new RateLimiter(QQ_TURNS_PER_MINUTE, 60_000);

export interface SendOutcome {
  ok: boolean;
  error?: string;
}

export interface QqbotDeps {
  db: Db;
  /**
   * 面板依赖面（`chat` / `llm.router` / `undo`）：**同一份对象**，不另造一套——
   * loop、工具执行、会话存储、撤销全与面板同源；装配根在构造后再把本入口挂回 `panel.qqbot`。
   */
  panel: PanelDeps;
  /** 回执发送（装配根 → OneBotNotifier.sendText；测试注入假实现） */
  send: (conversation: QqConversation, text: string) => Promise<SendOutcome>;
  /** LLM 接缝（测试注入假 LLM）；缺省走 panel.llm.router（与面板同一条熔断/路由/降级） */
  completeChat?: (req: LlmRequest) => Promise<ChatCompletion>;
  /** 限流器（测试注入）；缺省全局单例 */
  limiter?: RateLimiter;
}

/**
 * 事件处理结果（既是日志也是 `/onebot` 的响应体）：动作 + 原因。
 * `ignored` 是绝大多数消息的归宿（没被唤起），不算异常。
 */
export interface QqbotOutcome {
  action:
    | 'disabled'   // qqbot_enabled 关（装配后热关：不改路由，直接拒收）
    | 'ignored'    // 非消息 / 自发消息 / 未被唤起
    | 'refused'    // 映射查不到，拒绝服务
    | 'limited'    // 超限流
    | 'empty'      // 被唤起了但没说要做什么
    | 'reset'      // /reset
    | 'help'       // /help
    | 'replied'    // LLM 一轮跑完并回了执
    | 'error';     // 前置缺失 / LLM 不可用 / 未预期异常
  reason?: string;
}

export class QqbotBot {
  private readonly limiter: RateLimiter;

  constructor(private readonly deps: QqbotDeps) {
    this.limiter = deps.limiter ?? qqConversationLimiter;
  }

  /** 处理一条 OneBot 上报事件（`/onebot` 的唯一入口）。**不抛异常**。 */
  async handleEvent(raw: unknown): Promise<QqbotOutcome> {
    try {
      return await this.dispatch(raw);
    } catch (e) {
      log.error('处理 QQ 事件失败', e);
      return { action: 'error', reason: e instanceof Error ? e.message : String(e) };
    }
  }

  private async dispatch(raw: unknown): Promise<QqbotOutcome> {
    if (!isQqbotEnabled(this.deps.db)) return { action: 'disabled', reason: 'qqbot_enabled 未开' };

    const msg = parseOnebotMessage(raw);
    if (!msg) return { action: 'ignored', reason: '非消息事件 / 自发消息 / 形状不认识' };

    const trig = decideTrigger(msg, getTriggerPrefix(this.deps.db));
    if (trig.kind === 'ignore') {
      log.debug(`${msg.conversation.key} 忽略：${trig.reason}`);
      return { action: 'ignored', reason: trig.reason };
    }

    // 限流：**只对被唤起的消息**计数与回话（未被唤起的消息不产生任何回执，也就没有刷屏风险）
    if (!this.limiter.allow(msg.conversation.key)) {
      log.warn(`${msg.conversation.key} 触发过于频繁，已限流`);
      await this.say(msg, rateLimitedText());
      return { action: 'limited', reason: `${QQ_TURNS_PER_MINUTE} 轮/分钟已用尽` };
    }

    // 会话 → 渠道映射：查不到**拒绝服务**，绝不回落默认渠道（渠道隔离第 1 条）
    const channelId = channelIdForConversation(this.deps.db, msg.conversation.key);
    if (channelId === undefined) {
      log.warn(`${msg.conversation.key} 未配置渠道映射（settings qq_channel_map），拒绝服务`);
      await this.say(msg, refusedText(msg.conversation.kind));
      return { action: 'refused', reason: '未配置渠道映射' };
    }

    const store = this.deps.panel.chat;
    if (!store) {
      log.error('会话存储未装配，QQ 自助入口不可用');
      return { action: 'error', reason: '对话存储未装配' };
    }
    // 会话键 = 来源渠道（与撤销栈同一套 scope 字符串）
    const scope = channelScope(channelId);

    if (trig.kind === 'command') {
      if (trig.command === 'help') {
        await this.say(msg, helpText(msg.conversation.kind));
        return { action: 'help' };
      }
      const cleared = store.reset(scope);
      log.info(`${msg.conversation.key} 清空本会话上下文（${cleared} 条消息）`);
      await this.say(msg, resetDoneText(msg.conversation.kind));
      return { action: 'reset', reason: `清空 ${cleared} 条` };
    }

    if (trig.kind === 'empty') {
      await this.say(msg, emptyPromptText(msg.conversation.kind));
      return { action: 'empty' };
    }

    return await this.runTurn(msg, trig.prompt, channelId, scope);
  }

  /** 一轮 LLM 对话：gateway 工具面 + 本渠道调用域；回执附 /reset 提示（上下文阈值政策） */
  private async runTurn(
    msg: IncomingMessage,
    prompt: string,
    channelId: number,
    scope: string,
  ): Promise<QqbotOutcome> {
    const channel = this.deps.db.listPushChannels().find((c) => c.id === channelId);
    const label = channel ? channel.name : (msg.conversation.kind === 'group' ? '本群' : '本私聊');
    try {
      const turn = await runAgentTurn(this.deps.panel, prompt, {
        scope,
        role: 'gateway',
        // actor 进审计与变更记录的 actor 列：谁在哪个渠道改的，面板变更历史里一眼能看出来
        actor: `qqbot-${msg.conversation.key}`,
        channelId,
        systemPrompt: buildQqbotSystemPrompt({ kind: msg.conversation.kind, label }),
        fallbacks: {
          empty: '（我这边没生成出回复，请再说一次）',
          truncated: '（这件事一轮没处理完。可以拆成两句再说，或请主人在面板上直接操作。）',
        },
        completeChat: this.deps.completeChat,
      });
      const usage = this.deps.panel.chat!.usage(scope);
      const sent = await this.say(msg, turn.reply, { needsResetHint: usage.needsResetHint });
      log.info(`${msg.conversation.key} 对话完成（${turn.steps} 轮 LLM / ${turn.toolCalls} 次工具调用）`);
      return {
        action: 'replied',
        reason: sent.ok ? undefined : `回执发送失败：${sent.error ?? '未知错误'}`,
      };
    } catch (e) {
      // LLM 未启用 / 无 provider（400）与调用彻底失败（502）对用户是同一件事：这边暂时用不了
      if (e instanceof HttpError) {
        log.warn(`${msg.conversation.key} LLM 不可用（${e.status}）：${e.message}`);
        await this.say(msg, llmUnavailableText());
        return { action: 'error', reason: `LLM 不可用 ${e.status}: ${e.message}` };
      }
      log.error(`${msg.conversation.key} 对话失败`, e);
      await this.say(msg, errorText());
      return { action: 'error', reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 回执：裁剪（正文优先 + /reset 附言）+ 发送；发送失败只记日志（不影响事件处理结果） */
  private async say(
    msg: IncomingMessage,
    text: string,
    opts: { needsResetHint?: boolean } = {},
  ): Promise<SendOutcome> {
    const body = renderReply(text, {
      kind: msg.conversation.kind,
      ...(opts.needsResetHint === true ? { needsResetHint: true } : {}),
    });
    try {
      const r = await this.deps.send(msg.conversation, body);
      if (!r.ok) log.warn(`${msg.conversation.key} 回执发送失败：${r.error ?? '未知错误'}`);
      return r;
    } catch (e) {
      log.warn(`${msg.conversation.key} 回执发送异常：${e instanceof Error ? e.message : String(e)}`);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

export function createQqbot(deps: QqbotDeps): QqbotBot {
  return new QqbotBot(deps);
}