# 核心、配置与装配（src/core/ + src/config/ + src/index.ts + src/tools/）

轴 A 的中间层：`core` 定义领域类型、信号总线、状态机、归档与信号编排；`index.ts` 是唯一装配根（只 new 和接线，不含业务逻辑）。抓取层见 [sources.md](sources.md)，分析层见 [analysis.md](analysis.md)，推送层见 [notify.md](notify.md)。实现现状见 [../status.md](../status.md)。

## 改前必知

- **import 方向**：`core` 不得 import 任何 `sources/` 下的类型（source 也不知道有 LLM，解耦点 1）。
- **`core/pipeline.ts` 是信号编排唯一装配点**，不要把编排散到 source 或 index。
- **运行时参数（间隔/阈值/开关）一律以 settings 表为唯一信源**，`config.json` 只剩 `panel` 段自举；生效值 = `withRuntimeConfig(默认值, settings)`。
- **schema 迁移只有两种手段**：在线补列 `ensureColumn`（旧库缺列自动补齐）+ 一次性 CLI（如 `migrate:snapshots-path`）。**运行时 Db 构造绝不悄悄改库。**

## core — 类型、总线、状态

### `types.ts`
`LiveStatus`（平台无关；bili `RoomStatus` 是其扩展，含可选 face）/ `Signal`（含可选 `previousTitle`/`previousAreaName`，title_change 专用）/ `LiveEvent`（含可选 face、`classifications: Classification[]`）/ `PushMessage`（含可选 `icon` 头像、`attribution` 小灰字行、`channels` 渠道 id 数组、`ref` 溯源）、`toLiveEvent()`；`STREAK_QQ_ALERT_AFTER_SEC = 600`（连续失败持续告警阈值，source 与 pipeline 共享）。

### `bus.ts`
类型化信号总线：emit 不 await，单 handler 异常记日志不影响其他。

### `state.ts`
纯函数状态机 `diffRoom(prev, curr)` → Signal；`(room_id, live_time)` 是一场直播的身份；轮播（`live_status=2`）视为未开播；拉取失败不产 Signal；无 prev 也如实产 `live_start`（抑制政策在 pipeline）。**title_change = 标题/分区内容变更**（title / areaName / parentAreaName 任一变化、同一 liveTime 内，同时变只产一条；带 `previousTitle`，分区变带 `previousAreaName`）。

### `scheduler.ts`
`PeriodicTask`：通用周期任务器（间隔 + 抖动 + 自调度不重叠），不含业务逻辑。

### `pipeline.ts` — 信号编排唯一装配点
bus 信号按序走：**归档分派** → **冷启动抑制** → **分析触发 / 队列** → **机械去重（`rules.decide`）** → **推送规则匹配（`matcher`）** → **推送**。

- **归档分派**（位于抑制闸门之前，冷启动/静音场次照样留痕；在信号同步前缀按序执行）：`live_start → recordSession`（含首段）/ `live_end → endSession` / `title_change → rotateSegment`。
- **分析**：`RulesClassifier` 内容分类，**仅 `live_start` 调用**（live_end / title_change 不烧 LLM）；判定入 verdicts 表并填 `LiveEvent.classifications`。
- **推送规则 v2 匹配**（`matcher`）：categoryId 可空 = 任意开播、uids 空 = 全部主播；**全部命中规则独立生效**——渠道 = 命中规则 channels 并集去重、推送词 = sort 序首个非空覆盖；无命中规则 = 不推送。
- **冷启动推送两开关**（`notify_on_first_run` / `notify_on_new_subscription`）直读 settings、热生效；信号处理并发 4。
- **health_alert → `alertAll`**：payload 带 `message` 时用自定义文案；本机告警只派发到实现 `alert()` 的通道（当前仅 toast）。**QQ 告警政策**：`alertKind==='login_drop'`（运行中登录掉线）立即报、`durationAlert===true`（连续失败满 10 分钟 source 再发的一次）才报，目标 = settings `napcat_alert_qq`（留空 = 全不发），经 `onebot.send` 私聊点对点发出，其余告警不发 QQ。

### `db.ts` — better-sqlite3 十六表
- `live_sessions`：时间轴列 `last_seen`（在播每轮刷新 = 近似下播锚点，崩溃恢复也有近似终点）/ `keyframe` / `cover`；方法 `recordSession`（扩展写快照 + 插首段）/ `touchLiveSessions` / `endSession(roomId, endTs)`（按房间 first_seen 最新一场关闭；liveTime 在 live_end 信号里不可靠）/ `rotateSegment` / `listTimeline`（时间轴三表归并）。`endTs` 语义：`last_seen` 鲜度窗口（10min）内 = 在播 null，超时/无打点 = `last_seen ?? first_seen`（崩溃错过 live_end 的兜底；legacy 场零长不画）。
- `live_segments`：一场按内容变更切分的连续时间段，idx `(room_id, live_time)`。
- `notify_log` / `room_state`：`room_state` 含展示列 `area_name/parent_area_name/keyframe/cover/online/last_live_at`（`ensureColumn` 自动补列）；`countLiveRooms()` / `listRoomStatesFull()` 供面板。
- `streamers`：监听名单（事实来源，含 face）；`watch` 仍是名单机制（watch=0 退回关注列表候选、主列表不显示）；`analyze`/`notify` 为**遗留列**（v2 起面板三开关删除，classifier/pipeline 不再消费）；含 `weibo_nick`；`listWatchedUids()` 只回 watch=1 且**纯数字** uid（批量接口遇非数字 uid 会 65530 route_exception）。
- `follows`：关注候选池，含 face。
- `push_channels`：推送渠道（事实来源，面板管理）；含 `sort` 展示顺序（拖拽排序）。
- `push_rules` v2：全局规则——`category_id` 可空 = 任意开播、`uids` JSON 数组空 = 全部主播（含未来新增）、`channels` 渠道 id 数组、`message_template` 可空 = 内置默认模板；`sort` 全局 = 匹配优先级；空名补「规则 N」；`created_by` 可空 = 面板/人工、`'mcp'` = MCP 群自助（权限隔离用）。
- `categories`：分类规则——`llm_prompt` 空 = 纯确定性；keywords/areas JSON 数组 + `cond_mode` and/or、enabled/sort；空名补「分类 N」；删除前 `disablePushRulesByCategory` 级联停用引用它的推送规则。
- `verdicts`：每场分类判定——`UNIQUE(room_id, live_time, category_id)` 去重 `INSERT OR IGNORE`；`category_name` 冗余、`source` llm/rule、`confidence`（rule 路径 NULL）、`evidence` 命中说明。
- `settings`：kv（`push_enabled` 等总开关、`llm_providers`/`llm_key:*`、`napcat_*`、`mcp_tokens`…）。
- `posts`：动态/微博/推文归档，`UNIQUE(platform, item_id)` 去重、raw 整 item 全留；`insertPosts`（返回新行下标）/ `listRecentPosts`（分组取近 N）/ `listRecentPostsMixed`（**主播卡第三栏**：B站动态按 uid + 关联微博账号的微博按 `weibo_accounts.bili_uid` 反查，混排后各截 perUid）/ `searchPosts`（供 MCP 与账号卡帖子段）。`uid` 语义：`bili_dynamic` = B站 uid、`weibo` = 微博账号 uid、`twitter` = screen name（**帖子归属 = 被抓账号自身**，不跨平台借 uid）。
- `x_accounts` / `weibo_accounts` / `bili_accounts`：图文来源的独立账号名单（独立于 streamers/follows）；x/weibo 的 `bili_uid` 只是可选关联（展示、文案、第三栏混排），bili_accounts 自身即 B站 uid 无需关联列；`enabled` 启停、`rule_ids` 选用图文规则（见 `post_rules` 行）、`last_*` 增量游标与抓取健康（bili_accounts 无游标，去重靠 posts UNIQUE）、`avatar` 本地头像文件名。CRUD 在 `Db`；微博侧另有 `unlinkWeiboAccountsFromBili`（主播详情清空昵称时解关联、保留行）。
- `post_rules`：图文帖规则（与 `push_rules` 平行）；**平台无关的通用规则——只定义筛选+渠道+推送词，生效范围在账号侧 `rule_ids`**（`account_ids` 列保留停用；`platform` 列保留停用，quote/翻译差异按帖子平台运行时生效：quote 仅 X 帖可识别、翻译仅 X 帖附加）；`filters` JSON（original/retweet 二选一、media、keywords、quote）；`llm_judge`/`judge_prompt`/`llm_translate` 规则级开关；`sort` 全局 = 匹配优先级。
- **一次性数据搬家** `migrateWeiboAccounts`（settings 闸门 `migrated_weibo_accounts_v1`）：① `streamers.weibo_uid` → `weibo_accounts`（`enabled = watch`）；② 历史 `platform='weibo'` 帖的 `uid` 从 B站 uid 改写成微博 uid（面板第三栏改由关联反查，对用户透明）。幂等靠闸门（改写后条件本身也不再成立）。`migratePostRuleScopes`（闸门 `migrated_post_rule_scopes_v1`）：旧 post_rules.account_ids 展开写入账号 rule_ids（空 = 该平台全部现有账号）。
- `snapshots`：关键帧缓存 room_id/live_time/ts/path/bytes，idx `(room_id, live_time, ts)`；`insertSnapshot`、`nearestSnapshot(roomId, liveTime, ts)` 按 `ABS(ts-?)` 取最近一帧（`/api/snapshot` 用）。**path 语义 = 相对 keyframe 目录、分隔符恒为正斜杠**（`<roomId>/<liveTime>/<ts>.ext`）——落库处（keyframe.ts）保证、绝不用 `join()`（Windows 反斜杠换机后全 404），读端读库时归一化反斜杠兜底，存量用 `migrate:snapshots-path` 一次性收敛。
- **目标**：`schedules` 表（预告时间表）。`signals` 表已放弃（见 `../design.md` §11）。

### `streamers.ts`
streamers / follows 两表的行类型与「行 ↔ 对象」映射（JSON 字段序列化集中在此）；监听名单 CRUD 是 `Db` 的方法。

### `push.ts`
push_channels / categories / push_rules / verdicts 四表的行类型与「行 ↔ 对象」映射（JSON 数组字段序列化集中在此）；`isPushEnabled` / `setPushEnabled` 推送总开关；`PushRule` 含 `createdBy`。CRUD 是 `Db` 的方法。

### `posts.ts`
posts 表的行类型与「行 ↔ 对象」映射（pics JSON 序列化集中在此）；归档/查询是 `Db` 的方法。

### `listen.ts`
监听功能开关（面板「监听」卡）：settings 存 `listen_<feature>`——缺省 = auto（没登录默认关、登录成功自动开）、`'1'`/`'0'` = 手动（手动设置为准）。`isListenEnabled`（UI 有效态）、`shouldRunListen`（源是否运行：cookie 存在 &&（手动开 || auto），**无 config 闸门**，面板开关唯一信源；auto 下登录过期不自动停——源自己心跳跳过并告警、保留源以感知恢复）、`setListen`（与 auto 默认一致则回 auto〔删 key 不留空串〕）。

### `runtime-config.ts`
运行时参数（**settings 表唯一信源**，面板按模块分散管理：监听卡「抓取设置」/ LLM 卡「高级」/ 推送渠道卡「推送设置」，`/api/advanced` 统一读写）：`RuntimeConfig` 十三项（poll 间隔/抖动、告警阈值、三源抓取间隔、LLM 超时/熔断/冷却、冷启动推送两开关、关键帧缓存开关 + 间隔〔60~3600s〕）；`NUM_SPECS`/`BOOL_SPECS` 规格表；`getRuntimeConfig`（非法/越界回落默认）/ `saveRuntimeConfig` / `withRuntimeConfig` / `isNotifyOnFirstRun` / `isNotifyOnNewSubscription`（pipeline 直读、热生效）。

### `onboarding.ts`
发布后首启默认值种入 `seedOnboardingDefaults(db)`（index.ts 装配处在 Db 创建后调用）——settings `onboarding_seeded` **一次性闸门**（用户清空默认值后不复活）；各项独立判空：push_channels 空 → 种「系统通知」toast 渠道、settings `llm_providers` 未设 → 种默认 provider 名单（只种名单不种 key）、categories 空 → 种默认分类、push_rules 空 → 种默认规则（分类按名映射回新 id、渠道重映射、uids 恒空）。

### `onboarding-defaults.gen.ts`
首启默认值数据（**构建期生成物，gitignore 防漂移，勿手改**）：由 `scripts/build-webui.mjs` 从 `webui/demo/defaults.json` 生成——defaults.json 是 LLM provider / 分类 / 推送规则的**唯一手工信源**（demo mock 与首启默认值共用同一份展示案例）。

### `concurrency.ts`
`mapLimit` 有界并发工具。

## config — 配置

- `index.ts`：读 `.env` + `config.json`（**全程可选**：文件不存在 = 全默认值启动；JSONC 注释、BOM 剥离，zod 启动即校验）。config.json 只有 `panel` 段被读取（面板自举），其余顶层字段一律无视（zod 剥离）；AppConfig 运行参数全部是代码默认值，生效值 = settings 叠加。
- `schema.ts`：`configSchema` 只校验 `panel` 段（enabled/port，默认 8787 只绑 127.0.0.1）；`llmProviderSchema` 供面板 provider CRUD；`AppConfig` 手写字段接口（含 `keyframe` 底形）+ `defaultAppConfig()`。秘密只在 `.env`（DB_PATH/LOG_LEVEL）/ `cookies.json` / `weibo-cookies.json`；LLM key 在 settings（面板明文填写）。
- `logger.ts`：极简结构化日志。

## 装配根 `src/index.ts`

CLI：`--dry-run` / `--test-notify` / `--probe` / `--probe-llm` / `--force-uid` / `--napcat-setup`（一次性创建 NapCat 最高权限计划任务，弹一次 UAC，做完即退出）。

- onebot 端点只读跟随 NapCat 自己的 onebot11 配置（dd-claw 专属条目；发现失败 = **降级不装配 QQ 通道**，log 说明、不阻塞启动——没配 QQ 是正常状态）。
- `reconcileNapcat` 统一看门狗启停（生效配置 enabled && onebot 已装配，双平台；`napcatRelaunchDriver` 按 platform 装配拉起能力、`autoRestart` 每 tick 读 settings 热生效；面板保存后重装配 + 立即 tick，dir/uin 热生效）。装配无通道级开关，通道启停走 `push_channels`。
- **`eff = withRuntimeConfig(defaultAppConfig, settings)` 生效配置**：sources 的 `ctx.config` / llm router 重建全消费它；`reconcileRuntime`（`/api/advanced` 保存回调）间隔/阈值变化重启对应源、LLM 超时熔断变化重建 router。
- follows 有 cookie 即跑（无开关）；dynamic/weibo 由 `reconcileListen` 按面板监听开关 + cookie 启停；`panel.enabled` 时起控制面板。
- follows / dynamic / weibo 三 source 单独持有（有各自 cookie 才创建，扫码登录后 `onCookiesSaved` 热重启；shutdown 停最新实例）。live-status source 单独持有 `liveSrc`（轮询参数热更新时 stop + 新建 + start，restore 从库恢复状态不丢轨迹）；`KeyframeCache` 总是创建（dir = `data/cache/keyframes/`），开关/间隔走 `configure` 热更新、实例跨 liveSrc 重启复用；`snapshots: {dir}` 注入面板 `/api/snapshot`。`onLoginState` → 面板平台状态。

## src/tools — 一次性脚本

- `migrate-snapshot-paths.ts`：`npm run migrate:snapshots-path`，把 `snapshots.path` 旧绝对/反斜杠相对路径收敛为正斜杠相对 keyframe 目录（幂等可重复，换机后各跑一次）。**只作为 CLI 直接运行时执行 main**（入口守卫），测试导入导出的 `migrateSnapshotPaths(db)` 不触发。
- `dump-demo-fixtures.ts`：`npm run demo:fixtures`，读真实库 → 写 `webui/demo/fixtures.json`（**随仓库发布**）。只导三个数据型卡片的固定名单节选：demo 主播 12 位 enrich（含 live/posts）+ 关注 18 位 + 近 14 天时间表（北京 06:00 日界，随带 `meta.exportedAt` 冻结点）；**其余卡片一律不导**（LLM/分类/推送规则 = defaults.json 手工案例；渠道/NapCat/监听态 = mock-data.js 手写）；导出内容全是公开数据、cookie 绝不读取；头像/关键帧本地化随仓库发布。**防覆盖**：已存在须 `--force`。形状与 `GET /api/streamers`（enrich 去 rules）/ `GET /api/schedule` entry 同构。
- `mcp-token.ts`：见 [../mcp.md](../mcp.md) 实现文件节。