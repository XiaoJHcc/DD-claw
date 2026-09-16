import type { LiveEvent, PushMessage } from '../core/types.js';
import type { PostCandidate } from '../analysis/matcher.js';

/**
 * LiveEvent → 推送层通用载荷。notify 各通道只认识 PushMessage。
 * 文案沿用 M1：who 开播了 / 标题（不用 emoji：QQ iOS 气泡渲染器会把增补平面
 * emoji 拆成两个方框）；推送文案一律用原名（uname 优先，缺省回退简称）；
 * 分区 · 开播时间放 attribution（toast 的小灰字行，
 * onebot 拼进正文第三行）；头像进 icon（刚开播还没有关键帧，用头像保证通知有图）。
 */
export function liveEventToMessage(e: LiveEvent): PushMessage {
  const who = e.uname || e.alias;
  const area = e.parentAreaName && e.areaName
    ? `${e.parentAreaName} / ${e.areaName}`
    : e.areaName || e.parentAreaName || '未知分区';
  const when = e.liveTime > 0
    ? new Date(e.liveTime * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : '';
  return {
    title: `${who} 开播了`,
    body: e.title,
    image: e.keyframe || undefined,
    icon: e.face || undefined,
    attribution: area + (when ? `  ·  ${when} 开播` : ''),
    url: e.roomUrl,
    priority: 'normal',
    ref: { roomId: e.roomId, liveTime: e.liveTime },
  };
}

export interface PostMessageInput {
  post: PostCandidate;
  /** 已渲染的标题（图文帖规则的推送词产物）；缺省「@账号 发了新推文」 */
  title?: string;
  /**
   * 已本地化的图片路径（X 图必须经代理下载成**本地文件**再传：NapCat 在同一个墙内
   * 网络里拉不到 pbs.twimg.com，`file://` 才是它真能取到的形态）。缺省 = 无图。
   */
  image?: string;
}

/**
 * 推文 → 推送层通用载荷。不用 emoji（同 liveEventToMessage：QQ iOS 气泡渲染器会把
 * 增补平面 emoji 拆成方框）。正文为空（纯图推文）时给一句占位，别让 QQ 里出现空消息。
 */
export function postToMessage(input: PostMessageInput): PushMessage {
  const { post } = input;
  const when = post.pubTs > 0
    ? new Date(post.pubTs * 1000).toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      })
    : '';
  const extra = post.pics.length > 1 ? `  ·  共 ${post.pics.length} 张图` : '';
  return {
    title: input.title?.trim() || `@${post.screenName} 发了新推文`,
    body: (post.text ?? '').trim() || '（仅图片，无正文）',
    image: input.image,
    attribution: `X  ·  @${post.screenName}` + (when ? `  ·  ${when}` : '') + extra,
    url: post.url ?? undefined,
    priority: 'normal',
  };
}
