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
  /** 已渲染的标题（图文帖规则的推送词产物）；缺省「显示名 @账号 发布新推文」 */
  title?: string;
  /**
   * 已本地化的图片路径（X 图必须经代理下载成**本地文件**再传：NapCat 在同一个墙内
   * 网络里拉不到 pbs.twimg.com，`file://` 才是它真能取到的形态）。有图的帖全图都传；
   * 缺省/空数组 = 无图（下载全失败的兜底）。
   */
  images?: string[];
  /** LLM 译文（规则开了翻译且调用成功时才有）；拼在正文下方，带「【译】」标记 */
  translation?: string | null;
}

/**
 * 图文帖 → 推送层通用载荷（X / 微博 / B站动态共用）。不用 emoji（同 liveEventToMessage：
 * QQ iOS 气泡渲染器会把增补平面 emoji 拆成方框）。正文为空（纯图帖）时给一句占位，
 * 别让 QQ 里出现空消息。
 *
 * 结构（QQ 渠道拼出来）：「显示名 @账号 发布新X」标题行 / 正文 / 全部图片 / 时间 / 链接。
 * 作者已进标题、多图全推，attribution 只留时间一行（toast 的小灰字行）。
 * 平台差异只在文案：X 的作者是「显示名 @screen_name」（无显示名回退 @screen_name），
 * 微博 / B站动态用展示名（uid 对人没有意义，只作兜底）；「发布新X」后缀按平台映射。
 * 这里刻意不 import analysis/matcher 的 `postAuthorName`——`sources / analysis / notify`
 * 互不 import 是依赖方向纪律，为一行字符串不值得破坏它（`PostCandidate` 只作类型引用，运行时被擦除）。
 */

/** 「发布新X」的名词后缀 */
const POST_NOUN: Record<PostCandidate['platform'], string> = {
  twitter: '推文',
  weibo: '微博',
  bili_dynamic: '动态',
};

export function postToMessage(input: PostMessageInput): PushMessage {
  const { post } = input;
  const when = post.pubTs > 0
    ? new Date(post.pubTs * 1000).toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      })
    : '';
  const text = (post.text ?? '').trim() || '（仅图片，无正文）';
  const translation = input.translation?.trim();
  const author = post.platform === 'twitter'
    ? (post.displayName ? `${post.displayName} @${post.screenName}` : `@${post.screenName}`)
    : (post.displayName || post.screenName);
  const images = input.images?.length ? input.images : undefined;
  return {
    title: input.title?.trim() || `${author} 发布新${POST_NOUN[post.platform]}`,
    body: translation ? `${text}\n\n【译】${translation}` : text,
    image: images?.[0],
    images,
    attribution: when || undefined,
    url: post.url ?? undefined,
    priority: 'normal',
  };
}
