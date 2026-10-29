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
| 决策模型判定档 | System One 供应商名单 + 独立 key + 启停 / 排序 + `vision` 标记 + `systemone` 探活；判决链第一档（每分类 `noul` 得概率、主分类一道 `choice`，灰区不定案），独立路由 / 熔断 / key 轮换 / 超时门槛参数，与 LLM 通道隔离 |
| 内容判定与归档 | 统一分类 + 判决链（确定性先跑、模型档按序、逐来源落库并标生效）→ `verdicts`；主分类组单选 → `primary_verdicts`（时间表展示）；判定与推送过程入 `content_audit`，面板可回看（契约见 [plan/decision-model.md](plan/decision-model.md)「二」与 [content-audit.md](content-audit.md)） |
| 直播分类时机 | 五个时机（开播 / 开播延迟后 / 直播中定时 / 标题分区变更 / 变更延迟后）各自选规则 / 决策 / LLM 三档；`analysis/triggers.ts` 排延迟与周期，LLM 冷却按房间独立；多次判定替换当前结论并留 `live_classification_runs` 历史，时间表按鼠标时间点回看（机制见 [modules/core.md](modules/core.md)、[modules/analysis.md](modules/analysis.md)） |
| 分类变更重推 | 重分时机只有「生效且属于」的分类集合相对上一轮改变时才重新匹配与发送，不经每场一次去重；任意内容规则同样响应，无命中 = 不推；冷启动抑制与推送总开关只抑制发送，不阻止判定与历史 |
| 视觉输入规范化 | 直播关键帧 / 封面与图文配图先落本地，再经 `sharp` 统一转合规 JPEG；被拦图片逐张记原因 |
| 推送规则与执行 | 一张 `push_rules` 覆盖直播与图文两形态，确定性匹配出渠道与文案，dispatcher 按渠道发送（模型见 [统一计划](plan/unify-classify-push.md)、机制见 [modules/analysis.md](modules/analysis.md)） |
| 面板与前端 | 五视图（时间表 / 主播 / 图文 / 设置 / Agent）+ 分类与推送记录回看 + 分类时机 sheet + 设置页底部变更历史；demo mock 与后端同构 |
| 时间轴统计 | `live_segments` 内容变更切段 + `/api/schedule`（北京 06:00 日界）+ 五天滑动窗口泳道 + 按时间点的分类判定历史 |
| NapCat 托管与健康告警 | 专属端口条目自管 + 三态探测看门狗 + 双平台自动拉起；健康告警收敛到本机 toast |
| 能力面（轴 B） | 注册表为唯一能力信源，写路径全部经 `runToolTracked`（校验 / 审计 / 快照）；`/api/*` 已收敛；MCP admin/gateway 双角色 + 渠道作用域隔离；撤销栈每调用域一条 |
| 接入途径 | `/mcp`（进程外 Host）· WebUI Agent（`src/agent/`）· NapCat 直连（`src/qqbot/`）· MaiBot 插件（独立仓库，自带 loop）；WebUI Agent 与 QQ 直连共用同一个 agent loop 与能力面 |
| 数据迁移 | 旧图文规则与范围列的一次性搬家已完成（旧表 DROP、账号选用列删除），机制与升级约束见 [modules/core.md](modules/core.md) |

## 待验收

已实现但尚未在真机达到验收口径，或实现只覆盖部分路径：

- **WebUI Agent / QQ 入口真机验收**：P1 验收口径 = ≥20 条本机自然语言请求（读/写/撤销/能力边界四类）、工具选择正确率 ≥90%、参数正确率 ≥90%、误写 0（「写前询问」模式下未经确认的写）、能力边界 100% 不臆造 id 或 uid。口径见 [plan/agent-access.md](plan/agent-access.md)「P1」。
- **`completeChat` 的 responses 分支**：`function_call_output` + `call_id` 往返只有离线测试，首次接真端点时先跑一次单轮工具往返再放量。
- **LLM 分类真机验收与调优**：真流量下看结构化输出失败率、带图请求确实携带规范化图片（直播与图文各至少一例）、内容记录逐来源回看；provider 结构化输出兼容（部分 provider 对 schema 请求返 400、由路由降级接住，需按其支持的模式单独复验）。口径见 [plan/decision-model.md](plan/decision-model.md)「五」。
- **QQ 通道复验**：统一规则升级后未实发 QQ（当次验收本机缺机器人配置，只走了本机 toast）；下次改动推送链路时一并复验群/私聊实发。
- **直播分类时机的真实流量表现**：延迟 / 定时 / 变更后的重判与「分类变更重推」只有离线用例，尚未在真实开播流量上验证（同理未实发 QQ）；上线后重点看定时时机的模型花费、重推频率与时间表分类历史的可读性。
- **MaiBot 插件适配统一规则模型**：插件（独立仓库）仍按旧 `uids` 读取规则范围，需改为读 `subjectKind` / `scope` 并覆盖图文规则显示与筛选；未适配前其「规则范围显示」「按主播查删」不可信，改动也不在本仓。
- **X 源待验证项**：转发去重语义（要「每次转发都推」须另取 RT 自身 id）、免登录路线的长期稳定性等，见 [research/twitter.md](research/twitter.md) §7 与 [plan/twitter-source.md](plan/twitter-source.md)。

## 未实现

### 未建文件

| 文件 | 规划职责 |
|---|---|
| `src/analysis/context.ts` | 按房间聚合时间窗内多源数据 → 一份 context（喂给分类 prompt） |
| `src/analysis/tasks/schedule-extract.ts` | 预告解析 → `schedules` 表（置信度入库、消费端按阈值过滤） |
| `src/sources/bili/danmaku.ts` | 弹幕 WS 按需拉起/关闭、采样进分析队列 |
| `src/sources/bili/wbi.ts` | WBI 签名，仅弹幕 WS 前置需要（动态接口不需要） |

### 未落地能力

- **`schedules` 表 + 预告条 + 「预定时间到」推送**（M3 剩余）。
- **通用分析触发与多源 context**：直播侧的五个分类时机已落地（含延迟 / 定时 / 变更后重判），仍缺**图文侧按规则触发**与「按房间聚合时间窗多源数据」的 context。
- **弹幕抓取**（含 L1 本地信号：弹幕词频、帧间差异）。
- **可选推送时机**：延迟到有封面 / 按内容实际变更之外的其它时机（只增不减，面板怎么配未定）。
- **优先级**：`PushMessage.priority` 无消费者，等产品方案再定（不做屏蔽类偏好，见 [design](design.md) §11）。
- **决策档实战验收**：离线契约已闭合（[plan/decision-model.md](plan/decision-model.md) M1–M4），但没有真流量数据——p95 延迟、请求失败率、灰区比例、四条回退路径的实际表现都要上线后再看；外部证据见 [research/decision-models.md](research/decision-models.md)。
