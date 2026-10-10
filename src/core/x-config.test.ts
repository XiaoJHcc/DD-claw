/**
 * X 连接配置（settings 唯一信源）单测：默认值、往返、异常库存值回落。
 * 与 runtime-config 一样，这里不碰面板——面板只负责校验形状后调用 saveXConfig。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from './db.js';
import {
  getXConfig, saveXConfig, emptyXStatus, invalidateXStatus, isSavedConfigTest,
  X_INSTANCES_DEFAULT, X_INTERVAL_DEFAULT, X_PROXY_DEFAULT,
} from './x-config.js';

function memDb(t: import('node:test').TestContext): Db {
  const db = new Db(':memory:');
  t.after(() => db.close());
  return db;
}

test('无 settings 时返回默认值（代理 / 实例 / 间隔 / 回退开）', (t) => {
  const db = memDb(t);
  const cfg = getXConfig(db);
  assert.equal(cfg.proxyUrl, X_PROXY_DEFAULT);
  assert.deepEqual(cfg.instances, X_INSTANCES_DEFAULT);
  assert.equal(cfg.intervalSec, X_INTERVAL_DEFAULT);
  assert.equal(cfg.fallbackHtml, true);
});

test('save/get 往返：逐字段落 settings，缺省字段不动', (t) => {
  const db = memDb(t);
  saveXConfig(db, { proxyUrl: ' 127.0.0.1:1080 ' });
  saveXConfig(db, { instances: ['a.example', 'b.example'], intervalSec: 600, fallbackHtml: false });
  const cfg = getXConfig(db);
  assert.equal(cfg.proxyUrl, '127.0.0.1:1080', '两侧空白被裁掉');
  assert.deepEqual(cfg.instances, ['a.example', 'b.example']);
  assert.equal(cfg.intervalSec, 600);
  assert.equal(cfg.fallbackHtml, false);
  assert.equal(db.getSetting('x_nitter_instances'), 'a.example,b.example', '实例以逗号串落库');
});

test('库存异常值回落默认：越界间隔、非数字、非法布尔、空代理串保留为空（= 不用代理）', (t) => {
  const db = memDb(t);
  db.setSetting('x_interval_sec', '5'); // 低于下限
  db.setSetting('x_fallback_html', 'maybe'); // 非法布尔
  db.setSetting('x_proxy_url', ''); // 显式清空 = 不用代理，不该被默认值顶掉
  const cfg = getXConfig(db);
  assert.equal(cfg.intervalSec, X_INTERVAL_DEFAULT, '越界回落默认');
  assert.equal(cfg.fallbackHtml, true, '非法布尔回落默认');
  assert.equal(cfg.proxyUrl, '', '空串是有效配置（墙外部署不用代理）');

  db.setSetting('x_interval_sec', 'abc');
  assert.equal(getXConfig(db).intervalSec, X_INTERVAL_DEFAULT, '非数字回落默认');
});

test('实例串里的空项被丢弃（面板存过 "", 或用户手改过 settings）', (t) => {
  const db = memDb(t);
  db.setSetting('x_nitter_instances', 'a.example, ,b.example,');
  assert.deepEqual(getXConfig(db).instances, ['a.example', 'b.example']);
});

// ---- 探测状态快照：配置变更只让「相关」旧结论失效 ----

function testedStatus() {
  return {
    proxy: { ok: true, message: '代理可达', checkedAt: 100 },
    instances: [{ host: 'a.example', ok: true, message: '可用' }],
    web: { ok: true, message: '免登录可用', checkedAt: 100 },
    updatedAt: 100,
  };
}

const baseCfg = { proxyUrl: X_PROXY_DEFAULT, instances: ['a.example'], intervalSec: 300, fallbackHtml: true };

test('invalidateXStatus：代理或回退变了 → 代理与免登录结论失效，实例结论保留', () => {
  const out = invalidateXStatus(testedStatus(), baseCfg, { ...baseCfg, proxyUrl: 'http://127.0.0.1:1080' });
  assert.equal(out.proxy.checkedAt, null, '代理结论作废');
  assert.equal(out.proxy.message, '配置已改，请重新测试');
  assert.equal(out.web.checkedAt, null, '免登录走同一条出网链路，一并作废');
  assert.equal(out.instances.length, 1, '实例名单没动，结论保留');

  const out2 = invalidateXStatus(testedStatus(), baseCfg, { ...baseCfg, fallbackHtml: false });
  assert.equal(out2.proxy.checkedAt, null);
});

test('invalidateXStatus：实例名单变了 → 只清实例结论；间隔变了 → 什么都不清', () => {
  const changed = invalidateXStatus(testedStatus(), baseCfg, { ...baseCfg, instances: ['a.example', 'b.example'] });
  assert.deepEqual(changed.instances, [], '实例名单变了，逐个探活结果不再适用');
  assert.equal(changed.proxy.ok, true, '代理结论仍有效');
  assert.equal(changed.proxy.checkedAt, 100);

  const same = invalidateXStatus(testedStatus(), baseCfg, { ...baseCfg, intervalSec: 600 });
  assert.deepEqual(same, testedStatus(), '间隔不影响连通性结论，一个字都不该动');
});

test('emptyXStatus：初始态是「尚未测试」而不是「失败」', () => {
  const s = emptyXStatus();
  assert.equal(s.proxy.checkedAt, null);
  assert.equal(s.proxy.message, '尚未测试');
  assert.deepEqual(s.instances, []);
  assert.equal(s.updatedAt, null);
  assert.equal(s.proxy.ok, false, '未测试时 ok=false 是「不知道」，前端靠 checkedAt 区分灰点与红点');
});

test('isSavedConfigTest：只有「测的就是已保存配置」才算，未保存值不污染卡片快照', () => {
  const cfg = { proxyUrl: 'http://127.0.0.1:7890', instances: ['a.example', 'b.example'], intervalSec: 300, fallbackHtml: true };
  assert.equal(isSavedConfigTest({}, cfg), true, '不带覆盖值 = 测已存配置');
  assert.equal(isSavedConfigTest({ target: 'all' } as never, cfg), true);
  assert.equal(isSavedConfigTest({ proxyUrl: 'http://127.0.0.1:7890' }, cfg), true, '值相同（含空白差异）');
  assert.equal(isSavedConfigTest({ proxyUrl: ' socks5://127.0.0.1:1080 ' }, cfg), false, '试了未保存的坏代理');
  assert.equal(isSavedConfigTest({ instances: 'a.example,b.example' }, cfg), true, '分隔符归一后相同');
  assert.equal(isSavedConfigTest({ instances: 'a.example，b.example' }, cfg), true, '中文逗号同样归一');
  assert.equal(isSavedConfigTest({ instances: 'a.example' }, cfg), false, '实例名单不同');
  assert.equal(isSavedConfigTest({ proxyUrl: 'http://127.0.0.1:7890', instances: 'a.example' }, cfg), false, '任一不同即不同');
});