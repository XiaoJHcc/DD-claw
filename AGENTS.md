# DD-claw

监听用户在面板选定的B站主播（关注列表同步作候选池，直播间 + B站动态 + 微博）→ 持续状态追踪 → LLM 分析（内容分类 / 预告时间表 / 偏好推送词）→ 按优先级路由推送（QQ 群 / 私聊 / 本机 Toast）。

**规模假设**：关注上百位、高峰 30+ 同时在播、信号是持续状态而非一次性事件、偏好用自然语言描述。这四条决定了架构，改代码前先读 `docs/design.md` 第 1、4 节。

## 架构：三段解耦

```
┌─ 1. 抓取  src/sources/   持续生产：原始数据入库归档 + 变更信号上总线
│           bili/live-status  批量轮询（50/片 POST，非逐个轮询）  [已实现]
│           bili/follows      关注列表同步（SESSDATA）           [已实现]
│           bili/danmaku      弹幕 WS 按需拉起                   [未实现]
│           bili/dynamic      空间动态（cookie）                 [已实现]
│           weibo/feed        微博时间线（cookie）               [已实现]
│           media/keyframe    画面采样                           [未实现]
│                            ↓
│   core/db  原始归档（signals/posts/snapshots/follows，供反复分析）
│   core/bus 变更信号（live_start / feed_post / …）
│                            ↓
├─ 2. 分析  src/analysis/  LLM 即任务：zod schema 进，JSON 出，中间可替换
│           triggers   触发策略（开播/新动态/预留：直播中抽查）  [未实现]
│           queue      分析队列：限流 + 优先级 + 结果缓存        [未实现]
│           tasks/     scene-classify / schedule-extract；matcher 确定性偏好匹配
│           context    按房间聚合多源数据                       [未实现]
│           providers  熔断 + 多 key 池 + 降级链                [未实现]
│           （当前仅 NoopAnalyzer 占位）
│                            ↓ 判定结果入库（verdicts/schedules）
├─ 护栏 src/rules/      确定性过滤，不经过 LLM：静音、静默时段、每场一次、冷却
│                            ↓
│              PushDirective { priority, targets[], message, image? }
│                            ↓
└─ 3. 推送  src/notify/    只执行：按 targets 路由 + 通道级规则（群×主播屏蔽、
            丢弃低优先级）+ 发送。通道实现 Notifier 即可增删：
            onebot(NapCat) [已实测] / toast [已实现] / ntfy [未实现]
```

**三个解耦点，改代码不要破坏：**

1. **Signal 总线**（抓取→分析）：source 不知道有 LLM
2. **任务化 LLM 接口**（分析内部）：schema 进 JSON 出，换模型只动 providers
3. **PushDirective**（分析→推送）：推送层不解释语义

**偏好归属（已决策）**：人类需求是唯一锚点信源——用户在控制面板直填**透明条件规则**（push_rules 表：关键词/分区条件 → 渠道 + 推送词覆盖；仅条件规则，默认推送是全局设置 settings.default_channels/default_template），matcher 确定性执行；不做 NL→结构化衍生编译，运行管线无人工环节，无 LLM 时不做任何模糊分类。rules 只做确定性护栏；notify 只做路由执行。LLM 不参与偏好解释，其可用性不影响偏好链路。

**高峰并发原则**：轮询循环只做「拉批量状态 + diff 产信号」两件便宜事；所有 LLM 调用进 analysis/queue，通知不等分析结果。

## 关键接口

| 接口 | 位置 | 约定 | 状态 |
|---|---|---|---|
| `Signal` / `LiveEvent` / `PushMessage` | `src/core/types.ts` | 抓取→分析的事件载荷；`verdict` 可为 null，下游必须能处理；notify 只认识 `PushMessage`；`PushMessage.channels`（渠道 id 字符串数组）存在时 dispatcher 按 push_channels 表路由，缺省 = 全通道旧行为 | ✅ |
| `Analyzer.analyze(ctx)` | `src/analysis/types.ts` | 返回 `SceneVerdict \| null` | ✅ 仅类型，将被任务化接口取代/包裹 |
| `LlmTask<I,O>` | `src/analysis/types.ts` | zod schema 进，JSON 出 | ✅ 类型占位 |
| `DecisionRule.decide(...)` | `src/rules/types.ts` | 去重/护栏属于这一层，不要塞到 Analyzer 之前 | ✅ M1 版 |
| `PushDirective` | 待定（rules 或 notify types） | 分析→推送的指令：优先级、目标、文案 | ⬜ 未实现 |
| `Notifier.send(msg)` | `src/notify/types.ts` | 载荷是 `PushMessage`（不认识 LiveEvent）；`capabilities` 声明能否带图；`alert()` 供健康告警 | ✅ |

## 文件清单

### core — 总线与状态（已实现）

| 文件 | 职责 |
|---|---|
| `src/core/types.ts` | `LiveStatus`（平台无关，bili `RoomStatus` 是其扩展，含可选 face 头像）/ `Signal` / `LiveEvent`（含可选 face）/ `PushMessage`（含可选 icon 头像、attribution 小灰字行），`toLiveEvent()`。core 不得 import 任何 sources/ 下的类型 |
| `src/core/bus.ts` | 类型化信号总线：emit 不 await，单 handler 异常记日志不影响其他 |
| `src/core/state.ts` | 纯函数状态机 `diffRoom(prev, curr)` → Signal；`(room_id, live_time)` 是一场直播的身份；轮播（`live_status=2`）视为未开播；拉取失败不产 Signal；无 prev 也如实产 live_start（抑制政策在 pipeline） |
| `src/core/scheduler.ts` | `PeriodicTask`：通用周期任务器（间隔+抖动+自调度不重叠），不含业务逻辑 |
| `src/core/pipeline.ts` | 信号编排唯一装配点：bus → 冷启动抑制 → silent 抑制（追踪照常） → 分析队列（Noop 恒 null，LLM 接入点保留） → 护栏 → 透明条件规则（**全部命中规则独立生效**：渠道 = 命中规则 channels 并集去重、推送词 = sort 序首个非空覆盖；均不命中走全局默认：settings.default_channels〔未设 = 全部启用渠道〕/default_template）→ 推送；信号处理并发 4；health_alert → alertAll（payload 带 `message` 时用自定义文案） |
| `src/core/db.ts` | better-sqlite3。已有九表：`live_sessions` / `notify_log` / `room_state`（已扩展展示列 area_name/parent_area_name/keyframe/cover/online/last_live_at，存库迁移自动补列；`countLiveRooms()` / `listRoomStatesFull()` 供面板）/ `streamers`（监听名单，事实来源，含 face；三开关 `watch`/`analyze`/`notify` 替代旧 `mode` 列——启动迁移：off→watch=0、silent→notify=0 后 DROP mode；另有 `weibo_nick` 列）/ `follows`（关注候选池，含 face）/ `push_channels`（推送渠道，事实来源；空表时 config 的 onebot targets + toast 种子导入，之后以表为准；含 `sort` 展示顺序列，面板拖拽排序）/ `push_rules`（透明条件规则；含 `name` 名称列〔存量空名迁移补「规则 <id>」〕+ `sort` 排序列〔同 uid 内 = 匹配优先级，面板拖拽排序〕；关键词/分区不填 = 任意匹配）/ `settings`（kv：default_template + default_channels 全局默认推送 + push_enabled 推送总开关）/ `posts`（动态/微博时间线归档，UNIQUE(platform,item_id) 去重，raw 整 item 全留；`insertPosts` 返回新行下标、`listRecentPosts` 分组取近 N 条供面板 enrich）。旧 `preference_clauses` 表已废弃：打开库时存在即 DROP。**待扩展**：`signals` / `snapshots` / `verdicts` / `schedules` |
| `src/core/streamers.ts` | streamers / follows 两表的行类型与「行 ↔ 对象」映射（JSON 字段序列化集中在此）；监听名单 CRUD 是 `Db` 的方法 |
| `src/core/push.ts` | push_channels / push_rules 两表的行类型与「行 ↔ 对象」映射（JSON 数组字段序列化集中在此；`isPushEnabled`/`setPushEnabled` 推送总开关）；CRUD 是 `Db` 的方法 |
| `src/core/posts.ts` | posts 表的行类型与「行 ↔ 对象」映射（pics JSON 序列化集中在此）；归档/查询是 `Db` 的方法 |
| `src/core/listen.ts` | 监听功能开关（面板「监听」卡）：动态/微博两个开关。settings 存 `listen_<feature>`：缺省=auto（没登录默认关、登录成功自动开）、'1'/'0'=手动（手动设置为准）；`isListenEnabled`（UI 有效态，auto 跟随登录态）、`shouldRunListen`（源是否运行：config 开 && cookie 存在 &&（手动开 || auto），auto 下登录过期不自动停——源自己心跳跳过并告警、保留源以感知恢复）、`setListen`（切换：与 auto 默认一致则回 auto〔删除 key，不留空串〕、否则落手动值） |
| `src/core/concurrency.ts` | `mapLimit` 有界并发工具 |

### sources — 抓取

| 文件 | 职责 | 状态 |
|---|---|---|
| `src/sources/types.ts` | `Source` / `SourceContext` 接口：只产 Signal + 归档，不含通知逻辑 | ✅ |
| `src/sources/bili/client.ts` | HTTP 层：强制注入 UA、超时重试、HTTP 错误与业务错误（`code != 0`）分层 | ✅ |
| `src/sources/bili/live-status.ts` | 批量 `get_status_info_by_uids`（POST，50/片）；缺 key = 未开播，不是失败 | ✅ |
| `src/sources/bili/live-status-source.ts` | 轮询 + diff + 批量落状态 + `coldStart` 标记 + 健康计数发 `health_alert` 信号；face / roomId 空值回填（已有值不覆盖） | ✅ |
| `src/sources/bili/types.ts` | 接口返回类型 | ✅ |
| `src/sources/bili/wbi.ts` | WBI 签名（仅弹幕 WS 前置；动态接口实测不需要，勿为此实现） | ⬜ |
| `src/sources/bili/auth.ts` | cookie 管理：`loadCookies`（cookies.json 整套字段，坏 JSON 启动即失败）/ `saveCookies`（扫码落盘，merge：新值覆盖、旧值兜底）/ `cookieHeader`（绝不进日志）/ `fetchSelf`（nav isLogin 心跳，-101 归一化为未登录） | ✅ |
| `src/sources/bili/qrcode.ts` | passport 扫码登录客户端：`generateQrcode` / `pollQrcode`（data.code 归一化 waiting/scanned/confirmed/expired，confirmed 从 Set-Cookie 提全套 cookie）；不走 biliRequest（要响应头） | ✅ 已实测（2026-08-03 真实扫码登录成功） |
| `src/sources/bili/followings.ts` | 分页拉 `x/relation/followings`（50/页，按 total 翻页，短页到底）；已实测 604 关注 13 页无需 WBI 签名 | ✅ 已实测 |
| `src/sources/bili/follows.ts` | `FollowsSource`：isLogin 心跳合并进同步周期（失效发一次 health_alert 并跳过，恢复复位；每轮 `onLoginState` 上报登录态供面板展示）→ 整轮成功才落库（单页失败整轮放弃，绝不清空）。关注**不自动入监听**：follows 表只是面板候选池，监听名单全由用户在面板管理；仅对已有 streamer 做空 face 回填 | ✅ 已实测 |
| `src/sources/bili/danmaku.ts` | 弹幕 WS，开播拉起、下播关闭；采样进分析队列 | ⬜ |
| `src/sources/bili/dynamic.ts` | `DynamicSource`：空间动态轮询（`feed/space`，全量 cookie + dm 三参 + space Referer，**无 WBI**；mapLimit(2) 逐 uid）→ posts 表归档（UNIQUE 去重）→ 新帖 emit `feed_post`（payload 带 post 摘要）；登录态心跳折进轮询周期（每轮 `fetchSelf`，失效发一次 health_alert 并跳过本轮、恢复复位；每轮 `onLoginState` 上报——follows.enabled=false 时这是 B站登录态唯一来源）；每 uid 首轮静默归档；拉取失败保留旧数据，单 uid 连续失败到阈值发一次 health_alert、恢复复位；无 cookie 不启动，随 follows 热重启。`parseDynamicItem`：LIVE_RCMD 二次解析 live_play_info / WORD / DRAW（opus pics、draw items）/ AV / FORWARD（拼「//转发自 @xx」摘要） | ✅ 已实测（2026-08-03：22 个 uid 全量归档，零 412） |
| `src/sources/bili/dm.ts` | dm 设备指纹参数（`dm_img_list` 高斯随机轨迹 + 两个静态 base64），算法出处 RSSHub `addDmVerifyInfo`；弹幕等风控接口复用 | ✅ |
| `src/sources/weibo/feed.ts` | `WeiboFeedSource`：微博时间线轮询（`ajax/statuses/mymblog`，桌面 UA + `Referer: /u/<uid>` + 全量 weibo cookie；对象 = watch=1 且 weiboUid 非空，mapLimit(2)）→ posts 表归档（`platform='weibo'`，posts.uid 存监听名单 uid 供第三栏混排，微博 uid 只用于拉取与拼 url）→ 新帖 emit `feed_post`。登录态心跳折进同步周期（`fetchWeiboSelf` 失效发一次 health_alert 并跳过整轮、恢复复位；每轮 `onLoginState` 上报）；每 uid 首轮静默归档；失败纪律同 dynamic。`parseMblog`：text_raw 纯文本 / retweeted_status 转发拼「//转发自 @xx」（被删残桩不炸）/ pics large.url / created_at Date.parse 转秒 / isLongText 补 `ajax/statuses/longtext`（失败用截断兜底不算错误） | ✅ 已实测（2026-08-03 真扫全链路：换票落盘 → 时间线归档 → 面板新增微博 5 分钟内自动纳入） |
| `src/sources/weibo/qrcode.ts` | passport sso/v2 扫码客户端：`generateQrcode`（**必须带 Referer: https://weibo.com/ 否则 403**，image 是 png 直链面板直接 `<img src>`）/ `pollQrcode`（retcode 归一化：20000000=confirmed、50114001=waiting 已实测；50114002=scanned、其他 50114xxx=expired 防御式映射）/ `exchangeCookies`（confirmed 的 data.url 起跟 302 链收集 Set-Cookie 换全套 cookie，3xx 时 res.ok=false 勿当错误）；fetch 可注入，cookie 绝不进日志 | ✅ 已实测（2026-08-03 真扫全链路） |
| `src/sources/weibo/auth.ts` | weibo-cookies.json 管理：`loadWeiboCookies`（坏 JSON 启动即失败）/ `saveWeiboCookies`（merge：新值覆盖、旧值兜底）/ `weiboCookieHeader`（绝不进日志）/ `fetchWeiboSelf`（`ajax/log/action` 看 X-Log-Uid 响应头，异常与缺头归一化为未登录） | ✅ |
| `src/sources/weibo/resolve.ts` | 昵称→UID 解析（匿名访客通道：genvisitor 拿 tid → incarnate 拿 SUB/SUBP → m.weibo.cn/n/<昵称> 302 /u/<uid>；cookie 模块级缓存、失效自动重建重试一次、绝不进日志；fetch 可注入） | ✅ 已实测昵称解析 |
| `src/sources/media/keyframe.ts` | 画面采样 → snapshots 表 | ⬜ |

### analysis — 分析（LLM 即任务）

| 文件 | 职责 | 状态 |
|---|---|---|
| `src/analysis/types.ts` | `Analyzer` / `AnalysisContext` / `SceneVerdict` / `LlmTask`（占位） | ✅ 仅类型 |
| `src/analysis/noop.ts` | M1 占位，恒返回 null | ✅ 占位 |
| `src/analysis/triggers.ts` | 触发策略：开播 / 新动态 /（预留）直播中抽查、定时全量 | ⬜ |
| `src/analysis/queue.ts` | 分析队列：信号量限流（并发 2）。预留：同房间触发合并、结果缓存、优先级 | ✅ 基础版 |
| `src/analysis/context.ts` | 按房间聚合时间窗内多源数据 → 一份 context | ⬜ |
| `src/analysis/providers.ts` | LLM provider 层（OpenAI 兼容直连，无外部网关；`api` 双协议 chat-completions / responses〔responses：system→instructions、部件 input_text/input_image、结构化输出走 text.format〕，Anthropic /messages 明确不接）：`LlmRouter.completeJson(req, parse?)` 按输入是否含图自动选 text/vision 路由（可显式覆盖），沿路由降级，全挂抛 `AllProvidersExhaustedError`；熔断（连续失败阈值 + 冷却期跳过）；多 key 池轮询（`needsAuth` 启发式：loopback 端点 = 无鉴权，其余无 key = 标「缺 key」跳过，不算配置错误）；`structuredOutput` 三档（schema / object / none，none 剥 ```json 围栏兜底）；任务层 zod parse 失败同等计入熔断；key 只进 Authorization 头绝不进日志/错误信息；**provider 名单事实来源是 settings 表 `llm_providers`**（`seedLlmProvidersIfEmpty` / `listLlmProviders` / `saveLlmProviders`），路由 `deriveRoutes` 自动推导（顺序 = 优先级，text = 全部启用，vision = 启用且多模态）；**key 事实来源是 settings 表 `llm_key:<providerName>`**（逗号分隔多 key；`dbKeysOf` = 面板 > .env keyEnvs 回退，`envKeysOf` = 纯 env）；`migrateLiteralKeys` 一次性迁移早期误填进 keyEnvs 的 key 值（非合法变量名 = key 值，挪进 key 存储，不再明文展示）；保存后 `router.refreshKeys()` 热更新；`router.ping(name)` 面板「测试」按钮用（绕熔断直连，结果计入熔断）；`createLlmRouter(cfg, keysOf?)` 装配（路由内部推导） | ✅ |
| `src/analysis/tasks/scene-classify.ts` | 内容分类（游戏/唱歌/杂谈/演出/other + evidence）→ verdicts 表 | ⬜ |
| `src/analysis/tasks/schedule-extract.ts` | 从动态/微博解析预告时间 → schedules 表（置信度入库，阈值过滤） | ⬜ |
| `src/analysis/matcher.ts` | 透明条件规则匹配：`matchPushRules(rules, event)` 关键词（标题子串）/分区（areaName+parentAreaName 子串）AND 语义、组内任一、大小写不敏感；**返回全部命中规则**（保持 sort 顺序）：所有命中规则独立生效，调用方对渠道取并集去重（同一渠道只推一次），推送词 = sort 序首个非空 messageTemplate；关键词/分区不填 = 空条件规则恒命中（任意匹配，与其他规则同等参与，不再单独兜底）。`renderTemplate` 渲染 {alias}/{uname}/{title}。零 LLM 依赖 | ✅ |

### rules — 确定性护栏

| 文件 | 职责 | 状态 |
|---|---|---|
| `src/rules/types.ts` | `DecisionRule` / `NotifyDecision` | ✅ 仅类型 |
| `src/rules/once-per-session.ts` | M1 规则：每场直播推一次 | ✅ 占位 |
| `src/rules/preference.ts` | 护栏全集：静音名单、静默时段、冷却窗口、状态跳变抑制 | ⬜ |

### notify — 推送（只执行，不解释语义）

| 文件 | 职责 | 状态 |
|---|---|---|
| `src/notify/types.ts` | `Notifier` 接口：`send(PushMessage)` + `capabilities` + `alert()` | ✅ |
| `src/notify/message.ts` | `liveEventToMessage()`：LiveEvent → PushMessage（纯文案不用 emoji——QQ iOS 气泡渲染会把增补平面 emoji 拆成两个方框；body 只留直播标题，分区 · 开播时间进 attribution，头像进 icon，刚开播无关键帧时通知仍有图） | ✅ |
| `src/notify/dispatcher.ts` | 并行 fan-out、notify_log 用 `msg.ref` 溯源、任一通道成功即标记。`msg.channels` 存在时渠道路由：查 push_channels 过滤「选中且启用」按 notifier 分组，onebot 组解析成 `msg.targets`，无选中渠道的 notifier 跳过；缺省走全通道旧行为。**待扩展**：通道级规则 | ✅ |
| `src/notify/onebot.ts` | NapCat OneBot 11 HTTP；消息段数组；attribution 拼成正文第三行；图片失败降级纯文本；每目标串行 + 1.2s 间隔。常规 `send` 只看 `msg.targets`（空 = 不发），构造参数 targets 只作 `alert()` 告警目标与 push_channels 种子来源；`--test-notify` 的假消息带 config targets 可真实验证链路 | ✅ 已实测（2026-08-05 test-notify 私聊 554056021 发送成功） |
| `src/notify/toast.ts` | powertoast 本机通知；兼作 NapCat 挂掉时的告警通道。构造可传 `aumid` + `cacheDir`；http 图先经 image-cache 本地化（Win32 身份不支持远程图），失败按无图发。icon = 左侧方形头像（appLogoOverride，不裁圆）、heroImg = 顶部关键帧大图、attribution = 底部分区 · 开播时间小灰字 | ✅ 已实测 |
| `src/notify/aumid.ts` | Win32 AUMID「DD-claw」自动注册：.lnk 缺失时调 `scripts/register-aumid.ps1`（PowerShell COM interop 写 AppUserModel.ID + 通知中心注册表，**必须 UTF-8 BOM + STGM_READWRITE**）；失败回落 Microsoft Store 默认身份，通知照发 | ✅ 已实测 |
| `src/notify/image-cache.ts` | toast 图片本地化：http 图下载到 `data/cache/toast/`（B站图床需 UA+Referer，3MB 上限，3 天清理），失败返回 null | ✅ |
| `src/notify/ntfy.ts` | ntfy 兜底通道 | ⬜ |

### panel — 控制面板（localhost WebUI，v1）

| 文件 | 职责 | 状态 |
|---|---|---|
| `src/panel/server.ts` | `createPanelServer({ db, status, weiboResolver?, auth?, weiboAuth?, listen? })`：同进程 node:http，零框架零依赖，只绑 127.0.0.1；REST API 读写 streamers/follows/push_channels/push_rules/settings + `/api/status`（platforms/liveCount 新形状）；`/api/listen` + `PUT /api/listen/:feature` 监听功能开关（listen dep 存在才挂载；GET 回 auto 有效态 + platforms；PUT 改手动设置并回调 onChanged 热启停源）；`/api/streamers` enrich（三开关 + face + live 实况 + rules 规则名数组〔按优先级，含 disabled〕 + posts 最近 5 条动态摘要〔platform/type/text/pics/pubTs/url，raw 不下发，一次分组查询〕，一次请求每表各查一次）；`PUT /api/streamers/:uid` 可写键 alias/watch/analyze/notify/weiboNick/profileNote（weiboNick 与现值不同才走 resolver 解析，成功连同 weibo_uid 入库，找不到/网络错误 400，传空两字段一起清；resolver 未注入时 400「微博解析不可用」）；`/api/channels` + `/api/channels/:id` 渠道 CRUD（notifier 枚举、onebot 必填纯数字 targetId、name 非空，PUT 对合并后形状做联动校验）+ `PUT /api/channels/order` 拖拽排序（ids 必须与现有渠道一一对应，否则 400；在 :id 通配之前匹配）；`/api/push` + `PUT /api/push/enabled` 推送总开关（settings.push_enabled，缺省开；关 = pipeline 全局不推，追踪照常）；`/api/push/default` 读写全局默认推送（渠道 id 数组 + 推送词；channels 未设置时 GET 返回全部启用渠道 id = pipeline 兜底行为）；`/api/rules?uid=` + `/api/rules` + `/api/rules/:id` 规则 CRUD（`name` 规则名称可省略，缺省自动补「规则 N」，显式传空串 = 400「规则名称不能为空」；关键词/分区不填 = 任意匹配，推送词不填 = 用全局默认模板）+ `PUT /api/rules/order` 拖拽排序（body 带 uid + ids，ids 必须与该 uid 现有规则一一对应，否则 400；在 :id 通配之前匹配）；`/api/auth/bili/qrcode` + `/poll` B站扫码登录（auth dep 存在才挂载，confirmed → saveCookies 落盘 → onCookiesSaved 热重启 follows + dynamic）；`/api/auth/weibo/qrcode` + `/poll` 微博扫码登录（weiboAuth dep 存在才挂载，qrid 会话存服务端；confirmed → exchangeCookies 换票 → saveWeiboCookies 落盘 → onCookiesSaved 热重启 weibo feed；expired 清会话）；`/api/llm` + `PUT /api/llm/keys` LLM provider 展示与 key 管理（llm dep 存在才挂载；key 按 provider 存 `llm_key:<providerName>`，**本机面板明文回显/编辑**〔用户决策 2026-08-06，不做掩码〕：GET 回 source panel/env/unset + count + value；空 value = 清除面板填写回退 .env keyEnvs；保存后 router.refreshKeys() 热更新）+ `POST /api/llm/providers` + `PUT/DELETE /api/llm/providers/:name` provider 名单 CRUD（llmProviderSchema 校验、重名 400、name 是路径标识不可改；body 可携带 `key` 一并保存〔弹窗单表单体验〕，不带则不动现有 key；落 settings 表后 onProvidersChanged 重建 router 热生效）+ `PUT /api/llm/providers/order` 整体重排（names 必须是现有名单的排列：长度一致/无重复/无增删，否则 400；在 :name 通配之前匹配）+ `POST /api/llm/providers/:name/test` 可用性 ping（404 不存在 / 400 缺 key / 200 {ok,ms} / 502 端点错误，错误信息不含 key）+ `PUT /api/llm/enabled` 总开关（settings.llm_enabled '1'/'0' 覆盖 config 默认，isLlmEnabled 解析）；cookie 值不进任何响应/日志（LLM key 例外：明文回显是本机面板的明示决策） | ✅ v1 |
| `src/panel/http-util.ts` | 请求体解析（64KB 上限）、参数校验（400 + 中文错误）、JSON 响应 | ✅ |
| `src/panel/page.ts` | 内嵌单页 HTML 拼壳（原生 fetch，无 CDN 离线可用；dist 不拷静态文件故内嵌；脚本段内不得出现反引号与 `${`） | ✅ |
| `src/panel/page/` | 单页拆分（2026-08-08 重构：macOS Sequoia 观感——设计令牌 + 浅色/深色双主题、卡片式行布局无分隔线、圆角矩形控件不用胶囊、事件委托无内联 on*、通用组件层）：`style.ts` 设计系统（CSS 变量令牌 --bg/--card-bg/--row-bg/--text/--text-secondary/--separator/--accent/--red/--green/--fill + 圆角两级 --r-lg 14〔一级：页面卡片/sheet〕/--r-md 8〔二级：一级卡片内的所有元素——行卡片/分段卡/按钮/输入框同档〕+ 唯一三级 --r-sm 6〔二级元素内部：动态卡片/缩略图/关键帧/tag/图标按钮/勾选框〕+ 高度两档 --ctl-h 36〔单行控件：按钮/输入框/图标按钮等只含文本或 icon 的元素〕/--row-h 44〔单行卡片：排序列表行/多选行/监听登录行/三模块开关行等 .row 级卡片〕，prefers-color-scheme 深色覆盖；**加粗仅标题**〔h1/h2/.sheet-title/.sheet-sub〕；统一控件：.row 行卡片〔--row-bg 浅填充、无分隔线〕/ .icon-btn 32×32 图标按钮 / .switch 38×22 macOS 扁蓝开关〔仅存四处主控：监听两行 + LLM/推送卡总开关〕/ .checkbox 16×16 圆角方块勾选框〔并排多选：详情三选项、渠道多选〕/ .checkdot 无方框蓝色勾〔勾选排序列表启停〕/ .btn 圆角矩形按钮 / .tag 圆角矩形标签 / .sheet 两级弹窗 / .toast-capsule 圆角矩形 toast）/ `qr-lib.ts` 二维码库（base64 内嵌）/ `icons.ts` 内联 SVG 图标集（描边仿 SF Symbols，24 viewBox currentColor：plus/pencil/trash/bolt/grip/search/xmark/qrcode/check/bell/chevron-right/gear/link + `icon(name)`）/ `app-core.ts` 通用组件层（esc / api / toast / openSheet+closeSheet 两级统一弹窗〔遮罩点击或 × 关闭，sheetCleanups 注册清理〕/ switchHtml / checkboxHtml / checkRowHtml / checkDotHtml / iconBtn / gripHtml / field / chanTypeName+chanTag / **makeSortable 通用拖拽排序**〔行 .row[draggable][data-sid]，opts {items,getId,onOrder}，provider/渠道/规则三处复用〕/ **事件委托**〔ACTIONS/CHANGES/INPUTS 三张表，渲染只写 data-action/data-change/data-input，所有插值过 esc()，天然消除属性注入 XSS；data-action="noop" 吞卡片点击〕/ fmtDur+durSpan 每秒重算 / data-icon 静态图标位填充）/ `app-listen.ts` 监听卡（四行：B站登录 / 监听动态〔开关〕/ 微博登录 / 监听微博〔开关〕；**统一参数化登录流程 LOGIN_PLATFORMS**〔B站内嵌 qr 库 svg / 微博 png 直链 `<img>`，轮询/状态文案/expired 处理一致〕；开关没登录默认关、登录后自动开、手动设置为准，走 `/api/listen`；直播间开播轮询不依赖登录常开、不在卡片展示）/ `app-llm.ts` LLM 分析卡（总开关卡片右上角；行 = 启停勾/名称/多模态标签/测试 bolt/编辑 pencil/删除 trash/拖拽 grip；新增与编辑统一 sheet 表单〔名称/baseURL/模型/key 明文/多模态勾选框/结构化输出档/协议〕；顺序 = 优先级，makeSortable 拖拽落库热生效）/ `app-push.ts` 推送卡（总开关右上角；渠道行同款通用行；全局默认推送 sheet〔渠道勾选框 + 推送词〕，卡片底部「新增渠道 + 全局默认推送」按钮）/ `app-streamers.ts` 主播卡片三栏（左基本信息｜中直播实况〔在播 keyframe 大圆角图 + 「直播中」徽标，下播弱化 off 类〕｜右动态时间线〔每条动态一张小卡片；LIVE_RCMD 过滤后为空显示「暂无动态」，无归档显示「暂无抓取」〕；卡片标题栏客户端算「在播 N · 共 M」）+ 详情弹窗（分段卡片 form-card：别名/直播间号只读/微博昵称/画像 + 三勾选项〔监听/LLM 分析/推送〕+ 推送规则：通用行列表 + 添加规则按钮；规则新增/编辑走二级 sheet〔名称/关键词/分区/渠道勾选/推送词〕，保存报错内联在按钮行 .form-err；规则区说明「命中即推，同渠道去重；顺序决定同渠道推送词取舍」）/ `app-follows.ts` 关注列表卡（头像网格 + 「已监听」标记 + 搜索框〔图标 + data-input 过滤昵称/UID〕+ 一键加入监听，超 120 条折叠可展开） | ✅ |

v1 范围：六卡片（监听〔B站登录 / 监听动态开关 / 微博登录 / 监听微博开关，开关没登录默认关、登录后自动开、手动设置为准〕/ LLM 分析 / 推送 / 时间表占位 / 主播列表 / 关注列表）；B站扫码登录（平台状态点：none/imported/ok/expired，弹窗出二维码轮询，确认后落盘热重启 follows + dynamic）；微博扫码登录（同一状态点与弹窗复用，png 直链 `<img>` 显示，confirmed → 换票落 weibo-cookies.json → 热重启微博时间线）；主播卡片三栏（左基本信息 + 规则名标签〔一条一个，无规则不显示〕｜中直播实况：在播关键帧/标题/分区/开播时长/在线，下播下播时长锚点 last_live_at｜右动态时间线：enrich posts 最近 5 条混排，B站动态与微博按 pub_ts 混合）；推送卡片 = 全局默认推送（渠道勾选 + 推送词，条件规则都不命中时走这里）+ 渠道管理（系统通知 / QQ群 / QQ私聊，可单独停用）；关注列表 = B站关注候选池（已监听标记 + 搜索过滤 + 一键加入监听）；主播详情弹窗下半区 = 推送规则（可排序勾选列表 + 嵌套弹窗编辑：规则名称/关键词/分区/渠道勾选/推送词覆盖）。v2 预留：verdicts 总览、时间表日历（M3）。

### 装配与基础设施（已实现）

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 装配入口 + CLI：`--dry-run` / `--test-notify` / `--probe` / `--probe-llm`（列 provider 状态 + text 路由 ping，验证 LLM 接线）/ `--force-uid`；启动种子：subscriptions → streamers、notify 目标 → push_channels（均仅空表时）；`panel.enabled` 时起控制面板；follows / dynamic / weibo 三 source 单独持有（有各自 cookie 才创建，扫码登录后 `onCookiesSaved` 热重启，shutdown 停最新实例；dynamic / weibo 无 cookie 时各 log 一次不阻塞启动）；`onLoginState` → 面板平台状态 |
| `src/config/index.ts` | 读 `.env` + `config.json`（JSONC 注释、BOM 剥离），zod 启动即校验 |
| `src/config/schema.ts` | 配置 schema；秘密只在 `.env` / `cookies.json` / `weibo-cookies.json`。`subscriptions` 已迁库（streamers 表），仅作首次启动种子，可省略（旧 `mode` 字段兼容映射为 watch/notify）。`notify.onebot.targets`：push_channels 种子来源 + onebot `alert()` 告警目标（zod 校验不变）。`follows`：关注列表同步开关 + 间隔（默认 1800s，下限 300s）。`dynamic`：空间动态轮询开关 + 间隔（默认 300s，下限 120s；无 cookie 自动跳过）。`weibo`：微博时间线开关 + 间隔（默认 300s，下限 120s；无 weibo-cookies.json 自动跳过）。`panel`：控制面板开关 + 端口（默认 8787，只绑 127.0.0.1）。`llm`：LLM 接入默认值/首次种子（全部管理在面板 LLM 卡片）：enabled 仅默认开关（settings.llm_enabled 覆盖）；providers 数组仅空库种子（settings 表 `llm_providers` 是事实来源；name/baseURL/model/vision/keyEnvs/structuredOutput 三档/api 双协议〔chat-completions 默认 / responses〕，keyEnvs 空数组 = 无鉴权本地端点，name 重复启动即校验失败）+ requestTimeoutMs/circuitThreshold/circuitCooldownMs；路由不用配，由名单自动推导 |
| `src/logger.ts` | 极简结构化日志 |

## 开发约定

- **ESM + Node ≥ 22**：相对导入带 `.js` 后缀；不装 axios，用原生 `fetch` + `AbortSignal.timeout`
- 配置错误**启动即失败**并指明字段
- 拉取失败**绝不能当成下播**——保留旧状态，什么都不做
- **不做任何写操作**（不发弹幕、不点赞）；匿名接口优先，需凭据的功能由用户显式导入 cookie 后才启用
- LLM 调用一律走 `analysis/queue`，禁止在轮询循环里直接调
- B站接口已知坑（UA 必填、Referer、轮播状态等）见 `docs/boundaries.md` 第 5 节，改 source 前先查

### 命令

```bash
npm run dev          # tsx watch 开发
npm run build        # tsc → dist/，常驻用 node dist/index.js
npm test             # node --test（state/bus/pipeline/concurrency/streamers/db/push/posts/live-status-source/auth/follows/qrcode/dynamic/weibo-resolve/weibo-qrcode/weibo-auth/weibo-feed/rules/config/matcher/providers/onebot/dispatcher/image-cache/message/panel）
npm run probe        # 只查一次开播状态，验证接口通不通
npm run probe-llm    # 列 LLM provider 状态 + text 路由 ping，验证 llm 段接线
npm run test-notify  # 假事件走完整推送链路，验证 NapCat/Toast 配置
```

手动验证三手段：`--dry-run`（只打日志不真发）、`--test-notify`、`--force-uid <uid>`（监听正在直播的房间，立刻触发真实全链路）。

## 文档索引

- `docs/design.md` — 总体设计：规模假设、三段架构、数据结构、里程碑 M1-M5、待定项
- `docs/boundaries.md` — 能力边界：匿名可得 / 需凭据 / 做不到，已知踩坑清单（含 M1 实施经验）
- `docs/research/` — 分模块调研（live-status、danmaku、feeds、llm、notify、media-capture、auth-cookie、ts-stack）

## 当前进度

- **M1（开播通知）**：代码完成，测试通过。**NapCat 已部署并实测**（2026-08-05：NapCat 4.18.13 + QQNT 9.9.32，OneBot11 HTTP 127.0.0.1:3000，`--test-notify` 私聊 554056021 带图发送成功，notify_log ok=1）
- **M2 第 0 步（架构纠偏）**：完成。bus / pipeline / PeriodicTask / Source 接口 / 分析队列 / PushMessage 落地，行为与 M1 对齐，测试全绿
- **M2（规模化 + 内容判定）**：进行中。监听名单已迁库：`streamers` / `follows` 两表 + CRUD + config 种子导入完成，source 名单改读 `listWatchedUids()`，测试全绿。**cookie 管理 + 关注列表同步已落地**：`auth.ts`（cookies.json 整套字段 + nav isLogin 心跳，端点 `x/web-interface/nav`，旧 `x/member/web/nav` 已 404）+ `FollowsSource`（心跳合并进同步周期、失效告警一次、单页失败整轮放弃；关注不自动入监听，follows 表仅作面板候选池），分页已实测（604 关注 13 页），测试全绿。**推送规则产品化已落地（替代旧 L0 + preference_clauses 设计）**：无 LLM 时不做模糊分类——用户直填透明条件规则（push_rules：关键词/分区 AND、组内任一，仅条件规则）→ matcher 确定性匹配 → PushMessage.channels 引用 push_channels（面板统一管理系统通知/QQ群/QQ私聊，可停用；空表时 config 种子导入）→ dispatcher 按渠道路由（onebot 组解析 msg.targets）；条件规则都不命中走**全局默认推送**（settings.default_channels 渠道 + default_template 推送词，推送卡片统一配置；default_channels 未设 = 全部启用渠道，显式空数组 = 默认不推）；推送词 = 规则覆盖 > settings.default_template > 内置默认；旧 preference_clauses 表开库即 DROP，测试全绿。**控制面板 v0 已落地**：`src/panel/`（node:http 只绑 127.0.0.1，内嵌单页无依赖），名单管理/画像编辑、候选池一键加入、系统状态展示，改库即生效无需重启，测试全绿。**控制面板 v1 已落地**：四卡片产品化展示（运行状态 platforms/liveCount、时间表占位、主播卡片实况、推送卡片）+ B站扫码登录（passport generate/poll，confirmed → saveCookies merge 落盘 → onCookiesSaved 热重启 follows source；`onLoginState` 心跳驱动平台状态点 none/imported/ok/expired）+ 主播卡片实况（room_state 展示列 + last_live_at 下播锚点 + rules 摘要）+ 主播详情推送规则 CRUD。扫码链路已真实实测通过（2026-08-03：扫码 → 落 cookie → 热重启 → 心跳 ok → 604 关注同步入库）。**空间动态源已落地**：`DynamicSource`（`feed/space` 全量 cookie + dm 三参 + space Referer，实测无需 WBI，推翻 feeds.md 旧 412 结论）+ `dm.ts`（RSSHub 算法）→ `posts` 表归档（UNIQUE(platform,item_id) 去重，raw 全留）→ 新帖 emit `feed_post`（每 uid 首轮静默；pipeline 现状自然不推送，M3 再消费）；主播卡片第三栏动态时间线（enrich 带最近 5 条）。已真实实测（2026-08-03：22 个监听对象首轮归档 281 条，含 LIVE_RCMD 二次解析，零 412/解析报错）。**微博接入已落地**：`weibo/qrcode.ts`（sso/v2 扫码，generate 必须带 `Referer: https://weibo.com/` 否则 403〔冒烟实测〕；image 为 png 直链）+ `weibo/auth.ts`（weibo-cookies.json 管理 + `ajax/log/action` X-Log-Uid 心跳）+ `weibo/feed.ts`（`ajax/statuses/mymblog` 轮询，text_raw 纯文本、转发递归、长文 longtext 补全兜底、登录态心跳折进同步周期）→ posts 表 `platform='weibo'`，第三栏动态时间线自然混排（`weibo`→「微博」标签）；面板微博扫码登录复用同一弹窗（png 直链 `<img>` 显示，qrid 会话存服务端，confirmed → 换票落盘 → 热重启 feed 源）；config 加 `weibo` 段。冒烟已验：generate/poll waiting/status 平台点真实可用。**真扫实测通过（2026-08-03）**：扫码确认 → 换票落盘 weibo-cookies.json → 登录态 ok → 阿梓微博归档 → 面板新增七海微博 5 分钟内自动纳入（无需重启）；50114002=scanned 等少数状态码为防御式映射（未单独观测）。**LLM 接线已落地（2026-08-06）**：`providers.ts`（OpenAI 兼容聚合：text/vision 路由〔含图自动走 vision〕+ 熔断 + 多 key 池 + structuredOutput 三档 + api 双协议〔chat-completions / responses，Anthropic /messages 不接〕）+ config `llm` 段 + `--probe-llm` 验证命令，测试全绿；**provider 名单与 key 都在面板管理**：LLM 卡片 = provider 列表〔每行仅勾选框/名称/多模态标签/测试/编辑/删除/拖拽把手，上移下移用拖拽排序替代；最后一行新增按钮；总开关在卡片右上角〕（settings 表 `llm_providers` 事实来源，config 仅种子，路由按名单顺序自动推导，改名单/排序重建 router 热生效）+ key 明文填写/回显（settings 表 `llm_key:<providerName>` 逗号分隔多 key，本机面板不做掩码〔用户决策 2026-08-06〕，面板 > .env 优先级，refreshKeys 热更新免重启）+ 总开关（settings.llm_enabled 覆盖 config 默认）——LLM 全流程不需要碰任何配置文件；选型结论同日修订（多模态硬要求、便宜付费 API 主力〔MiniMax-M3 vision / DeepSeek text〕、本地 LM Studio 作 vision 降级位、OpenCode Go 走官方 API 作降级链 provider〔CLI/反代方式舍弃，chat/completions 族直接可接、gpt-5.6-luna 族配 api: responses、Anthropic 族不接〕、订阅反代不做），详见 docs/research/llm.md。后续：scene-classify / schedule-extract 任务接入 queue；面板 v2 = verdicts 总览、时间表日历（M3）
**WebUI 卡片整理 + 监听功能开关已落地（2026-08-07）**：六卡片布局（监听 / LLM分析 / 推送 三并列，时间表占位，主播列表，关注列表独立卡片带搜索框）；「监听」卡四行——B站登录（点击行扫码弹窗）/ 监听动态（开关）/ 微博登录 / 监听微博（开关），直播间轮询匿名常开不在卡片展示；`core/listen.ts` 三态开关（settings `listen_<feature>`：缺省=auto 跟随登录、'1'/'0'=手动，手动设置为准；`setListen` 与 auto 一致则回 auto），`shouldRunListen`（config 开 && cookie &&（手动开||auto），auto 下登录过期不自动停由源心跳兜底），动态/微博源启停统一走 `reconcileListen`（index.ts），面板 `/api/listen` GET/PUT 热启停；**LLM/推送卡统一为「总开关右上角 + 列表行〔勾选框/名称/标签/按钮/拖拽把手〕+ 弹窗编辑」**：LLM 用拖拽排序替代上移下移（`/api/llm/providers/order`），推送卡新增总开关（settings.push_enabled，pipeline 全局闸门）+ 渠道拖拽排序（push_channels.sort + `/api/channels/order`）+ 渠道/全局默认推送弹窗化；**推送规则 UI 同款列表化**：push_rules 加 name/sort 列，主播弹窗内规则 = 可排序勾选列表〔勾选框/规则名称/渠道名多标签/编辑/删除/拖拽把手〕+ 添加规则按钮，规则新增/编辑走嵌套弹窗 modal2（表单带 label，含规则名称/关键词/分区/渠道勾选/推送词；启停由列表勾选框控制，弹窗内无「启用」），`PUT /api/rules/order`（uid + ids 全排列）；**规则弹窗去注释文字 + 允许空条件**：关键词/分区可空 = 任意匹配（双条件仍 AND）、推送词空 = 全局默认，移除 checkRuleConditions 与「空条件开库即删」迁移；保存报错不再走顶部 toast，改在保存按钮同一行内联显示；测试全绿（271）。
**面板 UI 设计重构 + 规则语义修正已落地（2026-08-08）**：上次提交审查修复——**推送规则语义改为「全部命中独立生效 + 按渠道去重」**（用户拍板：`matchPushRule` → `matchPushRules` 返回全部命中，pipeline 渠道并集去重、推送词取 sort 序首个非空；空条件规则不再单独兜底）；DynamicSource 补登录态心跳（follows.enabled=false 时 B站登录态唯一来源）；`/api/status` 删 followsCount 死字段；规则名显式传空 = 400（三方口径统一）；`setListen` 回 auto 删 key 不留空串；清理 index.ts 冗余 stop 与过时注释。**前端整体重写（苹果风格）**：设计令牌 CSS 变量 + prefers-color-scheme 深色双主题；统一控件（44px 列表行 / 28×28 图标按钮 / 44×26 iOS 开关 / 胶囊按钮 / pill 标签 / sheet 两级弹窗 / 顶部胶囊 toast）；事件委托（data-action/change/input 三张表）彻底消灭内联 on* 与 jsq 转义（顺带修掉 provider name 属性注入 XSS）；makeSortable 通用拖拽三处复用；B站/微博登录流程参数化统一；新增 icons.ts 内联 SVG 图标集；app-status → app-listen 改名；主播卡片「直播中」徽标 + 标题栏「在播 N · 共 M」+ LIVE_RCMD 过滤后空白修复；测试全绿（275）。
- **M3（预告时间表）/ M4（偏好与路由）/ M5（产品化）**：未开始