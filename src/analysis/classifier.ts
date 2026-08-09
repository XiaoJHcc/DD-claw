import { makeLogger } from '../logger.js';
import type { Db } from '../core/db.js';
import type { LiveEvent } from '../core/types.js';
import type { Category } from '../core/push.js';
import type { LlmRouter } from './providers.js';
import { matchCategory } from './matcher.js';
import { buildClassifyRequest, parseClassifyResults, toClassifyCategory } from './tasks/classify.js';
import type { AnalysisContext, Classification, Classifier } from './types.js';

const log = makeLogger('analysis/classifier');

/**
 * 分类编排：每场 live_start 对全部启用分类逐个判定，结果入 verdicts 表。
 *
 * 判定语义（LLM 优先，用户拍板）：
 * - 无 llmPrompt 的分类：永远走确定性条件（matchCategory），与 LLM 开关无关
 * - 有 llmPrompt 的分类：router 可用 && LLM 总开关开 && 该主播 analyze=1 时
 *   合并成一次 LLM 调用，LLM 判定权威（说「否」不回看确定性条件）；
 *   LLM 不可用 / 调用失败 / 解析失败时回退确定性条件
 * - LLM 只用于 analyze=1 的主播（analyze 开关的真实语义）；确定性路径不受开关影响
 *
 * 熔断状态在 providers 层：服务异常 = completeJson 抛错 → 当场回退，无需额外状态。
 */
export class RulesClassifier implements Classifier {
  readonly name = 'rules-classifier';

  constructor(
    private readonly db: Db,
    /** getter 而非固定值：面板改 provider 名单后 router 热重建，每轮取最新 */
    private readonly getRouter: () => LlmRouter | null,
    private readonly llmEnabled: () => boolean,
  ) {}

  async classify(ctx: AnalysisContext): Promise<Classification[]> {
    if (ctx.signal.kind !== 'live_start') return [];
    const { event } = ctx;
    const cats = this.db.listEnabledCategories();
    const out: Classification[] = [];

    const deterministicOnly = cats.filter((c) => !c.llmPrompt);
    this.matchDeterministic(deterministicOnly, event, out);

    const promptCats = cats.filter((c) => c.llmPrompt);
    const router = this.getRouter();
    const useLlm = promptCats.length > 0 && router !== null && this.llmEnabled()
      && this.db.getStreamer(event.uid)?.analyze === true;
    if (promptCats.length > 0) {
      if (useLlm) {
        try {
          const inputs = promptCats.map(toClassifyCategory);
          const results = await router.completeJson(
            buildClassifyRequest(event, inputs),
            (raw) => parseClassifyResults(raw, inputs),
          );
          // LLM 权威：未判定为是的 promptCats 不命中，不回看确定性条件
          out.push(...results);
        } catch (e) {
          log.warn(`LLM 分类失败，回退确定性条件: ${(e as Error).message}`);
          this.matchDeterministic(promptCats, event, out);
        }
      } else {
        this.matchDeterministic(promptCats, event, out);
      }
    }

    for (const c of out) {
      // INSERT OR IGNORE：同一场同一分类重复判定静默跳过
      this.db.insertVerdict({
        roomId: event.roomId, liveTime: event.liveTime, uid: event.uid,
        categoryId: c.categoryId, categoryName: c.name,
        source: c.source, confidence: c.confidence, evidence: c.evidence,
      });
    }
    return out;
  }

  private matchDeterministic(cats: Category[], event: LiveEvent, out: Classification[]): void {
    for (const c of cats) {
      const m = matchCategory(c, event);
      if (m.matched) {
        out.push({
          categoryId: c.id, name: c.name, source: 'rule',
          confidence: null, evidence: m.evidence,
        });
      }
    }
  }
}
