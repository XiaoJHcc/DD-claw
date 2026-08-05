import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveEventToMessage } from './message.js';
import { toLiveEvent, type LiveStatus } from '../core/types.js';

function status(over: Partial<LiveStatus> = {}): LiveStatus {
  return {
    uid: '1', roomId: '100', uname: '阿梓', title: '唱歌捏', isLive: true,
    liveTime: 1785936622, areaName: 'CS2', parentAreaName: '网游',
    cover: '', keyframe: '', face: 'https://i2.hdslb.com/bfs/face/x.jpg',
    ...over,
  };
}

test('头像进 icon，分区 · 开播时间进 attribution，body 只留标题', () => {
  const m = liveEventToMessage(toLiveEvent(status(), ''));
  assert.equal(m.title, '阿梓 开播了');
  assert.equal(m.body, '唱歌捏', 'body 不再拼分区时间行');
  assert.equal(m.icon, 'https://i2.hdslb.com/bfs/face/x.jpg');
  assert.equal(m.attribution, `网游 / CS2  ·  ${new Date(1785936622 * 1000)
    .toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 开播`);
});

test('缺 face / keyframe 时 icon / image 缺省；alias 优先于 uname', () => {
  const m = liveEventToMessage(toLiveEvent(status({ face: '', keyframe: '' }), '小梓'));
  assert.equal(m.title, '小梓 开播了');
  assert.equal(m.icon, undefined);
  assert.equal(m.image, undefined);
});

test('缺分区显示未知分区；liveTime=0 不拼开播时间', () => {
  const m = liveEventToMessage(toLiveEvent(
    status({ areaName: '', parentAreaName: '', liveTime: 0 }), '',
  ));
  assert.equal(m.attribution, '未知分区');
});
