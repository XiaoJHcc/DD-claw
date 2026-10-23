import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from './db.js';
import {
  getRuntimeConfig, saveRuntimeConfig, withRuntimeConfig,
  isNotifyOnFirstRun, isNotifyOnNewSubscription, getPostBacklogConfig,
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
