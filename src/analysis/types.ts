import type { LiveEvent, Signal } from '../core/types.js';

export type Scene = 'chatting' | 'singing' | 'gaming' | 'show' | 'other';

export interface SceneVerdict {
  scene: Scene;
  /** 0-1 */
  confidence: number;
  /** 2-4 条判断依据，用于事后追溯误判原因 */
  evidence: string[];
  secondaryScene?: Scene | null;
}

/**
 * 聚合后的多源信号。M1 只有 event + signal 两个字段，
 * M2 加弹幕/动态时在这里扩充（danmaku?: string[]、feedPosts?: ... 等），
 * Analyzer 的签名不变。
 */
export interface AnalysisContext {
  event: LiveEvent;
  signal: Signal;
}

export interface Analyzer {
  readonly name: string;
  /**
   * 返回 null 表示「不做判定」。规则层必须能在 verdict 为 null 时正常工作，
   * 这样 M2 接上真 Analyzer 后规则层不用改。
   */
  analyze(ctx: AnalysisContext): Promise<SceneVerdict | null>;
}

/**
 * LLM 任务统一形态（M2 占位）：zod schema 进，JSON 出，provider 可替换。
 * buildPrompt 返回文本或多模态消息；parse 里做 zod 校验。
 */
export interface LlmTask<I, O> {
  readonly name: string;
  buildPrompt(input: I): unknown;
  parse(raw: unknown): O;
}
