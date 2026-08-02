# DD-claw

监听用户在面板选定的B站主播（关注列表同步作候选池，直播间 + B站动态 + 微博）→ 持续状态追踪 → LLM 分析（内容分类 / 预告时间表 / 偏好推送词）→ 按优先级路由推送（QQ 群 / 私聊 / 本机 Toast）。

**规模假设**：关注上百位、高峰 30+ 同时在播、信号是持续状态而非一次性事件、偏好用自然语言描述。这四条决定了架构，改代码前先读 `docs/design.md` 第 1、4 节。

## 架构：三段解耦

```
┌─ 1. 抓取  src/sources/   持续生产：原始数据入库归档 + 变更信号上总线
│           bili/live-status  批量轮询（50/片 POST，非逐个轮询）  [已实现]
│           bili/follows      关注列表同步（SESSDATA）           [已实现]
│           bili/danmaku      弹幕 WS 按需拉起                   [未实现]
│           bili/dynamic      空间动态（cookie）                 [未实现]
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

**偏好归属（已决策）**：人类需求是唯一锚点信源——用户在控制面板直填结构化偏好子句（preference_clauses 表），matcher 确定性执行 → 文案/优先级/方向；不做 NL→结构化衍生编译，运行管线无人工环节。rules 只做确定性护栏；notify 只做路由执行。LLM 不参与偏好解释，其可用性不影响偏好链路。

**高峰并发原则**：轮询循环只做「拉批量状态 + diff 产信号」两件便宜事；所有 LLM 调用进 analysis/queue，通知不等分析结果。

## 关键接口

| 接口 | 位置 | 约定 | 状态 |
|---|---|---|---|
| `Signal` / `LiveEvent` / `PushMessage` | `src/core/types.ts` | 抓取→分析的事件载荷；`verdict` 可为 null，下游必须能处理；notify 只认识 `PushMessage` | ✅ |
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
| `src/core/pipeline.ts` | 信号编排唯一装配点：bus → 冷启动抑制 → silent 抑制（追踪照常） → 分析队列（null 则 L0 兜底） → 护栏 → matcher/默认文案 → 推送；信号处理并发 4；health_alert → alertAll（payload 带 `message` 时用自定义文案） |
| `src/core/db.ts` | better-sqlite3。已有六表：`live_sessions` / `notify_log` / `room_state`（已扩展展示列 area_name/parent_area_name/keyframe/cover/online/last_live_at，存库迁移自动补列；`countLiveRooms()` / `listRoomStatesFull()` 供面板）/ `streamers`（监听名单，事实来源，含 face）/ `follows`（关注候选池，含 face）/ `preference_clauses`（偏好子句）。**待扩展**：`signals` / `posts` / `snapshots` / `verdicts` / `schedules` |
| `src/core/streamers.ts` | streamers / follows / preference_clauses 三表的行类型与「行 ↔ 对象」映射（JSON 字段序列化集中在此）；监听名单 CRUD 是 `Db` 的方法 |
| `src/core/concurrency.ts` | `mapLimit` 有界并发工具 |

### sources — 抓取

| 文件 | 职责 | 状态 |
|---|---|---|
| `src/sources/types.ts` | `Source` / `SourceContext` 接口：只产 Signal + 归档，不含通知逻辑 | ✅ |
| `src/sources/bili/client.ts` | HTTP 层：强制注入 UA、超时重试、HTTP 错误与业务错误（`code != 0`）分层 | ✅ |
| `src/sources/bili/live-status.ts` | 批量 `get_status_info_by_uids`（POST，50/片）；缺 key = 未开播，不是失败 | ✅ |
| `src/sources/bili/live-status-source.ts` | 轮询 + diff + 批量落状态 + `coldStart` 标记 + 健康计数发 `health_alert` 信号 | ✅ |
| `src/sources/bili/types.ts` | 接口返回类型 | ✅ |
| `src/sources/bili/wbi.ts` | WBI 签名（弹幕/动态接口前置） | ⬜ |
| `src/sources/bili/auth.ts` | cookie 管理：`loadCookies`（cookies.json 整套字段，坏 JSON 启动即失败）/ `saveCookies`（扫码落盘，merge：新值覆盖、旧值兜底）/ `cookieHeader`（绝不进日志）/ `fetchSelf`（nav isLogin 心跳，-101 归一化为未登录） | ✅ |
| `src/sources/bili/qrcode.ts` | passport 扫码登录客户端：`generateQrcode` / `pollQrcode`（data.code 归一化 waiting/scanned/confirmed/expired，confirmed 从 Set-Cookie 提全套 cookie）；不走 biliRequest（要响应头） | ✅ 已实测（2026-08-03 真实扫码登录成功） |
| `src/sources/bili/followings.ts` | 分页拉 `x/relation/followings`（50/页，按 total 翻页，短页到底）；已实测 604 关注 13 页无需 WBI 签名 | ✅ 已实测 |
| `src/sources/bili/follows.ts` | `FollowsSource`：isLogin 心跳合并进同步周期（失效发一次 health_alert 并跳过，恢复复位；每轮 `onLoginState` 上报登录态供面板展示）→ 整轮成功才落库（单页失败整轮放弃，绝不清空）。关注**不自动入监听**：follows 表只是面板候选池，监听名单全由用户在面板管理；仅对已有 streamer 做空 face 回填 | ✅ 已实测 |
| `src/sources/bili/danmaku.ts` | 弹幕 WS，开播拉起、下播关闭；采样进分析队列 | ⬜ |
| `src/sources/bili/dynamic.ts` | 空间动态 → posts 表 + feed_post 信号 | ⬜ |
| `src/sources/weibo/feed.ts` | 微博时间线（config 配 `weiboUid` 映射） | ⬜ |
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
| `src/analysis/matcher.ts` | 确定性偏好匹配：preference_clauses × verdict → PushMessage（模板渲染/优先级/目标） | ✅ |
| `src/analysis/l0.ts` | L0 确定性分类器：标题/分区关键词 → SceneVerdict（与 LLM 同形），分析队列返回 null 时兜底 | ✅ |

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
| `src/notify/dispatcher.ts` | 并行 fan-out、notify_log 用 `msg.ref` 溯源、任一通道成功即标记。**待扩展**：通道级规则 | ✅ M1 版 |
| `src/notify/onebot.ts` | NapCat OneBot 11 HTTP；消息段数组；图片失败降级纯文本；每目标串行 + 1.2s 间隔 | ✅ **NapCat 未部署，未实测** |
| `src/notify/toast.ts` | powertoast 本机通知；兼作 NapCat 挂掉时的告警通道 | ✅ |
| `src/notify/ntfy.ts` | ntfy 兜底通道 | ⬜ |

### panel — 控制面板（localhost WebUI，v1）

| 文件 | 职责 | 状态 |
|---|---|---|
| `src/panel/server.ts` | `createPanelServer({ db, status, auth? })`：同进程 node:http，零框架零依赖，只绑 127.0.0.1；REST API 读写 streamers/follows/preference_clauses 三表 + `/api/status`（platforms/liveCount 新形状）；`/api/streamers` enrich（face + live 实况 + clauses 摘要，一次请求三表各查一次）；`/api/auth/bili/qrcode` + `/poll` 扫码登录（auth dep 存在才挂载，confirmed → saveCookies 落盘 → onCookiesSaved 热重启 follows）；cookie 值不进任何响应/日志 | ✅ v1 |
| `src/panel/http-util.ts` | 请求体解析（64KB 上限）、参数校验（400 + 中文错误）、JSON 响应 | ✅ |
| `src/panel/page.ts` | 内嵌单页 HTML 拼壳（原生 fetch，无 CDN 离线可用；dist 不拷静态文件故内嵌；脚本段内不得出现反引号与 `${`） | ✅ |
| `src/panel/page/` | 单页拆分：`style.ts` 样式 / `qr-lib.ts` 二维码库（base64 内嵌）/ `app-core.ts` 公共段 / `app-status.ts` 运行状态卡 + 扫码登录弹窗 / `app-streamers.ts` 主播卡片（实况展示）+ 详情弹窗（全字段编辑 + 子句 CRUD）+ 关注未监听区 | ✅ |

v1 范围：三卡片（运行状态 / 时间表占位 / 主播列表）；B站扫码登录（平台状态点：none/imported/ok/expired，弹窗出二维码轮询，确认后落盘热重启）；主播卡片实况（在播：关键帧/标题/分区/开播时长/在线；下播：下播时长锚点 last_live_at）；子句摘要（count + maxPriority）。v2 预留：verdicts 总览、时间表日历（M3）。

### 装配与基础设施（已实现）

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 装配入口 + CLI：`--dry-run` / `--test-notify` / `--probe` / `--force-uid`；`panel.enabled` 时起控制面板；follows source 单独持有（扫码登录后 `onCookiesSaved` 热重启，shutdown 停最新实例）；`onLoginState` → 面板平台状态 |
| `src/config/index.ts` | 读 `.env` + `config.json`（JSONC 注释、BOM 剥离），zod 启动即校验 |
| `src/config/schema.ts` | 配置 schema；秘密只在 `.env` / `cookies.json`。`subscriptions` 已迁库（streamers 表），仅作首次启动种子，可省略。`follows`：关注列表同步开关 + 间隔（默认 1800s，下限 300s）。`panel`：控制面板开关 + 端口（默认 8787，只绑 127.0.0.1）。待扩展：weiboUid 映射 |
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
npm test             # node --test（state/bus/pipeline/concurrency/streamers/db/live-status-source/auth/follows/qrcode/rules/config/l0/matcher/onebot/panel）
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
- **M2（规模化 + 内容判定）**：进行中。监听名单已迁库：`streamers` / `follows` / `preference_clauses` 三表 + CRUD + config 种子导入完成，source 名单改读 `listWatchedUids()`，测试全绿。**cookie 管理 + 关注列表同步已落地**：`auth.ts`（cookies.json 整套字段 + nav isLogin 心跳，端点 `x/web-interface/nav`，旧 `x/member/web/nav` 已 404）+ `FollowsSource`（心跳合并进同步周期、失效告警一次、单页失败整轮放弃；关注不自动入监听，follows 表仅作面板候选池），分页已实测（604 关注 13 页），测试全绿。**无 LLM 偏好执行链路已落地**：L0 关键词分类器（与 LLM 同形 verdict，队列返回 null 时兜底）→ matcher（子句 × verdict → 文案/优先级/目标）→ OneBot 按 `msg.targets` 定向 + `mode='silent'` 抑制推送（追踪照常），测试全绿。**控制面板 v0 已落地**：`src/panel/`（node:http 只绑 127.0.0.1，内嵌单页无依赖），名单三态/画像编辑、候选池一键加入、偏好子句 CRUD、系统状态展示，改库即生效无需重启，测试全绿。**控制面板 v1 已落地**：三卡片产品化展示（运行状态 platforms/liveCount、时间表占位、主播卡片实况）+ B站扫码登录（passport generate/poll，confirmed → saveCookies merge 落盘 → onCookiesSaved 热重启 follows source；`onLoginState` 心跳驱动平台状态点 none/imported/ok/expired）+ 主播卡片实况（room_state 展示列 + last_live_at 下播锚点 + clauses 摘要）。扫码链路已真实实测通过（2026-08-03：扫码 → 落 cookie → 热重启 → 心跳 ok → 604 关注同步入库）。后续：动态/微博源，见 design.md §6；面板 v2 = verdicts 总览、时间表日历（M3）
- **M3（预告时间表）/ M4（偏好与路由）/ M5（产品化）**：未开始
