import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OncePerSessionRule, type SessionStore } from './once-per-session.js';
import type { LiveEvent, Signal, SignalKind } from '../core/types.js';

function store(notified: Set<string> = new Set()): SessionStore {
  return { hasNotified: (r, t) => notified.has(`${r}:${t}`) };
}

function event(over: Partial<LiveEvent> = {}): LiveEvent {
  return {
    platform: 'bilibili', uid: '7706705', roomId: '80397',
    uname: '阿梓从小就很可爱', alias: '阿梓', title: '孩子们下午好',
    areaName: '无畏契约', parentAreaName: '网游', keyframe: 'k.jpg', cover: '',
    roomUrl: 'https://live.bilibili.com/80397', liveTime: 1_785_310_737, verdict: null,
    ...over,
  };
}

function signal(kind: SignalKind = 'live_start'): Signal {
  return { source: 'live-status', kind, uid: '7706705', roomId: '80397', ts: 0, status: {} as never };
}

test('首次开播允许推送', async () => {
  const r = new OncePerSessionRule(store());
  const d = await r.decide(event(), signal(), null);
  assert.equal(d.shouldNotify, true);
});

test('同一场第二次调用不推', async () => {
  const r = new OncePerSessionRule(store(new Set(['80397:1785310737'])));
  const d = await r.decide(event(), signal(), null);
  assert.equal(d.shouldNotify, false);
  assert.match(d.reason, /已推送过/);
});

test('liveTime 变了视为新的一场，允许推送', async () => {
  const r = new OncePerSessionRule(store(new Set(['80397:1785310737'])));
  const d = await r.decide(event({ liveTime: 1_785_400_000 }), signal(), null);
  assert.equal(d.shouldNotify, true);
});

test('M1 忽略 live_end 与 title_change', async () => {
  const r = new OncePerSessionRule(store());
  for (const kind of ['live_end', 'title_change'] as SignalKind[]) {
    const d = await r.decide(event(), signal(kind), null);
    assert.equal(d.shouldNotify, false, kind);
  }
});

test('liveTime 缺失时保守不推', async () => {
  const r = new OncePerSessionRule(store());
  const d = await r.decide(event({ liveTime: 0 }), signal(), null);
  assert.equal(d.shouldNotify, false);
});

test('verdict 为 null 不影响判定（M1 接缝约定）', async () => {
  const r = new OncePerSessionRule(store());
  assert.equal((await r.decide(event(), signal(), null)).shouldNotify, true);
});
