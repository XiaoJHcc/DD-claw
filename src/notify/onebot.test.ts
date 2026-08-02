import { test } from 'node:test';
import assert from 'node:assert/strict';
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
    const n = new OneBotNotifier('http://napcat:3000', '', [
      { type: 'group', id: '11111', enabled: true },
    ]);
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

test('msg.targets 缺省时用配置的默认目标', async () => {
  const posted: Posted[] = [];
  const restore = stubFetch(posted);
  try {
    const n = new OneBotNotifier('http://napcat:3000', '', [
      { type: 'group', id: '11111', enabled: true },
      { type: 'group', id: '33333', enabled: false },
    ]);
    await n.send(msg());
    assert.equal(posted.length, 1, 'disabled 的默认目标不发');
    assert.ok(posted[0]!.url.endsWith('/send_group_msg'));
    assert.equal(posted[0]!.body['group_id'], 11111);
  } finally {
    restore();
  }
});
