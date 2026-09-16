# DD-claw 实现现状

本文件回答「做到哪了」。设计意图（含里程碑目标与验收）见 [design.md](design.md) §8，逐文件职责见 [AGENTS.md 文件地图](../AGENTS.md#文件地图)，分模块实现细节见 [modules/](modules/)。

## 里程碑视图

| 里程碑 | 状态 | 说明 |
|---|---|---|
| M1 开播通知 | ✅ | 批量轮询 + 状态机 + OncePerSession + OneBot/Toast 全链路；NapCat/Toast 已实测（`--test-notify` 私聊带图发送成功、notify_log ok=1） |
| M2 规模化 + 内容判定 | ✅ | 名单迁库 / 扫码登录 / 关注同步 / 空间动态 / 微博 / LLM 分类管线 / 推送规则 v2 / 面板 v1+v2，详见下表 |
| M3 预告时间表 | 过半 | **时间轴统计已落地**；预告解析（schedule-extract → schedules 表）与「预定时间到」推送**未做**；前置 = 分析触发层能消费 `feed_post` |
| M4 偏好与路由 | 部分 | `matcher` + `push_rules` v2 已落地；剩余 = 可选推送时机 + 优先级（待产品方案） |
| M5 产品化 | 未开始 | 面板 v0/v1/v2 已提前在 M2 落地，不计入 |

### M2 已落地（按能力）

| 能力 | 关键实现 |
|---|---|
| 名单迁库 | `streamers` / `follows` 两表 + CRUD + config 种子导入；source 名单改读 `listWatchedUids()`（过滤非纯数字 uid） |
| 凭据与登录 | B站 `auth.ts`（cookies.json + nav isLogin 心跳）+ passport 扫码；微博 `weibo/auth.ts` + sso/v2 扫码 + 换票落盘；均真扫实测 |
| 关注列表同步 | `FollowsSource`：604 关注 13 页、无需 WBI；关注不自动入监听 |
| B站空间动态 | `DynamicSource`：全量 cookie + dm 三参 + space Referer、**无需 WBI**；22 uid 全量归档零 412 |
| 微博时间线 | `WeiboFeedSource`：mymblog 轮询、转发/长文补全、登录态心跳；真扫全链路实测 |
| 关键帧缓存 | `KeyframeCache`：在播定时本地缓存、md5 去重、相对路径入库、开关热生效 |
| LLM 接线 | `providers.ts`：text/vision 路由 + 熔断 + 多 key 池 + structuredOutput 三档 + chat-completions/responses 双协议；provider 名单与 key 面板管理 |
| 内容分类管线 | `tasks/classify.ts` 单次批量 LLM + `RulesClassifier`（LLM 优先 / 确定性回退）→ `verdicts` 表；仅 live_start 烧 LLM |
| 推送规则 v2 | `categories` + `push_rules` v2 + `matcher`（全部命中独立生效、渠道并集去重、无命中不推）+ dispatcher 按 `PushMessage.channels` 路由 |
| 控制面板 | v1（卡片 + 扫码 + 主播实况）→ v2（边栏三视图 + 设置六卡 + 时间表；2026-09-03 UI 重设计 v2 平移定稿） |
| NapCat 托管 | 专属端口条目自管 + 三态探测看门狗 + 双平台自动拉起（Windows 计划任务 / macOS `open -a QQ --qq <uin>`） |
| 健康告警 | 收敛到本机 toast；QQ 只报 login_drop 与持续失败满 10 分钟，目标 settings `napcat_alert_qq` |
| 时间轴统计 | `live_segments` 内容变更切段 + `GET /api/schedule`（北京 06:00 日界）+ 面板 5 天滑动窗口泳道 |

## 模块视图

| 模块 | 状态 | 实现笔记 |
|---|---|---|
| core（总线/状态/归档/装配） | ✅ | [modules/core.md](modules/core.md) |
| sources（B站 / 微博 / 媒体） | 直播间状态 / 关注 / 动态 / 微博 / 关键帧 ✅；弹幕 WS ⬜ | [modules/sources.md](modules/sources.md) |
| analysis + rules | 分类管线 ✅；triggers / context / schedule-extract 为目标 ⬜；preference 护栏已放弃 ❌ | [modules/analysis.md](modules/analysis.md) |
| notify | onebot(NapCat) / toast ✅（ntfy 已放弃 ❌） | [modules/notify.md](modules/notify.md) |
| panel + webui | ✅（verdicts 总览、预告条预留） | [modules/panel.md](modules/panel.md) |
| mcp | ✅ v1（admin / gateway 双角色） | [mcp.md](mcp.md) |

## 未实现清单

**未建文件（目标 / 待启动）**

| 文件 | 规划职责 |
|---|---|
| `src/sources/bili/danmaku.ts` | 弹幕 WS 按需拉起/关闭、采样进分析队列 |
| `src/sources/bili/wbi.ts` | WBI 签名，仅弹幕 WS 前置需要（动态接口勿为此实现） |
| `src/analysis/triggers.ts` | **分析触发**：哪些信号送进 LLM（开播 / 新动态 / 直播中抽查 / 定时全量） |
| `src/analysis/context.ts` | 按房间聚合时间窗内多源数据 → 一份 context（喂给分类 prompt） |
| `src/analysis/tasks/schedule-extract.ts` | 预告解析 → schedules 表（置信度入库，阈值过滤） |
| `src/sources/twitter/{nitter,web,feed}.ts` | ~~**X/推特图文源**~~ **P1 已落地**（Nitter RSS 主 + 免登录回退 `web.ts` + 源 `feed.ts`）；计划见 [plan/twitter-source.md](plan/twitter-source.md) |
| `src/core/post-rules.ts` | ~~图文帖规则表~~ **P2 已落地**（与 push_rules 平行的第 15 张表 + filters 语义） |
| `src/analysis/tasks/translate.ts` | 推文翻译（`LlmTask`），X 链路可选判定（P3） |

**未落地能力**

- `schedules` 表未建（目标）；`signals` 表已放弃（见 `design.md` §11）
- **X/推特：P0+P1+P2 已落地**（隧道 fetch、`/api/x*`、独立分页、免登录源 Nitter RSS + 回退、`x_accounts` 独立名单、监听开关 `listen_twitter`、`post_rules` 图文帖规则 + `feed_post` 推送分支（X 图经代理本地化后交 NapCat）、MCP 工具）；**待做**：P3 LLM 判定/翻译（规则级开关、失败回退机械筛选）
- verdicts 总览 UI；预告半透明条与「预定时间到」推送
- dispatcher 通道级规则（群 × 主播屏蔽、优先级阈值）：待产品方案，机制不预设
- 其余已放弃 / 不采用方案见 `design.md` §11