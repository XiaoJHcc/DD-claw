/**
 * ContentItem 内容项抽象：直播场次与图文帖的统一投影。
 * 分类判定与 LLM prompt 构造只吃它（判决链的统一输入面）；
 * 输入面自带图，但只吃**判定前已规范化**的基线 JPEG data URL（见 image-prep），
 * 图床远程 URL 绝不进这里——两个判定通道共用同一份视觉输入。
 */
import { liveVerdictSubjectId, postVerdictSubjectId } from '../core/push.js';
import type { LiveEvent } from '../core/types.js';
// 与 matcher.ts 互相引用（matcher 的 matchCategory 用 fromLiveEvent 投影）：
// 两侧都是函数级使用、无模块顶层互调，ESM 循环安全
import { postAuthorName, type PostCandidate } from './matcher.js';

export interface ContentItem {
  /** 内容主体类型：直播场次 / 图文帖 */
  subjectType: 'live' | 'post';
  /** 判决身份键（与 verdicts.subject_id 同形）：live=`room:liveTime` / post=`platform:itemId` */
  subjectId: string;
  /** 直播主播 uid / 图文账号标识 */
  uid: string;
  /** 展示名：直播 uname（缺省回退简称）/ 图文作者 */
  authorName: string;
  /** 直播标题 / 帖子正文 */
  text: string;
  /** 内容标签：live=area/parentArea；post=type/isQuote/hasMedia/platform */
  tags: Record<string, string>;
  /** 视觉输入：已规范化的 JPEG data URL（直播关键帧 / 图文配图；可空 = 无图或全被拦） */
  imageUrls: string[];
  /** 直播间链接 / 帖子链接 */
  url: string;
  /** 内容时间戳（秒）：live=场次 liveTime / post=帖子 pubTs */
  ts: number;
}

/**
 * LiveEvent → 内容项投影（分类判定 / LLM prompt 构造的直播输入面）。
 * 关键帧 / 封面在这里只是「哪张图的来源」，实际喂给模型的图片由 pipeline 先落本地、
 * 再经 image-prep 规范化成 data URL 传进来；不传 = 无图（远程 URL 绝不回流）。
 */
export function fromLiveEvent(event: LiveEvent, imageDataUrls?: string[]): ContentItem {
  return {
    subjectType: 'live',
    subjectId: liveVerdictSubjectId(event.roomId, event.liveTime),
    uid: event.uid,
    authorName: event.uname || event.alias,
    text: event.title,
    tags: { area: event.areaName, parentArea: event.parentAreaName },
    imageUrls: imageDataUrls ?? [],
    url: event.roomUrl,
    ts: event.liveTime,
  };
}

/**
 * PostCandidate → 内容项投影。type 在投影时折叠成 original/retweet——
 * matcher「转发只认 type==='retweet'，其余一律原创」的语义在这里归一。
 * imageDataUrls = 配图规范化后的 data URL（与帖子自带的图床 URL 不同）。
 */
export function fromPostCandidate(post: PostCandidate, imageDataUrls?: string[]): ContentItem {
  return {
    subjectType: 'post',
    subjectId: postVerdictSubjectId(post.platform, post.itemId ?? ''),
    uid: post.screenName,
    authorName: postAuthorName(post),
    text: post.text ?? '',
    tags: {
      type: post.type === 'retweet' ? 'retweet' : 'original',
      // 三态保留（未知 ≠ 明确否）：X 免登录回退之外的来源不标引用
      isQuote: post.isQuote === undefined ? 'unknown' : String(post.isQuote),
      hasMedia: String(post.pics.length > 0),
      platform: post.platform,
    },
    imageUrls: imageDataUrls ?? [],
    url: post.url ?? '',
    ts: post.pubTs,
  };
}
