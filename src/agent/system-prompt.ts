/**
 * WebUI Agent 的系统提示 + 写操作模式（`settings.chat_write_mode` 是唯一信源）。
 *
 * 写前询问**不在 loop 里硬拦**（计划明确没要这个机制）：纪律写在系统提示里——
 * ask 模式下模型必须先在回复里复述「要改什么、改成什么」，用户在下一轮确认后才调写工具；
 * auto 模式下可直接调用，调用后简述做了什么。兜底是「写都可撤销」（每次写都落变更记录）。
 *
 * 模式开关对 LLM **不可见**（`set_chat_mode` 进 AGENT_EXCLUDED_TOOLS）：模型若能自己切到 auto，
 * 「未确认不写」的门槛就形同虚设，P1 验收的「误写率 0 容忍」会名存实亡。
 */
import type { Db } from '../core/db.js';

export type ChatWriteMode = 'ask' | 'auto';

export const CHAT_WRITE_MODE_SETTING = 'chat_write_mode';
/** 缺省 'ask'：没配过、或值不合法（脏库）一律按「写前询问」——安全默认 */
export const DEFAULT_CHAT_WRITE_MODE: ChatWriteMode = 'ask';
export const CHAT_WRITE_MODES: readonly ChatWriteMode[] = ['ask', 'auto'];

export function isChatWriteMode(v: unknown): v is ChatWriteMode {
  return v === 'ask' || v === 'auto';
}

/** 面板（`PUT /api/chat/mode`）与 loop 共用同一份读取口径 */
export function getChatWriteMode(db: Db): ChatWriteMode {
  const v = db.getSetting(CHAT_WRITE_MODE_SETTING);
  return isChatWriteMode(v) ? v : DEFAULT_CHAT_WRITE_MODE;
}

/** 写模式；返回落库后的值（注册表工具 handler 直接回给调用方） */
export function setChatWriteMode(db: Db, mode: ChatWriteMode): ChatWriteMode {
  db.setSetting(CHAT_WRITE_MODE_SETTING, mode);
  return mode;
}

/** 面板/历史文案用（'ask' → 写前询问） */
export function chatWriteModeLabel(mode: ChatWriteMode): string {
  return mode === 'ask' ? '写前询问' : '自动修改';
}

/**
 * 系统提示：每轮按当前模式重拼、不落库（库里只存 user / assistant / tool 往来）。
 * 内容要点与 P1 验收口径一一对应：能力只来自工具、uid/id 先查再引用、写前询问、
 * 撤销走 undo_last_change、简洁、不臆造能力边界。
 */
export function buildSystemPrompt(mode: ChatWriteMode): string {
  const lines = [
    '你是 DD-claw 控制面板里的助手。对话方是本机主人（admin 身份），可以读全部数据、改全部设置。',
    '',
    '## 你的能力只来自工具',
    '- 你能做的事就是本轮工具列表里给出的那些，没有别的通道：没有的工具就是没有——不要承诺，也不要用别的方式绕过（不能发弹幕、不能点赞、不能上网、不能改别的程序）。',
    '- 查数据用 list_* / search_* / get_*；改设置用 watch_streamer / set_streamer / set_* / upsert_* / delete_* / update_runtime_config。',
    '',
    '## 硬纪律',
    '1. uid / id 一律「先查再引用」：主播先 search_streamers（或 list_streamers），分类 / 规则 / 渠道 / 账号 / 图文规则先 list_*。**绝不编造 uid、规则 id、渠道 id、账号 id**；查不到就说不存在、请主人确认，不许猜一个塞进去。',
    '2. 工具报错就照实转述，并给下一步（缺参数就再查一次，不确定就问主人）。不要声称改成功了。',
    '3. 回答简洁：结论先行，一两句话说清；不要复述工具返回的整段 JSON，需要细节时给摘要。',
    '4. 只处理主人问的事；不确定的信息宁可说不知道。',
    '',
    '## 写操作',
  ];
  if (mode === 'ask') {
    lines.push(
      `当前模式：**写前询问**。任何写工具（watch_streamer / set_streamer / set_* / upsert_* / delete_* / update_runtime_config 等）在调用前，先在回复里说清「准备改什么、改成什么」，然后**等主人下一轮确认**——没有明确确认就不要调用。`,
      '主人确认后（例如「好」「改吧」「可以」）才真正调用；一轮里要改多项时，只做确认过的范围。',
    );
  } else {
    lines.push(
      '当前模式：**自动修改**。可以直接调用写工具、不必先等确认；调用后在回复里简述做了什么（改了哪个对象、改成了什么值）。',
      '把握不大时（同名多账号、目标 id 不确定、要删东西）仍先问一句再动手。',
    );
  }
  lines.push(
    '- 每次写都会记进面板的变更历史、可以撤销：主人说「撤销刚才那个」时调用 undo_last_change（撤的是最近一次写；若该设置已被其他入口改过，撤销会中止，照实告诉主人）。',
    '- 不确定主人意图时先问，不要靠猜写库。',
  );
  return lines.join('\n');
}