/**
 * mcp-token CLI 的纯函数部分（参数解析）测试。
 * 只测解析：main() 依赖 loadConfig() 的真实落盘路径，不做端到端（避免测试污染本机 settings）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseChannelFlag } from './mcp-token.js';

test('不传 --channel → 无绑定', () => {
  assert.deepEqual(parseChannelFlag(['add', 'gw1', 'gateway']), {});
});

test('--channel <id> 与 --channel=<id> 都支持', () => {
  assert.deepEqual(parseChannelFlag(['add', 'gw1', 'gateway', '--channel', '7']), { value: 7 });
  assert.deepEqual(parseChannelFlag(['add', 'gw1', 'gateway', '--channel=7']), { value: 7 });
});

test('渠道 id 必须是正整数', () => {
  for (const bad of ['0', '-3', '1.5', 'abc', '']) {
    const r = parseChannelFlag(['add', 'gw1', 'gateway', '--channel', bad]);
    assert.ok(r.error, `应拒绝: ${bad}`);
    assert.equal(r.value, undefined);
  }
});

test('--channel 后缺值 / 紧跟另一个 flag → 报错', () => {
  assert.ok(parseChannelFlag(['add', 'gw1', 'gateway', '--channel']).error);
  assert.ok(parseChannelFlag(['add', 'gw1', 'gateway', '--channel', '--force']).error);
});
