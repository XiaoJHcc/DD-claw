import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from './db.js';
import {
  getRuntimeConfig, saveRuntimeConfig, withRuntimeConfig,
  isNotifyOnFirstRun, isNotifyOnNewSubscription,
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
  saveRuntimeConfig(db, { healthAlertAfterFailures: 10, notifyOnFirstRun: true });
  let rc = getRuntimeConfig(db);
  assert.equal(rc.healthAlertAfterFailures, 10);
  assert.equal(rc.notifyOnFirstRun, true);

  db.setSetting('health_alert_after_failures', '99999'); // 越界
  db.setSetting('poll_interval_sec', 'abc'); // 非数字
  rc = getRuntimeConfig(db);
  assert.equal(rc.healthAlertAfterFailures, 5, '越界值回落默认');
  assert.equal(rc.pollIntervalSec, 45, '非法值回落默认');
});

test('withRuntimeConfig：运行时参数覆盖回 AppConfig', (t) => {
  const db = memDb(t);
  const app = defaultAppConfig();
  saveRuntimeConfig(db, {
    pollIntervalSec: 99, dynamicIntervalSec: 200,
    llmRequestTimeoutMs: 5000, notifierOnebotEnabled: true,
  });
  const eff = withRuntimeConfig(app, getRuntimeConfig(db));
  assert.equal(eff.pollIntervalSec, 99);
  assert.equal(eff.dynamic.intervalSec, 200);
  assert.equal(eff.llm.requestTimeoutMs, 5000);
  assert.equal(eff.notify.onebot.enabled, true);
  assert.equal(eff.notify.toast.enabled, true, '默认开');
});

test('冷启动推送开关 helper：默认与显式设置', (t) => {
  const db = memDb(t);
  assert.equal(isNotifyOnFirstRun(db), false);
  assert.equal(isNotifyOnNewSubscription(db), true);
  saveRuntimeConfig(db, { notifyOnFirstRun: true, notifyOnNewSubscription: false });
  assert.equal(isNotifyOnFirstRun(db), true);
  assert.equal(isNotifyOnNewSubscription(db), false);
});
