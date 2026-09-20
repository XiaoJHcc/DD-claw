/**
 * bili_accounts 行类型与 uid 归一化单测。
 * 重点：normalizeBiliUid 要能吃「纯数字 / 带空白 / space.bilibili.com URL（含 /dynamic 后缀）」
 * 这几种人填形态；rowToBiliAccount 把 JSON 列与布尔列还原成对象字段。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidBiliUid, normalizeBiliUid, rowToBiliAccount, type BiliAccountRow,
} from './bili-accounts.js';

test('normalizeBiliUid：纯数字与空白', () => {
  assert.equal(normalizeBiliUid('80397'), '80397');
  assert.equal(normalizeBiliUid('  80397  '), '80397');
});

test('normalizeBiliUid：space.bilibili.com URL（含 /dynamic 后缀与大小写）', () => {
  assert.equal(normalizeBiliUid('https://space.bilibili.com/80397'), '80397');
  assert.equal(normalizeBiliUid('https://space.bilibili.com/80397/dynamic'), '80397');
  assert.equal(normalizeBiliUid('space.bilibili.com/80397'), '80397');
  assert.equal(normalizeBiliUid('SPACE.BILIBILI.COM/80397/dynamic'), '80397');
});

test('normalizeBiliUid：其余输入剥掉非数字字符', () => {
  assert.equal(normalizeBiliUid('uid:80397'), '80397');
  assert.equal(normalizeBiliUid('abc'), '', '没有数字 = 空串（由 isValidBiliUid 拦下）');
});

test('isValidBiliUid：数字串 1~20 位', () => {
  assert.equal(isValidBiliUid('80397'), true);
  assert.equal(isValidBiliUid('1'), true, '老账号位数更短');
  assert.equal(isValidBiliUid(''), false);
  assert.equal(isValidBiliUid('abc'), false);
  assert.equal(isValidBiliUid('80397a'), false);
  assert.equal(isValidBiliUid('1'.repeat(21)), false, '超长拒绝');
});

test('rowToBiliAccount：JSON 列与布尔列还原', () => {
  const row: BiliAccountRow = {
    id: 7, uid: '80397', uname: '阿梓从小就很可爱', display_name: null,
    enabled: 0, rule_ids: '[1,2]', last_ok_at: 1800000000, avatar: 'a.jpg',
    created_at: 100, updated_at: 200,
  };
  const a = rowToBiliAccount(row);
  assert.equal(a.id, 7);
  assert.equal(a.uid, '80397');
  assert.equal(a.uname, '阿梓从小就很可爱');
  assert.equal(a.displayName, null);
  assert.equal(a.enabled, false);
  assert.deepEqual(a.ruleIds, [1, 2]);
  assert.equal(a.lastOkAt, 1800000000);
  assert.equal(a.avatar, 'a.jpg');
  assert.equal(a.createdAt, 100);
  assert.equal(a.updatedAt, 200);
});
