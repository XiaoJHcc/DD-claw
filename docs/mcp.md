# MCP 接口（Agent 接入）

DD-claw 的 Agent 能力面：挂在控制面板同一个端口上的 `/mcp` 端点（Streamable HTTP transport，
`@modelcontextprotocol/sdk`），供 Claude Code 等 MCP Host 读写设置、查询数据库。

**MaiBot 不直连本端点**（2026-09-15 定案：其 MCP 连接进程级共享、无法按群隔离）——
群自助能力由 MaiBot 插件以 gateway 令牌调用本端点实现，见
[plan/agent-access.md](plan/agent-access.md) P2 详案。

定位：**工具的具体用法看工具自身的 description**（LLM 消费，随 tools/list 下发）；
本文档只覆盖运维面——令牌、角色、接入配置、安全边界。

## 快速开始

```bash
npm run mcp-token -- add claude admin                            # 生成 admin 令牌（token 只打印这一次）
npm run mcp-token -- add maibot-g123 gateway --channel 2         # 生成绑渠道的 gateway 令牌（一渠道一条）
npm run mcp-token -- list                                        # 列出令牌（只显示前 12 位 + 绑定的渠道）
npm run mcp-token -- remove <名字>                                # 吊销
```

令牌存 settings 表 `mcp_tokens`（库即信源，换机随 `dd-claw.db` 一起走）。
未配置任何令牌时 `/mcp` 回 503；Bearer 缺失/无效回 401。
gateway 令牌**必须绑渠道**（`--channel <push_channels.id>`）：渠道是 QQ 入口唯一可信的身份锚点，
未绑渠道时自助工具一律 403（见「gateway 写/读的服务端强制」）。

### Claude Code

```bash
claude mcp add --transport http dd-claw http://127.0.0.1:8787/mcp \
  --header "Authorization: Bearer ddc_..."
```

### 其他 MCP Host

任何支持 streamable_http 的 Host 均可接入：POST `http://127.0.0.1:8787/mcp`，
请求头带 `Authorization: Bearer <token>`。服务端是无状态模式（不校验会话），
握手后逐请求独立调用即可。

## 角色与权限

| | admin | gateway |
|---|---|---|
| 典型持有者 | 主人本机（Claude Code / 其他 Agent） | MaiBot 插件（群里所有人间接调用） |
| 只读查询 | ✔ 全部 | ✔ 全部 |
| 撤销本调用域的变更（`undo_last_change`） | ✔ 全局栈 | ✔ 本渠道栈（未绑渠道拒绝） |
| 设置/名单/规则/渠道/LLM 写 | ✔ | ✘（工具不存在） |
| 群推送规则自助 | ✘（用全量规则 CRUD；指定渠道走 `upsert_push_rule` 的 `channels`） | ✔（受限，只限令牌绑定的渠道，见下） |

**关键设计：权限差异体现在 tools/list——越权工具对 gateway 连接根本不存在
（调用得到 Tool not found），而不是注册后靠参数校验拒绝。**

### 为什么不信工具参数

下游 Host 的工具调用由 LLM 发起，参数是模型生成的——一句精心设计的 prompt injection
就能让模型在参数里谎称「这是主人私聊」「群号是 X」。因此服务端**只信任连接级 Bearer token**，
参数里任何身份声明都不作数：角色决定 tools/list，渠道由令牌绑定的 scope 提供
（`channelId` 这类身份字段连 schema 都不进）。按角色拆分 tools/list 正是这一原则的落地。

### gateway 写/读的服务端强制（不信任调用方声明）

**渠道 = 令牌绑定的调用域（scope），不是工具参数**（2026-09-22 落地，见
[plan/agent-access.md](plan/agent-access.md)「能力层调用域」方案 A）：`mcp_tokens` 条目带可选
`channelId`（`npm run mcp-token -- add <名字> gateway --channel <id>`，一渠道一条令牌），
服务端由令牌解析 `scope.channelId`。**工具参数里根本没有渠道字段**——LLM 在参数里塞 `channelId`
/ `groupId` 也会被 zod 校验剥离（未知键不进 handler），能力层只读 `ctx.scope.channelId`。
未绑渠道的 gateway 在读写自助工具上一律 **403**，绝不回落默认渠道，也绝不回落「全部」。
admin 令牌没有 scope：管理侧指定渠道一直走 `upsert_push_rule` 的 `channels` 参数（全量 CRUD，行为不变）。

| 工具 | 参数 | 服务端强制 |
|---|---|---|
| `add_group_push_rule` | `{ uid, categoryId?, messageTemplate?, name? }` | 渠道 = scope 绑定那条；必须是**已启用的 onebot 群/私聊**渠道（私聊一视同仁；toast/停用/已删拒）；主播已在监听名单；同主播同分类去重；单渠道自助规则 ≤ 20 条；规则打 `created_by='mcp'` |
| `remove_group_push_rule` | `{ id }` | 先校验**渠道归属**（本渠道不在该规则 `channels` 里 → 403）；语义是「让本渠道不再收到它」：自助规则整条删除，非 mcp 规则只做渠道级移出（不得整条删除/改内容）；返回 `{ ok, id, split, ruleRemoved }` |
| `list_group_channels` | `{}` | 只回**本渠道一条**（`{ id, name, targetType, groupId }`）；令牌绑的渠道不可自助时回空列表 |
| `list_push_rules`（shared） | `{}` | gateway 只回本渠道的规则（含与其他渠道共享的多渠道规则，那类带 `sharedWithOtherChannels: true`）；admin / 面板全量 |
| `list_channels`（shared） | `{}` | gateway 只回本渠道一条（别渠道的群号不进调用方上下文）；admin / 面板全量 |

**copy-on-write 拆分**（plan「多渠道规则」）：自助要动的规则推**多个渠道**时先拆——原规则保留其余
渠道、内容一行不动（`created_by` 原样），另建一条**只含本渠道**的规则（`created_by='mcp'`），
后续写只操作拆出来的这条；**拆分与后续写同一个事务**（不留半成品）。原规则本就只剩本渠道时就地操作。
`remove_group_push_rule` 因此有三种结果：

- 自助规则（`createdBy='mcp'`）**只推本渠道** → 整条删除（`split: false, ruleRemoved: true`）；
- 规则推**多个渠道**（自助的或 admin 建的）→ 拆分后只把本渠道移出，其余渠道与规则内容原样保留
  （`split: true, ruleRemoved: false`）；
- **非 mcp 规则且只推本渠道** → 也是渠道级移出：`channels` 置空、**行与内容全留**、`createdBy` 原样
  （`split: false, ruleRemoved: false`，没有「其余渠道」可保留故不拆新行）。「别推 XXX 了」对主人建的
  规则同样生效；规则变成「不推任何渠道」后仍在面板里可见可删，撤销即还原本渠道。

其余强制项：

- 单渠道自助规则 ≤ 20 条；写操作限流 20 次/10 分钟——**按渠道分桶**（同一渠道的多条令牌共桶，
  一个吵的群不拖累别的渠道；admin 侧回落按令牌名）
- 全部写操作落审计日志：`[mcp] MCP 写操作 [角色:令牌名 #ch<渠道>] 工具 参数`（llm key 打码）

`undo_last_change` 的撤销栈同样由**令牌 scope** 决定（admin = 全局栈，gateway = 绑定渠道栈），
未绑渠道的 gateway 一律 403——调用方声明不了自己的栈，也就撤不到别人的写；撤销自身不进变更记录。

> **2026-09-16 定方案、2026-09-22 落地**：渠道从 LLM 可见参数改为令牌绑定的 scope，四处服务端改动
> 全部完成——① `add_group_push_rule` 去掉 `channelId` 参数（admin 侧指定渠道走 `upsert_push_rule`）；
> ② `remove_group_push_rule` 补渠道归属校验 + 多渠道规则 copy-on-write 拆分（非 mcp 规则只允许渠道级操作）；
> ③ 读侧 `list_push_rules` / `list_channels` / `list_group_channels` 按 scope 在服务端裁剪；
> ④ 写限流从「每令牌」改为「每渠道」。渠道类型同时从「仅群」放开到「群 + 私聊」。
> 改造前那条「调用方理论上可给任意已启用群渠道加规则」的残留风险由此在**服务端**消除。

## 工具一览（细节以 tools/list 的 description 为准）

- **只读（两角色共享）**：`get_status` / `get_live_now` / `get_schedule` / `list_streamers` /
  `search_streamers` / `list_push_rules` / `list_categories` / `list_channels` / `search_posts` /
  `list_x_accounts` / `list_weibo_accounts` / `list_bili_accounts`
- **admin 只读审计**：`get_content_audit`——分类标准、模型尝试、规则命中与实际发送结果，见 [content-audit.md](content-audit.md)
- **两角色共享的写（唯一一个）**：`undo_last_change`——撤**本调用域**的栈顶（admin = 全局栈，
  gateway = 令牌绑定渠道的栈；未绑渠道直接拒绝，不回落），逐行比对后像与当前值，不一致则中止且一行不动；
  撤完触发热生效（等同面板上改回来）。它自身**不进变更记录**（撤销不该可再撤，见 `UndoStore`）。
- **admin 写**：`watch_streamer` / `unwatch_streamer` / `set_streamer` / `set_push_enabled` /
  `set_llm_enabled` / `set_listen` / `set_chat_mode` / `set_chat_provider` / `update_runtime_config` / `upsert_category` / `delete_category` /
  `upsert_push_rule` / `delete_push_rule` / `upsert_channel` / `delete_channel` /
  `list_llm_providers` / `upsert_llm_provider` / `delete_llm_provider` / `set_llm_key` /
  `get_x_config` / `update_x_config` / `upsert_x_account` / `delete_x_account` /
  `upsert_weibo_account` / `delete_weibo_account` / `upsert_bili_account` / `delete_bili_account`
- **gateway 自助**：`list_group_channels` / `add_group_push_rule` / `remove_group_push_rule`
  ——渠道来自令牌绑定的 scope（参数里没有渠道字段；admin 令牌看不到这三个工具）

图文来源的工具与面板同一条校验：post_rules 是**平台无关的通用规则**（只定义筛选+渠道+推送词），
账号经 `ruleIds` 选用规则（只校验规则存在，任意账号可选用任意规则）；quote 仅 X 帖可识别、
`llmTranslate` 运行时仅对 X 帖生效；X 配置含代理地址与实例（运维面），故 `get_x_config`
是 admin 专属，而三份账号名单是 shared。

写路径全部复用面板同款校验与热生效回调——经 MCP 改设置与在面板改完全等价
（监听开关热启停源、运行时参数热生效、LLM 名单/key 热重建 router）。

## 边界与 v2 预留

- **主人 QQ 私聊改设置**：v1 不做。私聊消息也走 MaiBot → 同样不可信；管理动作用 Claude Code 或面板
- **MaiBot 群自助接入**：详案在 [plan/agent-access.md](plan/agent-access.md) P2 节——插件在事件层取真实
  group_id（LLM 不可见该身份），按群选一条**渠道绑定**的 gateway 令牌调本端点；DD-claw 侧的四处
  服务端前提（渠道类型放开 / copy-on-write 拆分 / 删除归属校验 / 限流审计按渠道）已落地（见上）。
  HMAC 盖章留给「单入口跨权限域」（主人私聊提升 admin 权限）场景，届时才动 DD-claw 侧
- **面板 token 管理卡**：v1 只有 CLI；token 纯文本存库（同 LLM key 的本机明文口径）
- 只暴露 tools；MCP resources / prompts / SSE 服务端推送不实现

## 实现文件

| 文件 | 职责 |
|---|---|
| `src/mcp/auth.ts` | token 模型：`mcp_tokens` settings 读写（含 gateway 令牌的 `channelId` 绑定）、`mintToken`（`ddc_` + 24B base64url）、`resolveMcpAuth`（Bearer → {name, role, scope}；无配置 = 'unconfigured' 503，无效 = null 401；非法渠道绑定视为未绑定；sha256 后 timingSafeEqual 比较；token 不进日志） |
| `src/mcp/tools.ts` | 工具注册表（能力层）：shared 只读 + admin 写 + gateway 渠道自助；渠道只从 `ctx.scope.channelId` 读（身份字段不进 schema），读侧按 scope 服务端裁剪；`registerTools(server, deps, auth)` 按角色注册，写操作审计日志 |
| `src/mcp/run-tool.ts` | 能力层唯一执行入口：zod 再校验 + 审计 + 错误归一 + 写快照接线；`scopeChannelId` / `undoScopeOf` / `toolChangeMeta`（调用域 = 撤销栈与审计渠道） |
| `src/mcp/handler.ts` | `/mcp` 请求处理：Bearer 鉴权（→ 角色 + 调用域）→ 每请求新建 McpServer + StreamableHTTPServerTransport（`sessionIdGenerator: undefined` 无状态模式，无会话管理），GET/DELETE 由 SDK 回 405 |
| `src/mcp/rate-limit.ts` | gateway 写操作滑动窗口限流（内存，**每渠道** 20 次/10min；`writeLimitBucket` 分桶键=scope 渠道，无 scope 回落令牌名）；`resetMcpWriteLimiter` 供测试隔离 |
| `src/tools/mcp-token.ts` | `npm run mcp-token` CLI：list / add <名字> <admin\|gateway> [--channel <id>] / remove <名字>；token 只在 add 时打印一次 |
| `src/core/push.ts` | `splitPushRuleChannel`：copy-on-write 拆分原语（多渠道规则拆出只含某渠道的一条，显式设定两侧 createdBy，同一事务） |

## 故障排查

| 现象 | 原因 |
|---|---|
| 503「未配置访问令牌」 | 还没跑过 `mcp-token add`（注意令牌存在库里，换库/换机要重建） |
| 401 | Bearer 缺失或 token 打错；`mcp-token list` 核对前缀 |
| Host 里看不到某个工具 | 角色不对（gateway 本就没有 admin 工具），或 Host 侧保留名冲突 |
| gateway 调用被拒「本令牌未绑定渠道」 | 令牌没绑渠道（写与读侧自助工具都会 403，不回落）：用 `mcp-token add <名字> gateway --channel <id>` 重建一条绑渠道的令牌 |
| 连接失败 | DD-claw 面板没起来（panel.enabled）或端口写错 |
| 调用返回「错误：…」 | 业务校验拒绝，消息是中文的具体原因（同面板报错口径） |
