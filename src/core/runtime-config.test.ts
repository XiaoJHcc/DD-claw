import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from './db.js';
import {
  getRuntimeConfig, saveRuntimeConfig, withRuntimeConfig,
  isNotifyOnFirstRun, isNotifyOnNewSubscription, getPostBacklogConfig,
  getLiveJudgeSelection, getLiveClassifyTiming, isLiveJudgeSelectionActive, isRuntimeConfigKey,
  NUM_SPECS, BOOL_SPECS,
} from './runtime-config.js';
import { defaultAppConfig } from '../config/schema.js';

function memDb(t: import('node:test').TestContext): Db {
  const db = new Db(':memory:');
  t.after(() => db.close());
  return db;
}

test('无 settings 时返回全部默认值', (t) => {
  const db = memDb(t);
  const rc = getRuntimeConfig(db);
  for (const s of NUM_SPECS) assert.equal(rc[s.field], s.def, s.key);
  for (const s of BOOL_SPECS) assert.equal(rc[s.field], s.def, s.key);
});

test('save/get 往返；库存越界值回落默认', (t) => {
  const db = memDb(t);
  saveRuntimeConfig(db, { healthAlertToastAfterSec: 300, notifyOnFirstRun: true });
  let rc = getRuntimeConfig(db);
  assert.equal(rc.healthAlertToastAfterSec, 300);
  assert.equal(rc.notifyOnFirstRun, true);

  db.setSetting('health_alert_toast_after_sec', '99999'); // 越界
  db.setSetting('poll_interval_sec', 'abc'); // 非数字
  rc = getRuntimeConfig(db);
  assert.equal(rc.healthAlertToastAfterSec, 180, '越界值回落默认');
  assert.equal(rc.pollIntervalSec, 45, '非法值回落默认');
});

test('旧的轮数口径键 health_alert_after_failures 开库即删（时间口径统一后只留一个键）', (t) => {
  const db = memDb(t);
  assert.equal(db.getSetting('health_alert_after_failures'), null, '构造时已清除');
  db.setSetting('health_alert_after_failures', '3'); // 模拟老库残留再开库的场景由构造覆盖，这里验证读不到
  assert.equal(getRuntimeConfig(db).healthAlertToastAfterSec, 180, '旧键不参与取值');
});

test('withRuntimeConfig：运行时参数覆盖回 AppConfig', (t) => {
  const db = memDb(t);
  const app = defaultAppConfig();
  saveRuntimeConfig(db, {
    pollIntervalSec: 99, dynamicIntervalSec: 200,
    llmRequestTimeoutMs: 5000,
    keyframeIntervalSec: 120, keyframeEnabled: false,
  });
  const eff = withRuntimeConfig(app, getRuntimeConfig(db));
  assert.equal(eff.pollIntervalSec, 99);
  assert.equal(eff.dynamic.intervalSec, 200);
  assert.equal(eff.llm.requestTimeoutMs, 5000);
  assert.deepEqual(eff.keyframe, { enabled: false, intervalSec: 120 }, 'keyframe 段叠加进 eff');
});

test('关键帧缓存参数：默认值、落库回读、越界回落', (t) => {
  const db = memDb(t);
  let rc = getRuntimeConfig(db);
  assert.equal(rc.keyframeEnabled, true);
  assert.equal(rc.keyframeIntervalSec, 300);

  saveRuntimeConfig(db, { keyframeEnabled: false, keyframeIntervalSec: 600 });
  rc = getRuntimeConfig(db);
  assert.equal(rc.keyframeEnabled, false);
  assert.equal(rc.keyframeIntervalSec, 600);

  db.setSetting('keyframe_interval_sec', '30'); // 低于下限 60
  rc = getRuntimeConfig(db);
  assert.equal(rc.keyframeIntervalSec, 300, '越界值回落默认');
});

test('冷启动推送开关 helper：默认与显式设置', (t) => {
  const db = memDb(t);
  assert.equal(isNotifyOnFirstRun(db), false);
  assert.equal(isNotifyOnNewSubscription(db), true);
  saveRuntimeConfig(db, { notifyOnFirstRun: true, notifyOnNewSubscription: false });
  assert.equal(isNotifyOnFirstRun(db), true);
  assert.equal(isNotifyOnNewSubscription(db), false);
});

test('getPostBacklogConfig：默认关/24h/10 条；settings 覆盖后直读生效（源每轮读，热生效）', (t) => {
  const db = memDb(t);
  assert.deepEqual(getPostBacklogConfig(db), { enabled: false, maxAgeSec: 21600, maxPerAccount: 3 });
  saveRuntimeConfig(db, { backlogPushEnabled: true, backlogMaxAgeHours: 48, backlogMaxPerAccount: 3 });
  assert.deepEqual(getPostBacklogConfig(db), { enabled: true, maxAgeSec: 172800, maxPerAccount: 3 });
});

test('决策模型参数：默认值 / 落库回读 / 越界回落 / 叠加进 AppConfig 的 decision 段', (t) => {
  const db = memDb(t);
  let rc = getRuntimeConfig(db);
  assert.deepEqual(
    [rc.decisionGrayLowPct, rc.decisionGrayHighPct, rc.decisionPrimaryMinPct,
      rc.decisionRequestTimeoutMs, rc.decisionCircuitThreshold, rc.decisionCircuitCooldownMs],
    [20, 80, 60, 30_000, 3, 600_000],
  );

  saveRuntimeConfig(db, {
    decisionGrayLowPct: 15, decisionGrayHighPct: 85, decisionPrimaryMinPct: 70,
    decisionRequestTimeoutMs: 45_000, decisionCircuitThreshold: 5, decisionCircuitCooldownMs: 900_000,
  });
  rc = getRuntimeConfig(db);
  assert.deepEqual(
    [rc.decisionGrayLowPct, rc.decisionGrayHighPct, rc.decisionPrimaryMinPct,
      rc.decisionRequestTimeoutMs, rc.decisionCircuitThreshold, rc.decisionCircuitCooldownMs],
    [15, 85, 70, 45_000, 5, 900_000],
  );
  assert.equal(db.getSetting('decision_gray_low_pct'), '15', 'settings 存整数百分数（无小数）');

  db.setSetting('decision_primary_min_pct', '101'); // 越界
  db.setSetting('decision_gray_high_pct', '0.8'); // 非整数
  rc = getRuntimeConfig(db);
  assert.equal(rc.decisionPrimaryMinPct, 60, '越界回落默认');
  assert.equal(rc.decisionGrayHighPct, 80, '非整数回落默认');

  const eff = withRuntimeConfig(defaultAppConfig(), rc);
  assert.deepEqual(eff.decision, {
    requestTimeoutMs: 45_000, circuitThreshold: 5, circuitCooldownMs: 900_000,
  }, '超时/熔断叠加进 AppConfig（灰区与主分类门槛由判定档直读）');
});

// ---- 直播分类时机（五时机 × 三档 + 三条时间口径）----

test('分类时机默认值：开播/变更走规则+决策，延迟三档全开，定时全关', (t) => {
  const db = memDb(t);
  assert.deepEqual(getLiveJudgeSelection(db, 'start'), { rule: true, decision: true, llm: false });
  assert.deepEqual(getLiveJudgeSelection(db, 'titleChange'), { rule: true, decision: true, llm: false });
  assert.deepEqual(getLiveJudgeSelection(db, 'startDelay'), { rule: true, decision: true, llm: true });
  assert.deepEqual(getLiveJudgeSelection(db, 'titleDelay'), { rule: true, decision: true, llm: true });
  assert.deepEqual(getLiveJudgeSelection(db, 'periodic'), { rule: false, decision: false, llm: false });
  assert.equal(isLiveJudgeSelectionActive(getLiveJudgeSelection(db, 'periodic')), false, '定时默认等于关闭');
  assert.equal(isLiveJudgeSelectionActive(getLiveJudgeSelection(db, 'start')), true);

  assert.deepEqual(getLiveClassifyTiming(db), { delaySec: 300, periodicSec: 1200, llmCooldownMin: 5 });
});

test('分类时机：落库回读、越界/非整数回落默认、单键直读不必重启', (t) => {
  const db = memDb(t);
  saveRuntimeConfig(db, {
    liveClassifyPeriodicLlm: true, liveClassifyStartLlm: true, liveClassifyTitleChangeRule: false,
    liveClassifyLlmCooldownMin: 0, liveClassifyDelayMin: 12, liveClassifyPeriodicMin: 45,
  });
  assert.deepEqual(getLiveJudgeSelection(db, 'periodic'), { rule: false, decision: false, llm: true });
  assert.deepEqual(getLiveJudgeSelection(db, 'start'), { rule: true, decision: true, llm: true });
  assert.deepEqual(getLiveJudgeSelection(db, 'titleChange'), { rule: false, decision: true, llm: false });
  assert.deepEqual(getLiveClassifyTiming(db), { delaySec: 720, periodicSec: 2700, llmCooldownMin: 0 },
    '冷却 0 = 不设冷却');

  db.setSetting('live_classify_periodic_min', '0'); // 低于下限 1
  db.setSetting('live_classify_delay_min', '3.5'); // 非整数
  const timing = getLiveClassifyTiming(db);
  assert.equal(timing.periodicSec, 1200, '越界回落默认 20 分钟');
  assert.equal(timing.delaySec, 300, '非整数回落默认 5 分钟');

  db.setSetting('live_classify_start_llm', 'x'); // 脏值
  assert.equal(getLiveJudgeSelection(db, 'start').llm, false, '脏值回落默认');
});

test('分类时机的 settings 键都在运行时参数规格表里（撤销热生效与 /api/advanced 校验都靠它）', () => {
  const keys = [...NUM_SPECS, ...BOOL_SPECS].map((s) => s.key);
  for (const trigger of ['start', 'start_delay', 'periodic', 'title_change', 'title_delay']) {
    for (const stage of ['rule', 'decision', 'llm']) {
      assert.ok(keys.includes(`live_classify_${trigger}_${stage}`), `缺键 live_classify_${trigger}_${stage}`);
    }
  }
  for (const key of ['live_classify_llm_cooldown_min', 'live_classify_delay_min', 'live_classify_periodic_min']) {
    assert.ok(keys.includes(key), `缺键 ${key}`);
    assert.equal(isRuntimeConfigKey(key), true);
  }
  assert.equal(isRuntimeConfigKey('live_classify_start_rule'), true);
  assert.equal(isRuntimeConfigKey('live_classify_start_llm'), true);
});

test('分类时机的字段名可由「时机 + 档位」机械拼出（面板 sheet 按这个约定生成 id 与提交体）', () => {
  const fields = BOOL_SPECS.map((s) => String(s.field));
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  for (const trigger of ['start', 'startDelay', 'periodic', 'titleChange', 'titleDelay']) {
    for (const stage of ['rule', 'decision', 'llm']) {
      const field = `liveClassify${cap(trigger)}${cap(stage)}`;
      assert.ok(fields.includes(field), `缺字段 ${field}（webui 的 timingFieldName 依赖这一约定）`);
    }
  }
});
