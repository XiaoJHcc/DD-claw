import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from './db.js';
import type { NewPost } from './posts.js';

const p = (uid: string, itemId: string, pubTs: number, over: Partial<NewPost> = {}): NewPost => ({
  platform: 'bili_dynamic',
  uid,
  itemId,
  type: 'DYNAMIC_TYPE_WORD',
  text: `正文 ${itemId}`,
  pics: [],
  pubTs,
  url: `https://t.bilibili.com/${itemId}`,
  raw: '{"id_str":"' + itemId + '"}',
  ...over,
});

test('insertPosts：UNIQUE(platform,item_id) 去重，返回新插入行的下标', (t) => {
  const db = new Db(':memory:');
  t.after(() => db.close());

  const first = db.insertPosts([p('1', 'a', 100), p('1', 'b', 200), p('2', 'c', 300)]);
  assert.deepEqual(first, [0, 1, 2], '首轮全部是新行');

  // a 重复（同 platform+item_id）、d 是新帖、换 platform 的同 id 也算新行
  const second = db.insertPosts([p('1', 'a', 100), p('1', 'd', 400), p('2', 'a', 100, { platform: 'weibo' })]);
  assert.deepEqual(second, [1, 2], '重复行不进下标，跨平台同 id 独立去重');
});

test('insertPosts：pics 序列化 / raw 归档 / 空数组', (t) => {
  const db = new Db(':memory:');
  t.after(() => db.close());

  assert.deepEqual(db.insertPosts([]), []);
  db.insertPosts([p('1', 'a', 100, { pics: ['https://i0.hdslb.com/x.jpg'], text: null })]);
  const got = db.listRecentPosts(['1'], 5).get('1')!;
  assert.equal(got.length, 1);
  assert.deepEqual(got[0]!.pics, ['https://i0.hdslb.com/x.jpg']);
  assert.equal(got[0]!.text, null);
  assert.equal(got[0]!.raw, '{"id_str":"a"}');
  assert.equal(got[0]!.platform, 'bili_dynamic');
  assert.equal(got[0]!.pubTs, 100);
});

test('listRecentPosts：按 uid 分组、pub_ts 倒序、各取 perUid 条', (t) => {
  const db = new Db(':memory:');
  t.after(() => db.close());

  db.insertPosts([
    p('1', 'a1', 100), p('1', 'a2', 300), p('1', 'a3', 200),
    p('2', 'b1', 50),
  ]);

  const all = db.listRecentPosts(['1', '2', '3'], 5);
  assert.deepEqual(all.get('1')!.map((x) => x.itemId), ['a2', 'a3', 'a1'], 'pub_ts 倒序');
  assert.deepEqual(all.get('2')!.map((x) => x.itemId), ['b1']);
  assert.equal(all.get('3'), undefined, '无动态的 uid 不在返回里');

  const top2 = db.listRecentPosts(['1'], 2);
  assert.deepEqual(top2.get('1')!.map((x) => x.itemId), ['a2', 'a3'], 'perUid 截取');

  assert.equal(db.listRecentPosts([], 5).size, 0, '空 uid 列表直接返回空');
});
