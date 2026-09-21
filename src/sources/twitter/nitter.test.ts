/**
 * Nitter RSS 解析单测。fixture 直接照 2026-09-16 实测的真实条目结构写，
 * 覆盖：原创 / 转发（guid 与 dc:creator 都是原作者）/ 纯图无正文 / 实体解码 /
 * 实例图片代理 URL 还原 / 缺 guid 时回落 link / 空 feed。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeEntities, instancePicToCdn, parseNitterAvatar, parseNitterItem, parseNitterRss,
} from './nitter.js';

function item(opts: {
  title: string; creator: string; link: string; guid?: string; date: string; desc?: string;
}): string {
  return `
  <item>
    <title>${opts.title}</title>
    <dc:creator>${opts.creator}</dc:creator>
    <description><![CDATA[${opts.desc ?? '<p>正文</p>'}]]></description>
    <pubDate>${opts.date}</pubDate>
    ${opts.guid ? `<guid isPermaLink="false">${opts.guid}</guid>` : ''}
    <link>${opts.link}</link>
  </item>`;
}

test('原创：字段全对，url 指向 x.com 原文', () => {
  const t = parseNitterItem(item({
    title: '【お知らせ】新作アニメに出演します',
    creator: '@Watase_Yuzuki',
    link: 'http://nitter.jaydenha.uk/Watase_Yuzuki/status/2100138324883280168#m',
    guid: '2100138324883280168',
    date: 'Wed, 16 Sep 2026 08:22:49 GMT',
    desc: '<p>正文<br>第二行</p><img src="http://nitter.jaydenha.uk/pic/media%2FHSUrcDJbYAAkpoV.jpg" />',
  }))!;
  assert.equal(t.id, '2100138324883280168');
  assert.equal(t.author, 'watase_yuzuki', 'dc:creator 去 @ 并小写');
  assert.equal(t.isRetweet, false);
  assert.equal(t.retweetedBy, null);
  assert.equal(t.text, '【お知らせ】新作アニメに出演します', '正文取 title（URL 完整），RT 前缀已剥离');
  assert.deepEqual(t.pics, ['https://pbs.twimg.com/media/HSUrcDJbYAAkpoV.jpg'], '实例代理图还原成 CDN 形态');
  assert.equal(t.pubTs, Math.floor(Date.parse('Wed, 16 Sep 2026 08:22:49 GMT') / 1000));
  assert.equal(t.url, 'https://x.com/watase_yuzuki/status/2100138324883280168');
});

test('转发：guid/作者都是原作者，retweetedBy 是被轮询的账号', () => {
  const t = parseNitterItem(item({
    title: 'RT by @Watase_Yuzuki: ⋰⋆໒꒱ Steamストアページ公開',
    creator: '@D4DJ_pj',
    link: 'http://nitter.jaydenha.uk/D4DJ_pj/status/2100147931877929308#m',
    guid: '2100147931877929308',
    date: 'Wed, 16 Sep 2026 09:01:00 GMT',
  }))!;
  assert.equal(t.id, '2100147931877929308');
  assert.equal(t.author, 'd4dj_pj', '原作者');
  assert.equal(t.isRetweet, true);
  assert.equal(t.retweetedBy, 'watase_yuzuki');
  assert.equal(t.text, '⋰⋆໒꒱ Steamストアページ公開', 'RT 前缀不进正文');
  assert.equal(t.url, 'https://x.com/d4dj_pj/status/2100147931877929308', '链接指向原推');
});

test('纯图无正文：text 为 null（不是空串），图仍带出', () => {
  const t = parseNitterItem(item({
    title: 'RT by @someone: ',
    creator: '@someone',
    link: 'http://nitter.x/someone/status/1234567890123456789#m',
    guid: '1234567890123456789',
    date: 'Wed, 16 Sep 2026 09:01:00 GMT',
    desc: '<img src="http://nitter.x/pic/media%2Fabc.jpg" />',
  }))!;
  assert.equal(t.text, null);
  assert.deepEqual(t.pics, ['https://pbs.twimg.com/media/abc.jpg']);
});

test('实体解码：数字实体 / &amp; / &quot; 都还原', () => {
  assert.equal(decodeEntities('a&#39;b &amp; c &quot;d&quot; &#x4E2D;'), "a'b & c \"d\" 中");
});

test('instancePicToCdn：路径形态与完整 URL 形态都还原；越界/异域拒绝', () => {
  assert.equal(instancePicToCdn('http://n/pic/media%2Fx.jpg'), 'https://pbs.twimg.com/media/x.jpg');
  assert.equal(instancePicToCdn('/pic/media%2Fx.jpg'), 'https://pbs.twimg.com/media/x.jpg');
  assert.equal(
    instancePicToCdn('http://n/pic/https%3A%2F%2Fpbs.twimg.com%2Fprofile_images%2F1%2Fa_400x400.jpg'),
    'https://pbs.twimg.com/profile_images/1/a_400x400.jpg',
    '频道头像的完整 URL 编码形态（2026-09-17 真机实测）',
  );
  assert.equal(instancePicToCdn('https://pbs.twimg.com/media/x.jpg'), null, '已经是 CDN 形态就不动');
  assert.equal(instancePicToCdn('http://n/pic/https%3A%2F%2Fevil.example.com%2Fx.jpg'), null, '完整 URL 但非 CDN 域');
  assert.equal(instancePicToCdn('http://n/user/pic/..%2F..%2Fetc'), null, '含 .. 一律拒绝');
  assert.equal(instancePicToCdn(''), null);
});

test('缺 guid 时回落 link 里的 id；两者都没有 → 跳过该条', () => {
  const t = parseNitterItem(item({
    title: 'hi', creator: '@a', link: 'http://n/a/status/2100000000000000001#m',
    date: 'Wed, 16 Sep 2026 09:01:00 GMT',
  }));
  assert.equal(t?.id, '2100000000000000001');

  const broken = parseNitterItem('<item><title>无 id</title><dc:creator>@a</dc:creator></item>');
  assert.equal(broken, null, '没有 id 的条目直接跳过，不产出半条数据');
});

test('parseNitterRss：整份解析、去重、按 pubTs 倒序', () => {
  const xml = '<rss><channel>' +
    item({ title: '旧', creator: '@a', link: 'http://n/a/status/1000000000000000001#m', guid: '1000000000000000001', date: 'Wed, 16 Sep 2026 01:00:00 GMT' }) +
    item({ title: '新', creator: '@a', link: 'http://n/a/status/1000000000000000003#m', guid: '1000000000000000003', date: 'Wed, 16 Sep 2026 09:00:00 GMT' }) +
    item({ title: '重复', creator: '@a', link: 'http://n/a/status/1000000000000000003#m', guid: '1000000000000000003', date: 'Wed, 16 Sep 2026 09:00:00 GMT' }) +
    '</channel></rss>';
  const list = parseNitterRss(xml);
  assert.deepEqual(list.map((t) => t.text), ['新', '旧'], '倒序 + 同一 id 去重');
});

test('parseNitterRss：空 feed / 非 RSS 内容都返回空数组（不抛错）', () => {
  assert.deepEqual(parseNitterRss('<rss><channel></channel></rss>'), []);
  assert.deepEqual(parseNitterRss('<html>挑战页</html>'), []);
  assert.deepEqual(parseNitterRss(''), []);
});

test('parseNitterAvatar：频道头 image/url → CDN 头像；没有 image 或认不出的形态 → null', () => {
  // 真实频道头格式（2026-09-17 真机 nitter.jaydenha.uk 核对）：完整 URL 编码
  const withAvatar = '<rss><channel><title>@a</title>' +
    '<image><title>@a</title><url>http://nitter.x/pic/https%3A%2F%2Fpbs.twimg.com%2Fprofile_images%2F123%2Fabc_400x400.jpg</url></image>' +
    item({ title: 'x', creator: '@a', link: 'http://n/a/status/1000000000000000001#m', guid: '1000000000000000001', date: 'Wed, 16 Sep 2026 01:00:00 GMT' }) +
    '</channel></rss>';
  assert.equal(
    parseNitterAvatar(withAvatar),
    'https://pbs.twimg.com/profile_images/123/abc_400x400.jpg',
    '完整 URL 编码形态还原成 CDN 直链',
  );

  const noImage = '<rss><channel><title>@a</title>' +
    item({ title: 'x', creator: '@a', link: 'http://n/a/status/1000000000000000001#m', guid: '1000000000000000001', date: 'Wed, 16 Sep 2026 01:00:00 GMT' }) +
    '</channel></rss>';
  assert.equal(parseNitterAvatar(noImage), null, '实例没给频道图');

  const odd = '<rss><channel><image><url>http://nitter.x/static/logo.png</url></image></channel></rss>';
  assert.equal(parseNitterAvatar(odd), null, '非 /pic/ 前缀（认不出来的形态）丢弃');

  assert.equal(parseNitterAvatar(''), null);
});