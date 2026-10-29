/**
 * B站用户搜索单测（不走网络）：URL/Referer 契约、字段映射、风控文案。
 * 端点实测见 docs/research/web-search.md。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BiliApiError } from './client.js';
import { searchBiliUsers } from './search.js';

test('searchBiliUsers：走 wbi 搜索端点、带 search.bilibili.com Referer、关键词编码', async () => {
  let seenUrl = '';
  let seenReferer: string | undefined;
  const hits = await searchBiliUsers('羊宫妃那', {
    request: async (url, opts) => {
      seenUrl = url;
      seenReferer = opts?.referer;
      return { result: [] };
    },
  });
  assert.match(seenUrl, /^https:\/\/api\.bilibili\.com\/x\/web-interface\/wbi\/search\/type\?/);
  assert.match(seenUrl, /search_type=bili_user/);
  assert.ok(seenUrl.includes(`keyword=${encodeURIComponent('羊宫妃那')}`), '关键词必须 URL 编码');
  assert.equal(seenReferer, 'https://search.bilibili.com/');
  assert.deepEqual(hits, []);
});

test('searchBiliUsers：字段映射（mid→uid、upic→avatar、official_verify.desc→official）', async () => {
  const hits = await searchBiliUsers('mygo', {
    request: async () => ({
      result: [{
        mid: 1459104794,
        uname: 'MyGO_AveMujica',
        usign: '来自 BanG Dream! Project',
        fans: 1018512,
        level: 6,
        official_verify: { type: 0, desc: 'MyGO!!!!!& Ave Mujica' },
        is_live: 1,
        room_id: 2333,
        upic: 'https://i0.hdslb.com/x.jpg',
      }],
    }),
  });
  assert.deepEqual(hits, [{
    uid: '1459104794',
    uname: 'MyGO_AveMujica',
    sign: '来自 BanG Dream! Project',
    fans: 1018512,
    level: 6,
    official: 'MyGO!!!!!& Ave Mujica',
    live: true,
    roomId: '2333',
    avatar: 'https://i0.hdslb.com/x.jpg',
  }]);
});

test('searchBiliUsers：limit 生效；缺 mid 的行丢弃', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ mid: i + 1, uname: `u${i}` }));
  const hits = await searchBiliUsers('x', { limit: 2, request: async () => ({ result: [...rows, { uname: '无 mid' }] }) });
  assert.deepEqual(hits.map((h) => h.uid), ['1', '2']);
});

test('searchBiliUsers：风控码单独点出来；其他失败带上原因', async () => {
  await assert.rejects(
    () => searchBiliUsers('x', { request: async () => { throw new BiliApiError(-352, '风控校验失败'); } }),
    /B站搜索被风控（-352）/,
  );
  await assert.rejects(
    () => searchBiliUsers('x', { request: async () => { throw new Error('网络错误'); } }),
    /B站搜索失败：网络错误/,
  );
});
