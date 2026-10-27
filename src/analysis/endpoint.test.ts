import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endpointUrl } from './endpoint.js';

test('endpointUrl：末尾斜杠可有可无，缺版本段按协议补默认 v1', () => {
  assert.equal(
    endpointUrl('https://api.deepseek.com', 'chat-completions'),
    'https://api.deepseek.com/v1/chat/completions',
  );
  assert.equal(
    endpointUrl('https://api.deepseek.com/', 'chat-completions'),
    'https://api.deepseek.com/v1/chat/completions',
  );
  assert.equal(
    endpointUrl('  https://api.deepseek.com//  ', 'chat-completions'),
    'https://api.deepseek.com/v1/chat/completions',
    '首尾空白与多重尾斜杠一并归一',
  );
  assert.equal(endpointUrl('http://127.0.0.1:8080', 'responses'), 'http://127.0.0.1:8080/v1/responses');
  assert.equal(endpointUrl('https://api.typesafe.ai', 'systemone'), 'https://api.typesafe.ai/v1/systemone');
  assert.equal(
    endpointUrl('https://gateway.example.com/openai', 'chat-completions'),
    'https://gateway.example.com/openai/v1/chat/completions',
    '路径前缀保留，版本补在前缀之后',
  );
});

test('endpointUrl：baseURL 自带版本段就沿用，不重复补 /v1', () => {
  assert.equal(
    endpointUrl('https://api.deepseek.com/v1', 'chat-completions'),
    'https://api.deepseek.com/v1/chat/completions',
  );
  assert.equal(
    endpointUrl('https://api.deepseek.com/v1/', 'chat-completions'),
    'https://api.deepseek.com/v1/chat/completions',
  );
  assert.equal(
    endpointUrl('https://api.example.com/v3', 'chat-completions'),
    'https://api.example.com/v3/chat/completions',
    '非 v1 的版本号同样认',
  );
  assert.equal(
    endpointUrl('https://gateway.example.com/openai/v3/', 'responses'),
    'https://gateway.example.com/openai/v3/responses',
  );
  assert.equal(
    endpointUrl('https://open.bigmodel.cn/api/paas/v4/', 'chat-completions'),
    'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    '带路径前缀的非 v1 版本（智谱 v4）也按原版本拼',
  );
  assert.equal(
    endpointUrl('https://api.typesafe.ai/v1beta1', 'systemone'),
    'https://api.typesafe.ai/v1beta1/systemone',
    '预发布版本段也算版本',
  );
});

test('endpointUrl：误把整条端点贴进 baseURL 时剥回版本根，路径不重复', () => {
  assert.equal(
    endpointUrl('https://api.deepseek.com/v1/chat/completions', 'chat-completions'),
    'https://api.deepseek.com/v1/chat/completions',
  );
  assert.equal(
    endpointUrl('https://api.deepseek.com/chat/completions/', 'chat-completions'),
    'https://api.deepseek.com/v1/chat/completions',
    '缺版本段时仍补默认 v1',
  );
  assert.equal(
    endpointUrl('https://api.deepseek.com/openai/v1/chat/completions', 'chat-completions'),
    'https://api.deepseek.com/openai/v1/chat/completions',
  );
  assert.equal(
    endpointUrl('https://api.openai.com/v1/responses', 'responses'),
    'https://api.openai.com/v1/responses',
  );
  assert.equal(
    endpointUrl('http://127.0.0.1:8080/v1/systemone', 'systemone'),
    'http://127.0.0.1:8080/v1/systemone',
  );
});
