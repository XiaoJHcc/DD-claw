import type { LiveEvent, Signal } from '../core/types.js';

/** 一场直播被判属于某分类的结果（入 verdicts 表） */
export interface Classification {
  categoryId: number;
  /** 冗余存名（= categories.name），分类删除后历史仍可读 */
  name: string;
  /** llm = LLM 判定（权威路径）；rule = 确定性条件（无提示词分类 / LLM 不可用时的回退）；
   *  decision = 决策模型通道（占位预留，暂无生产者） */
  source: 'llm' | 'rule' | 'decision';
  /** LLM 路径置信度（0-1），rule 路径为 null */
  confidence: number | null;
  /** LLM 证据 / 命中的关键词·分区说明 */
  evidence: string;
}

/**
 * 聚合后的多源信号。当前只有 event + signal 两个字段，
 * 后续加弹幕/动态时在这里扩充（danmaku?: string[]、feedPosts?: ... 等），
 * Classifier 的签名不变。
 */
export interface AnalysisContext {
  event: LiveEvent;
  signal: Signal;
}

export interface Classifier {
  readonly name: string;
  /** 非 live_start 信号返回 []。判定结果由实现自行入 verdicts 表。 */
  classify(ctx: AnalysisContext): Promise<Classification[]>;
}

/**
 * LLM 任务统一形态：zod schema 进，JSON 出，provider 可替换。
 * buildPrompt 返回文本或多模态消息；parse 里做 zod 校验。
 */
export interface LlmTask<I, O> {
  readonly name: string;
  buildPrompt(input: I): unknown;
  parse(raw: unknown): O;
}
