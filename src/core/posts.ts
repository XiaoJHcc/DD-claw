/**
 * posts 表（动态/微博时间线归档）的行类型与「行 ↔ 对象」映射。
 * 类型与 JSON 字段（pics）的序列化集中在这里，同 streamers.ts / push.ts 惯例；
 * 表结构见 db.ts SCHEMA。
 *
 * 设计哲学：原始数据全留（raw），供 LLM 反复分析；去重只靠 (platform, item_id)
 * UNIQUE，不用时间戳（编辑/置顶会让时间戳不稳定，见 docs/research/feeds.md）。
 */

export interface PostRow {
  id: number;
  platform: string;
  uid: string;
  item_id: string;
  type: string;
  text: string | null;
  pics: string;
  pub_ts: number;
  url: string | null;
  raw: string | null;
  created_at: number;
}

export interface Post {
  id: number;
  /** 'bili_dynamic' | 'weibo'（预留） */
  platform: string;
  /** 作者 uid（字符串，跨平台一致用字符串） */
  uid: string;
  /** 平台全局唯一 id（B站 id_str / 微博 bid），去重靠它 */
  itemId: string;
  /** 平台原始类型，如 DYNAMIC_TYPE_WORD */
  type: string;
  /** 正文（转发拼「//转发自 @xx」摘要） */
  text: string | null;
  /** 图片 URL 列表 */
  pics: string[];
  /** 发布时间（秒级时间戳） */
  pubTs: number;
  /** 前端点击打开的链接 */
  url: string | null;
  /** 原始 JSON 归档（整 item） */
  raw: string | null;
  createdAt: number;
}

export type NewPost = Omit<Post, 'id' | 'createdAt'>;

export function rowToPost(r: PostRow): Post {
  return {
    id: r.id,
    platform: r.platform,
    uid: r.uid,
    itemId: r.item_id,
    type: r.type,
    text: r.text,
    pics: JSON.parse(r.pics) as string[],
    pubTs: r.pub_ts,
    url: r.url,
    raw: r.raw,
    createdAt: r.created_at,
  };
}
