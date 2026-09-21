/**
 * 图文帖分析编排：命中规则要 LLM 时，对一条帖子做「判定 + 翻译」，一次调用出结果。
 *
 * 翻译运行时门控：规则的 llmTranslate 只对 X 帖生效（微博/B站动态本就中文）——
 * 非 X 帖不请求翻译、不附译文；判定（llmJudge）不受平台影响，三平台通用。
 *
 * 降级策略（与 RulesClassifier 同一条思路，也是项目纪律）：
 * - 规则没开判定也没开翻译（或翻译被平台门控掉）→ 根本不调 LLM（`source='off'`）
 * - LLM 总开关关 / router 不可用 / 调用失败 / 解析失败 → `source='fallback'`，
 *   **判定视为通过（照机械筛选推）**、不附译文。宁可按用户填的机械条件发出去，
 *   也不要因为模型抖动让推文凭空消失。
 * - `source='llm'` 时判定权威：pass=false 则该规则不贡献渠道（这条帖子不推）。
 *
 * 熔断状态在 providers 层：服务异常 = completeJson 抛错 → 当场回退，无需额外状态。
 */
import { makeLogger } from '../logger.js';
import type { LlmRouter } from './providers.js';
import type { PostCandidate } from './matcher.js';
import { platformSupportsTranslate, type PostRule } from '../core/post-rules.js';
import { buildPostAnalysisRequest, parsePostAnalysis, type PostAnalysisOptions } from './tasks/post-analysis.js';

const log = makeLogger('analysis/post-analyzer');

export interface PostAnalysis {
  /** 'llm' = 模型给了结论；'fallback' = LLM 不可用/失败，按机械筛选放行；'off' = 该规则没请求 LLM */
  source: 'llm' | 'fallback' | 'off';
  /** 判定结论（仅 source='llm' 且规则开了判定时有值） */
  pass: boolean;
  reason: string;
  translation: string | null;
}

/** 规则是否请求了 LLM（判定或翻译任一开启） */
export function ruleNeedsLlm(rule: PostRule): boolean {
  return rule.llmJudge || rule.llmTranslate;
}

export class PostAnalyzer {
  constructor(
    /** getter 而非固定值：面板改 provider 名单后 router 热重建，每轮取最新 */
    private readonly getRouter: () => LlmRouter | null,
    private readonly llmEnabled: () => boolean,
  ) {}

  async analyze(post: PostCandidate, rule: PostRule): Promise<PostAnalysis> {
    const opts: PostAnalysisOptions = {
      judge: rule.llmJudge,
      judgePrompt: rule.judgePrompt,
      // 翻译运行时门控：只有 X 帖才需要译文（微博/B站动态本就中文），非 X 帖不请求翻译
      translate: rule.llmTranslate && platformSupportsTranslate(post.platform),
    };
    if (!opts.judge && !opts.translate) {
      return { source: 'off', pass: true, reason: '', translation: null };
    }
    const router = this.getRouter();
    if (router === null || !this.llmEnabled()) {
      log.debug(`LLM 不可用（${router === null ? '无 provider' : '总开关关'}），按机械筛选放行`);
      return { source: 'fallback', pass: true, reason: 'LLM 未启用', translation: null };
    }
    try {
      const r = await router.completeJson(
        buildPostAnalysisRequest(post, opts),
        (raw) => parsePostAnalysis(raw),
      );
      return {
        source: 'llm',
        pass: opts.judge ? r.pass : true, // 没开判定就不让模型替我们决定
        reason: opts.judge ? r.reason : '',
        translation: opts.translate ? r.translation : null,
      };
    } catch (e) {
      log.warn(`图文帖 LLM 分析失败，按机械筛选放行: ${(e as Error).message}`);
      return { source: 'fallback', pass: true, reason: 'LLM 调用失败', translation: null };
    }
  }
}