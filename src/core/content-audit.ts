import type { Category, JudgeDirection, PrimaryJudgement, PushRule, SubjectKind } from './push.js';

export interface ModelAttempt {
  provider: string;
  model: string;
  status: 'success' | 'failed' | 'skipped';
  /** 哪个判定通道发起的尝试（LLM 与决策模型各有一条独立链路，排障时分开看） */
  channel?: 'llm' | 'decision';
  error?: string;
}

/**
 * 精确模式的一条条件结论：条件 id + 方向 + 该条件成立的概率。
 * 逐条落库是为了回答「哪条原子条件把结论推到了哪边」——聚合概率刻意不合成（见 analysis/tasks/decide.ts）。
 */
export interface ConditionAudit {
  categoryId: number;
  /** 分类内稳定的条件 id（与 categories.judge_conditions[].id 同源） */
  conditionId: string;
  direction: JudgeDirection;
  /** 条件原文，供试判与审计直接展示，不需从当前分类草稿反查 */
  text: string;
  /** P(该条件成立)，0–1 */
  p: number;
  /** 按本次决策灰区上下界分带 */
  band: 'high' | 'low' | 'gray';
  /** 是否实际促成决策档的定案；灰区与未看图一律 false */
  decisive: boolean;
}

export interface AnalysisAudit {
  /** skipped = 整轮未执行（如只有 LLM 档且房间在冷却）：当前判定与历史都不变，不是失败 */
  status: 'pending' | 'done' | 'failed' | 'skipped';
  categories: Category[];
  /** 逐档逐来源的结论，同一分类可有多行；effective = 该分类的生效结论 */
  results: Array<{
    categoryId: number;
    name: string;
    source: 'llm' | 'rule' | 'decision';
    pass: boolean;
    confidence: number | null;
    evidence: string;
    effective: boolean;
  }>;
  /** 精确模式的逐条件概率（决策档产出；simple 分类没有） */
  conditionResults?: ConditionAudit[];
  /** 主分类各来源结论（生效与否见各项 effective） */
  primary?: PrimaryJudgement[];
  /** LLM 档回退原因（只承载 LLM 通道；决策档的跳过 / 失败见 stageNotes） */
  fallbackReason?: string;
  /** 逐档被跳过 / 失败的原因（决策档不可用的具体缘由：开关关、无供应商、全部失败…） */
  stageNotes?: Array<{ stage: 'decision' | 'llm'; reason: string }>;
  /** 该场内容本轮实际启用了哪些判定档（关闭的档不进判定，也不会作为回退） */
  judgeSelection?: { rule: boolean; decision: boolean; llm: boolean };
  error?: string;
  durationMs?: number;
  /** 送模型的图片张数（= 规范化后仍在的 data URL 数） */
  imageCount?: number;
  /** 被拦下的图片逐张带原因（解码失败 / 超体积 / 下载失败 / 超过张数上限…） */
  skippedImages?: Array<{ ref: string; reason: string }>;
  attempts?: ModelAttempt[];
  input?: { text: string; authorName: string; tags: Record<string, string>; url: string; ts: number };
}

export interface PushAudit {
  status: 'pending' | 'skipped' | 'sent' | 'partial' | 'failed' | 'dry-run';
  reason: string;
  rules: Array<{ id: number; name: string; matched: boolean; reason: string; configuration?: PushRule }>;
  channels: Array<{ id: number; name: string; enabled: boolean }>;
  deliveries?: Array<{ channel: string; target?: string; ok: boolean; error?: string }>;
  title?: string;
  imageWarning?: string;
  translationWarning?: string;
}

export interface ContentAudit {
  subjectType: SubjectKind;
  subjectId: string;
  analysis: AnalysisAudit | null;
  push: PushAudit | null;
  updatedAt: number;
}
