/**
 * QQ 自助入口（P3 NapCat 直连）的 settings 契约——**settings 表是唯一信源**（项目纪律），
 * 三个键都在这里读写，别处不再各写一份：
 *
 * | 键 | 形状 | 缺省 | 说明 |
 * |---|---|---|---|
 * | `qqbot_enabled` | `'1'`/`'0'` | 关（非 '1' 一律关） | 总开关；关时装配根**不挂** `/onebot` 事件路由 |
 * | `qq_channel_map` | JSON `{"group:123456":2,"private:789":3}` | 空 | 会话键 → `push_channels.id`；**查不到 = 拒绝服务**，绝不回落默认渠道 |
 * | `qqbot_trigger_prefix` | 字符串 | `'dd'` | 群聊唤起前缀；显式空串 = 只靠 @机器人 |
 *
 * 映射没有 UI（v1 决定，plan 也把「渠道映射编辑」列在「待定/后续」）：主人直接写 settings，
 * 一条命令见 docs/modules/qqbot.md；渠道 id 用面板（或 `list_channels`）查。
 */
import type { Db } from '../core/db.js';

export const QQBOT_ENABLED_KEY = 'qqbot_enabled';
export const QQ_CHANNEL_MAP_KEY = 'qq_channel_map';
export const QQ_TRIGGER_PREFIX_KEY = 'qqbot_trigger_prefix';

/**
 * 缺省唤起前缀。不带尾随空格是刻意的：中文群聊里「dd加一下栞栞」远比「dd 加一下」常见，
 * 前缀后是否紧跟 ASCII 字母/数字才是真边界（见 `matchTriggerPrefix`）。
 */
export const DEFAULT_TRIGGER_PREFIX = 'dd';

/** 总开关：只有显式 '1' 才算开（缺省关——QQ 入口是暴露面，必须主人主动开） */
export function isQqbotEnabled(db: Db): boolean {
  return db.getSetting(QQBOT_ENABLED_KEY) === '1';
}

export function setQqbotEnabled(db: Db, enabled: boolean): void {
  db.setSetting(QQBOT_ENABLED_KEY, enabled ? '1' : '0');
}

/** 唤起前缀：没配过用缺省；显式空串 = 关掉前缀触发（只留 @机器人 与私聊直通） */
export function getTriggerPrefix(db: Db): string {
  const v = db.getSetting(QQ_TRIGGER_PREFIX_KEY);
  return v === null ? DEFAULT_TRIGGER_PREFIX : v.trim();
}

/**
 * 前缀匹配（大小写不敏感）：
 * - 前缀后紧跟 ASCII 字母/数字 → **不算触发**（`dddd` 只是长得像，不是「dd 命令」）；
 * - 前缀后是中文/空白/标点/结尾 → 触发（`dd加主播` / `dd 加主播` / `dd` 都算）。
 * 返回 null = 没触发；返回字符串 = 触发且已剥掉前缀的正文（可能为空 = 只喊了一声）。
 */
export function matchTriggerPrefix(text: string, prefix: string): string | null {
  const p = prefix.trim().toLowerCase();
  if (p === '') return null;
  const t = text.toLowerCase();
  if (!t.startsWith(p)) return null;
  const next = t.charAt(p.length);
  if (next !== '' && /[a-z0-9]/.test(next)) return null;
  return text.slice(p.length).trim();
}

/**
 * 会话键 → 渠道 id。坏 JSON / 形状不对的条目**静默丢弃**（与 `mcp_tokens` 同容错口径：
 * settings 由人/工具写，容错优先；宁可「这个群没开通」也不要因一条脏数据整体报废）。
 * 值必须是正整数——渠道 id 就是 `push_channels.id`。
 */
export function parseChannelMap(raw: string | null): Map<string, number> {
  const out = new Map<string, number>();
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return out;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) out.set(key, value);
  }
  return out;
}

export function listChannelMap(db: Db): Map<string, number> {
  return parseChannelMap(db.getSetting(QQ_CHANNEL_MAP_KEY));
}

/** 查不到 = undefined：调用方必须**拒绝服务**（渠道隔离第 1 条），绝不回落默认渠道 */
export function channelIdForConversation(db: Db, conversationKey: string): number | undefined {
  return listChannelMap(db).get(conversationKey);
}

/** 写映射（v1 没有 UI，供 admin 侧工具/脚本调用；整体覆写 settings 的 JSON） */
export function saveChannelMap(db: Db, map: Record<string, number>): void {
  db.setSetting(QQ_CHANNEL_MAP_KEY, JSON.stringify(map));
}

/** 会话键必须是 `group:<数字>` / `private:<数字>`（写映射时校验，避免手写脏键） */
export function isValidConversationKey(key: string): boolean {
  return /^(group|private):\d+$/.test(key);
}