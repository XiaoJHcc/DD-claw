# DD-claw 文档索引

按问题选择入口，不必先通读全部文档。项目定义和跨模块约束从 [根 AGENTS](../AGENTS.md) 开始；文档维护分工见 [docs/AGENTS](AGENTS.md)。

## 设计与现行契约

| 想了解 | 阅读 |
|---|---|
| 为什么这样分层、核心概念、什么明确不做 | [design.md](design.md) |
| 哪些已经实现、哪些还需验收或开发 | [status.md](status.md) |
| 外部平台能做什么、凭据要求、接口与平台坑 | [boundaries.md](boundaries.md) |
| MCP 接入、令牌、角色、渠道隔离与撤销 | [mcp.md](mcp.md) |
| 分类与推送过程如何回看、历史快照边界 | [content-audit.md](content-audit.md) |

## 修改代码：先模块约束，再深入机制

模块 AGENTS 管代码地图与设计约束，专题只展开机制，不重复文件清单。

| 模块入口 | 深入阅读 |
|---|---|
| [装配](../src/AGENTS.md) / [配置](../src/config/AGENTS.md) / [工具](../src/tools/AGENTS.md) | [数据、恢复与撤销](modules/core.md) |
| [core](../src/core/AGENTS.md) | [持久化与时间轴语义](modules/core.md) |
| [sources](../src/sources/AGENTS.md) | [来源恢复与平台差异](modules/sources.md)、[外部证据](boundaries.md) |
| [analysis](../src/analysis/AGENTS.md) / [rules](../src/rules/AGENTS.md) | [分类与回退机制](modules/analysis.md) |
| [notify](../src/notify/AGENTS.md) | [通知平台与托管排障](modules/notify.md) |
| [panel](../src/panel/AGENTS.md) / [webui](../webui/AGENTS.md) / [scripts](../scripts/AGENTS.md) | [前后端、demo 与内嵌契约](modules/panel.md) |
| [mcp](../src/mcp/AGENTS.md) / [agent](../src/agent/AGENTS.md) | [MCP 契约](mcp.md) |
| [qqbot](../src/qqbot/AGENTS.md) | [QQ 接入与配置](modules/qqbot.md) |

## 实施计划与决策依据

计划保留原路径以供代码与文档引用。历史实施方式不覆盖现行设计与契约；是否完成以 status 为准，原验收合同仍需保留。

| 文档 | 适用范围 |
|---|---|
| [unify-classify-push](plan/unify-classify-push.md) | 统一分类 / 推送模型依据、视觉与决策模型实施和验收合同 |
| [agent-access](plan/agent-access.md) | 多入口接入、信任模型与调用域方案依据；Agent 真机验收口径 |
| [twitter-source](plan/twitter-source.md) | X 来源建设历史、代理与链路回归口径 |
| [weibo-source](plan/weibo-source.md) | 微博独立来源与历史迁移依据 |
| [bili-dynamic-posts](plan/bili-dynamic-posts.md) | B站独立动态来源、监听边界与迁移依据 |

## 研究与外部证据

研究回答外部能力是否可行，不代表项目已实现。各篇自行记录基准日期、版本与来源，平台风控、模型额度和服务可用性需重新确认。

| 研究 | 范围 |
|---|---|
| [live-status](research/live-status.md) | 批量直播状态与匿名接口 |
| [danmaku](research/danmaku.md) | 弹幕 WS、签名与接入条件 |
| [media-capture](research/media-capture.md) | 关键帧、流媒体与采样能力 |
| [feeds](research/feeds.md) | B站动态、微博与登录要求 |
| [twitter](research/twitter.md) | Nitter、免登录回退、代理与时效 |
| [auth-cookie](research/auth-cookie.md) | 凭据获取的可行性与安全边界 |
| [llm](research/llm.md) | 模型路由、协议与成本评估 |
| [decision-models](research/decision-models.md) | 枚举判断模型、图像输入与 API 证据 |
| [notify](research/notify.md) | QQ 与系统通知可行性 |
| [ts-stack](research/ts-stack.md) | 技术栈能力与替代方案评估 |

溯源标记统一含义：**[实测]** 有实际请求或运行证据；**[文档]** 来自公开资料或源码但未亲测；**[待验证]** 尚不能当作实现事实。证据时效与具体例外在原文维护，不在索引重复结论。
