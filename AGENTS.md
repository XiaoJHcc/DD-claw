# DD-claw

监听用户在面板选定的B站主播（关注列表同步作候选池，直播间 + B站动态 + 微博）→ 持续状态追踪 → LLM 分析（内容分类；预告时间表为目标）→ 按人填的推送规则路由推送（QQ 群 / 私聊 / 本机 Toast）。

**规模假设**：关注上百位、高峰 30+ 同时在播、信号是持续状态而非一次性事件、偏好用自然语言描述。这四条决定了架构，**改代码前先读 `docs/design.md` 第 1、4 节**。

## 架构：两条正交轴

旧「抓取→分析→推送」只描述了**轴 A（运行时数据流）**；项目还有一条正交的**轴 B（能力面与接入：查数据/改设置的 N 种入口）**。交叉点是 SQLite（尤其 `settings`）——轴 A 的归档，也是轴 B 的唯一配置信源。

### 轴 A — 运行时数据流

```
┌─ 抓取  src/sources/   持续生产：原始数据入库归档 + 变更信号上总线
│   bili/live-status 批量轮询（50/片）· follows 关注同步 · dynamic 空间动态
│   weibo/feed 微博时间线（独立名单）· twitter/feed X 时间线 · media/keyframe 在播关键帧缓存
│   bili/danmaku 弹幕 WS（待启动）
│        ↓
│   core/db 领域归档 · core/bus 变更信号（live_start / title_change / feed_post / …）
│        ↓
├─ 分析  src/analysis/   分析触发（目标）→ 队列（并发 2）→ LLM 任务 → 判定入库
│   tasks/classify（现状）· schedule-extract（目标）· providers 路由/熔断/多key/降级
│   context 多源聚合（目标）· triggers 现仅 live_start，目标任意时机按规则进 LLM
│        ↓ 判定入库 verdicts / schedules（目标）
├─ 推送时机与去重  默认开播；未来可选：延迟到有封面 / 换标题 / 内容实际变更（只增不减）
│   机械去重防抖始终生效：每场一次 + 场景切换去重 + 冷却（用户不可配）
│        ↓
├─ 偏好执行  matcher（纯确定性）  人填推送规则 × 判定 → PushMessage
│   push_rules（统一规则，P2 起 live/post 同表）：内容形态 × 分类引用〔空=任意内容〕
│   × 生效范围 scope〔空=全部生效〕→ 渠道 + 推送词 + 附加动作（llm_translate，仅 X 帖）
│   图文筛选条件（帖子类型/引用/带图/关键词）已上移进分类（applies_to=post 的条件组）
│        ↓ PushMessage
└─ 通知  src/notify/   dispatcher 按 channels 路由 + 通道执行
     onebot(NapCat) [已实测] / toast [已实现]（ntfy 已放弃）
```

**解耦点（改代码不要破坏）：** ① **Signal 总线**（抓取→分析）：source 不知道有 LLM。② **任务化 LLM 接口**（分析内部）：schema 进 JSON 出，换模型只动 providers。③ **PushMessage**（决策→推送）：推送层不解释语义（无 `PushDirective` 中间态）。④ **能力面注册表**（轴 B）：`tools.ts` 是唯一能力信源，传输层只是适配器。

**偏好归属（已决策，2026-08-09 修订；2026-10-10 统一计划 P2 落地）**：人类需求是唯一锚点信源——用户面板直填**推送规则**（push_rules，live/post 同表），matcher 确定性执行；LLM 只做**内容分类**（本内容属于哪些分类，入 verdicts；图文侧判否也落 pass=0）。分类口径也由人填（categories：LLM 提示词 + 确定性条件组〔关键词/分区/帖子类型/引用/带图〕，`applies_to` 区分 live/post）——有提示词且 LLM 可用以 LLM 为准，LLM 关/熔断/失败回退确定性条件，无提示词永远确定性。不做 NL→结构化编译，运行管线无人工环节。**不做静音名单/静默时段/定时推/「不推」偏好**；未来只有增加式可选推送时机（见 `docs/design.md` §11）。

**高峰并发原则**：轮询循环只做「拉批量状态 + diff 产信号」两件便宜事；所有 LLM 调用进 `analysis/queue`，通知不等分析结果。

### 轴 B — 能力面与接入

```
                      ┌─ Web UI REST（/api/*，人点鼠标）        [已收敛到注册表]
一个能力面            ├─ MCP over HTTP（/mcp，进程外 Host）     [已落地 v1 + gateway 渠道隔离]
src/mcp/tools.ts ───┼─ WebUI Agent（进程内 agent loop）       [已落地 P1]
（schema + handler    ├─ MaiBot 插件（HTTP 调 /mcp）           [已落地 P2（插件在独立目录 dd-claw-maibot-plugin）]
 + 角色标注）         └─ NapCat 直连（OneBot 事件 → 进程内）   [已落地 P3（src/qqbot/）]
```

- **能力层与传输层解耦**：注册表是纯数据结构（工具名 + zod schema + handler + role），前端直接消费；`/mcp` 只是「进程外 Host」接线。
- **角色在能力层标注（admin/gateway），身份在接入层确权**：localhost 绑定（`/api/*`）= 主人；Bearer token → 角色；OneBot 事件身份天然可信；**LLM 生成的参数永不可信**。**`/mcp` 永远要令牌**（缺失/无效 401、零令牌 503），**不设回环免 token**（已定 2026-09-16）；QQ 渠道经 **gateway 令牌的 `channelId` 绑定**在服务端解析 scope，身份字段不进任何工具参数。
- 目标重构：面板 REST 收敛到注册表，使「唯一能力信源」成立。计划见 `docs/plan/agent-access.md`（**先做 P0 地基：`runTool` + 写快照/撤销 + REST 收敛 + 鉴权口径**），已落地见 `docs/mcp.md`。

## 关键接口

| 接口 | 位置 | 约定（细节见 `docs/design.md` §6） | 状态 |
|---|---|---|---|
| `Signal` / `LiveEvent` / `PushMessage` | `src/core/types.ts` | 事件载荷；`LiveEvent.classifications` 仅 live_start 由分析队列填充、其余恒空；notify 只认 `PushMessage`，`channels` 存在时 dispatcher 按 push_channels 路由 | ✅ |
| `Source.start(ctx)` | `src/sources/types.ts` | `start/stop` 只产 Signal + 归档；source 内禁止任何通知 / LLM 逻辑 | ✅ |
| `Classifier.classify(ctx)` | `src/analysis/types.ts` | 返回 `Classification[]`（非 live_start 为 `[]`）；实现自行入 verdicts | ✅ RulesClassifier |
| `LlmTask<I,O>` | `src/analysis/types.ts` | zod schema 进，JSON 出 | ✅ 类型占位 |
| `DecisionRule.decide(event, signal, classifications?)` | `src/rules/types.ts` | 机械去重 / 防抖属于这层（不是用户偏好过滤）；第三参可空数组 | ✅ M1 版 |
| `Notifier.send(msg)` | `src/notify/types.ts` | 载荷是 `PushMessage`；`capabilities` 声明能否带图；`alert()` 供健康告警（当前仅 toast） | ✅ |
| 能力面 tool def | `src/mcp/tools.ts` | 工具名 + zod schema + handler + role；前端不得绕过注册表私接 Db | ✅ v1 |
| 撤销入口 | `src/panel/server.ts` `PanelDeps.undoLast` + `src/core/undo.ts` `undoEffects` | 撤该调用域栈顶 + 按受影响表/键触发**装配根**的热生效回调（回调不进 Db / UndoStore 层）；撤销自身 `track: false`，不进变更记录 | ✅ |
| `runAgentTurn(deps, userMessage)` | `src/agent/loop.ts` | 一轮对话的完整回路（历史 → LLM 轮 → 工具执行 → 结果/错误回填 → 终答），返回 `{reply, steps, toolCalls, truncated, provider, calls}`（`calls` = 工具调用展示明细，形状信源 `agent/tool-view.ts`）；scope = `adminScope()`、工具一律经 `runToolTracked`（**entry='agent'**）；`opts.completeChat` 是测试注入点；LLM 未就绪 400 / 调用失败 502 | ✅ P1 |

`PushMessage.priority` 目前是**预留字段、无消费者**，等优先级产品方案定了再补。

## 文件地图

一行一文件（`路径 — 职责`）；「改前必知」与深度笔记见 `docs/modules/`，未实现占位见 `docs/status.md`。测试与被测同目录（`*.test.ts`）不逐列。

### core / config / logger

- `src/core/types.ts` — 领域类型 + `toLiveEvent` + 告警阈值常量
- `src/core/bus.ts` — 类型化信号总线（handler 异常隔离）
- `src/core/state.ts` — `diffRoom → Signal`；轮播=未开播；title_change=标题/分区变更
- `src/core/scheduler.ts` — `PeriodicTask` 通用周期任务器
- `src/core/pipeline.ts` — **信号编排唯一装配点**（归档→抑制→分析触发→机械去重→规则匹配→推送；`feed_post` 是与之平行的图文帖分支，X / 微博 / B站动态同分支）
- `src/core/db.ts` — SQLite 表群 + 仓储；`ensureColumn` 在线补列；`raw` 只读句柄与 `transaction` 同步事务包装（供 UndoStore / 级联写）；`migrateWeiboAccounts` / `migratePostRuleScopes` / `dropLiveRcmdPosts` / `migrateVerdictsSubjectKeys` / `migratePushRuleScopeShape`（uids→scope 重建）/ `migratePostRulesToCategories`（post_rules 一次性搬家，搬完 DROP）/ `migrateAccountRuleIdsDrop`（三账号表 rule_ids 删列）一次性数据搬家与清理
- `src/core/undo.ts` — 写操作快照与撤销：`capture`（同步事务版）/ `track`（异步段串行版，写工具的实际记录点）；逐行比对撤销、每渠道一栈、LLM key 不落明文；`DEFAULT_IGNORE_COLUMNS`（四张「配置+归档」混合表——`streamers` + 三张图文账号名单——的轮询/同步回写列不参与差分、比对与还原；`streamers` 已纳入快照表，2026-09-21）、`undoEffects`（撤销后热生效分类，纯函数不持回调；`streamers` 无标签——名单每轮直读 DB）
- `src/core/streamers.ts` — streamers / follows 行类型与映射
- `src/core/push.ts` — push_channels / categories / push_rules / verdicts 行类型与映射
- `src/core/posts.ts` — posts 行类型与映射（pics JSON）
- `src/core/listen.ts` — 监听功能开关（settings `listen_<feature>`）；`dynamic` 只管动态账号名单（bili_accounts）的轮询，监听主播的动态归档随 B站登录常开；手动关→重开 = 该平台启用账号全部进入恢复轮静默
- `src/core/backlog.ts` — 图文补推语义（轮次判定 resume/gap/normal + 时间窗/条数上限挑选；三源共用的唯一权威定义）
- `src/core/runtime-config.ts` — 运行时参数（settings 唯一信源）
- `src/core/onboarding.ts` — 首启默认值种入（一次性闸门）
- `src/core/onboarding-defaults.gen.ts` — 构建期生成物（勿手改）
- `src/core/concurrency.ts` — `mapLimit` 有界并发
- `src/core/csv.ts` — 「逗号分隔列表」输入唯一解析口径（`splitCsvText` 拆分 / `normalizeCsvText` 写库归一，中英文逗号均可；面板、MCP、CLI 统一走这里，别处不得再手写 `split(',')`）
- `src/core/proxy.ts` — **隧道 fetch**（HTTP 代理 CONNECT；Node 22 原生 fetch 不认代理），X 链路唯一出网通道；`TunnelError.stage` 区分代理责任（connect）与目标责任（established），告警分型的依据
- `src/core/x-config.ts` — X/推特连接配置 + 探测状态快照（settings 唯一信源）
- `src/core/x-accounts.ts` — X 独立关注名单（行类型/映射/归一化 + 账号级故障列 `fetch_fail_since`/`fetch_error`；表在 db.ts，独立于 streamers）
- `src/core/chat-store.ts` — agent 会话存储（chat_sessions / chat_messages；会话键 = 来源渠道，与撤销栈同 scope）
- `src/core/weibo-accounts.ts` — 微博独立关注名单（行/映射/uid 归一化 + 源运行状态快照；表在 db.ts）
- `src/core/bili-accounts.ts` — B站动态独立账号名单（行/映射/uid 归一化；表在 db.ts，独立于 streamers）
- `src/core/post-rules.ts` — 图文帖的**平台语义**（PostPlatform / 文案措辞 / quote 与翻译门控）+ 旧 post_rules.filters 的迁移解析口径（`parseFilters`，仅 `migratePostRulesToCategories` 用）；规则行类型已随 post_rules 表 DROP（P2 统一进 push_rules）
- `src/config/index.ts` — 读 `.env` + `config.json`（只有 panel 段生效）
- `src/config/schema.ts` — panel 校验 + provider schema + 默认配置
- `src/logger.ts` — 极简结构化日志（console + 文件 sink：`data/logs/dd-claw-YYYY-MM-DD.log` 按天滚动、保留 7 天，`initFileSink` 在 index.ts 装配，写盘失败静默）

### sources — 抓取

- `src/sources/types.ts` — `Source` / `SourceContext` 接口
- `src/sources/bili/client.ts` — HTTP 层（UA、超时重试、错误分层）
- `src/sources/bili/types.ts` — B站接口返回类型
- `src/sources/bili/live-status.ts` — 批量 `get_status_info_by_uids`（50/片）
- `src/sources/bili/live-status-source.ts` — 轮询 + diff + coldStart + 健康计数；顺手给 streamers 的空值回填 `uname`/`face`/`room_id`（已有值绝不覆盖——这三列 + `updated_at` 是 `undo.ts` 对 streamers 的忽略列）
- `src/sources/bili/auth.ts` — cookies.json + nav 心跳（不进日志）
- `src/sources/bili/qrcode.ts` — passport 扫码客户端（要响应头）
- `src/sources/bili/followings.ts` — `x/relation/followings` 分页（50/页，无 WBI）
- `src/sources/bili/follows.ts` — `FollowsSource`（正轮成功才落库；不自动入监听）；只给已在名单且 face 为空的 streamers 回填头像（不写别的列——该列是 `undo.ts` 对 streamers 的忽略列之一）
- `src/sources/bili/dynamic.ts` — `DynamicSource`：`feed/space`（无 WBI）→ posts；轮询对象 = 监听主播 ∪（图文开关开着时的）bili_accounts 启用账号，`feed_post` **只对名单账号发**（监听主播只归档）；FORWARD 归一 `retweet`、LIVE_RCMD 彻底舍弃；名单账号回写 uname/last_ok_at/头像；`kickAccount` 添加后即时首拉；故障两级同 X（全灭=风控链路级聚合告警，个别失败落库不推送）
- `src/sources/bili/avatar.ts` — B站头像本地化（**直连下载**，hdslb 境内可达且不校验 Referer；md5 文件名入库，面板按文件名读）
- `src/sources/bili/dm.ts` — dm 设备指纹参数（RSSHub 算法）
- `src/sources/media/keyframe.ts` — `KeyframeCache`（md5 去重、相对路径入库）
- `src/sources/weibo/feed.ts` — `WeiboFeedSource`：轮 `weibo_accounts` → mymblog → posts → `feed_post`（`posts.uid` = 微博账号 uid）；登录态心跳折进周期；抓取顺手抠头像落 `cache/weibo-avatars`；每轮上报运行状态快照；故障两级同 X（登录态失效=链路级 login_drop；全灭聚合告警；个别失败落库不推送）
- `src/sources/weibo/avatar.ts` — 微博头像本地化（**直连下载**，sinaimg 境内可达；md5 文件名入库，面板经 `/api/weibo-avatar` 读）
- `src/sources/weibo/qrcode.ts` — 微博扫码（generate 必须带 Referer）
- `src/sources/weibo/auth.ts` — weibo-cookies + `X-Log-Uid` 心跳
- `src/sources/weibo/resolve.ts` — 昵称↔UID 匿名解析链（昵称→uid 实测；uid→昵称走 getIndex userInfo）
- `src/sources/twitter/probe.ts` — **X 连通性探测**（代理 / 实例 RSS / 免登录回退），`npm run probe-x` 与 `/api/x/test` 共用
- `src/sources/twitter/nitter.ts` — Nitter RSS 解析（主路线：唯一能区分原创/转发）；多实例轮询
- `src/sources/twitter/web.ts` — 免登录回退：`x.com` HTML 发现 id + 单推接口补详情；账号存在性校验（og:title 顺手抠显示名，verify 回报）
- `src/sources/twitter/feed.ts` — `TwitterFeedSource`：轮询 `x_accounts` → posts → `feed_post`（模子与 weibo/feed 互为参照）；顺手抠头像 URL 落盘回写、免登录路线回写平台昵称；**故障两级**：一轮全灭=链路级（聚合告警一条 + canary 退避：中断中每轮只探第一个账号），个别失败=账号级（不推送，持续满阈值落库 `fetch_fail_*` 上面板账号卡）
- `src/sources/twitter/avatar.ts` — X 头像本地化（代理隧道下载 → cache/x-avatars，md5 文件名入库；面板经 `/api/x-avatar` 读）

### analysis / rules

- `src/analysis/types.ts` — `Classifier` / `Classification` / `AnalysisContext` / `LlmTask`
- `src/analysis/classifier.ts` — `RulesClassifier`（LLM 优先 + 确定性回退，入 verdicts）
- `src/analysis/queue.ts` — 分析队列（限流并发 2；`run()` 是图文帖等非分类任务的通用入口）
- `src/analysis/providers.ts` — LLM provider（路由/可重试失败就地重试/熔断/多 key/双协议）
- `src/analysis/tasks/classify.ts` — 单次批量 LLM 分类任务
- `src/analysis/tasks/post-analysis.ts` — 图文帖翻译任务（判定已挪进分类判决链，这里只剩生成译文；只对 X 帖请求，纯文本）
- `src/analysis/post-analyzer.ts` — 图文翻译编排（规则层附加动作 llm_translate；LLM 不可用/失败一律不附译文、绝不挡推送）
- `src/analysis/matcher.ts` — 确定性匹配（`matchCategory`/`matchCategoryItem` 条件算子注册表〔keyword/area/postType/quote/media〕/ `matchRules` 两形态统一命中 / `aggregateRuleHits` / `renderTemplate` / `renderPostTemplate`）
- `src/rules/types.ts` — `DecisionRule` / `NotifyDecision`
- `src/rules/once-per-session.ts` — 每场直播推一次

### notify — 推送

- `src/notify/types.ts` — `Notifier` 接口
- `src/notify/message.ts` — `liveEventToMessage()` / `postToMessage()`（图文帖：X 与微博两平台文案，不用 emoji）
- `src/notify/dispatcher.ts` — fan-out + 渠道路由 + `alertAll`
- `src/notify/onebot.ts` — NapCat OneBot 11 HTTP（串行 + 1.2s；无 alert）
- `src/notify/napcat.ts` — NapCat 通道 + 失活自动拉起（双平台、端口条目自管）
- `src/notify/toast.ts` — 本机通知（健康告警唯一通道）
- `src/notify/mac-notifier.ts` — macOS 原生 helper（失败回落 osascript）
- `src/notify/aumid.ts` — Win32 AUMID 注册
- `src/notify/image-cache.ts` — 图片本地化（B站/微博图床直连 / **X 图经代理隧道下载**，落盘后由 onebot 内嵌 base64 发给 NapCat：沙盒 QQ 无文件读权限，file:// 会 EPERM）

### panel / mcp

- `src/panel/server.ts` — node:http + 静态内嵌 + `/api/*` + `/mcp`；**写路由一律经 `runPanelTool`/`callTool` 走注册表**（校验/审计/快照在能力层，路由只做状态码与形状映射）；**唯一例外 `POST /api/undo`**（撤销执行器本身，直接调 `deps.undoLast` 且不入快照）
- `src/panel/http-util.ts` — 解析/校验/响应 + 面板与 MCP 共用逻辑
- `src/panel/schedule.ts` — 时间表查询（北京 06:00 日界）
- `src/panel/undo-view.ts` — 变更历史的展示层翻译（`title` 中文操作名 / `headline` 值感知一句话描述 / `detail` 行级带值明细（`changes[{field,from,to,bool?}]`）/ `undoNote` refill 判定）——settings 键与表→中文名唯一信源，webui 不再自维护工具名映射
- `src/panel/webui-assets.gen.ts` — 构建期生成物（勿手改）
- `src/mcp/auth.ts` — token 模型 + `resolveMcpAuth`（调用域：gateway 令牌绑渠道）
- `src/mcp/tools.ts` — 工具注册表（按角色；`registerTools` 走 `runToolTracked`）；`undo_last_change` 是唯一 `track: false` 的写工具（撤销不进快照栈）
- `src/mcp/run-tool.ts` — **能力层唯一执行入口**：`runTool`（zod 再校验 + 审计 + 错误归一）+ `runToolTracked`（写工具经 UndoStore.track 落变更记录；`def.track === false` 的撤销执行器跳过）+ `toolChangeMeta` / `undoScopeOf`（调用域 → 撤销栈，gateway 未绑渠道拒绝）/ `PANEL_TOOL_CTX`（REST 入口身份）
- `src/mcp/handler.ts` — `/mcp` 无状态处理
- `src/mcp/rate-limit.ts` — gateway 写限流
- `src/agent/tool-schema.ts` — 注册表 → LLM 工具面（`AGENT_EXCLUDED_TOOLS` 显式排除名单，与 write-path-inventory 测试互锁）
- `src/agent/loop.ts` — **agent loop**（`runAgentTurn` / `chatBlockedReason` / `AGENT_MAX_STEPS=8`）：读历史 → `[system, ...history, user]` → 循环 `deps.llm.router.completeChat`（可注入假 LLM）→ tool_calls 逐个经 `runToolTracked` 执行、结果或错误文本回填 → 无 tool_calls 即终答；往来全部落 ChatStore。面板（admin 单会话）与 QQ 渠道（gateway、scope=渠道栈）共用同一 loop，`AgentOptions` 传 scope/role/actor/systemPrompt 泛化。**不按 mode 硬拦写工具**（写纪律在系统提示层）
- `src/agent/system-prompt.ts` — 系统提示 + 写操作模式（`settings.chat_write_mode`，缺省 `ask`=写前询问 / `auto`）：`buildSystemPrompt`（面板）/ `buildQqbotSystemPrompt`（QQ 渠道变体）/ `getChatWriteMode` / `setChatWriteMode`（`set_chat_mode` 工具用它，且**不在 agent 工具面**）
- `src/agent/tool-view.ts` — 工具调用 → Agent 视图展示形状（`ToolCallView` `{id,name,title,target,ok,args,output}`；loop 实时回包与 `/api/chat/history` 回放共用的唯一信源；中文名复用 undo-view）
- `src/panel/server.ts` 的 `/api/chat/{history,reset,mode}` 与 `POST /api/chat` 是 WebUI Agent 的接线（chat dep 不注入则 404）；`POST /onebot` 是 NapCat 直连的事件入口（qqbot dep 存在才挂，不在 /api 下）
- `src/qqbot/` — **NapCat 直连（P3）**：onebot-event（事件解析/@识别）· settings（`qqbot_enabled` / `qq_channel_map` / `qqbot_trigger_prefix`）· trigger（触发纪律：斜杠命令确定性 + @/前缀进 LLM，私聊直通）· reply（回执裁剪 + /reset 附言）· bot（编排，不抛异常）· napcat-post（上报地址条目自管）。细节见 `docs/modules/qqbot.md`
- 细节见 `docs/modules/panel.md`、`docs/mcp.md`、`docs/plan/agent-access.md`

### 装配 / 工具 / 前端 / 脚本

- `src/index.ts` — 装配根 + CLI；三个 reconcile
- `src/tools/migrate-snapshot-paths.ts` — 一次性迁移 snapshots.path
- `src/tools/dump-demo-fixtures.ts` — demo 夹具导出（--force）
- `src/tools/mcp-token.ts` — MCP 令牌 CLI
- `webui/` — 前端唯一信源（含 demo/）；构建期内嵌
- `scripts/build-webui.mjs` — 内嵌 `webui/**` 与 defaults.json
- `scripts/webui-dev.mjs` — 开发静态服
- `scripts/mac-notify.swift` / `scripts/register-aumid.ps1` — macOS helper / Win32 AUMID
- `scripts/seed-timeline.mjs` — 时间表演示种子（手动跑）

## 开发约定

- **ESM + Node ≥ 22**：相对导入带 `.js` 后缀；不装 axios，用原生 `fetch` + `AbortSignal.timeout`
- **依赖方向**：`core` 不 import `sources`；`sources` / `analysis` / `notify` 互不 import；`mcp/*` 依赖 `panel` 的 `http-util` / `schedule` / `PanelDeps`（共享 API 层）；`webui` 只经 `/api/*`；`index.ts` 是唯一装配根
- **`settings` 表是运行时配置唯一信源**，`config.json` 只剩 `panel` 段自举；改动落 settings 后经热生效回调（`onChanged` / `onProvidersChanged` / `onCookiesSaved` / `rebuildNotifiers` / `reconcileRuntime` / `reconcileListen`）生效，绝不要求手改配置文件
- 配置错误**启动即失败**并指明字段；拉取失败**绝不能当成下播**（保留旧状态，什么都不做）
- **不写外部平台**（不发弹幕、不点赞）；本地配置写是正常能力，由面板 / MCP（gateway 受限）受控进行
- LLM 调用一律走 `analysis/queue`，禁止在轮询循环里直接调
- B站/微博外部接口已知坑（UA、Referer、轮播、dm 指纹、扫码等）见 `docs/boundaries.md` 第 5 节，改 source 前先查
- **UI 只在 `webui/` 里改**：日常 `npm run webui:dev`（静态服 + `?demo=1` mock，刷新即生效）；改完 `npm run build && npm start` 接线后端。运行时页面来源 = 构建期内嵌内存快照，**绝不读磁盘**；改 `/api/*` 须同步改 `webui/demo/mock-api.js`（与真实后端同构）
- **streamers.alias 正规化为「简称」**：默认一律用原名 uname；简称仅在空间受限处优先（规则行主播标签、时间表横条）

## 命令

```bash
npm run dev          # tsx watch 开发
npm run build        # tsc → dist/（prebuild 先内嵌 webui）
npm run typecheck    # tsc --noEmit
npm run webui:dev    # 静态服 webui/（改 UI 零重启，浏览器开 ?demo=1 看 mock 数据）
npm test             # node --test（各 *.test.ts）
npm run probe        # 只查一次开播状态，验证接口通不通
npm run probe-llm    # 列 LLM provider 状态 + text 路由 ping
npm run probe-x      # X/推特链路探测：代理 → Nitter 实例（RSS）→ 免登录回退（--x-screen 换账号）
npm run test-notify  # 假事件走完整推送链路，验证 NapCat/Toast 配置
npm run napcat-setup # 一次性创建 NapCat 最高权限计划任务（弹一次 UAC）并开启自动拉起
npm run migrate:snapshots-path # 一次性迁移 snapshots.path（换机后跑一次；幂等）
npm run mcp-token    # MCP 令牌管理：list / add <名字> <admin|gateway> / remove <名字>
npm run demo:fixtures # 真实库 → webui/demo/fixtures.json（已存在须 --force）
```

手动验证：`--dry-run`（只打日志不真发）、`--test-notify`、`--force-uid <uid>`（监听正在直播的房间，立刻触发真实全链路）。

## 实现现状

- **已落地主干**：开播通知（NapCat/Toast 已实测）、规模化 + 内容判定（名单迁库 / 扫码登录 / 关注同步 / 动态 / 微博 / LLM 分类管线 / 推送规则 v2）、时间轴统计、控制面板 v1+v2、MCP v1、NapCat 双平台托管
- **X/推特（独立于 B站的一条路径）**：**P0–P3 全部落地**（隧道 fetch / X 配置 / 连通性探测 / `/api/x*` / 图文分页 `#view-x`（X + 微博，账号卡片墙：身份段 + 选用图文规则 + 帖子段）/ 免登录源 Nitter RSS + 回退 / `x_accounts` 独立名单 / 监听开关 `listen_twitter` / `post_rules` 图文帖规则与 `feed_post` 推送分支（X 图经代理本地化后由 onebot 内嵌 base64 交 NapCat）/ 规则级 LLM 判定与翻译（失败回退机械筛选）/ MCP 工具 / `npm run probe-x`）。计划见 `docs/plan/twitter-source.md`，调研见 `docs/research/twitter.md`
- **微博图文来源（与 X 同构的第二条图文链路）**：已落地（`weibo_accounts` 独立名单 / `WeiboFeedSource` 轮独立名单 + 运行状态快照 + 头像本地化 / `feed_post` 双平台推送分支（微博图直连下载）/ `post_rules.platform` 平台分流 / 图文页单墙混排 + 平台筛选胶囊 / MCP 三工具 / 老库一次性数据搬家）。计划与实现记录见 `docs/plan/weibo-source.md`
- **B站动态图文来源 + 图文规则重构**：已落地（`bili_accounts` 独立名单〔动态型 UP 主不开播也能监听〕/ `DynamicSource` 轮询对象 = 监听主播 ∪（图文开关开着时的）动态名单，`feed_post` 只对名单账号发，名单账号头像·uname 回写 / `feed_post` 三平台推送分支 / 图文规则改为**平台无关通用规则 + 账号侧 `rule_ids` 选用**〔post_rules 去 account_ids 与 platform 两个维度〕/ 图文页「图文规则」卡 + B站账号卡与平台筛选胶囊 / MCP 三工具 / 旧规则 scope 一次性迁移到账号）。**2026-09-21 修订**：监听开关拆分（监听主播动态归档随登录常开，`listen_dynamic` 只管动态账号名单）、开播动态（LIVE_RCMD）彻底舍弃（不入库 + 一次性清旧行）、FORWARD 在 source 归一成 `retweet`、三平台账号的 ID 与平台昵称锁定为平台事实（输入面不可改，X 昵称经 verify 种入 / 抓取回写）。计划与实现记录见 `docs/plan/bili-dynamic-posts.md`
- **图文补推语义（三平台统一，2026-09-21 拍板）**：主动关闭（账号停用→重新启用 / 图文开关手动关→重开）恢复轮**一律静默不补推**（账号表 `silent_next` 恢复位）；服务未运行期间（重启/崩溃/登录态丢失）与添加账号之前默认不推，推送设置开 `backlog_push_enabled`（「补推未运行期间的图文」）后按**时间窗（默认 6h）+ 每账号条数上限（默认 3、取最新）**双重封顶补推；三种轮次归档永不受影响，正常轮新帖全推。语义唯一权威在 `src/core/backlog.ts`
- **能力面 P0 地基（全部落地）**：后端（切片 A–C）=`runTool` 共享执行器 + 写快照与撤销（`UndoStore` 差分前像 / 逐行比对中止 / 每渠道一栈 / 四张混合表按列过滤——`streamers` + 三张图文账号名单）+ 撤销执行器（`PanelDeps.undoLast` + `undoEffects` 热生效映射 + `POST /api/undo` / `GET /api/undo/history` + 内部工具 `undo_last_change`）+ 面板配置写 REST 全部收敛到注册表 + 鉴权口径启动日志；面板侧（P0b）= 设置页底部「变更历史」卡（`webui/js/undo.js`，栈顶撤销 + 冲突标注）。切片记录见 `docs/plan/agent-access.md`
- **能力面 P1–P3（QQ 入口已全落地）**：P1 = WebUI Agent（`src/agent/loop.ts` + 第五个视图「Agent」聊天面板 + 写模式开关）；P2 = MaiBot 插件（独立目录 `d:\Git\dd-claw-maibot-plugin`，3 个动作 + 渠道绑定令牌，本机 MaiBot 1.1.4 + SDK 2.7.1 实测 146 用例全过）；P3 = NapCat 直连（`src/qqbot/`：OneBot 上报接收 + 触发纪律 + 按渠道限流 + 回执裁剪）。共用前提 = **gateway 渠道隔离收敛**（`channelId` 移出 schema 改 scope 注入、读侧服务端裁剪、copy-on-write 拆分、删除渠道归属校验、限流按渠道分桶、群/私聊一视同仁）。切片记录见 `docs/plan/agent-access.md`
- **统一计划 P2（附录 A.1–A.5，2026-10-10 拍板）已落地**：categories 扩展（`applies_to`/`post_types`/`require_quote`/`require_media` + 条件算子 postType/quote/media）/ push_rules 统一（`subject_kind`/`scope`〔uids 更名，空=全部生效〕/`llm_translate`，表重建）/ 三账号表 `rule_ids` 删列 / post_rules 一次性搬家成「分类+规则」后 DROP（无账号选用的规则 enabled=0 行为保持闸；迁移测试见 `src/core/db.test.ts`）/ 判定分类制（feed_post 与 live 同走判决链，verdicts 落真实 categoryId，post 侧 LLM 判否落 pass=0）/ `matchRules` 两形态统一命中 / 翻译独立成规则附加动作 / **推送等不等判定规则级化**（仅覆盖本内容的分类规则让推送等 LLM；任意内容规则即时推，不产生双推）/ post_rule 工具与 `/api/post-rules*` 端点退役、账号工具 ruleIds 入参退役。webui 最小可用适配（分类弹窗按 applies_to 渲染、规则弹窗带 subject_kind、账号卡勾选改写规则 scope、demo mock 同构）；体验精修在 P3。行为变化仅限附录 A.4 白名单
- **目标态待做**：LLM 分类真机验收与调优、分析触发（任意时机进 LLM）、M3 预告（schedule-extract + schedules + 预告条 / 到点推）、可选推送时机、**决策模型通道（类 Jev / System One，`/v1/systemone` 为主端点、识图为默认要求，仅覆盖枚举类判断；调研见 `docs/research/decision-models.md`）**、WebUI Agent / QQ 入口真机验收（P1 验收口径的实操项）、弹幕抓取
- **已放弃 / 不采用**：见 `docs/design.md` §11（PushDirective、preference 护栏、ntfy、signals 表等）
- 逐项明细与未建占位见 `docs/status.md` 

## 文档索引

- `docs/design.md` — 总体设计：两条正交轴（数据流 / 能力面）、数据结构、里程碑、待定项、**§11 已放弃清单**
- `docs/status.md` — 实现现状：里程碑 + 模块两视图、未实现清单
- `docs/boundaries.md` — 能力边界：匿名可得 / 需凭据 / 做不到，已知踩坑清单
- `docs/modules/` — 模块实现笔记：core / sources / analysis / notify / panel（逐文件职责与「改前必知」）
- `docs/mcp.md` — MCP 接口：令牌、角色权限、Host 配置、安全模型与 v2 预留（MaiBot 不直连）
- `docs/plan/agent-access.md` — 多前端接入统一计划：一个能力面 N 种接线 + 信任模型矩阵 + 分期 **P0-P3** + 能力层调用域（scope，**已定令牌绑定渠道**）+ 拍板记录
- `docs/plan/twitter-source.md` — X/推特图文来源计划：独立分页 + 独立账号名单 + 图文帖规则，P0–P3 全部落地
- `docs/plan/weibo-source.md` — 微博图文来源计划：把微博从「主播附属数据源」升级为独立来源（独立名单 / platform 分流 / 单墙混排），已落地
- `docs/plan/bili-dynamic-posts.md` — B站动态图文来源 + 图文规则「规则卡 + 每账号选用」重构，已落地
- `docs/plan/unify-classify-push.md` — 直播/图文「分类 + 推送」统一总计划（产品模型 + 底层抽象 + 分期 P0–P4 + 决策模型通道预留；**附录 A = P2 逐条执行规格，已落地**），**dev 分支承载**
- `docs/research/` — 分模块调研归档（live-status、danmaku、feeds、**twitter**、llm、notify、media-capture、auth-cookie、ts-stack、**decision-models**）
