import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchPushRule, renderTemplate } from './matcher.js';
import type { LiveEvent } from '../core/types.js';
import type { PushRule } from '../core/push.js';

function rule(over: Partial<PushRule> = {}): PushRule {
  return {
    id: 1, uid: 'u1', keywords: [], areas: [], channels: [],
    messageTemplate: null, enabled: true, createdAt: 0, updatedAt: 0,
    ...over,
  };
}

function event(over: Partial<LiveEvent> = {}): LiveEvent {
  return {
    platform: 'bilibili', uid: 'u1', roomId: 'r1', uname: '主播1', alias: '阿梓',
    title: '标题', areaName: '虚拟Gamer', parentAreaName: '虚拟主播', keyframe: 'k.jpg', cover: '',
    roomUrl: 'https://live.bilibili.com/r1', liveTime: 1_785_310_737, verdict: null,
    ...over,
  };
}

// ---- matchPushRule ----

test('关键词：标题大小写不敏感子串，任一命中', () => {
  const r = rule({ keywords: ['APEX', '歌回'] });
  assert.equal(matchPushRule([r], event({ title: '今晚 apex 上分' })), r);
  assert.equal(matchPushRule([r], event({ title: '生日歌回！' })), r);
  assert.equal(matchPushRule([r], event({ title: '随便播播' })), null);
});

test('分区：areaName 与 parentAreaName 任一字段子串命中', () => {
  const byArea = rule({ areas: ['gamer'] });
  assert.equal(matchPushRule([byArea], event()), byArea, 'areaName 命中（大小写不敏感）');
  const byParent = rule({ areas: ['虚拟主播'] });
  assert.equal(matchPushRule([byParent], event()), byParent, 'parentAreaName 命中');
  const miss = rule({ areas: ['网游'] });
  assert.equal(matchPushRule([miss], event()), null);
});

test('关键词和分区都填 = AND：只满足一个不命中', () => {
  const r = rule({ keywords: ['歌'], areas: ['虚拟主播'] });
  assert.equal(matchPushRule([r], event({ title: '歌回' })), r, '都满足才命中');
  assert.equal(matchPushRule([r], event({ title: '打游戏' })), null, '缺关键词');
  assert.equal(
    matchPushRule([r], event({ title: '歌回', areaName: '网游', parentAreaName: '电子竞技' })),
    null, '缺分区',
  );
});

test('空条件 = 默认规则，恒命中', () => {
  const r = rule();
  assert.equal(matchPushRule([r], event({ title: '任何东西' })), r);
});

test('条件规则按顺序第一条命中优先', () => {
  const first = rule({ id: 1, keywords: ['歌'] });
  const second = rule({ id: 2, keywords: ['歌'] });
  assert.equal(matchPushRule([first, second], event({ title: '歌回' })), first);
});

test('默认规则最后兜底：即使 id 更小也不挡条件规则', () => {
  const def = rule({ id: 1 });
  const cond = rule({ id: 2, keywords: ['歌'] });
  assert.equal(matchPushRule([def, cond], event({ title: '歌回' })), cond, '条件规则命中优先');
  assert.equal(matchPushRule([def, cond], event({ title: '打游戏' })), def, '条件规则不命中落默认');
});

test('全不命中且无默认规则 → null', () => {
  const r = rule({ keywords: ['歌'] });
  assert.equal(matchPushRule([r], event({ title: '打游戏' })), null);
  assert.equal(matchPushRule([], event()), null);
});

// ---- renderTemplate ----

test('模板变量 {alias} {uname} {title} 渲染', () => {
  assert.equal(
    renderTemplate('{alias}唱歌速来｜{uname}｜{title}', event({ title: '今晚歌回' })),
    '阿梓唱歌速来｜主播1｜今晚歌回',
  );
});

test('alias 为空时 {alias} 回退 uname', () => {
  assert.equal(renderTemplate('{alias}开播', event({ alias: '' })), '主播1开播');
});
