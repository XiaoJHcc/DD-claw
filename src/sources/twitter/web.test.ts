/**
 * 免登录回退路线的 HTML 解析单测（不走网络）：og:image 头像与 og:title 显示名抠取。
 * meta 属性顺序不固定、&amp; 要解码、非 http(s) 内容拒绝。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOgImage, parseOgTitleName } from './web.js';

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

