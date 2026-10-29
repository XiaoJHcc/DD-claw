/**
 * X 账号发现单测（不走网络）：handle 抠取规则、候选排序、x.com 校验过滤。
 * 路线成因（X 无免登录搜索）见 docs/research/web-search.md。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractXHandles, searchXAccounts } from './search.js';
import type { WebSearchResult } from '../../search/web.js';

function hit(url: string, snippet = '', summary = '', title = ''): WebSearchResult {
  return { title, url, snippet, summary, site: null, date: null };
}

test('extractXHandles：x.com / twitter.com 链接与 @提及；保留路径与邮箱不算', () => {
  assert.deepEqual(
    extractXHandles('见 https://x.com/Hina_Youmiya/status/2065033881359884712?s=46'),
    ['hina_youmiya'],
    '大小写归一、status 后缀不影响',
  );
  assert.deepEqual(extractXHandles('http://twitter.com/foo_bar'), ['foo_bar']);
  assert.deepEqual(extractXHandles('x.com/i/status/1 与 x.com/pic.twitter.com/a'), [], 'i 是保留路径');
  assert.deepEqual(extractXHandles('@Watase_Yuzuki さん'), ['watase_yuzuki']);
  assert.deepEqual(extractXHandles('联系 foo@bar.com'), [], '邮箱不当 handle');
  assert.deepEqual(extractXHandles('没有链接'), []);
});

test('searchXAccounts：候选去重、按命中数排序、带出处片段', async () => {
  const out = await searchXAccounts('羊宮妃那', {
    search: async () => [
      hit('https://pttcomics.com/x', '她的推特 https://x.com/hina_youmiya/status/1'),
      hit('https://thetv.jp/person/1', '@Hina_Youmiya 出演'),
      hit('https://example.com/b', 'x.com/youmiya_hina/status/2'),
    ],
  });
  assert.deepEqual(out.map((c) => c.screenName), ['hina_youmiya', 'youmiya_hina']);
  assert.equal(out[0]!.sources.length, 2, '两个来源都记下来');
  assert.match(out[0]!.sources[0]!.quote, /hina_youmiya/);
  assert.equal(out[0]!.exists, null, '没注入 verify = 未校验');
  assert.equal(out[0]!.url, 'https://x.com/hina_youmiya');
});

test('searchXAccounts：verify 判不存在的候选丢弃，确认存在的排前面并带显示名', async () => {
  const out = await searchXAccounts('Ave Mujica', {
    search: async () => [
      hit('https://p1/x', 'x.com/fake_account/status/1'),
      hit('https://p2/x', 'x.com/Watase_Yuzuki/status/2'),
      hit('https://p3/x', 'x.com/unknown_one/status/3'),
    ],
    verify: async (screen) => screen === 'watase_yuzuki'
      ? { checked: true, ok: true, kind: 'ok', name: '渡瀬 結月', message: 'ok' }
      : screen === 'fake_account'
        ? { checked: true, ok: false, kind: 'not-found', message: 'x.com 返回 404' }
        : { checked: true, ok: false, kind: 'link', message: '代理不通' },
  });
  assert.deepEqual(out.map((c) => c.screenName), ['watase_yuzuki', 'unknown_one']);
  assert.equal(out[0]!.exists, true);
  assert.equal(out[0]!.name, '渡瀬 結月');
  assert.equal(out[1]!.exists, null, '链路不通 = 未校验，不丢候选');
});

test('searchXAccounts：首选检索线索太少时补一次 x.com 检索并合并', async () => {
  const queries: string[] = [];
  const out = await searchXAccounts('立石凛', {
    search: async (q) => {
      queries.push(q);
      return q.endsWith('twitter')
        ? [hit('https://p1/x', 'x.com/ttisrn_0710/status/1')]
        : [hit('https://p2/x', 'x.com/tateishi_rin/status/2')];
    },
  });
  assert.deepEqual(queries, ['立石凛 twitter', '立石凛 x.com']);
  assert.deepEqual(out.map((c) => c.screenName).sort(), ['tateishi_rin', 'ttisrn_0710']);
});

test('searchXAccounts：没挖到线索返回空数组（不抛错）', async () => {
  const out = await searchXAccounts('x', { search: async () => [] });
  assert.deepEqual(out, []);
});
