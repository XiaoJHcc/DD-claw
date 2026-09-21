/**
 * 链路结论单测。这条规则是实测逼出来的：x.com 经代理瞬时 TLS 失败、但 Nitter 实例
 * 照样取到 20 条（走同一个代理）——主路线可用却报「不可用」是错的判定。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeVerdict, type InstanceProbe, type ProxyProbe, type WebProbe } from './probe.js';

function proxy(ok: boolean): ProxyProbe {
  return {
    ok, kind: ok ? 'ok' : 'error', target: 'https://x.com/robots.txt',
    status: ok ? 200 : null, ms: 10,
    message: ok ? '代理可达 · x.com 200 · 10ms' : 'TLS 失败（多为被墙或代理未生效）',
  };
}

function inst(host: string, ok: boolean): InstanceProbe {
  return { host, ok, kind: ok ? 'ok' : 'blocked', status: ok ? 200 : 429, ms: 5, items: ok ? 20 : 0, message: ok ? '可用 · 20 条' : '429 被限速' };
}

function web(ok: boolean): WebProbe {
  return { ok, screenName: 'watase_yuzuki', status: ok ? 200 : 500, ms: 5, tweetIds: ok ? 7 : 0, latestId: null, latestAt: null, message: ok ? '免登录可用' : 'x.com 返回 500' };
}

test('实例可用 → 可用（哪怕 x.com 经代理不通：主路线不依赖它）', () => {
  const v = probeVerdict({ proxy: proxy(false), instances: [inst('a', true), inst('b', false)], web: null });
  assert.equal(v.usable, true, '能抓到推文就算可用');
  assert.match(v.message, /主路线可用：1\/2/);
  assert.match(v.message, /x\.com 经代理不通/, '如实说明回退与图片下载受影响');
});

test('实例全挂但免登录可用 → 可用（并说明看不到转发）', () => {
  const v = probeVerdict({ proxy: proxy(true), instances: [inst('a', false)], web: web(true) });
  assert.equal(v.usable, true);
  assert.match(v.message, /免登录回退可用/);
  assert.match(v.message, /看不到转发/);
});

test('两条路线都不通 → 不可用；代理自身的错误优先暴露', () => {
  const v1 = probeVerdict({ proxy: proxy(true), instances: [inst('a', false)], web: web(false) });
  assert.equal(v1.usable, false);

  const v2 = probeVerdict({ proxy: proxy(false), instances: [], web: null });
  assert.equal(v2.usable, false);
  assert.match(v2.message, /TLS 失败/, '代理坏掉时把代理的原因摆出来');
});

test('没有实例也没有免登录结果（名单为空）→ 不可用', () => {
  const v = probeVerdict({ proxy: proxy(true), instances: [], web: null });
  assert.equal(v.usable, false);
  assert.match(v.message, /实例全挂/);
});