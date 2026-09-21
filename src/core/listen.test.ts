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

test('shouldRunListen：auto 前提满足就跑；手动关不跑；前提不满足不跑', () => {
  const db = new Db(':memory:');
  // auto + 有 cookie → 跑
  assert.equal(shouldRunListen(db, 'dynamic', true), true);
  // auto + 无 cookie → 不跑
  assert.equal(shouldRunListen(db, 'dynamic', false), false);
  // 手动关 + 有 cookie → 不跑
  setListen(db, 'weibo', false, true);
  assert.equal(shouldRunListen(db, 'weibo', true), false);
  // 手动开但前提不满足（无 cookie）→ 源照样不跑（UI 显示开，由这条拦住）
  setListen(db, 'dynamic', true, false);
  assert.equal(isListenEnabled(db, 'dynamic', false), true, 'UI 显示开');
  assert.equal(shouldRunListen(db, 'dynamic', false), false, '源不跑');
});

test('X（推特）：运行前提是「代理已配置」，不是登录态', () => {
  const db = new Db(':memory:');
  assert.equal(isListenEnabled(db, 'twitter', true), true, 'auto + 代理已配置 → 开');
  assert.equal(isListenEnabled(db, 'twitter', false), false, 'auto + 未配置代理 → 关');
  // 未配置代理也能手动开：UI 显示开，但源不跑（提醒用户去填代理，而不是把开关变灰）
  assert.equal(setListen(db, 'twitter', true, false), true);
  assert.equal(listenSetting(db, 'twitter'), '1');
  assert.equal(shouldRunListen(db, 'twitter', false), false, '前提不满足 → 源不跑');
  assert.equal(shouldRunListen(db, 'twitter', true), true, '前提满足 + 手动开 → 跑');
  // 手动关优先于前提
  assert.equal(setListen(db, 'twitter', false, true), false);
  assert.equal(shouldRunListen(db, 'twitter', true), false, '手动关优先');
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

test('setListen 手动关→手动开：该平台启用账号进入恢复轮静默；关闭当下 / auto→手动开都不置位', () => {
  const db = new Db(':memory:');
  const x = db.upsertXAccount({ screenName: 'a', displayName: null, biliUid: null, enabled: true });
  const w = db.upsertWeiboAccount({ uid: '100', nickname: null, biliUid: null, enabled: true });
  const wOff = db.upsertWeiboAccount({ uid: '101', nickname: null, biliUid: null, enabled: false });
  const b = db.upsertBiliAccount({ uid: '80397' });

  setListen(db, 'weibo', false, true);
  assert.equal(db.getWeiboAccount(w)!.silentNext, false, '关闭当下不置位（置位在重开那一刻）');

  setListen(db, 'weibo', true, true);
  assert.equal(db.getWeiboAccount(w)!.silentNext, true, '重开 = 主动暂停结束 → 恢复轮静默');
  assert.equal(db.getWeiboAccount(wOff)!.silentNext, false, '停用行不动');
  assert.equal(db.getXAccount(x)!.silentNext, false, '别的平台不受影响');
  assert.equal(db.getSetting('listen_weibo'), null, '与 auto 一致 → 回 auto（key 删除）');

  setListen(db, 'dynamic', false, true);
  setListen(db, 'dynamic', true, true);
  assert.equal(db.getBiliAccount(b)!.silentNext, true, 'B站名单同一语义');

  setListen(db, 'twitter', true, false);
  assert.equal(db.getXAccount(x)!.silentNext, false, 'auto→手动开不是「重开」，不置位');
});
