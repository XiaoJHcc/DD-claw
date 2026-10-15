/**
 * 图文帖翻译编排（判定已挪进分类判决链，见 classifier.ts；这里只剩规则层的附加动作）：
 * 命中规则里任一开了 llmTranslate 且平台支持时，对帖子正文调一次 LLM 生成译文。
 *
 * 降级策略（与 RulesClassifier 同一条思路，也是项目纪律）：
 * - LLM 总开关关 / router 不可用 / 调用失败 / 解析失败 → `source='fallback'`，不附译文。
 *   **翻译失败绝不挡推送**（正文照发）——生成类任务的任何抖动都不该让推文凭空消失。
 *
 * 熔断状态在 providers 层：服务异常 = completeJson 抛错 → 当场回退，无需额外状态。
 */
import { makeLogger } from '../logger.js';
import type { LlmRouter } from './providers.js';
import type { PostCandidate } from './matcher.js';
import { buildTranslateRequest, parseTranslation } from './tasks/post-analysis.js';

const log = makeLogger('analysis/post-analyzer');

export interface PostTranslation {
  /** 'llm' = 模型给了译文（或明确无需翻译）；'fallback' = LLM 不可用/失败，不附译文 */
  source: 'llm' | 'fallback';
  translation: string | null;
  error?: string;
}

export class PostAnalyzer {
  constructor(
    /** getter 而非固定值：面板改 provider 名单后 router 热重建，每轮取最新 */
    private readonly getRouter: () => LlmRouter | null,
    private readonly llmEnabled: () => boolean,
  ) {}

  /** 生成译文（调用方保证平台支持翻译，见 platformSupportsTranslate） */
  async translate(post: PostCandidate): Promise<PostTranslation> {
    const router = this.getRouter();
    if (router === null || !this.llmEnabled()) {
      log.debug(`LLM 不可用（${router === null ? '无 provider' : '总开关关'}），不附译文`);
      return { source: 'fallback', translation: null, error: router === null ? '未配置 LLM provider' : 'LLM 总开关关闭' };
    }
    try {
      const translation = await router.completeJson(
        buildTranslateRequest(post),
        (raw) => parseTranslation(raw),
      );
      return { source: 'llm', translation };
    } catch (e) {
      log.warn(`图文帖翻译失败，不附译文: ${(e as Error).message}`);
      return { source: 'fallback', translation: null, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
