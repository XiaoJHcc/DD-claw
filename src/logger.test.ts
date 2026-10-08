import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initFileSink, closeFileSink, makeLogger } from './logger.js';

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function daysAgoStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function withTmpDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'dd-claw-log-'));
  try {
    initFileSink(dir);
    fn(dir);
  } finally {
    closeFileSink();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('文件 sink：warn 落盘到当天日志文件', () => {
  withTmpDir((dir) => {
    makeLogger('test/mod').warn('出错了', { code: 42 });
    const file = join(dir, `dd-claw-${todayStr()}.log`);
    assert.ok(existsSync(file), '当天日志文件应存在');
    const content = readFileSync(file, 'utf8');
    assert.match(content, /WARN +\[test\/mod\] 出错了 \{"code":42\}/);
  });
});

test('文件 sink 与 console 用同一阈值：debug 不落盘', () => {
  withTmpDir((dir) => {
    makeLogger('test/mod').debug('细节');
    assert.equal(readdirSync(dir).length, 0, '默认阈值 info，debug 不写文件');
  });
});

test('initFileSink 清理 7 天前的旧日志', () => {
  withTmpDir((dir) => {
    // withTmpDir 已 init 过一次；先关掉，预置旧文件后重新 init 触发清理
    closeFileSink();
    const old = join(dir, `dd-claw-${daysAgoStr(8)}.log`);
    const recent = join(dir, `dd-claw-${daysAgoStr(3)}.log`);
    const other = join(dir, 'other.txt');
    writeFileSync(old, 'old');
    writeFileSync(recent, 'recent');
    writeFileSync(other, 'keep');
    initFileSink(dir);
    assert.equal(existsSync(old), false, '8 天前的日志被清理');
    assert.equal(existsSync(recent), true, '3 天前的日志保留');
    assert.equal(existsSync(other), true, '非日志文件不动');
  });
});

test('closeFileSink 后不再写文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dd-claw-log-'));
  try {
    initFileSink(dir);
    closeFileSink();
    makeLogger('test/mod').warn('不该落盘');
    assert.equal(readdirSync(dir).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
