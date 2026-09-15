# 推送层（src/notify/）

轴 A 的第三段（通知执行）：**只执行，不解释语义**（`PushMessage` 边界）。载荷是 `PushMessage`——notify 不认识 `LiveEvent`；dispatcher 做路由 + fan-out + 通道级规则，通道实现 `Notifier` 即可增删。分析层见 [analysis.md](analysis.md)，装配见 [core.md](core.md) 的 index.ts；实现现状见 [../status.md](../status.md)。

## 文件

### `types.ts`
`Notifier` 接口：`send(PushMessage)` + `capabilities` + `alert()`（可选，供健康告警；当前仅 toast 实现）。

### `message.ts`
`liveEventToMessage()`：`LiveEvent → PushMessage`。纯文案不用 emoji——QQ iOS 气泡渲染会把增补平面 emoji 拆成两个方框；body 只留直播标题，分区 · 开播时间进 `attribution`，头像进 `icon`，刚开播无关键帧时通知仍有图。

### `dispatcher.ts`
并行 fan-out、notify_log 用 `msg.ref` 溯源、任一通道成功即标记。

- `msg.channels` 存在时渠道路由：查 `push_channels` 过滤「选中且启用」按 notifier 分组，onebot 组解析成 `msg.targets`，无选中渠道的 notifier 跳过；缺省走全通道旧行为。
- `alertAll(title, body, qqTarget?)`：本机告警只派发到实现 `alert()` 的通道（当前仅 toast），`qqTarget` 存在时另走 `onebot.send` 私聊点对点。
- `setNotifiers` 装配级替换（NapCat 配置热更新后重建，pipeline 引用不变；无通道级开关——通道启停走 `push_channels.enabled`）。
- **通道级规则**（群×主播屏蔽、优先级阈值）：待产品方案，机制不预设。

### `onebot.ts`
NapCat OneBot 11 HTTP；消息段数组；attribution 拼成正文第三行；图片失败降级纯文本；每目标串行 + 1.2s 间隔。

- 常规 `send` 只看 `msg.targets`（空 = 不发）。
- **不实现 `alert()`**——次数阈值类健康告警不发 QQ；QQ 告警由 dispatcher 按 pipeline 判定带 `qqTarget` 走 `send` 私聊点对点。
- `updateEndpoint()` 供 NapCat 看门狗热跟随端点。
- `--test-notify` 的假消息取 `push_channels` 表的启用 QQ 渠道，可真实验证链路。

### `napcat.ts` — NapCat 通道 + 失活自动拉起（双平台）

- **dd-claw 专属条目自管**：`ensureNapcatEntry` 在 `onebot11_<uin>.json` 自建/修复 `name: "dd-claw"` 的 httpServers 条目（缺了选高位空闲端口〔41990 起扫〕创建、被禁用启用、端口被占自动换；只动这一条，http/3000 等其他条目原样保留）。
- `readOnebotEndpoint` 按名匹配发现（无条目回落第一个启用条目；host `0.0.0.0`/`::` 归一化回环）。
- `probeNapCat` 三态探测（连接拒绝 = down / TCP 通但非 OneBot = conflict / OneBot JSON = ok 再看 retcode 判登录态）。
- `NapcatWatchdog` 状态机：`target` 回调每 tick 取生效 dir/uin、缺条目自建、conflict 自动换端口再拉起、**陈旧实例识别**（新端口 down 但 lastOk 旧端口仍 ok → 停旧再拉起让新配置生效）、down 冷却 10min 内拉起、3 次放弃告警、未登录只告警一次、恢复自动复位；**拉起由 `autoRestart` 开关 + `available` 能力双闸门控制**（开关关 = 只探测/告警/热跟随绝不拉起；能力不可用〔任务被删〕告警一次不拉起）。
- 配置：`getNapcatConfig` / `saveNapcatConfig`（settings `napcat_enabled`〔使用 NapCat 通道〕/ `napcat_autorestart`〔失活自动拉起，缺省关〕/ `napcat_dir` / `napcat_uin` **唯一信源**，webui 管理；传空串 = 清空字段，无回落）；`getNapcatAlertQq` 读 settings `napcat_alert_qq`（健康告警 QQ 私聊目标，留空 = 不报，独立设置不进 NapcatConfig）。
- **`napcatRelaunchDriver(platform)` 拉起能力抽象**：
  - `win32` = schtasks（`setupNapcatTask` 一次 UAC 同建拉起 + 停止双任务：生成 `data/napcat-launch.cmd`〔先 `cd /d` 进一键包目录——launcher.bat 用 `%cd%` 拼 NAPCAT_* 路径〕+ `data/napcat-stop.cmd`〔`taskkill /F /IM /T`，高权限进程非提权杀不掉〕+ `data/napcat-setup.cmd` 提权 `schtasks /create`〔日志落 napcat-setup.log〕；**不经 `Start-Process -ArgumentList` 拼参**〔带空格元素不加引号的坑〕；`launchNapcatViaTask` / `stopNapcatViaTask` / `removeNapcatTask`）。
  - `darwin` = `open -a QQ --args --no-sandbox --qq <uin>`（**快速登录**：`--qq` 进 `process.argv` 由 NapCat `shell/base.ts` 读走；`launchMacNapcat` / `stopMacNapcat`〔osascript quit〕；setup/remove 为 no-op——NapCat-Mac-Installer 已改 QQ 无需提权任务，`macNapcatInstalled` = `/Applications/QQ.app` 存在即能力就绪）。
  - 探测/执行/时钟全可注入。

### `toast.ts`
powertoast 本机通知；**健康告警（health_alert → alertAll）的唯一通道**。构造可传 `aumid` + `cacheDir`；http 图先经 image-cache 本地化（Win32 身份不支持远程图），失败按无图发。icon = 左侧方形头像（`appLogoOverride`，不裁圆）、heroImg = 顶部关键帧大图、attribution = 底部分区 · 开播时间小灰字。macOS 走 mac-notifier（见下）。

### `mac-notifier.ts` — macOS 原生 helper
`scripts/mac-notify.swift` 用系统 `swiftc` 编译成 `DD-claw.app`（落 data 目录、每台机一次、幂等缓存）——正确的应用名 + 点击跳转 + 内容图；helper 发出通知后常驻 runloop 等待点击（点击打开 `--url`），超时退出避免僵尸进程。**swiftc 不可用 / 编译失败时回落 osascript**（身份固定为「脚本编辑器」、无点击跳转、无图，仅兜底）。

### `aumid.ts`
Win32 AUMID「DD-claw」自动注册：.lnk 缺失时调 `scripts/register-aumid.ps1`（PowerShell COM interop 写 AppUserModel.ID + 通知中心注册表，**必须 UTF-8 BOM + STGM_READWRITE**）；失败回落 Microsoft Store 默认身份，通知照发。

### `image-cache.ts`
toast 图片本地化：http 图下载到 `data/cache/toast/`（B站图床需 UA+Referer，3MB 上限，3 天清理），失败返回 null。

## 已放弃

`ntfy.ts`（ntfy 兜底通道）**已放弃**：本机 Toast + NapCat 已覆盖（见 `../design.md` §11）。