import type { Category, PushRule, SubjectKind } from './push.js';

export interface ModelAttempt {
  provider: string;
  model: string;
  status: 'success' | 'failed' | 'skipped';
  error?: string;
}

export interface AnalysisAudit {
  status: 'pending' | 'done' | 'failed';
  categories: Category[];
  results: Array<{
    categoryId: number;
    name: string;
    source: 'llm' | 'rule' | 'decision';
    pass: boolean;
    confidence: number | null;
    evidence: string;
  }>;
  fallbackReason?: string;
  error?: string;
  durationMs?: number;
  imageCount?: number;
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
