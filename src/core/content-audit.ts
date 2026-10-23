import type { Category, PrimaryJudgement, PushRule, SubjectKind } from './push.js';

export interface ModelAttempt {
  provider: string;
  model: string;
  status: 'success' | 'failed' | 'skipped';
  /** 哪个判定通道发起的尝试（LLM 与决策模型各有一条独立链路，排障时分开看） */
  channel?: 'llm' | 'decision';
  error?: string;
}

export interface AnalysisAudit {
  status: 'pending' | 'done' | 'failed';
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
  /** 主分类各来源结论（生效与否见各项 effective） */
  primary?: PrimaryJudgement[];
  /** LLM 档回退原因（只承载 LLM 通道；决策档的跳过 / 失败见 stageNotes） */
  fallbackReason?: string;
  /** 逐档被跳过 / 失败的原因（决策档不可用的具体缘由：开关关、无供应商、全部失败…） */
  stageNotes?: Array<{ stage: 'decision' | 'llm'; reason: string }>;
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
