/**
 * 图文帖平台语义 + 旧 post_rules.filters 解析口径（A.3 迁移解析用）的单测。
 * 重点：库存 JSON 坏掉/缺字段时必须回落默认（防御式，与 posts.pics 同风格）。
 * 行类型与「行 ↔ 对象」映射已随 post_rules 表 DROP（统一计划附录 A.3）下线。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultPostFilters, parseFilters,
  platformLabel, platformSupportsQuote, platformSupportsTranslate, POST_PLATFORMS,
} from './post-rules.js';

test('默认筛选：只推原创、不论有没有图', () => {
  const f = defaultPostFilters();
  assert.equal(f.original, true);
  assert.equal(f.retweet, false);
  assert.equal(f.media, false);
  assert.deepEqual(f.keywords, []);
});

test('parseFilters：缺字段回落默认，非法类型忽略', () => {
  assert.deepEqual(parseFilters(null), defaultPostFilters());
  assert.deepEqual(parseFilters(''), defaultPostFilters());
  assert.deepEqual(parseFilters('不是 JSON'), defaultPostFilters());
  assert.deepEqual(parseFilters('[]'), defaultPostFilters(), '数组不是对象');

  const f = parseFilters(JSON.stringify({ retweet: true, media: 'yes', keywords: ['歌回', 42, null] }));
  assert.equal(f.retweet, true);
  assert.equal(f.original, true, '未提供的字段回落默认（不是 false）');
  assert.equal(f.media, false, '非布尔忽略');
  assert.deepEqual(f.keywords, ['歌回'], '非字符串元素被滤掉');
});

test('parseFilters：quote 字段解析（只有 X 帖可能命中是语义，解析层照收）', () => {
  const f = parseFilters(JSON.stringify({ quote: true }));
  assert.equal(f.quote, true);
});

test('平台语义：三平台名单 / 文案措辞 / quote 与翻译门控', () => {
  assert.deepEqual([...POST_PLATFORMS], ['twitter', 'weibo', 'bili_dynamic']);
  assert.equal(platformLabel('twitter'), 'X');
  assert.equal(platformLabel('weibo'), '微博');
  assert.equal(platformLabel('bili_dynamic'), 'B站');

  assert.equal(platformSupportsQuote('twitter'), true, '只有 X 的 HTML 回退路线能标引用');
  assert.equal(platformSupportsQuote('weibo'), false);
  assert.equal(platformSupportsQuote('bili_dynamic'), false);

  assert.equal(platformSupportsTranslate('twitter'), true, '只有 X 帖需要译文');
  assert.equal(platformSupportsTranslate('weibo'), false);
  assert.equal(platformSupportsTranslate('bili_dynamic'), false);
});
