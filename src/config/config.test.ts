import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __stripJsonCommentsForTest as strip } from './index.js';
import { configSchema, defaultAppConfig } from './schema.js';

test('空对象/缺文件 → 全默认值（panel 默认 8787 开）', () => {
  const r = configSchema.safeParse({});
  assert.ok(r.success, JSON.stringify(r.success ? {} : r.error.issues));
  assert.deepEqual(r.data!.panel, { enabled: true, port: 8787 });
});

test('schema 只认 panel 段：其余顶层字段剥离无视', () => {
  const r = configSchema.safeParse({ panel: { port: 9999 }, pollIntervalSec: 10, subscriptions: [] });
  assert.ok(r.success);
  assert.equal(r.data!.panel.port, 9999);
  assert.deepEqual(Object.keys(r.data!), ['panel'], '遗留字段不进解析结果');
});

test('panel.port 越界仍启动即失败', () => {
  assert.equal(configSchema.safeParse({ panel: { port: 0 } }).success, false);
});

test('defaultAppConfig：运行参数代码默认值', () => {
  const app = defaultAppConfig();
  assert.equal(app.pollIntervalSec, 45);
  assert.equal(app.notify.onebot.enabled, false, 'QQ 通道默认关（面板高级设置开）');
  assert.equal(app.notify.toast.enabled, true);
});

test('剥掉行注释', () => {
  assert.equal(JSON.parse(strip('{"a":1} // trailing')).a, 1);
  assert.equal(JSON.parse(strip('{\n// lead\n"a":1}')).a, 1);
});

test('剥掉块注释', () => {
  assert.equal(JSON.parse(strip('{/* x */"a":1}')).a, 1);
  assert.equal(JSON.parse(strip('{"a":1/*\nmulti\n*/}')).a, 1);
});

test('不误伤字符串里的 //（URL 是最常见的踩坑点）', () => {
  const o = JSON.parse(strip('{"url":"https://example.com/a//b"}'));
  assert.equal(o.url, 'https://example.com/a//b');
});

test('不误伤字符串里的 /*', () => {
  assert.equal(JSON.parse(strip('{"s":"a/*b"}')).s, 'a/*b');
});

test('正确处理转义引号', () => {
  const o = JSON.parse(strip('{"s":"say \\"hi\\" // not comment"}'));
  assert.equal(o.s, 'say "hi" // not comment');
});

test('config.example.json 剥注释后是合法 JSON（只剩 panel 自举段）', async () => {
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const { projectRoot } = await import('./index.js');
  const raw = readFileSync(resolve(projectRoot, 'config.example.json'), 'utf8');
  const parsed = JSON.parse(strip(raw.replace(/^﻿/, '')));
  assert.deepEqual(Object.keys(parsed), ['panel'], '示例只保留面板自举段');
  assert.equal(configSchema.safeParse(parsed).success, true);
});
