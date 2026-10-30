# sources — 抓取层

持续生产两件事：原始数据/状态**归档入库** + 变更信号**上总线**；直播通知的抑制、每场一次与告警派发政策在下游。本目录保留归档去重、增量与补推轮次选择，依据统一领域定义决定哪些新内容发信号。外部接口的参数坑（UA / Referer / 轮播 / dm 指纹 / 扫码 retcode 等）唯一信源是 [docs/boundaries.md](../../docs/boundaries.md) 第 5 节，本目录与 [docs/modules/sources.md](../../docs/modules/sources.md) 都不复述。

## 长期不变量

- **失败不覆盖成功结果**：拉取失败既不是下播也不是「没有新内容」——不得改写已归档的内容、已确认的状态与游标，也不得为失败账号发 `feed_post`。允许回写失败诊断（`fetch_fail_since` / `fetch_error`、运行状态快照），但不得伪造最近成功时间；同一轮里成功的账号照常归档、发信号、前进游标。
- **故障两级**，判据是「本轮全灭还是个别账号」：一轮全灭 = **链路级**（风控 / 代理 / 登录链路），聚合成一条 `health_alert`（本机 toast）；个别账号失败 = **账号级**，不推送、不告警，持续满阈值落库 `fetch_fail_since` / `fetch_error` 给面板账号卡。
- **告警两级都是时间口径**：链路故障持续满 `health_alert_toast_after_sec` 报本机 toast，满 `STREAK_QQ_ALERT_AFTER_SEC` 再发一次 `durationAlert`（pipeline 据政策报 QQ）。轮数口径会随轮询间隔倒挂两级顺序，不要退回轮数。
- **登录态心跳折进轮询/同步周期**，不单独起任务；只有**运行中意外失效**（本进程此前成功登录过）才告警一次并跳过本轮，本来没登录只记日志。每轮 `onLoginState` / `onStatus` 上报状态供面板展示。
- **cookie 绝不进日志或错误文本**；凭据只存在于 `cookies.json` / `weibo-cookies.json`。
- **平台事实不可由用户任意覆盖**：昵称 / 头像 / 游标 / 心跳由来源维护，已有值不回退成空；添加时允许微博昵称作为解析键、X verify 结果种入昵称，更新阶段仍锁定平台身份与昵称。
- **图文轮次与补推只调 `core/backlog.ts`**：主动关闭恢复轮（`silent_next`）一律静默、缺口轮受开关与时间窗 + 条数双封顶、正常轮全推；归档永不缺席。源内不得自造一套判断。
- **B站动态的轮询集合与信号面是两条不同的集合**：轮询对象 = `listWatchedUids()` ∪（图文开关开着时的）`bili_accounts` 启用账号；`feed_post` **只对名单账号发**，监听主播的动态只归档（是预告分析的数据源，不进图文推送）。
- **`DYNAMIC_TYPE_LIVE_RCMD` 彻底舍弃**（不归档、不发信号）；`FORWARD` 在 source 内归一成三平台共用的 `retweet`——matcher 只认这个值。
- **X 的一切出网经 `core/proxy.ts` 隧道**（Node 22 原生 fetch 不认代理），主路线 Nitter RSS、免登录 HTML 作回退；链路中断走 **canary 退避**（每轮只探第一个账号，通了当轮立刻恢复全量）。
- **关键帧缓存不阻塞轮询**：按「尝试时间」节流（失败也记，不重试轰炸）、按**内容 md5** 去重（不按 URL 判）、路径相对且正斜杠。
- **头像本地化按图床选路**：B站 `hdslb` / 微博 `sinaimg` 境内直连，X `pbs.twimg.com` 必须经隧道。

## 文件地图

**接口与公共件**
- `types.ts` — `Source`（`start` / `stop`）/ `SourceContext`（bus / db / config）：只产 Signal + 归档，不含通知逻辑。
- `bili/client.ts` — B站 HTTP 层：强制 UA、超时重试、HTTP 错误与业务错误（`code != 0`）分层。
- `bili/types.ts` — B站接口返回类型（`RoomStatus` 是 `LiveStatus` 的扩展）。
- `bili/dm.ts` — dm 设备指纹参数（高斯轨迹 + 静态 base64），风控接口复用。
- `bili/avatar.ts` — B站头像本地化（直连，md5 文件名入库）。

**B站 直播间状态与时间轴素材**
- `bili/live-status.ts` — 批量 `get_status_info_by_uids`（分片请求，非逐个轮询）；缺 key = 未开播，不算失败。
- `bili/live-status-source.ts` — 轮询 + `diffRoom` + 批量落状态 + `coldStart` 标记 + 两级告警；顺手回填空的 face / roomId；在播场次每轮打 `last_seen` 存活点并喂关键帧缓存；重启首轮才发现的 `live_end` 标 `endObserved=false`（真实下播时间未知），成功抓取同时推进服务心跳。
- `media/keyframe.ts` — `KeyframeCache`：在播直播间定时抓关键帧落盘入库（判定素材），开关/间隔走 settings 热生效。

**B站 凭据 · 关注 · 动态**
- `bili/auth.ts` — cookies.json 读写（坏 JSON 启动即失败）+ nav 登录态心跳。
- `bili/qrcode.ts` — passport 扫码客户端（要响应头，不走 `client.ts`）。
- `bili/followings.ts` — 关注列表分页拉取（按 total 翻页、短页到底）。
- `bili/follows.ts` — `FollowsSource`：整轮成功才落库；关注**不自动入监听**，只对已有主播补空 face。
- `bili/dynamic.ts` — `DynamicSource`：空间动态轮询（全量 cookie + dm 三参 + space Referer）→ posts 归档 → 名单账号发 `feed_post`；回写名单账号 uname / 心跳 / 头像；`kickAccount` 添加后即时首拉。

**微博（图文来源）**
- `weibo/feed.ts` — `WeiboFeedSource`：mymblog 时间线轮询 → posts 归档 → `feed_post`；长文补全、转发拼接、`pic_infos` 两形态取图、游标与昵称回写、运行状态快照。
- `weibo/auth.ts` — weibo-cookies 读写 + `X-Log-Uid` 心跳。
- `weibo/qrcode.ts` — passport sso/v2 扫码（generate 必须带 Referer）+ 302 链换 cookie。
- `weibo/resolve.ts` — 昵称↔UID 匿名解析链（访客 cookie 缓存、失效重建重试一次）。
- `weibo/avatar.ts` — 微博头像本地化（直连 sinaimg，md5 文件名入库）。

**X / 推特（图文来源）**
- `twitter/feed.ts` — `TwitterFeedSource`：Nitter RSS 主路线 + 免登录回退、逐账号拉时间线 → posts → `feed_post`；链路 canary 退避、账号级故障落库、头像与昵称回写。
- `twitter/nitter.ts` — Nitter RSS 解析（唯一能区分原创/转发的免登录路线），多实例轮询。
- `twitter/web.ts` — 免登录回退：`x.com` HTML 发现推文 id + 单推接口补详情；账号存在性校验。
- `twitter/probe.ts` — X 连通性探测（代理 → 实例 RSS → 免登录回退），面板测试按钮与 `npm run probe-x` 共用。
- `twitter/avatar.ts` — X 头像本地化（隧道下载，md5 文件名入库）。

未落地能力与文件规划见 [docs/status.md](../../docs/status.md)。
