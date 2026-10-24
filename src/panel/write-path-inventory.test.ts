/**
 * 配置写路径清单（机械化）——docs/plan/agent-access.md「配置写路径缺口清单」的单一信源。
 *
 * 为什么是测试而不是文档表格：REST 写路径**只增不减**（X 来源、微博来源都是这么加进来的），
 * 手抄的清单必然持续过期（计划里写的「29 处写分支」在 main 上已经变成 38 处）。
 * 本文件从 server.ts 源码里**提取**写路由，任何新增且未分类的写路由都会让测试失败，
 * 强制动手的人回答两个概念上分开的问题：
 *   ① coverage（回滚覆盖）：这条写是否必须过工具注册表——决定 P0「写操作彻底可撤销」是否成立；
 *      （唯一的第三种取值 `executor` = 撤销执行器本身：写由 UndoStore 完成，不得进快照）
 *   ② exposeToAgent（工具暴露）：这条写 LLM 是否看得见——「①成立」不等于「②开放」。
 *
 * 维护方式：加了写路由 → 在 INVENTORY 补一行 → 填 tool / toolStatus；
 *          补了注册表工具 → 把对应条目的 toolStatus 从 planned 改成 exists（否则测试会提醒你）。
 *
 * 本文件只**只读** server.ts 与 tools.ts 模块，不改任何被改动的文件，故与在改 panel 的分支不冲突。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { AGENT_EXCLUDED_TOOLS } from '../agent/tool-schema.js';
import { allToolDefs } from '../mcp/tools.js';

type Method = 'POST' | 'PUT' | 'DELETE';

/** 写方法出现的那一行 */
const WRITE_METHOD = /method === '(POST|PUT|DELETE)'/;
/** 字面量路径绑定：path === '/api/x' */
const LITERAL_PATH = /path === '([^']+)'/;
/** 正则路径绑定（:param 路由）：const sm = path.match(/^\/api\/x\/([^/]+)$/) */
const REGEX_BINDING = /=\s*path\.match\(\/(.*)\/\)/;

interface ExtractedRoute {
  method: Method;
  /** 与源码逐字一致：字面量 '/api/x'，或正则体 String.raw`^\/api\/x$` */
  pattern: string;
  line: number;
}

/**
 * 从 panel/server.ts 提取所有写路由。
 *
 * 路径绑定与方法的关联走「就近原则」：写方法在同一条 if 条件里时用同一行的字面量路径；
 * 嵌套的 :param 路由（如 streamers/channels/categories/rules）方法检查在内部 if 里，
 * 取其之前最近的一条路径绑定。若某天写法变了导致关联不上，测试会直接失败（宁可响亮地坏，
 * 也不要静默漏掉一条写路径）。
 */
export function extractWriteRoutes(src: string): ExtractedRoute[] {
  const lines = src.split('\n');
  const bindings: Array<{ line: number; pattern: string }> = [];
  lines.forEach((line, i) => {
    const lit = LITERAL_PATH.exec(line);
    if (lit) bindings.push({ line: i, pattern: lit[1]! });
    const re = REGEX_BINDING.exec(line);
    if (re) bindings.push({ line: i, pattern: re[1]! });
  });

  const out: ExtractedRoute[] = [];
  lines.forEach((line, i) => {
    const m = WRITE_METHOD.exec(line);
    if (!m) return;
    const own = LITERAL_PATH.exec(line);
    const near = own
      ? { pattern: own[1]! }
      : [...bindings].reverse().find((b) => b.line <= i);
    assert.ok(near, `server.ts:${i + 1} 的写方法找不到路径绑定，清单解析器需要更新`);
    out.push({ method: m[1] as Method, pattern: near.pattern, line: i + 1 });
  });
  return out;
}

interface InventoryEntry {
  method: Method;
  /** 与 server.ts 源码写法逐字一致（正则体用 String.raw） */
  path: string;
  /** 人类可读标签 */
  label: string;
  /**
   * ① 回滚覆盖：
   * - `registry`  必须过工具注册表（写经 runToolTracked → 落快照）
   * - `executor`  撤销执行器本身：写由 UndoStore 直接完成（撤的是已记录的前像），**不得进快照**
   *               （否则撤销自己会成为下一条可撤销记录）。它对应注册表工具，但 REST 路由
   *               直接调 `deps.undoLast` 而不经 runPanelTool（两者语义等价，工具侧同样 track:false）
   * - `excluded`  明知而未纳入（docs/plan/agent-access.md「变更记录遗漏面」）
   */
  coverage: 'registry' | 'executor' | 'excluded';
  /** coverage≠excluded 时对应的注册表工具名 */
  tool?: string;
  /** 该工具现在有没有（exists = 已在 tools.ts；planned = P0 待补） */
  toolStatus?: 'exists' | 'planned';
  /** ② 工具暴露：LLM/agent 是否看得见这条能力 */
  exposeToAgent: boolean;
  /** excluded 或「暂不暴露」的理由 */
  reason?: string;
}

/**
 * 写路径分类表。来源 = docs/plan/agent-access.md「配置写路径缺口清单」，
 * 按当前代码逐条核对（2026-09-17，mcp-interface @3df7424）。
 */
const INVENTORY: InventoryEntry[] = [
  // ---- 已收敛：面板已有对应注册表工具，P0 只需面板改走 runTool ----
  {
    method: 'PUT', path: String.raw`^\/api\/listen\/(dynamic|weibo|twitter)$`, label: 'PUT /api/listen/:feature',
    coverage: 'registry', tool: 'set_listen', toolStatus: 'exists', exposeToAgent: true,
  },
  {
    method: 'PUT', path: '/api/advanced', label: 'PUT /api/advanced',
    coverage: 'registry', tool: 'update_runtime_config', toolStatus: 'exists', exposeToAgent: true,
  },
  {
    method: 'POST', path: '/api/channels', label: 'POST /api/channels',
    coverage: 'registry', tool: 'upsert_channel', toolStatus: 'exists', exposeToAgent: true,
  },
  {
    method: 'PUT', path: '/api/push/enabled', label: 'PUT /api/push/enabled',
    coverage: 'registry', tool: 'set_push_enabled', toolStatus: 'exists', exposeToAgent: true,
  },
  {
    method: 'PUT', path: '/api/llm/keys', label: 'PUT /api/llm/keys',
    coverage: 'registry', tool: 'set_llm_key', toolStatus: 'exists', exposeToAgent: true,
  },
  {
    method: 'PUT', path: '/api/llm/enabled', label: 'PUT /api/llm/enabled',
    coverage: 'registry', tool: 'set_llm_enabled', toolStatus: 'exists', exposeToAgent: true,
  },
  {
    method: 'PUT', path: '/api/decision/enabled', label: 'PUT /api/decision/enabled',
    coverage: 'registry', tool: 'set_decision_enabled', toolStatus: 'exists', exposeToAgent: true,
  },
  {
    method: 'POST', path: '/api/llm/providers', label: 'POST /api/llm/providers',
    coverage: 'registry', tool: 'upsert_llm_provider', toolStatus: 'exists', exposeToAgent: true,
    reason: '待裁决：REST 拒绝重名 vs upsert_llm_provider 按名更新，收敛前须统一口径',
  },
  {
    method: 'PUT', path: String.raw`^\/api\/llm\/providers\/([^/]+)$`, label: 'PUT /api/llm/providers/:name',
    coverage: 'registry', tool: 'upsert_llm_provider', toolStatus: 'exists', exposeToAgent: true,
  },
  {
    method: 'DELETE', path: String.raw`^\/api\/llm\/providers\/([^/]+)$`, label: 'DELETE /api/llm/providers/:name',
    coverage: 'registry', tool: 'delete_llm_provider', toolStatus: 'exists', exposeToAgent: true,
  },
  {
    method: 'POST', path: '/api/decision/providers', label: 'POST /api/decision/providers',
    coverage: 'registry', tool: 'upsert_decision_provider', toolStatus: 'exists', exposeToAgent: true,
  },
  {
    method: 'PUT', path: String.raw`^\/api\/decision\/providers\/([^/]+)$`, label: 'PUT /api/decision/providers/:name',
    coverage: 'registry', tool: 'upsert_decision_provider', toolStatus: 'exists', exposeToAgent: true,
  },
  {
    method: 'DELETE', path: String.raw`^\/api\/decision\/providers\/([^/]+)$`, label: 'DELETE /api/decision/providers/:name',
    coverage: 'registry', tool: 'delete_decision_provider', toolStatus: 'exists', exposeToAgent: true,
  },
  {
    method: 'POST', path: '/api/categories', label: 'POST /api/categories',
    coverage: 'registry', tool: 'upsert_category', toolStatus: 'exists', exposeToAgent: true,
  },
  {
    method: 'POST', path: '/api/categories/test', label: 'POST /api/categories/test',
    coverage: 'registry', tool: 'test_category', toolStatus: 'exists', exposeToAgent: false,
    reason: '草稿试跑：读随机归档样本 + 模型调用，不写库、不推送（与其它 test_* 同档）；'
      + '一次试跑要占分析队列，且结论只对人有用 → 不暴露给 agent',
  },
  {
    method: 'POST', path: '/api/rules', label: 'POST /api/rules',
    coverage: 'registry', tool: 'upsert_push_rule', toolStatus: 'exists', exposeToAgent: true,
  },
  {
    method: 'POST', path: String.raw`^\/api\/streamers\/([^/]+?)(\/watch)?$`, label: 'POST /api/streamers/:uid/watch',
    coverage: 'registry', tool: 'watch_streamer', toolStatus: 'exists', exposeToAgent: true,
  },
  {
    method: 'PUT', path: String.raw`^\/api\/streamers\/([^/]+?)(\/watch)?$`, label: 'PUT /api/streamers/:uid',
    coverage: 'registry', tool: 'set_streamer', toolStatus: 'exists', exposeToAgent: true,
  },
  {
    method: 'PUT', path: String.raw`^\/api\/channels\/([^/]+)$`, label: 'PUT /api/channels/:id',
    coverage: 'registry', tool: 'upsert_channel', toolStatus: 'exists', exposeToAgent: true,
  },
  {
    method: 'DELETE', path: String.raw`^\/api\/channels\/([^/]+)$`, label: 'DELETE /api/channels/:id',
    coverage: 'registry', tool: 'delete_channel', toolStatus: 'exists', exposeToAgent: true,
  },
  {
    method: 'PUT', path: String.raw`^\/api\/categories\/([^/]+)$`, label: 'PUT /api/categories/:id',
    coverage: 'registry', tool: 'upsert_category', toolStatus: 'exists', exposeToAgent: true,
  },
  {
    method: 'DELETE', path: String.raw`^\/api\/categories\/([^/]+)$`, label: 'DELETE /api/categories/:id',
    coverage: 'registry', tool: 'delete_category', toolStatus: 'exists', exposeToAgent: true,
    reason: '级联停用引用规则现为两条独立语句（非原子），收敛时须事务化（撤销快照的前提）',
  },
  {
    method: 'PUT', path: String.raw`^\/api\/rules\/([^/]+)$`, label: 'PUT /api/rules/:id',
    coverage: 'registry', tool: 'upsert_push_rule', toolStatus: 'exists', exposeToAgent: true,
  },
  {
    method: 'DELETE', path: String.raw`^\/api\/rules\/([^/]+)$`, label: 'DELETE /api/rules/:id',
    coverage: 'registry', tool: 'delete_push_rule', toolStatus: 'exists', exposeToAgent: true,
  },

  {
    method: 'PUT', path: '/api/x', label: 'PUT /api/x',
    coverage: 'registry', tool: 'update_x_config', toolStatus: 'exists', exposeToAgent: true,
  },
  {
    method: 'POST', path: '/api/x/accounts', label: 'POST /api/x/accounts',
    coverage: 'registry', tool: 'upsert_x_account', toolStatus: 'exists', exposeToAgent: true,
  },
  {
    method: 'PUT', path: String.raw`^\/api\/x\/accounts\/(\d+)$`, label: 'PUT /api/x/accounts/:id',
    coverage: 'registry', tool: 'upsert_x_account', toolStatus: 'exists', exposeToAgent: true,
  },
  {
    method: 'DELETE', path: String.raw`^\/api\/x\/accounts\/(\d+)$`, label: 'DELETE /api/x/accounts/:id',
    coverage: 'registry', tool: 'delete_x_account', toolStatus: 'exists', exposeToAgent: true,
  },
  {
    method: 'POST', path: '/api/weibo/accounts', label: 'POST /api/weibo/accounts',
    coverage: 'registry', tool: 'upsert_weibo_account', toolStatus: 'exists', exposeToAgent: true,
  },
  {
    method: 'PUT', path: String.raw`^\/api\/weibo\/accounts\/(\d+)$`, label: 'PUT /api/weibo/accounts/:id',
    coverage: 'registry', tool: 'upsert_weibo_account', toolStatus: 'exists', exposeToAgent: true,
  },
  {
    method: 'DELETE', path: String.raw`^\/api\/weibo\/accounts\/(\d+)$`, label: 'DELETE /api/weibo/accounts/:id',
    coverage: 'registry', tool: 'delete_weibo_account', toolStatus: 'exists', exposeToAgent: true,
  },
  {
    method: 'POST', path: '/api/bili/accounts', label: 'POST /api/bili/accounts',
    coverage: 'registry', tool: 'upsert_bili_account', toolStatus: 'exists', exposeToAgent: true,
  },
  {
    method: 'PUT', path: String.raw`^\/api\/bili\/accounts\/(\d+)$`, label: 'PUT /api/bili/accounts/:id',
    coverage: 'registry', tool: 'upsert_bili_account', toolStatus: 'exists', exposeToAgent: true,
  },
  {
    method: 'DELETE', path: String.raw`^\/api\/bili\/accounts\/(\d+)$`, label: 'DELETE /api/bili/accounts/:id',
    coverage: 'registry', tool: 'delete_bili_account', toolStatus: 'exists', exposeToAgent: true,
  },

  // ---- 已收敛但 P0 待补工具（「①成不成立」的答案：成立，写必须过注册表；②暂关） ----
  {
    method: 'POST', path: '/api/x/test', label: 'POST /api/x/test',
    coverage: 'registry', tool: 'test_x_connection', toolStatus: 'exists', exposeToAgent: false,
    reason: '网络探测（代理/Nitter/免登录）+ 探测状态快照写 settings → 不暴露给 agent',
  },
  {
    method: 'PUT', path: '/api/channels/order', label: 'PUT /api/channels/order',
    coverage: 'registry', tool: 'reorder_channels', toolStatus: 'exists', exposeToAgent: false,
    reason: '排序类：先进注册表以纳入回滚覆盖；是否暴露给 agent 单独决定',
  },
  {
    method: 'PUT', path: '/api/categories/order', label: 'PUT /api/categories/order',
    coverage: 'registry', tool: 'reorder_categories', toolStatus: 'exists', exposeToAgent: false,
    reason: '同上',
  },
  {
    method: 'PUT', path: '/api/rules/order', label: 'PUT /api/rules/order',
    coverage: 'registry', tool: 'reorder_push_rules', toolStatus: 'exists', exposeToAgent: false,
    reason: '同上',
  },
  {
    method: 'PUT', path: '/api/llm/providers/order', label: 'PUT /api/llm/providers/order',
    coverage: 'registry', tool: 'reorder_llm_providers', toolStatus: 'exists', exposeToAgent: false,
    reason: '同上',
  },
  {
    method: 'PUT', path: '/api/decision/providers/order', label: 'PUT /api/decision/providers/order',
    coverage: 'registry', tool: 'reorder_decision_providers', toolStatus: 'exists', exposeToAgent: false,
    reason: '同上',
  },
  {
    method: 'POST', path: '/api/push/test', label: 'POST /api/push/test',
    coverage: 'registry', tool: 'test_push', toolStatus: 'exists', exposeToAgent: false,
    reason: '有对外副作用（真发一条消息）、不可撤销 → 不暴露给 agent',
  },
  {
    method: 'POST', path: String.raw`^\/api\/llm\/providers\/([^/]+)\/test$`, label: 'POST /api/llm/providers/:name/test',
    coverage: 'registry', tool: 'test_llm_provider', toolStatus: 'exists', exposeToAgent: false,
    reason: '网络探测 + 失败计熔断，非 DB 写 → 不暴露给 agent',
  },
  {
    method: 'POST', path: String.raw`^\/api\/decision\/providers\/([^/]+)\/test$`,
    label: 'POST /api/decision/providers/:name/test',
    coverage: 'registry', tool: 'test_decision_provider', toolStatus: 'exists', exposeToAgent: false,
    reason: '网络探测（真实 systemone 请求），非 DB 写 → 不暴露给 agent',
  },

  // ---- 撤销执行器（唯一不进快照的写面：它就是回滚动作本身）----
  {
    method: 'POST', path: '/api/undo', label: 'POST /api/undo',
    coverage: 'executor', tool: 'undo_last_change', toolStatus: 'exists', exposeToAgent: true,
    reason: '撤销执行器：写由 UndoStore.undo() 完成（把已记录的前像写回去），进快照会让撤销自己'
      + '成为下一条可撤销记录；对应注册表工具 undo_last_change（同样 track:false），'
      + '但 REST 路由直接调 deps.undoLast（不经 runPanelTool）',
  },

  // ---- WebUI Agent 对话（P1）----
  {
    method: 'PUT', path: '/api/chat/mode', label: 'PUT /api/chat/mode',
    coverage: 'registry', tool: 'set_chat_mode', toolStatus: 'exists', exposeToAgent: false,
    reason: '写模式开关（ask=写前询问 / auto=自动修改）：是配置写，进注册表以纳入回滚覆盖；'
      + '但**不得暴露给 agent**——LLM 若能自己切到 auto，「未经确认不写」的门槛就交回给了模型，'
      + 'P1 验收的「误写率 0 容忍」名存实亡',
  },
  {
    method: 'PUT', path: '/api/chat/provider', label: 'PUT /api/chat/provider',
    coverage: 'registry', tool: 'set_chat_provider', toolStatus: 'exists', exposeToAgent: false,
    reason: 'Agent 模型选择（settings chat_provider，空串=自动路由）：是配置写，进注册表以纳入回滚覆盖；'
      + '但**不得暴露给 agent**——换模型是主人对成本与质量的取舍，模型不该自己「点将」，'
      + '也不该在自己答不好时改配置',
  },
  {
    method: 'POST', path: '/api/chat', label: 'POST /api/chat',
    coverage: 'excluded', exposeToAgent: false,
    reason: 'agent 对话入口：路由自身只写 chat_messages（会话记录，非配置、不入撤销栈）；'
      + '对话里产生的配置写各自经工具面落快照（entry=agent），故这里不重复覆盖',
  },
  {
    method: 'POST', path: '/api/chat/reset', label: 'POST /api/chat/reset',
    coverage: 'excluded', exposeToAgent: false,
    reason: '清空会话消息（chat_messages）、保留会话行：非配置写；重置上下文是用户显式动作，'
      + '撤销它没有意义（旧消息不会因为撤销而「回来」）',
  },

  // ---- 明知而未纳入（docs/plan/agent-access.md「变更记录遗漏面」） ----
  {
    method: 'PUT', path: '/api/napcat', label: 'PUT /api/napcat',
    coverage: 'excluded', exposeToAgent: false,
    reason: '写 onebot11_<uin>.json / 计划任务（文件与进程写面），兜底靠面板卡片 + 看门狗自愈',
  },
  {
    method: 'POST', path: '/api/napcat/launch', label: 'POST /api/napcat/launch',
    coverage: 'excluded', exposeToAgent: false,
    reason: '同上',
  },
  {
    method: 'POST', path: '/api/auth/bili/qrcode', label: 'POST /api/auth/bili/qrcode',
    coverage: 'excluded', exposeToAgent: false,
    reason: '人机交互（扫码）；凭据落盘 cookies.json 属隐私例外',
  },
  {
    method: 'POST', path: '/api/auth/weibo/qrcode', label: 'POST /api/auth/weibo/qrcode',
    coverage: 'excluded', exposeToAgent: false,
    reason: '同上（weibo-cookies.json）',
  },
  {
    method: 'POST', path: '/onebot', label: 'POST /onebot',
    coverage: 'excluded', exposeToAgent: false,
    reason: 'OneBot 11 事件入口（NapCat 直连 P3）：消息入口而非主人能力面；'
      + '路由自身只写 chat_messages 与经工具面落快照的渠道栈写（entry=agent）',
  },
];

/**
 * 带写副作用的 GET：不是写方法，但会改变状态（扫码 poll 确认后落盘凭据 + 热重启源）。
 * 单独列出以免「按方法过滤」把它们漏掉。
 */
const SIDE_EFFECT_GETS: Array<{ path: string; reason: string }> = [
  {
    path: '/api/auth/bili/qrcode/poll',
    reason: 'confirmed 时写 cookies.json 并热重启 B 站源',
  },
  {
    path: '/api/auth/weibo/qrcode/poll',
    reason: 'confirmed 时写 weibo-cookies.json 并热重启微博源',
  },
  {
    path: '/api/category-sample-image',
    reason: '首次请求把 X 图经代理下载进图片缓存目录（缓存文件写面，非配置写；'
      + '只允许 https://pbs.twimg.com/，读盘仍守缓存目录边界）',
  },
];

const SERVER_SRC = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');

const key = (r: { method: Method; pattern: string }): string => `${r.method} ${r.pattern}`;

test('写路径清单与 server.ts 源码完全对齐（新增未分类的写路由即失败）', (t) => {
  const extracted = extractWriteRoutes(SERVER_SRC);
  const known = new Map(INVENTORY.map((e) => [`${e.method} ${e.path}`, e]));

  const unclassified = extracted.filter((r) => !known.has(key(r)));
  assert.deepEqual(
    unclassified.map((r) => `server.ts:${r.line}  ${r.method} ${r.pattern}`),
    [],
    '发现未分类的 REST 写路径。请在 INVENTORY 里补一行，并回答两件事：\n' +
      '  ① coverage：默认纳入回滚覆盖（写必须过工具注册表）；' +
      '只有「写由 UndoStore 直接完成」的撤销执行器用 executor，明知遗漏用 excluded\n' +
      '  ② exposeToAgent：这条能力是否让 LLM/agent 看得见\n' +
      '（背景见 docs/plan/agent-access.md「配置写路径缺口清单」）',
  );

  const extractedKeys = new Set(extracted.map(key));
  const stale = INVENTORY.filter((e) => !extractedKeys.has(`${e.method} ${e.path}`));
  assert.deepEqual(
    stale.map((e) => `${e.method} ${e.path}  (${e.label})`),
    [],
    'INVENTORY 里有条目在 server.ts 里已提取不到（路由被改名/删除），请同步更新本表',
  );

  t.diagnostic(`已分类写路由 ${INVENTORY.length} 条（源码提取 ${extracted.length} 条）`);
});

test('planned / exists 状态与 tools.ts 注册表一致（表不能骗人）', (t) => {
  const defs = new Map(allToolDefs().map((d) => [d.name, d]));

  for (const e of INVENTORY) {
    if (e.coverage === 'excluded') {
      assert.equal(e.tool, undefined, `${e.label}: excluded 条目不应声明工具名`);
      continue;
    }
    assert.ok(e.tool, `${e.label}: coverage=${e.coverage} 但没写 tool`);
    const def = defs.get(e.tool!);
    if (e.toolStatus === 'exists') {
      assert.ok(def, `${e.label}: 表里标 exists 的工具「${e.tool}」在 tools.ts 里不存在（改名了？）`);
      assert.equal(def!.write, true, `${e.label}: 写路径映射到了非写工具「${e.tool}」`);
      if (e.coverage === 'executor') {
        // 撤销执行器与「撤销不入栈」互锁：工具体必须声明不带快照（见 McpToolDef.track 注释）
        assert.equal(
          def!.track, false,
          `${e.label}: 撤销执行器「${e.tool}」必须 track:false（否则撤销自己会进变更记录）`,
        );
      }
    }
    if (e.toolStatus === 'planned') {
      assert.equal(
        def, undefined,
        `${e.label}: 工具「${e.tool}」已经补上了——请把该条目的 toolStatus 改成 exists`,
      );
    }
  }

  const gaps = INVENTORY.filter((e) => e.toolStatus === 'planned');
  t.diagnostic(
    `P0 收敛缺口 ${gaps.length} 条：` + gaps.map((e) => e.tool).join(' / '),
  );
});

test('工具暴露策略闭环：exposeToAgent 与生产侧 AGENT_EXCLUDED_TOOLS 互为反面', () => {
  for (const e of INVENTORY) {
    if (e.coverage === 'excluded' || e.tool === undefined) continue;
    const policyExposed = !AGENT_EXCLUDED_TOOLS.includes(e.tool);
    assert.equal(
      e.exposeToAgent, policyExposed,
      `${e.label}: 清单说 exposeToAgent=${e.exposeToAgent}，但 src/agent/tool-schema.ts 的名单给出 ${policyExposed}` +
        '（暴露策略只有一处信源，改一边必须改另一边）',
    );
  }
});

test('带写副作用的 GET 仍在源码里（清单逐条可在源码核对）', (t) => {
  for (const g of SIDE_EFFECT_GETS) {
    assert.ok(
      SERVER_SRC.includes(`path === '${g.path}'`),
      `带写副作用的 GET ${g.path} 在 server.ts 里找不到了，请复核「配置写路径缺口清单」`,
    );
  }
  t.diagnostic(`带写副作用 GET ${SIDE_EFFECT_GETS.length} 条，均属排除范围`);
});
