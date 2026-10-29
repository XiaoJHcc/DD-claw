# core — 领域类型 / 状态机 / 归档 / 信号编排

轴 A 的中间层，同时是**运行时配置与历史归档的唯一落点**。抓取见 [../sources/AGENTS.md](../sources/AGENTS.md)，判定见 [../analysis/AGENTS.md](../analysis/AGENTS.md)，推送见 [../notify/AGENTS.md](../notify/AGENTS.md)。专题机制、数据语义与排障见 [docs/modules/core.md](../../docs/modules/core.md)。

## 长期不变量

- **归档先于抑制**：`pipeline.ts` 的归档分派（`recordSession` / `endSession` / `rotateSegment`）排在冷启动抑制与推送总开关之前，且在信号处理的同步前缀按序执行——冷启动、静音、关推送的场次照样留痕；`live_end` 的 `endSession` 必须先于配对 `live_start` 的 `recordSession`。
- **`settings` 是运行时配置唯一信源**：`config.json` 只剩 `panel` 段自举，其余顶层字段一律不读；生效值 = `withRuntimeConfig(defaultAppConfig(), getRuntimeConfig(db))`。新参数只加进 `NUM_SPECS` / `BOOL_SPECS` 并在 `withRuntimeConfig` 里映射，消费方不得直读 config。
- **schema 演进必须显式且保数据**：`Db` 构造期执行的就是既有的一次性迁移（在线补列 `ensureColumn` + 带 settings 闸门的数据搬家；改列 / 删列走「建新表 → 拷全列 → DROP → RENAME」），这条约束**不禁止迁移**，它禁止的是**无保护的破坏性改库**——任何删表、删列、重建都要有一次性闸门（可重复执行）、按前像保数据，并在 `db.test.ts` 留迁移用例。搬家顺序有依赖（如 `migratePushRuleScopeShape` 必须早于 `migratePostRulesToCategories`），改动前读 [docs/modules/core.md](../../docs/modules/core.md)。
- **`verdicts` / `primary_verdicts` 身份键** = `(subject_type, subject_id)`（live=`room_id:live_time` / post=`platform:item_id`）；`category_id`、`rule_id` 的 **0 是「不适用」哨兵，绝不用 NULL**（原因见 [docs/modules/core.md](../../docs/modules/core.md)）。`verdicts` 唯一键含 `source`（同分类的确定性结论与模型结论各留一行），`effective` 标出生效行（每个主体每个分类恰一行）；`primary_verdicts` 唯一键含 `source`，`category_id=0` = 「其他」。消费方只读 `effective=1`。
- **一场直播会被多次判定，当前结论跟最新一轮走**：五个分类时机（开播 / 开播延迟后 / 直播中定时 / 标题分区变更 / 变更延迟后）共用一条判定入口，写入用 `replaceSubjectVerdicts`（事务内先删后插，**不用 INSERT OR IGNORE 留第一次**）；每轮结果另记 `live_classification_runs`（`trigger_kind` + 判定**完成**时间 + 生效且属于的分类 + 生效主分类，空结果也记，表示「从该时刻起未分类」）。历史只增不改，时间表按轮次回看；旧场次没有历史时前端回退 `verdicts` / `primary`。
- **一场直播的推送可以发生多次，但只在分类真正变化时**：开播初判走 `OncePerSessionRule`（每场一次）；重分时机不经该规则，只有「生效且属于」的 categoryId 集合相对上一轮改变时才重新匹配并发送（分类失败不算「变成空」）。冷启动抑制与推送总开关只抑制发送，**不阻止判定与历史归档**。
- **每时机选哪些判定档是运行参数**（`live_classify_<时机>_<档>`）：pipeline 每次判定经 `getLiveJudgeSelection` 直读，三档全关 = 该时机不判定（不写历史、不动已有判定）。延迟/定时/LLM 冷却三类时间口径经 `getLiveClassifyTiming` 直读；装配根只在口径真的变化时按变化项重排计时器（`LiveClassifyTriggers.reconfigure({ delay, periodic })`）。
- **`snapshots.path` 恒为正斜杠相对路径**（相对 keyframe 目录）：落库处不用 `path.join`，读端读库时归一化反斜杠兜底；Windows 反斜杠路径换机后全 404。
- **撤销忽略列**（`undo.ts` `DEFAULT_IGNORE_COLUMNS`）= 「谁写这一列」的代码事实，差分 / 比对 / 还原三处共用同一过滤。四张「配置 + 归档」混合表（`streamers` + `x_accounts` / `weibo_accounts` / `bili_accounts`）的轮询列不得被撤销回滚；归档表（`room_state` / `posts` / `verdicts` / `primary_verdicts` / `live_segments`）不进快照。
- **撤销逐行冲突中止**：撤销前逐行比对后像，任一行已被其他入口改动即整体 `reason='conflict'`，不做部分还原；每渠道一栈（`admin` / `ch:ID`），`undo_last_change` 是唯一 `track: false` 的写工具。
- **`csv.ts` 是逗号分隔列表的唯一解析口径**（关键词 / 分区 / 实例 / key 列表），中英文逗号都认；别处不得再手写 `split(',')`。
- **`backlog.ts` 是图文补推语义的唯一权威**（`resume` / `gap` / `normal` 三态 + 时间窗与条数双封顶），三个图文源只调用不重定义。
- **平台事实与用户配置分开**：图文账号的平台身份、昵称、头像、游标由解析 / 校验 / 抓取维护，不允许任意覆盖；微博新建时的昵称解析、X verify 种入属于合法初始化，更新时锁定。主播空值回填不覆盖已有事实，用户简称另存 `alias`。

## 文件地图

**类型 · 信号 · 基础件**
- `types.ts` — `LiveStatus` / `Signal`（含 `coldStart` 三态）/ `LiveEvent` / `PushMessage` / `toLiveEvent`；`STREAK_QQ_ALERT_AFTER_SEC`。
- `bus.ts` — 类型化信号总线：emit 不 await，单 handler 异常隔离。
- `state.ts` — 纯函数状态机 `diffRoom`：`(room_id, live_time)` 是一场直播的身份，轮播视为未开播，拉取失败不产信号，标题/分区变更产一条 `title_change`。
- `scheduler.ts` — `PeriodicTask` 周期任务器（间隔 + 抖动 + 自调度不重叠），不含业务逻辑。
- `concurrency.ts` — `mapLimit` 有界并发。

**编排**
- `pipeline.ts` — **信号编排唯一装配点**：归档分派 → 冷启动抑制 → 判决 → 机械去重 → 规则匹配 → 推送 → 审计落库；判决按五个分类时机分派（`start` 走 `OncePerSessionRule`，其余四个重分时机只在分类集合变化时重推），等待策略按规则级判据。`feed_post` 是与之平行的图文分支（三平台同路）。

**持久化与仓储**（`db.ts` 建表 + CRUD，其余文件只放行类型 / 映射）
- `db.ts` — SQLite 表群与仓储（会话 / 时间轴 / 状态 / 名单 / 渠道 / 分类 / 规则 / 判定 / 分类时机历史 / 内容审计 / 帖子 / 关键帧 / 设置），`raw` 只读句柄与 `transaction` 包装，一次性迁移。
- `streamers.ts` — `streamers` / `follows` 行类型与映射。
- `push.ts` — 渠道 / 分类 / 推送规则 / 判定（`verdicts`）与主分类（`primary_verdicts`）行类型与映射；分类的判定模式（`judge_mode` simple / precise）与精确条件（`judge_conditions`，正负向 + 稳定 id + 停用态）及 `hasJudgeBasis` / `preciseConditions` 口径函数——两套判定数据**双份保留**，切模式不清空对方；`SubjectKind` / `postSubjectRef` / `liveVerdictSubjectId` / `postVerdictSubjectId`；推送总开关；copy-on-write 拆渠道。
- `posts.ts` — `posts` 行类型与映射（pics JSON）。
- `x-accounts.ts` / `weibo-accounts.ts` / `bili-accounts.ts` — 三张图文账号名单的行类型、映射与标识归一化（含 `silent_next` / `fetch_fail_*`）。
- `content-audit.ts` — 判定与推送过程归档类型（标准与规则快照、逐来源结论 `effective`、精确模式逐条件概率 `conditionResults`、主分类结论、标通道的模型尝试、通道结果）。
- `chat-store.ts` — agent 会话存储（`chat_sessions` / `chat_messages`；会话键 = 来源渠道，与撤销栈同 scope）。

**配置 · 开关 · 撤销**
- `runtime-config.ts` — 运行时参数规格表与读写；`isRuntimeConfigKey` 是撤销热生效映射的键名单信源。直播分类时机（`getLiveJudgeSelection` / `getLiveClassifyTiming`）也在这里，判定与计时器按信号直读。
- `listen.ts` — `listen_<feature>` 三态开关（缺省 auto / 强制开 / 强制关），`shouldRunListen` 判源是否运行。
- `x-config.ts` — X 连接配置与探测状态快照（settings 唯一信源）。
- `onboarding.ts` — 首启默认值种入（一次性闸门 + 各项独立判空）。
- `onboarding-defaults.gen.ts` — 构建期生成物（勿手改，源在 `webui/demo/defaults.json`）。
- `undo.ts` — 写快照与撤销：`capture`（同步）/ `track`（异步串行）、忽略列、逐行冲突、每渠道一栈、模型 key 脱敏、`undoEffects` 纯分类。

**输入口径 · 出网 · 遗留**
- `csv.ts` — 逗号分隔列表的拆分与写库归一。
- `backlog.ts` — 图文补推三态与挑选（唯一权威）。
- `post-rules.ts` — 帖子侧平台语义（平台名、quote / 翻译门控）+ 旧 `post_rules.filters` 的迁移解析口径（`parseFilters` 仅供搬家使用）。
- `proxy.ts` — HTTP 代理 CONNECT 隧道（Node 22 原生 fetch 不认代理）；X 链路唯一出网通道，`TunnelError.stage` 区分代理责任与目标责任。
