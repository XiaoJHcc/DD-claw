# mcp — 能力面注册表与 MCP 传输

`tools.ts` 是工具（名字 + zod schema + handler + 角色 + 写/快照标注）的唯一信源，本目录其余文件是执行、鉴权与传输适配。运维面（令牌、Host 接入、安全模型、排障）见 [docs/mcp.md](../../docs/mcp.md)；HTTP 适配层见 [../panel/AGENTS.md](../panel/AGENTS.md)，进程内对话回路见 [../agent/AGENTS.md](../agent/AGENTS.md)。

## 长期不变量

- **唯一能力信源**：工具只在这里定义；新增入口是接线，不是复制 handler。前端不得绕过注册表私接 Db。
- **角色在能力层标注，身份在接入层确权**：`shared` / `admin` / `gateway`。越权工具对 gateway 连接**根本不注册**（`tools/list` 不可见、调用得到 Tool not found），不是注册后靠参数拒绝。
- **身份字段永不进工具 schema**：`channelId` 只从令牌绑定的 `ctx.scope.channelId` 读，LLM 在参数里塞渠道会被 zod 剥离。未绑渠道的 gateway 一律 403，绝不回落默认渠道，也绝不回落「全部」。
- **gateway 自助在服务端强制**：渠道必须是已启用的 onebot 群/私聊（私聊一视同仁）；主播必须在监听名单；同主播同分类去重；单渠道自助规则 ≤20 条；规则打 `createdBy='mcp'`；删除先校验渠道归属；多渠道规则先 copy-on-write 拆出只含本渠道的一条（拆分与后续写同一事务，原规则内容一行不动）；读侧按 scope 裁剪；写限流按渠道分桶。
- **写一律经 `runToolTracked`**：zod 再校验 + 审计 + 撤销快照 + 错误归一都在能力层。`undo_last_change` 是唯一 `track: false` 的写工具——它的写是回写已记录的前像，入栈会把自己变成下一条可撤销记录。
- **撤销栈由调用域决定**：admin 全局栈；gateway 绑定渠道栈，未绑渠道拒绝。撤销自身不进变更记录。
- **审计与凭据**：写操作记「角色:令牌名 #渠道 + 工具 + 参数」，LLM key 打码；token 只进 `Authorization` 头，绝不进日志与错误信息（比较走 sha256 + timingSafeEqual）。
- **工具清单不进文档表**：具体用法以 `tools/list` 的 description 为准（LLM 消费口径）；暴露面由 `agent/tool-schema.ts` 的排除名单与 `write-path-inventory.test.ts` 互锁，文档只写运维面与不变量。

## 文件地图

- `auth.ts` — 令牌模型：`mcp_tokens` settings 读写（gateway 令牌带 `channelId`）、`mintToken`、`resolveMcpAuth`（Bearer → `{name, role, scope}`；无令牌 `'unconfigured'` 503、无效 `null` 401；非法渠道绑定视为未绑定）。
- `tools.ts` — 工具注册表与全部 handler；角色 / 写 / 快照标注；调用域读侧裁剪；gateway 自助的 copy-on-write 与限流接线；`registerTools` / `toolDefsForRole` / `allToolDefs` / `toolDefByName`。
- `run-tool.ts` — 能力层唯一执行入口：`runTool`（校验 + 审计 + 错误归一，不抛异常）+ `runToolTracked`（写经 `UndoStore.track` 落变更记录）；`scopeChannelId` / `scopeOf` / `undoScopeOf` / `toolChangeMeta` / `ToolEntry`（panel / mcp / agent）/ `PANEL_TOOL_CTX`。
- `handler.ts` — `/mcp` 无状态处理：Bearer 鉴权 → 每请求新建 McpServer + StreamableHTTPServerTransport（`sessionIdGenerator: undefined`），GET/DELETE 由 SDK 回 405。
- `rate-limit.ts` — gateway 写限流滑动窗口（内存，每渠道 20 次/10min；无 scope 回落令牌名）+ `resetMcpWriteLimiter` 供测试隔离。
- `mcp.test.ts` / `run-tool.test.ts` — 角色工具面、调用域强制、自助写语义、执行器契约回归。
