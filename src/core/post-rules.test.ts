/**
 * 图文帖规则的行类型与 filters 解析单测。
 * 重点：库存 JSON 坏掉/缺字段时必须回落默认（防御式，与 posts.pics 同风格），
 * 以及「原创与转发都不勾 = 死规则」这个可判定性检查。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultPostFilters, filtersAreUsable, parseFilters, rowToPostRule, type PostRuleRow,
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
  assert.deepEqual(f.keywords, ['歌回'], '非字符串元素被丢掉');
});

test('filtersAreUsable：原创/转发至少勾一个，都不勾就是死规则', () => {
  assert.equal(filtersAreUsable(defaultPostFilters()), true);
  assert.equal(filtersAreUsable({ ...defaultPostFilters(), original: false, retweet: true }), true);
  assert.equal(filtersAreUsable({ ...defaultPostFilters(), original: false, retweet: false }), false);
});

test('rowToPostRule：JSON 列还原成数组/对象，布尔列还原成 boolean', () => {
  const row: PostRuleRow = {
    id: 7, name: '只推带图原创', account_ids: '[1,2]', channels: '[3]',
    filters: JSON.stringify({ original: true, retweet: false, media: true, keywords: ['live'] }),
    message_template: '{author} 更新了', enabled: 0, sort: 5, created_at: 100, updated_at: 200,
  };
  const r = rowToPostRule(row);
  assert.deepEqual(r.accountIds, [1, 2]);
  assert.deepEqual(r.channels, [3]);
  assert.equal(r.filters.media, true);
  assert.equal(r.filters.quote, false, '未存的字段回落默认');
  assert.deepEqual(r.filters.keywords, ['live']);
  assert.equal(r.messageTemplate, '{author} 更新了');
  assert.equal(r.enabled, false);
  assert.equal(r.sort, 5);
});