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

