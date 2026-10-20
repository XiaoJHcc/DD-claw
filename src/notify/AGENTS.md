# notify — 推送执行

轴 A 的第三段：**只执行，不解释语义**。载荷永远是 `PushMessage`——notify 不认识 `LiveEvent`，也不认识分类与规则。渠道路由、告警政策、降级细节的机制与排障见 [docs/modules/notify.md](../../docs/modules/notify.md)；装配与热生效见 [../core/AGENTS.md](../core/AGENTS.md)。

## 长期不变量

- **唯一语义投影点在 `message.ts`**：`liveEventToMessage` / `postToMessage` 把领域事件翻成 `PushMessage`，通道实现只消费 `PushMessage`。新增通道不需要理解直播或帖子。
- **文案不用 emoji**（QQ iOS 气泡渲染会把增补平面 emoji 拆成两个方框）；分区 · 开播时间这类辅助信息进 `attribution`，头像进 `icon`，正文只留标题 / 帖子正文。
- **路由只看 `msg.channels`**：存在时查 `push_channels` 取「被选中且启用」的渠道按 notifier 分组，onebot 组解析成 `msg.targets`，没有选中渠道的通道跳过；`msg.channels` 缺省（告警、`--test-notify`）才是全通道旧行为。**通道没有独立启停开关**，启停走 `push_channels.enabled`。
- **`notify_log` 用 `msg.ref` 溯源**；投递结果是逐渠道逐目标的 `deliveries`，任一成功即算发出（pipeline 据此标记本场已推并写审计）。
- **健康告警分两条腿**：`alertAll` 只派发给实现了 `alert()` 的通道（当前仅 toast）；QQ 告警由 pipeline 按政策判定后在 `qqTarget` 里带目标，走 `onebot.send` 私聊点对点。**onebot 不实现 `alert()`**——次数阈值类告警从不发 QQ。
- **本地图片必须 base64 内嵌，绝不 `file://`**：沙盒 QQ 对本进程数据目录无读权限（`EPERM`）。公网可达的 B站 CDN 图直接给 URL 让 NapCat 自己拉，只有本地文件（X 图经隧道下载、关键帧缓存）才内嵌。
- **同目标串行 + 最小间隔**：QQ 群主动推送有分钟级限流，每目标一条串行链；带图失败降级纯文本重试**只在请求真的到达 NapCat 时**做——连不上时去掉图必然同样失败。
- **NapCat 只自管 `dd-claw` 那一条 httpServers 条目**：缺了自建、被禁用启用、端口被占换端口；其他条目原样保留。端点发现按名匹配，`0.0.0.0` / `::` 归一化回环。
- **拉起是双闸门**：「失活自动拉起」开关（每 tick 热读）+ 拉起能力就绪（任务 / 安装存在）。关 = 只探测、告警、热跟随端点，绝不拉起；**任务生命周期 = 开关**（开时创建、关时删除）。
- **平台差异只在驱动里**：Windows 走最高权限计划任务（一次性 UAC 建拉起 + 停止双任务），macOS 走 `open -a QQ --args --no-sandbox --qq <uin>` 快速登录；探测 / 执行 / 时钟全可注入。
- **Win32 身份限制是既成事实**：AUMID .lnk 缺失时用 PowerShell COM 注册（脚本必须 UTF-8 BOM + `STGM_READWRITE`），注册失败回落默认 Store 身份、通知照发；Win32 身份不支持远程图，http 图先本地化，失败按无图发。macOS 用 Swift helper 拿正确应用名与点击跳转，`swiftc` 不可用才回落 osascript（无应用名 / 无点击 / 无图）。

## 文件地图

- `types.ts` — `Notifier`：`send(PushMessage)` + `capabilities`（图片 / 点击跳转）+ 可选 `alert()`。
- `message.ts` — 领域事件 → `PushMessage` 的唯一投影（直播事件；图文帖按三平台各自的措辞与后缀）。
- `dispatcher.ts` — fan-out + 渠道路由 + 逐目标投递记录 + `dryRun`；`alertAll`；`setNotifiers` 装配级替换。
- `onebot.ts` — NapCat OneBot 11 HTTP：消息段拼装、本地图 base64、逐目标串行 + 1.2s、带图失败降级、`retcode != 0` 判失败、`updateEndpoint` 热跟随；`sendText` 是 QQ 渠道回执路径。
- `napcat.ts` — NapCat 托管：配置（settings 唯一信源）、专属条目自管、三态探测、`NapcatWatchdog` 状态机、双平台拉起驱动（计划任务 / `open -a QQ`）、告警 QQ 目标读取。
- `toast.ts` — 本机系统通知（Win32 powertoast + `aumid` / heroImg / icon / attribution；macOS 原生 helper），实现通用 `alert()`；特定 QQ 告警仍由 pipeline 单独路由。
- `mac-notifier.ts` — macOS 原生 helper（Swift 编译成 `DD-claw.app`，落 data 目录、幂等缓存；发出后常驻等点击）。
- `aumid.ts` — Win32 AUMID 注册（调 `scripts/register-aumid.ps1`，失败回落默认身份）。
- `image-cache.ts` — 图片本地化：按图床选 Referer、单图 3MB 上限、3 天清理、md5 文件名；`localizeImageViaProxy` 是 X 图专用（隧道）。

`ntfy` 通道已放弃（见 [docs/design.md](../../docs/design.md) §11）。
