import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyL0, L0_AREA_CONFIDENCE, L0_TITLE_CONFIDENCE } from './l0.js';

const base = { title: '', areaName: '', parentAreaName: '' };

test('标题命中唱歌', () => {
  const v = classifyL0({ ...base, title: '【歌回】晚上好呀' });
  assert.equal(v?.scene, 'singing');
  assert.equal(v?.confidence, L0_TITLE_CONFIDENCE);
  assert.deepEqual(v?.evidence, ['标题含「歌回」']);
});

test('标题命中游戏（游戏名与行为词都算）', () => {
  assert.equal(classifyL0({ ...base, title: '无畏契约上分！' })?.scene, 'gaming');
  assert.equal(classifyL0({ ...base, title: '和弹幕联机玩一会' })?.scene, 'gaming');
});

test('标题命中演出', () => {
  const v = classifyL0({ ...base, title: '三周年纪念回！' });
  assert.equal(v?.scene, 'show');
  assert.ok(v?.evidence.some((e) => e.includes('周年')));
});

test('标题命中杂谈', () => {
  assert.equal(classifyL0({ ...base, title: '深夜杂谈电台' })?.scene, 'chatting');
});

test('多类命中取优先级顺序的第一个（唱歌 > 游戏）', () => {
  const v = classifyL0({ ...base, title: '先打两把排位然后唱歌' });
  assert.equal(v?.scene, 'singing');
});

test('无命中返回 null', () => {
  assert.equal(classifyL0({ ...base, title: '孩子们下午好' }), null);
  assert.equal(classifyL0(base), null);
});

test('标题无命中时分区弱信号（更低置信度）', () => {
  const v = classifyL0({ ...base, title: '下午好', areaName: '虚拟Gamer' });
  assert.equal(v?.scene, 'gaming');
  assert.equal(v?.confidence, L0_AREA_CONFIDENCE);
  assert.deepEqual(v?.evidence, ['分区「虚拟Gamer」']);
});

test('标题有命中时忽略分区（挂游戏区唱歌也判唱歌）', () => {
  const v = classifyL0({ ...base, title: '歌回！', areaName: '虚拟Gamer' });
  assert.equal(v?.scene, 'singing');
  assert.equal(v?.confidence, L0_TITLE_CONFIDENCE);
});
