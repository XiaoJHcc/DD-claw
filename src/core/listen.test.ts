import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from './db.js';
import {
  isListenEnabled, listenSetting, setListen, shouldRunListen,
} from './listen.js';

test('缺省 = auto：登录即开、未登录即关', () => {
  const db = new Db(':memory:');
  assert.equal(isListenEnabled(db, 'dynamic', true), true);
  assert.equal(isListenEnabled(db, 'dynamic', false), false);
  assert.equal(listenSetting(db, 'dynamic'), null, 'auto 模式无手动设置');
});

test('手动关：登录后也保持关（手动设置为准）', () => {
  const db = new Db(':memory:');
  assert.equal(setListen(db, 'dynamic', false, true), false, '登录态下手动关');
  assert.equal(listenSetting(db, 'dynamic'), '0');
  assert.equal(isListenEnabled(db, 'dynamic', true), false, '登录后仍关');
  assert.equal(isListenEnabled(db, 'dynamic', false), false);
});

test('手动开：即使未登录也显示开（无 cookie 时源实际不跑，由 shouldRunListen 拦）', () => {
  const db = new Db(':memory:');
  assert.equal(setListen(db, 'weibo', true, false), true);
  assert.equal(listenSetting(db, 'weibo'), '1');
  assert.equal(isListenEnabled(db, 'weibo', false), true);
});

test('setListen 与 auto 一致则回 auto：删除手动设置的 key', () => {
  const db = new Db(':memory:');
  // 已登录、auto 开 → 手动关
  assert.equal(setListen(db, 'dynamic', false, true), false);
  assert.equal(listenSetting(db, 'dynamic'), '0');
  // 再开（= auto 默认开）→ 回 auto：settings 里的 key 整个删掉
  assert.equal(setListen(db, 'dynamic', true, true), true);
  assert.equal(listenSetting(db, 'dynamic'), null);
  assert.equal(db.getSetting('listen_dynamic'), null, '回 auto 后 key 不存在（不是空串）');
  // auto 下登录态变化会跟着走
  assert.equal(isListenEnabled(db, 'dynamic', false), false, '回 auto 后未登录又关');
});

test('shouldRunListen：auto 有 cookie 就跑；手动关不跑；无 cookie 不跑', () => {
  const db = new Db(':memory:');
  // auto + 有 cookie → 跑
  assert.equal(shouldRunListen(db, 'dynamic', true), true);
  // auto + 无 cookie → 不跑
  assert.equal(shouldRunListen(db, 'dynamic', false), false);
  // 手动关 + 有 cookie → 不跑
  setListen(db, 'weibo', false, true);
  assert.equal(shouldRunListen(db, 'weibo', true), false);
  // config 关 → 不跑
  assert.equal(shouldRunListen(db, 'dynamic', true, false), false);
});

test('auto 下登录过期不自动停：shouldRunListen 只看 cookie 不看登录态', () => {
  const db = new Db(':memory:');
  // auto + 有 cookie（即使登录已过期）→ 继续跑，让源自己心跳跳过并感知恢复
  assert.equal(shouldRunListen(db, 'dynamic', true), true);
  // 但 isListenEnabled（UI）会因登录过期显示关
  assert.equal(isListenEnabled(db, 'dynamic', false), false);
});

test('db.close() 可正常关闭', () => {
  const db = new Db(':memory:');
  db.setSetting('listen_dynamic', '1');
  db.close();
});
