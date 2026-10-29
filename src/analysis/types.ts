import type { LiveEvent, Signal } from '../core/types.js';
import type { PreparedImages } from './image-prep.js';
import type { PostCandidate } from './matcher.js';

/** 精确模式的逐条件结论类型（审计形状的唯一信源在 core/content-audit，这里只转出口供分析层引用） */
export type { ConditionAudit as ConditionResult } from '../core/content-audit.js';

/** 一份内容被判属于/不属于某分类的结果（入 verdicts 表；每档每来源一行） */
export interface Classification {
  categoryId: number;
  /** 冗余存名（= categories.name），分类删除后历史仍可读 */
  name: string;
  /** llm = LLM 判定（权威路径）；rule = 确定性条件（无提示词分类 / 模型档不可用时的回退）；
   *  decision = 决策模型通道（判决链第一档，带 P(属于)） */
  source: 'llm' | 'rule' | 'decision';
  /** 仅决策模型的 P(属于)，其余来源 null（LLM 自报数字没有校准意义，不采信）。
   *  精确模式的是非由逐条件裁决得出，不合成伪最终概率，故同样为 null。 */
  confidence: number | null;
  /** LLM 证据 / 命中的关键词·分区说明 */
  evidence: string;
  /** 判定结论：true = 属于。判否也要入档（「为什么没推」可回看；直播与图文一致） */
  pass: boolean;
  /** 是否为本分类的生效结论（判决链编排器最终填写；消费方只读生效行） */
  effective: boolean;
}

/** 图文帖的分析输入：帖子投影（视觉输入走 ctx.images，不在这里） */
export interface PostAnalysisInput {
  post: PostCandidate;
}

/**
 * 本轮判定选哪些判定档参与（直播分类时机用：开播 / 延迟 / 定时 / 变更各有自己的选择）。
 * 关闭的档既不参与判定，也不作为其他档失败时的回退：只有所选档能定案。
 */
export interface JudgeSelection {
  /** 确定性条件（source='rule'） */
  rule: boolean;
  /** 决策模型档 */
  decision: boolean;
  /** LLM 档 */
  llm: boolean;
}

/** 缺省三档全开：图文帖与既有调用保持不变 */
export const DEFAULT_JUDGE_SELECTION: JudgeSelection = { rule: true, decision: true, llm: true };

/**
 * 整轮判定被跳过（既不是失败，也不是「结果为空」）：例如只启用了 LLM 档、本轮确有 LLM 候选、
 * 但该房间还在冷却。判定层什么都不写（当前 `verdicts` / `primary_verdicts` 原样保留），
 * pipeline 据此不记历史、不做分类集合变更判断、不重推，审计里记成「未执行」。
 */
export class LiveClassificationSkippedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'LiveClassificationSkippedError';
  }
}

/**
 * 聚合后的多源信号。live_start 带 event（直播场次），feed_post 带 post（图文帖），
 * 后续加弹幕时在这里扩充（danmaku?: string[] 等），Classifier 的签名不变。
 */
export interface AnalysisContext {
  /** 直播场次（直播分类判定入口：开播 / 延迟 / 定时 / 变更）；图文判定不带 */
  event?: LiveEvent;
  signal: Signal;
  /** 图文帖（feed_post 判定入口）；直播判定不带 */
  post?: PostAnalysisInput;
  /** 视觉输入（两种内容共用）：判定前已规范化的基线 JPEG data URL + 被拦下的图与原因 */
  images?: PreparedImages;
  /** 判定档选择；缺省 = 三档全开（图文与旧调用行为不变） */
  judge?: JudgeSelection;
}

export interface Classifier {
  readonly name: string;
  /** 直播分类时机（开播 / 延迟 / 定时 / 变更，ctx.event + ctx.judge）→ 按直播分类判定；
   *  feed_post → 按图文分类判定；其余返回 []。
   *  判定结果由实现自行入 verdicts / primary_verdicts 表；返回值只含生效且属于的分类。 */
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
