import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bus } from '../core/bus.js';
import { LiveClassifyTriggers, type LiveTriggerTimers } from './triggers.js';
import type { LiveStatus, Signal } from '../core/types.js';

function status(over: Partial<LiveStatus> = {}): LiveStatus {
  return {
    uid: '1', roomId: 'r1', uname: '主播1', title: '今晚歌回！',
    isLive: true, liveTime: 1_785_310_737, areaName: '虚拟Singer', parentAreaName: '虚拟主播',
    cover: '', keyframe: 'k.jpg', ...over,
  };
}

/** 可控假时钟：advance 按到期顺序推进并同步执行到点的回调（不真等 5 分钟） */
class FakeClock {
  nowMs = 0;
  private seq = 0;
  private readonly tasks = new Map<number, { at: number; fn: () => void }>();
  readonly timers: LiveTriggerTimers = {
    set: (fn, ms) => {
      const id = ++this.seq;
      this.tasks.set(id, { at: this.nowMs + ms, fn });
      return id;
    },
    clear: (handle) => { this.tasks.delete(handle as number); },
  };

  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.tasks.delete(due[0]);
      this.nowMs = due[1].at;
      due[1].fn();
    }
    this.nowMs = target;
  }

  pending(): number { return this.tasks.size; }
}

function harness(opts: { delaySec?: number; periodicSec?: number } = {}) {
  const bus = new Bus();
  const clock = new FakeClock();
  const emitted: Signal[] = [];
  bus.on('live_reclassify', (s) => { emitted.push(s); });
  let delaySec = opts.delaySec ?? 300;
  let periodicSec = opts.periodicSec ?? 1200;
  const triggers = new LiveClassifyTriggers({
    bus,
    delaySec: () => delaySec,
    periodicSec: () => periodicSec,
    timers: clock.timers,
    now: () => Math.floor(clock.nowMs / 1000),
  });
  triggers.attach();
  return {
    bus, clock, emitted, triggers,
    setDelay: (sec: number) => { delaySec = sec; },
    setPeriodic: (sec: number) => { periodicSec = sec; },
    emittedTriggers: () => emitted.map((s) => (s.payload as { trigger: string }).trigger),
  };
}

function liveSig(over: Partial<Signal> & { over?: Partial<LiveStatus> } = {}): Signal {
  const { over: statusOver, ...rest } = over;
  return {
    source: 'bili/live-status', kind: 'live_start', uid: '1', roomId: 'r1', ts: 0,
    status: status(statusOver), ...rest,
  };
}

// ---- 开播延迟与直播中定时 ----

test('startDelay 到点发 live_reclassify；periodic 按周期重复（都不在开播瞬间触发）', () => {
  const h = harness();
  h.bus.emit(liveSig());
  assert.deepEqual(h.emittedTriggers(), [], '开播瞬间不判定，等计时器');
  h.clock.advance(299_000);
  assert.deepEqual(h.emittedTriggers(), [], '延迟未到不发');
  h.clock.advance(1_000);
  assert.deepEqual(h.emittedTriggers(), ['startDelay']);
  assert.equal(h.emitted[0]!.status?.title, '今晚歌回！', '信号带最后一次观测到的快照');

  assert.deepEqual(h.emittedTriggers(), ['startDelay']);
  h.clock.advance(1_200_000);
  assert.deepEqual(h.emittedTriggers(), ['startDelay', 'periodic'], '周期从观察到该场起算');
  h.clock.advance(1_200_000);
  assert.deepEqual(h.emittedTriggers(), ['startDelay', 'periodic', 'periodic'], '每周期一次');
});

test('重复 live_start 更新快照但不重置已有定时器；新 liveTime 才是新场', () => {
  const h = harness();
  h.bus.emit(liveSig());
  h.clock.advance(200_000);
  h.bus.emit(liveSig({ over: { title: '改过的标题' } }));
  h.clock.advance(100_000);
  assert.deepEqual(h.emittedTriggers(), ['startDelay'], '重复开播不重置延迟计时器');
  assert.equal(h.emitted[0]!.status?.title, '改过的标题', '快照用最新的');

  // 新一场：旧场的计时器清掉，新场重新计时
  h.bus.emit(liveSig({ over: { liveTime: 1_785_999_999 } }));
  assert.equal(h.triggers.tracked().length, 1, '同房间只跟踪最新一场');
  h.clock.advance(300_000);
  assert.deepEqual(h.emittedTriggers(), ['startDelay', 'startDelay']);
  assert.equal(h.emitted[1]!.status?.liveTime, 1_785_999_999);
});

test('冷启动恢复的场次不排 startDelay（开播早已发生），周期照排', () => {
  const h = harness();
  h.bus.emit(liveSig({ coldStart: 'restart_recovery' }));
  h.clock.advance(300_000);
  assert.deepEqual(h.emittedTriggers(), [], '不补延迟判定');
  h.clock.advance(900_000);
  assert.deepEqual(h.emittedTriggers(), ['periodic']);
});

// ---- 标题/分区变更防抖 ----

test('连续 title_change 以最后一次重新计时（防抖），只判一次', () => {
  const h = harness();
  const delays = () => h.emittedTriggers().filter((t) => t === 'titleDelay');
  h.bus.emit(liveSig());
  h.bus.emit(liveSig({ kind: 'title_change', over: { title: '换歌' } }));
  h.clock.advance(200_000);
  h.bus.emit(liveSig({ kind: 'title_change', over: { title: '再换' } }));
  h.clock.advance(200_000);
  assert.deepEqual(delays(), [], '第一次的计时器已被重置');
  h.clock.advance(100_000);
  assert.deepEqual(delays(), ['titleDelay'], '自最后一次变更起满延迟才判');
  h.clock.advance(600_000);
  assert.deepEqual(delays(), ['titleDelay'], '一次变更只判一次');
  const fired = h.emitted.find((s) => (s.payload as { trigger: string }).trigger === 'titleDelay');
  assert.equal(fired?.status?.title, '再换');
});

test('未跟踪的场次（本进程没看到开播）不为 title_change 排延迟判定', () => {
  const h = harness();
  h.bus.emit(liveSig({ kind: 'title_change' }));
  h.clock.advance(600_000);
  assert.deepEqual(h.emittedTriggers(), [], '没有开播锚点就不做变更延迟');
});

// ---- 结束与清理 ----

test('live_end 清该房间全部计时器（延迟、变更、周期都不再触发）', () => {
  const h = harness();
  h.bus.emit(liveSig());
  h.bus.emit(liveSig({ kind: 'title_change' }));
  assert.equal(h.clock.pending(), 3, '延迟 + 变更 + 周期三个计时器');
  h.bus.emit({ source: 'bili/live-status', kind: 'live_end', uid: '1', roomId: 'r1', ts: 10 });
  assert.equal(h.clock.pending(), 0, '下播即清空');
  h.clock.advance(2_000_000);
  assert.deepEqual(h.emittedTriggers(), []);
  assert.deepEqual(h.triggers.tracked(), []);
});

test('stop() 清空全部计时器并停止响应后续信号', () => {
  const h = harness();
  h.bus.emit(liveSig());
  h.triggers.stop();
  assert.equal(h.clock.pending(), 0);
  h.bus.emit(liveSig({ over: { roomId: 'r2', liveTime: 2 } }));
  assert.equal(h.clock.pending(), 0, '停止后不再排计时器');
});

// ---- 运行参数热更新 ----

test('reconfigure({ periodic }) 只按新周期重排周期计时器，延迟计时器不动', () => {
  const h = harness({ delaySec: 300, periodicSec: 1200 });
  h.bus.emit(liveSig());
  h.clock.advance(100_000);
  h.setPeriodic(60);
  h.triggers.reconfigure({ periodic: true, delay: false });
  h.clock.advance(60_000); // t = 160s
  assert.deepEqual(h.emittedTriggers(), ['periodic'], '新周期从重排时刻起算');
  h.clock.advance(139_000); // t = 299s
  assert.ok(!h.emittedTriggers().includes('startDelay'), '延迟不因周期重排而提前');
  h.clock.advance(1_000); // t = 300s
  assert.ok(h.emittedTriggers().includes('startDelay'), '延迟仍按原间隔（开播后 300s）到点');
});

test('reconfigure({ delay }) 把尚未触发的开播延迟按新值重排（已触发的不再补排）', () => {
  const h = harness({ delaySec: 300, periodicSec: 1200 });
  h.bus.emit(liveSig());
  h.clock.advance(120_000);
  h.setDelay(60);
  h.triggers.reconfigure({ delay: true, periodic: false });
  h.clock.advance(59_000);
  assert.deepEqual(h.emittedTriggers(), [], '旧值 300s 不该再生效');
  h.clock.advance(1_000);
  assert.deepEqual(h.emittedTriggers(), ['startDelay'], '改后 60s 即触发');

  // 已经触发过的场次：再改延迟不会补排一次
  h.setDelay(30);
  h.triggers.reconfigure({ delay: true, periodic: false });
  h.clock.advance(300_000);
  assert.deepEqual(h.emittedTriggers(), ['startDelay'], '延迟时机一场只触发一次');
});

test('reconfigure({ delay }) 让正在等待的变更延迟按新值重新计时（防抖窗口从此刻起算）', () => {
  const h = harness({ delaySec: 300, periodicSec: 1_000_000 });
  h.bus.emit(liveSig());
  h.bus.emit(liveSig({ kind: 'title_change', over: { title: '换歌' } }));
  h.clock.advance(200_000);
  h.setDelay(90);
  h.triggers.reconfigure({ delay: true, periodic: false });
  h.clock.advance(89_000);
  assert.deepEqual(h.emittedTriggers().filter((t) => t === 'titleDelay'), [], '旧的 300s 窗口已被重置');
  h.clock.advance(1_000);
  assert.deepEqual(h.emittedTriggers().filter((t) => t === 'titleDelay'), ['titleDelay'], '新窗口 90s 到点');
});

test('reconfigure() 无参调用两项都重排（兼容旧调用）', () => {
  const h = harness({ delaySec: 300, periodicSec: 1200 });
  h.bus.emit(liveSig());
  h.clock.advance(100_000);
  h.setDelay(120);
  h.setPeriodic(60);
  h.triggers.reconfigure();
  h.clock.advance(60_000); // t = 160s
  assert.deepEqual(h.emittedTriggers(), ['periodic'], '周期按新值从重排时刻起算');
  h.clock.advance(59_000); // t = 219s
  assert.ok(!h.emittedTriggers().includes('startDelay'), '新延迟 120s 尚未到点');
  h.clock.advance(1_000); // t = 220s
  assert.ok(h.emittedTriggers().includes('startDelay'), '延迟按新值从重排时刻起算');
});
