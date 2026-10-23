/**
 * 决策模型判定任务：把一次内容打成一道 System One 请求（`state + questions`），
 * 再把 typed answers 解成判决链要的 `JudgeOutcome`。
 *
 * 口径（docs/plan/decision-model.md §2.1 / §2.5）：
 * - 是非判定 = 每分类一道 `noul`，得 `p = P(属于)`，`pass = p ≥ 0.5`，`confidence = p`；
 *   只有 `p ≥ high` 或 `p ≤ low` 才定案，中间是灰区（结果落库、交下一档）。
 * - 主分类 = 一道 `choice`，选项键是分类名（重名追加 `#id`），末项「其他」；最高项概率
 *   `≥ primaryMin` 才定案。
 * - 内容带图但回答者是纯文本供应商：结果落库但一律不定案（它没看图）。
 * - **防注入**：抓来的标题 / 正文 / 平台标签只进 `state`，判定描述只进 `instructions` /
 *   `criteria`（问句里可以反引号指称 state 字段）。
 * - 图片走 TypeSafe 原生 `assets`：每张一个本次请求新生成的 UUID ref，base64 剥掉 data URL 前缀。
 */
import { randomUUID } from 'node:crypto';
import type { PrimaryJudgement } from '../../core/push.js';
import type { ContentItem } from '../content.js';
import type { Classification } from '../types.js';
import type { JudgeOutcome } from '../classifier.js';
import type { DecisionAsset, SystemOneQuestion, SystemOneRequest, SystemOneResponse } from '../decision-providers.js';
import { PRIMARY_OTHER_ID, PRIMARY_OTHER_NAME, type ClassifyCategory } from './classify.js';

/** 判决门（0–1 概率）：是非灰区上下界 + 主分类最高项定案门槛 */
export interface DecisionThresholds {
  low: number;
  high: number;
  primaryMin: number;
}

/** 与 NUM_SPECS 的默认值一致（20% / 80% / 60%）；生产由运行时参数注入 */
export const DEFAULT_DECISION_THRESHOLDS: DecisionThresholds = { low: 0.2, high: 0.8, primaryMin: 0.6 };

export interface DecisionRequestParts {
  req: SystemOneRequest;
  /** 含图时的图片资产（无图不带这个键，请求体里就没有 assets） */
  assets?: Record<string, DecisionAsset>;
  /** choice 选项键 → 分类 id（「其他」= 0）；解析答案时把键映射回分类 */
  keyMap: Record<string, number>;
}

/** data URL → 纯 base64（只认 base64 形态；拿不到 base64 的图直接不发） */
function splitDataUrl(url: string): string | null {
  const m = /^data:[^;,]*;base64,(.*)$/s.exec(url);
  return m ? m[1]! : null;
}

/** 图片 data URL → assets + refs（每张一个新 UUID；全部拿不到 = null，按无图处理） */
function imageParts(urls: string[]): { assets: Record<string, DecisionAsset>; refs: string[] } | null {
  const assets: Record<string, DecisionAsset> = {};
  const refs: string[] = [];
  for (const url of urls) {
    const data = splitDataUrl(url);
    if (data === null) continue;
    const ref = randomUUID();
    assets[ref] = { type: 'image', format: 'jpg', data_base64: data };
    refs.push(ref);
  }
  return refs.length > 0 ? { assets, refs } : null;
}

/**
 * 主分类 choice 的「选项键 → 分类 id」映射。键是分类名（模型看得到），
 * 重名追加 `#id`；分类名恰好叫「其他」时同样改名，「其他」这条也给唯一键。
 */
export function primaryKeyMap(options: ClassifyCategory[]): Record<string, number> {
  const map: Record<string, number> = {};
  const used = new Set<string>();
  for (const c of options) {
    const key = used.has(c.name) || c.name === PRIMARY_OTHER_NAME ? `${c.name}#${c.id}` : c.name;
    used.add(key);
    map[key] = c.id;
  }
  const otherKey = used.has(PRIMARY_OTHER_NAME) ? `${PRIMARY_OTHER_NAME}#${PRIMARY_OTHER_ID}` : PRIMARY_OTHER_NAME;
  map[otherKey] = PRIMARY_OTHER_ID;
  return map;
}

/** 直播 state：主播 / 标题 / 分区（父 / 子），有图时追加 `画面` ref */
function liveState(item: ContentItem, refs: string[]): Record<string, unknown> {
  const state: Record<string, unknown> = {
    主播: item.authorName,
    标题: item.text,
    分区: `${item.tags.parentArea ?? ''} / ${item.tags.area ?? ''}`,
  };
  if (refs.length > 0) state.画面 = refs[0];
  return state;
}

/** 图文 state：作者 / 平台 / 类型 / 引用 / 正文，有图时追加 `配图` ref 数组 */
function postState(item: ContentItem, refs: string[]): Record<string, unknown> {
  const state: Record<string, unknown> = {
    作者: item.authorName,
    平台: item.tags.platform ?? '',
    类型: item.tags.type === 'retweet' ? '转发' : '原创',
    引用: item.tags.isQuote === 'unknown' ? '未知' : item.tags.isQuote === 'true' ? '是' : '否',
    正文: item.text || '（无正文，仅图片）',
  };
  if (refs.length > 0) state.配图 = refs;
  return state;
}

/**
 * 打包一次判定请求。`withImages=false` 时**既不发 assets，也不在 state 里留任何图片 ref**
 *（纯文本供应商只应看到文字），图片部分由调用方按候选供应商的能力选择。
 */
export function buildDecisionRequest(
  item: ContentItem,
  cats: ClassifyCategory[],
  primaryOptions: ClassifyCategory[] | undefined,
  model: string,
  withImages: boolean,
): DecisionRequestParts {
  const images = withImages
    // 直播只发一张画面（关键帧）：state 里只有一个 ref，多发的 asset 会被端点判 400
    ? imageParts(item.subjectType === 'post' ? item.imageUrls : item.imageUrls.slice(0, 1))
    : null;
  const refs = images?.refs ?? [];
  const state = item.subjectType === 'post' ? postState(item, refs) : liveState(item, refs);

  const questions: Record<string, SystemOneQuestion> = {};
  for (const c of cats) {
    questions[`c${c.id}`] = {
      type: 'noul',
      instructions: `这条内容是否属于「${c.name}」？判定标准：${c.prompt}`,
    };
  }

  let keyMap: Record<string, number> = {};
  if (primaryOptions && primaryOptions.length > 0) {
    keyMap = primaryKeyMap(primaryOptions);
    const criteria: Record<string, string> = {};
    for (const [key, id] of Object.entries(keyMap)) {
      const cat = id === PRIMARY_OTHER_ID ? undefined : primaryOptions.find((c) => c.id === id);
      criteria[key] = cat ? cat.prompt : '不属于以上任何一项';
    }
    questions.primary = {
      type: 'choice',
      instructions: '这条内容最像下面哪一项？',
      criteria,
    };
  }

  const req: SystemOneRequest = { model, state, questions };
  return images ? { req, assets: images.assets, keyMap } : { req, keyMap };
}

/** 0–1 概率：类型不对或越界即整份响应判失败（不猜一半结果） */
function prob(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
    throw new Error(`${what} 不是 0–1 的数值`);
  }
  return v;
}

export interface DecisionMeta {
  /** 回答者（供应商名） */
  providerName: string;
  /** 响应回显的模型版本（别名会漂，审计记这个） */
  model: string;
  /** 内容带图但回答者是纯文本供应商：结果落库，一律不定案 */
  textOnlyForImageItem: boolean;
}

/**
 * typed answers → 判决链产出。任何一道题缺失 / 类型不符 / 数值越界 = 抛错（整份失败，
 * 本档本次没有结果，未定案项交下一档）。
 *
 * `meta` 只影响 evidence 文案与「纯文本供应商未看图」的定案抑制，故缺省可省：
 * 路由层用它做**契约校验**（只看会不会抛错），真正落库的那次解析再带上回答者信息。
 */
export function parseDecisionResponse(
  res: SystemOneResponse,
  cats: ClassifyCategory[],
  primaryOptions: ClassifyCategory[] | undefined,
  keyMap: Record<string, number>,
  thresholds: DecisionThresholds,
  meta: DecisionMeta = { providerName: '', model: res.model, textOnlyForImageItem: false },
): JudgeOutcome {
  const answers = res.answers ?? {};
  const base = `${meta.providerName} · ${meta.model}`;
  const results: Classification[] = [];
  const decided = new Set<number>();

  for (const c of cats) {
    const answer = answers[`c${c.id}`];
    if (!answer) throw new Error(`决策响应缺少分类 ${c.id} 的答案`);
    if (answer.type !== 'noul') throw new Error(`分类「${c.name}」的答案不是 noul（收到 ${answer.type}）`);
    const p = prob(answer.noul, `分类「${c.name}」的 p`);
    const notes: string[] = [];
    let isDecided = false;
    if (meta.textOnlyForImageItem) {
      notes.push('纯文本供应商未看图，不定案');
    } else if (p >= thresholds.high || p <= thresholds.low) {
      isDecided = true;
    } else {
      notes.push(`灰区 p=${p.toFixed(2)} 未定案`);
    }
    if (isDecided) decided.add(c.id);
    results.push({
      categoryId: c.id,
      name: c.name,
      source: 'decision',
      confidence: p,
      evidence: notes.length > 0 ? `${base}；${notes.join('；')}` : base,
      pass: p >= 0.5,
      effective: false,
    });
  }

  let primary: PrimaryJudgement | null = null;
  let primaryDecided = false;
  if (primaryOptions && primaryOptions.length > 0) {
    const answer = answers.primary;
    if (!answer) throw new Error('决策响应缺少主分类答案');
    if (answer.type !== 'choice') throw new Error(`主分类答案不是 choice（收到 ${answer.type}）`);
    const pickedKey = answer.choice;
    if (typeof pickedKey !== 'string' || keyMap[pickedKey] === undefined) {
      throw new Error(`主分类答案的选项未知: ${String(pickedKey)}`);
    }
    const pickedId = keyMap[pickedKey]!;
    const pickedCat = pickedId === PRIMARY_OTHER_ID ? undefined : primaryOptions.find((c) => c.id === pickedId);
    if (pickedId !== PRIMARY_OTHER_ID && !pickedCat) throw new Error(`主分类答案不在选项集内: ${pickedId}`);

    const probs = answer.probabilities;
    if (!probs || typeof probs !== 'object' || Array.isArray(probs)) {
      throw new Error('主分类答案缺 probabilities 对象');
    }
    const distribution: Record<string, number> = {};
    for (const [key, value] of Object.entries(probs)) {
      if (keyMap[key] === undefined) continue; // 模型编造的选项键不进分布
      distribution[key] = prob(value, `主分类概率「${key}」`);
    }
    if (Object.keys(distribution).length === 0) throw new Error('主分类 probabilities 没有任何请求过的选项');

    const top = Math.max(...Object.values(distribution));
    const notes: string[] = [`最高概率 ${top.toFixed(2)}`];
    if (meta.textOnlyForImageItem) notes.push('纯文本供应商未看图，不定案');
    else if (top < thresholds.primaryMin) notes.push('低于主分类门槛，未定案');
    else primaryDecided = true;

    primary = {
      source: 'decision',
      categoryId: pickedId,
      name: pickedCat ? pickedCat.name : PRIMARY_OTHER_NAME,
      distribution,
      evidence: `${base}；${notes.join('；')}`,
      effective: false,
    };
  }

  return { results, decided, primary, primaryDecided };
}
