import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDecisionRequest, parseDecisionResponse, primaryKeyMap, DEFAULT_DECISION_THRESHOLDS,
} from './decide.js';
import type { ContentItem } from '../content.js';
import type { ClassifyCategory } from './classify.js';
import type { SystemOneAnswer, SystemOneResponse } from '../decision-providers.js';

function item(over: Partial<ContentItem> = {}): ContentItem {
  return {
    subjectType: 'live', subjectId: 'r1:1', uid: '1', authorName: '主播1',
    text: '今晚歌回！', tags: { area: '虚拟Singer', parentArea: '虚拟主播' },
    imageUrls: [], url: 'https://live.bilibili.com/1', ts: 1, ...over,
  };
}

const CATS: ClassifyCategory[] = [
  { id: 1, name: '歌回', prompt: '在以唱歌为主的直播' },
  { id: 2, name: '游戏', prompt: '在打游戏的直播' },
];

const IMG = 'data:image/jpeg;base64,QUJD';

/** 精确模式分类：两条正向 + 一条负向（稳定 id 是逐条概率的锚点） */
const PRECISE: ClassifyCategory = {
  id: 5, name: '歌回', prompt: '', judgeMode: 'precise',
  positives: [
    { id: 'p1', text: '标题或画面在以唱歌为主' },
    { id: 'p2', text: '分区是唱见或 singer' },
  ],
  negatives: [{ id: 'n1', text: '明确在玩单机游戏' }],
};

/** 精确分类的合规响应：逐条件给概率（缺任一条件 = 整份失败） */
function preciseAnswers(p: [number, number], n: number[]): Record<string, SystemOneAnswer> {
  const answers: Record<string, SystemOneAnswer> = {};
  PRECISE.positives!.forEach((c, i) => { answers[`c5:${c.id}`] = { type: 'noul', noul: p[i]! }; });
  PRECISE.negatives!.forEach((c, i) => { answers[`c5:${c.id}`] = { type: 'noul', noul: n[i]! }; });
  return answers;
}

/** 按题目 id 拼一份合规响应 */
function response(
  answers: Record<string, SystemOneAnswer>,
  model = 'jev-1.13.0',
): SystemOneResponse {
  return { model, answers };
}

// ---- 请求构造 ----

test('buildDecisionRequest：直播 state 只放抓取事实，判定描述进 instructions', () => {
  const { req, assets } = buildDecisionRequest(item(), CATS, undefined, 'jev-1.14.0', false);
  assert.equal(req.model, 'jev-1.14.0');
  assert.deepEqual(req.state, {
    主播: '主播1', 标题: '今晚歌回！', 分区: '虚拟主播 / 虚拟Singer',
  });
  assert.equal(assets, undefined, '无图不带 assets');
  assert.deepEqual(Object.keys(req.questions), ['c1', 'c2']);
  assert.deepEqual(req.questions['c1'], {
    type: 'noul', instructions: '这条内容是否属于「歌回」？判定标准：在以唱歌为主的直播',
  });
  // 抓取文本只进 state：不进任何问句
  assert.doesNotMatch(JSON.stringify(req.questions), /今晚歌回/);
});

test('buildDecisionRequest：图文 state 带类型 / 引用 / 正文，空正文写明只有图', () => {
  const base = item({
    subjectType: 'post', subjectId: 'twitter:1', tags: {
      type: 'retweet', isQuote: 'unknown', hasMedia: 'true', platform: 'twitter',
    },
  });
  const { req } = buildDecisionRequest(base, CATS, undefined, 'm', false);
  assert.deepEqual(req.state, {
    作者: '主播1', 平台: 'twitter', 类型: '转发', 引用: '未知', 正文: '今晚歌回！',
  });
  const empty = buildDecisionRequest({ ...base, text: '' }, CATS, undefined, 'm', false);
  assert.equal((empty.req.state as Record<string, unknown>).正文, '（无正文，仅图片）');
});

test('buildDecisionRequest：含图时 assets 是被 state 引用的完整集合（纯 base64，无 data: 前缀）', () => {
  // 直播：只发一张画面，state 的 `画面` 与唯一的 asset ref 对应
  const live = buildDecisionRequest(
    { ...item(), imageUrls: [IMG, 'data:image/jpeg;base64,REVG'] },
    CATS, undefined, 'm', true,
  );
  const liveRefs = Object.keys(live.assets!);
  assert.equal(liveRefs.length, 1, '直播只发一张画面');
  assert.equal((live.req.state as Record<string, unknown>).画面, liveRefs[0]);
  assert.equal(live.assets![liveRefs[0]!]!.data_base64, 'QUJD');
  for (const ref of liveRefs) {
    assert.equal(live.assets![ref]!.type, 'image');
    assert.equal(live.assets![ref]!.format, 'jpg');
    assert.doesNotMatch(live.assets![ref]!.data_base64, /^data:/, '只发纯 base64');
  }

  // 图文：每张配图一个 ref，全部被 state 的 `配图` 引用（Jev 对未被引用的 asset 直接 400）
  const post = buildDecisionRequest(
    { ...item({ subjectType: 'post', subjectId: 'twitter:1' }), imageUrls: [IMG, 'data:image/jpeg;base64,REVG'] },
    CATS, undefined, 'm', true,
  );
  const postRefs = Object.keys(post.assets!);
  assert.equal(postRefs.length, 2);
  assert.deepEqual(postRefs.map((r) => post.assets![r]!.data_base64), ['QUJD', 'REVG']);
  assert.deepEqual((post.req.state as Record<string, unknown>).配图, postRefs, '配图 ref 数组');
});

test('buildDecisionRequest：拿不到 base64 的图不发（按无图处理），非图片内容不进请求', () => {
  const { assets, req } = buildDecisionRequest(
    { ...item(), imageUrls: ['https://i0.hdslb.com/keyframe.jpg'] }, CATS, undefined, 'm', true,
  );
  assert.equal(assets, undefined);
  assert.equal((req.state as Record<string, unknown>).画面, undefined, '远程 URL 绝不进 state');
});

test('buildDecisionRequest：主分类一道 choice，重名追加 #id，「其他」冲突改 #0', () => {
  const options: ClassifyCategory[] = [
    { id: 1, name: '歌回', prompt: '唱歌' },
    { id: 2, name: '歌回', prompt: '同名但不同分类' },
    { id: 3, name: '其他', prompt: '名字正好叫其他' },
  ];
  const { req, keyMap } = buildDecisionRequest(item(), CATS, options, 'm', false);
  assert.deepEqual(keyMap, {
    '歌回': 1, '歌回#2': 2, '其他#3': 3, '其他': 0,
  });
  const q = req.questions.primary!;
  assert.equal(q.type, 'choice');
  assert.equal(q.instructions, '这条内容最像下面哪一项？');
  assert.deepEqual(Object.keys(q.criteria!), ['歌回', '歌回#2', '其他#3', '其他']);
  assert.equal(q.criteria!['其他'], '不属于以上任何一项');
  assert.equal(q.criteria!['歌回#2'], '同名但不同分类');
});

test('primaryKeyMap：无冲突时键就是分类名，末项「其他」', () => {
  assert.deepEqual(primaryKeyMap(CATS), { 歌回: 1, 游戏: 2, 其他: 0 });
});

// ---- 解析 ----

const TH = DEFAULT_DECISION_THRESHOLDS; // 0.2 / 0.8 / 0.6
const META = { providerName: 'Jev', model: 'jev-1.13.0', textOnlyForImageItem: false };

test('parseDecisionResponse：高 p / 低 p 定案，灰区落库不定案；confidence = p，evidence 带回答者', () => {
  const out = parseDecisionResponse(response({
    c1: { type: 'noul', noul: 0.93 },
    c2: { type: 'noul', noul: 0.55 },
    c3: { type: 'noul', noul: 0.05 },
  }), [...CATS, { id: 3, name: '杂谈', prompt: '聊天' }], undefined, {}, TH, META);

  assert.deepEqual(out.results.map((r) => [r.categoryId, r.pass, r.confidence, r.effective]), [
    [1, true, 0.93, false], [2, true, 0.55, false], [3, false, 0.05, false],
  ]);
  assert.deepEqual([...out.decided].sort(), [1, 3], '灰区（0.55）不定案');
  assert.equal(out.results[0]!.source, 'decision');
  assert.equal(out.results[0]!.evidence, 'Jev · jev-1.13.0');
  assert.match(out.results[1]!.evidence, /灰区 p=0\.55/);
  assert.equal(out.primary, null);
  assert.equal(out.primaryDecided, false);
});

test('parseDecisionResponse：纯文本供应商对带图内容一律不定案（结论仍返回）', () => {
  const out = parseDecisionResponse(response({
    c1: { type: 'noul', noul: 0.99 },
    c2: { type: 'noul', noul: 0.99 },
  }), CATS, undefined, {}, TH, { ...META, textOnlyForImageItem: true });
  assert.deepEqual([...out.decided], []);
  assert.match(out.results[0]!.evidence, /纯文本供应商未看图/);
  assert.equal(out.results[0]!.pass, true);
});

test('parseDecisionResponse：缺题 / 类型不符 / 数值越界都整份失败', () => {
  assert.throws(
    () => parseDecisionResponse(response({ c1: { type: 'noul', noul: 0.9 } }), CATS, undefined, {}, TH, META),
    /缺少分类 2/,
  );
  assert.throws(
    () => parseDecisionResponse(response({
      c1: { type: 'choice', choice: 'x', probabilities: {} },
      c2: { type: 'noul', noul: 0.1 },
    }), CATS, undefined, {}, TH, META),
    /不是 noul/,
  );
  for (const bad of [1.2, -0.1, Number.NaN]) {
    assert.throws(
      () => parseDecisionResponse(response({
        c1: { type: 'noul', noul: bad as number }, c2: { type: 'noul', noul: 0.1 },
      }), CATS, undefined, {}, TH, META),
      /0–1 的数值/,
    );
  }
  assert.throws(() => parseDecisionResponse(response({}), CATS, undefined, {}, TH, META), /缺少分类/);
});

test('parseDecisionResponse：主分类按概率分布定案，低于门槛不定案；「其他」映射 0', () => {
  const keyMap = primaryKeyMap(CATS);
  const decided = parseDecisionResponse(response({
    c1: { type: 'noul', noul: 0.9 },
    c2: { type: 'noul', noul: 0.1 },
    primary: { type: 'choice', choice: '歌回', probabilities: { 歌回: 0.7, 游戏: 0.2, 其他: 0.1 } },
  }), CATS, CATS, keyMap, TH, META);
  assert.deepEqual(
    [decided.primary!.categoryId, decided.primary!.name, decided.primary!.source, decided.primaryDecided],
    [1, '歌回', 'decision', true],
  );
  assert.deepEqual(decided.primary!.distribution, { 歌回: 0.7, 游戏: 0.2, 其他: 0.1 });
  assert.equal(decided.primary!.effective, false, 'effective 由编排器填');

  const low = parseDecisionResponse(response({
    c1: { type: 'noul', noul: 0.9 },
    c2: { type: 'noul', noul: 0.1 },
    primary: { type: 'choice', choice: '歌回', probabilities: { 歌回: 0.55, 游戏: 0.45 } },
  }), CATS, CATS, keyMap, TH, META);
  assert.equal(low.primaryDecided, false);
  assert.match(low.primary!.evidence, /低于主分类门槛/);

  const other = parseDecisionResponse(response({
    c1: { type: 'noul', noul: 0.9 },
    c2: { type: 'noul', noul: 0.1 },
    primary: { type: 'choice', choice: '其他', probabilities: { 歌回: 0.2, 游戏: 0.2, 其他: 0.6 } },
  }), CATS, CATS, keyMap, TH, META);
  assert.deepEqual([other.primary!.categoryId, other.primary!.name, other.primaryDecided], [0, '其他', true]);
});

test('parseDecisionResponse：主分类答案不合契约（未知键 / probabilities 不是对象 / 全未知选项）都失败', () => {
  const keyMap = primaryKeyMap(CATS);
  const base = { c1: { type: 'noul', noul: 0.9 }, c2: { type: 'noul', noul: 0.1 } } as Record<string, SystemOneAnswer>;
  assert.throws(
    () => parseDecisionResponse(response({
      ...base, primary: { type: 'choice', choice: '乱答', probabilities: { 歌回: 0.9 } },
    }), CATS, CATS, keyMap, TH, META),
    /选项未知/,
  );
  assert.throws(
    () => parseDecisionResponse(response({
      ...base, primary: { type: 'choice', choice: '歌回', probabilities: [1] as never },
    }), CATS, CATS, keyMap, TH, META),
    /probabilities 对象/,
  );
  assert.throws(
    () => parseDecisionResponse(response({
      ...base, primary: { type: 'choice', choice: '歌回', probabilities: { 编造: 0.9 } },
    }), CATS, CATS, keyMap, TH, META),
    /没有任何请求过的选项/,
  );
  assert.throws(
    () => parseDecisionResponse(response({ ...base }), CATS, CATS, keyMap, TH, META),
    /缺少主分类答案/,
  );
});

test('parseDecisionResponse：未请求主分类时不产出主分类结论', () => {
  const out = parseDecisionResponse(response({
    c1: { type: 'noul', noul: 0.9 }, c2: { type: 'noul', noul: 0.1 },
    primary: { type: 'choice', choice: '歌回', probabilities: { 歌回: 1 } },
  }), CATS, undefined, {}, TH, META);
  assert.equal(out.primary, null, '没问主分类就不采纳模型多给的主分类答案');
});

// ---- 精确模式：逐条件一道题，逐条件裁决 ----

test('buildDecisionRequest：精确分类每个启用条件一道 noul，问句引用字段与条件原文', () => {
  const { req } = buildDecisionRequest(item(), [PRECISE], undefined, 'm', false);
  assert.deepEqual(Object.keys(req.questions), ['c5:p1', 'c5:p2', 'c5:n1'], '一条条件一道题，正向在前');
  assert.equal(req.questions['c5:p1']!.type, 'noul');
  const q = (req.questions['c5:p1'] as { instructions: string }).instructions;
  assert.match(q, /`标题`/, '问句指称 state 字段');
  assert.match(q, /标题或画面在以唱歌为主/, '条件原文整体进问句');
  assert.doesNotMatch(q, /分区是唱见/, '不同条件不拼进同一道问句');
  assert.doesNotMatch(q, /是否属于「歌回」/, '精确模式不问整体是否属于');
  // 抓取内容只进 state，不进问句
  assert.doesNotMatch(JSON.stringify(req.questions), /今晚歌回/);
});

test('buildDecisionRequest：精确分类的主分类 criteria 用正向条件组合，不拿判定描述', () => {
  const mixed: ClassifyCategory = { ...PRECISE, prompt: '这段判定描述在精确模式不该被用' };
  const { req, keyMap } = buildDecisionRequest(item(), [], [mixed], 'm', false);
  assert.deepEqual(keyMap, { 歌回: 5, 其他: 0 });
  assert.equal(req.questions.primary!.criteria!['歌回'], '标题或画面在以唱歌为主 或 分区是唱见或 singer');
});

test('buildDecisionRequest：主分类选项缺有效口径时拒绝组题（不让残缺选项集提前定案）', () => {
  const broken: ClassifyCategory = { id: 6, name: '空精确分类', prompt: '', judgeMode: 'precise', positives: [] };
  assert.throws(
    () => buildDecisionRequest(item(), [], [PRECISE, broken], 'm', false),
    /没有可用的判定条件/,
  );
});

test('parseDecisionResponse 精确：负向成立即否决，即使正向很强', () => {
  const out = parseDecisionResponse(response(preciseAnswers([0.95, 0.9], [0.9])),
    [PRECISE], undefined, {}, TH, META);
  const row = out.results[0]!;
  assert.deepEqual([row.categoryId, row.pass, row.source], [5, false, 'decision']);
  assert.equal(row.confidence, null, '精确模式不合成伪最终概率');
  assert.ok(out.decided.has(5), '负向明确成立 = 定案');
  assert.match(row.evidence, /负向条件「明确在玩单机游戏」成立 p=0\.90，判否/);
  assert.deepEqual(out.conditionResults!.map((c) => [c.conditionId, c.direction, c.p]), [
    ['p1', 'pass', 0.95], ['p2', 'pass', 0.9], ['n1', 'reject', 0.9],
  ], '逐条件 id / 方向 / 概率全部回传');
  const veto = out.conditionResults!.find((c) => c.conditionId === 'n1')!;
  assert.deepEqual([veto.text, veto.band, veto.decisive], ['明确在玩单机游戏', 'high', true]);
  assert.ok(out.conditionResults!.filter((c) => c.direction === 'pass').every((c) => !c.decisive));
});

test('parseDecisionResponse 精确：全部正向都不成立即判否；无负向视作全部不成立', () => {
  const noNeg: ClassifyCategory = { ...PRECISE, negatives: [] };
  const out = parseDecisionResponse(response({
    ...preciseAnswers([0.1, 0.05], []),
  }), [noNeg], undefined, {}, TH, META);
  assert.equal(out.results[0]!.pass, false);
  assert.ok(out.decided.has(5));
  assert.match(out.results[0]!.evidence, /全部正向条件都不成立/);
  assert.equal(out.conditionResults!.length, 2, '只记存在的条件');
});

test('parseDecisionResponse 精确：正向成立且负向全不成立 → 判是定案', () => {
  const out = parseDecisionResponse(response(preciseAnswers([0.85, 0.3], [0.1])),
    [PRECISE], undefined, {}, TH, META);
  assert.equal(out.results[0]!.pass, true);
  assert.ok(out.decided.has(5));
  assert.match(out.results[0]!.evidence, /判是/);
  assert.match(out.results[0]!.evidence, /「明确在玩单机游戏」p=0\.10/, '逐条件概率进证据');
});

test('parseDecisionResponse 精确：灰区不定案（正向偏中 / 强正向下负向未排除）', () => {
  // ① 正向都偏中、负向低：没有强正向证据
  const mid = parseDecisionResponse(response(preciseAnswers([0.5, 0.6], [0.1])),
    [PRECISE], undefined, {}, TH, META);
  assert.equal(mid.decided.size, 0);
  assert.equal(mid.results[0]!.pass, false, '灰区的 pass 只是倾向标记');
  assert.match(mid.results[0]!.evidence, /灰区未定案/);

  // ② 有强正向但负向落在灰区：不定案，倾向「是」
  const leaning = parseDecisionResponse(response(preciseAnswers([0.9, 0.1], [0.5])),
    [PRECISE], undefined, {}, TH, META);
  assert.equal(leaning.decided.size, 0);
  assert.equal(leaning.results[0]!.pass, true, '有强正向证据 → 倾向标记为 true');
});

test('parseDecisionResponse 精确：缺条件答案 / 非 noul / 越界都整份失败', () => {
  const missing = preciseAnswers([0.9, 0.9], [0.1]);
  delete missing['c5:p2'];
  assert.throws(() => parseDecisionResponse(response(missing), [PRECISE], undefined, {}, TH, META),
    /条件「分区是唱见或 singer」的答案/);
  assert.throws(
    () => parseDecisionResponse(response({
      ...preciseAnswers([0.9, 0.9], [0.1]),
      'c5:n1': { type: 'choice', choice: 'x', probabilities: {} },
    }), [PRECISE], undefined, {}, TH, META),
    /不是 noul/,
  );
  assert.throws(
    () => parseDecisionResponse(response({
      ...preciseAnswers([0.9, 0.9], [0.1]),
      'c5:p1': { type: 'noul', noul: 1.4 },
    }), [PRECISE], undefined, {}, TH, META),
    /0–1 的数值/,
  );
});

test('parseDecisionResponse 精确：纯文本供应商对带图内容不定案（结论与逐条件概率仍回传）', () => {
  const out = parseDecisionResponse(response(preciseAnswers([0.95, 0.95], [0.05])),
    [PRECISE], undefined, {}, TH, { ...META, textOnlyForImageItem: true });
  assert.equal(out.decided.size, 0);
  assert.equal(out.results[0]!.pass, true);
  assert.match(out.results[0]!.evidence, /纯文本供应商未看图/);
  assert.equal(out.conditionResults!.length, 3);
  assert.ok(out.conditionResults!.every((c) => !c.decisive), '未看图时没有任何条件实际促成定案');
});
