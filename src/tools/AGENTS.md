# tools：显式运维 CLI

工具只在显式调用时运行，不从应用启动路径隐式执行。复用领域仓储、鉴权与路径口径；不要在脚本中另造运行时配置信源。

| 文件 | 职责 / 使用边界 |
|---|---|
| `mcp-token.ts` | 令牌 list / add / remove；角色与渠道绑定契约见 [MCP](../../docs/mcp.md)，密钥只在必要时展示 |
| `migrate-snapshot-paths.ts` | 换机后的快照路径一次性迁移，保持幂等；路径语义见 [数据专题](../../docs/modules/core.md) |
| `dump-demo-fixtures.ts` | 从真实库导出 demo 夹具；覆盖已有文件必须显式 `--force`，不导出凭据 |

命令入口见 `package.json`。迁移或导出前确认目标数据库；不把本机数据或执行结果追加到长期文档。
