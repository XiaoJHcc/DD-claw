import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OncePerSessionRule, type PreviousSession, type SessionStore } from './once-per-session.js';
import type { LiveEvent, Signal, SignalKind } from '../core/types.js';

function store(notified: Set<string> = new Set(), chain: PreviousSession[] = []): SessionStore {
  return {
    hasNotified: (r, t) => notified.has(`${r}:${t}`),
    recentSessionsBefore: () => chain,
  };
}

function event(over: Partial<LiveEvent> = {}): LiveEvent {
  return {
    platform: 'bilibili', uid: '7706705', roomId: '80397',
    uname: '阿梓从小就很可爱', alias: '阿梓', title: '孩子们下午好',
    areaName: '无畏契约', parentAreaName: '网游', keyframe: 'k.jpg', cover: '',
    roomUrl: 'https://live.bilibili.com/80397', liveTime: 1_785_310_737, classifications: [],
    ...over,
  };
}

function signal(kind: SignalKind = 'live_start', ts = 0): Signal {
  return { source: 'live-status', kind, uid: '7706705', roomId: '80397', ts, status: {} as never };
}

function session(over: Partial<PreviousSession> = {}): PreviousSession {
  return {
    liveTime: 1_785_310_737, title: '孩子们下午好',
    firstSeen: 40, endSeen: 100, notifiedAt: 1_785_310_800,
    ...over,
  };
}

test('首次开播允许推送', async () => {
  const r = new OncePerSessionRule(store());
  const d = await r.decide(event(), signal(), []);
  assert.equal(d.shouldNotify, true);
});

test('同一场第二次调用不推', async () => {
  const r = new OncePerSessionRule(store(new Set(['80397:1785310737'])));
  const d = await r.decide(event(), signal(), []);
  assert.equal(d.shouldNotify, false);
  assert.match(d.reason, /已推送过/);
});

test('liveTime 变了视为新的一场，允许推送', async () => {
  const r = new OncePerSessionRule(store(new Set(['80397:1785310737'])));
  const d = await r.decide(event({ liveTime: 1_785_400_000 }), signal(), []);
  assert.equal(d.shouldNotify, true);
});

test('M1 忽略 live_end 与 title_change', async () => {
  const r = new OncePerSessionRule(store());
  for (const kind of ['live_end', 'title_change'] as SignalKind[]) {
    const d = await r.decide(event(), signal(kind), []);
    assert.equal(d.shouldNotify, false, kind);
  }
});

test('liveTime 缺失时保守不推', async () => {
  const r = new OncePerSessionRule(store());
  const d = await r.decide(event({ liveTime: 0 }), signal(), []);
  assert.equal(d.shouldNotify, false);
});

test('classifications 为空数组不影响判定', async () => {
  const r = new OncePerSessionRule(store());
  assert.equal((await r.decide(event(), signal(), [])).shouldNotify, true);
});

test('平台重发 liveTime 且同轮替换：上一场已推、标题未变、未观测到下播 → 同场重连不推', async () => {
  const r = new OncePerSessionRule(store(new Set(['80397:1785310737']), [session()]));
  const d = await r.decide(event({ liveTime: 1_785_400_000 }), signal('live_start', 100), []);
  assert.equal(d.shouldNotify, false);
  assert.match(d.reason, /重连/);
});

test('连续多次同轮替换：回溯到最早已推送的那场，仍然只算同一条直播', async () => {
  const chain = [
    session({ liveTime: 1_785_320_000, firstSeen: 200, endSeen: 300, notifiedAt: null }),
    session({ liveTime: 1_785_310_737, firstSeen: 40, endSeen: 200, notifiedAt: 1_785_310_800 }),
  ];
  const r = new OncePerSessionRule(
    store(new Set(['80397:1785310737']), chain),
  );
  const d = await r.decide(event({ liveTime: 1_785_400_000 }), signal('live_start', 300), []);
  assert.equal(d.shouldNotify, false);
  assert.match(d.reason, /liveTime 1785310737→1785400000/);
});

test('回溯链中断（有一场观测到了下播）：不是重连，照常推', async () => {
  const chain = [
    session({ liveTime: 1_785_320_000, firstSeen: 200, endSeen: 300, notifiedAt: null }),
    session({ liveTime: 1_785_310_737, firstSeen: 40, endSeen: 150, notifiedAt: 1_785_310_800 }),
  ];
  const r = new OncePerSessionRule(store(new Set(), chain));
  const d = await r.decide(event({ liveTime: 1_785_400_000 }), signal('live_start', 300), []);
  assert.equal(d.shouldNotify, true);
});

test('上一场在更早的轮询里已观测到下播：不是重连，照常推', async () => {
  const r = new OncePerSessionRule(store(new Set(['80397:1785310737']), [
    session({ endSeen: 90 }),
  ]));
  const d = await r.decide(event({ liveTime: 1_785_400_000 }), signal('live_start', 100), []);
  assert.equal(d.shouldNotify, true);
});

test('重连但标题变了：按新内容推', async () => {
  const r = new OncePerSessionRule(store(new Set(['80397:1785310737']), [session()]));
  const d = await r.decide(event({ liveTime: 1_785_400_000, title: '来打游戏' }), signal('live_start', 100), []);
  assert.equal(d.shouldNotify, true);
});

test('上一场没推送过：即使同轮替换也照常推（本轮是这条直播的第一次通知）', async () => {
  const r = new OncePerSessionRule(store(new Set(), [session({ notifiedAt: null })]));
  const d = await r.decide(event({ liveTime: 1_785_400_000 }), signal('live_start', 100), []);
  assert.equal(d.shouldNotify, true);
});

test('标题为空时不判断连续性，照常推', async () => {
  const r = new OncePerSessionRule(store(new Set(['80397:1785310737']), [
    session({ title: '' }),
  ]));
  const d = await r.decide(event({ liveTime: 1_785_400_000, title: '' }), signal('live_start', 100), []);
  assert.equal(d.shouldNotify, true);
});
