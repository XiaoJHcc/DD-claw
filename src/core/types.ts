// 仅类型导入，编译期擦除，不构成运行时循环依赖
import type { Classification } from '../analysis/types.js';

/**
 * 平台无关的直播间状态。core 层只认识它；各平台 source 把自己的原始类型
 * 归一化成它（如 bili 的 RoomStatus 是它的扩展，多带一个 rawLiveStatus）。
 */
export interface LiveStatus {
  uid: string;
  roomId: string;
  uname: string;
  title: string;
  /** 已折叠平台特异语义（如 bili 轮播(2) 视为未开播） */
  isLive: boolean;
  /** 本场开播时间戳（秒），未开播为 0。是一场直播的身份 */
  liveTime: number;
  areaName: string;
  parentAreaName: string;
  cover: string;
  keyframe: string;
  /** 主播头像 URL（平台无关、匿名可得；拿不到时缺省） */
  face?: string;
  /** 直播间在线人数（平台无关、匿名可得；拿不到时缺省） */
  online?: number;
}

export type SignalKind =
  | 'live_start' | 'live_end' | 'title_change' // live-status source 真实产生
  | 'feed_post' | 'danmaku_batch' | 'snapshot' // 预留：动态/弹幕/画面
  | 'health_alert';                            // 监听自身健康

export interface Signal {
  /** 产出方标识，如 'bili/live-status' */
  source: string;
  kind: SignalKind;
  uid: string;
  roomId: string;
  ts: number;
  /** live 系信号携带：live_start / title_change 为当前状态，live_end 为最后已知状态 */
  status?: LiveStatus;
  /** title_change（标题/分区内容变更）专用：旧标题 */
  previousTitle?: string;
  /** title_change 专用：分区变了时带上旧分区 */
  previousAreaName?: string;
  /**
   * 冷启动来源。source 只标记，抑制策略在 pipeline：
   * - first_run：整轮首次运行（库中无历史状态），启动时已在播
   * - new_subscription：新增订阅时正在直播（运行期，可能值得通知）
   * - restart_recovery：上次下播、本次启动前开播（重启恢复，无法得知真实开播时间）
   */
  coldStart?: 'first_run' | 'new_subscription' | 'restart_recovery';
  /** 各 source 自定义载荷（如 health_alert 的失败详情） */
  payload?: unknown;
}

/**
 * health_alert 的 QQ 告警政策（pipeline 判定，见 core/pipeline）：
 * - payload.alertKind === 'login_drop'：运行中登录态意外失效 → 立即向告警 QQ 报
 * - payload.durationAlert === true：故障持续满本阈值后 source 再发一次 → 向告警 QQ 报
 * 其余 health_alert（本地 toast 阈值、看门狗）只发本机 toast。告警 QQ 为空 = 全不发。
 * 两级阈值都是时间口径（2026-11 统一）：toast 级 = settings `health_alert_toast_after_sec`
 * （默认 180s），QQ 级 = 本常量；同一根时间轴上的两个点，顺序永不倒挂。
 */
export const STREAK_QQ_ALERT_AFTER_SEC = 600;

/** 推送用的事件载荷。live_start 信号的 classifications 由分析队列填充（其余信号恒空）。 */
export interface LiveEvent {
  platform: 'bilibili';
  uid: string;
  roomId: string;
  uname: string;
  alias: string;
  title: string;
  areaName: string;
  parentAreaName: string;
  keyframe: string;
  cover: string;
  roomUrl: string;
  liveTime: number;
  /** 主播头像 URL（来自 LiveStatus.face；刚开播没有关键帧时推送用它兜底） */
  face?: string;
  /** 本场直播的分类判定结果（LLM 或确定性规则路径）；无分类/未判定为空数组 */
  classifications: Classification[];
}

export function toLiveEvent(status: LiveStatus, alias: string): LiveEvent {
  return {
    platform: 'bilibili',
    uid: status.uid,
    roomId: status.roomId,
    uname: status.uname,
    alias,
    title: status.title,
    areaName: status.areaName,
    parentAreaName: status.parentAreaName,
    keyframe: status.keyframe,
    cover: status.cover,
    roomUrl: `https://live.bilibili.com/${status.roomId}`,
    liveTime: status.liveTime,
    face: status.face,
    classifications: [],
  };
}

export interface PushTarget {
  type: 'group' | 'private';
  id: string;
}

/** 推送层的通用载荷。notify 不认识 LiveEvent，只认识 PushMessage。 */
export interface PushMessage {
  title: string;
  body: string;
  image?: string;
  /** 多图（图文帖全图推送）。存在时优先于 image；toast 等单图通道取第一张 */
  images?: string[];
  /** 小图标（主播头像）。toast 显示在左侧（appLogoOverride），刚开播无关键帧时仍有图 */
  icon?: string;
  /** 辅助说明小字（toast attribution 那行灰字；其他通道自行拼进正文） */
  attribution?: string;
  /** 点击跳转 */
  url?: string;
  priority: 'high' | 'normal' | 'low';
  /** 缺省 = 各通道用配置的默认目标 */
  targets?: PushTarget[];
  /** 引用 push_channels 表的渠道 id（字符串）。存在时 dispatcher 按渠道路由；缺省 = 兼容旧行为全通道发 */
  channels?: string[];
  /** notify_log 溯源：对应的直播场次。非直播类消息缺省。 */
  ref?: { roomId: string; liveTime: number };
}
