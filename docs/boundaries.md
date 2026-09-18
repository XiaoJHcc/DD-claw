# 能力边界

调研基准日 **2026-07-29**。溯源标记含义见 [README](README.md#溯源标记)。

这份文档回答一个问题：**哪些事我们能做，哪些做不到，做得到的代价是什么。**

## 1. 数据获取边界

### 匿名可得（无需任何凭据）

| 能力 | 接口 / 手段 | 验证 |
|---|---|---|
| 开播状态、标题、分区、开播时间 | `room/v1/Room/get_status_info_by_uids`（批量） | [实测] 200 |
| 单房间详情 | `get_info` / `room_init` / `getRoomBaseInfo` | [实测] 200 |
| 直播间预览图 | `keyframe` 字段 → `i0.hdslb.com/bfs/live-key-frame/...` | [实测] 连 UA 都不需要 |
| **弹幕流** | `getDanmuInfo` + WBI 签名 + UA → `wss://.../sub` | [实测] 收到 `DANMU_MSG` |
| 直播流截图 / 音频 | `getRoomPlayInfo` → FLV → ffmpeg | [实测] 截图 ~1s |
| 视频/专栏评论 | `x/v2/reply`（旧接口） | [实测] 200 |

### 需要登录凭据

| 能力 | 匿名结果 | 最低代价 |
|---|---|---|
| B站空间动态 | [实测] ~~HTTP 412，即使 WBI 签名正确~~（2026-08-03 推翻：全量 cookie + dm 三参（高斯算法生成，非静态占位）+ space Referer 即通，**无需 WBI**） | 完整 cookie 集 |
| 微博用户时间线 | [实测] **HTTP 432**，游客 cookie 流程已失效（2026-08-03 补充：扫码登录 + `weibo.com/ajax/statuses/mymblog` 路径已跑通，见 feeds.md 修订块） | 登录 cookie（面板扫码落 weibo-cookies.json） |
| 我关注的直播列表 | [实测] `-101 账号未登录` | SESSDATA |
| 直播原画画质 | [实测] `qn=10000` 静默降级到 250 | SESSDATA（本项目不需要） |
| 动态评论区 | [文档] 需 `type=17` + 动态 id | 未跑通，见 feeds.md |

### 需要代理出网（境内直连不可达）

以下都是 **X / 推特** 的能力，2026-09-16 在本机实测：**免凭据可用，但必须先有可用 HTTP 代理**（直连 `x.com` TLS 被重置、`pbs.twimg.com` 直接超时）。详见 [research/twitter.md](research/twitter.md)。

| 能力 | 接口 / 手段 | 验证 |
|---|---|---|
| **账号最新推文（含正文）** | 免登录 `x.com/<screen>` HTML 内嵌数据 | [实测] 拿到当天 00:54Z 的推文 |
| 单推详情（时间/图片/正文） | `cdn.syndication.twimg.com/tweet-result?id=<id>&token=<任意非空>` | [实测] 200 完整 JSON |
| 推文列表（100 条，但**非最新**） | `cdn.syndication.twimg.com/srv/timeline-profile/screen-name/<name>` | [实测] 100 条；限流 30 次/15 分钟 |
| **原创/转发/带图/时间可判的订阅** | 存活 Nitter 实例的 `/<screen>/rss` | [实测] 20 条 = 10 转 + 10 原创，19 带图 |
| 图片下载 | `pbs.twimg.com`（经代理） | [实测] 代理通、直连超时 |

### 明确做不到

- **自动读取 Chrome/Edge 已登录 cookie** — Chrome 127+ App-Bound Encryption 封死。可绕过，但手段是进程注入 / process hollowing / COM 伪装，等同恶意软件技术，本项目不采用。
- **CDP 直挂用户日常 Chrome** — [文档] Chrome ≥136 不再支持对默认 profile 用 remote debugging。
- **免签调用 B站动态接口** — 旧接口 `dynamic_svr/space_history` [实测] 同样 412，无替代。（2026-08-03 修订：带登录 cookie + dm 参数的新接口 `web-dynamic/feed/space` 已跑通，见 §5.18；免签仍不可能。）
- **绕过 412 靠静态占位设备指纹** — `dm_img_list` 等参数有生成算法，[实测] 填静态占位值无效；必须按 RSSHub 高斯算法现场生成（本项目 `src/sources/bili/dm.ts`）。

## 2. 功能边界

### 能做

- 分钟级开播感知（轮询 30-60s）
- 带预览图、可点击跳转的多通道推送
- 基于「标题 + 分区 + 弹幕 + 画面文字」的内容类型判定
- 按主播 × 场景的偏好过滤（阿梓唱歌推、打游戏不推）
- 判定依据可追溯（evidence 字段）

### 有条件能做

| 能力 | 条件 |
|---|---|
| 秒级开播感知 | 该房间常驻弹幕 WS；只对少数重点主播划算 |
| 预告时间表 | 导入 cookie，且接受定期手动续期 |
| 高精度中文 OCR | 额外跑一个 OCR 服务（Umi-OCR / Python PaddleOCR） |
| 唱歌的声学确认 | 接 ffmpeg 音频 + 本地 speech/music 模型 |
| 原画截图 | 登录 cookie；但本项目无此需要 |

### 不做

- **不做完整录播** — 已有录播姬 / DDTV，本项目只做短采样
- **不设人工确认环节** — 运行管线无人工参与；预告条目带置信度入库，消费端按阈值过滤；人工只在控制面板指定需求
- **不做写操作** — 只读，不发弹幕、不点赞、不发动态
- **不做公开部署** — 个人自用；B站已对接口收集类项目发起法律行动
- **不用 agent CLI 订阅额度冒充 LLM API** — 封号风险

## 3. 成本边界

| 项 | 量级 |
|---|---|
| 轮询流量 | 一次批量请求覆盖全部关注对象，可忽略 |
| keyframe 预览图 | 几十 KB / 次 |
| ffmpeg 单次采样 | [实测] 1~1.5MB，8~10s（瓶颈是音频时长） |
| LLM 文本判定 | 免费额度内；L0/L1 规则层拦掉 60-80% |
| LLM 视觉判定 | 免费额度更紧，仅文本信号矛盾时动用 |
| 本地常驻 | Node 单进程 + 按需几路 WS；OCR/音频模型按需加载 |
| 推特第三方 API（增量轮询 50 账号） | ≈$65–80/月（twitterapi.io）；官方 X API 去重后 ≈$37/月，**无去重 ≈$10,800/月** |
| 推特免登录路线（HTML + syndication / Nitter RSS） | 0 元，代价是实例与页面结构随时可变 |

## 4. 时效性风险

以下结论**实现前必须重新验证**，它们依赖于随时可变的外部策略：

| 结论 | 为什么会变 |
|---|---|
| 各家 LLM 免费额度与型号 | Gemini 已不公开固定 RPM/RPD；国内厂商政策季度级变动 |
| B站接口的匿名可用性 | `getInfoByRoom`、`getDanmuInfo` 都是 2025 年才收紧的 |
| WBI 签名算法 | 2023-03 至今未变，但 RSSHub 选择动态解析 B站 JS 而非硬编码 |
| Chrome cookie 加密机制 | ABE 仍在攻防迭代 |
| NapCat 可用性 | 同类项目 go-cqhttp / Lagrange V1 / Shamrock 已相继失效 |
| SESSDATA 有效期 | [待验证] 网传半年到一年，无官方声明；用心跳检测代替硬编码天数 |
| Nitter 实例存活与 X 页面结构 | 公共实例随时被限速/被停止函打死；免登录 HTML 的字段随 X 改版变化（2026-09-16 实测可用） |
| 本机代理的可用性 | X 全部能力都压在 `127.0.0.1:7890` 上，代理挂 = X 源全停（应做健康检查与告警） |

## 5. 已知踩坑清单

汇总各模块调研中确认的坑，实现时直接规避：

1. `getDanmuInfo` **必须带 User-Agent**（内容随意），不带任何 header 则 `-352`；Referer 反倒不必需。[实测]
2. `tiny-bilibili-ws` 有 headers 覆盖 bug：传自定义 headers 会冲掉内置 UA 导致 `-352`。[实测]
3. ffmpeg 输入选项必须在 `-i` 前、输出选项在 `-i` 后，顺序错了**不报错但静默失效**。[实测]
4. 直播流别加 `-ss`，没有可寻址时间轴。[实测]
5. `-frames:v 1` 要配 `-update 1`，否则报图片序列警告。[实测]
6. 不登录时 `qn` 会静默降级，要读返回的 `current_qn` 而非假设。[实测]
7. `getRoomPlayInfo` / 拉流必须带 `Referer: https://live.bilibili.com/`。[实测]
8. cookie 要导出**完整一整套**，别只挑「必需」字段——缺不起眼字段是间歇性 412 的元凶。[文档]
9. `tesseract.js` v7 默认走 relaxedsimd wasm 会编译报错，需显式指定 `corePath` 为非 simd 版。[实测]
10. Gemini 拒绝 zod 自动生成的 `$schema` / `additionalProperties` 字段，转 JSON Schema 后要清理。[文档]
11. 未开播时 `playurl_info` 为 `null`，调 ffmpeg 前必须先查 `live_status`。[实测]
12. 别装 cookie 编辑类浏览器扩展——ModHeader 2026-07 因藏休眠外泄代码被下架。[文档]

以下来自 M1 实施（2026-07-30），原 M1 计划文档已归档删除，经验折叠于此：

13. `powertoast` v3 是类 API（`new Toast(opts).show()`），不是默认导出函数；字段名 `aumid`（非 appID）、`activation`（非 onClick）；预览大图用 `heroImg` 而非 `icon`。[实测]
14. 配置文件支持 JSONC 注释时，剥注释必须跳过字符串内部（`"https://..."` 里的 `//` 会被误删）；Windows 记事本 / PowerShell 写的文件常有 BOM，`JSON.parse` 不接受，需先剥离。[实测]
15. `live_status=2` 是轮播不是直播（泠鸢实测命中），必须当未开播处理，否则把B站自动放的录像推成开播。[实测]
16. OneBot 对同一目标并发发送会被限流（群约 20 条/分钟）：每目标一条串行链 + ≥1.2s 间隔。图片失败降级纯文本重发只在请求真正到达 NapCat 后才有意义——NapCat 没启动时降级重试必然同样失败。[实测]
17. 批量接口单 POST 不宜过长：`uids` 按 50 分片。多主播同时开播时推送要并发受限（`mapLimit` 4），否则串行 await 会把第 10 条通知拖到分钟级。[实测]

以下来自动态源实施（2026-08-03）：

18. B站空间动态接口 `x/polymer/web-dynamic/v1/feed/space` **不需要 WBI 签名**——之前「签名正确仍 412」缺的是全量 cookie + dm 三参的正确组合：`dm_img_list`（高斯随机轨迹 JSON，算法抄 RSSHub `getDmImgList`，静态占位无效）+ `dm_img_str`/`dm_cover_img_str=bm8gd2ViZ2w`（base64('no webgl') 去 padding）+ `Referer: https://space.bilibili.com/<uid>/` + cookies.json 全字段。实测 22 个 uid 全量归档零 412。`DYNAMIC_TYPE_LIVE_RCMD` 的 `major.live_rcmd.content` 是需要二次 JSON.parse 的字符串，内含 `live_play_info.{title,room_id,area_name,cover}`。[实测]
19. 动态去重只靠 `(platform, item_id)` UNIQUE，不要用时间戳判新旧（编辑/置顶会让时间戳不稳定）；拉取失败（412 HTML / -352 / 网络错）必须跳过本轮保留旧数据，绝不能当成「没动态」。[实测]

以下来自 NapCat 托管化实施（2026-08-09）：

20. NapCat 一键包 `launcher.bat` 注入 QQ 需管理员（非管理员会自己弹 UAC 重开 wt.exe）。[实测] 自动拉起走「最高权限」计划任务：一次性创建（弹一次 UAC），之后非管理员也能 `schtasks /run` 静默触发；`/it` 必须有——QQ 要跑在交互会话。**坑：PowerShell `Start-Process -ArgumentList` 数组不会给带空格的元素自动加引号**（任务名 'DD-claw NapCat' 被平铺拼断 → schtasks 语法错误 exit=1）；正解是生成 `data/napcat-launch.cmd`（任务 action 本体，launcher.bat + uin）+ `data/napcat-setup.cmd`（提权执行的 schtasks /create，输出落 `napcat-setup.log` 供失败诊断），引号只经 CommandLineToArgvW 一层 `\"` 转义（已实测任务 XML 里 Command 值正确）。另：`Start-Process` 不设置 `$LASTEXITCODE`，取退出码必须 `-PassThru` + `$p.ExitCode`；**launcher.bat 用 `%cd%` 拼 NAPCAT_* 路径，wrapper 必须 `cd /d` 进一键包目录再调它**——计划任务默认 cwd 是 System32，不 cd 会把 loadNapCat.js 写进 System32 且找不到 qqnt.json，任务「尝试运行」成功但 NapCat 起不来（已实测修复：cd 后 schtasks /run → 快速登录 → OneBot 在线）。[实测]
21. NapCat OneBot 端点管理：**DD-claw 自建自管 `name: "dd-claw"` 的专属 httpServers 条目**（用户决策 2026-08-09：不靠「取第一个」排序协议，用户不手动改、DD-claw 自动改）——`ensureNapcatEntry` 缺了自动选高位空闲端口（41990 起扫）创建、被禁用自动启用、端口被占（探测=conflict）自动换端口；只动这一条，其他服务条目（如教程惯例的 http/3000）原样保留，发现逻辑按名匹配、无条目回落第一个启用条目。写配置后 NapCat 需重启才生效：看门狗识别「陈旧实例」（新端口 down 但 lastOk 旧端口仍 ok）→ 停止任务杀进程树 → 拉起；**NapCat 被 /rl highest 拉起后是高权限进程，非提权进程 Stop-Process 拒绝访问，停止也必须做成配套计划任务（DD-claw NapCat Stop，taskkill /F /IM ... /T，同一次 UAC 创建）**。[实测 2026-08-09：创建条目保留 http/3000 → stop/start 双端口同时在线]
22. NapCat 失活自动拉起双平台（2026-08-16）：**任务生命周期 = 开关**——「失活自动拉起」开时建拉起任务（Windows 弹一次 UAC）、关时 `schtasks /delete` 彻底移除；任务本身 `/sc once` 无自触发，拉起唯一驱动是 DD-claw 进程内的看门狗，因此 **DD-claw 关闭后不会再拉起 NapCat**（旧实现残留的「关闭后仍持续拉起」根因是任务与开关脱钩 + 依赖外部常驻）。**macOS 无需提权任务**：NapCat-Mac-Installer 已用 sudo 改好 QQ 的 package.json（注入 loadNapCat.js），DD-claw 拉起只是 `open -a QQ --args --no-sandbox --qq <uin>`——`--no-sandbox` 是安装器要求（Chromium 沙箱禁止加载未签名库）；**`--qq <uin>`（等价 `-q`）进 QQ 主进程 process.argv，NapCat 的 `napcat-shell/base.ts` 读取后走 `quickLoginWithUin` 快速登录，无需扫码**（源码实测；另有 `NAPCAT_QUICK_ACCOUNT` 环境变量等价）。macOS 停止 = `osascript -e 'tell application "QQ" to quit'`（QQ 跑在用户态，无需提权杀）。

以下来自微博接入 / 关注接口实施（2026-08-03）：

23. 微博扫码 `passport sso/v2` 的 generate **必须带 `Referer: https://weibo.com/`，否则 403**；返回 image 是 png 直链（面板直接 `<img src>`）。poll 的 retcode 归一化：`20000000`=confirmed、`50114001`=waiting（已实测）；`50114002`=scanned、其他 `50114xxx`=expired（防御式映射，未单独观测）。[实测]
24. 微博登录态心跳走 `ajax/log/action`，看 **`X-Log-Uid` 响应头**；异常与缺头都归一化为未登录。[实测]
25. 微博昵称→UID 匿名解析链（`src/sources/weibo/resolve.ts`）：`genvisitor` 拿 tid → `incarnate` 拿 SUB/SUBP → `m.weibo.cn/n/<昵称>` 302 到 `/u/<uid>`；cookie 模块级缓存、失效自动重建并重试一次，绝不进日志。[实测]
26. B站 `x/relation/followings` 分页 **50/页**，按返回 total 翻页、短页到底；**无需 WBI 签名**（604 关注 13 页实测）。[实测]
27. B站批量接口 `get_status_info_by_uids` 传入**非纯数字 uid** 会报 `65530 route_exception`，单 uid 拉取也必败——`listWatchedUids()` 只回 watch=1 且纯数字的 uid（防止 demo 演示数据混入）。[实测]

以下来自 X/推特接入调研（2026-09-16）：

28. **Node 22 原生 fetch 不认代理**：`HTTPS_PROXY` 环境变量无效（`NODE_USE_ENV_PROXY` 是 Node 24+ 才有），项目也未装 `undici`；`curl.exe -x` 在同一环境下同样打不通（`000`）。可行解只有一个——**手写 CONNECT 隧道 + 在隧道上 `tls.connect({servername})`**。请求务必带 `Connection: close`：HTTP/1.1 默认 keep-alive 会让读取端永不 `end`，表现为**假的 20 秒超时**（本次调研踩过，浪费两轮探测）。[实测]
29. `cdn.syndication.twimg.com/tweet-result` 的 `token` 参数**只需存在且非空，值任意**（`abc` 与推文 id 都返回完整 JSON，与网传"由 id 派生"不符）；**缺 token 时返回 `200` + `{}`**——空对象必须当失败处理，不能当"没内容"。[实测]
30. **免登录的两条 X 路线都过滤转发**：`x.com/<screen>` HTML 与 `syndication timeline-profile` 实测 `retweeted_status_results` 全为 `null`（同期 Nitter RSS 显示同一账号 20 条里 10 条是转发）。要转发就必须走 Nitter RSS / 持号路线 / API。[实测]
31. `syndication timeline-profile` **给的不是「最新 100 条」而是抽样**（实测最新条目停在 4 个月前，而该账号当天有推文），且限流 `x-rate-limit-limit: 30`（15 分钟窗口，打满返 429 + 20 字节空体）→ 只能当回填源，不能当实时源。[实测]
32. Nitter RSS 的 `<link>` 指向**原作者**的 `/status/<id>`（`RT by @xxx` 的 link 是原作者推文），按 link 去重会把"同一条推文被多次转发"折叠成一条；需要"每次转发都推"就必须另取 RT 自身 id。[实测]
33. Nitter 系公共实例对脚本客户端大多不可用：`xcancel.com` 返回 **451**（法律下架），`nitter.net`/`nitter.poast.org` TLS 重置，`nitter.space`/`lightbrd.com` Cloudflare 403，`tiekoetter`/`privacyredirect` 挂 **Anubis 工作量证明**。实测可用仅 `nitter.jaydenha.uk`、`x.n0g.xyz`（RSS 各 20 条）与限速的 `nitter.kareem.one` → 只能"多实例轮询 + 失败即弃"。[实测]
34. **Nitter 实例判活必须打 RSS 路径，不能打首页**："首页挂了 Anubis/Cloudflare" ≠ "实例不可用"。2026-09-16 实测 `x.n0g.xyz` 首页是 Anubis 挑战页，但 `/<user>/rss` 正常返回 20 条；按首页判活会把唯一能用的实例误杀成不可用。[实测]
35. 公共实例会**分钟级抖动**：同一个 `nitter.jaydenha.uk` 前一次探测 TLS 被重置，几十秒后重试又正常返回 20 条。实例探测要带一次瞬时错误重试，并如实标注「已重试 1 次」——既不要把抖动读成死亡，也不要把抖动读成稳定。[实测]
36. `127.0.0.1:7890` 这类本地代理在 Windows 上可能**只监听 IPv6 通配 `[::]:7890`**：`Get-NetTCPConnection -LocalPort 7890 -State Listen` 查不到（表现为「代理没在跑」），但 `net.connect(7890,'127.0.0.1')` 与 CONNECT 隧道都正常。查代理存活要以实际连接为准，不要只信端口枚举。[实测]

以下来自微博独立图文来源实施（2026-09-17）：

37. **微博没有像 X 那样便宜的匿名「账号存在性」接口**：X 可以拿 `tweet-result` 单推接口低成本判账号（见 29），微博只有昵称解析链（见 25）能反查 uid。所以微博账号的添加流程**在只填 uid 时不校验存在性**（填昵称则解析失败即 400）——硬加等于把添加流程挂在一个未实测的端点上。填错 uid 的表现是「该账号抓取持续失败并告警」，不是「添加时就报错」。[设计取舍]
38. **微博图床（`sinaimg.cn`）境内直连可达**，不需要 X 那条代理隧道；但**对 Referer 敏感**——头像链路带 `Referer: https://weibo.com/` 实测可达，帖子图复用的 `localizeImage` 也按域带 weibo Referer（带外站 Referer 会被防盗链 403，浏览器端同样靠 no-referrer 才显示得了微博图）。头像 URL 还带签名与过期参数（`?KID=…&ssig=…`，同一头像每轮 URL 也可能不同），所以按 URL 的 md5 落盘、且只在还没有本地头像时下载一次——换头像不更新本地缓存（删号重加才会；旧文件体积小、随目录一起清理）。[实测]
39. **微博的「转发」就是它的引用形态**：抓取层把带 `retweeted_status` 的微博折成 `type='retweet'` 并把原文拼进正文（`//转发自 @原作者: …`），没有独立的引用实体可言。因此图文帖规则里 `filters.quote` 只对 X 生效，微博规则带它会**保存时 400**（与「原创/转发都不勾 = 死规则」同一条纪律：不存永不命中的配置）。[设计取舍]
