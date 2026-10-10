import type { LiveEvent, Signal } from '../core/types.js';
import type { PostCandidate } from './matcher.js';

/** 一份内容被判属于/不属于某分类的结果（入 verdicts 表） */
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
  /** 判定结论（缺省 true = 属于）。false 只由 LLM 档产出（判否入档：post 侧落 pass=0 供
   *  「为什么没推」回看）；classify() 对外只返回属于（pass=true）的条目 */
  pass?: boolean;
}

/** 图文帖的分析输入：帖子投影 + 已本地化的配图（data URL，vision 输入面） */
export interface PostAnalysisInput {
  post: PostCandidate;
  imageDataUrls?: string[];
}

/**
 * 聚合后的多源信号。live_start 带 event（直播场次），feed_post 带 post（图文帖），
 * 后续加弹幕时在这里扩充（danmaku?: string[] 等），Classifier 的签名不变。
 */
export interface AnalysisContext {
  /** 直播场次（live_start 判定入口）；图文判定不带 */
  event?: LiveEvent;
  signal: Signal;
  /** 图文帖（feed_post 判定入口）；直播判定不带 */
  post?: PostAnalysisInput;
}

export interface Classifier {
  readonly name: string;
  /** live_start → 按直播分类判定；feed_post → 按图文分类判定；其余返回 []。
   *  判定结果由实现自行入 verdicts 表。 */
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
