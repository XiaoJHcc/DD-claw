import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateRuleHits, defaultPostTitle, matchCategory, matchPostFilters, matchPostRules, matchPushRules,
  renderPostTemplate, renderTemplate,
  type PostCandidate,
} from './matcher.js';
import type { LiveEvent } from '../core/types.js';
import type { Category, PushRule } from '../core/push.js';
import { defaultPostFilters, type PostRule } from '../core/post-rules.js';

function category(over: Partial<Category> = {}): Category {
  return {
    id: 1, name: '歌回', llmPrompt: null, keywords: [], areas: [],
    condMode: 'and', enabled: true, createdAt: 0, updatedAt: 0,
    ...over,
  };
}

function rule(over: Partial<PushRule> = {}): PushRule {
  return {
    id: 1, name: '规则 1', categoryId: null, uids: [], channels: [],
    messageTemplate: null, enabled: true, createdAt: 0, updatedAt: 0,
    ...over,
  };
}

function event(over: Partial<LiveEvent> = {}): LiveEvent {
  return {
    platform: 'bilibili', uid: 'u1', roomId: 'r1', uname: '主播1', alias: '阿梓',
    title: '标题', areaName: '虚拟Gamer', parentAreaName: '虚拟主播', keyframe: 'k.jpg', cover: '',
    roomUrl: 'https://live.bilibili.com/r1', liveTime: 1_785_310_737, classifications: [],
    ...over,
  };
}

// ---- matchCategory ----

test('关键词组：标题大小写不敏感子串，任一命中', () => {
  const c = category({ keywords: ['APEX', '歌回'] });
  assert.equal(matchCategory(c, event({ title: '今晚 apex 上分' })).matched, true);
  assert.equal(matchCategory(c, event({ title: '生日歌回！' })).matched, true);
  assert.equal(matchCategory(c, event({ title: '随便播播' })).matched, false);
});

test('分区组：areaName 与 parentAreaName 任一字段子串命中', () => {
  const byArea = category({ areas: ['gamer'] });
  assert.equal(matchCategory(byArea, event()).matched, true, 'areaName 命中（大小写不敏感）');
  const byParent = category({ areas: ['虚拟主播'] });
  assert.equal(matchCategory(byParent, event()).matched, true, 'parentAreaName 命中');
  assert.equal(matchCategory(category({ areas: ['网游'] }), event()).matched, false);
});

test('condMode=and：两组都填需都中，只满足一个不命中', () => {
  const c = category({ keywords: ['歌'], areas: ['虚拟主播'], condMode: 'and' });
  assert.equal(matchCategory(c, event({ title: '歌回' })).matched, true, '都满足才命中');
  assert.equal(matchCategory(c, event({ title: '打游戏' })).matched, false, '缺关键词');
  assert.equal(
    matchCategory(c, event({ title: '歌回', areaName: '网游', parentAreaName: '电子竞技' })).matched,
    false, '缺分区',
  );
});

test('condMode=or：任一组命中即中', () => {
  const c = category({ keywords: ['歌'], areas: ['网游'], condMode: 'or' });
  assert.equal(matchCategory(c, event({ title: '歌回' })).matched, true, '关键词命中即可');
  assert.equal(
    matchCategory(c, event({ title: '打游戏', areaName: '网游' })).matched, true, '分区命中即可',
  );
  assert.equal(matchCategory(c, event({ title: '随便播播' })).matched, false, '都不中');
});

test('空组忽略：只剩一组时按该组判（与 condMode 无关）', () => {
  const onlyKeywords = category({ keywords: ['歌'], condMode: 'and' });
  assert.equal(matchCategory(onlyKeywords, event({ title: '歌回' })).matched, true);
  const onlyAreas = category({ areas: ['虚拟主播'], condMode: 'or' });
  assert.equal(matchCategory(onlyAreas, event({ title: '随便播播' })).matched, true);
  assert.equal(matchCategory(onlyAreas, event({ areaName: '网游', parentAreaName: '电子竞技' })).matched, false);
});

test('两组皆空 → 不命中（纯 LLM 分类不被确定性路径误判恒中）', () => {
  const empty = category({ keywords: [], areas: [] });
  const r = matchCategory(empty, event({ title: '任何东西' }));
  assert.equal(r.matched, false);
  assert.equal(r.evidence, '');
});

test('evidence 记录命中词，未命中为空串', () => {
  const c = category({ keywords: ['歌'], areas: ['gamer'], condMode: 'or' });
  const both = matchCategory(c, event({ title: '今晚歌回' }));
  assert.equal(both.matched, true);
  assert.equal(both.evidence, '命中关键词「歌」、分区「gamer」');
  assert.equal(matchCategory(c, event({ title: '不相关', areaName: '网游', parentAreaName: '电子竞技' })).evidence, '');
});

// ---- matchPushRules v2 ----

test('categoryId 为 null = 任意开播都命中', () => {
  const any = rule({ categoryId: null });
  assert.deepEqual(matchPushRules([any], event(), new Set()), [any], '无分类判定也命中');
  assert.deepEqual(matchPushRules([any], event(), new Set([1])), [any]);
});

test('categoryId 非空 = 该场须判定属于此分类', () => {
  const r = rule({ categoryId: 7 });
  assert.deepEqual(matchPushRules([r], event(), new Set([7])), [r]);
  assert.deepEqual(matchPushRules([r], event(), new Set([1, 2])), [], '不在判定集合里不命中');
  assert.deepEqual(matchPushRules([r], event(), new Set()), []);
});

test('uids 空 = 全部主播（含未来新增）；非空 = 仅名单内', () => {
  const all = rule({ uids: [] });
  assert.deepEqual(matchPushRules([all], event({ uid: '任何人' }), new Set()), [all]);
  const some = rule({ uids: ['u1', 'u2'] });
  assert.deepEqual(matchPushRules([some], event({ uid: 'u2' }), new Set()), [some]);
  assert.deepEqual(matchPushRules([some], event({ uid: 'u3' }), new Set()), []);
});

test('分类与主播两个条件 AND：只满足一个不命中', () => {
  const r = rule({ categoryId: 7, uids: ['u1'] });
  assert.deepEqual(matchPushRules([r], event({ uid: 'u1' }), new Set([7])), [r]);
  assert.deepEqual(matchPushRules([r], event({ uid: 'u1' }), new Set()), [], '分类不满足');
  assert.deepEqual(matchPushRules([r], event({ uid: 'u9' }), new Set([7])), [], '主播不满足');
});

test('多条规则全部命中都返回，保持传入顺序', () => {
  const first = rule({ id: 1 });
  const second = rule({ id: 2, categoryId: 3 });
  const third = rule({ id: 3, categoryId: 9 });
  assert.deepEqual(
    matchPushRules([first, second, third], event(), new Set([3])),
    [first, second], '未命中的不参与，顺序不变',
  );
  assert.deepEqual(matchPushRules([], event(), new Set()), []);
});

// ---- renderTemplate ----

test('模板变量 {liver} {uname} {title} 渲染（{liver} 用原名）', () => {
  assert.equal(
    renderTemplate('{liver}唱歌速来｜{uname}｜{title}', event({ title: '今晚歌回' })),
    '主播1唱歌速来｜主播1｜今晚歌回',
  );
});

test('uname 为空时 {liver} 回退简称', () => {
  assert.equal(renderTemplate('{liver}开播', event({ uname: '' })), '阿梓开播');
});

// ---- 图文帖（X/推特 + 微博 + B站动态）：与开播规则平行的确定性判定 ----

function post(over: Partial<PostCandidate> = {}): PostCandidate {
  return {
    platform: 'twitter',
    accountId: 1, ruleIds: [1, 2], screenName: 'watase_yuzuki', type: 'tweet', text: '今晚有直播',
    pics: [], pubTs: 1_789_549_200, url: 'https://x.com/watase_yuzuki/status/9001',
    ...over,
  };
}

/** 微博帖：账号标识是数字 uid、展示名是昵称、类型是 mblog */
function weiboPost(over: Partial<PostCandidate> = {}): PostCandidate {
  return {
    platform: 'weibo',
    accountId: 1, ruleIds: [1, 2], screenName: '2203177060', displayName: '渡瀬結月', type: 'mblog',
    text: '今晚九点直播！', pics: [], pubTs: 1_789_549_200,
    url: 'https://weibo.com/2203177060/Pa1bC',
    ...over,
  };
}

/** B站动态：账号标识是 uid、类型在 pipeline 归一成 dynamic/retweet */
function biliDynPost(over: Partial<PostCandidate> = {}): PostCandidate {
  return {
    platform: 'bili_dynamic',
    accountId: 1, ruleIds: [1, 2], screenName: '80397', displayName: '阿梓', type: 'dynamic',
    text: '今晚八点直播！', pics: [], pubTs: 1_789_549_200,
    url: 'https://t.bilibili.com/9001',
    ...over,
  };
}

function postRule(over: Partial<PostRule> = {}): PostRule {
  return {
    id: 1, name: 'r', channels: [1],
    filters: defaultPostFilters(), messageTemplate: null,
    llmJudge: false, judgePrompt: null, llmTranslate: false,
    enabled: true, sort: 0,
    createdAt: 0, updatedAt: 0,
    ...over,
  };
}

test('matchPostFilters：默认只推原创，转发不命中；勾了转发反过来', () => {
  const def = defaultPostFilters();
  assert.equal(matchPostFilters(def, post()), true);
  assert.equal(matchPostFilters(def, post({ type: 'retweet' })), false);

  const onlyRt = { ...def, original: false, retweet: true };
  assert.equal(matchPostFilters(onlyRt, post({ type: 'retweet' })), true);
  assert.equal(matchPostFilters(onlyRt, post()), false, '只推转发时原创不推');
});

test('matchPostFilters：原创与转发都勾 = 两类都推', () => {
  const both = { ...defaultPostFilters(), retweet: true };
  assert.equal(matchPostFilters(both, post()), true);
  assert.equal(matchPostFilters(both, post({ type: 'retweet' })), true);
});

test('matchPostFilters：必须带图 / 关键词（任一命中）/ 大小写不敏感', () => {
  const media = { ...defaultPostFilters(), media: true };
  assert.equal(matchPostFilters(media, post({ pics: [] })), false);
  assert.equal(matchPostFilters(media, post({ pics: ['https://pbs.twimg.com/media/a.jpg'] })), true);

  const kw = { ...defaultPostFilters(), keywords: ['歌回', 'LIVE'] };
  assert.equal(matchPostFilters(kw, post({ text: '今天休息' })), false);
  assert.equal(matchPostFilters(kw, post({ text: '今晚歌回！' })), true);
  assert.equal(matchPostFilters(kw, post({ text: 'going live now' })), true, '大小写不敏感');
  assert.equal(matchPostFilters(kw, post({ text: null })), false, '无正文不命中关键词');
});

test('matchPostFilters：quote 勾上要求来源确实标了引用（RSS 帖永不命中）', () => {
  const q = { ...defaultPostFilters(), quote: true };
  assert.equal(matchPostFilters(q, post()), false, '未知引用 = 不命中');
  assert.equal(matchPostFilters(q, post({ isQuote: false })), false);
  assert.equal(matchPostFilters(q, post({ isQuote: true })), true);
});

test('matchPostRules：账号侧 ruleIds 选用规则 + 筛选，返回全部命中（保持 sort 顺序）', () => {
  const rules = [
    postRule({ id: 1, sort: 0 }),
    postRule({ id: 2, sort: 1, filters: { ...defaultPostFilters(), media: true } }),
    postRule({ id: 3, sort: 2 }),
  ];
  assert.deepEqual(
    matchPostRules(rules, post({ ruleIds: [1] })).map((r) => r.id),
    [1],
    '账号没选用的规则不命中（规则 3 同理）',
  );
  assert.deepEqual(
    matchPostRules(rules, post({ ruleIds: [1, 2], pics: ['https://pbs.twimg.com/media/a.jpg'] })).map((r) => r.id),
    [1, 2],
    '有图时选用的两条都命中，顺序按 sort；ruleIds 为空 = 一律不推',
  );
  assert.deepEqual(matchPostRules(rules, post({ ruleIds: [] })), [], '账号不选用任何规则 = 不推');
});

test('renderPostTemplate：{author} {text} {url} {liver}', () => {
  assert.equal(
    renderPostTemplate('{author}｜{text}｜{url}', post()),
    '@watase_yuzuki｜今晚有直播｜https://x.com/watase_yuzuki/status/9001',
  );
  assert.equal(renderPostTemplate('{liver} 发帖了', post({ biliName: '阿梓' })), '阿梓 发帖了');
  assert.equal(
    renderPostTemplate('{liver} 发帖了', post()),
    '@watase_yuzuki 发帖了',
    '没关联主播时回退账号',
  );
  assert.equal(renderPostTemplate('{text}', post({ text: null })), '', '无正文渲染成空串');
});

// ---- 规则平台无关：任何平台的账号都可选用任何规则，命中只看 ruleIds + 机械筛选 ----

test('matchPostRules：规则不分平台，微博/B站帖命中同一条规则（账号侧选用即可）', () => {
  const rules = [postRule({ id: 1 }), postRule({ id: 2 })];
  assert.deepEqual(matchPostRules(rules, post({ ruleIds: [1] })).map((r) => r.id), [1], 'X 帖');
  assert.deepEqual(matchPostRules(rules, weiboPost({ ruleIds: [1] })).map((r) => r.id), [1], '微博帖命中同一条规则');
  assert.deepEqual(matchPostRules(rules, biliDynPost({ ruleIds: [1, 2] })).map((r) => r.id), [1, 2], 'B站动态帖同理');
  assert.deepEqual(matchPostRules(rules, weiboPost({ ruleIds: [] })), [], '账号不选用任何规则 = 不推');
});

test('matchPostRules：quote 规则对非 X 帖永不命中（isQuote undefined，是语义不是错误）', () => {
  const q = postRule({ id: 1, filters: { ...defaultPostFilters(), quote: true } });
  assert.deepEqual(matchPostRules([q], weiboPost({ ruleIds: [1] })), [], '微博没有引用形态');
  assert.deepEqual(matchPostRules([q], biliDynPost({ ruleIds: [1] })), [], 'B站动态没有引用形态');
  assert.deepEqual(matchPostRules([q], post({ ruleIds: [1], isQuote: true })).map((r) => r.id), [1], 'X 引用帖命中');
});

test('B站动态帖：作者名用展示名、uid 兜底；转发走同一套原创/转发筛选', () => {
  assert.equal(defaultPostTitle(biliDynPost()), '阿梓 发布新动态');
  assert.equal(
    renderPostTemplate('{author}', biliDynPost({ displayName: null })),
    '80397',
    '展示名缺省回退 uid（uid 对人没有意义，但至少不是空标题）',
  );
  // 转发（pipeline 已把 DYNAMIC_TYPE_FORWARD 归一成 retweet）走同一套原创/转发筛选
  assert.equal(matchPostFilters(defaultPostFilters(), biliDynPost({ type: 'retweet' })), false);
  assert.equal(
    matchPostFilters({ ...defaultPostFilters(), original: false, retweet: true }, biliDynPost({ type: 'retweet' })),
    true,
  );
});

test('微博帖文案：{author} 用昵称、缺昵称回退 uid；转发语义与 X 相同', () => {
  assert.equal(renderPostTemplate('{author} 发了新微博', weiboPost()), '渡瀬結月 发了新微博');
  assert.equal(
    renderPostTemplate('{author}', weiboPost({ displayName: null })),
    '2203177060',
    '昵称还没抓到（新账号）时用 uid，至少不是空标题',
  );
  assert.equal(defaultPostTitle(weiboPost()), '渡瀬結月 发布新微博');
  assert.equal(defaultPostTitle(post()), '@watase_yuzuki 发布新推文');
  assert.equal(
    defaultPostTitle(post({ displayName: '渡濑结月' })),
    '渡濑结月 @watase_yuzuki 发布新推文',
    'X 有显示名时标题带「显示名 @账号」',
  );
  // 微博的转发在抓取层折进 type='retweet'（正文带 //转发自），筛选语义与 X 一致
  assert.equal(matchPostFilters(defaultPostFilters(), weiboPost({ type: 'retweet' })), false);
  assert.equal(
    matchPostFilters({ ...defaultPostFilters(), original: false, retweet: true }, weiboPost({ type: 'retweet' })),
    true,
  );
});

// ---- aggregateRuleHits：命中规则 → 渠道并集 + 首个非空推送词（直播/图文共用纯聚合）----

test('aggregateRuleHits：无命中 → null；渠道并集去重保序', () => {
  assert.equal(aggregateRuleHits([]), null, '空命中 = 不推');
  assert.deepEqual(
    aggregateRuleHits([
      { channels: [2, 1], messageTemplate: null },
      { channels: [1, 3], messageTemplate: null },
    ]),
    { channels: [2, 1, 3], template: null },
    '并集按首次出现序去重，不重排',
  );
});

test('aggregateRuleHits：推送词取命中序首个非 null，之后不覆盖', () => {
  assert.equal(
    aggregateRuleHits([
      { channels: [1], messageTemplate: null },
      { channels: [2], messageTemplate: '模板 A' },
      { channels: [3], messageTemplate: '模板 B' },
    ])?.template,
    '模板 A',
    '跳过 null，取首个非 null（命中列表已按 sort 序）',
  );
  assert.equal(
    aggregateRuleHits([{ channels: [1], messageTemplate: null }])?.template,
    null,
    '全 null = 无推送词（缺省模板由调用方注入）',
  );
  assert.equal(
    aggregateRuleHits([
      { channels: [1], messageTemplate: '' },
      { channels: [2], messageTemplate: '模板 B' },
    ])?.template,
    '',
    '??= 语义：空串也算「已填」，不被后续覆盖（与旧内联实现逐字一致）',
  );
});

test('aggregateRuleHits：并集为空 → null（有命中、有推送词也一样 = 用户明确不推）', () => {
  assert.equal(aggregateRuleHits([{ channels: [], messageTemplate: '有词也没用' }]), null);
  assert.equal(
    aggregateRuleHits([{ channels: [] }, { channels: [], messageTemplate: 'x' }]),
    null,
  );
});

test('aggregateRuleHits：只要两字段的结构化约束（PushRule / PostRule 子集都能喂）', () => {
  const pushLike = rule({ channels: [7], messageTemplate: '{liver} 开播了' });
  const postLike = postRule({ channels: [8], messageTemplate: null });
  assert.deepEqual(aggregateRuleHits([pushLike, postLike]), {
    channels: [7, 8],
    template: '{liver} 开播了',
  });
});

// ---- 统一渲染器（renderByVars）：两个语义化入口共用一套实现，变量集互不串 ----

test('统一渲染器：同一占位符多处全替换、未知占位符原样保留', () => {
  assert.equal(
    renderTemplate('{liver} vs {liver}｜{unknown}', event()),
    '主播1 vs 主播1｜{unknown}',
  );
  assert.equal(
    renderPostTemplate('{author} 与 {author}｜{title}', post()),
    '@watase_yuzuki 与 @watase_yuzuki｜{title}',
    '{title} 不在图文变量集里，不渲染；{author} 是 replaceAll 语义',
  );
});

test('统一渲染器：{screenName} 变量 + 顺序替换语义与旧实现一致', () => {
  assert.equal(renderPostTemplate('@{screenName}', post()), '@watase_yuzuki');
  // 顺序替换：先替换出的取值里若含后续占位符，也会被后续替换（旧实现即如此，逐字保持）
  assert.equal(
    renderTemplate('{liver} 开播', event({ uname: '{title}', title: '歌回' })),
    '歌回 开播',
    '{liver} 展开成 "{title}" 后又被 {title} 替换',
  );
});
