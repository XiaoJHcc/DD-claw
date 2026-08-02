import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeMessage, matchClauses } from './matcher.js';
import type { LiveEvent } from '../core/types.js';
import type { PreferenceClause } from '../core/streamers.js';
import type { SceneVerdict } from './types.js';

function clause(over: Partial<PreferenceClause> = {}): PreferenceClause {
  return {
    id: 1, uid: 'u1', scenes: [], minConfidence: null, titleKeywords: [],
    priority: 'normal', messageTemplate: '{alias}来了', targets: null,
    enabled: true, createdAt: 0, updatedAt: 0,
    ...over,
  };
}

function event(over: Partial<LiveEvent> = {}): LiveEvent {
  return {
    platform: 'bilibili', uid: 'u1', roomId: 'r1', uname: '主播1', alias: '阿梓',
    title: '标题', areaName: '', parentAreaName: '', keyframe: 'k.jpg', cover: '',
    roomUrl: 'https://live.bilibili.com/r1', liveTime: 1_785_310_737, verdict: null,
    ...over,
  };
}

const singing = (confidence = 0.9): SceneVerdict => ({ scene: 'singing', confidence, evidence: [] });

// ---- matchClauses ----

test('scenes 命中且置信度达标 → 命中', () => {
  const c = clause({ scenes: ['singing'] });
  assert.equal(matchClauses([c], event(), singing()), c);
});

test('scenes 子句在 verdict 为 null 时不命中', () => {
  const c = clause({ scenes: ['singing'] });
  assert.equal(matchClauses([c], event(), null), null);
});

test('置信度门槛：低于 minConfidence 不命中，minConfidence 缺省视为 0', () => {
  const gated = clause({ scenes: ['singing'], minConfidence: 0.8 });
  assert.equal(matchClauses([gated], event(), singing(0.6)), null);
  assert.equal(matchClauses([gated], event(), singing(0.8)), gated);
  const open = clause({ scenes: ['singing'] });
  assert.equal(matchClauses([open], event(), singing(0.1)), open);
});

test('titleKeywords 大小写不敏感命中任一即可，verdict 为 null 也可命中', () => {
  const c = clause({ titleKeywords: ['APEX', '歌'] });
  assert.equal(matchClauses([c], event({ title: '今晚 apex 上分' }), null), c);
  assert.equal(matchClauses([c], event({ title: '随便播播' }), singing()), null);
});

test('scenes 与 titleKeywords 同时非空时是 AND：只满足一个不命中', () => {
  const c = clause({ scenes: ['singing'], titleKeywords: ['歌'] });
  assert.equal(matchClauses([c], event({ title: '歌回' }), null), null, '缺 verdict');
  assert.equal(matchClauses([c], event({ title: '打游戏' }), singing()), null, '缺标题关键词');
  assert.equal(matchClauses([c], event({ title: '歌回' }), singing()), c, '都满足才命中');
});

test('两个条件都空 = 兜底子句，恒命中（含 verdict 为 null）', () => {
  const c = clause();
  assert.equal(matchClauses([c], event(), null), c);
  assert.equal(matchClauses([c], event(), singing()), c);
});

test('uid 不匹配不命中', () => {
  const c = clause({ uid: 'other' });
  assert.equal(matchClauses([c], event(), singing()), null);
});

test('多条命中取优先级高者，同级取 id 小者', () => {
  const low = clause({ id: 1, priority: 'low' });
  const high = clause({ id: 2, priority: 'high' });
  const normal = clause({ id: 3, priority: 'normal' });
  assert.equal(matchClauses([low, high, normal], event(), null), high);

  const first = clause({ id: 1 });
  const second = clause({ id: 2 });
  assert.equal(matchClauses([second, first], event(), null), first);
});

// ---- composeMessage ----

test('模板变量 {alias} {uname} {title} 渲染', () => {
  const c = clause({ messageTemplate: '{alias}唱歌速来｜{uname}｜{title}' });
  const m = composeMessage(c, event({ title: '今晚歌回' }), '阿梓');
  assert.equal(m.title, '阿梓唱歌速来｜主播1｜今晚歌回');
});

test('alias 为空时 {alias} 回退 uname', () => {
  const c = clause({ messageTemplate: '{alias}开播' });
  assert.equal(composeMessage(c, event(), '').title, '主播1开播');
});

test('targets 透传；null 时缺省（通道用默认目标）', () => {
  const targets = [{ type: 'group' as const, id: '12345' }];
  const m = composeMessage(clause({ targets }), event(), '阿梓');
  assert.deepEqual(m.targets, targets);
  assert.equal(composeMessage(clause(), event(), '阿梓').targets, undefined);
});

test('优先级/图片/跳转/ref 组装沿用默认消息形状', () => {
  const m = composeMessage(clause({ priority: 'high' }), event(), '阿梓');
  assert.equal(m.priority, 'high');
  assert.equal(m.image, 'k.jpg');
  assert.equal(m.url, 'https://live.bilibili.com/r1');
  assert.deepEqual(m.ref, { roomId: 'r1', liveTime: 1_785_310_737 });
});
