# DD-claw 文档索引

B站关注列表全员监听（直播间 + 动态 + 微博）→ 持续追踪 → LLM 内容判定与预告解析 → 按偏好子句路由推送。

## 文档结构

| 文档 | 内容 |
|---|---|
| [design.md](design.md) | 项目设计：规模假设、三段解耦架构、数据结构、里程碑 M1-M5、待定项 |
| [boundaries.md](boundaries.md) | **能力边界**：什么能做、什么做不到、代价是什么 + 已知踩坑清单 |
| [mcp.md](mcp.md) | **MCP 接口**：Agent 接入（令牌/角色权限/Claude Code 与 MaiBot 配置/安全边界） |

（M1 落地计划已完成使命并归档删除，实施经验折叠进 boundaries.md 第 5 节；后续里程碑的实施计划在动手前按同样格式补写。）

### 模块调研

| 文档 | 结论一句话 |
|---|---|
| [research/live-status.md](research/live-status.md) | 开播状态匿名可查，批量接口一次覆盖所有关注对象 |
| [research/danmaku.md](research/danmaku.md) | 弹幕 WS 匿名可连，只需 WBI 签名 + UA |
| [research/media-capture.md](research/media-capture.md) | keyframe 白嫖；需音频时走 FLV + ffmpeg 合并命令 |
| [research/feeds.md](research/feeds.md) | 动态/微博匿名全灭，必须 cookie 或浏览器 |
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
