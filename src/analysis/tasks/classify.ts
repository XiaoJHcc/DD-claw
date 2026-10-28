import { z } from 'zod';
import type { Category, JudgeMode, PrimaryJudgement } from '../../core/push.js';
import { preciseConditions } from '../../core/push.js';
import type { ContentPart, LlmRequest } from '../providers.js';
import type { ContentItem } from '../content.js';
import type { Classification } from '../types.js';

/**
 * 内容分类 LLM 任务：一次内容（live_start / feed_post）对所有「有模型判定口径」的分类
 * 合并成一次调用（而非每分类一次），成本与降级语义都最简单。
 * 口径两种：simple = 一句判定描述；precise = 逐条原子条件（正向任一支持、负向任一否决）。
 * 模型只给结论与理由（不给置信度——自报数字没有校准意义），另外在要求时选一个主分类。
 * 产出经 zod 校验（逐项完整、id 唯一、主分类 id 合法）后即为 LLM 档的判定结果。
 */

/** 精确条件下的单条原子条件（带稳定 id，试判 / 审计按它对齐） */
export interface ClassifyCondition {
  id: string;
  text: string;
}

/** 任务输入里每个分类的最小形状（Category 的子集，方便测试构造） */
export interface ClassifyCategory {
  id: number;
  name: string;
  /** simple 的判定描述（precise 下留空：精确模式绝不回退它） */
  prompt: string;
  /** 缺省 simple；precise 时才带下面两组条件 */
  judgeMode?: JudgeMode;
  /** 启用且文本非空的精确条件（数组顺序即展示顺序） */
  positives?: ClassifyCondition[];
  negatives?: ClassifyCondition[];
}

/** 「其他」的选项 id（主分类组里都不像时选它） */
export const PRIMARY_OTHER_ID = 0;
export const PRIMARY_OTHER_NAME = '其他';

const resultSchema = z.object({
  results: z.array(z.object({
    id: z.number().int(),
    match: z.boolean(),
    evidence: z.string(),
  })),
  primary: z.object({ id: z.number().int(), evidence: z.string() }).optional(),
});

const LIVE_SYSTEM_PROMPT =
  '你是直播内容分类器。逐项判断当前直播是否属于用户给出的每个分类，并在要求时选出主分类，' +
  '严格按 JSON schema 输出，不要输出任何多余内容。';

const POST_SYSTEM_PROMPT =
  '你是社交平台图文分类器。逐项判断这条帖子是否属于用户给出的每个分类，并在要求时选出主分类，' +
  '严格按 JSON schema 输出，不要输出任何多余内容。';

/**
 * 精确条件的判定规则（清单里出现精确分类时追加一段，只写一次）：
 * 正向「或」、负向「或」、两组之间「且非」——负向任一明确成立即否决，且否决优先。
 */
const PRECISE_RULES = [
  '精确条件判定规则（带「精确条件」的分类适用）：',
  '- 正向条件之间是「或」：任一条件可靠成立即可判属于，多条弱证据也可以合并支持同一结论。',
  '- 负向条件之间也是「或」，且整体否决正向：任一负向条件明确成立即判不属于，不再看正向。',
  '- 全部正向条件都不成立 = 不属于；只按列出的条件判，不要推测没写出来的意图。',
].join('\n');

/** 精确分类的清单块：名称 + 带稳定 id 的正负条件（顺序即用户排的顺序） */
function preciseBlock(c: ClassifyCategory): string[] {
  const positives = c.positives ?? [];
  const negatives = c.negatives ?? [];
  const lines = [`- id=${c.id} 「${c.name}」（精确条件）`, '  正向条件（任一成立即可支持）：'];
  for (const p of positives) lines.push(`  - id=${p.id} ${p.text}`);
  if (negatives.length > 0) {
    lines.push('  负向条件（任一成立即否决，优先于正向）：');
    for (const n of negatives) lines.push(`  - id=${n.id} ${n.text}`);
  }
  return lines;
}

/**
 * 单选口径的唯一写法：simple = 判定描述；precise = 启用正向条件的简明组合
 * （精确模式绝不拿 llmPrompt 当口径）。LLM 主分类清单与决策 choice criteria 共用它。
 */
export function criteriaText(c: ClassifyCategory): string {
  if (c.judgeMode !== 'precise') return c.prompt;
  return (c.positives ?? []).map((p) => p.text).join(' 或 ');
}

/** 分类清单（有主分类时追加单选段）：判定口径只进清单，抓来的标题正文只进上文内容段 */
function categorySection(categories: ClassifyCategory[], primaryOptions?: ClassifyCategory[]): string[] {
  const lines = ['分类清单（id、名称、判定描述）：'];
  for (const c of categories) {
    if (c.judgeMode === 'precise') lines.push(...preciseBlock(c));
    else lines.push(`- id=${c.id} 「${c.name}」：${c.prompt}`);
  }
  if (categories.some((c) => c.judgeMode === 'precise')) lines.push('', PRECISE_RULES);
  if (primaryOptions) {
    lines.push(
      '',
      '主分类（单选，选最像的一项；都不像选 id=0「其他」）：',
      ...primaryOptions.map((c) => `- id=${c.id} 「${c.name}」：${criteriaText(c)}`),
    );
  }
  return lines;
}

/** live 场次的用户消息（除分类清单段外逐字冻结：直播侧判定行为保持不变） */
function liveUserText(item: ContentItem, categories: ClassifyCategory[], primaryOptions?: ClassifyCategory[]): string {
  return [
    `主播：${item.authorName}`,
    `标题：${item.text}`,
    `分区：${item.tags.parentArea ?? ''} / ${item.tags.area ?? ''}`,
    '',
    ...categorySection(categories, primaryOptions),
  ].join('\n');
}

/** 图文帖的用户消息（判定分类制：同一条判决链，输入面换成帖子） */
function postUserText(item: ContentItem, categories: ClassifyCategory[], primaryOptions?: ClassifyCategory[]): string {
  const kind = item.tags.type === 'retweet' ? '转发' : '原创';
  return [
    `作者：${item.authorName}`,
    `类型：${kind}`,
    item.tags.platform ? `平台：${item.tags.platform}` : '',
    `引用：${item.tags.isQuote === 'unknown' ? '来源未提供引用状态' : item.tags.isQuote === 'true' ? '是' : '否'}`,
    item.tags.hasMedia === 'true' ? '配图：有（见下方附图）' : '配图：无',
    '',
    '帖子正文：',
    item.text || '（无正文，仅图片）',
    '',
    ...categorySection(categories, primaryOptions),
  ].filter(Boolean).join('\n');
}

/** 结构化输出 schema：只有请求了主分类时才要求 `primary`（未请求时模型不该答它） */
function classifySchema(withPrimary: boolean): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            match: { type: 'boolean' },
            evidence: { type: 'string' },
          },
          required: ['id', 'match', 'evidence'],
          additionalProperties: false,
        },
      },
      ...(withPrimary
        ? {
          primary: {
            type: 'object',
            properties: {
              id: { type: 'number' },
              evidence: { type: 'string' },
            },
            required: ['id', 'evidence'],
            additionalProperties: false,
          },
        }
        : {}),
    },
    required: withPrimary ? ['results', 'primary'] : ['results'],
    additionalProperties: false,
  };
}

export function buildClassifyRequest(
  item: ContentItem,
  categories: ClassifyCategory[],
  primaryOptions?: ClassifyCategory[],
): LlmRequest {
  const isPost = item.subjectType === 'post';
  const text = isPost
    ? postUserText(item, categories, primaryOptions)
    : liveUserText(item, categories, primaryOptions);
  const content: ContentPart[] = [{ type: 'text', text }];
  // 图片是判定前已规范化的基线 JPEG data URL（见 analysis/image-prep）；有图自动走 vision 路由
  for (const image of item.imageUrls) content.push({ type: 'image_url', image_url: { url: image } });
  // 主分类选项按一个额外条目的量估 token；精确条件逐条也按一个条目估（长清单被截断会稳定表现为「结果不完整」）
  const conditions = categories.reduce((n, c) => n + (c.positives?.length ?? 0) + (c.negatives?.length ?? 0), 0);
  const items = categories.length + conditions + (primaryOptions ? 1 : 0);
  return {
    messages: [
      { role: 'system', content: isPost ? POST_SYSTEM_PROMPT : LIVE_SYSTEM_PROMPT },
      { role: 'user', content },
    ],
    jsonSchema: { name: 'classify', schema: classifySchema(primaryOptions !== undefined) },
    maxTokens: Math.max(1024, Math.min(8192, items * 160)),
  };
}

/** 主分类判定 → PrimaryJudgement（id=0 = 「其他」；未生效由编排器标记） */
function toPrimaryJudgement(
  raw: { id: number; evidence: string },
  primaryOptions: ClassifyCategory[],
): PrimaryJudgement {
  if (raw.id === PRIMARY_OTHER_ID) {
    return {
      source: 'llm', categoryId: PRIMARY_OTHER_ID, name: PRIMARY_OTHER_NAME,
      distribution: null, evidence: raw.evidence, effective: false,
    };
  }
  const hit = primaryOptions.find((c) => c.id === raw.id);
  if (!hit) throw new Error(`主分类结果 id=${raw.id} 不在选项集内`);
  return {
    source: 'llm', categoryId: hit.id, name: hit.name,
    distribution: null, evidence: raw.evidence, effective: false,
  };
}

/**
 * zod 校验 + 结论标注：**逐项全部返回**（含判否，pass=false，同样落 verdicts
 * 供「为什么没推」回看）；模型编造的未知分类 id 丢弃，重复 id 与漏项整份判失败。
 * 请求了主分类时 `primary` 必答，且 id 必须是选项之一或 0（「其他」）。
 * parse 抛错（模型没按 schema 输出）由 providers 层计入熔断并触发调用方回退。
 */
export function parseClassifyResults(
  raw: unknown,
  categories: ClassifyCategory[],
  primaryOptions?: ClassifyCategory[],
): { results: Classification[]; primary: PrimaryJudgement | null } {
  const parsed = resultSchema.parse(raw);
  const byId = new Map(categories.map((c) => [c.id, c]));
  const seen = new Set<number>();
  const out: Classification[] = [];
  for (const r of parsed.results) {
    const cat = byId.get(r.id);
    if (!cat) continue;
    if (seen.has(r.id)) throw new Error(`分类结果重复 id=${r.id}`);
    seen.add(r.id);
    out.push({
      categoryId: cat.id, name: cat.name, source: 'llm',
      confidence: null, evidence: r.evidence, pass: r.match, effective: false,
    });
  }
  if (seen.size !== byId.size) throw new Error('分类结果不完整：必须返回每个分类的判定');
  if (primaryOptions === undefined) return { results: out, primary: null };
  if (parsed.primary === undefined) throw new Error('主分类结果缺失：要求了主分类必须返回 primary');
  return { results: out, primary: toPrimaryJudgement(parsed.primary, primaryOptions) };
}

/**
 * Category → 任务输入形状。判定模式决定口径：simple 带判定描述（调用方保证非空），
 * precise 只带启用且文本非空的正负条件（**不**带 llmPrompt——精确模式不回退它）。
 */
export function toClassifyCategory(c: Category): ClassifyCategory {
  if (c.judgeMode === 'precise') {
    const { positives, negatives } = preciseConditions(c);
    const toCond = (x: { id: string; text: string }): ClassifyCondition => ({ id: x.id, text: x.text });
    return {
      id: c.id, name: c.name, prompt: '', judgeMode: 'precise',
      positives: positives.map(toCond), negatives: negatives.map(toCond),
    };
  }
  return { id: c.id, name: c.name, prompt: c.llmPrompt ?? '' };
}
