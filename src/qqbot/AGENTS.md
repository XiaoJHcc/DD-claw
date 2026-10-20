# qqbot — QQ 自助入口（NapCat 直连）

OneBot 11 上报 → `POST /onebot` → 本目录判定触发、隔离渠道、裁剪回执；对话本身复用 [../agent/AGENTS.md](../agent/AGENTS.md) 的 loop（gateway 工具面）。上报地址自管与 NapCat 托管的分工见 [../notify/AGENTS.md](../notify/AGENTS.md)。启用步骤、settings 配方、手工配置、设计理由与排障见 [docs/modules/qqbot.md](../../docs/modules/qqbot.md)。

## 长期不变量

**触发契约**（唯一权威；按上到下的顺序判定，进 LLM 的正文一律已剥掉 @段与前缀）：

| 消息 | 行为 |
|---|---|
| 非消息事件（心跳 / 通知 / 请求）、其他平台消息、缺 id、机器人自己发的 | 静默忽略 |
| 空正文（纯图 / 表情）且 @了机器人 | 回一句「想做什么」（`empty`） |
| `/reset` / `/help` | 确定性执行，不进 LLM |
| 其它 `/xxx` | 静默忽略（斜杠是确定性通道，未知命令不猜、不喂模型） |
| 群聊：@机器人 或前缀命中 | 进 LLM |
| 私聊 | 直接进 LLM（无需 @ 或前缀；带了一样剥掉） |
| 群聊：没 @、前缀也不匹配 | 静默忽略（群里的闲聊不插嘴） |

- **前缀边界**：大小写不敏感；前缀后紧跟 ASCII 字母/数字**不算触发**（`dddd` 不是命令），后接中文 / 空白 / 标点 / 结尾才算。
- **会话即渠道**：会话键 `group:<数字>` / `private:<数字>`；映射查不到 = 拒绝服务，绝不回落默认渠道，且只对**被唤起**的消息回话（不往未开通的群里刷屏）。
- **身份只从事件来**：`channelId` 由映射解析后经 `runAgentTurn({ channelId })` 注入调用域，永不进工具参数；scope = `channelScope(channelId)`，与撤销栈同一套字符串——本渠道的上下文与撤销栈对别的渠道不可见。
- **限流按渠道分桶**：`QQ_TURNS_PER_MINUTE` 轮/分钟，只对被唤起的消息计数；超限回缓和文案。
- **回执裁剪正文优先**：`QQ_REPLY_MAX_CHARS` 内留头不留尾，附言（`/reset` 提示）先扣预算、永不被截；LLM 不可用如实说，不装作听懂。
- **恒不抛异常**：`/onebot` 恒 200 + 动作摘要（`ignored` 是正常业务结果，不是错误）；回执发送失败只记日志。
- **开关每条事件重读**：运行中关 `qqbot_enabled` 立即静默；重新打开需重启进程（路由挂载是一次性的）。
- **NapCat 两个方向只各管一条**：本目录只自管 `network.httpClients` 里名字 `dd-claw-qqbot` 的上报条目；`httpServers`（我们调 `send_*` 的方向）由 notify 侧自管 `dd-claw`。别的条目原样保留，读不到 / 坏 JSON / 热重载失败只 warn 不抛。
- **settings 三键的读写口径只在本目录**（`qqbot_enabled` / `qq_channel_map` / `qqbot_trigger_prefix`）：装配根与面板都经这里的函数，不各自拼键名。

## 文件地图

- `bot.ts` — 编排：开关 → 解析 → 触发 → 限流 → 映射 → 确定性命令 / LLM → 回执；`QqbotDeps`（面板依赖面同一份对象 + 注入的 `send` / `completeChat` / `limiter`）；动作摘要联合类型是日志与 `/onebot` 响应体的同一份形状。
- `onebot-event.ts` — OneBot 11 事件解析：只认消息事件、忽略自发消息；数组格式与 CQ 字符串格式归一；@机器人 识别；文本实体还原；会话键生成。
- `trigger.ts` — 触发判定（`ignore` / `command` / `empty` / `agent`）与唤起手法剥离。
- `settings.ts` — 三个 settings 键的读写与容错解析、前缀匹配、会话键校验。
- `reply.ts` — 回执渲染（规整 + 裁剪 + 附言）与一组固定文案（help / 拒服务 / 超限 / LLM 不可用 / 出错）。
- `napcat-post.ts` — `httpClients` 上报条目自管（幂等：一致则不写盘不重载）+ 热重载复用 notify 侧实现。
- `qqbot.test.ts` / `napcat-post.test.ts` — 全离线契约测试（不连真 NapCat / QQ）。
