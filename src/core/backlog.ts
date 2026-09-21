/**
 * 图文帖「缺口轮」的补推语义（X / 微博 / B站动态三源共用；2026-09-21 拍板，
 * 与直播冷启动开关 notify_on_first_run 同族的产品决策）。
 *
 * 一个账号的每轮抓取按三种轮次之一处理：
 *
 *  · resume（主动关闭恢复轮）：账号停用→重新启用、或图文开关手动关→手动开。
 *    用户主动说过「这段时间别推」，恢复后**一律静默归档、永不补推**——
 *    由账号表 `silent_next` 置位（重新启用在 db upsert、开关重开在 setListen），
 *    源读到即静默并顺手清位。
 *
 *  · gap（缺口轮）：本源实例对这个账号的第一轮——进程重启/崩溃/登录态丢失恢复、
 *    源热重启、或刚添加账号后的首拉。期间新帖**默认也不推**；用户开了
 *    backlog_push_enabled 才补推，且双重封顶：时间窗内（默认 6h）+ 每账号最多
 *    N 条（默认 3，取最新）——停一周积压上百条旧帖在启动时一口气轰炸是不合理的，
 *    哪怕开关开着。
 *
 *  · normal（正常轮）：新帖照常全推，不经过本模块。
 *
 * 归档永不缺席：三种轮次都先 insertPosts（面板可见），差别只在发不发 feed_post。
 */

/** 轮次判定：resume > gap > normal（主动关闭恢复的静默优先于一切） */
export function roundKind(silentNext: boolean, firstRound: boolean): 'resume' | 'gap' | 'normal' {
  if (silentNext) return 'resume';
  return firstRound ? 'gap' : 'normal';
}

export interface BacklogCandidate {
  /** 发布时间（Unix 秒）。pubTs 缺失（0）按窗外处理：时间未知的帖只归档不补推 */
  pubTs: number;
}

export interface BacklogWindow {
  maxAgeSec: number;
  maxPerAccount: number;
}

/**
 * 从缺口轮新入库的帖子里挑出允许补推的下标：
 * 时间窗外丢掉，窗内取最新 maxPerAccount 条，按发布时间从旧到新返回
 * （群里的阅读顺序应该是时间正序）。返回空数组 = 本轮全部静默。
 */
export function pickBacklogPush<T extends BacklogCandidate>(
  posts: readonly T[],
  insertedIdx: readonly number[],
  win: BacklogWindow,
  nowSec: number,
): number[] {
  const minTs = nowSec - win.maxAgeSec;
  const fresh = insertedIdx.filter((i) => posts[i]!.pubTs >= minTs);
  const newest = fresh
    .sort((a, b) => posts[b]!.pubTs - posts[a]!.pubTs)
    .slice(0, win.maxPerAccount);
  return newest.sort((a, b) => posts[a]!.pubTs - posts[b]!.pubTs);
}
