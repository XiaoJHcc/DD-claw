import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  macNotifierBinaryPath, macNotifierArgs, ensureMacNotifier,
  type Runner,
} from './mac-notifier.js';

let dir = '';
test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dd-claw-macnotify-')); });
test.afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const okRun: Runner = async () => ({ code: 0, stdout: '', stderr: '' });
const failRun: Runner = async () => ({ code: 1, stdout: '', stderr: 'swiftc: error' });

// ---------- macNotifierArgs ----------

test('参数：title/message 必有，subtitle/url/image 可选', () => {
  assert.deepEqual(macNotifierArgs({ title: 't', subtitle: '', message: 'm', url: '', image: '' }), [
    '--title', 't', '--message', 'm',
  ]);
  assert.deepEqual(macNotifierArgs({ title: 't', subtitle: 's', message: 'm', url: 'u', image: 'i' }), [
    '--title', 't', '--message', 'm', '--subtitle', 's', '--url', 'u', '--image', 'i',
  ]);
});

// ---------- macNotifierBinaryPath ----------

test('二进制路径在 DD-claw.app/Contents/MacOS 下', () => {
  // 期望值用 join 拼：产物在 macOS 上跑，但断言不该因在 Windows 上执行而假失败
  assert.equal(macNotifierBinaryPath('/data'), join('/data', 'DD-claw.app', 'Contents', 'MacOS', 'DD-claw'));
});

// ---------- ensureMacNotifier ----------

test('产物已存在：直接返回，不再编译', async () => {
  const bin = macNotifierBinaryPath(dir);
  mkdirSync(join(dir, 'DD-claw.app', 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(bin, 'x');
  let called = false;
  const run: Runner = async () => { called = true; return { code: 0, stdout: '', stderr: '' }; };
  assert.equal(await ensureMacNotifier(dir, run), bin);
  assert.equal(called, false);
});

test('首次：写 Info.plist + swiftc 编译，返回二进制路径', async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const run: Runner = async (cmd, args) => {
    calls.push({ cmd, args });
    return { code: 0, stdout: '', stderr: '' };
  };
  const bin = await ensureMacNotifier(dir, run);
  assert.equal(bin, macNotifierBinaryPath(dir));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.cmd, 'swiftc');
  assert.ok(calls[0]!.args.includes('-O'));
  assert.ok(calls[0]!.args.some((a) => a.endsWith(join('scripts', 'mac-notify.swift')) || a.endsWith('scripts/mac-notify.swift')));
  assert.ok(calls[0]!.args.includes('-o'));
  // Info.plist 已写入且带身份字段
  const plist = readFileSync(join(dir, 'DD-claw.app', 'Contents', 'Info.plist'), 'utf8');
  assert.ok(plist.includes('DD-claw'));
  assert.ok(plist.includes('com.ddclaw.notifier'));
});

test('swiftc 编译失败：返回 null，不抛异常', async () => {
  assert.equal(await ensureMacNotifier(dir, failRun), null);
});

test('swiftc 抛异常（如不可用）：返回 null，不抛异常', async () => {
  const run: Runner = async () => { throw new Error('ENOENT'); };
  assert.equal(await ensureMacNotifier(dir, run), null);
});
