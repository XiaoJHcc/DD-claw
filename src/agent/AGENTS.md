# agent — 进程内对话回路

面板（admin 单会话）与 QQ 渠道（gateway、本渠道）共用同一个 loop；本目录只管「一轮对话怎么跑」。入口接线在 [../panel/AGENTS.md](../panel/AGENTS.md)（`/api/chat*`）与 [../qqbot/AGENTS.md](../qqbot/AGENTS.md)，工具定义在 [../mcp/AGENTS.md](../mcp/AGENTS.md)，写模式与工具面语义见 [docs/modules/qqbot.md](../../docs/modules/qqbot.md) 与 [docs/mcp.md](../../docs/mcp.md)。

## 长期不变量

- **一个 loop 服务所有入口**：差异全部走 `AgentOptions`（scope / role / actor / channelId / systemPrompt / fallbacks / `completeChat` 注入点），loop 不按入口分支、不推断身份——接入层给什么就是什么。
- **工具执行只经 `runToolTracked`**，`entry='agent'`（面板与 QQ 同档，来源靠 scope 与 actor 区分）；loop 不直调 handler，校验 / 审计 / 快照全在能力层。
- **不按 mode 硬拦写工具**：ask / auto 的「先问再写」是系统提示层的纪律，不是 loop 里的闸门；兜底是写可撤销（每次写都落变更记录）。
- **模式与模型不是模型能改的配置**：`set_chat_mode` / `set_chat_provider` 在 `AGENT_EXCLUDED_TOOLS` 里（同名单还有排序类与有外部副作用的 `test_*`）。该常量是生产代码常量，与 `write-path-inventory.test.ts` 互锁——新增工具默认暴露，排除必须写清理由。
- **工具展示形状只有一处信源**：`tool-view.ts` 的 `ToolCallView`（实时回包与历史回放共用；中文名复用 `panel/undo-view.ts`），失败判定与回填文案同源（`错误：` 前缀）。
- **`settings` 是唯一信源**：`chat_write_mode`（缺省 ask）、`chat_provider`（空 = 自动路由，非空不降级）每轮直读；不自动裁剪历史（面板提示用量，QQ 回执附 `/reset` 提示）。
- **步数兜底**：`AGENT_MAX_STEPS` 到顶就收口并告知，不空转、不卡死。

## 文件地图

- `loop.ts` — `runAgentTurn(deps, userMessage, opts)`：读历史 → `[system, ...history, user]` → 循环 `completeChat` → tool_calls 逐个执行、结果或错误文本回填 → 无 tool_calls 即终答；返回 `{reply, steps, toolCalls, truncated, provider, calls}`；`chatBlockedReason` 与 LLM 未就绪 400 / 调用失败 502。
- `system-prompt.ts` — `buildSystemPrompt`（面板，按写模式分两档）/ `buildQqbotSystemPrompt`（QQ 变体：只服务本渠道、永远先复述再等确认、回执要短）/ `getChatWriteMode` / `setChatWriteMode`。
- `tool-schema.ts` — 注册表 → LLM 工具面：`AGENT_EXCLUDED_TOOLS`、`agentToolSpecs`、`paramsFromShape`（zod → JSON Schema）。
- `tool-view.ts` — 一次工具调用 + 回填文本 → `ToolCallView`。
- `loop.test.ts` / `tool-schema.test.ts` — 假 LLM 驱动的多轮剧本与工具面互锁。
