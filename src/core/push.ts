/**
 * push_channels / push_rules / settings 三表的行类型与「行 ↔ 对象」映射。
 * 类型与 JSON 字段的序列化集中在这里，同 streamers.ts 惯例；
 * 表结构见 db.ts SCHEMA 与 design.md。
 */
import type { Db } from './db.js';

// ---- push_channels：推送渠道（面板统一管理，主播规则只引用 id）----

export type ChannelNotifier = 'toast' | 'onebot';
export type ChannelTargetType = 'group' | 'private';

export interface PushChannelRow {
  id: number;
  name: string;
  notifier: ChannelNotifier;
  target_type: ChannelTargetType | null;
  target_id: string | null;
  enabled: number;
  /** 面板拖拽排序（展示顺序）；行对象不暴露，排序是列表内部实现 */
  sort: number;
  created_at: number;
  updated_at: number;
}

export interface PushChannel {
  id: number;
  /** 用户起的名，如「粉丝群」 */
  name: string;
  notifier: ChannelNotifier;
  /** toast 为 null */
  targetType: ChannelTargetType | null;
  /** QQ号/群号，toast 为 null */
  targetId: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type NewPushChannel = Omit<PushChannel, 'id' | 'createdAt' | 'updatedAt'>;
/** upsert 输入：带 id 且存在 = 改行（未提供字段保留原值）；否则建行（缺省取默认值） */
export type PushChannelInput = Partial<NewPushChannel> & { id?: number };

export function rowToChannel(r: PushChannelRow): PushChannel {
  return {
    id: r.id, name: r.name, notifier: r.notifier,
    targetType: r.target_type, targetId: r.target_id,
    enabled: r.enabled === 1,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// ---- settings：推送总开关 ----

export function isPushEnabled(db: Db): boolean {
  return db.getSetting('push_enabled') !== '0';
}

export function setPushEnabled(db: Db, enabled: boolean): void {
  db.setSetting('push_enabled', enabled ? '1' : '0');
}

// ---- push_rules：透明条件规则（属于某个主播，sort 升序第一条命中生效）----

export interface PushRuleRow {
  id: number;
  uid: string;
  /** 规则名称（面板列表展示）；存量为空时迁移补「规则 <id>」 */
  name: string;
  keywords: string;
  areas: string;
  channels: string;
  message_template: string | null;
  enabled: number;
  /** 同 uid 内 = 匹配优先级（面板拖拽排序）；行对象不暴露 */
  sort: number;
  created_at: number;
  updated_at: number;
}

export interface PushRule {
  id: number;
  /** 属于哪个主播 */
  uid: string;
  /** 规则名称（面板列表展示） */
  name: string;
  /** 标题子串，任一命中（大小写不敏感）；空 = 不限制 */
  keywords: string[];
  /** 分区子串（areaName / parentAreaName 都匹配），任一命中；空 = 不限制 */
  areas: string[];
  /** 引用 push_channels.id */
  channels: number[];
  /** null = 用全局默认模板 */
  messageTemplate: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type NewPushRule = Omit<PushRule, 'id' | 'createdAt' | 'updatedAt'>;
export type PushRuleInput = Partial<NewPushRule> & { id?: number };

export function rowToRule(r: PushRuleRow): PushRule {
  return {
    id: r.id, uid: r.uid, name: r.name,
    keywords: JSON.parse(r.keywords) as string[],
    areas: JSON.parse(r.areas) as string[],
    channels: JSON.parse(r.channels) as number[],
    messageTemplate: r.message_template,
    enabled: r.enabled === 1,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
