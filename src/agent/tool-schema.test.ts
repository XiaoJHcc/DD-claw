/**
 * 工具面转换测试：zod shape → JSON Schema 的形状、暴露策略，以及与真实注册表的联调烟雾测试。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { allToolDefs, toolDefsForRole, type McpToolDef } from '../mcp/tools.js';
import { AGENT_EXCLUDED_TOOLS, agentToolSpecs, isAgentExposed, paramsFromShape, toolSpecFromDef } from './tool-schema.js';

function def(over: Partial<McpToolDef> & { name: string }): McpToolDef {
  return { description: 'd', schema: {}, role: 'admin', handler: () => ({}), ...over };
}

test('shape → object schema；$schema 元键被剥掉', () => {
  const params = paramsFromShape({ q: z.string().describe('查询词') });
  assert.equal(params.$schema, undefined, '不得带 $schema');
  assert.equal(params.type, 'object');
  assert.deepEqual((params.properties as Record<string, unknown>).q, { type: 'string', description: '查询词' });
  assert.deepEqual(params.required, ['q']);
});

test('nullable/optional 不进 required；regex 变 pattern；空 shape 也可用', () => {
  const params = paramsFromShape({
    uid: z.string().regex(/^\d+$/, 'uid 必须是纯数字字符串'),
    categoryId: z.number().int().positive().nullable().optional(),
  });
  assert.deepEqual(params.required, ['uid'], '可选/可空字段不该 required');
  const props = params.properties as Record<string, Record<string, unknown>>;
  assert.equal(props.uid!.pattern, '^\\d+$');

  const empty = paramsFromShape({});
  assert.equal(empty.type, 'object');
  assert.deepEqual(empty.required, undefined);
});

test('toolSpecFromDef 取 name/description/parameters，不夹带 handler', () => {
  const spec = toolSpecFromDef(def({ name: 'search_streamers', description: '搜主播', schema: { q: z.string() } }));
  assert.deepEqual(Object.keys(spec).sort(), ['description', 'name', 'parameters']);
  assert.equal(spec.name, 'search_streamers');
  assert.equal(spec.description, '搜主播');
});

test('暴露策略：排序类与副作用类被挖掉，其余照给', () => {
  assert.equal(isAgentExposed('upsert_push_rule'), true);
  for (const name of AGENT_EXCLUDED_TOOLS) {
    assert.equal(isAgentExposed(name), false, `${name} 不该暴露`);
  }
  const defs = [
    def({ name: 'upsert_push_rule' }),
    def({ name: 'test_push' }),
    def({ name: 'reorder_push_rules' }),
    def({ name: 'reorder_categories' }),
  ];
  assert.deepEqual(agentToolSpecs(defs).map((s) => s.name), ['upsert_push_rule']);
});

test('与真实注册表联调：全部工具都能转成 object schema（schema 形状不被 toJSONSchema 噎住）', (t) => {
  const defs = allToolDefs();
  assert.ok(defs.length > 20, '注册表规模异常');
  for (const d of defs) {
    const spec = toolSpecFromDef(d);
    assert.equal(spec.name, d.name);
    assert.equal(spec.parameters.type, 'object', `${d.name} 的参数必须是 object`);
    assert.equal(spec.parameters.$schema, undefined, `${d.name} 带了 $schema`);
  }
  t.diagnostic(`注册表 ${defs.length} 个工具全部可转换`);
});

test('与真实注册表联调：admin 工具面里的写工具都在（暴露名单只挖排序/副作用类）', (t) => {
  const specNames = agentToolSpecs(toolDefsForRole('admin')).map((s) => s.name);
  for (const name of ['set_listen', 'upsert_push_rule', 'delete_push_rule', 'upsert_channel', 'set_llm_key', 'update_runtime_config']) {
    assert.ok(specNames.includes(name), `${name} 应在 admin 工具面`);
  }
  for (const name of AGENT_EXCLUDED_TOOLS) {
    assert.ok(!specNames.includes(name), `${name} 不该在工具面`);
  }
  assert.ok(!specNames.includes('list_group_channels'), 'gateway 工具不该进 admin 面');
  t.diagnostic(`admin 工具面 ${specNames.length} 个工具（注册表 ${allToolDefs().length} 个）`);
});
