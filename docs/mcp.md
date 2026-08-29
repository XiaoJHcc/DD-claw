# MCP 接口（Agent 接入）

DD-claw 的 Agent 能力面：挂在控制面板同一个端口上的 `/mcp` 端点（Streamable HTTP transport，
`@modelcontextprotocol/sdk`），供 Claude Code、MaiBot 等 MCP Host 读写设置、查询数据库。

定位：**工具的具体用法看工具自身的 description**（LLM 消费，随 tools/list 下发）；
本文档只覆盖运维面——令牌、角色、接入配置、安全边界。

## 快速开始

```bash
npm run mcp-token -- add claude admin      # 生成 admin 令牌（token 只打印这一次）
npm run mcp-token -- add maibot gateway    # 生成 gateway 令牌
npm run mcp-token -- list                  # 列出令牌（只显示前 12 位）
npm run mcp-token -- remove <名字>         # 吊销
```

令牌存 settings 表 `mcp_tokens`（库即信源，换机随 `dd-claw.db` 一起走）。
未配置任何令牌时 `/mcp` 回 503；Bearer 缺失/无效回 401。

### Claude Code

```bash
claude mcp add --transport http dd-claw http://127.0.0.1:8787/mcp \
  --header "Authorization: Bearer ddc_..."
```

### MaiBot（bot_config.toml）

```toml
[[mcp.servers]]
name = "dd-claw"
transport = "streamable_http"
url = "http://127.0.0.1:8787/mcp"
headers = { Authorization = "Bearer ddc_..." }   # gateway 令牌
```

MaiBot 启动日志应出现 `✓ MCP 服务器 'dd-claw' 已连接 (工具 12 / …)`；其 WebUI 工具列表可见。

## 角色与权限

| | admin | gateway |
|---|---|---|
| 典型持有者 | 主人本机（Claude Code / 其他 Agent） | MaiBot（群里所有人间接调用） |
| 只读查询 | ✔ 全部 | ✔ 全部 |
| 设置/名单/规则/渠道/LLM 写 | ✔ | ✘（工具不存在） |
| 群推送规则自助 | ✘（用全量规则 CRUD） | ✔（受限，见下） |

**关键设计：权限差异体现在 tools/list——越权工具对 gateway 连接根本不存在
（调用得到 Tool not found），而不是注册后靠参数校验拒绝。**

### 为什么不信工具参数

MaiBot 的 MCP 调用由其 LLM 规划器发起，参数是模型生成的——群友一句精心设计的话
（prompt injection）就能让 MaiBot 在参数里谎称「这是主人私聊」「群号是 X」。
因此服务端**只信任连接级 Bearer token**，参数里任何身份声明都不作数。

### gateway 写操作的服务端强制（不信任调用方声明）

`add_group_push_rule` / `remove_group_push_rule`：

- 渠道只能是**已存在的已启用 QQ 群渠道**（私聊/toast/新建渠道一律拒绝）
- 主播必须已在监听名单（监听新主播是 admin 动作）
- 规则打 `created_by='mcp'` 标记；**只能删除同标记的规则**，面板/Claude Code 建的规则动不了
- 单群渠道自助规则 ≤ 20 条；写操作限流 20 次/10 分钟（每令牌）
- 同主播同分类去重；全部写操作落审计日志（`[mcp] MCP 写操作 [角色:令牌名] 工具 参数`）

残留风险（如实说明）：群号参数本身不可验证，群友理论上可诱导 MaiBot 给**别的**群渠道加规则。
爆炸半径被限制在「往某群加开播推送」这种可撤销的骚扰级；如需锁死「只能操作本群」，
做 v2 的 MaiBot 插件（见下）。

## 工具一览（细节以 tools/list 的 description 为准）

- **只读（两角色共享）**：`get_status` / `get_live_now` / `get_schedule` / `list_streamers` /
  `search_streamers` / `list_push_rules` / `list_categories` / `list_channels` / `search_posts`
- **admin 写**：`watch_streamer` / `unwatch_streamer` / `set_streamer` / `set_push_enabled` /
  `set_llm_enabled` / `set_listen` / `update_runtime_config` / `upsert_category` / `delete_category` /
  `upsert_push_rule` / `delete_push_rule` / `upsert_channel` / `delete_channel` /
  `list_llm_providers` / `upsert_llm_provider` / `delete_llm_provider` / `set_llm_key`
- **gateway 自助**：`list_group_channels` / `add_group_push_rule` / `remove_group_push_rule`

写路径全部复用面板同款校验与热生效回调——经 MCP 改设置与在面板改完全等价
（监听开关热启停源、运行时参数热生效、LLM 名单/key 热重建 router）。

## 边界与 v2 预留

- **主人 QQ 私聊改设置**：v1 不做。私聊消息也走 MaiBot → 同样不可信；管理动作用 Claude Code 或面板
- **per-message 可信身份**：v2 以 MaiBot 插件实现——插件在代码层取消息事件的发送者/群号，
  用共享密钥 HMAC 签名随调用带给 DD-Claw，验签后才信任（LLM 无法伪造签名）
- **面板 token 管理卡**：v1 只有 CLI；token 纯文本存库（同 LLM key 的本机明文口径）
- 只暴露 tools；MCP resources / prompts / SSE 服务端推送不实现

## 故障排查

| 现象 | 原因 |
|---|---|
| 503「未配置访问令牌」 | 还没跑过 `mcp-token add`（注意令牌存在库裡，换库/换机要重建） |
| 401 | Bearer 缺失或 token 打错；`mcp-token list` 核对前缀 |
| MaiBot 里看不到某个工具 | 角色不对（gateway 本就没有 admin 工具），或撞上 MaiBot 内置保留名 |
| MaiBot 显示连接失败 | DD-claw 面板没起来（panel.enabled）或端口写错 |
| 调用返回「错误：…」 | 业务校验拒绝，消息是中文的具体原因（同面板报错口径） |
