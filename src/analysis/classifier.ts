import { makeLogger } from '../logger.js';
import type { Db } from '../core/db.js';
import type { Category, PrimaryJudgement } from '../core/push.js';
import type { LlmRouter } from './providers.js';
import type { DecisionRouter } from './decision-router.js';
import { DecisionUnavailableError } from './decision-router.js';
import { matchCategoryItem } from './matcher.js';
import { fromLiveEvent, fromPostCandidate, type ContentItem } from './content.js';
import { buildClassifyRequest, parseClassifyResults, toClassifyCategory, PRIMARY_OTHER_ID, PRIMARY_OTHER_NAME } from './tasks/classify.js';
import {
  buildDecisionRequest, parseDecisionResponse, DEFAULT_DECISION_THRESHOLDS, type DecisionThresholds,
} from './tasks/decide.js';
import type { AnalysisContext, Classification, Classifier } from './types.js';
import type { AnalysisAudit, ModelAttempt } from '../core/content-audit.js';

const log = makeLogger('analysis/classifier');

// ---- 判决链：可插拔的判定档位（确定性永远先跑，模型档按序试，未定案项交下一档）----

/** 判决链运行时上下文：各档共用的能力面（两条模型通道各自独立的路由、开关与门槛） */
export interface JudgeContext {
  /** LLM 路由 getter（面板改 provider 名单后热重建，每轮取最新）；null = 无 provider */
  getRouter: () => LlmRouter | null;
  /** LLM 总开关 */
  llmEnabled: () => boolean;
  /** 决策模型路由 getter（名单 / key / 超时熔断变化后热重建）；null = 无可用路由 */
  getDecisionRouter: () => DecisionRouter | null;
  /** 决策档总开关（settings `decision_enabled`，缺省关） */
  decisionEnabled: () => boolean;
  /** 决策档的门槛（灰区上下界 + 主分类门槛，0–1；每次判定直读 settings） */
  decisionThresholds: () => DecisionThresholds;
  /** LLM 档不可用的原因（审计的 fallbackReason 只承载它） */
  onFallback?: (reason: string) => void;
  /** 某档被跳过 / 失败的原因（进审计 stageNotes，不与 LLM 的回退文案混用） */
  onStageSkip?: (stage: JudgeStage['name'], reason: string) => void;
  onAttempt?: (attempt: ModelAttempt) => void;
}

/**
 * 一档要判的东西：本轮仍未定案的分类（`cats`），以及（主分类仍未定案时）主分类组的模型候选。
 * `primaryCats` 为 null = 主分类已定案或没有带判定描述的主分类，本档不要问主分类。
 */
export interface JudgeRequest {
  cats: Category[];
  primaryCats: Category[] | null;
}

/**
 * 一档的产出：`results` = 本档跑出的**全部**结论（含未定案项，逐档全部落库）；
 * `decided` = 本档定案的分类 id（未定案的判否与灰区留在 results 里但交下一档）；
 * `primary` = 本档的主分类结论（未定案也可能有结论，例如灰区），`primaryDecided` = 是否定案。
 */
export interface JudgeOutcome {
  results: Classification[];
  decided: Set<number>;
  primary: PrimaryJudgement | null;
  primaryDecided: boolean;
}

/** 判决档位：返回 null = 本档不可用 / 不适用（交下一档）。 */
export interface JudgeStage {
  name: 'decision' | 'llm';
  judge(item: ContentItem, req: JudgeRequest, ctx: JudgeContext): Promise<JudgeOutcome | null>;
}

/**
 * LLM 档：一次批量调用同时回答「是否属于」与「主分类」（请求了主分类才问）。
 * 返回即定案（权威——定案后不回看确定性）；无 provider / 总开关关 / 调用失败 / 解析失败
 * = 本档不可用，返回 null 交下一档（失败时 audit 记 fallbackReason）。
 */
export const llmJudge: JudgeStage = {
  name: 'llm',
  async judge(item, req, ctx) {
    const router = ctx.getRouter();
    if (router === null || !ctx.llmEnabled()) {
      ctx.onFallback?.(router === null ? '未配置 LLM provider，使用确定性条件' : 'LLM 总开关关闭，使用确定性条件');
      return null;
    }
    try {
      const inputs = req.cats.map(toClassifyCategory);
      // 没有候选时不必问主分类（问也只能答「其他」）
      const primaryOptions = req.primaryCats !== null && req.primaryCats.length > 0
        ? req.primaryCats.map(toClassifyCategory)
        : undefined;
      const { results, primary } = await router.completeJson(
        buildClassifyRequest(item, inputs, primaryOptions),
        (raw) => parseClassifyResults(raw, inputs, primaryOptions),
        (attempt) => ctx.onAttempt?.({ ...attempt, channel: 'llm' }),
      );
      return {
        results,
        decided: new Set(results.map((r) => r.categoryId)),
        primary,
        primaryDecided: primary !== null,
      };
    } catch (e) {
      log.warn(`LLM 分类失败，回退确定性条件: ${(e as Error).message}`);
      ctx.onFallback?.(e instanceof Error ? e.message : String(e));
      return null;
    }
  },
};

/**
 * 决策档：一次 System One 请求同时回答「是否属于」（每分类一道 noul）与主分类（一道 choice）。
 *
 * 不可用 / 失败一律返回 null 把未定案项交下一档，且**只经 `onStageSkip` 记原因**——
 * `fallbackReason` 只承载 LLM 档的回退文案，决策档不往那里写（否则审计会把两条通道混成一条）。
 * 灰区与「纯文本供应商没看图」不算失败：结论照常落库，只是不定案。
 */
export const decisionJudge: JudgeStage = {
  name: 'decision',
  async judge(item, req, ctx) {
    const router = ctx.getDecisionRouter();
    if (router === null) {
      ctx.onStageSkip?.('decision', '未配置决策模型供应商');
      return null;
    }
    if (!ctx.decisionEnabled()) {
      ctx.onStageSkip?.('decision', '决策模型总开关关闭');
      return null;
    }
    const cats = req.cats.map(toClassifyCategory);
    const primaryOptions = req.primaryCats !== null && req.primaryCats.length > 0
      ? req.primaryCats.map(toClassifyCategory)
      : undefined;
    if (cats.length === 0 && primaryOptions === undefined) return null;
    const hasImages = item.imageUrls.length > 0;
    const thresholds = ctx.decisionThresholds();
    // build 按候选供应商各自构造（model 随供应商变）；keyMap 只由分类/选项集决定，最后一次即准。
    // validate 只做契约校验（解析是纯函数，成功后再解一次拿到带证据的结论）。
    let keyMap: Record<string, number> = {};
    try {
      const { response, provider, withImages } = await router.decide(
        (withImages, spec) => {
          const built = buildDecisionRequest(item, cats, primaryOptions, spec.model, withImages);
          keyMap = built.keyMap;
          return { req: built.req, assets: built.assets };
        },
        { hasImages },
        (res) => { parseDecisionResponse(res, cats, primaryOptions, keyMap, thresholds); },
        (attempt) => ctx.onAttempt?.({ ...attempt, channel: 'decision' }),
      );
      return parseDecisionResponse(response, cats, primaryOptions, keyMap, thresholds, {
        providerName: provider.name,
        model: response.model || provider.model,
        textOnlyForImageItem: hasImages && !withImages,
      });
    } catch (e) {
      const message = (e as Error).message;
      log.warn(`决策模型档不可用，交下一档: ${message}`);
      // 区分「没有可用供应商」（档位本次不该跑）与「调用 / 解析失败」，两者在审计里读得出来
      ctx.onStageSkip?.('decision', e instanceof DecisionUnavailableError
        ? `决策模型档不可用：${message}`
        : `决策模型判定失败：${message}`);
      return null;
    }
  },
};

/** 模型档的顺序：决策模型先跑（便宜、带概率、可定案），未定案项再交 LLM。确定性不是档位——
 *  它永远先跑，既是无描述分类的定案来源，也是模型档全部不可用时的回退来源。 */
export const JUDGE_STAGES: readonly JudgeStage[] = [decisionJudge, llmJudge];

/** 无条件组的确定性结论说明（落库要能看出「为什么判否」） */
const NO_CONDITION_NOTE = '无确定性条件';

/**
 * 单分类的确定性结论（source='rule'）：线上判决链与分类草稿试跑共用同一份口径，
 * 两边都不得各自重写一遍「命中说明 / 未命中 / 无条件组」的措辞。
 * `hasConditions` = 该分类对本内容类型有可判定条件组（决定落库时是否保留判否行）。
 */
export function ruleConclusion(
  cat: Category,
  item: ContentItem,
): { hasConditions: boolean; result: Classification } {
  const m = matchCategoryItem(cat, item);
  return {
    hasConditions: m.hasConditions,
    result: {
      categoryId: cat.id, name: cat.name, source: 'rule', confidence: null,
      evidence: m.matched ? m.evidence : (m.hasConditions ? '确定性条件未命中' : NO_CONDITION_NOTE),
      pass: m.matched, effective: false,
    },
  };
}

/** 分类编排的运行时依赖（全是 getter：面板改动后下一轮即生效） */
export interface RulesClassifierOptions {
  /** LLM 路由；null = 没有可用 provider */
  getRouter: () => LlmRouter | null;
  /** LLM 总开关（settings `llm_enabled`） */
  llmEnabled: () => boolean;
  /** 决策模型路由；缺省 null（决策档不参与） */
  getDecisionRouter?: () => DecisionRouter | null;
  /** 决策档总开关（settings `decision_enabled`）；缺省 false */
  decisionEnabled?: () => boolean;
  /** 决策档门槛（0–1）；缺省 DEFAULT_DECISION_THRESHOLDS */
  decisionThresholds?: () => DecisionThresholds;
}

/**
 * 分类编排：live_start 对直播分类、feed_post 对图文分类判定，结论入 verdicts / primary_verdicts。
 *
 * 逐档落库 + 定案条件：
 * - 确定性永远先跑（零成本），对全部分类给出属于 / 不属于；无判定描述的分类由它定案
 * - 有判定描述的分类按档位依次判（决策模型 → LLM）：每档只收到仍未定案的分类，返回的结论
 *   全部落库，定案的（`decided`）成为该分类生效结论并移出后续档；决策档的灰区、
 *   以及「带图内容只被纯文本供应商回答」的结论照样落库但不定案
 * - 模型档都没定案的有描述分类，由确定性结果定案（evidence 写明是回退）
 * - 主分类：模型档定案优先；仍未定案则按分类排序取主分类组里第一个「生效且属于」的分类，
 *   都不属于 = 「其他」（categoryId 0）
 * - 模型定案后不回看确定性（关键词捞不回模型的「否」）
 *
 * 落库口径两形态统一：pass=true 与 pass=false 都入 verdicts（「为什么没推」可回看）；
 * 无任何有效条件组的分类不落确定性行（除非它成为生效结论）——那里没有可回看的判据。
 * classify() 返回值只含「生效且属于」，pipeline 的规则匹配只看它。
 */
export class RulesClassifier implements Classifier {
  readonly name = 'rules-classifier';

  /**
   * `opts` 里的都是 getter 而非固定值：面板改 provider 名单 / 总开关 / 门槛后热生效，
   * 每轮判定取最新。决策档三项（router / 开关 / 门槛）缺省 = 决策档不参与
   *（只跑 LLM 与确定性），供单测与只接 LLM 的场景使用。
   */
  constructor(private readonly db: Db, private readonly opts: RulesClassifierOptions) {}

  private decisionThresholds(): DecisionThresholds {
    return this.opts.decisionThresholds?.() ?? DEFAULT_DECISION_THRESHOLDS;
  }

  async classify(ctx: AnalysisContext): Promise<Classification[]> {
    // 视觉输入只认判定前规范化好的 data URL（两种内容共用）；缺省 = 无图
    const imageDataUrls = ctx.images?.dataUrls ?? [];
    const item = ctx.signal.kind === 'live_start' && ctx.event
      ? fromLiveEvent(ctx.event, imageDataUrls)
      : ctx.signal.kind === 'feed_post' && ctx.post
        ? fromPostCandidate(ctx.post.post, imageDataUrls)
        : null;
    if (item === null) return [];
    const cats = this.db.listEnabledCategories().filter((c) => c.appliesTo === item.subjectType);
    const started = Date.now();
    const audit: AnalysisAudit = { status: 'pending', categories: cats, results: [], imageCount: item.imageUrls.length, attempts: [],
      input: { text: item.text, authorName: item.authorName, tags: item.tags, url: item.url, ts: item.ts } };
    // 被拦下的图逐张记原因：送模型的张数与「本可以有几张」的差要能回看
    if (ctx.images?.skipped?.length) audit.skippedImages = ctx.images.skipped;
    this.db.recordContentAudit(item.subjectType, item.subjectId, 'analysis', audit);
    const jctx: JudgeContext = {
      getRouter: this.opts.getRouter,
      llmEnabled: this.opts.llmEnabled,
      getDecisionRouter: this.opts.getDecisionRouter ?? (() => null),
      decisionEnabled: this.opts.decisionEnabled ?? (() => false),
      decisionThresholds: () => this.decisionThresholds(),
      onFallback: (reason) => { audit.fallbackReason = reason; },
      onStageSkip: (stage, reason) => {
        audit.stageNotes ??= [];
        audit.stageNotes.push({ stage, reason });
      },
      onAttempt: (attempt) => { audit.attempts!.push(attempt); },
    };

    // 确定性结论：对全部分类计算（零成本）；无条件组的分类标出来，落库时区别对待
    const deterministic = new Map<number, Classification>();
    const noConditions = new Set<number>();
    for (const c of cats) {
      const conclusion = ruleConclusion(c, item);
      if (!conclusion.hasConditions) noConditions.add(c.id);
      deterministic.set(c.id, conclusion.result);
    }

    const modelCats = cats.filter((c) => c.llmPrompt);
    const primaryAll = cats.filter((c) => c.primary);
    const primaryModel = primaryAll.filter((c) => c.llmPrompt);
    const pending = new Set(modelCats.map((c) => c.id));
    let primaryPending = primaryModel.length > 0;
    const modelRows: Classification[] = [];
    const primaryRows: PrimaryJudgement[] = [];
    let decidedPrimary: PrimaryJudgement | null = null;

    for (const stage of JUDGE_STAGES) {
      if (pending.size === 0 && !primaryPending) break;
      const req: JudgeRequest = {
        cats: modelCats.filter((c) => pending.has(c.id)),
        primaryCats: primaryPending ? primaryModel : null,
      };
      const out = await stage.judge(item, req, jctx);
      if (out === null) continue; // 本档不可用：未定案项交下一档
      // 定案标记必须在**本档**落地：pending 是滚动的，后面档把同一分类定案后
      // 不能再回头把前面档的灰区行标成生效
      for (const r of out.results) {
        if (!out.decided.has(r.categoryId)) continue;
        r.effective = true;
        pending.delete(r.categoryId);
      }
      modelRows.push(...out.results);
      if (out.primary !== null) {
        primaryRows.push(out.primary);
        if (out.primaryDecided) {
          out.primary.effective = true;
          decidedPrimary = out.primary;
          primaryPending = false;
        }
      }
    }

    // 生效结论：无描述分类 = 确定性；模型定案的 = 该档结论；其余 = 确定性回退（写明原因）
    const effective = new Map<number, Classification>();
    for (const c of cats) {
      if (!c.llmPrompt) effective.set(c.id, deterministic.get(c.id)!);
    }
    for (const r of modelRows) {
      if (!r.effective) continue; // 未定案（如决策模型灰区 / 纯文本供应商没看图）不生效
      effective.set(r.categoryId, r);
    }
    for (const id of pending) {
      const det = deterministic.get(id)!;
      const row: Classification = {
        ...det, effective: true,
        evidence: det.pass
          ? `模型不可用，按确定性条件：${det.evidence}`
          : (noConditions.has(id) ? '模型不可用且无确定性条件' : '模型不可用，按确定性条件未命中'),
      };
      deterministic.set(id, row);
      effective.set(id, row);
    }
    for (const row of effective.values()) row.effective = true;

    // 主分类：模型定案优先，否则按分类排序取组内第一个「生效且属于」，都没有 = 「其他」
    if (decidedPrimary === null && primaryAll.length > 0) {
      const hit = primaryAll.find((c) => effective.get(c.id)?.pass === true);
      decidedPrimary = {
        source: 'rule',
        categoryId: hit ? hit.id : PRIMARY_OTHER_ID,
        name: hit ? hit.name : PRIMARY_OTHER_NAME,
        distribution: null,
        evidence: hit ? '按分类顺序取首个生效且属于的组内分类' : '组内没有生效且属于的分类',
        effective: true,
      };
      primaryRows.push(decidedPrimary);
    }

    // 落库：确定性行在前（无条件的仅当它是生效结论时才落），模型行在后；每分类恰一行生效
    const rows: Classification[] = [];
    for (const c of cats) {
      const det = deterministic.get(c.id)!;
      if (!noConditions.has(c.id) || effective.get(c.id) === det) rows.push(det);
      for (const r of modelRows) {
        if (r.categoryId === c.id) rows.push(r);
      }
    }
    for (const r of rows) {
      this.db.insertVerdict({
        subjectType: item.subjectType,
        subjectId: item.subjectId,
        uid: item.uid,
        categoryId: r.categoryId, categoryName: r.name,
        ruleId: 0,
        source: r.source, pass: r.pass, confidence: r.confidence,
        evidence: r.evidence, effective: r.effective,
      });
    }
    for (const p of primaryRows) {
      this.db.insertPrimaryVerdict({
        subjectType: item.subjectType,
        subjectId: item.subjectId,
        uid: item.uid,
        categoryId: p.categoryId, name: p.name, source: p.source,
        distribution: p.distribution, evidence: p.evidence, effective: p.effective,
      });
    }

    audit.results = rows.map((r) => ({
      categoryId: r.categoryId, name: r.name, source: r.source,
      pass: r.pass, confidence: r.confidence, evidence: r.evidence, effective: r.effective,
    }));
    if (primaryRows.length > 0) audit.primary = primaryRows;
    audit.status = 'done';
    audit.durationMs = Date.now() - started;
    this.db.recordContentAudit(item.subjectType, item.subjectId, 'analysis', audit);

    return cats.map((c) => effective.get(c.id)!).filter((r) => r.pass);
  }
}
