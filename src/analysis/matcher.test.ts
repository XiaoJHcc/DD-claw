import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchCategory, matchPushRules, renderTemplate } from './matcher.js';
import type { LiveEvent } from '../core/types.js';
import type { Category, PushRule } from '../core/push.js';

function category(over: Partial<Category> = {}): Category {
  return {
    id: 1, name: '歌回', llmPrompt: null, keywords: [], areas: [],
    condMode: 'and', enabled: true, createdAt: 0, updatedAt: 0,
    ...over,
  };
}

function rule(over: Partial<PushRule> = {}): PushRule {
  return {
    id: 1, name: '规则 1', categoryId: null, uids: [], channels: [],
    messageTemplate: null, enabled: true, createdAt: 0, updatedAt: 0,
    ...over,
  };
}

function event(over: Partial<LiveEvent> = {}): LiveEvent {
  return {
    platform: 'bilibili', uid: 'u1', roomId: 'r1', uname: '主播1', alias: '阿梓',
    title: '标题', areaName: '虚拟Gamer', parentAreaName: '虚拟主播', keyframe: 'k.jpg', cover: '',
    roomUrl: 'https://live.bilibili.com/r1', liveTime: 1_785_310_737, classifications: [],
    ...over,
  };
}

// ---- matchCategory ----

test('关键词组：标题大小写不敏感子串，任一命中', () => {
  const c = category({ keywords: ['APEX', '歌回'] });
  assert.equal(matchCategory(c, event({ title: '今晚 apex 上分' })).matched, true);
  assert.equal(matchCategory(c, event({ title: '生日歌回！' })).matched, true);
  assert.equal(matchCategory(c, event({ title: '随便播播' })).matched, false);
});

test('分区组：areaName 与 parentAreaName 任一字段子串命中', () => {
  const byArea = category({ areas: ['gamer'] });
  assert.equal(matchCategory(byArea, event()).matched, true, 'areaName 命中（大小写不敏感）');
  const byParent = category({ areas: ['虚拟主播'] });
  assert.equal(matchCategory(byParent, event()).matched, true, 'parentAreaName 命中');
  assert.equal(matchCategory(category({ areas: ['网游'] }), event()).matched, false);
});

test('condMode=and：两组都填需都中，只满足一个不命中', () => {
  const c = category({ keywords: ['歌'], areas: ['虚拟主播'], condMode: 'and' });
  assert.equal(matchCategory(c, event({ title: '歌回' })).matched, true, '都满足才命中');
  assert.equal(matchCategory(c, event({ title: '打游戏' })).matched, false, '缺关键词');
  assert.equal(
    matchCategory(c, event({ title: '歌回', areaName: '网游', parentAreaName: '电子竞技' })).matched,
    false, '缺分区',
  );
});

test('condMode=or：任一组命中即中', () => {
  const c = category({ keywords: ['歌'], areas: ['网游'], condMode: 'or' });
  assert.equal(matchCategory(c, event({ title: '歌回' })).matched, true, '关键词命中即可');
  assert.equal(
    matchCategory(c, event({ title: '打游戏', areaName: '网游' })).matched, true, '分区命中即可',
  );
  assert.equal(matchCategory(c, event({ title: '随便播播' })).matched, false, '都不中');
});

test('空组忽略：只剩一组时按该组判（与 condMode 无关）', () => {
  const onlyKeywords = category({ keywords: ['歌'], condMode: 'and' });
  assert.equal(matchCategory(onlyKeywords, event({ title: '歌回' })).matched, true);
  const onlyAreas = category({ areas: ['虚拟主播'], condMode: 'or' });
  assert.equal(matchCategory(onlyAreas, event({ title: '随便播播' })).matched, true);
  assert.equal(matchCategory(onlyAreas, event({ areaName: '网游', parentAreaName: '电子竞技' })).matched, false);
});

test('两组皆空 → 不命中（纯 LLM 分类不被确定性路径误判恒中）', () => {
  const empty = category({ keywords: [], areas: [] });
  const r = matchCategory(empty, event({ title: '任何东西' }));
  assert.equal(r.matched, false);
  assert.equal(r.evidence, '');
});

test('evidence 记录命中词，未命中为空串', () => {
  const c = category({ keywords: ['歌'], areas: ['gamer'], condMode: 'or' });
  const both = matchCategory(c, event({ title: '今晚歌回' }));
  assert.equal(both.matched, true);
  assert.equal(both.evidence, '命中关键词「歌」、分区「gamer」');
  assert.equal(matchCategory(c, event({ title: '不相关', areaName: '网游', parentAreaName: '电子竞技' })).evidence, '');
});

// ---- matchPushRules v2 ----

test('categoryId 为 null = 任意开播都命中', () => {
  const any = rule({ categoryId: null });
  assert.deepEqual(matchPushRules([any], event(), new Set()), [any], '无分类判定也命中');
  assert.deepEqual(matchPushRules([any], event(), new Set([1])), [any]);
});

test('categoryId 非空 = 该场须判定属于此分类', () => {
  const r = rule({ categoryId: 7 });
  assert.deepEqual(matchPushRules([r], event(), new Set([7])), [r]);
  assert.deepEqual(matchPushRules([r], event(), new Set([1, 2])), [], '不在判定集合里不命中');
  assert.deepEqual(matchPushRules([r], event(), new Set()), []);
});

test('uids 空 = 全部主播（含未来新增）；非空 = 仅名单内', () => {
  const all = rule({ uids: [] });
  assert.deepEqual(matchPushRules([all], event({ uid: '任何人' }), new Set()), [all]);
  const some = rule({ uids: ['u1', 'u2'] });
  assert.deepEqual(matchPushRules([some], event({ uid: 'u2' }), new Set()), [some]);
  assert.deepEqual(matchPushRules([some], event({ uid: 'u3' }), new Set()), []);
});

test('分类与主播两个条件 AND：只满足一个不命中', () => {
  const r = rule({ categoryId: 7, uids: ['u1'] });
  assert.deepEqual(matchPushRules([r], event({ uid: 'u1' }), new Set([7])), [r]);
  assert.deepEqual(matchPushRules([r], event({ uid: 'u1' }), new Set()), [], '分类不满足');
  assert.deepEqual(matchPushRules([r], event({ uid: 'u9' }), new Set([7])), [], '主播不满足');
});

test('多条规则全部命中都返回，保持传入顺序', () => {
  const first = rule({ id: 1 });
  const second = rule({ id: 2, categoryId: 3 });
  const third = rule({ id: 3, categoryId: 9 });
  assert.deepEqual(
    matchPushRules([first, second, third], event(), new Set([3])),
    [first, second], '未命中的不参与，顺序不变',
  );
  assert.deepEqual(matchPushRules([], event(), new Set()), []);
});

// ---- renderTemplate ----

test('模板变量 {liver} {uname} {title} 渲染（{liver} 用原名）', () => {
  assert.equal(
    renderTemplate('{liver}唱歌速来｜{uname}｜{title}', event({ title: '今晚歌回' })),
    '主播1唱歌速来｜主播1｜今晚歌回',
  );
});

test('uname 为空时 {liver} 回退简称', () => {
  assert.equal(renderTemplate('{liver}开播', event({ uname: '' })), '阿梓开播');
});
