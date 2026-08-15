import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToastNotifier, buildMacNotificationScript } from './toast.js';
import type { PushMessage } from '../core/types.js';

function msg(over: Partial<PushMessage> = {}): PushMessage {
  return {
    title: '阿梓 开播了',
    body: '今晚歌回',
    attribution: '虚拟主播 / 虚拟Singer  ·  21:00 开播',
    url: 'https://live.bilibili.com/80397',
    priority: 'normal',
    ...over,
  };
}

const okRunner = async () => ({ code: 0, stdout: '', stderr: '' });
const failRunner = async () => ({ code: 1, stdout: '', stderr: 'execution error: x' });

// ---------- buildMacNotificationScript（osascript 回落路径的转义） ----------

test('mac 脚本：结构为 display notification ... with title ... subtitle ...', () => {
  const s = buildMacNotificationScript('标题', '正文', '小字');
  assert.equal(s, 'display notification "正文" with title "标题" subtitle "小字"');
});

test('mac 脚本：无 subtitle 时不拼 subtitle 子句；空标题回落 DD-claw', () => {
  assert.equal(buildMacNotificationScript('', '正文'), 'display notification "正文" with title "DD-claw"');
});

test('mac 脚本：引号/反斜杠/换行/制表被正确转义（内容不被拆出字符串）', () => {
  const s = buildMacNotificationScript('标题"引"', '他\\说\n好\t的', '小字');
  assert.equal(
    s,
    'display notification "他\\\\说\\n好\\t的" with title "标题\\"引\\"" subtitle "小字"',
  );
});

// ---------- macOS helper 路径（DD-claw.app） ----------

test('darwin + helper：spawn helper 带 title/subtitle/message/url，返回 ok', async () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const n = new ToastNotifier(undefined, undefined, {
    platform: 'darwin', macHelper: '/x/DD-claw.app/Contents/MacOS/DD-claw',
    spawnMac: async (bin, args) => { calls.push({ bin, args }); },
  });
  const res = await n.send(msg());
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.bin, '/x/DD-claw.app/Contents/MacOS/DD-claw');
  assert.deepEqual(calls[0]!.args, [
    '--title', '阿梓 开播了',
    '--message', '今晚歌回',
    '--subtitle', '虚拟主播 / 虚拟Singer  ·  21:00 开播',
    '--url', 'https://live.bilibili.com/80397',
  ]);
  assert.deepEqual(res, [{ ok: true, target: 'local' }]);
});

test('darwin + helper：本地图路径透传给 --image，http 图需本地化（此处本地路径直达）', async () => {
  const calls: Array<{ args: string[] }> = [];
  const n = new ToastNotifier(undefined, undefined, {
    platform: 'darwin', macHelper: '/x/DD-claw',
    spawnMac: async (_bin, args) => { calls.push({ args }); },
  });
  await n.send(msg({ image: '/local/keyframe.jpg' }));
  assert.ok(calls[0]!.args.includes('--image'));
  assert.ok(calls[0]!.args.includes('/local/keyframe.jpg'));
});

test('darwin + helper：spawn 失败回落 osascript（runMac 被调用）', async () => {
  let runCalled = false;
  const n = new ToastNotifier(undefined, undefined, {
    platform: 'darwin', macHelper: '/x/DD-claw',
    spawnMac: async () => { throw new Error('ENOENT'); },
    runMac: async () => { runCalled = true; return { code: 0, stdout: '', stderr: '' }; },
  });
  const res = await n.send(msg());
  assert.ok(runCalled);
  assert.deepEqual(res, [{ ok: true, target: 'local' }]);
});

test('darwin 无 helper：直接回落 osascript，成功返回 ok', async () => {
  const n = new ToastNotifier(undefined, undefined, {
    platform: 'darwin', macHelper: null, runMac: okRunner,
  });
  const res = await n.send(msg());
  assert.deepEqual(res, [{ ok: true, target: 'local' }]);
});

test('darwin 无 helper：osascript 失败返回 ok:false 且带错误', async () => {
  const n = new ToastNotifier(undefined, undefined, {
    platform: 'darwin', macHelper: null, runMac: failRunner,
  });
  const res = await n.send(msg());
  assert.equal(res[0]!.ok, false);
  assert.ok(res[0]!.error);
});

test('darwin + helper：alert 走 helper，标题加【告警】前缀、无 url/image', async () => {
  const calls: Array<{ args: string[] }> = [];
  const n = new ToastNotifier(undefined, undefined, {
    platform: 'darwin', macHelper: '/x/DD-claw',
    spawnMac: async (_bin, args) => { calls.push({ args }); },
  });
  await n.alert!('连续失败', '详情');
  assert.deepEqual(calls[0]!.args, ['--title', '【告警】连续失败', '--message', '详情']);
});

// ---------- 平台能力与降级 ----------

test('win32：capabilities 带图 + 点击跳转', () => {
  const n = new ToastNotifier(undefined, undefined, { platform: 'win32' });
  assert.deepEqual(n.capabilities, { image: true, clickThrough: true });
});

test('darwin + helper：capabilities 带图 + 点击跳转', () => {
  const n = new ToastNotifier(undefined, undefined, { platform: 'darwin', macHelper: '/x/DD-claw' });
  assert.deepEqual(n.capabilities, { image: true, clickThrough: true });
});

test('darwin 无 helper：capabilities 不带图、不带点击跳转', () => {
  const n = new ToastNotifier(undefined, undefined, { platform: 'darwin', macHelper: null });
  assert.deepEqual(n.capabilities, { image: false, clickThrough: false });
});

test('linux 等其它平台：不调用任何执行器，返回不支持', async () => {
  let called = false;
  const n = new ToastNotifier(undefined, undefined, {
    platform: 'linux',
    spawnMac: async () => { called = true; },
    runMac: async () => { called = true; return { code: 0, stdout: '', stderr: '' }; },
  });
  const res = await n.send(msg());
  assert.equal(called, false);
  assert.equal(res[0]!.ok, false);
});
