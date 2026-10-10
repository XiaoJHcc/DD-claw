import { makeLogger } from '../logger.js';
import type { Db } from '../core/db.js';
import type { Category } from '../core/push.js';
import type { LlmRouter } from './providers.js';
import { matchCategoryItem } from './matcher.js';
import { fromLiveEvent, fromPostCandidate, type ContentItem } from './content.js';
import { buildClassifyRequest, parseClassifyResults, toClassifyCategory } from './tasks/classify.js';
import type { AnalysisContext, Classification, Classifier } from './types.js';

const log = makeLogger('analysis/classifier');

// ---- 判决链：可插拔的分类判定档位（决策模型档位预留接口，本期不进链）----

/** 判决链运行时上下文：各档共用的能力面（decision 档将来在此扩阈值/配置） */
export interface JudgeContext {
  /** LLM 路由 getter（面板改 provider 名单后热重建，每轮取最新）；null = 无 provider */
  getRouter: () => LlmRouter | null;
  /** LLM 总开关 */
  llmEnabled: () => boolean;
}

/**
 * 判决档位：对一组分类给出判定。
 * 返回 Map（键 = categories.id）= 本档定案（空 Map 也算定案：判否不落到下一档）；
 * 返回 null = 本档不可用/不适用，交下一档。
 */
export interface JudgeStage {
  name: 'deterministic' | 'decision' | 'llm';
  judge(item: ContentItem, cats: Category[], ctx: JudgeContext): Promise<Map<number, Classification> | null>;
}

/** 确定性档：关键词/分区/帖子类型等条件组（条件算子注册表）。永远可用，判否即空 Map（只记「属于」）。 */
export const deterministicJudge: JudgeStage = {
  name: 'deterministic',
  async judge(item, cats) {
    const out = new Map<number, Classification>();
    for (const c of cats) {
      const m = matchCategoryItem(c, item);
      if (m.matched) {
        out.set(c.id, {
          categoryId: c.id, name: c.name, source: 'rule',
          confidence: null, evidence: m.evidence, pass: true,
        });
      }
    }
    return out;
  },
};

/**
 * LLM 档：批量分类（权威——定案后不回看确定性）。
 * **逐项全部定案**（含判否 pass=false，判否入档供「为什么没推」回看）；
 * 无 provider / 总开关关 / 调用失败 / 解析失败 = 本档不可用，返回 null 交下一档。
 */
export const llmJudge: JudgeStage = {
  name: 'llm',
  async judge(item, cats, ctx) {
    const router = ctx.getRouter();
    if (router === null || !ctx.llmEnabled()) return null;
    try {
      const inputs = cats.map(toClassifyCategory);
      const results = await router.completeJson(
        buildClassifyRequest(item, inputs),
        (raw) => parseClassifyResults(raw, inputs),
      );
      return new Map(results.map((c) => [c.categoryId, c]));
    } catch (e) {
      log.warn(`LLM 分类失败，回退确定性条件: ${(e as Error).message}`);
      return null;
    }
  },
};

/** 判决链：按序试各档，首个非 null 结果即定案；全 null = 该组无判定。 */
export async function runJudgeChain(
  stages: JudgeStage[],
  item: ContentItem,
  cats: Category[],
  ctx: JudgeContext,
): Promise<Map<number, Classification>> {
  for (const s of stages) {
    const r = await s.judge(item, cats, ctx);
    if (r !== null) return r;
  }
  return new Map();
}

/**
 * 分类编排：live_start 对直播分类逐个判定、feed_post 对图文分类逐个判定，结果入 verdicts 表。
 *
 * 判定语义（LLM 优先，用户拍板；判决链精确映射）：
 * - 无 llmPrompt 的分类：永远只走 deterministic 档（matchCategoryItem），与 LLM 开关无关
 * - 有 llmPrompt 的分类：链序 llm → deterministic——llm 可用时定案（说「否」不回看确定性
 *   条件，空 Map 也算定案）；不可用 / 调用失败 / 解析失败时交 deterministic 兜底
 * - decision 档（决策模型）本期只定义类型不进链
 * - LLM 分类对全部监听主播 / 名单账号生效（v2 起 analyze 开关随面板三开关一并删除）
 *
 * 落档口径两形态（A.4）：post 侧 LLM 判否也落 pass=0（「为什么没推」可回看）；
 * 直播侧保持只记「属于」。classify() 返回值只含 pass=true（= 被判属于的分类）。
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
    const item = ctx.signal.kind === 'live_start' && ctx.event
      ? fromLiveEvent(ctx.event)
      : ctx.signal.kind === 'feed_post' && ctx.post
        ? fromPostCandidate(ctx.post.post, ctx.post.imageDataUrls)
        : null;
    if (item === null) return [];
    const isPost = item.subjectType === 'post';
    const cats = this.db.listEnabledCategories().filter((c) => c.appliesTo === item.subjectType);
    const jctx: JudgeContext = { getRouter: this.getRouter, llmEnabled: this.llmEnabled };
    const judged: Classification[] = [];

    const deterministicOnly = cats.filter((c) => !c.llmPrompt);
    if (deterministicOnly.length > 0) {
      judged.push(...(await runJudgeChain([deterministicJudge], item, deterministicOnly, jctx)).values());
    }

    const promptCats = cats.filter((c) => c.llmPrompt);
    if (promptCats.length > 0) {
      judged.push(...(await runJudgeChain([llmJudge, deterministicJudge], item, promptCats, jctx)).values());
    }

    for (const c of judged) {
      // post 侧 LLM 判否（pass=false）也落档；直播侧保持只记「属于」
      if (!isPost && c.pass === false) continue;
      // INSERT OR IGNORE：同一主体同一分类重复判定静默跳过
      this.db.insertVerdict({
        subjectType: item.subjectType,
        subjectId: item.subjectId,
        uid: item.uid,
        categoryId: c.categoryId, categoryName: c.name,
        ruleId: 0,
        source: c.source, confidence: c.confidence, evidence: c.evidence,
        ...(c.pass === false ? { pass: false } : {}),
      });
    }
    return judged.filter((c) => c.pass !== false);
  }
}
