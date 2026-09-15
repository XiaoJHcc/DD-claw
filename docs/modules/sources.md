# 抓取层（src/sources/）

持续生产：原始数据入库归档 + 变更信号上总线。source 不知道有 LLM（解耦点 1）；轮询循环只做「拉批量状态 + diff 产信号」两件便宜事。外部接口的坑（UA 必填、Referer、轮播状态等）一律查 [../boundaries.md](../boundaries.md) 第 5 节，本文不重复。

**全体源共同纪律**（各文件只记差异）：

- **拉取失败绝不能当成下播/清空**——保留旧数据，什么都不做。
- **健康告警**：单对象连续失败达阈值 emit 一次 `health_alert`；首轮失败记 firstFailTs，持续满 10 分钟（`STREAK_QQ_ALERT_AFTER_SEC`）再发一次（payload `durationAlert` + durationSec）；恢复复位。
- **登录态心跳折进轮询/同步周期**，不单独起任务；只有**运行中意外失效**（本进程内此前成功登录过）才发一次 `health_alert` 并跳过本轮，本来就没登录只记日志不告警；每轮 `onLoginState` 上报登录态供面板展示。
- cookie 绝不进日志/错误信息。

## 接口与公共件

| 文件 | 职责 |
|---|---|
| `src/sources/types.ts` | `Source` / `SourceContext` 接口：只产 Signal + 归档，不含通知逻辑 |
| `src/sources/bili/client.ts` | HTTP 层：强制注入 UA、超时重试、HTTP 错误与业务错误（`code != 0`）分层 |
| `src/sources/bili/types.ts` | B站接口返回类型 |
| `src/sources/bili/dm.ts` | dm 设备指纹参数（`dm_img_list` 高斯随机轨迹 + 两个静态 base64），算法出处 RSSHub `addDmVerifyInfo`；弹幕等风控接口复用 |
| `src/sources/bili/wbi.ts` | ⬜ 目标（待启动）。WBI 签名仅弹幕 WS 前置需要；动态接口实测不需要，勿为此实现 |

## B站 直播间状态

- `src/sources/bili/live-status.ts` — 批量 `get_status_info_by_uids`（POST，50/片，非逐个轮询）；缺 key = 未开播，不是失败。
- `src/sources/bili/live-status-source.ts` — 轮询 + diff + 批量落状态 + `coldStart` 标记（`first_run` / `new_subscription` / 重启恢复 `restart_recovery`）+ 健康计数发 `health_alert`（共同纪律）；face / roomId 空值回填（已有值不覆盖）；`saveRoomStates` 同事务点 `touchLiveSessions` 存活打点（在播条目刷 last_seen + 非空 keyframe 覆盖）。
- `src/sources/bili/danmaku.ts` — ⬜ 未实现。弹幕 WS：开播拉起、下播关闭；采样进分析队列。

## B站 凭据与关注列表

- `src/sources/bili/auth.ts` — cookie 管理：`loadCookies`（cookies.json 整套字段，坏 JSON 启动即失败）/ `saveCookies`（扫码落盘，merge：新值覆盖、旧值兜底）/ `cookieHeader` / `fetchSelf`（nav isLogin 心跳，-101 归一化为未登录）。
- `src/sources/bili/qrcode.ts` — passport 扫码登录客户端：`generateQrcode` / `pollQrcode`（data.code 归一化 waiting/scanned/confirmed/expired，confirmed 从 Set-Cookie 提全套 cookie）；不走 biliRequest（要响应头）。
- `src/sources/bili/followings.ts` — 分页拉 `x/relation/followings`（50/页，按 total 翻页，短页到底）；实测 604 关注 13 页无需 WBI 签名。
- `src/sources/bili/follows.ts` — `FollowsSource`：登录态心跳合并进同步周期（共同纪律）→ **整轮成功才落库**（单页失败整轮放弃，绝不清空）。关注**不自动入监听**：follows 表只是面板候选池，监听名单全由用户在面板管理；仅对已有 streamer 做空 face 回填。

## B站 空间动态

- `src/sources/bili/dynamic.ts` — `DynamicSource`：空间动态轮询（`feed/space`，全量 cookie + dm 三参 + space Referer，**无 WBI**；mapLimit(2) 逐 uid）→ posts 表归档（UNIQUE 去重）→ 新帖 emit `feed_post`（payload 带 post 摘要）。登录态心跳折进轮询周期（共同纪律；follows.enabled=false 时这是 B站登录态唯一来源）；每 uid 首轮静默归档；拉取失败保留旧数据；无 cookie 不启动，随 follows 热重启。`parseDynamicItem`：LIVE_RCMD 二次解析 live_play_info / WORD / DRAW（opus pics、draw items）/ AV / FORWARD（拼「//转发自 @xx」摘要）。

## 微博

- `src/sources/weibo/feed.ts` — `WeiboFeedSource`：时间线轮询（`ajax/statuses/mymblog`，桌面 UA + `Referer: /u/<uid>` + 全量 weibo cookie；对象 = watch=1 且 weiboUid 非空，mapLimit(2)）→ posts 表归档（`platform='weibo'`，posts.uid 存监听名单 uid 供第三栏混排，微博 uid 只用于拉取与拼 url）→ 新帖 emit `feed_post`。登录态心跳折进同步周期（`fetchWeiboSelf`，失效跳过整轮，共同纪律）；每 uid 首轮静默归档；失败纪律同 dynamic。`parseMblog`：text_raw 纯文本 / retweeted_status 转发拼「//转发自 @xx」（被删残桩不炸）/ pics large.url / created_at Date.parse 转秒 / isLongText 补 `ajax/statuses/longtext`（失败用截断兜底不算错误）。
- `src/sources/weibo/qrcode.ts` — passport sso/v2 扫码客户端：`generateQrcode`（**必须带 `Referer: https://weibo.com/` 否则 403**，image 是 png 直链面板直接 `<img src>`）/ `pollQrcode`（retcode 归一化：20000000=confirmed、50114001=waiting 已实测；50114002=scanned、其他 50114xxx=expired 防御式映射）/ `exchangeCookies`（confirmed 的 data.url 起跟 302 链收集 Set-Cookie 换全套 cookie，3xx 时 res.ok=false 勿当错误）；fetch 可注入。
- `src/sources/weibo/auth.ts` — weibo-cookies.json 管理：`loadWeiboCookies`（坏 JSON 启动即失败）/ `saveWeiboCookies`（merge：新值覆盖、旧值兜底）/ `weiboCookieHeader` / `fetchWeiboSelf`（`ajax/log/action` 看 X-Log-Uid 响应头，异常与缺头归一化为未登录）。
- `src/sources/weibo/resolve.ts` — 昵称→UID 解析（匿名访客通道：genvisitor 拿 tid → incarnate 拿 SUB/SUBP → `m.weibo.cn/n/<昵称>` 302 /u/<uid>；cookie 模块级缓存、失效自动重建重试一次；fetch 可注入）。

## 媒体

- `src/sources/media/keyframe.ts` — `KeyframeCache`：在播直播间关键帧定时本地缓存（积累判定素材，供后续人工/LLM 对照分类正确性）。
  - `consider(live)` 每轮由 live-status source 喂同一份在播数据：同步返回、内部 mapLimit(2) 异步下载，**绝不阻塞轮询**；同一场 (roomId, liveTime) 距上次**尝试**不足 intervalMs 跳过（失败也记，不重试轰炸）；下播场次清出内存表防无限增长。
  - 下载 UA+Referer / 8s 超时 / 10MB 防御上限 / content-type 定扩展名；**内容 md5 去重**（与上一帧相同直接丢弃不写盘，不按 URL 判）；失败仅 log.debug。
  - 落盘 `<dir>/<roomId>/<liveTime>/<ts>.jpg` + `insertSnapshot` 入库；**库内 path 存相对 `<dir>` 的相对路径，分隔符恒为正斜杠**（绝不用 join()，Windows 反斜杠换机后全 404；存量收敛用一次性命令 `migrate:snapshots-path`）。
  - **开关/间隔事实来源 = settings（RuntimeConfig）**：`configure({enabled, intervalMs})` 热生效——关闭只是 consider no-op，去重/间隔记忆保留，重开不炸量。**暂不清理**，体积用户已接受。

实现现状总览见 [../status.md](../status.md)；信号编排与归档分派在 [core 模块](core.md) 的 pipeline。
