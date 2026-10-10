import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateRuleHits, defaultPostTitle, matchCategory, matchCategoryItem, matchRules,
  renderPostTemplate, renderTemplate,
  type PostCandidate,
} from './matcher.js';
import { fromLiveEvent, fromPostCandidate } from './content.js';
import type { LiveEvent } from '../core/types.js';
import type { Category, PushRule } from '../core/push.js';

function category(over: Partial<Category> = {}): Category {
  return {
    id: 1, name: '歌回', llmPrompt: null, keywords: [], areas: [],
    postTypes: [], requireQuote: false, requireMedia: false, appliesTo: 'live',
    condMode: 'and', enabled: true, createdAt: 0, updatedAt: 0,
    ...over,
  };
}

function rule(over: Partial<PushRule> = {}): PushRule {
  return {
    id: 1, name: '规则 1', subjectKind: 'live', categoryId: null, scope: [], channels: [],
    messageTemplate: null, llmTranslate: false, enabled: true, createdBy: null,
    createdAt: 0, updatedAt: 0,
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

// ---- matchCategoryItem：post 条件组（postType / quote / media 算子）----

test('postType 组：type 折叠后 original/retweet 命中对应勾选', () => {
  const orig = category({ appliesTo: 'post', postTypes: ['original'] });
  assert.equal(matchCategoryItem(orig, fromPostCandidate(post())).matched, true);
  assert.equal(matchCategoryItem(orig, fromPostCandidate(post({ type: 'retweet' }))).matched, false);
  const rt = category({ appliesTo: 'post', postTypes: ['retweet'] });
  assert.equal(matchCategoryItem(rt, fromPostCandidate(post({ type: 'retweet' }))).matched, true);
  assert.equal(matchCategoryItem(rt, fromPostCandidate(post())).matched, false);
  const both = category({ appliesTo: 'post', postTypes: ['original', 'retweet'] });
  assert.equal(matchCategoryItem(both, fromPostCandidate(post())).matched, true);
  assert.equal(matchCategoryItem(both, fromPostCandidate(post({ type: 'retweet' }))).matched, true);
});

test('quote 组：isQuote 三态——unknown/明确否不命中（沿用旧 quote 语义）', () => {
  const q = category({ appliesTo: 'post', requireQuote: true });
  assert.equal(matchCategoryItem(q, fromPostCandidate(post())).matched, false, '未知引用 = 不命中');
  assert.equal(matchCategoryItem(q, fromPostCandidate(post({ isQuote: false }))).matched, false);
  assert.equal(matchCategoryItem(q, fromPostCandidate(post({ isQuote: true }))).matched, true);
  assert.equal(
    matchCategoryItem(q, fromPostCandidate(post({ isQuote: true }))).evidence, '命中引用帖',
  );
});

test('media 组：hasMedia 由 pics 推出', () => {
  const m = category({ appliesTo: 'post', requireMedia: true });
  assert.equal(matchCategoryItem(m, fromPostCandidate(post({ pics: [] }))).matched, false);
  assert.equal(
    matchCategoryItem(m, fromPostCandidate(post({ pics: ['https://pbs.twimg.com/media/a.jpg'] }))).matched,
    true,
  );
});

test('post 多组：condMode 统辖 post_types/quote/media/keywords（空组忽略）', () => {
  const and = category({
    appliesTo: 'post', postTypes: ['original'], requireMedia: true,
    keywords: ['歌回'], condMode: 'and',
  });
  const hit = post({ text: '今晚歌回', pics: ['a.jpg'] });
  assert.equal(matchCategoryItem(and, fromPostCandidate(hit)).matched, true);
  assert.equal(matchCategoryItem(and, fromPostCandidate(hit, ['data:...'])).evidence,
    '命中关键词「歌回」、类型「原创」、带图');
  assert.equal(matchCategoryItem(and, fromPostCandidate(post({ text: '今晚歌回', pics: [] }))).matched, false);
  assert.equal(
    matchCategoryItem(and, fromPostCandidate(post({ text: '随便', pics: ['a.jpg'] }))).matched, false,
  );
  const or = category({ appliesTo: 'post', postTypes: ['retweet'], requireMedia: true, condMode: 'or' });
  assert.equal(matchCategoryItem(or, fromPostCandidate(post({ pics: ['a.jpg'] }))).matched, true, '带图命中即可');
  assert.equal(matchCategoryItem(or, fromPostCandidate(post({ type: 'retweet' }))).matched, true, '转发命中即可');
});

test('live 分类的 areas 组对 post 项不命中；post 算子对 live 项不命中（按 appliesTo 过滤）', () => {
  const liveCat = category({ areas: ['虚拟主播'] });
  assert.equal(matchCategoryItem(liveCat, fromPostCandidate(post())).matched, false, 'area 算子不适用 post');
  const postCat = category({ appliesTo: 'post', requireMedia: true });
  assert.equal(matchCategoryItem(postCat, fromLiveEvent(event())).matched, false, 'media 算子不适用 live');
});

// ---- matchRules：两形态统一的规则命中（live=uid / post=账号引用）----

test('categoryId 为 null = 任意内容都命中', () => {
  const any = rule({ categoryId: null });
  assert.deepEqual(matchRules([any], { subjectType: 'live' }, new Set(), 'u1'), [any], '无分类判定也命中');
  assert.deepEqual(matchRules([any], { subjectType: 'live' }, new Set([1]), 'u1'), [any]);
});

test('categoryId 非空 = 该内容须判定属于此分类', () => {
  const r = rule({ categoryId: 7 });
  assert.deepEqual(matchRules([r], { subjectType: 'live' }, new Set([7]), 'u1'), [r]);
  assert.deepEqual(matchRules([r], { subjectType: 'live' }, new Set([1, 2]), 'u1'), [], '不在判定集合里不命中');
  assert.deepEqual(matchRules([r], { subjectType: 'live' }, new Set(), 'u1'), []);
});

test('scope 空 = 全部生效（含未来新增）；非空 = 仅名单内', () => {
  const all = rule({ scope: [] });
  assert.deepEqual(matchRules([all], { subjectType: 'live' }, new Set(), '任何人'), [all]);
  const some = rule({ scope: ['u1', 'u2'] });
  assert.deepEqual(matchRules([some], { subjectType: 'live' }, new Set(), 'u2'), [some]);
  assert.deepEqual(matchRules([some], { subjectType: 'live' }, new Set(), 'u3'), []);
});

test('分类与生效范围两个条件 AND：只满足一个不命中', () => {
  const r = rule({ categoryId: 7, scope: ['u1'] });
  assert.deepEqual(matchRules([r], { subjectType: 'live' }, new Set([7]), 'u1'), [r]);
  assert.deepEqual(matchRules([r], { subjectType: 'live' }, new Set(), 'u1'), [], '分类不满足');
  assert.deepEqual(matchRules([r], { subjectType: 'live' }, new Set([7]), 'u9'), [], '主体不满足');
});

test('subjectKind 过滤：live 规则不吃 post 内容，反之亦然', () => {
  const liveRule = rule({ subjectKind: 'live', categoryId: null });
  const postRule_ = rule({ id: 2, subjectKind: 'post', categoryId: null });
  assert.deepEqual(matchRules([liveRule, postRule_], { subjectType: 'live' }, new Set(), 'u1'), [liveRule]);
  assert.deepEqual(matchRules([liveRule, postRule_], { subjectType: 'post' }, new Set(), 'twitter:aaa'), [postRule_]);
});

test('post 规则 scope = 账号引用（platform:key），空 = 全部账号', () => {
  const scoped = rule({ subjectKind: 'post', scope: ['twitter:aaa', 'weibo:123', 'bili:456'] });
  assert.deepEqual(matchRules([scoped], { subjectType: 'post' }, new Set(), 'twitter:aaa'), [scoped]);
  assert.deepEqual(matchRules([scoped], { subjectType: 'post' }, new Set(), 'weibo:123'), [scoped]);
  assert.deepEqual(matchRules([scoped], { subjectType: 'post' }, new Set(), 'bili:456'), [scoped]);
  assert.deepEqual(matchRules([scoped], { subjectType: 'post' }, new Set(), 'twitter:bbb'), []);
  const anyAcct = rule({ subjectKind: 'post', scope: [] });
  assert.deepEqual(matchRules([anyAcct], { subjectType: 'post' }, new Set(), 'twitter:任何人'), [anyAcct]);
});

test('多条规则全部命中都返回，保持传入顺序', () => {
  const first = rule({ id: 1 });
  const second = rule({ id: 2, categoryId: 3 });
  const third = rule({ id: 3, categoryId: 9 });
  assert.deepEqual(
    matchRules([first, second, third], { subjectType: 'live' }, new Set([3]), 'u1'),
    [first, second], '未命中的不参与，顺序不变',
  );
  assert.deepEqual(matchRules([], { subjectType: 'live' }, new Set(), 'u1'), []);
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

// ---- 图文帖（X/推特 + 微博 + B站动态）：PostCandidate 载体与文案渲染 ----

function post(over: Partial<PostCandidate> = {}): PostCandidate {
  return {
    platform: 'twitter',
    accountId: 1, screenName: 'watase_yuzuki', type: 'tweet', text: '今晚有直播',
    pics: [], pubTs: 1_789_549_200, url: 'https://x.com/watase_yuzuki/status/9001',
    ...over,
  };
}

/** 微博帖：账号标识是数字 uid、展示名是昵称、类型是 mblog */
function weiboPost(over: Partial<PostCandidate> = {}): PostCandidate {
  return {
    platform: 'weibo',
    accountId: 1, screenName: '2203177060', displayName: '渡瀬結月', type: 'mblog',
    text: '今晚九点直播！', pics: [], pubTs: 1_789_549_200,
    url: 'https://weibo.com/2203177060/Pa1bC',
    ...over,
  };
}

/** B站动态：账号标识是 uid、类型在 pipeline 归一成 dynamic/retweet */
function biliDynPost(over: Partial<PostCandidate> = {}): PostCandidate {
  return {
    platform: 'bili_dynamic',
    accountId: 1, screenName: '80397', displayName: '阿梓', type: 'dynamic',
    text: '今晚八点直播！', pics: [], pubTs: 1_789_549_200,
    url: 'https://t.bilibili.com/9001',
    ...over,
  };
}

// 旧「机械筛选」（matchPostFilters）与「账号 ruleIds 选用」（matchPostRules）已随 P2 退役：
// 筛选条件上移进分类条件组（postType/quote/media/keyword 算子，见上方 matchCategoryItem 段），
// 命中改走 matchRules（分类判定 × 规则 scope）。

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

// ---- 跨平台语义：分类条件对三平台统一生效（quote 例外：只有 X 帖能标引用）----

test('post 分类条件不分平台：同一条分类判三平台的帖子（命中只看分类条件 × 规则 scope）', () => {
  const cat = category({ appliesTo: 'post', postTypes: ['original', 'retweet'] });
  assert.equal(matchCategoryItem(cat, fromPostCandidate(post())).matched, true, 'X 帖');
  assert.equal(matchCategoryItem(cat, fromPostCandidate(weiboPost())).matched, true, '微博帖');
  assert.equal(matchCategoryItem(cat, fromPostCandidate(biliDynPost())).matched, true, 'B站动态帖');
});

test('require_quote 分类对非 X 帖永不命中（isQuote undefined，是语义不是错误）', () => {
  const q = category({ appliesTo: 'post', requireQuote: true });
  assert.equal(matchCategoryItem(q, fromPostCandidate(weiboPost())).matched, false, '微博没有引用形态');
  assert.equal(matchCategoryItem(q, fromPostCandidate(biliDynPost())).matched, false, 'B站动态没有引用形态');
  assert.equal(matchCategoryItem(q, fromPostCandidate(post({ isQuote: true }))).matched, true, 'X 引用帖命中');
});

test('B站动态帖：作者名用展示名、uid 兜底；转发在投影时折叠成 retweet', () => {
  assert.equal(defaultPostTitle(biliDynPost()), '阿梓 发布新动态');
  assert.equal(
    renderPostTemplate('{author}', biliDynPost({ displayName: null })),
    '80397',
    '展示名缺省回退 uid（uid 对人没有意义，但至少不是空标题）',
  );
  // 转发（pipeline 已把 DYNAMIC_TYPE_FORWARD 归一成 retweet）投影成 type='retweet'
  assert.equal(fromPostCandidate(biliDynPost({ type: 'retweet' })).tags.type, 'retweet');
  assert.equal(fromPostCandidate(biliDynPost()).tags.type, 'original', '其余折叠成原创');
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
  // 微博的转发在抓取层折进 type='retweet'（正文带 //转发自），投影语义与 X 一致
  assert.equal(fromPostCandidate(weiboPost({ type: 'retweet' })).tags.type, 'retweet');
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

test('aggregateRuleHits：只要两字段的结构化约束（live / post 规则子集都能喂）', () => {
  const pushLike = rule({ channels: [7], messageTemplate: '{liver} 开播了' });
  const postLike = rule({ id: 2, subjectKind: 'post', channels: [8], messageTemplate: null });
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
