import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OneBotNotifier } from './onebot.js';
import type { PushMessage } from '../core/types.js';

interface Posted {
  url: string;
  body: Record<string, unknown>;
}

/** 替换全局 fetch，捕获发往 NapCat 的请求 */
function stubFetch(posted: Posted[]): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    posted.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify({ status: 'ok', retcode: 0 }));
  }) as typeof fetch;
  return () => { globalThis.fetch = orig; };
}

function msg(over: Partial<PushMessage> = {}): PushMessage {
  return { title: 't', body: 'b', priority: 'normal', ...over };
}

test('msg.targets 覆盖配置的默认目标，无效 id 记日志跳过', async () => {
  const posted: Posted[] = [];
  const restore = stubFetch(posted);
  try {
    const n = new OneBotNotifier('http://napcat:3000', '');
    const results = await n.send(msg({
      targets: [
        { type: 'group', id: 'abc' },      // 无效 → 跳过且不抛错
        { type: 'private', id: '22222' },  // 有效
      ],
    }));
    assert.equal(posted.length, 1, '默认目标 11111 与无效目标都不应发送');
    assert.ok(posted[0]!.url.endsWith('/send_private_msg'));
    assert.equal(posted[0]!.body['user_id'], 22222);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.target, 'private:22222');
    assert.ok(results[0]!.ok);
  } finally {
    restore();
  }
});

test('msg.targets 缺省/空数组 = 不发（config 目标仅作渠道种子与测试目标）', async () => {
  const posted: Posted[] = [];
  const restore = stubFetch(posted);
  try {
    const n = new OneBotNotifier('http://napcat:3000', '');
    const results = await n.send(msg());
    assert.equal(posted.length, 0, '常规 send 不看配置的默认目标');
    assert.deepEqual(results, []);
  } finally {
    restore();
  }
});

test('attribution 拼成正文尾段，缺省不拼', async () => {
  const posted: Posted[] = [];
  const restore = stubFetch(posted);
  try {
    const n = new OneBotNotifier('http://napcat:3000', '');
    await n.send(msg({
      targets: [{ type: 'private', id: '22222' }],
      attribution: '网游 / CS2  ·  21:31 开播',
    }));
    await n.send(msg({ targets: [{ type: 'private', id: '22222' }] }));
    const segsOf = (i: number) => posted[i]!.body['message'] as Array<{ type: string; data: { text?: string } }>;
    assert.equal(segsOf(0)[0]!.data.text, 't\nb');
    assert.equal(segsOf(0).at(-1)!.data.text, '\n网游 / CS2  ·  21:31 开播');
    assert.equal(segsOf(1).length, 1, '无 attribution 时只有一个文本段');
    assert.equal(segsOf(1)[0]!.data.text, 't\nb');
  } finally {
    restore();
  }
});

test('段序：标题+正文 → 全部图片 → 时间+链接；images 优先于 image', async () => {
  const posted: Posted[] = [];
  const restore = stubFetch(posted);
  const dir = mkdtempSync(join(tmpdir(), 'onebot-test-'));
  const a = join(dir, 'a.jpg');
  const b = join(dir, 'b.jpg');
  writeFileSync(a, 'fake-a');
  writeFileSync(b, 'fake-b');
  try {
    const n = new OneBotNotifier('http://napcat:3000', '');
    await n.send(msg({
      targets: [{ type: 'private', id: '22222' }],
      image: 'https://i2.hdslb.com/bfs/face/should-not-use.jpg',
      images: [a, b],
      attribution: '09/26 21:23',
      url: 'https://x.com/watase_yuzuki/status/9001',
    }));
    const segs = posted[0]!.body['message'] as Array<{ type: string; data: Record<string, string> }>;
    assert.deepEqual(segs.map((s) => s.type), ['text', 'image', 'image', 'text']);
    assert.equal(segs[0]!.data['text'], 't\nb');
    assert.equal(segs[1]!.data['file'], 'base64://' + Buffer.from('fake-a').toString('base64'), '本地图内嵌 base64');
    assert.equal(segs[2]!.data['file'], 'base64://' + Buffer.from('fake-b').toString('base64'), '多图逐张各发一个 image 段');
    assert.equal(segs[3]!.data['text'], '\n09/26 21:23\nhttps://x.com/watase_yuzuki/status/9001');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('本地图读取失败跳过该图（消息照发），远程 URL 原样透传', async () => {
  const posted: Posted[] = [];
  const restore = stubFetch(posted);
  try {
    const n = new OneBotNotifier('http://napcat:3000', '');
    await n.send(msg({
      targets: [{ type: 'private', id: '22222' }],
      images: ['/nonexistent/gone.jpg', 'https://i0.hdslb.com/bfs/new_dyn/x.jpg'],
    }));
    const segs = posted[0]!.body['message'] as Array<{ type: string; data: Record<string, string> }>;
    assert.deepEqual(segs.map((s) => s.type), ['text', 'image']);
    assert.equal(segs[1]!.data['file'], 'https://i0.hdslb.com/bfs/new_dyn/x.jpg');
  } finally {
    restore();
  }
});

test('updateEndpoint 热更新 baseUrl（去尾斜杠），后续请求走新端点', async () => {
  const posted: Posted[] = [];
  const restore = stubFetch(posted);
  try {
    const n = new OneBotNotifier('http://napcat:3000', '');
    n.updateEndpoint('http://napcat:41234/', 'tk');
    await n.send(msg({ targets: [{ type: 'private', id: '22222' }] }));
    assert.ok(posted[0]!.url.startsWith('http://napcat:41234/'));
  } finally {
    restore();
  }
});
