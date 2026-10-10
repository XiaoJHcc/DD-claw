/**
 * NapCat 上报地址注册（P3）契约测试——**只碰临时目录**，不连真 NapCat：
 * 自管 `onebot11_<uin>.json` 的 `network.httpClients` 里 `dd-claw-qqbot` 条目（创建 / 更新 / 幂等）、
 * 别人手建的条目一律不动、配置缺失/坏 JSON 一律 `failed` 且不抛、写盘后走注入的热重载。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QQ_POST_ENTRY_NAME, ensureNapcatHttpClient, qqPostUrl } from './napcat-post.js';

interface Sandbox {
  dir: string;
  file: string;
  read: () => Record<string, unknown>;
  /** 注入的热重载：记录调用次数（缺省成功） */
  reloads: number[];
}

function sandbox(t: import('node:test').TestContext, config: unknown, uin = '10001'): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'dd-qqpost-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'config'), { recursive: true });
  const file = join(dir, 'config', `onebot11_${uin}.json`);
  writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config, null, 2));
  return {
    dir, file, reloads: [],
    read: () => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>,
  };
}

function clientsOf(sb: Sandbox): Array<Record<string, unknown>> {
  const network = sb.read()['network'] as { httpClients: Array<Record<string, unknown>> };
  return network.httpClients;
}

test('没有条目时创建：url 指向面板的 /onebot、array 格式、不上报自发消息，写完走热重载', async (t) => {
  const sb = sandbox(t, { network: { httpServers: [{ name: 'dd-claw', port: 41990 }], httpClients: [] } });
  const reload = async (dir: string, uin: string): Promise<boolean> => { sb.reloads.push(1); assert.equal(dir, sb.dir); assert.equal(uin, '10001'); return true; };

  const r = await ensureNapcatHttpClient(sb.dir, '10001', qqPostUrl(8787), reload);
  assert.equal(r.status, 'created');
  assert.equal(r.reloaded, true);
  assert.deepEqual(sb.reloads.length, 1);
  const [entry] = clientsOf(sb);
  assert.deepEqual(
    { name: entry!.name, enable: entry!.enable, url: entry!.url, format: entry!.messagePostFormat, self: entry!.reportSelfMessage },
    { name: QQ_POST_ENTRY_NAME, enable: true, url: 'http://127.0.0.1:8787/onebot', format: 'array', self: false },
  );
  // httpServers（我们调 API 的那条）原样保留
  const network = sb.read()['network'] as { httpServers: unknown[] };
  assert.deepEqual(network.httpServers, [{ name: 'dd-claw', port: 41990 }]);
});

test('幂等：地址与开关都一致时不写盘、不重载；地址变了就地更新', async (t) => {
  const url = qqPostUrl(8787);
  const sb = sandbox(t, {
    network: {
      httpClients: [
        { name: '我的上报', enable: true, url: 'http://127.0.0.1:9999/hook', messagePostFormat: 'array' },
        { name: QQ_POST_ENTRY_NAME, enable: true, url, messagePostFormat: 'array', reportSelfMessage: false, token: 'keep-me' },
      ],
    },
  });
  const reload = async (): Promise<boolean> => { sb.reloads.push(1); return true; };

  const again = await ensureNapcatHttpClient(sb.dir, '10001', url, reload);
  assert.equal(again.status, 'unchanged');
  assert.deepEqual(sb.reloads, [], '一致就不打扰 NapCat');

  const moved = await ensureNapcatHttpClient(sb.dir, '10001', qqPostUrl(9000), reload);
  assert.equal(moved.status, 'updated');
  assert.equal(moved.reloaded, true);
  const entry = clientsOf(sb).find((c) => c.name === QQ_POST_ENTRY_NAME)!;
  assert.equal(entry.url, 'http://127.0.0.1:9000/onebot');
  assert.equal(entry.token, 'keep-me', '我们只管四个字段，别的值不动');
  assert.equal(clientsOf(sb)[0]!.name, '我的上报', '主人手建的条目原样保留');
});

test('被禁用/格式不对的条目会被修正（enable / messagePostFormat 都是我们的口径）', async (t) => {
  const url = qqPostUrl(8787);
  const sb = sandbox(t, {
    network: { httpClients: [{ name: QQ_POST_ENTRY_NAME, enable: false, url, messagePostFormat: 'string', reportSelfMessage: true }] },
  });
  const r = await ensureNapcatHttpClient(sb.dir, '10001', url, async () => false);
  assert.equal(r.status, 'updated');
  assert.equal(r.reloaded, false, '热重载失败 = 下次重启生效，不算致命');
  const entry = clientsOf(sb)[0]!;
  assert.deepEqual([entry.enable, entry.messagePostFormat, entry.reportSelfMessage], [true, 'array', false]);
});

test('读不到配置 / 坏 JSON / 路径不对：一律 failed 且不抛（不硬来，交回装配根提示手工配置）', async (t) => {
  const sb = sandbox(t, {});
  rmSync(join(sb.dir, 'config'), { recursive: true, force: true });
  const missing = await ensureNapcatHttpClient(sb.dir, '10001', qqPostUrl(8787), async () => true);
  assert.equal(missing.status, 'failed');
  assert.match(missing.detail, /未找到/);

  const bad = sandbox(t, '{ 不是 JSON');
  const broken = await ensureNapcatHttpClient(bad.dir, '10001', qqPostUrl(8787), async () => true);
  assert.equal(broken.status, 'failed');
  assert.match(broken.detail, /不是合法 JSON/);

  const noDir = await ensureNapcatHttpClient('', '', qqPostUrl(8787), async () => true);
  assert.equal(noDir.status, 'failed');

  const badShape = sandbox(t, { network: { httpClients: { 不是: '数组' } } });
  const shape = await ensureNapcatHttpClient(badShape.dir, '10001', qqPostUrl(8787), async () => true);
  assert.equal(shape.status, 'failed');
  assert.match(shape.detail, /不是数组/);
});

test('回落到 onebot11.json（老配置文件名）', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dd-qqpost-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config', 'onebot11.json'), JSON.stringify({ network: { httpClients: [] } }));

  const r = await ensureNapcatHttpClient(dir, '10001', qqPostUrl(8787), async () => true);
  assert.equal(r.status, 'created');
  const json = JSON.parse(readFileSync(join(dir, 'config', 'onebot11.json'), 'utf8')) as { network: { httpClients: unknown[] } };
  assert.equal(json.network.httpClients.length, 1);
});