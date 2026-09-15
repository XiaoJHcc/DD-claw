# 多前端接入统一计划（Agent 能力面）

> 状态：统一计划（2026-09-15 定）。把「查看状态 / 修改数据」的所有接入途径归纳为一个架构：
> **一个能力面，N 种接线**。已实现部分的运维文档见 [mcp.md](../mcp.md)。

## 统一认知

```
                        ┌─ Web UI（panel REST，人点鼠标）        [已有]
                        ├─ MCP over HTTP（进程外 Host）          [已有]
tools.ts 工具注册表 ────┼─ WebUI Agent（进程内 agent loop）      [待做 P1]
（唯一能力信源：         ├─ MaiBot 插件（HTTP 调 /mcp）           [待做 P2]
 zod schema + handler   └─ NapCat 直连（OneBot 事件 → 进程内）   [待做 P3]
 + role 标注）
```

- **能力层与传输层解耦**：`src/mcp/tools.ts` 的注册表（`toolDefsForRole()`）是纯数据结构，任何前端直接消费，不经过 HTTP。`/mcp` 端点只是「进程外 Host」这一种接线的适配器。
- **角色在能力层标注，身份在接入层确权**：能力层只看 role（admin/gateway）决定工具可见性；「这个调用者是谁、该得什么角色」由各接入途径用自己的可信锚点判定。
- **新能力先进注册表，再接前端**——任何途径不得绕过注册表私接 Db。

## 接入途径矩阵

| 途径 | 状态 | 传输 | 身份确权（可信锚点） | 角色 | 典型场景 |
|---|---|---|---|---|---|
| Web UI（REST） | 已有 | HTTP /api/* | localhost 绑定 = 主人 | admin | 面板点选管理 |
| MCP | 已有 | streamable HTTP /mcp | Bearer token（连接级） | admin / gateway | 管理员本机 Claude Code；进程外 Host |
| WebUI Agent | 待做 P1 | 进程内 agent loop + POST /api/chat | localhost 绑定 = 主人 | admin | 本机后台自然语言改设置、查库 |
| MaiBot 插件 | 待做 P2 | 插件 HTTP 调 /mcp | OneBot 事件 group_id（插件代码钉死）+ gateway token | gateway + 群→channel 映射 | 群友自然语言自助（MaiBot 已在监听群聊时） |
| NapCat 直连 | 待做 P3 | OneBot 上报 → 进程内 agent loop（或斜杠命令） | OneBot 事件 user_id/group_id（天然可信，不经 LLM） | 主人私聊 admin / 群 gateway | 绕过 MaiBot 的 QQ 对话；MaiBot 不监听群聊时 |

关键区分：

- **MaiBot 插件 vs NapCat 直连**解决同一个问题（QQ 群/私聊对话入口），互斥择优——MaiBot 持续用 LLM 监听群聊且能判断群号时走插件（DD-claw 零新组件）；想绕过 MaiBot、或用自己的 LLM/规则（如斜杠命令）时才走直连。
- **NapCat 直连的信任链最短**：事件 user_id/group_id 是 NapCat 直接给的，主人私聊改设置、群隔离都天然成立，v2 的 HMAC 盖章永久不需要。代价是 DD-claw 自己收消息（新增事件接收 + 触发纪律 + 对话限流）。
- **斜杠命令变体**：P3 可以不接 LLM——确定性解析 `/dd watch 阿梓` 类命令直调注册表 handler，零 LLM 成本、零注入面，适合群友自助的最小可用形态。

## 信任模型总表

| 锚点 | 可信性 | 用于 |
|---|---|---|
| localhost 绑定 | 可信（本机即主人） | Web UI / WebUI Agent → admin |
| Bearer token（连接级） | 可信（settings `mcp_tokens` 唯一信源） | MCP / MaiBot 插件 → 角色 |
| OneBot 事件 user_id/group_id | 可信（不经 LLM） | NapCat 直连 → admin/gateway + 群映射；MaiBot 插件（事件层转发）→ 群映射 |
| LLM 生成的一切参数 | **永不可信** | 只允许表达业务内容（主播是谁、加还是删），永不含身份/渠道声明 |

## 共享新组件（一次投入，多前端复用）

| 组件 | 内容 | 量级 | 被谁复用 |
|---|---|---|---|
| schema 转换 | zod v4 `z.toJSONSchema()`，`z.object(shape)` 包一层即成 function 定义，零新依赖 | ~30 行 | agent loop |
| `completeChat` | providers.ts 扩展：messages + tools 透传、解析 tool_calls；熔断/key 池/降级与 completeJson 同源；不支持 tools 的端点走 JSON 模拟降级（现有 completeJson 即可拼） | ~120 行 + 测试 | agent loop |
| agent loop（`src/agent/`） | maxSteps ≈ 8、handler 进程内直调注册表、工具错误回填自我纠正、审计复用 | ~80 行 + 测试 | WebUI Agent / NapCat 直连 |
| 群→channel 映射 | settings 存 `group_channel:<groupId>` → channelId | ~20 行 | MaiBot 插件 / NapCat 直连 |
| 事件接收 + 触发纪律 + 对话限流 | NapCat httpPost 上报端点、仅 @bot 响应（与 MaiBot 触发词错开）、对话级限流 | ~200 行 | 仅 NapCat 直连 |

## 分期

- **P1：agent loop + WebUI Agent**（~500 行含测试，一两天）
  落地 loop 与 completeChat；验证工具 description 的 LLM 命中率；管理员场景无身份问题，风险最低。
  交付：`/api/chat` + 面板聊天卡。
- **P2：MaiBot 插件**（独立仓库，DD-claw 零改动；详案见下节）
  前置 = MaiBot 持续监听群聊且用户接受插件维护。
  插件侧自行实现 group→channel 钉死；DD-claw 只保证 gateway 契约稳定。
- **P3：NapCat 直连**（~200 行 + P1 的 loop）
  前置 = 决定绕过 MaiBot（或 MaiBot 不监听群聊）。两个变体：斜杠命令（确定性，先做也够）
  与 LLM 对话（复用 P1 loop）。触发纪律是与 MaiBot 共存的产品决策，动手前拍板。

P2 与 P3 顺序可互换、也可只做其一——取决于「MaiBot 是否继续作为群聊对话方」。

## P2 详案：MaiBot 插件（群自助推送）

> 状态：预研，未动工。插件独立仓库（Python），不进 DD-claw 主仓；DD-claw 侧能力已就绪
> （`/mcp` + gateway 角色，见 [mcp.md](../mcp.md)），本案不需要 DD-claw 改动。

### 目标场景与硬边界

群友在 QQ 群里用自然语言自助：「把栞栞的开播推到本群」「别推 XXX 了」「本群现在推哪些主播」。
硬边界：**每个群只能看到本群的推送配置、只能改本群的推送**；主人（私聊/面板/Claude Code）不受此限。

### 为什么 MaiBot 不直连 MCP（2026-09-15 定案）

1. **MaiBot 的 MCP 连接是进程级共享**：所有聊天流共用同一条连接
   （[官方 release note](https://github.com/Mai-with-u/MaiBot/releases)），配置在全局
   `bot_config.toml` 的 `[mcp]` 段，没有任何按群/按聊天划分的字段
   （[MCP 配置文档](https://docs.mai-mai.org/manual/configuration/mcp-config)）。
   → 连接级 token 无法区分调用来自哪个群，服务端 scope 最多覆盖全部群的并集。
2. **工具参数全部由 LLM 生成**：任何自报群号的字段都可被 prompt injection 伪造，不能作信任锚点。

唯一可信的群身份来源是 OneBot 消息事件里的 `group_id`——能读到它的确定性代码只在
MaiBot 事件层，即插件。注意：否定的是「MaiBot 作为 MCP Host 直连」；插件本身仍消费
`/mcp` 端点，DD-claw 侧零改动。

### 信任模型推论（在总表基础上）

- 插件对 LLM 暴露的动作里**没有 channelId 参数**——由插件按事件 group_id 查映射注入，LLM 无从伪造。
- 读侧：`list_push_rules` 结果由插件按本群 channelId 过滤后再喂给 LLM；不调
  `list_group_channels`（避免他群群号进入 LLM 上下文）。
- prompt injection 的最坏结果 = 本群成员给本群加/删规则——这正是开放的能力本身。

### 插件设计（v1）

技术栈：Python + [maibot-plugin-sdk](https://github.com/Mai-with-u/maibot-plugin-sdk)
（能力代理、配置模型、热重载）。

配置（插件 config.toml）：

```toml
endpoint = "http://127.0.0.1:8787/mcp"
token = "ddc_..."            # gateway 令牌，明文（同本机明文口径）

[[groups]]                   # 群 → DD-claw 群渠道映射（可信锚点，主人维护）
group_id = 123456789
channel_id = 2
```

对 LLM 暴露三个动作（channelId 全部由插件注入）：

| 动作 | 链路 |
|---|---|
| 添加本群推送（主播名/uid，分类、推送词可选） | `search_streamers` 确认 uid → `add_group_push_rule` |
| 删除本群推送（主播名或规则 id） | `list_push_rules` 过滤本群定位 → `remove_group_push_rule` |
| 查看本群推送 | `list_push_rules` 过滤本群 + `list_streamers` / `list_categories` 翻译名称 |

调 `/mcp`：无状态 streamable_http——每次 `POST {endpoint}` 带
`Authorization: Bearer …` / `Content-Type: application/json` /
`Accept: application/json, text/event-stream`，JSON-RPC `tools/call`，
解析 SSE `data:` 帧取 result。业务错误（`isError` 的中文报错）直接透传回群。

### 阶段与不做

- **v1（本案）**：单群起步，三个动作；实测 LLM 选动作/填参数的命中率与注入抵抗，按表现调 description
- **v2（预留）**：主人私聊改全局设置——同一插件处理私聊事件时构成「单入口跨权限域」，
  上 HMAC 盖章（共享密钥签名 user_id，DD-claw 验签后提升 admin）；届时才动 DD-claw 侧
- **不做**：MaiBot 直连 MCP；插件内重复实现服务端已有约束（限流/去重/条数上限以服务端为准）

### 动手前待验证

- maibot-plugin-sdk 的动作注册形态：LLM 如何选择插件动作、description 写法、
  与 MaiBot 内置工具/MCP 工具的共存与优先级
- 插件能否按群启用/分群配置（若 SDK 原生支持，配置形态可更简）
- Python httpx 与 `/mcp` 无状态模式的兼容（SSE 帧解析；实测服务端不校验会话，
  可不经 initialize 直接 tools/call，但建议仍先握手一次兜底兼容性）
- gateway 令牌明文存插件 config.toml 的口径确认（同 DD-claw 面板 LLM key 明文口径，预期无争议）

### 与 DD-claw 的契约

插件只依赖 gateway 角色的 6 个工具：`search_streamers` / `list_streamers` /
`list_categories` / `list_push_rules` / `add_group_push_rule` / `remove_group_push_rule`。
这些工具名、参数形状与服务端约束（渠道必须已启用群渠道、主播必须在监听名单、≤20 条、
createdBy='mcp' 隔离、限流）视为对插件的稳定契约；要改需同步改本文档。

## 不变量（任何接入途径不得破坏）

1. tools.ts 注册表是唯一能力信源；新能力先进注册表再接前端
2. 写路径全部过面板同款校验 + 热生效回调（listen/advanced/llm 的 onChanged）
3. 身份确权只发生在接入层；能力层只认 role，不认任何参数里的身份声明
4. gateway 约束（createdBy='mcp'、单渠道 ≤20 条、写限流、审计日志）对所有群入口一致生效，前端不重复实现
5. LLM 调用不进入轮询循环；agent loop 走 LlmRouter（熔断/降级语义与分类任务一致）
