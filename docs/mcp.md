# MCP 接口（Agent 接入）

DD-claw 的 Agent 能力面：挂在控制面板同一个端口上的 `/mcp` 端点（Streamable HTTP transport，
`@modelcontextprotocol/sdk`），供 Claude Code 等 MCP Host 读写设置、查询数据库。

**MaiBot 不直连本端点**（其 MCP 连接进程级共享、无法按群隔离）——
群自助能力由 MaiBot 插件以 gateway 令牌调用本端点实现，见
[plan/agent-access.md](plan/agent-access.md) P2 详案。

定位：**工具的具体用法看工具自身的 description**（LLM 消费，随 tools/list 下发）；
本文档只覆盖运维面——令牌、角色、接入配置、安全边界。进程内的 WebUI Agent 与 NapCat 直连
共用同一份工具注册表但不经过本端点；它们的接入契约见 [plan/agent-access.md](plan/agent-access.md)。

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
| 只读查询 | ✔ 全部（含运维/审计只读） | ✔ 共享只读（admin 专属的运维配置与审计工具不存在） |
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

**渠道 = 令牌绑定的调用域（scope），不是工具参数**（方案见
[plan/agent-access.md](plan/agent-access.md)「能力层调用域」）：`mcp_tokens` 条目带可选
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
- 全部写操作落审计日志：`[mcp] MCP 写操作 [角色:令牌名 #ch<渠道>] 工具 参数`（模型 key 打码）

`undo_last_change` 的撤销栈同样由**令牌 scope** 决定（admin = 全局栈，gateway = 绑定渠道栈），
未绑渠道的 gateway 一律 403——调用方声明不了自己的栈，也就撤不到别人的写；撤销自身不进变更记录。

渠道身份（scope）由令牌绑定，四处强制都在服务端：① `add_group_push_rule` 没有 `channelId` 参数（admin 侧指定渠道走 `upsert_push_rule` 的 `channels`）；② `remove_group_push_rule` 先校验渠道归属，多渠道规则走 copy-on-write 拆分（非 mcp 规则只允许渠道级操作）；③ 读侧 `list_push_rules` / `list_channels` / `list_group_channels` 按 scope 裁剪后才离开能力层；④ 写限流与审计按渠道。渠道类型是群与私聊，两者一视同仁。

## 工具一览

**完整清单、参数与逐条用法以 `tools/list` 的 description 为准**（LLM 消费口径），本文只写可见性规则：
工具只按角色注册，越权工具对 gateway 连接根本不存在。按能力类别：

- **只读**：状态与实时在播、时间表、名单（主播与三份图文账号）、分类与规则、渠道、帖子检索——两角色共享。
  运维/审计类只读（分类与推送过程回看 `get_content_audit`、LLM provider 名单、X 连接配置）**只对 admin 注册**。
- **撤销**：`undo_last_change` 是两角色共享的唯一写工具——撤本调用域的栈顶，它自身不进变更记录。
- **配置写**：名单与开关、运行时参数、分类与规则、渠道、LLM provider 与 key、X 连接与三份图文账号——admin。
- **排序与测试**：`reorder_*` / `test_*` 同为 admin 写工具，进注册表是为了**统一校验与审计**，但**不进 agent 工具面**。
  两者的撤销面不同：排序是 DB 写、走快照可撤销；测试推送与连通性探测**有对外副作用但不是 DB 写**（差分恒空，
  不产生变更记录），**不可撤销**——它们是运维验证动作，不是配置变更。
- **QQ 自助**：渠道清单与群规则增删三个工具——gateway 专属，渠道来自令牌绑定的 scope（参数里没有渠道字段）。

分类与规则是两张统一表，两形态同表：分类用 `applies_to` 区分直播/图文，条件算子（关键词、分区、帖子类型、引用、带图）随类型可用；推送规则用 `subject_kind` 区分，`scope` 空 = 全部生效（live = 主播 uid，post = `twitter:账号` / `weibo:uid` / `bili:uid`）。旧 `uids` 字段与旧图文规则工具（`upsert_post_rule` 等）、账号工具的 `ruleIds` 入参均已退役——传 `uids` 会被明确拒绝而不是静默剥离。quote 仅 X 帖可识别、`llmTranslate` 运行时仅对 X 帖生效（门控在分析层，不在工具层）。

写路径全部复用面板同款校验与热生效回调——经 MCP 改设置与在面板改完全等价
（监听开关热启停源、运行时参数热生效、LLM 名单/key 热重建 router）。

## 边界与 v2 预留

- **主人 QQ 私聊改设置**：v1 不做。私聊消息也走 MaiBot → 同样不可信；管理动作用 Claude Code 或面板
- **MaiBot 群自助接入**：详案在 [plan/agent-access.md](plan/agent-access.md)「P2 详案」——Host 在工具回调里注入运行时
  group_id（**fill-only**，身份字段不进 LLM 参数），插件据此选一条**渠道绑定**的 gateway 令牌调本端点。
  DD-claw 侧的四处服务端前提（渠道类型放开 / copy-on-write 拆分 / 删除归属校验 / 限流审计按渠道）已落地（见上）。
  HMAC 盖章留给「单入口跨权限域」（主人私聊提升 admin 权限）场景，届时才动 DD-claw 侧
- **面板 token 管理卡**：v1 只有 CLI；token 纯文本存库（同模型 key 的本机明文口径）
- 只暴露 tools；MCP resources / prompts / SSE 服务端推送不实现

## 实现文件

逐文件职责见 [src/mcp/AGENTS.md](../src/mcp/AGENTS.md)（能力层代码地图与长期不变量）；本文不复制文件清单。
本文件与之的分工：**本文 = 运维面**（令牌、Host 接入、角色、安全边界、排障），**AGENTS = 代码面**。

与 MCP 相关但不在 `src/mcp/` 的两处：令牌 CLI 在 `src/tools/mcp-token.ts`（`npm run mcp-token`），
多渠道规则拆分原语在 `src/core/push.ts`——两者的职责同见各级 `AGENTS.md`。

## 故障排查

| 现象 | 原因 |
|---|---|
| 503「未配置访问令牌」 | 还没跑过 `mcp-token add`（注意令牌存在库里，换库/换机要重建） |
| 401 | Bearer 缺失或 token 打错；`mcp-token list` 核对前缀 |
| Host 里看不到某个工具 | 角色不对（gateway 本就没有 admin 工具），或 Host 侧保留名冲突 |
| gateway 调用被拒「本令牌未绑定渠道」 | 令牌没绑渠道（写与读侧自助工具都会 403，不回落）：用 `mcp-token add <名字> gateway --channel <id>` 重建一条绑渠道的令牌 |
| 连接失败 | DD-claw 面板没起来（panel.enabled）或端口写错 |
| 调用返回「错误：…」 | 业务校验拒绝，消息是中文的具体原因（同面板报错口径） |
