/**
 * 一次性迁移命令（npm run migrate:snapshots-path）：把 snapshots.path 从旧版绝对路径
 * 改写为相对 keyframe 目录的 <roomId>/<liveTime>/<ts>.ext。做完即退出，不进主流程。
 *
 * 为什么存在：旧版 keyframe.ts 落库时直接存了拼好的绝对路径（<dir>/<roomId>/<liveTime>/<ts>.ext），
 * 换机/移动 data 目录后旧盘符失效。修正后的代码只写相对路径，本命令负责把存量库一次到位。
 * 迁移幂等：已相对的行不动，可反复跑。跑完每台机器一次即可，之后无需再迁移。
 *
 * migrateSnapshotPaths 导出供测试；入口守卫保证仅作为 CLI 运行时执行 main。
 */
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/index.js';
import { makeLogger } from '../logger.js';

const log = makeLogger('migrate/snapshots-path');

/** 库里的 path resolve 后必须是相对（<roomId>/<liveTime>/<ts>.ext）或旧绝对路径 */
export function migrateSnapshotPaths(db: Database.Database): number {
  const rows = db.prepare('SELECT id, room_id, live_time, path FROM snapshots').all() as
    Array<{ id: number; room_id: string; live_time: number; path: string }>;
  if (rows.length === 0) return 0;
  const stmt = db.prepare('UPDATE snapshots SET path = ? WHERE id = ?');
  let changed = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      // 已经是相对路径（<roomId>/<liveTime>/<ts>.ext）的行不动
      if (!/^[A-Za-z]:[\\/]/.test(r.path) && !r.path.startsWith('/')) continue;
      // 文件名 = 路径最后一段（兼容 / 与 \ 分隔）；相对形式按库内列重建，与 keyframe.ts 落盘一致
      const name = r.path.split(/[\\/]/).pop() ?? '';
      if (!name) continue;
      stmt.run(join(r.room_id, String(r.live_time), name), r.id);
      changed++;
    }
  });
  tx();
  return changed;
}

function main(): void {
  const { secrets } = loadConfig();
  const db = new Database(secrets.dbPath);
  try {
    const rows = db.prepare('SELECT COUNT(*) AS c FROM snapshots').get() as { c: number };
    if (rows.c === 0) {
      log.info(`snapshots 表为空（${secrets.dbPath}），无需迁移`);
      return;
    }
    const changed = migrateSnapshotPaths(db);
    log.info(`snapshots.path 迁移完成：${changed} 行改写为相对路径（${secrets.dbPath}）`);
  } finally {
    db.close();
  }
}

// 入口守卫：仅当作为 CLI 直接运行时执行 main（测试导入 migrateSnapshotPaths 不触发）
const isDirectRun = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url).replace(/\\/g, '/') === process.argv[1].replace(/\\/g, '/');
if (isDirectRun) main();
