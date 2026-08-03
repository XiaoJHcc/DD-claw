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
│           weibo/feed        微博时间线（cookie）               [未实现]
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
            onebot(NapCat) [已实现，未实测] / toast [已实现] / ntfy [未实现]
```

**三个解耦点，改代码不要破坏：**

1. **Signal 总线**（抓取→分析）：source 不知道有 LLM
2. **任务化 LLM 接口**（分析内部）：schema 进 JSON 出，换模型只动 providers
3. **PushDirective**（分析→推送）：推送层不解释语义

**偏好归属（已决策）**：人类需求是唯一锚点信源——用户在控制面板直填**透明条件规则**（push_rules 表：关键词/分区条件 → 渠道 + 推送词覆盖），matcher 确定性执行；不做 NL→结构化衍生编译，运行管线无人工环节，无 LLM 时不做任何模糊分类。rules 只做确定性护栏；notify 只做路由执行。LLM 不参与偏好解释，其可用性不影响偏好链路。

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
| `src/core/types.ts` | `LiveStatus`（平台无关，bili `RoomStatus` 是其扩展）/ `Signal` / `LiveEvent` / `PushMessage`，`toLiveEvent()`。core 不得 import 任何 sources/ 下的类型 |
| `src/core/bus.ts` | 类型化信号总线：emit 不 await，单 handler 异常记日志不影响其他 |
| `src/core/state.ts` | 纯函数状态机 `diffRoom(prev, curr)` → Signal；`(room_id, live_time)` 是一场直播的身份；轮播（`live_status=2`）视为未开播；拉取失败不产 Signal；无 prev 也如实产 live_start（抑制政策在 pipeline） |
| `src/core/scheduler.ts` | `PeriodicTask`：通用周期任务器（间隔+抖动+自调度不重叠），不含业务逻辑 |
| `src/core/pipeline.ts` | 信号编排唯一装配点：bus → 冷启动抑制 → silent 抑制（追踪照常） → 分析队列（Noop 恒 null，LLM 接入点保留） → 护栏 → 透明条件规则（无规则兜底全渠道）→ 推送；信号处理并发 4；health_alert → alertAll（payload 带 `message` 时用自定义文案） |
| `src/core/db.ts` | better-sqlite3。已有九表：`live_sessions` / `notify_log` / `room_state`（已扩展展示列 area_name/parent_area_name/keyframe/cover/online/last_live_at，存库迁移自动补列；`countLiveRooms()` / `listRoomStatesFull()` 供面板）/ `streamers`（监听名单，事实来源，含 face；三开关 `watch`/`analyze`/`notify` 替代旧 `mode` 列——启动迁移：off→watch=0、silent→notify=0 后 DROP mode；另有 `weibo_nick` 列）/ `follows`（关注候选池，含 face）/ `push_channels`（推送渠道，事实来源；空表时 config 的 onebot targets + toast 种子导入，之后以表为准）/ `push_rules`（透明条件规则）/ `settings`（kv，现只有 default_template）/ `posts`（动态/微博时间线归档，UNIQUE(platform,item_id) 去重，raw 整 item 全留；`insertPosts` 返回新行下标、`listRecentPosts` 分组取近 N 条供面板 enrich）。旧 `preference_clauses` 表已废弃：打开库时存在即 DROP。**待扩展**：`signals` / `snapshots` / `verdicts` / `schedules` |
| `src/core/streamers.ts` | streamers / follows 两表的行类型与「行 ↔ 对象」映射（JSON 字段序列化集中在此）；监听名单 CRUD 是 `Db` 的方法 |
| `src/core/push.ts` | push_channels / push_rules 两表的行类型与「行 ↔ 对象」映射（JSON 数组字段序列化集中在此）；CRUD 是 `Db` 的方法 |
| `src/core/posts.ts` | posts 表的行类型与「行 ↔ 对象」映射（pics JSON 序列化集中在此）；归档/查询是 `Db` 的方法 |
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
| `src/sources/bili/dynamic.ts` | `DynamicSource`：空间动态轮询（`feed/space`，全量 cookie + dm 三参 + space Referer，**无 WBI**；mapLimit(2) 逐 uid）→ posts 表归档（UNIQUE 去重）→ 新帖 emit `feed_post`（payload 带 post 摘要）；每 uid 首轮静默归档；拉取失败保留旧数据，单 uid 连续失败到阈值发一次 health_alert、恢复复位；无 cookie 不启动，随 follows 热重启。`parseDynamicItem`：LIVE_RCMD 二次解析 live_play_info / WORD / DRAW（opus pics、draw items）/ AV / FORWARD（拼「//转发自 @xx」摘要） | ✅ 已实测（2026-08-03：22 个 uid 全量归档，零 412） |
| `src/sources/bili/dm.ts` | dm 设备指纹参数（`dm_img_list` 高斯随机轨迹 + 两个静态 base64），算法出处 RSSHub `addDmVerifyInfo`；弹幕等风控接口复用 | ✅ |
| `src/sources/weibo/feed.ts` | 微博时间线（config 配 `weiboUid` 映射） | ⬜ |
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
| `src/analysis/providers.ts` | LLM provider 熔断 + 降级链（Gemini → GLM） | ⬜ |
| `src/analysis/tasks/scene-classify.ts` | 内容分类（游戏/唱歌/杂谈/演出/other + evidence）→ verdicts 表 | ⬜ |
| `src/analysis/tasks/schedule-extract.ts` | 从动态/微博解析预告时间 → schedules 表（置信度入库，阈值过滤） | ⬜ |
| `src/analysis/matcher.ts` | 透明条件规则匹配：`matchPushRule(rules, event)` 关键词（标题子串）/分区（areaName+parentAreaName 子串）AND 语义、组内任一、大小写不敏感，条件规则按 id 第一条命中、空条件 = 默认规则最后兜底；`renderTemplate` 渲染 {alias}/{uname}/{title}。零 LLM 依赖 | ✅ |

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
| `src/notify/message.ts` | `liveEventToMessage()`：LiveEvent → PushMessage（🔴 文案沿用 M1） | ✅ |
| `src/notify/dispatcher.ts` | 并行 fan-out、notify_log 用 `msg.ref` 溯源、任一通道成功即标记。`msg.channels` 存在时渠道路由：查 push_channels 过滤「选中且启用」按 notifier 分组，onebot 组解析成 `msg.targets`，无选中渠道的 notifier 跳过；缺省走全通道旧行为。**待扩展**：通道级规则 | ✅ |
| `src/notify/onebot.ts` | NapCat OneBot 11 HTTP；消息段数组；图片失败降级纯文本；每目标串行 + 1.2s 间隔。常规 `send` 只看 `msg.targets`（空 = 不发），构造参数 targets 只作 `alert()` 告警目标与 push_channels 种子来源 | ✅ **NapCat 未部署，未实测** |
| `src/notify/toast.ts` | powertoast 本机通知；兼作 NapCat 挂掉时的告警通道。构造可传 `aumid` + `cacheDir`；http 图先经 image-cache 本地化（Win32 身份不支持远程图），失败按无图发 | ✅ 已实测 |
| `src/notify/aumid.ts` | Win32 AUMID「DD-claw」自动注册：.lnk 缺失时调 `scripts/register-aumid.ps1`（PowerShell COM interop 写 AppUserModel.ID + 通知中心注册表，**必须 UTF-8 BOM + STGM_READWRITE**）；失败回落 Microsoft Store 默认身份，通知照发 | ✅ 已实测 |
| `src/notify/image-cache.ts` | toast 图片本地化：http 图下载到 `data/cache/toast/`（B站图床需 UA+Referer，3MB 上限，3 天清理），失败返回 null | ✅ |
| `src/notify/ntfy.ts` | ntfy 兜底通道 | ⬜ |

### panel — 控制面板（localhost WebUI，v1）

| 文件 | 职责 | 状态 |
|---|---|---|
| `src/panel/server.ts` | `createPanelServer({ db, status, weiboResolver?, auth? })`：同进程 node:http，零框架零依赖，只绑 127.0.0.1；REST API 读写 streamers/follows/push_channels/push_rules/settings + `/api/status`（platforms/liveCount 新形状）；`/api/streamers` enrich（三开关 + face + live 实况 + rules 摘要 count + posts 最近 5 条动态摘要〔platform/type/text/pics/pubTs/url，raw 不下发，一次分组查询〕，一次请求每表各查一次）；`PUT /api/streamers/:uid` 可写键 alias/watch/analyze/notify/weiboNick/profileNote（weiboNick 与现值不同才走 resolver 解析，成功连同 weibo_uid 入库，找不到/网络错误 400，传空两字段一起清；resolver 未注入时 400「微博解析不可用」）；`/api/channels` + `/api/channels/:id` 渠道 CRUD（notifier 枚举、onebot 必填纯数字 targetId、name 非空，PUT 对合并后形状做联动校验）；`/api/push/template` 读写全局默认推送词；`/api/rules?uid=` + `/api/rules` + `/api/rules/:id` 规则 CRUD；`/api/auth/bili/qrcode` + `/poll` 扫码登录（auth dep 存在才挂载，confirmed → saveCookies 落盘 → onCookiesSaved 热重启 follows + dynamic）；cookie 值不进任何响应/日志 | ✅ v1 |
| `src/panel/http-util.ts` | 请求体解析（64KB 上限）、参数校验（400 + 中文错误）、JSON 响应 | ✅ |
| `src/panel/page.ts` | 内嵌单页 HTML 拼壳（原生 fetch，无 CDN 离线可用；dist 不拷静态文件故内嵌；脚本段内不得出现反引号与 `${`） | ✅ |
| `src/panel/page/` | 单页拆分：`style.ts` 样式 / `qr-lib.ts` 二维码库（base64 内嵌）/ `app-core.ts` 公共段 / `app-status.ts` 运行状态卡 + 扫码登录弹窗 / `app-streamers.ts` 主播卡片三栏（左基本信息｜中直播实况｜右动态时间线：相对时间 + 平台/类型小标签 + 文字截断 2 行 + 首图小缩略，点击新窗口打开 url 且 stopPropagation，无数据显「暂无抓取」）+ 详情弹窗（别名/三开关/直播间号只读/微博昵称/画像 + 推送规则 CRUD：首行固定「默认推送」+ 条件规则）+ 关注未监听区 / `app-push.ts` 推送卡片（全局默认推送词 + 渠道管理） | ✅ |

v1 范围：四卡片（运行状态 / 时间表占位 / 主播列表 / 推送）；B站扫码登录（平台状态点：none/imported/ok/expired，弹窗出二维码轮询，确认后落盘热重启 follows + dynamic）；主播卡片三栏（左基本信息 + 规则摘要 count｜中直播实况：在播关键帧/标题/分区/开播时长/在线，下播下播时长锚点 last_live_at｜右动态时间线：enrich posts 最近 5 条混排）；推送卡片 = 全局默认推送词 + 渠道管理（系统通知 / QQ群 / QQ私聊，可单独停用）；主播详情弹窗下半区 = 推送规则（首行固定「默认推送」空条件规则，其后条件规则：关键词/分区/渠道勾选/推送词覆盖）。v2 预留：verdicts 总览、时间表日历（M3）。

### 装配与基础设施（已实现）

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 装配入口 + CLI：`--dry-run` / `--test-notify` / `--probe` / `--force-uid`；启动种子：subscriptions → streamers、notify 目标 → push_channels（均仅空表时）；`panel.enabled` 时起控制面板；follows / dynamic 两 source 单独持有（有 cookie 才创建，扫码登录后 `onCookiesSaved` 热重启，shutdown 停最新实例；dynamic 无 cookie 时 log 一次不阻塞启动）；`onLoginState` → 面板平台状态 |
| `src/config/index.ts` | 读 `.env` + `config.json`（JSONC 注释、BOM 剥离），zod 启动即校验 |
| `src/config/schema.ts` | 配置 schema；秘密只在 `.env` / `cookies.json`。`subscriptions` 已迁库（streamers 表），仅作首次启动种子，可省略（旧 `mode` 字段兼容映射为 watch/notify）。`notify.onebot.targets`：push_channels 种子来源 + onebot `alert()` 告警目标（zod 校验不变）。`follows`：关注列表同步开关 + 间隔（默认 1800s，下限 300s）。`dynamic`：空间动态轮询开关 + 间隔（默认 300s，下限 120s；无 cookie 自动跳过）。`panel`：控制面板开关 + 端口（默认 8787，只绑 127.0.0.1）。待扩展：weiboUid 映射 |
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
npm test             # node --test（state/bus/pipeline/concurrency/streamers/db/push/posts/live-status-source/auth/follows/qrcode/dynamic/weibo-resolve/rules/config/matcher/onebot/dispatcher/image-cache/panel）
npm run probe        # 只查一次开播状态，验证接口通不通
npm run test-notify  # 假事件走完整推送链路，验证 NapCat/Toast 配置
```

手动验证三手段：`--dry-run`（只打日志不真发）、`--test-notify`、`--force-uid <uid>`（监听正在直播的房间，立刻触发真实全链路）。

## 文档索引

- `docs/design.md` — 总体设计：规模假设、三段架构、数据结构、里程碑 M1-M5、待定项
- `docs/boundaries.md` — 能力边界：匿名可得 / 需凭据 / 做不到，已知踩坑清单（含 M1 实施经验）
- `docs/research/` — 分模块调研（live-status、danmaku、feeds、llm、notify、media-capture、auth-cookie、ts-stack）

## 当前进度

- **M1（开播通知）**：代码完成，测试通过。**NapCat 未部署**，QQ 通道未实测
- **M2 第 0 步（架构纠偏）**：完成。bus / pipeline / PeriodicTask / Source 接口 / 分析队列 / PushMessage 落地，行为与 M1 对齐，测试全绿
- **M2（规模化 + 内容判定）**：进行中。监听名单已迁库：`streamers` / `follows` 两表 + CRUD + config 种子导入完成，source 名单改读 `listWatchedUids()`，测试全绿。**cookie 管理 + 关注列表同步已落地**：`auth.ts`（cookies.json 整套字段 + nav isLogin 心跳，端点 `x/web-interface/nav`，旧 `x/member/web/nav` 已 404）+ `FollowsSource`（心跳合并进同步周期、失效告警一次、单页失败整轮放弃；关注不自动入监听，follows 表仅作面板候选池），分页已实测（604 关注 13 页），测试全绿。**推送规则产品化已落地（替代旧 L0 + preference_clauses 设计）**：无 LLM 时不做模糊分类——用户直填透明条件规则（push_rules：关键词/分区 AND、组内任一、空条件 = 默认推送兜底）→ matcher 确定性匹配 → PushMessage.channels 引用 push_channels（面板统一管理系统通知/QQ群/QQ私聊，可停用；空表时 config 种子导入）→ dispatcher 按渠道路由（onebot 组解析 msg.targets）；推送词 = 规则覆盖 > settings.default_template > 内置默认；主播无规则兜底全启用渠道；旧 preference_clauses 表开库即 DROP，测试全绿。**控制面板 v0 已落地**：`src/panel/`（node:http 只绑 127.0.0.1，内嵌单页无依赖），名单管理/画像编辑、候选池一键加入、系统状态展示，改库即生效无需重启，测试全绿。**控制面板 v1 已落地**：四卡片产品化展示（运行状态 platforms/liveCount、时间表占位、主播卡片实况、推送卡片）+ B站扫码登录（passport generate/poll，confirmed → saveCookies merge 落盘 → onCookiesSaved 热重启 follows source；`onLoginState` 心跳驱动平台状态点 none/imported/ok/expired）+ 主播卡片实况（room_state 展示列 + last_live_at 下播锚点 + rules 摘要）+ 主播详情推送规则 CRUD。扫码链路已真实实测通过（2026-08-03：扫码 → 落 cookie → 热重启 → 心跳 ok → 604 关注同步入库）。**空间动态源已落地**：`DynamicSource`（`feed/space` 全量 cookie + dm 三参 + space Referer，实测无需 WBI，推翻 feeds.md 旧 412 结论）+ `dm.ts`（RSSHub 算法）→ `posts` 表归档（UNIQUE(platform,item_id) 去重，raw 全留）→ 新帖 emit `feed_post`（每 uid 首轮静默；pipeline 现状自然不推送，M3 再消费）；主播卡片第三栏动态时间线（enrich 带最近 5 条）。已真实实测（2026-08-03：22 个监听对象首轮归档 281 条，含 LIVE_RCMD 二次解析，零 412/解析报错）。后续：微博源，见 design.md §6；面板 v2 = verdicts 总览、时间表日历（M3）
- **M3（预告时间表）/ M4（偏好与路由）/ M5（产品化）**：未开始
