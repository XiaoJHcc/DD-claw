/**
 * 免登录回退路线的 HTML 解析单测（不走网络）：og:image 头像抠取。
 * meta 属性顺序不固定、&amp; 要解码、非 http(s) 内容拒绝。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOgImage } from './web.js';

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
