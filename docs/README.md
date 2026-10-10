# DD-claw 文档索引

B站关注列表全员监听（直播间 + 动态 + 微博）→ 持续追踪 → LLM 内容判定与预告解析 → 按偏好子句路由推送。

## 文档结构

| 文档 | 内容 |
|---|---|
| [design.md](design.md) | 项目设计：两条正交轴（运行时数据流 / 能力面接入）、数据结构、里程碑 M1-M5、待定项、已放弃清单 |
| [status.md](status.md) | **实现现状**：里程碑（M1 起）与模块两视图 + 未实现清单 |
| [boundaries.md](boundaries.md) | **能力边界**：什么能做、什么做不到、代价是什么 + 已知踩坑清单 |
| [mcp.md](mcp.md) | **MCP 接口**：Agent 接入（令牌/角色权限/Claude Code 等 Host 配置/安全边界；MaiBot 不直连） |

### 实施计划

| 文档 | 内容 |
|---|---|
| [plan/agent-access.md](plan/agent-access.md) | **多前端接入统一计划**：一个能力面 N 种接线（Web UI / MCP / WebUI Agent / MaiBot 插件 / NapCat 直连），信任模型矩阵 + 共享组件 + 分期 **P0-P3** + 能力层调用域（scope，已定令牌绑定渠道）+ 拍板记录 |
| [plan/twitter-source.md](plan/twitter-source.md) | **X/推特图文来源计划**：免登录路线（Nitter RSS 主 + 免登录 HTML 备）、面板可配代理、机械筛选与可选 LLM 判定/翻译，分期 P0-P3 |
| [plan/weibo-source.md](plan/weibo-source.md) | **微博图文来源计划**：把微博从「主播附属数据源」升级为独立来源（独立名单 / platform 分流 / 单墙混排），已落地 |
| [plan/bili-dynamic-posts.md](plan/bili-dynamic-posts.md) | **B站动态图文来源 + 图文规则重构**：规则卡 + 每账号选用，已落地 |

（M1 落地计划已完成使命并归档删除，实施经验折叠进 boundaries.md 第 5 节；后续里程碑的实施计划在动手前按同样格式补写。）

### 模块实现笔记

| 文档 | 内容 |
|---|---|
| [modules/core.md](modules/core.md) | core + config + logger + tools + index.ts 装配 |
| [modules/sources.md](modules/sources.md) | B站（直播间/关注/动态）/ 微博 / 媒体关键帧 |
| [modules/analysis.md](modules/analysis.md) | analysis + rules：触发 / 分类管线、LLM provider、matcher、机械去重 |
| [modules/notify.md](modules/notify.md) | notify：dispatcher / onebot / NapCat 托管 / toast（含 macOS helper） |
| [modules/panel.md](modules/panel.md) | panel 路由契约 + webui + 构建内嵌 + demo 契约 |

### 模块调研

| 文档 | 结论一句话 |
|---|---|
| [research/live-status.md](research/live-status.md) | 开播状态匿名可查，批量接口一次覆盖所有关注对象 |
| [research/danmaku.md](research/danmaku.md) | 弹幕 WS 匿名可连，只需 WBI 签名 + UA |
| [research/media-capture.md](research/media-capture.md) | keyframe 白嫖；需音频时走 FLV + ffmpeg 合并命令 |
| [research/feeds.md](research/feeds.md) | 动态/微博匿名全灭，必须 cookie 或浏览器 |
| [research/twitter.md](research/twitter.md) | 推特免登录能拿最新推文（**代理是硬前提**）；Nitter RSS 仍有活口且最适合机械筛选 |
| [research/auth-cookie.md](research/auth-cookie.md) | 自动读 Chrome cookie 已死，手动导出是唯一正路 |
| [research/llm.md](research/llm.md) | 文本为主路径；免费视觉首选 Gemini，备选 GLM-4V-Flash |
| [research/notify.md](research/notify.md) | QQ 只剩 NapCat 一条活路；本机 Toast 走 powertoast |
| [research/ts-stack.md](research/ts-stack.md) | TS 全项可行，唯一短板中文 OCR，隔离成独立服务 |

## 溯源标记

调研结论按可信度分三级，全文统一使用：

- **[实测]** — 本次调研期间真实发出过请求 / 跑过代码，附返回码或输出。绝大多数由 subagent 在 2026-07-29 执行。
- **[文档]** — 来自公开文档或源码阅读，未亲自跑通。
- **[待验证]** — 传闻、社区经验、或 agent 自己标注不确定的内容。**不要当事实用**。

时效性：所有结论基于 **2026-07-29**。B站/微博风控与各家免费额度政策变动频繁，标注 [待验证] 的部分实现前需重新确认。

## 一句话现状

匿名可拿：开播状态（批量）、标题、分区、开播时间、keyframe 预览图、弹幕流、直播流截图与音频。
需要凭据：关注列表（SESSDATA）、B站空间动态、微博时间线。
故开播检测与弹幕内容分析可完全匿名运行；**cookie 是「规模化」（关注列表同步）与「预告时间表」的前置条件**。
X/推特另开一路：**免登录即可拿到最新推文**（详见 research/twitter.md），但**必须先有可用代理**——境内直连 x.com 与图片 CDN 均不可达。
