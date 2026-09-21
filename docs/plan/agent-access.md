# 多前端接入统一计划（Agent 能力面）

> 状态：统一计划（2026-09-15 定；经两轮对照代码的复核后，2026-09-17 按产品目标重构定稿）。
> 把「查看状态 / 修改数据」的所有接入途径归纳为一个架构：**一个能力面，N 种接线**。
> 已实现部分的运维文档见 [mcp.md](../mcp.md)。

## 产品目标

| # | 目标 | 含义 |
|---|---|---|
| G1 | **一个能力面，N 种接线** | 「查数据 / 改设置」的全部能力收敛到 `src/mcp/tools.ts` 注册表（唯一能力信源）；Web UI、/mcp、WebUI Agent、MaiBot 插件、NapCat 直连都只是接线方式，任何途径不得绕过注册表私接 Db |
| G2 | **QQ 渠道自助** | 群 / 私聊成员用自然语言管理**本渠道**的推送（加主播、删规则、查清单）；每个渠道只能看到并只能改自己，群与私聊一视同仁（身份 = 消息来源渠道，群号与个人 QQ 号无区别） |
| G3 | **主人全局管理** | 本机即主人：面板、Claude Code、WebUI Agent 都是 admin，可改全局；QQ 入口（含主人私聊）不设 admin。未来若加 QQ 侧 admin，按「与 WebUI Agent 面板 UX 对齐」处理 |
| G4 | **写操作彻底可撤销** | 每个单次变更（新增 / 删除 / 文字改动 / 开关 / 排序拖拽）可撤销，栈式逆序、历史全量保留——这是「写前确认不强制」的唯一兜底 |
| G5 | **聊天体验一致，权限按来源分层** | 凡是「聊天方式输入」（群聊 / 私聊 / Claude Code 任务 / WebUI 对话框）反馈体验一致，接入途径与 Agent Loop 归属是实现细节；权限不因入口统一：QQ = 来源渠道自助，本机 = admin |

配套产品边界（已定，不再翻案）：

- **写前确认不强制**：面板为可切换模式「写前询问 / 自动修改」；QQ 侧由 LLM 追问 + 口头确认，不另做关键词确认机制。安全模型重心在**可设置面的权限**（谁能改什么范围），不在单次修改的管控，撤销作兜底。
- **提示词注入**判定为理论攻击面、概率不大：最坏结果 = 本渠道成员给本渠道加/删规则——正是开放的能力本身；只要写可回退，风险即可控，不做结果隔离标记 / 写工具白名单等重防护。
- **交互入口**：面板新增**第四个视图**（agent 聊天面板）；会话持久保留到库、只做单会话，仅提供「重置上下文」；上下文变长不自动裁剪（面板由 UI 提示用量，QQ 侧政策见「渠道隔离」）。**撤销历史与入口放设置页底部**，不占视图。
- **触发纪律**：关键词 / 前缀硬触发（不接 LLM）与自然语言（LLM 语义触发）两条路完全共存、可同时启用，斜杠命令不是降级替代，与 MaiBot 的语义式触发也不冲突。

## 架构：能力层与接入层

```
                        ┌─ Web UI（panel REST，人点鼠标）        [已有]
                        ├─ MCP over HTTP（进程外 Host）          [已有 v1]
tools.ts 工具注册表 ────┼─ WebUI Agent（进程内 agent loop）      [待做 P1]
（唯一能力信源：         ├─ MaiBot 插件（HTTP 调 /mcp）           [待做 P2]
 zod schema + handler   └─ NapCat 直连（OneBot 事件 → 进程内）   [待做 P3]
 + role 标注）
```

- **能力层与传输层解耦**：`toolDefsForRole()` 是纯数据结构，任何前端直接消费，不经过 HTTP；`/mcp` 只是「进程外 Host」这一种接线的适配器。
- **角色在能力层标注，身份在接入层确权**：能力层只看 role + scope；「这个调用者是谁、该得什么角色」由各接入途径用自己的可信锚点判定。
- **新能力先进注册表，再接前端**。

### 接入途径

| 途径 | 状态 | 传输 | Agent Loop 归属 | 身份确权（可信锚点） | 角色 |
|---|---|---|---|---|---|
| Web UI（REST） | 已有 | HTTP /api/* | 无（表单直调） | localhost 绑定 = 主人（免 token） | admin |
| MCP | v1 已有 | streamable HTTP /mcp | 入口自带（Claude Code 等 Host） | Bearer token（**`/mcp` 永远要令牌**） | admin / gateway |
| WebUI Agent | 待做 P1 | 进程内 agent loop + POST /api/chat | **DD-claw 提供** | localhost 绑定 = 主人 | admin |
| MaiBot 插件 | 待做 P2 | 插件 HTTP 调 /mcp | 入口自带（MaiBot） | Host 注入工具回调的 group_id（fill-only，不声明为 LLM 参数）+ 渠道绑定令牌 | gateway + 群→channel 映射 |
| NapCat 直连 | 待做 P3 | OneBot 上报 → 进程内 agent loop（或斜杠命令） | **DD-claw 提供**（斜杠命令则无 loop） | OneBot 事件 user_id/group_id（天然可信，不经 LLM） | gateway（仅来源渠道范围） |

关键区分：

- **MaiBot 插件 vs NapCat 直连**解决同一个问题（QQ 群/私聊对话入口），互斥择优——MaiBot 持续用 LLM 监听群聊时走插件（DD-claw 零新组件）；想绕过 MaiBot 自己的对话行为（不借它的 loop / 触发词，收发完全由 DD-claw 掌控）时才走直连。确定性斜杠命令两边都能做（插件侧 `@Command`、直连侧自解析），**不构成选择理由**。
- **NapCat 直连的信任链最短**：事件 user_id/group_id 是 NapCat 直接给的，群/私聊隔离天然成立，v2 的 HMAC 盖章不需要（QQ 入口本就不设 admin）。代价是 DD-claw 自己收消息（事件接收 + 触发纪律 + 对话限流）。P2 插件侧同样有可信 group_id——两条路的差别不在身份可信度，而在「要不要经过 MaiBot 这个常驻 LLM 监听方」。

## 信任模型

| 锚点 | 可信性 | 用于 |
|---|---|---|
| localhost 绑定 | 可信（本机即主人） | Web UI / WebUI Agent → admin。**只对 `/api/*` 成立**，`/mcp` 不适用 |
| Bearer token（连接级） | 可信（settings `mcp_tokens` 唯一信源） | MCP / MaiBot 插件 → 角色 |
| **令牌携带的渠道绑定**（`mcp_tokens` 条目增 `channelId`） | 可信（**服务端校验**，不依赖调用方声明） | QQ 入口 → 本渠道 scope（读/写/撤销/审计/限流共用） |
| OneBot 事件 user_id/group_id；MaiBot Host 注入工具回调的 group_id/stream_id | 可信（不经 LLM。Host 注入是 **fill-only**，前提是不把身份字段声明成工具参数） | NapCat 直连 → 仅来源渠道范围 + 会话映射；MaiBot 插件 → 会话映射 |
| LLM 生成的一切参数 | **永不可信** | 只允许表达业务内容（主播是谁、加还是删），永不含身份/渠道声明 |

**鉴权口径**：**`/mcp` 永远要令牌**——零令牌 503、缺失/无效 Bearer 401，**不设回环免 token**（同机插件漏配/配错令牌会静默拿到全局 admin 的 fail-open 方案已否决）；**免 token 仅限 `/api/*`**（面板与进程内 WebUI Agent loop，绑 127.0.0.1 即主人）。现码（`src/mcp/auth.ts`、`src/mcp/handler.ts`）已符合本口径，P0 只补启动日志与文档对齐。

### 能力层调用域（scope）

能力层现在只拿到 `ctx = {name, role}`（`McpAuth`），而渠道是 QQ 入口唯一可信的锚点——`add_group_push_rule` 今天的 `channelId` 还是 LLM 可见的 schema 参数，必须改掉。统一形状：能力层执行入口收一个**调用域**，而不是从参数里读身份：

```
runTool(deps, def, args, ctx)     // ctx = { role, name, scope: { channelId?: number } }
  → zod 校验 args →（写操作）快照 + 审计 → def.handler(deps, args, ctx) → 错误归一为中文文案
```

- `scope.channelId` **永不出现在工具 schema 里**（进去就等于交给 LLM）；读 / 写 / 撤销 / 审计 / 限流全部只读这一个字段。
- 读侧裁剪在**服务端**做（`list_push_rules` 按 scope 过滤后才离开能力层），不靠前端/插件过滤。
- 进程内入口（WebUI Agent / NapCat 直连）由接入层直接构造 ctx；`/mcp` 入口由**令牌绑定**解析 ctx。

**方案 A：令牌绑定渠道**（已定）。`mcp_tokens` 条目增可选 `channelId`（settings JSON，仍由 `npm run mcp-token` 管理，CLI 增渠道参数）：

```
mcp_tokens = [{ name: "maibot-group-123", role: "gateway", token: "ddc_…", channelId: 2 }]
npm run mcp-token add <名字> gateway --channel <id>
```

- 服务端由 token 解析 `scope.channelId`；**调用方声明什么渠道都无效**（参数里根本没有该字段）。
- QQ 入口：每个来源渠道一条 gateway 令牌（一个群一条），插件按 `group_id` 选令牌；一令牌只绑一渠道，同渠道多令牌允许（改名轮换用）；admin 令牌不带 `channelId`（全量，无 scope）。
- 顺带同源解决四件事：按渠道限流分桶、审计带渠道、读侧服务端裁剪、写范围校验——不再各写一遍。
- **方案 B 已否决，别再翻案**：`channelId` 留在 arguments、由插件在 `tools/call` 前强制覆盖——能力层就是在信任「参数里的身份声明」，隔离退化为「插件不做错就没事」。方案 A 的代价：`channelId` 从 `add_group_push_rule` 的 schema 里**移除**（参数形状的破坏性改动），gateway 契约表述为「工具名与业务参数不变，身份参数改为 scope 注入」。

## 核心机制

### 写操作快照与撤销（G4 的落地）

三个硬要求：① 覆盖**所有配置写路径**——含面板表单写，所以「面板 REST 收敛到注册表」是回滚的前置条件（非 DB 写面见下文遗漏面）；② 快照粒度必须是**受影响行的前像**（含级联影响），且与写入同事务；③ 唯一例外 LLM key（隐私：快照不落明文，撤销 = 清空并要求重填）。

可行性（已对代码核实）：写都是 SQLite 行操作、事务能力在库层具备（better-sqlite3；`Db` 需先补一个公开 transaction 包装），逆操作可确定（插入→按 id 删；删除→按原 id 重插并还原 sort/时间戳；改字段/开关→恢复前像）。必须按「受影响行集合」而非单行来记的形状有五种：

1. **删分类级联停用引用它的规则**（`disablePushRulesByCategory`，N 行 `enabled` 变化 + 1 行删除；现状级联停用与删除是两条独立语句、**非原子**，REST 收敛时须顺手事务化——这是「快照与写入同事务」的前提）；
2. **排序拖拽整表重写 `sort`**（`reorderPushRules` / `reorderPushChannels` / `reorderCategories`）；
3. **新建 `sort = MAX+1`**（push_rules / categories / push_channels **三表同形**，撤销后重插需还原该值）；
4. **settings 的删除式写**（`set_listen` 回 auto 是 `db.deleteSetting` 删 key 而非写值：前像须区分「key 不存在」与「值=X」，撤销相应是删 key 或重插）；
5. **复合写**（provider 表单一次写两行 settings：`llm_providers` JSON + `llm_key:<name>`，后者属隐私例外不落明文——受影响行集合要跨「可快照行 + 例外行」）。

删渠道是裸 `DELETE`（`deletePushChannel`），规则里的渠道引用靠同 id 重插自动恢复。

撤销语义：

- **栈式逆序**：只撤最近一次、可连续撤销、不做跳序；**每来源渠道一条独立栈**（面板 admin 另有全局栈）——单全局栈下「渠道只能撤自己的」会把栈顶让给别人，跨渠道/跨入口交叠会静默覆盖别人的写。
- **冲突处理**：每次撤销逐行比对「前像 == 当前值」，不等则**中止并提示「该设置已被其他入口修改，无法撤销本次」**，不做强制覆盖——宁中止不丢写。
- **比对中止是预期内 UX，不是异常**：settings 复合 JSON 是整行覆写、`reorder_*` 的 `updated_at` 随行变化，排序/名单类撤销极易因后续任意编辑比对失败而中止；变更历史 UI 应对中止项标注「已被后续变更覆盖」，避免用户误读为系统故障。
- **撤销本身也是写路径**：撤 runtime config 要 `reconcileRuntime`、撤 listen 要 `reconcileListen`、撤 provider 要重建 router——热生效回调不在 Db 层（挂在 PanelDeps 闭包），撤销执行器需带「表/工具 → 回调」映射，撤销后与面板手写等价。
- **归档表不参与撤销**：room_states / posts / verdicts / live_segments 等后台源自动写的表不进变更记录，避免把轮询数据回滚。
- **撤销的用户面**：撤销是**内部工具**（注册表能力，由 agent loop 调用；QQ 侧自然语言说「撤销刚才那个」即可，不设专门命令）；面板入口是设置页底部的变更历史。历史全量保留（供查看 / 审计，不自动清）。

#### 变更记录遗漏面（本期不入撤销）

「所有写路径都可撤销」目前只覆盖 **settings / 配置表类**的写。以下写面**明知而未纳入**，避免以后误以为全都可撤：

| 写面 | 位置 | 兜底方式 |
|---|---|---|
| B站 / 微博凭据落盘 | `cookies.json` / `weibo-cookies.json`（扫码成功后 merge 写入，`src/sources/*/auth.ts`） | 按 LLM key 同口径视为隐私例外；要「撤销」就重新扫码或清空该文件 |
| NapCat 托管配置写盘 | `onebot11_<uin>.json` 里 dd-claw 条目的自建/换端口（`ensureNapcatEntry`）、Windows 计划任务创建（`napcat-setup`）与启停 | 面板 NapCat 卡片 + 看门狗自愈；改错可重配或手工恢复文件 |
| 媒体与通知缓存 | 关键帧文件（`sources/media/keyframe`）、toast 图片本地化（`notify/image-cache`）、mac-notifier helper 落盘 | 纯缓存，删掉即重建，不算配置变更 |
| 一次写库脚本 | `migrate-snapshots-path` 等 | 幂等，不属于面板 / 对话变更 |
| 对外副作用 | `--test-notify` 与面板测试推送（真发一条消息） | 不可撤回，仅测试动作 |

若将来要求这些也可撤销，凭据与 NapCat 配置需要额外的**文件前像**快照，成本另估。

### 渠道隔离（G2 的落地）

隔离不是某一层加过滤就够，以下每一处都必须用**同一个「来源渠道」锚点**（渠道 = 群号或个人 QQ 号映射出的 DD-claw channelId），在服务端单点强制，不靠前端/插件过滤：

| # | 落实点 | 要求 |
|---|---|---|
| 1 | 会话解析 | 来源会话 → channelId 的映射查不到就**拒绝服务**，不回落默认渠道 |
| 2 | 读 | **服务端**按 scope 裁剪工具结果（如 `list_push_rules` 只回本渠道规则）；不把其他渠道号/规则喂进上下文 |
| 3 | 写 | channelId 经**调用域**注入（接入层解析 → `runTool` → handler），**永不作为 LLM 参数**；写范围限本渠道（多渠道规则走 copy-on-write 拆分）。删除也必须校验目标规则的渠道归属 |
| 4 | 上下文 | 会话键 = 来源渠道；不同群/不同私聊/面板之间上下文完全独立 |
| 5 | 撤销 | 渠道只能看到并撤销**本渠道自身**产生的变更；面板 admin 可看全部（跨渠道交叠处理见「撤销」机制） |
| 6 | 审计与限流 | 审计按渠道可检索；写限流**按渠道**分桶（否则一个吵的群会拖累其他渠道）。两者都需要 scope 在服务端可见 |
| 7 | 系统提示 | agent 提示词明确「只处理本渠道」，不主动查询其他渠道信息 |

QQ 侧配套政策：

- **上下文**：面板「不自动裁剪、由 UI 提示用量」对 QQ 不适用（QQ 没有 UI 可看用量）。QQ 每个来源渠道的会话达到阈值（40 条消息 / 8k 字符）时，由回复末尾附一句「本群对话上下文已较长，发送 `/reset` 可清空」，**仍不自动裁剪**，但由系统主动提示。落地位置 = 会话存储 + 回执渲染，P2/P3 共用。
- **回执裁剪**：单条回执按 QQ 限制截断（正文优先、工具细节折叠成一行摘要），超长结果改「已写入，详情请在面板查看」。具体长度阈值待 P2/P3 动手时按 QQ 实际限制微调（见「待定项」）。

### 多渠道规则：copy-on-write 拆分

`push_rules.channels` 是**数组**：一条规则可同时推多个渠道。自助要改本渠道时**先拆**——原规则保留其余渠道、另建一条只含本渠道的规则（`createdBy='mcp'`），自助后续只操作这条；原规则本就只剩本渠道时就地改，不拆。

落地要点：① 拆分与后续写入同一事务；② 拆出的原规则若渠道被清空，说明本渠道是唯一渠道 → 不拆；③ `upsertPushRule` 不传 `createdBy` 时保留原值（`src/core/db.ts`），拆分必须显式设定两侧的 `createdBy`，别沿用 admin 规则的值；④ **非 mcp 规则也只允许「移出本渠道」这种渠道级操作，不得整条删除**——否则自助会误伤 admin 配置的其它渠道。

### 统一会话与 UX 一致性（G5 的落地）

实质差异只有两处，都不该让用户看到两套行为：**Agent Loop 归谁**（Claude Code / MaiBot 自带 loop，DD-claw 只提供能力面；斜杠指令不需要 loop；WebUI Agent、NapCat 直连由 DD-claw 提供**同一个** loop）与**权限层级**（QQ = 来源渠道自助；Claude Code / WebUI Agent = 管理员级别）。

一致性要素（各入口同源，不得各自实现）：

| 要素 | 要求 |
|---|---|
| 结果与错误文案 | 同一条工具调用在任何入口拿到同一句中文结果 / 错误（都过 `runTool()`） |
| 撤销 | 任何入口产生的写操作都能撤销：撤销是内部工具（QQ 侧自然语言即可触发）+ 面板设置页底部的变更历史 |
| 写前询问 / 自动修改 | 面板可切换模式；QQ 侧由 LLM 追问 + 口头确认；安全靠权限面 + 撤销兜底 |
| 身份与范围 | 身份 = 消息来源渠道；范围 = 该渠道自身 |
| 权限 | **按来源分层，不因入口统一**：QQ 消息（群/私聊）只能改本渠道相关的部分；Claude Code / WebUI Agent 可改全局 |
| 会话上下文 | **与权限同源、严格隔离**：面板单会话 + 重置；QQ 侧每个来源渠道各一份上下文，互不可见 |

## 执行方案（分期）

**依赖关系**：`runTool` + 写快照/撤销 + REST 收敛是 **P1/P2/P3 全部复用**的底座（撤销又是 QQ 侧「确认不强制」的唯一兜底），与聊天 UI 无关；调用域（scope）的 ctx 形状与 `mcp_tokens.channelId` 解析同属地基，QQ 入口在 P2/P3 直接消费。因此地基整体抽成 **P0**，P1 缩回「loop + 聊天视图」——P2 的正确性不该绑在 P1 的 UI 进度上。

P2 与 P3 顺序可互换、也可只做其一——取决于「MaiBot 是否继续作为群聊对话方」（见「待定项」）。若最终只做 P2：P1 的 agent loop 不被复用（MaiBot 自带 loop），但 P0 地基与 `completeChat`、会话存储、scope 解析仍被复用——这也是把 P0 单独拆出的理由之一。

### P0：地基（不依赖任何新前端）

内容：`runTool` 共享执行器（含 `ctx.scope` 形状）+ 写操作快照/撤销（含冲突比对与回调映射）+ 调用域解析（`mcp_tokens.channelId` 与 `mcp-token --channel`）+ 配置写路径的 REST 收敛与缺失工具（见缺口清单）+ 鉴权口径落地（补启动日志与文档对齐）。

交付判据：

1. 面板侧任一次配置写（含排序、级联停用）都能在设置页底部看到并撤销；
2. 撤销前后像 ≠ 当前值时中止并提示；
3. 面板 REST 不再有绕过注册表的直接 Db 写；
4. 启动日志明确「`/api/*` 回环免 token = admin；`/mcp` 必须带 Bearer」；
5. **`/api/*` 响应形状与状态码不变**（201 vs 200、`{id}` vs `{ok:true,id}` 等前端契约保持，webui 无回归；`webui/demo/mock-api.js` 同步，AGENTS.md 强制）；
6. **撤销路径触发热生效回调**（撤 runtime config → `reconcileRuntime`、撤 listen → `reconcileListen`、撤 provider → 重建 router，与面板手写等价）。

#### 已落地（2026-09-17，`mcp-interface` 分支；均为新文件或安全集文件）

| 项 | 落点 | 说明 |
|---|---|---|
| ✅ `runTool()` 共享执行器 | 新 `src/mcp/run-tool.ts` + 测试 | zod 再校验（第二个适配器绕不过）/ 审计（带角色与渠道、llm key 打码）/ 中文错误归一（`text` 与改造前 `/mcp` 逐字一致，`status` 供 REST 映射）/ `beforeWrite` 快照钩子（抛错即不写库）/ `scopeChannelId()` |
| ✅ 调用域解析 | `src/mcp/auth.ts` | `mcp_tokens` 条目支持可选 `channelId`；`McpAuth` 增 `scope: { channelId? }`；`resolveMcpAuth` 由令牌解析（非法值 = 未绑定）；`readChannelId` 正整数校验 |
| ✅ 令牌 CLI 渠道参数 | `src/tools/mcp-token.ts` | `add <名字> <admin\|gateway> [--channel <id>]`；`list` 增渠道列；admin + `--channel` 拒绝；gateway 未绑渠道给提示 |
| ✅ 缺口清单机械化 | 新 `src/panel/write-path-inventory.test.ts` | 从 `server.ts` 提取写路由 × `tools.ts` 工具名，**新增未分类的写路由即测试失败**；「缺口清单」的单一信源由本表移到该测试（本文件的手抄表格会过期） |
| ✅ 快照 + 撤销引擎 | 新 `src/core/undo.ts` + 测试（19 例） | `capture(meta, write)` 把「读前像 → 写 → 读后像 → 落记录」包进**同一事务**；差分出受影响行；`undo(scope)` 逐行比对后像==当前值否则**中止且一行不动**；栈式逆序、每渠道一栈；历史全量保留（只标记 undone）；LLM key 不落明文（撤销=清空+refill 提示） |
| ✅ 会话存储 | 新 `src/core/chat-store.ts` + 测试（8 例） | `chat_sessions` / `chat_messages` 两张表；会话键 = 来源渠道（与撤销栈同一套 scope 字符串），不同群/私聊/面板**完全隔离**；**不自动裁剪**，`usage()` 给用量与 `needsResetHint`（40 条 / 8k 字符）；`reset()` 只清消息、保留会话行 |
| ✅ `completeChat`（双协议 tools） | `src/analysis/providers.ts`（**纯新增**，既有 `complete`/`completeJson` 行为不变，旧测试 20 例全绿）+ 测试（12 例） | chat/completions 走 `tools` + `tool_calls` 回填；responses 走顶层 `{type:'function',name,parameters}` + `function_call` / `function_call_output`(`call_id`)；熔断/路由与 `completeJson` 同源；端点不支持原生 tools（HTTP 4xx 且报文点名 tool/function）→ **就地 JSON 模拟降级且不记熔断**；模拟产出的 arguments 与原生一样只做透传，**必须过 `runTool` 校验**（已用测试钉住） |
| ✅ 工具面转换 + 暴露策略 | 新 `src/agent/tool-schema.ts` + 测试（6 例） | `z.toJSONSchema()` 转 function 参数（剥 `$schema`）；**暴露策略是生产侧常量** `AGENT_EXCLUDED_TOOLS`（排序类 + `test_*` 副作用类），与清单测试互补校验——「哪些进 agent 工具面」只有一处信源 |

**`completeChat` 的 `responses` 分支尚未真机验证**：形状按上面写的实现并有离线测试钉住，但「真实端点是否逐字如此」（尤其 `function_call_output` + `call_id` 往返、`instructions` 与 `tools` 能否共存）只有接上真端点才能确认。第一次接真端点时先跑一次单轮工具往返再放量。

**快照实现取向（对「写操作快照与撤销」一节的落实方式，2026-09-17）**：采用**表级前像快照 + 差分**，而不是让每条写路径自己声明「影响了哪些行」。理由是计划里点名的五种形状（级联停用 N 条 / 排序整表重写 / 新建 `sort=MAX+1` / settings 删除式写 / provider 复合写两行）在差分下**自动收敛为同一种记录**，且顺带拿到后像——撤销插入/删除才做得出来；代价是每次配置写整表 SELECT 一遍，但这只发生在配置写路径（面板点一下 / 一次 MCP 调用），配置表几十到几百行，绝不进轮询循环。两个附带决定：① `streamers` 是否纳入快照表——**2026-09-21 最终纳入 + 按列过滤**（原裁决定为「暂不纳入」，理由见下条修订）；② 除 LLM key 外**不做其它隐私例外**，即 `mcp_tokens` 的值会被快照（同库已有明文，未新增暴露面，且换来「撤销令牌轮换」能还原旧令牌）；若要求同口径打码，改一行 `redact` 判定即可。

**快照接线落地（切片 B，2026-09-21）**：记录点 = `UndoStore.track()`（异步段版 capture）：进 handler 前取前像，`runTool` 成功后同步做「后像 → 差分 → 落记录」，所有写调用经内部队列串行化防差分窗口交错。两个已知取舍（详见 `undo.ts` track() 注释）：① 前像读取不在事务里（事务不能跨 await），残留窗口 = 写已提交而记录 INSERT 失败（磁盘级故障），此时错误抛给调用方；② 不走 track 的写（轮询源回写 `x_accounts` 的游标/头像列）可能落进差分窗口被捎带——x_accounts 与 streamers 同为「配置+归档混合表」，后果是撤销比对更易中止（宁中止不丢写）。**② 已由切片 C 的按列过滤解除**（`DEFAULT_IGNORE_COLUMNS`：混合表的轮询列不参与差分/比对/还原，见下「切片 C 落地」）。**切片 B 当时** `streamers` 尚未进快照表：`watch_streamer` / `set_streamer` / `unwatch_streamer` 照常过 runTool + 审计，但差分恒空、不落变更记录——**该口径已作废**（2026-09-21 按列过滤后一并纳入，见下「切片 C 落地」末两行）。

**接线进展**：
- **切片 A（2026-09-17 后）**：`registerTools` 已改走 `runTool`（MCP 侧 content 文本逐字不变，run-tool 契约测试钉住）；
  鉴权口径启动日志已加（`index.ts`，判据 4）；`Db` 已暴露原始句柄（`Db.raw` 只读 getter），
  `UndoStore` / `ChatStore` 已在装配根实例化并建表、挂进 `PanelDeps`；
  缺口清单的 8 条 planned 工具（5 个 `reorder_*` + `test_push` / `test_llm_provider` / `test_x_connection`）已补进注册表
  （admin、write、agent 工具面继续排除），逻辑与对应 REST 路由同口径。
- **切片 B（REST 收敛 + 快照接线）**：清单里 `coverage: 'registry'` 的全部写路由已改经 `runToolTracked`
  （`runTool` + UndoStore.track）调注册表 handler，面板里的重复校验分支已删（判据 3 达成；判据 5 由
  server.test.ts 零改动通过背书）；快照记录点 = `UndoStore.track()`（方案与取舍见下「快照实现取向」）；
  删分类级联停用已事务化（`Db.transaction` 包装已补）；两处裁决落地见缺口清单末行；
  REST 收敛需要的工具语义对齐（additive/趋严，MCP 契约不破坏）：`set_streamer` 补 analyze/notify、
  `upsert_llm_provider` 补 keyEnvs、`upsert_x_account` 新建并入 verify（not-found 拒 / link 照收 /
  ok 种昵称，响应增 `verify` 键）、`upsert_post_rule` 的 filters 改 strictObject。
- **P0b 变更历史 UI 已落地（2026-09-21，与切片 C 并行）**：设置页底部通宽卡（`webui/js/undo.js`，进设置视图拉取，
  栈式语义 = 只有最新未撤销条带「撤销」按钮；409 中止标「已被后续变更覆盖」、按钮保留）；`/api/undo*` 两条路由的
  mock 已同步进 `webui/demo/mock-api.js`（`?demo=1` 可完整演示成功路径与空栈态，409 分支留代码路径不演示）。
  `completeChat` 与 `agentToolSpecs` 目前**没有任何调用方**（agent loop 尚未写），对现有链路零行为变化。

**切片 C 落地（2026-09-21，后端收尾）**：

| 项 | 落点 | 说明 |
|---|---|---|
| ✅ 撤销执行器 | `src/core/undo.ts`（`undo` 回 `tables` / `settingKeys` / `tool`）+ `src/mcp/run-tool.ts`（`undoScopeOf`）+ `src/index.ts`（`undoLast`） | `PanelDeps.undoLast(scope?)`：撤栈顶 + 触发热生效（判据 6）。**回调闭包只在装配根**，能力层拿到的是纯分类结果 `undoEffects()` |
| ✅ 「表 / 键 → 回调」映射 | `undo.ts` 的 `undoEffects()`（纯函数，不认识 Db 也不持回调） | `settings` 运行参数键 → `reconcileRuntime`；`listen_*` → `reconcileListen`；`llm_providers` / `llm_key:*` → 重建 router（撤 key = 清空 + refill）；`push_channels` / `napcat_*` → `rebuildNotifiers`；三张图文账号名单 → `reconcileListen`（源名单同一启停入口）；`push_enabled` / 规则 / 分类无回调（逐条读表） |
| ✅ REST 端点 | `src/panel/server.ts` | `GET /api/undo/history` → `{changes:[{id,tool,entry,actor,scope,at(秒),undone,tables,rows}]}`（新→旧）；`POST /api/undo`（忽略 body）→ 200 `{ok,change:{id,tool}}` / 空栈 404 / 比对中止 409。**唯一不经注册表的写路由**，直接调 `deps.undoLast` |
| ✅ 撤销内部工具 | `src/mcp/tools.ts` `undo_last_change`（shared = 两角色可见） | admin → 全局栈；gateway → 令牌绑定渠道栈，**未绑渠道拒绝不回落**；默认暴露给 agent（不进 `AGENT_EXCLUDED_TOOLS`）；`track: false` ——撤销自身不入栈 |
| ✅ `POST /api/undo` 的清单分类 | `write-path-inventory.test.ts` 新增第三种 `coverage: 'executor'` | 机器校验：该路由对应的工具必须 `exists` + `write` + `track === false`（与「撤销不入栈」互锁），暴露策略仍与 `AGENT_EXCLUDED_TOOLS` 对齐 |
| ✅ `x_accounts` 混合表裁决（切片 B 遗留） | `undo.ts` `DEFAULT_IGNORE_COLUMNS` | 三张图文账号名单的轮询列（游标 / `last_ok_at` / `avatar` / `silent_next` / 平台昵称 `nickname` / `uname` / `updated_at`）不参与差分、比对与还原：轮询写不再被捎带，游标前进不再让撤销中止，撤销也不回滚轮询数据 |
| ✅ `streamers` 混合表裁决（原「整表不纳入」作废，2026-09-21） | `undo.ts` `DEFAULT_CONFIG_TABLES` + `DEFAULT_IGNORE_COLUMNS.streamers` | 触发原因 = P1 真机冒烟：agent 用 `set_streamer` 改别名后**撤不掉**（差分恒空 → 不落记录）。逐列核对写者后确认轮询列与配置列可分——忽略 `uname`（`LiveStatusSource` 的回填；平台事实，输入面不收）、`face`（同一条回填 + `FollowsSource` 头像回填）、`room_id`（同一条回填，匿名可得通道）、`updated_at`（每次 `upsertStreamer` 都重写）；配置列 `watch` / `alias` / `analyze` / `notify` / `weibo_nick` / `weibo_uid` / `profile_note` 全部参与差分与还原（`source` / `created_at` 只在建行时定，照常参与）。两种撤销形状都已覆盖：不在名单 → 插行（撤销 = 整行删除）；已在名单（下过监听）→ `upsertStreamer` 的 ON CONFLICT 更新同一行（撤销 = 按列还原，轮询列保留） |
| ✅ `streamers` 撤销的热生效口径 | `undo.ts` `undoEffects` | **不给 `listen`**：监听名单（含 `watch` 开关）由 live-status / 动态源每轮直读 `listWatchedUids()`，撤一次别名或 watch 下一轮即生效，不需要重启任何源（与三张图文账号名单不同——那两个源在构造时快照名单，故要 `reconcileListen`） |

**快照与写入的同事务**：better-sqlite3 事务不能跨 await，故 `runTool` 内不做完整 capture；
切片 B 的实际记录点与取舍见上「快照实现取向」的落地补充。

**顺带修正的过期内容**（动手前先按最新代码复核）：

- 缺口清单「29 处写分支」在 `main` 上已是 **38 处**（新增 `/api/x`、`/api/x/test`、`/api/x/accounts`、`/api/post-rules`、`/api/post-rules/order` 等）；微博来源落地后还会再涨——这正是把清单改成测试的原因。
- P1 的「面板新增第四个视图」与 `main` 现状冲突（已是 时间表 / 主播列表 / 设置 / 图文 四个视图）。
- **P0 宜拆两段**：P0a = 后端地基（`runTool` + 撤销 + scope + REST 收敛，与面板布局正交，因为 `/api/*` 形状由判据 5 冻结）；P0b = 设置页底部变更历史 UI + `webui/demo/mock-api.js` 同步（等面板改版定稿再做，否则与「移动老功能位置」互相踩）。

估算：**~800–1000 行（含测试与表）**，跨 3–4 天；含 `Db` 公开 transaction 包装与删分类级联事务化；REST 收敛按缺口清单逐条推进，非一次性大重构。

#### 配置写路径缺口清单（REST 收敛的真实范围）

注册表当前**缺**这些写路径的工具（`src/panel/server.ts` 29 处 POST/PUT/DELETE 写分支 vs `src/mcp/tools.ts` 现有工具；另有 2 个**带写副作用的 GET**——扫码 poll，见登录流行）。缺的不是「搬代码」，而是先决定**哪些能力该存在、哪些该让 LLM 看见**：

| REST 写路径 | 注册表现状 | 处置 |
|---|---|---|
| `PUT /api/rules/order`、`/api/channels/order`、`/api/categories/order`、`/api/llm/providers/order` | **无工具** | 增 `reorder_*`（admin）→ 纳入回滚覆盖；是否暴露给 agent 单独决定 |
| `POST /api/push/test` | 无工具 | 增 `test_push`（admin）；有对外副作用、不可撤销（已在遗漏面）→ **不暴露给 agent** |
| `POST /api/llm/providers/:name/test` | 无工具 | 网络探测 + 失败计熔断，非 DB 写 → 与 `test_push` 同类「①成立②暂关」，**不暴露给 agent** |
| `PUT /api/napcat`、`POST /api/napcat/launch` | 无工具 | 文件/进程写面（已在遗漏面）→ v1 **仅面板**，不进 agent 工具面 |
| `POST /api/auth/{bili,weibo}/qrcode` 等登录流 | 无工具 | 人机交互（扫码），不进工具面、不进回滚覆盖（凭据落盘已在遗漏面）；配套 `GET …/qrcode/poll` 是**带写副作用的 GET**（confirmed 时落盘 cookies + 热重启源），同属本排除范围 |
| `PUT /api/advanced`、`/api/listen/*`、`/api/llm/*`、`PUT /api/push/enabled`（`set_push_enabled`）、分类 / 规则 / 渠道 / 名单 CRUD | 已有对应工具 | ~~面板改为经 `runTool` 调注册表 handler，删掉面板里的重复校验分支~~ **切片 B 已落地**。两处分歧的裁决（2026-09-21 拍板）：① provider 重名——**REST 保持「重名 400」，工具保持按名 upsert**，REST 路由在调 runTool 前做重名预检（PUT 同理做 404 存在性预检），两边契约都不变；② `set_streamer` 的 `resolveWeiboNick`——收敛后 REST 走 runTool，server.ts 那份已删，唯一实现在工具 handler |

**两个概念必须分开**：① **回滚覆盖**——配置写路径全部过注册表，才有「撤销彻底可信」；② **工具暴露**——哪些进 `toolDefsForRole()`、LLM 才看得见。①决定②的实现位置，但不等于②全开放；排序 / 测试推送 / NapCat 正属于「①成立而②暂关」的那类。

### P1：agent loop + WebUI Agent

内容：`completeChat`（双协议 tools 透传）+ loop + 会话持久 + 第四个视图。

估算：**loop/LLM 侧 ~350 行含测试（1–2 天）；webui 侧 ~300–600 行**（第四个视图 + 写模式开关 + 设置页底部变更历史 + `webui/demo/mock-api.js` 同步，AGENTS.md 强制）。

验收口径（判成败的硬门槛）：

| 项 | 门槛 |
|---|---|
| 用例集 | ≥ 20 条本机自然语言请求，覆盖读 / 写 / 撤销 / 能力边界四类，落 `src/agent/` 下的用例表 |
| 工具选择正确率 | ≥ 90%（选对工具；多步任务按最终结果判定） |
| 参数正确率 | ≥ 90%（uid / id / 开关值不编造；不确定时先调 `search_streamers`） |
| **误写率** | **0 容忍**——「写前询问」模式下未经用户确认的写操作数为 0（「自动修改」模式下不确认即写是**合法行为**，不计误写）；出现一次即修系统提示与工具 description |
| 能力边界 | 100% 不臆造：不存在的 uid / id 必须报错或澄清，不得凭空构造 id（本机 admin 下「改任意渠道」是合法业务，不算越界） |
| 失败处置 | 任一项不达标 → 先调 description / 提示词；两轮仍不达标 → P1 暂停，回到 P0 评估是否值得继续 |

#### 已落地（2026-09-21，`mcp-interface` 分支，后端侧；webui 侧由前端并行落地）

| 项 | 落点 | 说明 |
|---|---|---|
| ✅ agent loop | 新 `src/agent/loop.ts` + `loop.test.ts`（13 例） | `runAgentTurn(deps, userMessage)`：面板**单会话**（scope = `adminScope()`）读历史 → 拼 `[system, ...history, user]` → 循环（`AGENT_MAX_STEPS = 8`）`completeChat` → 有 `tool_calls` 就逐个 `runToolTracked`（ctx = `{name:'webui-agent', role:'admin', scope:{}}`，**entry='agent'**）→ 结果**或中文错误文本**回填 → 无 `tool_calls` 即终答；超上限给兜底回复（`truncated: true`），不空转。user / assistant（含 tool_calls）/ tool 往来**全部落 ChatStore**；system 提示每轮重拼不落库。历史回放做**双向半截轮次清理**（assistant 的 tool_calls 与 tool 结果没配对成功的都摘掉——否则进程在两者之间挂掉会让之后每一轮请求都被端点拒绝）。LLM 接缝可注入（`opts.completeChat`，测试用假 LLM 驱动多轮剧本）；生产缺省走 `deps.llm.router.completeChat`（熔断/降级与分类任务同源） |
| ✅ 系统提示 | 新 `src/agent/system-prompt.ts` | 中文，四条硬纪律 + 写模式两套措辞：**能力只来自工具**（没有的工具就说没有、不绕路）、**uid/id 先 search 再引用绝不编造**、ask 模式**任何写工具调用前先在回复里复述要改什么、等用户下一轮确认**（auto 模式可直接写但要简述做了什么）、撤销走 `undo_last_change`（本调用域栈顶）、回答简洁。**每轮按当前模式重拼** |
| ✅ 写模式开关 | `system-prompt.ts` 的 `get/setChatWriteMode`（settings `chat_write_mode`，缺省 `ask`）+ 注册表工具 `set_chat_mode`（admin、write）+ `PUT /api/chat/mode` | 工具进注册表以纳入回滚覆盖，但**进 `AGENT_EXCLUDED_TOOLS`**——LLM 若能自己切 auto，「未经确认不写」的门槛就交回给模型（验收表里的「误写率 0 容忍」） |
| ✅ 四端点接线 | `src/panel/server.ts`（chat dep 不注入则 404） | `GET /api/chat/history` → `{messages:[{role,content,at(秒)}],mode,usage}`（只给 user/assistant 的**有正文**消息；`tool` 结果与空轮次不上屏）；`POST /api/chat` → `{ok,reply,usage}`（message 空/非字符串 400；LLM 未启用/无可用 provider 400 中文指引去设置页；调用彻底失败 502）；`POST /api/chat/reset` → `{ok:true}`（清消息保会话行）；`PUT /api/chat/mode` → `{ok:true,mode}`（经 `runPanelTool` → `set_chat_mode`，非法值 400） |
| ✅ 清单分类 | `write-path-inventory.test.ts` | `/api/chat/mode` → `registry` + `set_chat_mode` + `exposeToAgent:false`；`POST /api/chat`、`POST /api/chat/reset` → `excluded`（对话入口自身只写 chat_messages；reset 是清消息，非配置写） |
| ✅ `entry='agent'` | `src/mcp/run-tool.ts` | `ToolEntry = 'panel' \| 'mcp' \| 'agent'`（`toolChangeMeta` / `runToolTracked` 签名 + 审计标签 `Agent`）；`ChangeMeta.entry` 本就是 string，注释里已列 agent。面板变更历史因此能区分「agent 写的」与「人手点的」——**webui 侧文案映射（`undo.js` 的 ENTRY_NAMES）待补** |
| ✅ provider 就绪判据 | `src/analysis/providers.ts` | `ProviderStatus` 增 `ready`（= `isReady()`）：让 `/api/chat` 的「未就绪 400」与「调用失败 502」分开，不必 parse `status` 文案。纯新增字段，`/api/llm` 契约不变 |

**装配**：`PanelDeps` 无新字段——loop 消费的 `chat`（ChatStore）、`llm.router`（可热重建）、`undo`（写快照）在切片 A 已挂进 `index.ts`，故装配根零改动。**LLM 关/无 provider 时 `/api/chat` 按契约 400**（`chatBlockedReason` 统一出中文原因，REST 只做状态码映射）。

**与计划的两处不符（已按实际处理）**：① 计划 P1 写的「面板新增**第四个**视图」在 `main` 上早已是四个视图（时间表/主播/图文/设置），agent 对话是**第五个**视图；② 「写前询问 / 自动修改」开关**没有**做成独立的布尔设置项，就一个 `chat_write_mode`（'ask'/'auto'，缺省 ask）——一个键两个值即是开关，避免两处状态可能打架。

**仍未验证**：`completeChat` 的 `responses` 分支（`function_call_output` + `call_id` 往返）仍只有离线测试钉住，第一次接真端点时先跑一次单轮工具往返（见上文 P0 记录）。`runAgentTurn` 的真机验收（≥20 条用例、工具选择/参数正确率、误写率 0）**需要人在面板上跑**，属 P1 验收口径的实操项，不在本轮后端交付内。

### P2：MaiBot 插件

独立仓库（Python）。前置 = **渠道绑定令牌已在 P0 落地** + MaiBot 持续监听群聊且用户接受插件维护。插件侧按运行时注入的 group_id 选对应渠道的令牌（身份字段不进任何 LLM 参数）；DD-claw 保证 gateway 契约稳定（工具名与业务参数不变，身份参数改为 scope 注入）。

**P2 不是「DD-claw 零改动」**：渠道类型放开 / copy-on-write 拆分 / 删除路径渠道归属校验 / 按渠道限流审计，共四处改动 + 调用域地基。详案见下文「P2 详案」。

**已落地（2026-09-22）**：DD-claw 侧 = gateway 渠道隔离收敛（`channelId` 移出 `add_group_push_rule` schema 改 `ctx.scope.channelId` 注入、未绑渠道 403 不回落；`list_push_rules` / `list_channels` / `list_group_channels` 服务端按 scope 裁剪；渠道类型放开 `group|private`；copy-on-write 拆分原语 `splitPushRuleChannel`（`src/core/push.ts`）+ 删除路径渠道归属校验（自助规则整条删 / 多渠道拆分移出 / 非 mcp 规则只移出本渠道——唯一渠道即本渠道时 `channels` 置空、行保留，已拍板）；写限流改按 `ch:<channelId>` 分桶）。插件侧 = 独立目录 `dd-claw-maibot-plugin/`（`plugin.py` 三个 `@Tool` 动作 + httpx 客户端 SSE/JSON 双解析 + initialize 兜底 + `@Command`），本机 **MaiBot 1.1.4 + maibot_sdk 2.7.1 实测 146 用例全过**；版本假设与 SDK 下限见插件 README。

### P3：NapCat 直连

前置 = 决定绕过 MaiBot（或 MaiBot 不监听群聊）。~200 行（事件接收 + 触发纪律 + 对话限流）+ P1 的 loop + P0 地基。**斜杠命令（确定性）与 LLM 对话（复用 P1 loop）两条路共存、可同时启用**——确定性命令在 P2 插件侧同样可用（`@Command`），所以「斜杠优先」不构成选 P3 的理由。

**已落地（2026-09-22，`src/qqbot/`，与 P2 并存、用户任选）**：`POST /onebot` 事件接收（不在 /api 下，恒 200 + 动作摘要）；loop 泛化（`AgentOptions` 传 scope/role/actor/systemPrompt，面板行为零变化）；触发纪律 = `/reset`、`/help` 确定性命令 + 群聊 @机器人或前缀（缺省 `dd`）进 LLM + **私聊直通**（产品解释见 `docs/modules/qqbot.md`）；会话→渠道映射 `settings.qq_channel_map`（查不到 = 拒绝服务不回落）；按渠道对话限流（10 轮/分钟）；回执裁剪（450 字保守阈值）+ 上下文阈值 `/reset` 附言；NapCat 上报地址条目自管（`network.httpClients` 的 `dd-claw-qqbot` 条目，幂等 + 热重载，手工兜底步骤见模块文档）。变更记录 entry=`agent`、actor=`qqbot-<会话键>`、撤销走本渠道栈。

### 共享新组件（一次投入，多前端复用）

| 组件 | 内容 | 量级 | 被谁复用 |
|---|---|---|---|
| schema 转换 | zod v4 `z.toJSONSchema()`，`z.object(shape)` 包一层即成 function 定义，零新依赖 | ~30 行 | agent loop |
| `completeChat` | providers.ts 扩展：messages + tools 透传、解析 tool_calls；熔断/key 池/降级与 completeJson 同源；不支持 tools 的端点走 JSON 模拟降级（现有 completeJson 即可拼）。**注意两点**：① `responses` 协议不是顺手带过——tools 用 `{type:'function',name,parameters}`，回填要用 `function_call_output` + `call_id`，而现 `callResponses` 只映射 `input_text`/`input_image`；② 「JSON 模拟降级」产出的 args **同样必须进 `runTool` 校验**，写工具不得绕过 schema | ~150 行 + 测试 | agent loop |
| agent loop（`src/agent/`） | maxSteps ≈ 8、handler 进程内直调注册表、工具错误回填自我纠正、审计复用 | ~80 行 + 测试 | WebUI Agent / NapCat 直连 |
| `runTool()`（共享执行器） | 唯一执行入口：`ctx = {role, name, scope{channelId}}` + zod 校验 args →（写操作）快照 + 审计 → 错误归一为中文文案。现在校验（SDK 做）与审计都在 MCP 适配器里，第二个适配器直调 handler 会同时丢校验和审计 | ~80 行 + 测试 | 面板 REST / MCP / WebUI Agent / NapCat 直连 |
| 调用域（scope）解析 | `McpAuth` 增 `scope`；`/mcp` 侧由**令牌的 `channelId`** 解析，进程内入口直接构造；**身份字段从 `add_group_push_rule` 等 schema 中移除**，读侧按 scope 服务端裁剪；`mcp-token` CLI 增 `--channel` | ~80 行 + 测试 + 令牌 CLI | 所有 QQ 入口（P2/P3） |
| 写操作快照 + 撤销 | **所有配置写路径必过**：记录受影响行的前像、与写入同事务；**每来源渠道一条栈**（admin 另有全局栈）；每次撤销前后像 ≠ 当前值即**中止并提示**；面板入口 = 设置页底部变更历史，agent 侧 = 内部工具。LLM key 只记「已变更」不落明文（撤销 = 清空重填） | ~120 行 + 表 | 所有写路径 |
| 按渠道限流 / 审计检索 | 现有 `mcpWriteLimiter` 按令牌名分桶（MaiBot 单令牌 = 全群共桶）；改为按 `scope.channelId` 分桶 + 审计条目带渠道，供面板按渠道检索 | ~60 行 + 测试 | P2 / P3（P1 无渠道，维持现状） |
| 会话存储（chat 会话 + 消息） | 会话持久到库；**按来源渠道隔离**（面板单会话 + 「重置上下文」）；**上下文不做自动裁剪**：面板提示用量，QQ 侧达阈值时由回复末尾主动提示 `/reset` | ~80 行 + 表 | WebUI Agent / NapCat 直连 |
| 会话→channel 映射 | settings 存 `<平台>:<会话 id>`（群号或个人 QQ 号，无区别）→ channelId | ~20 行 | MaiBot 插件 / NapCat 直连 |
| 规则渠道拆分（copy-on-write） | 把某规则的本渠道拆成独立规则（原规则保留其余渠道、显式设定两侧 `createdBy`），供自助「只改本渠道」；与后续写入同事务 | ~40 行 + 测试 | gateway 写路径（自助增删改的前置） |
| 事件接收 + 触发纪律 + 对话限流 | NapCat httpPost 上报端点；**关键词/前缀硬触发可选、可与 MaiBot 语义触发并存**；**对话与写限流按来源渠道分桶** | ~200 行 | 仅 NapCat 直连 |

## P2 详案：MaiBot 插件（QQ 自助推送）

> 状态：预研，未动工。插件独立仓库（Python），不进 DD-claw 主仓；DD-claw 侧 `/mcp` + gateway
> 角色已就绪（见 [mcp.md](../mcp.md)），但按「私聊一视同仁」+ 渠道隔离共需**四处改动与调用域（scope）地基**。

### 目标场景与硬边界

群友在 QQ 群里用自然语言自助：「把栞栞的开播推到本群」「别推 XXX 了」「本群现在推哪些主播」。
硬边界：**每个群 / 每个私聊只能看到并只能改与自身相关的推送配置**；面板与 Claude Code（本机主人）
不受此限——QQ 入口（含主人私聊）一视同仁，**不设 admin**。
本案文字里的「本群」一律理解为**消息来源渠道**（群或私聊）；v1 仍从群起步。

### 为什么 MaiBot 不直连 MCP（定案）

1. **MaiBot 的 MCP 连接是进程级共享**：所有聊天流共用同一条连接
   （[官方 release note](https://github.com/Mai-with-u/MaiBot/releases)），配置在全局
   `bot_config.toml` 的 `[mcp]` 段，没有任何按群/按聊天划分的字段
   （[MCP 配置文档](https://docs.mai-mai.org/manual/configuration/mcp-config)）。
   → **MaiBot 自带的 MCP 连接**无法区分调用来自哪个群，服务端 scope 最多覆盖全部群的并集。
   这正是本插件**不走 MaiBot 的 MCP 连接、而用自带 httpx 客户端逐群选令牌**的原因（方案 A 可行的前提）。
2. **工具参数全部由 LLM 生成**：任何自报群号的字段都可被 prompt injection 伪造，不能作信任锚点。

唯一可信的群身份来源是 OneBot 事件里的 `group_id`。能读到它的确定性代码不止 MaiBot 事件层——
Host 自己在 `plugin.invoke_tool` 路径就把 `{stream_id, chat_id, group_id, user_id, platform}`
注入插件工具回调（`src/plugin_runtime/component_query.py`：`_build_tool_context_payload` →
`_build_tool_invocation_payload`），所以插件**不必自建事件层**。但注入是 **fill-only**：
LLM 填了同名字段就不覆盖——不变量因此是「`group_id`/`stream_id`/`user_id` 永不进
`ToolParameterInfo`，只读运行时 kwargs」（官方示例把 `stream_id` 声明成 required 参数，
在这套语义下等于把身份交给 LLM）。旧 `@Action` 路径是强制覆盖、更硬，但 README 称
`@Action` 现仅作 `@Tool` 的兼容入口，转换后是否仍走强制覆盖待实测。
注意：否定的是「MaiBot 作为 MCP Host 直连」；插件本身仍消费 `/mcp` 端点、端点形态不变。

（上述结论取自 SDK/官方文档与 Host `main` 分支源码，落地前按实际 MaiBot 版本复核一次。）

### 信任模型推论（在总表基础上）

- 插件对 LLM 暴露的动作里**没有任何 channelId / group_id 参数**——渠道由**令牌绑定**在服务端解析，
  LLM 无字段可填、无值可伪造；插件只负责按运行时 group_id 选出对应令牌。
- 读侧：渠道裁剪在**服务端**完成（能力层按 `scope.channelId` 过滤 `list_push_rules` 等结果），
  **不由插件自己过滤**。插件只负责不声明身份参数、不调 `list_group_channels`（避免其他渠道号进入 LLM 上下文）。
- prompt injection 的最坏结果 = 本渠道成员给本渠道加/删规则——这正是开放的能力本身。

### 插件设计（v1）

技术栈：Python + [maibot-plugin-sdk](https://github.com/Mai-with-u/maibot-plugin-sdk)
（能力代理、配置模型、热重载）。

配置（插件 config.toml）：

```toml
endpoint = "http://127.0.0.1:8787/mcp"

[[groups]]                   # 群 → DD-claw 群渠道映射（可信锚点，主人维护）
group_id = 123456789
channel_id = 2               # 供插件做会话映射/自检；权威始终是服务端由令牌解析出的 scope
token = "ddc_..."            # 该群的渠道绑定 gateway 令牌（一渠道一条，DD-claw 侧 mcp_tokens.channelId=2）
```

令牌与渠道的绑定关系**只存在 DD-claw 侧**（`mcp_tokens`，`npm run mcp-token add <名字> gateway --channel 2`）；
插件配置里只是「哪个群用哪条令牌」。`channel_id` 不发给 DD-claw、也不进任何工具参数。

配置**值**只能全局（一个 `config.toml`，`config_model` 无群维度），所以群映射只能落在
`[[groups]]`（或插件自建存储）；而「按群启用 / 限定生效范围」是 MaiBot 原生的
（`chat_scope` ∈ {all,group,private}、`allowed_session`/`disabled_session`、
`component.enable_component(..., scope='stream', stream_id)`），不需要自造。

对 LLM 暴露三个动作（**channelId 不进参数**，由令牌绑定在服务端确定）：

| 动作 | 链路 |
|---|---|
| 添加本渠道推送（主播名/uid，分类、推送词可选） | `search_streamers` 确认 uid → `add_group_push_rule`（不带渠道参数） |
| 删除本渠道推送（主播名或规则 id） | `list_push_rules`（服务端已按 scope 裁到本渠道）定位 → `remove_group_push_rule` |
| 查看本渠道推送 | `list_push_rules`（同上）+ `list_streamers` / `list_categories` 翻译名称 |

工具可见性：MaiBot 默认把工具放进 **deferred 池**（需被「搜索发现」才可见），
`core_tool=True` 才进 visible 池——三个动作都应标 `core_tool=True`。模型只看到
`description` / `brief_description`，`detailed_description` 已弃用、不参与描述构建
（`src/core/tooling.py`），调 description 时别指望后者。

调 `/mcp`：无状态 streamable_http——每次 `POST {endpoint}` 带
`Authorization: Bearer …` / `Content-Type: application/json` /
`Accept: application/json, text/event-stream`，JSON-RPC `tools/call`，
解析 SSE `data:` 帧取 result。业务错误（`isError` 的中文报错）直接透传回群。

### 阶段与不做

- **v1（本案）**：单群起步，三个动作；实测 LLM 选动作/填参数的命中率与注入抵抗，按表现调 description
- **v2（预留）**：**不做 admin 提升**（QQ 入口一视同仁，只在来源渠道范围内读写）。未来若确需
  admin（如主人私聊改全局设置），按「与 WebUI Agent 面板 UX 对齐」设计——那时才动 DD-claw 侧；
  HMAC 盖章之类的机制不预先承诺。
- **不做**：MaiBot 直连 MCP；插件内重复实现服务端已有约束（限流/去重/条数上限以服务端为准）

### 调研结论与剩余实测项

依据：SDK README / guide、docs.mai-mai.org（tools / commands / config / manifest / vibe-coding /
mcp-integration）、Host `main` 分支源码。**落地前按实际 MaiBot 版本复核一次。**

| 调研项 | 结论 |
|---|---|
| maibot-plugin-sdk 的动作注册形态、与内置/MCP 工具的共存与优先级 | `@Tool(name, description/brief_description, parameters)`；MCP 工具与插件、内置工具**同池平等**（统一 `ToolProvider`），重名先注册者胜（MCP 另有 6 个内核保留名：`reply`/`no_action`/`stop`/`create_table`/`list_tables`/`view_table`）；默认 deferred 池，需 `core_tool=True` |
| 插件能否按群启用 / 分群配置 | 配置**值**全局（单 `config.toml`，无群维度）→ 群映射只能写 `[[groups]]` 或插件自建存储；**启用/范围**原生支持按群（`chat_scope` / `allowed_session` / `toggle_component_status(..., session_id)`） |
| Python httpx 与 `/mcp` 无状态模式的兼容 | SDK 无任何 HTTP/SSE 能力，插件须自带客户端并在 manifest `dependencies` 声明 `{"type":"python_package","name":"httpx"}`（Runner 自动安装）；SSE 帧解析无官方指引 → 仍属实测项 |
| gateway 令牌明文存插件 config.toml 的口径 | 无误，同面板 LLM key 的本机明文口径；方案 A 下每渠道一条令牌，条数随群数增长，仍是本机明文文件 |

顺带确认（影响 P2/P3 形态边界）：`@Command(name, pattern=..., permission="operator")` 可用——
正则确定性匹配、**LLM 不参与选择**，配合 `bot_config.toml [plugin.command_permissions.<插件>.<命令>]`
的 `allow_users` / `allow_chats` 做按群授权；所以确定性斜杠命令在插件侧即可实现，不必等 P3。
（其三元素返回值的第三位在 Host 里实际是 **intercept 标志**，与文档写的「优先级」不一致。）

剩余实测项（动手时各几分钟）：

- `@Action` → `@Tool` 兼容转换后，legacy 的强制覆盖语义是否仍生效（决定身份注入要不要加保险）
- 文档声称工具回调有 `message` kwarg，源码里只有 command 路径有——触发判定别依赖它
- httpx 直连 `/mcp`、`data:` SSE 帧解析（含是否先 `initialize` 一次兜底）
- 上述源码级结论按实际 MaiBot 版本复核

### 与 DD-claw 的契约

插件只依赖 gateway 角色的 6 个工具：`search_streamers` / `list_streamers` /
`list_categories` / `list_push_rules` / `add_group_push_rule` / `remove_group_push_rule`。
这些工具名、业务参数与服务端约束视为对插件的稳定契约；要改需同步改本文档。
约束里有**四处**需要 DD-claw 侧改动（**P2 既不是零改动，也不是两处小改动**）：
① 渠道判定从 `targetType==='group'` 放开到 `group|private`（`list_group_channels` 同理）；
② 多渠道规则走 **copy-on-write 拆分**（自助只改拆出来的本渠道规则；非 mcp 规则不得整条删除）；
③ **删除路径补渠道归属校验**（`remove_group_push_rule` 现只认 `createdBy==='mcp'`，跨渠道可删）；
④ **限流/审计按渠道分桶**（现按令牌名分桶）。①②③④ 都在服务端写路径内部完成，插件侧无需感知业务逻辑。

**契约形状（方案 A）**：`channelId` 从 `add_group_push_rule` 的 schema 中移除、改由令牌解析 scope；
插件在 `[[groups]]` 里为每个群配一条令牌，**插件侧需感知**（这也是本案唯一的插件侧改动）。
契约表述：**工具名与业务参数不变，身份参数改为 scope 注入**——`add_group_push_rule` 的参数收敛为
`{ uid, categoryId?, messageTemplate?, name? }`，`list_group_channels` 在 gateway 令牌下只回本渠道。

## 约束（任何接入途径不得破坏）

1. tools.ts 注册表是唯一能力信源；新能力先进注册表再接前端
2. 写路径全部过面板同款校验 + 热生效回调（listen/advanced/llm 的 onChanged）
3. 身份确权只发生在接入层；能力层只认 **role + 调用域 scope**（scope 由接入层解析后经 `runTool` 传入，能力层只读不推断），
   不认任何**工具参数**里的身份声明——`channelId` 这类身份字段**必须**从 schema 移除（见「能力层调用域」）
4. gateway 约束（createdBy='mcp'、单渠道 ≤20 条、写限流、审计日志）对所有 QQ 入口一致生效，前端不重复实现；
   **删除/修改都必须先校验目标规则的渠道归属**，对**非 mcp 规则**只允许渠道级操作（copy-on-write 拆出本渠道），不得整条删除
5. LLM 调用不进入轮询循环；agent loop 走 LlmRouter（熔断/降级语义与分类任务一致）
6. 写操作必须可撤销且快照彻底（每个单次变更都可撤销、栈式逆序不做跳序、**撤销前逐行比对前像与当前值、不一致即中止**、
   历史全量保留，覆盖所有配置写路径与级联影响，与写入同事务；唯一例外 LLM key；非 DB 写的遗漏面见「变更记录遗漏面」）；
   身份字段永不进 LLM 可见的工具参数表
7. 渠道隔离贯穿全链路（读 / 写 / 上下文 / 撤销 / 审计 / 限流共用同一个「来源渠道」锚点 = `scope.channelId`），
   **在服务端单点强制，不靠前端/插件过滤**

## 待定项

| # | 议题 | 何时需要定 | 说明 |
|---|---|---|---|
| 1 | P2（MaiBot 插件）还是 P3（NapCat 直连），或都做 | P0/P1 完成后 | 决定 P1 的 agent loop 是否被复用、P2/P3 排序；取决于「MaiBot 是否继续作为群聊对话方」 |
| 2 | QQ 回执裁剪的具体长度阈值 | P2/P3 动手时 | 默认边界已定（正文优先、超长改「已写入，详情请在面板查看」），实现时按 QQ 实际限制微调 |
