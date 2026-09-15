# DD-claw

监听用户在面板选定的B站主播（关注列表同步作候选池，直播间 + B站动态 + 微博）→ 持续状态追踪 → LLM 分析（内容分类 / 预告时间表 / 偏好推送词）→ 按优先级路由推送（QQ 群 / 私聊 / 本机 Toast）。

**规模假设**：关注上百位、高峰 30+ 同时在播、信号是持续状态而非一次性事件、偏好用自然语言描述。这四条决定了架构，**改代码前先读 `docs/design.md` 第 1、4 节**。

## 架构：三段解耦

```
─ 1. 抓取  src/sources/   持续生产：原始数据入库归档 + 变更信号上总线
│           bili/live-status  批量轮询（50/片 POST，非逐个）       [已实现]
│           bili/follows      关注列表同步（SESSDATA）           [已实现]
│           bili/dynamic      空间动态（cookie，无 WBI）          [已实现]
│           weibo/feed        微博时间线（cookie）               [已实现]
│           media/keyframe    在播关键帧定时本地缓存              [已实现]
│           bili/danmaku      弹幕 WS 按需拉起                   [未实现]
│                            ↓
│   core/db  原始归档（signals/posts/snapshots/follows，供反复分析）
│   core/bus 变更信号（live_start / feed_post / …）
│                            ↓
├─ 2. 分析  src/analysis/  LLM 即任务：schema 进 JSON 出
│           queue      分析队列：限流（并发 2）                [已实现]
│           classifier RulesClassifier：LLM 优先 + 回退确定性  [已实现]
│           tasks/     classify（单次批量 LLM 分类）；matcher 确定性匹配
│           providers  熔断 + 多 key 池 + 降级链                [已实现]
│           （triggers / context / schedule-extract 未实现）
│                            ↓ 判定结果入库（verdicts/schedules）
├─ 护栏 src/rules/      确定性过滤，不经过 LLM：静音、静默时段、每场一次、冷却
│                            ↓
│              PushDirective { priority, targets[], message, image? }
│                            ↓
└─ 3. 推送  src/notify/    只执行：按 targets 路由 + 通道级规则（群×主播屏蔽、
            丢弃低优先级）+ 发送。通道实现 Notifier 即可增删：
            onebot(NapCat) [已实测] / toast [已实现] / ntfy [未实现]
```

**三个解耦点，改代码不要破坏：** ① **Signal 总线**（抓取→分析）：source 不知道有 LLM。② **任务化 LLM 接口**（分析内部）：schema 进 JSON 出，换模型只动 providers。③ **PushDirective**（分析→推送）：推送层不解释语义。

**偏好归属（已决策，2026-08-09 修订）**：人类需求是唯一锚点信源——用户面板直填**推送规则**（push_rules v2：分类引用〔空 = 任意开播〕× 生效主播〔空 = 全部，含未来新增〕→ 渠道 + 推送词），matcher 确定性执行；LLM 只做**内容分类**（本场属于哪些分类，入 verdicts）。分类口径也由人填（categories：LLM 提示词 + 确定性关键词/分区条件）：有提示词且 LLM 可用以 LLM 为准，LLM 关/熔断/失败回退确定性条件，无提示词永远确定性。不做 NL→结构化编译，运行管线无人工环节；rules 只做护栏，notify 只做路由。细节见 `docs/design.md` §4。

**高峰并发原则**：轮询循环只做「拉批量状态 + diff 产信号」两件便宜事；所有 LLM 调用进 `analysis/queue`，通知不等分析结果。

## 关键接口

| 接口 | 位置 | 约定（细节见 `docs/design.md` §6） | 状态 |
|---|---|---|---|
| `Signal` / `LiveEvent` / `PushMessage` | `src/core/types.ts` | 事件载荷；`LiveEvent.classifications` 仅 live_start 由分析队列填充、其余恒空；notify 只认 `PushMessage`，`channels` 存在时 dispatcher 按 push_channels 路由 | ✅ |
| `Classifier.classify(ctx)` | `src/analysis/types.ts` | 返回 `Classification[]`（非 live_start 为 `[]`）；实现自行入 verdicts | ✅ RulesClassifier |
| `LlmTask<I,O>` | `src/analysis/types.ts` | zod schema 进，JSON 出 | ✅ 类型占位 |
| `DecisionRule.decide(event, signal, classifications?)` | `src/rules/types.ts` | 去重/护栏属于这层，不要塞到 Classifier 之前；第三参可空数组 | ✅ M1 版 |
| `PushDirective` | 待定（rules 或 notify types） | 分析→推送指令；⬜ 未实现，角色现由 pipeline `buildMessage` 产 `PushMessage` 承担 | ⬜ |
| `Notifier.send(msg)` | `src/notify/types.ts` | 载荷是 `PushMessage`；`capabilities` 声明能否带图；`alert()` 供健康告警（当前仅 toast） | ✅ |

## 文件地图

一行一文件（`路径 — 职责`）；「改前必知」与深度笔记见 `docs/modules/`，未实现占位见 `docs/status.md`。测试与被测同目录（`*.test.ts`）不逐列。

### core / config / logger

- `src/core/types.ts` — 领域类型 + `toLiveEvent` + 告警阈值常量
- `src/core/bus.ts` — 类型化信号总线（handler 异常隔离）
- `src/core/state.ts` — `diffRoom → Signal`；轮播=未开播；title_change=标题/分区变更
- `src/core/scheduler.ts` — `PeriodicTask` 通用周期任务器
- `src/core/pipeline.ts` — **信号编排唯一装配点**（归档→抑制→分析→护栏→规则→推送）
- `src/core/db.ts` — SQLite 十三表 + 仓储；`ensureColumn` 在线补列
- `src/core/streamers.ts` — streamers / follows 行类型与映射
- `src/core/push.ts` — push_channels / categories / push_rules / verdicts 行类型与映射
- `src/core/posts.ts` — posts 行类型与映射（pics JSON）
- `src/core/listen.ts` — 监听功能开关（settings `listen_<feature>`）
- `src/core/runtime-config.ts` — 运行时参数（settings 唯一信源）
- `src/core/onboarding.ts` — 首启默认值种入（一次性闸门）
- `src/core/onboarding-defaults.gen.ts` — 构建期生成物（勿手改）
- `src/core/concurrency.ts` — `mapLimit` 有界并发
- `src/config/index.ts` — 读 `.env` + `config.json`（只有 panel 段生效）
- `src/config/schema.ts` — panel 校验 + provider schema + 默认配置
- `src/logger.ts` — 极简结构化日志

### sources — 抓取

- `src/sources/types.ts` — `Source` / `SourceContext` 接口
- `src/sources/bili/client.ts` — HTTP 层（UA、超时重试、错误分层）
- `src/sources/bili/types.ts` — B站接口返回类型
- `src/sources/bili/live-status.ts` — 批量 `get_status_info_by_uids`（50/片）
- `src/sources/bili/live-status-source.ts` — 轮询 + diff + coldStart + 健康计数
- `src/sources/bili/auth.ts` — cookies.json + nav 心跳（不进日志）
- `src/sources/bili/qrcode.ts` — passport 扫码客户端（要响应头）
- `src/sources/bili/followings.ts` — `x/relation/followings` 分页（50/页，无 WBI）
- `src/sources/bili/follows.ts` — `FollowsSource`（正轮成功才落库；不自动入监听）
- `src/sources/bili/dynamic.ts` — `DynamicSource`：`feed/space`（无 WBI）→ posts
- `src/sources/bili/dm.ts` — dm 设备指纹参数（RSSHub 算法）
- `src/sources/media/keyframe.ts` — `KeyframeCache`（md5 去重、相对路径入库）
- `src/sources/weibo/feed.ts` — `WeiboFeedSource`：mymblog 轮询
- `src/sources/weibo/qrcode.ts` — 微博扫码（generate 必须带 Referer）
- `src/sources/weibo/auth.ts` — weibo-cookies + `X-Log-Uid` 心跳
- `src/sources/weibo/resolve.ts` — 昵称→UID 匿名解析链

### analysis / rules

- `src/analysis/types.ts` — `Classifier` / `Classification` / `AnalysisContext` / `LlmTask`
- `src/analysis/classifier.ts` — `RulesClassifier`（LLM 优先 + 确定性回退，入 verdicts）
- `src/analysis/queue.ts` — 分析队列（限流并发 2）
- `src/analysis/providers.ts` — LLM provider（路由/熔断/多 key/双协议）
- `src/analysis/tasks/classify.ts` — 单次批量 LLM 分类任务
- `src/analysis/matcher.ts` — 确定性匹配（`matchCategory` / `matchPushRules` / `renderTemplate`）
- `src/rules/types.ts` — `DecisionRule` / `NotifyDecision`
- `src/rules/once-per-session.ts` — 每场直播推一次

### notify — 推送

- `src/notify/types.ts` — `Notifier` 接口
- `src/notify/message.ts` — `liveEventToMessage()`（不用 emoji）
- `src/notify/dispatcher.ts` — fan-out + 渠道路由 + `alertAll`
- `src/notify/onebot.ts` — NapCat OneBot 11 HTTP（串行 + 1.2s；无 alert）
- `src/notify/napcat.ts` — NapCat 通道 + 失活自动拉起（双平台、端口条目自管）
- `src/notify/toast.ts` — 本机通知（健康告警唯一通道）
- `src/notify/mac-notifier.ts` — macOS 原生 helper（失败回落 osascript）
- `src/notify/aumid.ts` — Win32 AUMID 注册
- `src/notify/image-cache.ts` — toast 图片本地化

### panel / mcp

- `src/panel/server.ts` — node:http + 静态内嵌 + `/api/*` + `/mcp`
- `src/panel/http-util.ts` — 解析/校验/响应 + 面板与 MCP 共用逻辑
- `src/panel/schedule.ts` — 时间表查询（北京 06:00 日界）
- `src/panel/webui-assets.gen.ts` — 构建期生成物（勿手改）
- `src/mcp/auth.ts` — token 模型 + `resolveMcpAuth`
- `src/mcp/tools.ts` — 工具注册表（按角色）
- `src/mcp/handler.ts` — `/mcp` 无状态处理
- `src/mcp/rate-limit.ts` — gateway 写限流
- 细节见 `docs/modules/panel.md`、`docs/mcp.md`

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
- 配置错误**启动即失败**并指明字段；拉取失败**绝不能当成下播**（保留旧状态，什么都不做）
- **不做任何写操作**（不发弹幕、不点赞）；匿名接口优先，需凭据的功能由用户显式导入 cookie 后才启用
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
npm run test-notify  # 假事件走完整推送链路，验证 NapCat/Toast 配置
npm run napcat-setup # 一次性创建 NapCat 最高权限计划任务（弹一次 UAC）并开启自动拉起
npm run migrate:snapshots-path # 一次性迁移 snapshots.path（换机后跑一次；幂等）
npm run mcp-token    # MCP 令牌管理：list / add <名字> <admin|gateway> / remove <名字>
npm run demo:fixtures # 真实库 → webui/demo/fixtures.json（已存在须 --force）
```

手动验证：`--dry-run`（只打日志不真发）、`--test-notify`、`--force-uid <uid>`（监听正在直播的房间，立刻触发真实全链路）。

## 实现现状

- **M1 ✅** 开播通知（NapCat/Toast 已实测）；**M2 ✅** 规模化 + 内容判定（名单迁库 / 扫码登录 / 动态 / 微博 / LLM 分类管线 / 推送规则 v2 / 面板 v1+v2）
- **M3 过半**：时间轴统计 ✅；预告解析（schedule-extract → schedules）与到点推送未做　**M4 / M5 未开始**
- 逐项明细见 `docs/status.md`

## 文档索引

- `docs/design.md` — 总体设计：规模假设、三段架构、数据结构、里程碑 M1-M5、待定项
- `docs/status.md` — 实现现状：里程碑 + 模块两视图、未实现清单
- `docs/boundaries.md` — 能力边界：匿名可得 / 需凭据 / 做不到，已知踩坑清单
- `docs/modules/` — 模块实现笔记：core / sources / analysis / notify / panel（逐文件职责与「改前必知」）
- `docs/mcp.md` — MCP 接口：令牌、角色权限、Host 配置、安全模型与 v2 预留（MaiBot 不直连）
- `docs/plan/agent-access.md` — 多前端接入统一计划：一个能力面 N 种接线 + 信任模型矩阵 + 分期 P1-P3
- `docs/research/` — 分模块调研归档（live-status、danmaku、feeds、llm、notify、media-capture、auth-cookie、ts-stack）