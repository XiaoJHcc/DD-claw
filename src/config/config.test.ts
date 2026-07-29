import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __stripJsonCommentsForTest as strip } from './index.js';

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

test('保留换行以免行号错位', () => {
  assert.match(strip('{\n// c\n"a":1}'), /\n/);
});

test('config.example.json 剥注释后是合法 JSON', async () => {
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const { projectRoot } = await import('./index.js');
  const raw = readFileSync(resolve(projectRoot, 'config.example.json'), 'utf8');
  const parsed = JSON.parse(strip(raw.replace(/^﻿/, '')));
  assert.ok(Array.isArray(parsed.subscriptions));
});
