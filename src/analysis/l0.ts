import type { Scene, SceneVerdict } from './types.js';

/** 标题关键词命中的固定置信度：确定性规则的判定，故意低于将来的 LLM */
export const L0_TITLE_CONFIDENCE = 0.6;
/** 仅靠分区弱信号的置信度（分区是先验不是真相，挂网游区唱歌很常见） */
export const L0_AREA_CONFIDENCE = 0.4;

export interface L0Input {
  title: string;
  areaName: string;
  parentAreaName: string;
}

interface SceneRule {
  scene: Scene;
  keywords: string[];
}

/**
 * 标题关键词词典。数组顺序即优先级：多类命中取靠前的
 * （唱歌 > 演出 > 游戏 > 杂谈——「周年 3D 回顺便打把游戏」这类标题，
 * 常识上观众更关心演出/唱歌）。匹配是大小写不敏感子串。
 * 词典故意保持小，按误判记录逐步扩充，不求一次收全。
 */
const TITLE_RULES: SceneRule[] = [
  { scene: 'singing', keywords: ['歌回', '歌枠', '唱歌', '点歌', '歌杂', '练歌', '歌会'] },
  { scene: 'show', keywords: ['周年', '生日', '纪念', '3D', '演唱会', '新衣', '出道'] },
  {
    scene: 'gaming',
    keywords: ['打游戏', '联机', '排位', '上分', '无畏契约', '瓦罗兰特', '原神', '英雄联盟', '王者荣耀', 'APEX'],
  },
  { scene: 'chatting', keywords: ['杂谈', '唠嗑', '聊天', '电台'] },
];

/** 分区弱信号：只收强指向的（虚拟Gamer 几乎不会拿来唱歌），拿不准的不放 */
const AREA_RULES: Array<{ areaName: string; scene: Scene }> = [
  { areaName: '虚拟Gamer', scene: 'gaming' },
  { areaName: '虚拟Singer', scene: 'singing' },
];

/**
 * L0 确定性分类器：标题/分区关键词 → SceneVerdict。
 * 产出与 LLM Analyzer 完全同形，是分析队列返回 null（LLM 缺席）时的兜底，
 * 也是将来 LLM 的上游替代位——下游（matcher/rules/notify）不感知来源。
 * 无法判断时返回 null，由调用方决定怎么办（通常是走默认行为）。
 */
export function classifyL0(input: L0Input): SceneVerdict | null {
  const title = input.title.toLowerCase();
  for (const rule of TITLE_RULES) {
    const hits = rule.keywords.filter((k) => title.includes(k.toLowerCase()));
    if (hits.length > 0) {
      return {
        scene: rule.scene,
        confidence: L0_TITLE_CONFIDENCE,
        evidence: hits.map((k) => `标题含「${k}」`),
      };
    }
  }

  // 标题无命中时才看分区，且置信度更低
  const area = AREA_RULES.find((r) => r.areaName === input.areaName);
  if (area) {
    return {
      scene: area.scene,
      confidence: L0_AREA_CONFIDENCE,
      evidence: [`分区「${area.areaName}」`],
    };
  }
  return null;
}
