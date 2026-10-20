# DD-claw

监听用户选定的 B站直播间，以及 B站动态、微博、X 独立账号名单；持续归档与内容分类，按人填规则推送到 QQ 群 / 私聊 / 本机通知。关注同步只提供候选池，不自动加入监听。

## 核心定义

- 规模基线：上百位关注、30+ 同时在播；批量状态轮询与昂贵分析分离，原始数据按领域归档。
- 人填分类口径与推送规则；模型判断内容属于什么分类，确定性 matcher 决定推给谁、推什么。运行管线不设人工确认，不做自然语言偏好编译。
- 直播与图文共用分类和推送模型，但保留各自的状态 / 事件语义、去重与恢复策略。范围为空表示全部，包含未来新增主体。
- 产品目标、设计理由和明确不采用项见 [设计 §1、§4、§11](docs/design.md)；实现进度只查 [status](docs/status.md)。

## 架构与跨模块边界

两条正交轴，交点是 SQLite：

- **运行时数据流**：sources → 领域归档 / Signal 总线 → pipeline → analysis / 机械去重 / 确定性匹配 → PushMessage → notify。
- **能力面与接入**：`src/mcp/tools.ts` 注册能力，REST、MCP、WebUI Agent、QQ 入口只做适配；`settings` 是运行时配置唯一信源。

不可破坏的边界：

1. source 只抓取、归档和产信号，不通知、不调用模型。拉取失败不等于下播，保留旧状态。
2. 分析任务与 provider 解耦；后台内容分析经 `analysis/queue` 限流，不把模型调用内联进轮询循环。分类规则可等待分析，任意内容规则不被无关分析阻塞。
3. 通知执行只消费 `PushMessage`，不解释分类或用户偏好，不增设中间指令对象。
4. 能力定义只进注册表，身份在接入层确权，工具参数不承载可信身份；LLM 参数必须再校验。鉴权与调用域契约见 [MCP](docs/mcp.md)。
5. `src/index.ts` 是唯一装配根。`core` 不导入 `sources`；`sources`、`analysis`、`notify` 不互相导入；`mcp` 可使用 panel 的共享 API 类型与辅助函数；WebUI 只经 `/api/*`。
6. 配置写入 `settings` 后由装配根回调热生效；`config.json` 只管 panel 自举，不要求用户手改运行时配置。配置错误应启动即失败并指出字段。
7. 不向来源平台发弹幕、点赞或评论；本地配置写经受控能力面执行。

## 按目录阅读

修改前先读目标目录的 AGENTS；下表只负责导航，代码职责不在根级重复维护。

| 入口 | 内容 |
|---|---|
| [src/AGENTS.md](src/AGENTS.md) | 装配根、CLI、日志与热生效 |
| [core](src/core/AGENTS.md) / [config](src/config/AGENTS.md) | 领域数据、编排、撤销 / 配置自举 |
| [sources](src/sources/AGENTS.md) | 平台抓取、凭据与媒体采样 |
| [analysis](src/analysis/AGENTS.md) / [rules](src/rules/AGENTS.md) | 分类、模型路由、偏好匹配 / 机械去重 |
| [notify](src/notify/AGENTS.md) | 渠道发送与 NapCat 托管 |
| [panel](src/panel/AGENTS.md) / [mcp](src/mcp/AGENTS.md) | HTTP 适配 / 能力执行与权限 |
| [agent](src/agent/AGENTS.md) / [qqbot](src/qqbot/AGENTS.md) | 对话回路 / QQ 触发与接入 |
| [webui](webui/AGENTS.md) | 前端组件、交互与 demo 契约 |
| [tools](src/tools/AGENTS.md) / [scripts](scripts/AGENTS.md) | 运维 CLI / 构建与平台辅助脚本 |
| [文档目录](docs/README.md) / [文档维护](docs/AGENTS.md) | 设计、专题、状态、计划、研究的阅读入口与归属 |

## 开发与验证

- ESM、Node.js ≥22，相对导入带 `.js` 后缀；HTTP 使用原生 `fetch` 和 `AbortSignal.timeout`，不引入 axios。
- 测试与被测代码同目录（`*.test.ts`）；命令信源是 `package.json`，日常操作见 [README](README.md#开发)。
- 验证运行 `npm run typecheck`、`npm run build`、`npm test`；涉及用户链路时还需实际验收，不能以编译通过代替。
- UI 源码只在 `webui/` 修改，生成的内嵌资产与默认值不手改；前后端/demo 协同见 [面板专题](docs/modules/panel.md)。
- 维护文档时修改事实所属的唯一信源，其余位置保留链接；AGENTS 不写任务日志、日期型补丁或分期验收记录。
