/**
 * 有界并发 map。并发跑但不超过 limit 个在飞。
 *
 * 为什么不用 Promise.all：多主播同时开播时，N 个推送全部瞬时打向 NapCat
 * 会撞群聊 20 条/分钟一类的限流。为什么不串行：那样第 N 条通知要等前
 * N-1 条 HTTP 往返完成，延迟线性累积。
 *
 * 单个任务抛错不影响其他任务，结果里对应位置为 undefined。
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<R | undefined>> {
  const results = new Array<R | undefined>(items.length);
  if (items.length === 0) return results;

  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i]!, i);
      } catch {
        results[i] = undefined;
      }
    }
  };

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

export function createLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    await new Promise<void>((resolve) => {
      const start = () => { active++; resolve(); };
      if (active < limit) start();
      else waiting.push(start);
    });
    try { return await task(); }
    finally { active--; waiting.shift()?.(); }
  };
}
