# DD-claw 实现现状

本文件是进度的唯一汇总：做到哪了、哪些实现了但未验收、哪些还没做。设计理由与里程碑验收口径见 [design.md](design.md) §4、§8；专题现行契约见 [mcp.md](mcp.md)、[content-audit.md](content-audit.md)、[boundaries.md](boundaries.md)；分模块机制见 [modules/](modules/)；代码职责见各级 `AGENTS.md`。已放弃/不采用的方案不在本文件重复，见 [design.md](design.md) §11。

## 里程碑视图

| 里程碑 | 状态 | 说明 |
|---|---|---|
| M1 开播通知 | ✅ 已落地 | 批量轮询 + 状态机 + OncePerSession + OneBot/Toast 全链路；NapCat/Toast 实测可用 |
| M2 规模化 + 内容判定 | ✅ 已落地 | 名单迁库 / 扫码登录 / 关注同步 / 三类图文来源 / LLM 分类管线 / 统一分类与推送规则 / 面板 |
| M3 预告时间表 | 过半 | 过往时间轴统计已落地；预告解析（`schedule-extract` → `schedules`）与「预定时间到」推送未做——缺的是预告解析任务与 `schedules` 归档，不是内容信号接入 |
| M4 偏好与路由 | 部分 | 统一分类与推送规则、确定性 matcher 已落地；剩余 = 可选推送时机 + 优先级（产品方案未定） |
| M5 产品化 | 未开始 | 面板 v0–v2 已在 M2 提前落地，不计入本里程碑 |

## 已落地能力

| 能力 | 实现与契约 |
|---|---|
| 名单与凭据 | `streamers` / `follows` + CRUD + config 种子导入；B站 cookies + nav 心跳 + passport 扫码；微博扫码换票落盘；source 名单读 `listWatchedUids()`（过滤非纯数字 uid） |
| 关注列表同步 | `FollowsSource` 分页拉取，正轮成功才落库，不自动入监听 |
| 直播状态与采样 | 批量 `get_status_info_by_uids`（50/片）+ `diffRoom`；轮播按未开播；`KeyframeCache` 在播定时本地缓存 |
| 三类图文来源 | X（免登录路线，`x_accounts`）· 微博（`weibo_accounts`）· B站动态（`bili_accounts`，监听主播 ∪ 名单账号）；各自独立名单、运行状态与账号级故障标记，`feed_post` 只对名单账号发 |
| 补推语义 | 三平台统一的恢复/补推判定（静默轮、未运行期间按开关与时间窗/条数封顶补推），权威定义在 `src/core/backlog.ts` |
| LLM 接线 | text/vision 路由、熔断、多 key 池、结构化输出多档、chat-completions / responses 双协议；`completeChat` 透传 tools |
| 内容判定与归档 | 统一分类 + 可插拔判决链（模型优先、确定性兜底）→ `verdicts`；判定与推送过程入 `content_audit`，面板可回看（行为契约见 [content-audit.md](content-audit.md)） |
| 推送规则与执行 | 一张 `push_rules` 覆盖直播与图文两形态，确定性匹配出渠道与文案，dispatcher 按渠道发送（模型见 [统一计划](plan/unify-classify-push.md)、机制见 [modules/analysis.md](modules/analysis.md)） |
| 面板与前端 | 五视图（时间表 / 主播 / 图文 / 设置 / Agent）+ 分类与推送记录回看 + 设置页底部变更历史；demo mock 与后端同构 |
| 时间轴统计 | `live_segments` 内容变更切段 + `/api/schedule`（北京 06:00 日界）+ 五天滑动窗口泳道 |
| NapCat 托管与健康告警 | 专属端口条目自管 + 三态探测看门狗 + 双平台自动拉起；健康告警收敛到本机 toast |
| 能力面（轴 B） | 注册表为唯一能力信源，写路径全部经 `runToolTracked`（校验 / 审计 / 快照）；`/api/*` 已收敛；MCP admin/gateway 双角色 + 渠道作用域隔离；撤销栈每调用域一条 |
| 接入途径 | `/mcp`（进程外 Host）· WebUI Agent（`src/agent/`）· NapCat 直连（`src/qqbot/`）· MaiBot 插件（独立仓库，自带 loop）；WebUI Agent 与 QQ 直连共用同一个 agent loop 与能力面 |
| 数据迁移 | 旧图文规则与范围列的一次性搬家已完成（旧表 DROP、账号选用列删除），机制与升级约束见 [modules/core.md](modules/core.md) |

## 待验收

已实现但尚未在真机达到验收口径，或实现只覆盖部分路径：

- **WebUI Agent / QQ 入口真机验收**：P1 验收口径 = ≥20 条本机自然语言请求（读/写/撤销/能力边界四类）、工具选择正确率 ≥90%、参数正确率 ≥90%、误写 0（「写前询问」模式下未经确认的写）、能力边界 100% 不臆造 id 或 uid。口径见 [plan/agent-access.md](plan/agent-access.md)「P1」。
- **`completeChat` 的 responses 分支**：`function_call_output` + `call_id` 往返只有离线测试，首次接真端点时先跑一次单轮工具往返再放量。
- **LLM 分类真机验收与调优**：含带图（vision 路由）路径与 provider 结构化输出兼容（部分 provider 对 schema 请求返 400、由路由降级接住，需按其支持的模式单独复验）。
- **视觉分类与决策模型通道（P4）**：关键帧本地化 / 图片规范化 / `DecisionProvider` / 审计决策明细在工作区有未提交改动，**仅有离线测试，未验收，不算已落地**；合同见 [plan/unify-classify-push.md](plan/unify-classify-push.md) 附录 C。
- **QQ 通道复验**：统一规则升级后未实发 QQ（当次验收本机缺机器人配置，只走了本机 toast）；下次改动推送链路时一并复验群/私聊实发。
- **MaiBot 插件适配统一规则模型**：插件（独立仓库）仍按旧 `uids` 读取规则范围，需改为读 `subjectKind` / `scope` 并覆盖图文规则显示与筛选；未适配前其「规则范围显示」「按主播查删」不可信，改动也不在本仓。
- **X 源待验证项**：转发去重语义（要「每次转发都推」须另取 RT 自身 id）、免登录路线的长期稳定性等，见 [research/twitter.md](research/twitter.md) §7 与 [plan/twitter-source.md](plan/twitter-source.md)。

## 未实现

### 未建文件

| 文件 | 规划职责 |
|---|---|
| `src/analysis/triggers.ts` | 通用分析触发层：哪些信号在什么时机进模型。**现状是两类内容各自在 pipeline 内联触发**（`live_start` 与 `feed_post` 都会进分类判决链），缺的是「任意时机按规则触发」与直播中抽查 |
| `src/analysis/context.ts` | 按房间聚合时间窗内多源数据 → 一份 context（喂给分类 prompt） |
| `src/analysis/tasks/schedule-extract.ts` | 预告解析 → `schedules` 表（置信度入库、消费端按阈值过滤） |
| `src/sources/bili/danmaku.ts` | 弹幕 WS 按需拉起/关闭、采样进分析队列 |
| `src/sources/bili/wbi.ts` | WBI 签名，仅弹幕 WS 前置需要（动态接口不需要） |

### 未落地能力

- **`schedules` 表 + 预告条 + 「预定时间到」推送**（M3 剩余）。
- **通用分析触发与多源 context**：任意时机按规则进模型、直播中抽查；现存触发只覆盖开播与图文帖发布两个时机。
- **弹幕抓取**（含 L1 本地信号：弹幕词频、帧间差异）。
- **可选推送时机**：延迟到有封面 / 换标题 / 内容实际变更（只增不减，面板怎么配未定）。
- **优先级**：`PushMessage.priority` 无消费者，等产品方案再定（不做屏蔽类偏好，见 [design](design.md) §11）。
- **决策模型通道（P4）**：`/v1/systemone` 主端点、`choice` + `noul` 混装契约、灰区升级与独立计费/熔断档位，合同见统一计划附录 C。
