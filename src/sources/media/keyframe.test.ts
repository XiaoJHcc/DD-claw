import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../../core/db.js';
import { KeyframeCache } from './keyframe.js';
const INTERVAL_MS = 300_000;

/** 构造假的 fetch Response（只需 ok/status/arrayBuffer/headers 四件套） */
function fakeFetch(status: number, body: Buffer | null, contentType = 'image/jpeg'): typeof fetch {
  return (() => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: () => Promise.resolve(body ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : new ArrayBuffer(0)),
    headers: new Headers({ 'content-type': contentType }),
  })) as unknown as typeof fetch;
}

interface Fixture {
  db: Db;
  cache: KeyframeCache;
  dir: string;      // 落盘根目录
  dbPath: string;
  setNow: (ms: number) => void;
}

/** 真实 Db（tmp 文件库）+ 可注入 now/fetch 的 cache；t.after 先关库再删目录（Windows 文件锁） */
function setup(t: import('node:test').TestContext, fetchImpl: typeof fetch): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'ddclaw-keyframe-'));
  const dbPath = join(root, 'test.db');
  const db = new Db(dbPath);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  let fakeNow = 1_800_000_000_000;
  const cache = new KeyframeCache(db, {
    dir: join(root, 'kf'),
    intervalMs: INTERVAL_MS,
    fetchImpl,
    now: () => fakeNow,
  });
  return { db, cache, dir: join(root, 'kf'), dbPath, setNow: (ms) => { fakeNow = ms; } };
}

const LIVE = { roomId: '80397', liveTime: 1000, keyframe: 'https://i0.hdslb.com/kf.jpg' };

/** 直读 snapshots 表（无查询方法，素材检索后续做；测试用第二连接验证落库内容） */
function snapshotRows(dbPath: string): Array<{ room_id: string; live_time: number; ts: number; path: string; bytes: number }> {
  const raw = new Database(dbPath, { readonly: true });
  const rows = raw
    .prepare('SELECT room_id, live_time, ts, path, bytes FROM snapshots ORDER BY id')
    .all() as Array<{ room_id: string; live_time: number; ts: number; path: string; bytes: number }>;
  raw.close();
  return rows;
}

function filesOf(fx: Fixture, roomId = LIVE.roomId, liveTime = LIVE.liveTime): string[] {
  const d = join(fx.dir, roomId, String(liveTime));
  return existsSync(d) ? readdirSync(d) : [];
}

test('首场立即缓存：文件落在 <dir>/<roomId>/<liveTime>/ 且 snapshots 表有一行', async (t) => {
  const body = Buffer.from('fake-keyframe-jpg');
  const fx = setup(t, fakeFetch(200, body));
  fx.setNow(1_800_000_000_000);

  fx.cache.consider([LIVE]);
  await fx.cache.drain();

  const files = filesOf(fx);
  assert.equal(files.length, 1);
  assert.equal(files[0], '1800000000.jpg'); // <ts>.jpg
  const rows = snapshotRows(fx.dbPath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.room_id, '80397');
  assert.equal(rows[0]!.live_time, 1000);
  assert.equal(rows[0]!.ts, 1_800_000_000);
  // 落库 path 必须是相对 keyframe 目录的相对路径（<roomId>/<liveTime>/<ts>.ext）且分隔符
  // 恒为正斜杠——join() 在 Windows 会落反斜杠，换机后 resolve 当普通字符全 404（历史事故）
  assert.equal(rows[0]!.path, '80397/1000/1800000000.jpg');
  assert.equal(rows[0]!.bytes, body.length);
});

test('间隔门控：interval 内重复 consider 不再下载，越过 interval 再下载', async (t) => {
  let calls = 0;
  const counting = (async (url: unknown, init: unknown) => {
    calls++;
    return (fakeFetch(200, Buffer.from('x')) as unknown as (u: unknown, i: unknown) => Promise<unknown>)(url, init);
  }) as unknown as typeof fetch;
  const fx = setup(t, counting);
  fx.setNow(1_800_000_000_000);
  fx.cache.consider([LIVE]);
  await fx.cache.drain();
  fx.cache.consider([LIVE]); // interval 内
  await fx.cache.drain();
  assert.equal(calls, 1);

  fx.setNow(1_800_000_000_000 + INTERVAL_MS - 1000); // 仍未到
  fx.cache.consider([LIVE]);
  await fx.cache.drain();
  assert.equal(calls, 1);

  fx.setNow(1_800_000_000_000 + INTERVAL_MS); // 到点
  fx.cache.consider([LIVE]);
  await fx.cache.drain();
  assert.equal(calls, 2);
});

test('keyframe 空串跳过', async (t) => {
  let calls = 0;
  const counting = (async () => { calls++; throw new Error('不应被调用'); }) as unknown as typeof fetch;
  const fx = setup(t, counting);
  fx.cache.consider([{ ...LIVE, keyframe: '' }]);
  await fx.cache.drain();
  assert.equal(calls, 0);
  assert.equal(filesOf(fx).length, 0);
});

test('下载失败（抛错 / 非 ok / 超 10MB）：不写盘不入库，interval 内不重试', async (t) => {
  for (const [name, impl] of [
    ['抛错', (() => Promise.reject(new Error('boom'))) as unknown as typeof fetch],
    ['非 ok', fakeFetch(503, null)],
    ['超 10MB', fakeFetch(200, Buffer.alloc(10 * 1024 * 1024 + 1))],
  ] as Array<[string, typeof fetch]>) {
    let calls = 0;
    const counting = (async (url: unknown, init: unknown) => {
      calls++;
      return (impl as unknown as (u: unknown, i: unknown) => Promise<unknown>)(url, init);
    }) as unknown as typeof fetch;
    const fx = setup(t, counting);
    fx.setNow(1_800_000_000_000);
    fx.cache.consider([LIVE]);
    await fx.cache.drain();
    fx.cache.consider([LIVE]); // interval 内：失败也记了尝试时间，不重试
    await fx.cache.drain();
    assert.equal(calls, 1, `${name} 场景 interval 内不应重试`);
    assert.equal(filesOf(fx).length, 0, `${name} 场景不应写盘`);
    assert.equal(snapshotRows(fx.dbPath).length, 0, `${name} 场景不应入库`);
  }
});

test('内容去重：相同字节只落一个文件一条库行；不同字节各落一份', async (t) => {
  const body1 = Buffer.from('frame-v1');
  const body2 = Buffer.from('frame-v2-different');
  let body = body1;
  const changing = (async () => {
    return {
      ok: true, status: 200,
      arrayBuffer: () => Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)),
      headers: new Headers({ 'content-type': 'image/jpeg' }),
    };
  }) as unknown as typeof fetch;
  const fx = setup(t, changing);

  fx.setNow(1_800_000_000_000);
  fx.cache.consider([LIVE]);
  await fx.cache.drain();
  fx.setNow(1_800_000_000_000 + INTERVAL_MS);
  fx.cache.consider([LIVE]); // 内容相同 → 丢弃不写盘
  await fx.cache.drain();
  assert.equal(filesOf(fx).length, 1);
  assert.equal(snapshotRows(fx.dbPath).length, 1);

  body = body2;
  fx.setNow(1_800_000_000_000 + INTERVAL_MS * 2);
  fx.cache.consider([LIVE]); // 内容变了 → 新文件新库行
  await fx.cache.drain();
  assert.equal(filesOf(fx).length, 2);
  const rows = snapshotRows(fx.dbPath);
  assert.equal(rows.length, 2);
  assert.equal(rows[1]!.bytes, body2.length);
});

test('consider 不阻塞：返回时下载未完成也不抛，完成后正常落盘', async (t) => {
  let resolveFetch!: (v: unknown) => void;
  const deferred = (() => new Promise((r) => { resolveFetch = r; })) as unknown as typeof fetch;
  const fx = setup(t, deferred);
  fx.setNow(1_800_000_000_000);

  fx.cache.consider([LIVE]); // 同步返回，不 await 下载
  await new Promise((r) => setImmediate(r)); // 让在飞链启动 fetch（promise 仍悬置）
  assert.equal(filesOf(fx).length, 0, '返回时下载尚未完成');

  resolveFetch({
    ok: true, status: 200,
    arrayBuffer: () => Promise.resolve(Buffer.from('late-frame').buffer),
    headers: new Headers({ 'content-type': 'image/jpeg' }),
  });
  await fx.cache.drain();
  assert.equal(filesOf(fx).length, 1);
  assert.equal(snapshotRows(fx.dbPath).length, 1);
});

test('configure：enabled=false 时 consider no-op，重开不炸量', async (t) => {
  let calls = 0;
  const counting = (async (url: unknown, init: unknown) => {
    calls++;
    return (fakeFetch(200, Buffer.from('x')) as unknown as (u: unknown, i: unknown) => Promise<unknown>)(url, init);
  }) as unknown as typeof fetch;
  const fx = setup(t, counting);
  fx.setNow(1_800_000_000_000);
  fx.cache.configure({ enabled: false, intervalMs: INTERVAL_MS });

  fx.cache.consider([LIVE]); // 关闭：no-op，也不记尝试时间
  await fx.cache.drain();
  assert.equal(calls, 0);
  assert.equal(filesOf(fx).length, 0);
  assert.equal(snapshotRows(fx.dbPath).length, 0);

  fx.cache.configure({ enabled: true, intervalMs: INTERVAL_MS }); // 重开：按既有记忆继续
  fx.cache.consider([LIVE]); // 首场立即缓存（关闭期没记尝试，不算炸量）
  await fx.cache.drain();
  assert.equal(calls, 1);
  assert.equal(filesOf(fx).length, 1);
});

test('configure：intervalMs 热改立即生效', async (t) => {
  let calls = 0;
  const counting = (async (url: unknown, init: unknown) => {
    calls++;
    return (fakeFetch(200, Buffer.from('x')) as unknown as (u: unknown, i: unknown) => Promise<unknown>)(url, init);
  }) as unknown as typeof fetch;
  const fx = setup(t, counting);
  fx.setNow(1_800_000_000_000);
  fx.cache.consider([LIVE]);
  await fx.cache.drain();
  assert.equal(calls, 1);

  fx.cache.configure({ enabled: true, intervalMs: 60_000 }); // 300s → 60s
  fx.setNow(1_800_000_000_000 + 60_000); // 按新间隔已到期（旧间隔远未到）
  fx.cache.consider([LIVE]);
  await fx.cache.drain();
  assert.equal(calls, 2, '新间隔生效：60s 后即再次下载');
});
