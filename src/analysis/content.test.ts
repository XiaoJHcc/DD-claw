import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromLiveEvent, fromPostCandidate, type ContentItem } from './content.js';
import { CONDITION_OPERATORS, matchCategoryItem, type PostCandidate } from './matcher.js';
import type { LiveEvent } from '../core/types.js';
import type { Category } from '../core/push.js';

function event(over: Partial<LiveEvent> = {}): LiveEvent {
  return {
    platform: 'bilibili', uid: 'u1', roomId: 'r1', uname: '主播1', alias: '阿梓',
    title: '标题', areaName: '虚拟Gamer', parentAreaName: '虚拟主播', keyframe: 'k.jpg', cover: '',
    roomUrl: 'https://live.bilibili.com/r1', liveTime: 1_785_310_737, classifications: [],
    ...over,
  };
}

function post(over: Partial<PostCandidate> = {}): PostCandidate {
  return {
    platform: 'twitter', itemId: '9001',
    accountId: 1, ruleIds: [1, 2], screenName: 'watase_yuzuki', type: 'tweet', text: '今晚有直播',
    pics: [], pubTs: 1_789_549_200, url: 'https://x.com/watase_yuzuki/status/9001',
    ...over,
  };
}

function category(over: Partial<Category> = {}): Category {
  return {
    id: 1, name: '歌回', llmPrompt: null, keywords: [], areas: [],
    condMode: 'and', enabled: true, createdAt: 0, updatedAt: 0,
    ...over,
  };
}

// ---- fromLiveEvent 投影 ----

test('fromLiveEvent：字段映射（身份键 / 展示名 / 标签 / 图 / 时间戳）', () => {
  assert.deepEqual(fromLiveEvent(event()), {
    subjectType: 'live',
    subjectId: 'r1:1785310737',
    uid: 'u1',
    authorName: '主播1',
    text: '标题',
    tags: { area: '虚拟Gamer', parentArea: '虚拟主播' },
    imageUrls: ['k.jpg'],
    url: 'https://live.bilibili.com/r1',
    ts: 1_785_310_737,
  } satisfies ContentItem);
});

test('fromLiveEvent：uname 空回退简称；图 keyframe||cover 兜底、都无图为空', () => {
  assert.equal(fromLiveEvent(event({ uname: '' })).authorName, '阿梓', '展示名口径 = uname 缺省回退简称');
  assert.deepEqual(fromLiveEvent(event({ keyframe: '', cover: 'c.jpg' })).imageUrls, ['c.jpg'], '无关键帧用封面兜底');
  assert.deepEqual(fromLiveEvent(event({ keyframe: '', cover: '' })).imageUrls, [], '都无图 = 空');
  assert.deepEqual(fromLiveEvent(event({ keyframe: 'k.jpg', cover: 'c.jpg' })).imageUrls, ['k.jpg'], '有则一张：关键帧优先');
});

// ---- fromPostCandidate 投影 ----

test('fromPostCandidate：身份键 / 作者名 / 正文 / 链接 / 时间戳', () => {
  assert.deepEqual(fromPostCandidate(post()), {
    subjectType: 'post',
    subjectId: 'twitter:9001',
    uid: 'watase_yuzuki',
    authorName: '@watase_yuzuki',
    text: '今晚有直播',
    tags: { type: 'original', isQuote: 'unknown', hasMedia: 'false', platform: 'twitter' },
    imageUrls: [],
    url: 'https://x.com/watase_yuzuki/status/9001',
    ts: 1_789_549_200,
  } satisfies ContentItem);
  const weibo = post({
    platform: 'weibo', itemId: '5', screenName: '2203177060', displayName: '渡瀬結月',
    type: 'mblog', text: null, url: null,
  });
  assert.deepEqual(fromPostCandidate(weibo), {
    subjectType: 'post',
    subjectId: 'weibo:5',
    uid: '2203177060',
    authorName: '渡瀬結月',
    text: '',
    tags: { type: 'original', isQuote: 'unknown', hasMedia: 'false', platform: 'weibo' },
    imageUrls: [],
    url: '',
    ts: 1_789_549_200,
  } satisfies ContentItem);
});

test('fromPostCandidate：type 折叠成 original/retweet（只认 type===retweet）', () => {
  assert.equal(fromPostCandidate(post({ type: 'retweet' })).tags.type, 'retweet');
  assert.equal(fromPostCandidate(post({ type: 'DYNAMIC_TYPE_WORD' })).tags.type, 'original', '其余一律原创');
  assert.equal(fromPostCandidate(post({ type: 'mblog' })).tags.type, 'original');
  assert.equal(fromPostCandidate(post({ type: '' })).tags.type, 'original');
});

test('fromPostCandidate：isQuote 三态 / hasMedia / platform 标签', () => {
  assert.equal(fromPostCandidate(post({ isQuote: true })).tags.isQuote, 'true');
  assert.equal(fromPostCandidate(post({ isQuote: false })).tags.isQuote, 'false');
  assert.equal(fromPostCandidate(post()).tags.isQuote, 'unknown', '未标引用 ≠ 明确否');
  assert.equal(fromPostCandidate(post({ pics: ['https://pbs.twimg.com/media/a.jpg'] })).tags.hasMedia, 'true');
  assert.equal(fromPostCandidate(post({ pics: [] })).tags.hasMedia, 'false');
  assert.equal(fromPostCandidate(post({ platform: 'bili_dynamic', itemId: '9' })).tags.platform, 'bili_dynamic');
});

test('fromPostCandidate：imageUrls 取配图 data URL（可空），与帖子图床 URL 分开', () => {
  assert.deepEqual(fromPostCandidate(post({ pics: ['https://pbs.twimg.com/media/a.jpg'] })).imageUrls, [], '不带 data URL 就为空');
  assert.deepEqual(
    fromPostCandidate(post({ pics: ['https://pbs.twimg.com/media/a.jpg'] }), ['data:image/jpeg;base64,x']).imageUrls,
    ['data:image/jpeg;base64,x'],
  );
  assert.deepEqual(fromPostCandidate(post()).imageUrls, [], '缺省参数 = 空');
});

// ---- 条件算子注册表 ----

test('算子注册表：keyword 适用两侧、area 仅 live（appliesTo 门控）', () => {
  assert.deepEqual(CONDITION_OPERATORS.keyword!.appliesTo, ['live', 'post']);
  assert.deepEqual(CONDITION_OPERATORS.area!.appliesTo, ['live']);
  const liveItem = fromLiveEvent(event());
  const postItem = fromPostCandidate(post());
  assert.equal(CONDITION_OPERATORS.area!.test(['虚拟主播'], postItem), null, '不适用的内容类型一律未命中');
  assert.equal(CONDITION_OPERATORS.keyword!.test(['有直播'], postItem), '关键词「有直播」');
  assert.ok(liveItem.subjectType === 'live');
});

test('keyword 算子：text 大小写不敏感子串，任一命中（证据用配置串原文）', () => {
  const liveItem = fromLiveEvent(event({ title: '今晚 apex 上分' }));
  assert.equal(CONDITION_OPERATORS.keyword!.test(['APEX', '歌回'], liveItem), '关键词「APEX」', '按配置序取首个命中');
  assert.equal(CONDITION_OPERATORS.keyword!.test(['歌回'], liveItem), null);
  assert.equal(CONDITION_OPERATORS.keyword!.test([], liveItem), null, '空条件串 = 未命中');
  const postItem = fromPostCandidate(post({ text: '今晚歌回！' }));
  assert.equal(CONDITION_OPERATORS.keyword!.test(['歌回'], postItem), '关键词「歌回」', 'post 吃 text（帖子正文）');
});

test('area 算子：对 tags.area / tags.parentArea 子串命中（证据用配置串原文）', () => {
  const liveItem = fromLiveEvent(event());
  assert.equal(CONDITION_OPERATORS.area!.test(['gamer'], liveItem), '分区「gamer」');
  assert.equal(CONDITION_OPERATORS.area!.test(['虚拟主播'], liveItem), '分区「虚拟主播」', 'parentArea 也认');
  assert.equal(CONDITION_OPERATORS.area!.test(['网游'], liveItem), null);
});

test('matchCategoryItem：走注册表组判定，evidence 格式「命中关键词「xx」、分区「yy」」', () => {
  const item = fromLiveEvent(event({ title: '今晚歌回' }));
  const both = matchCategoryItem(category({ keywords: ['歌'], areas: ['gamer'], condMode: 'or' }), item);
  assert.equal(both.matched, true);
  assert.equal(both.evidence, '命中关键词「歌」、分区「gamer」');
  const postItem = fromPostCandidate(post({ text: '今晚歌回！' }));
  const onPost = matchCategoryItem(category({ keywords: ['歌回'] }), postItem);
  assert.equal(onPost.matched, true, 'post 项也能走 keyword 组');
  const areaOnPost = matchCategoryItem(category({ areas: ['任意'] }), postItem);
  assert.equal(areaOnPost.matched, false, 'area 算子不适用 post = 该组不命中');
});
