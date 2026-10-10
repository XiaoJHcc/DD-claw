/**
 * 「逗号分隔列表」输入的唯一解析口径：中英文逗号都是分隔符，去空白、去空项。
 * 面板输入框（关键词 / 分区 / Nitter 实例 / LLM key）、MCP 参数、CLI 列表参数统一走这里，
 * 别处不得再手写 split(',')——否则又会出现「这个框认中文逗号、那个框不认」。
 */

/** 逗号分隔文本 → 数组（null/空白安全） */
export function splitCsvText(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
}

/** 写库前归一：中文逗号 → 英文逗号（settings 里保持规范形态；读侧仍容忍存量中文逗号值） */
export function normalizeCsvText(raw: string): string {
  return raw.replace(/，/g, ',');
}
