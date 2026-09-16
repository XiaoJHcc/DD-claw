import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveEventToMessage, postToMessage } from './message.js';
import { toLiveEvent, type LiveStatus } from '../core/types.js';
import type { PostCandidate } from '../analysis/matcher.js';

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

test('缺 face / keyframe 时 icon / image 缺省；推送文案用原名（uname 优先）', () => {
  const m = liveEventToMessage(toLiveEvent(status({ face: '', keyframe: '' }), '小梓'));
  assert.equal(m.title, '阿梓 开播了');
  assert.equal(m.icon, undefined);
  assert.equal(m.image, undefined);
});

test('缺分区显示未知分区；liveTime=0 不拼开播时间', () => {
  const m = liveEventToMessage(toLiveEvent(
    status({ areaName: '', parentAreaName: '', liveTime: 0 }), '',
  ));
  assert.equal(m.attribution, '未知分区');
});

// ---- 图文帖（X）：postToMessage ----

function post(over: Partial<PostCandidate> = {}): PostCandidate {
  return {
    accountId: 1, screenName: 'watase_yuzuki', type: 'tweet', text: '今晚有直播',
    pics: [], pubTs: 1_789_549_200, url: 'https://x.com/watase_yuzuki/status/9001',
    ...over,
  };
}

test('postToMessage：默认标题带 @账号，正文与链接各就各位，来源进 attribution', () => {
  const m = postToMessage({ post: post(), image: 'D:\\cache\\a.jpg' });
  assert.equal(m.title, '@watase_yuzuki 发了新推文');
  assert.equal(m.body, '今晚有直播');
  assert.equal(m.url, 'https://x.com/watase_yuzuki/status/9001');
  assert.equal(m.image, 'D:\\cache\\a.jpg', '图片是已本地化的路径（OneBot 会转 file://）');
  assert.equal(m.icon, undefined, 'X 帖没有头像字段');
  assert.equal(m.priority, 'normal');
  assert.match(m.attribution!, /^X {2}· {2}@watase_yuzuki/);
});

test('postToMessage：模板标题优先；纯图帖正文给占位；多图在 attribution 里报数', () => {
  const m = postToMessage({ post: post({ text: '   ', pics: ['a', 'b', 'c'] }), title: ' 阿梓 更新了 ' });
  assert.equal(m.title, '阿梓 更新了', '标题两侧空白被裁掉');
  assert.equal(m.body, '（仅图片，无正文）');
  assert.match(m.attribution!, /共 3 张图/);
});

test('postToMessage：无图 / 无 url / pubTs=0 时不写这些字段', () => {
  const m = postToMessage({ post: post({ pics: [], url: null, pubTs: 0 }) });
  assert.equal(m.image, undefined);
  assert.equal(m.url, undefined);
  assert.equal(m.attribution, 'X  ·  @watase_yuzuki', '没有时间就不拼时间');
});

test('postToMessage：有译文时正文下方拼【译】块；空译文不拼', () => {
  const withTr = postToMessage({ post: post(), translation: '今晚有直播' });
  assert.equal(withTr.body, '今晚有直播\n\n【译】今晚有直播');

  const blank = postToMessage({ post: post(), translation: '   ' });
  assert.equal(blank.body, '今晚有直播', '空白译文不该拼出空块');

  const none = postToMessage({ post: post({ text: null, pics: ['a'] }), translation: null });
  assert.equal(none.body, '（仅图片，无正文）');
});
