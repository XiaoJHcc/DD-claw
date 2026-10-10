import { z } from 'zod';
import type { Category } from '../../core/push.js';
import type { ContentPart, LlmRequest } from '../providers.js';
import type { ContentItem } from '../content.js';
import type { Classification } from '../types.js';

/**
 * 内容分类 LLM 任务：一次 live_start 对所有「启用且有 llmPrompt」的分类
 * 合并成一次调用（而非每分类一次），成本与降级语义都最简单。
 * 产出经 zod 校验 + match/confidence 阈值过滤后即为 LLM 路径的判定结果。
 */

/** LLM 判定采纳的最低置信度（低于此视为「不属于」） */
export const MIN_CONFIDENCE = 0.5;

/** 任务输入里每个分类的最小形状（Category 的子集，方便测试构造） */
export interface ClassifyCategory {
  id: number;
  name: string;
  prompt: string;
}

const resultSchema = z.object({
  results: z.array(z.object({
    id: z.number(),
    match: z.boolean(),
    confidence: z.number(),
    evidence: z.string(),
  })),
});

const LIVE_SYSTEM_PROMPT =
  '你是直播内容分类器。逐项判断当前直播是否属于用户给出的每个分类，' +
  '严格按 JSON schema 输出，不要输出任何多余内容。';

const POST_SYSTEM_PROMPT =
  '你是社交平台图文分类器。逐项判断这条帖子是否属于用户给出的每个分类，' +
  '严格按 JSON schema 输出，不要输出任何多余内容。';

/** live 场次的用户消息（逐字冻结：直播侧判定行为保持不变） */
function liveUserText(item: ContentItem, categories: ClassifyCategory[]): string {
  return [
    `主播：${item.authorName}`,
    `标题：${item.text}`,
    `分区：${item.tags.parentArea ?? ''} / ${item.tags.area ?? ''}`,
    '',
    '分类清单（id、名称、判定提示词）：',
    ...categories.map((c) => `- id=${c.id} 「${c.name}」：${c.prompt}`),
  ].join('\n');
}

/** 图文帖的用户消息（判定分类制：同一条判决链，输入面换成帖子） */
function postUserText(item: ContentItem, categories: ClassifyCategory[]): string {
  const kind = item.tags.type === 'retweet' ? '转发' : '原创';
  return [
    `作者：${item.authorName}`,
    `类型：${kind}`,
    item.tags.platform ? `平台：${item.tags.platform}` : '',
    item.tags.hasMedia === 'true' ? '配图：有（见下方附图）' : '配图：无',
    '',
    '帖子正文：',
    item.text || '（无正文，仅图片）',
    '',
    '分类清单（id、名称、判定提示词）：',
    ...categories.map((c) => `- id=${c.id} 「${c.name}」：${c.prompt}`),
  ].filter(Boolean).join('\n');
}

export function buildClassifyRequest(item: ContentItem, categories: ClassifyCategory[]): LlmRequest {
  const isPost = item.subjectType === 'post';
  const text = isPost ? postUserText(item, categories) : liveUserText(item, categories);
  const content: ContentPart[] = [{ type: 'text', text }];
  // 开播瞬间常无关键帧，封面兜底（fromLiveEvent 已折叠）；带图自动走 vision 路由
  for (const image of item.imageUrls) content.push({ type: 'image_url', image_url: { url: image } });
  return {
    messages: [
      { role: 'system', content: isPost ? POST_SYSTEM_PROMPT : LIVE_SYSTEM_PROMPT },
      { role: 'user', content },
    ],
    jsonSchema: {
      name: 'classify',
      schema: {
        type: 'object',
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'number' },
                match: { type: 'boolean' },
                confidence: { type: 'number' },
                evidence: { type: 'string' },
              },
              required: ['id', 'match', 'confidence', 'evidence'],
              additionalProperties: false,
            },
          },
        },
        required: ['results'],
        additionalProperties: false,
      },
    },
    maxTokens: 1024,
  };
}

/**
 * zod 校验 + 判定标注：**逐项全部返回**（含判否，pass=false——post 侧判否落 verdicts
 * 供「为什么没推」回看）；match=true 且置信度达标才 pass=true。模型编造的未知 id 丢弃。
 * parse 抛错（模型没按 schema 输出）由 providers 层计入熔断并触发调用方回退。
 */
export function parseClassifyResults(raw: unknown, categories: ClassifyCategory[]): Classification[] {
  const parsed = resultSchema.parse(raw);
  const byId = new Map(categories.map((c) => [c.id, c]));
  const out: Classification[] = [];
  for (const r of parsed.results) {
    const cat = byId.get(r.id);
    if (!cat) continue;
    out.push({
      categoryId: cat.id, name: cat.name, source: 'llm',
      confidence: r.confidence, evidence: r.evidence,
      pass: r.match && r.confidence >= MIN_CONFIDENCE,
    });
  }
  return out;
}

/** Category → 任务输入形状（llmPrompt 非空断言由调用方保证） */
export function toClassifyCategory(c: Category): ClassifyCategory {
  return { id: c.id, name: c.name, prompt: c.llmPrompt! };
}
