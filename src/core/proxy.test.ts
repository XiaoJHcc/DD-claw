/**
 * 隧道层单测：纯函数 + 一次真实的「客户端 → 假代理 → 本地 HTTP 服务」往返。
 * 后者同时守住 §5.28 那条坑——请求不带 Connection: close 时服务端 keep-alive，
 * 读取端永不 end，本测试会挂住（而不是悄悄通过）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { once } from 'node:events';
import {
  parseProxyUrl, parseInstanceList, decodeChunked, tunnelFetch, TunnelError, describeTunnelError,
} from './proxy.js';

test('parseProxyUrl：http 形式带/不带协议、尾斜杠都收', () => {
  assert.deepEqual(parseProxyUrl('http://127.0.0.1:7890'), { host: '127.0.0.1', port: 7890 });
  assert.deepEqual(parseProxyUrl('127.0.0.1:7890'), { host: '127.0.0.1', port: 7890 });
  assert.deepEqual(parseProxyUrl('  http://proxy.local:8080/  '), { host: 'proxy.local', port: 8080 });
  assert.deepEqual(parseProxyUrl('http://127.0.0.1'), { host: '127.0.0.1', port: 80 });
});

test('parseProxyUrl：空值 = 不用代理；socks 与坏形状给配置错误', () => {
  assert.equal(parseProxyUrl(''), null);
  assert.equal(parseProxyUrl(null), null);
  assert.equal(parseProxyUrl(undefined), null);
  assert.throws(() => parseProxyUrl('socks5://127.0.0.1:1080'), (e: unknown) =>
    e instanceof TunnelError && e.kind === 'bad-proxy-url');
  assert.throws(() => parseProxyUrl('http://'), (e: unknown) =>
    e instanceof TunnelError && e.kind === 'bad-proxy-url');
});

test('parseInstanceList：逗号（中英文）/空白分隔、去协议与尾斜杠、去重保序', () => {
  assert.deepEqual(parseInstanceList('a.com, b.com'), ['a.com', 'b.com']);
  assert.deepEqual(parseInstanceList('a.com，b.com'), ['a.com', 'b.com'], '中文逗号同样分隔');
  assert.deepEqual(parseInstanceList('https://a.com/  b.com\nc.com'), ['a.com', 'b.com', 'c.com']);
  assert.deepEqual(parseInstanceList('a.com,a.com'), ['a.com']);
  assert.deepEqual(parseInstanceList(''), []);
  assert.deepEqual(parseInstanceList(null), []);
});

test('decodeChunked：按块拼接，忽略尾部 0 块', () => {
  const raw = Buffer.from('5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n', 'latin1');
  assert.equal(decodeChunked(raw).toString('utf8'), 'hello world');
});

test('tunnelFetch：经假代理走 CONNECT 隧道取到响应（含 chunked）', async () => {
  // 本地目标服务：故意用 chunked 回体，顺带验证解析
  const target = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' });
    res.write('hello ');
    res.end('tunnel');
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  const targetPort = (target.address() as net.AddressInfo).port;

  // 假代理：解析 CONNECT 后回 200，再把字节管道接到本地目标（不做真实 DNS/出网）
  const proxy = net.createServer((sock) => {
    let buf = '';
    sock.on('data', function onData(d) {
      buf += d.toString('latin1');
      if (!buf.includes('\r\n\r\n')) return;
      sock.removeListener('data', onData);
      sock.write('HTTP/1.1 200 Connection established\r\n\r\n');
      const up = net.connect(targetPort, '127.0.0.1');
      sock.pipe(up);
      up.pipe(sock);
    });
    sock.on('error', () => sock.destroy());
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const proxyPort = (proxy.address() as net.AddressInfo).port;

  try {
    const res = await tunnelFetch('http://example.test/thing?x=1', { host: '127.0.0.1', port: proxyPort }, {
      headers: { 'X-Probe': 'yes' },
      timeoutMs: 5000,
    });
    assert.equal(res.status, 200);
    assert.equal(res.text, 'hello tunnel');
    assert.match(res.headers['content-type'] ?? '', /text\/plain/);
  } finally {
    target.close();
    proxy.close();
  }
});

test('tunnelFetch：代理端口没人听 → 归类为代理不可用（不是超时）', async () => {
  // 先占一个端口再关掉，保证「确定没人听」
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const deadPort = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));

  await assert.rejects(
    () => tunnelFetch('http://example.test/', { host: '127.0.0.1', port: deadPort }, { timeoutMs: 3000 }),
    (e: unknown) => e instanceof TunnelError && (e.kind === 'proxy-refused' || e.kind === 'proxy-unreachable'),
  );
  assert.match(describeTunnelError(new TunnelError('proxy-refused', 'x')), /代理不可用/);
  assert.match(describeTunnelError(new TunnelError('bad-proxy-url', 'x')), /配置有误/);
  assert.match(describeTunnelError(new Error('boom')), /boom/);
});