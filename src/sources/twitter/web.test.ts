/**
 * 免登录回退路线的 HTML 解析单测（不走网络）：og:image 头像与 og:title 显示名抠取。
 * meta 属性顺序不固定、&amp; 要解码、非 http(s) 内容拒绝。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWebTimeline, parseOgImage, parseOgTitleName, parseWebTweetIds } from './web.js';
import type { ParsedTweet } from './nitter.js';

test('parseOgImage：property 在前 / content 在前两种属性顺序都认', () => {
  const a = '<html><head><meta property="og:image" content="https://pbs.twimg.com/profile_images/1/a_200x200.jpg"></head></html>';
  assert.equal(parseOgImage(a), 'https://pbs.twimg.com/profile_images/1/a_200x200.jpg');

  const b = '<html><head><meta content="https://pbs.twimg.com/profile_images/1/b.png" property="og:image"></head></html>';
  assert.equal(parseOgImage(b), 'https://pbs.twimg.com/profile_images/1/b.png');
});

test('parseOgImage：&amp; 解码；缺 og:image / 非 http(s) / 缺 content 都返回 null', () => {
  assert.equal(
    parseOgImage('<meta property="og:image" content="https://pbs.twimg.com/x.jpg?name=A&amp;ext=1">'),
    'https://pbs.twimg.com/x.jpg?name=A&ext=1',
  );
  assert.equal(parseOgImage('<html><head></head><body>x</body></html>'), null, '没有 og:image');
  assert.equal(parseOgImage('<meta property="og:image" content="/relative/x.jpg">'), null, '相对路径拒绝');
  assert.equal(parseOgImage('<meta property="og:image">'), null, '没有 content 属性');
  assert.equal(parseOgImage(''), null);
});

test('parseOgTitleName：`名字 (@handle) / X` 形态抠显示名（实体解码、属性顺序不拘）', () => {
  assert.equal(
    parseOgTitleName('<meta property="og:title" content="渡瀬 結月 (@Watase_Yuzuki) / X">'),
    '渡瀬 結月',
  );
  assert.equal(
    parseOgTitleName('<meta content="A &amp; B (あ) (@ab) / X" name="og:title">'),
    'A & B (あ)',
    '显示名含 &amp; 与括号都原样保留（只剥尾部 (@handle)）',
  );
  assert.equal(
    parseOgTitleName('<meta property="og:title" content="只带后缀 (@Watase_Yuzuki)">'),
    '只带后缀',
    ' / X 后缀可缺',
  );
});

test('parseOgTitleName：名字为空 / 形态对不上 / 缺标签都返回 null', () => {
  assert.equal(parseOgTitleName('<meta property="og:title" content="(@Watase_Yuzuki) / X">'), null, '空名');
  assert.equal(parseOgTitleName('<meta property="og:title" content="Explore / X">'), null, '形态对不上不硬猜');
  assert.equal(parseOgTitleName('<meta property="og:title">'), null, '没有 content');
  assert.equal(parseOgTitleName('<html></html>'), null, '没有 og:title');
});

test('parseWebTweetIds：兼容普通 JSON 与 Flight 多层转义，去重并按 id 降序', () => {
  const html = [
    'rest_id":"1000000000000000101"',
    String.raw`rest_id\\\":\\\"1000000000000000103\\\"`,
    String.raw`rest_id\\\":\\\"1000000000000000102\\\"`,
    String.raw`rest_id\\\":\\\"1000000000000000103\\\"`,
  ].join('\n');
  assert.deepEqual(parseWebTweetIds(html), [
    '1000000000000000103',
    '1000000000000000102',
    '1000000000000000101',
  ]);
});

const webIds = (ids: string[]) => async () => ({ ids, avatarUrl: null, authorName: null, bytes: 100, ms: 1 });
const webDetail = (id: string, author = 'watase_yuzuki'): ParsedTweet => ({
  id,
  author,
  isRetweet: false,
  retweetedBy: null,
  text: id,
  pics: [],
  pubTs: Number(id.slice(-3)),
  url: `https://x.com/${author}/status/${id}`,
  isQuote: false,
});

test('web 时间线：空 id 明确报错，不得伪装成成功的空时间线', async () => {
  await assert.rejects(
    fetchWebTimeline('watase_yuzuki', 'http://127.0.0.1:7890', { listFetcher: webIds([]) }),
    /未发现任何推文 id/,
  );
});

test('web 增量：最旧新 id 先处理，限额不跳过；其他作者只推进游标不归入账号', async () => {
  const ids = ['105', '104', '103', '102', '101'].map((n) => `1000000000000000${n}`);
  const calls: string[] = [];
  const detailFetcher = async (id: string) => {
    calls.push(id);
    return webDetail(id, id.endsWith('102') ? 'quoted_author' : 'watase_yuzuki');
  };
  const first = await fetchWebTimeline('watase_yuzuki', 'http://127.0.0.1:7890', {
    sinceId: '1000000000000000100', maxDetails: 2, listFetcher: webIds(ids), detailFetcher,
  });
  assert.deepEqual(calls, ['1000000000000000101', '1000000000000000102']);
  assert.deepEqual(first.tweets.map((t) => t.id), ['1000000000000000101']);
  assert.equal(first.cursorId, '1000000000000000102', '成功识别的引用帖可以越过，但不归入轮询账号');

  calls.length = 0;
  const second = await fetchWebTimeline('watase_yuzuki', 'http://127.0.0.1:7890', {
    sinceId: first.cursorId, maxDetails: 2, listFetcher: webIds(ids), detailFetcher,
  });
  assert.deepEqual(calls, ['1000000000000000103', '1000000000000000104']);
  assert.equal(second.cursorId, '1000000000000000104');
});

test('web 增量：详情失败即停在失败前，下一轮重试，不越过失败项', async () => {
  const ids = ['103', '102', '101'].map((n) => `1000000000000000${n}`);
  let fail102 = true;
  const detailFetcher = async (id: string) => {
    if (fail102 && id.endsWith('102')) throw new Error('temporary failure');
    return webDetail(id);
  };
  const first = await fetchWebTimeline('watase_yuzuki', 'http://127.0.0.1:7890', {
    sinceId: '1000000000000000100', maxDetails: 2, listFetcher: webIds(ids), detailFetcher,
  });
  assert.equal(first.cursorId, '1000000000000000101');
  assert.deepEqual(first.tweets.map((t) => t.id), ['1000000000000000101']);

  fail102 = false;
  const second = await fetchWebTimeline('watase_yuzuki', 'http://127.0.0.1:7890', {
    sinceId: first.cursorId, maxDetails: 2, listFetcher: webIds(ids), detailFetcher,
  });
  assert.deepEqual(second.tweets.map((t) => t.id), ['1000000000000000103', '1000000000000000102']);
  assert.equal(second.cursorId, '1000000000000000103');
});

