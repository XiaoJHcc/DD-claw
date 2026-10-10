# QQ 自助入口（NapCat 直连，P3）

QQ 群 / 私聊成员用自然语言管理**本渠道**推送的对话式入口：NapCat 用 OneBot 11 的 HTTP 上报把消息
推给 DD-claw 的 `POST /onebot`，DD-claw 自己判定触发、限流、进 agent loop（gateway 工具面），
回执经 OneBot HTTP API 发回来源渠道。设计依据见 [../plan/agent-access.md](../plan/agent-access.md)
的「P3：NapCat 直连」「渠道隔离」「QQ 侧配套政策」；同一条链路复用 P1 的 agent loop。

```
NapCat ──(httpClients: POST /onebot)──▶ src/panel/server.ts 路由
                                          └─▶ src/qqbot/bot.ts
                                                ├─ onebot-event.ts  事件解析（身份锚点：group_id/user_id）
                                                ├─ trigger.ts       触发判定（斜杠命令 / @ / 前缀）
                                                ├─ settings.ts      开关 + 触发前缀 + 会话→渠道映射
                                                ├─ reply.ts         回执裁剪 + /reset 附言 + 固定文案
                                                ├─ agent/loop.ts    一轮对话（role=gateway、scope=ch:<channelId>）
                                                └─ 回执 → OneBotNotifier.sendText → send_group_msg / send_private_msg
```

## 文件职责

| 文件 | 职责 |
|---|---|
| `src/qqbot/onebot-event.ts` | OneBot 11 事件解析：只认消息事件、忽略自发消息；数组格式与 CQ 字符串格式归一；`@机器人` 识别；文本实体还原。会话键 = `group:<群号>` / `private:<QQ号>` |
| `src/qqbot/settings.ts` | settings 契约（`qqbot_enabled` / `qq_channel_map` / `qqbot_trigger_prefix`）+ 前缀匹配 + 映射容错解析 |
| `src/qqbot/trigger.ts` | 触发纪律（确定性命令 ↔ LLM 两条路共存）；未被唤起一律静默 |
| `src/qqbot/reply.ts` | 回执渲染（裁剪 + `/reset` 附言）、`/help` 与各类固定文案 |
| `src/qqbot/bot.ts` | 编排：开关 → 解析 → 触发 → 限流 → 映射 → 命令/LLM → 回执；**不抛异常**，返回动作摘要 |
| `src/qqbot/napcat-post.ts` | NapCat 侧上报地址自管（`onebot11_<uin>.json` 的 `network.httpClients` 条目 `dd-claw-qqbot`）+ 热重载 |
| `src/qqbot/*.test.ts` | 契约测试（全离线，不连真 NapCat / QQ） |

改动落在 `src/agent/loop.ts`（入口泛化）、`src/agent/system-prompt.ts`（QQ 变体提示）、
`src/panel/server.ts`（`POST /onebot` 路由 + `PanelDeps.qqbot`）、`src/notify/onebot.ts`（`sendText`）、
`src/index.ts`（装配）。

## 装配与开关

- **前提**：面板 server 在跑（事件接收与它同进程同端口）；`settings.qqbot_enabled = '1'`（缺省关）。
  面板不开或开关关 = 该入口**不装配**，日志说明。
- **运行时热关**：bot 每条事件都重读开关，关掉立即静默丢弃（无需重启）；重新打开要重启进程
  （路由挂载是一次性的）。
- 启动日志会打印入口是否装配、以及 NapCat 上报地址注册结果。

## NapCat 侧的上报地址

`network.httpClients` 是「NapCat 把事件 POST 给谁」的方向（与 `httpServers` —— 我们调
`send_group_msg` 的方向 ——是两条）。DD-claw **自管其中一条**，名字固定 `dd-claw-qqbot`，
只动这一条、别的条目原样保留；写完经 NapCat webui 的 `SetConfig` 热重载（`reloadOnebotConfig`），
热重载失败则下次重启 NapCat 生效。

自动注册的条件与失败回退：

| 情况 | 行为 |
|---|---|
| `napcat_enabled` + 目录 + 纯数字 QQ 号都齐 | 启动时自动建/修 `dd-claw-qqbot` 条目，url = `http://127.0.0.1:<面板端口>/onebot`，`messagePostFormat='array'`、`reportSelfMessage=false` |
| 条目已一致 | 不写盘不热重载（幂等） |
| 配置读不到 / 坏 JSON / 写失败 | 只记 warn，不影响启动——**手工配置步骤**见下 |

手工配置（NapCat webui → 网络 → 新建「HTTP 客户端」，或直接改 `config/onebot11_<QQ号>.json`）：

```json
{
  "network": {
    "httpClients": [
      {
        "name": "dd-claw-qqbot",
        "enable": true,
        "url": "http://127.0.0.1:8787/onebot",
        "messagePostFormat": "array",
        "reportSelfMessage": false,
        "token": "",
        "debug": false
      }
    ]
  }
}
```

改完在 webui 里「保存并启用」（或重启 NapCat）。`messagePostFormat` 建议 `array`
（字符串格式也能解析，但数组格式对 @ 段更稳）。`reportSelfMessage=false` 是不上报机器人自己的消息。

## settings 键

| 键 | 形状 | 缺省 | 说明 |
|---|---|---|---|
| `qqbot_enabled` | `'1'` / 其它 | 关 | 总开关。只有 `'1'` 才算开 |
| `qq_channel_map` | JSON `{"group:123456":2,"private":789:3}` | 空 | 会话键 → `push_channels.id`。**查不到 = 拒绝服务**，绝不回落默认渠道 |
| `qqbot_trigger_prefix` | 字符串 | `dd` | 群聊唤起前缀；显式空串 = 只靠 @机器人 |

**映射没有 UI（v1 决定）**：主人直接写 settings。一条命令即可（库路径缺省 `data/dd-claw.db`，
自定义过 `DB_PATH` 就换成实际路径）：

```bash
node --import tsx --input-type=module -e "
const { Db } = await import('./src/core/db.js');
const { saveChannelMap } = await import('./src/qqbot/settings.js');
const db = new Db('data/dd-claw.db');
saveChannelMap(db, { 'group:123456': 2, 'private:789': 3 });
db.close();
"
```

渠道 id 用面板的推送渠道列表（或 MCP `list_channels`）查。键必须是 `group:<数字>` /
`private:<数字>`；值必须是正整数，否则该条目被静默丢弃（与 `mcp_tokens` 同容错口径）。
后续若要 UI：`src/mcp/tools.ts` 加一个 admin 工具（进注册表 → 可撤销）+ 设置页卡片即可，
`saveChannelMap` 已经就绪。

## 触发纪律（最终规则）

| 消息 | 行为 |
|---|---|
| 非消息事件（心跳/通知/请求）、其他平台消息、缺 id、**机器人自己发的** | 静默忽略（连回执都没有） |
| 空正文（纯图/表情）且 @了机器人 | 回一句「想做什么」 |
| `/reset` | **确定性执行**：清空本渠道会话上下文（保留会话行），不进 LLM |
| `/help` | **确定性执行**：能力简介，不进 LLM |
| 其它 `/xxx` | 静默忽略（斜杠是确定性通道，未知命令不猜、不喂模型） |
| 群聊：@机器人 或 前缀命中（`qqbot_trigger_prefix`，缺省 `dd`） | 进 LLM（正文 = 剥掉 @段与前缀后的文本） |
| 私聊 | **直接进 LLM**（一对一对话本身就是对着机器人说的；前缀/@ 一样剥掉）。渠道是否开通由映射把关 |
| 群聊：没 @、前缀也不匹配 | 静默忽略（群里的闲聊不插嘴） |

前缀匹配细节：大小写不敏感；**前缀后紧跟 ASCII 字母/数字不算触发**（`dddd` 不是命令），
后接中文/空白/结尾都算（`dd加主播`、`dd 加主播` 都触发）。

代价与取舍：私聊直通是**产品解释**（plan 只说「群与私聊一视同仁」，没规定私聊也要唤起手法）——
一对一会话里要求打前缀体验很差，而映射已经是主人显式开通。若要收紧，改
`trigger.ts` 里 `private` 分支一处即可（改成与群聊同规则）。

## 限流与回执

- **限流**：每来源渠道 `QQ_TURNS_PER_MINUTE = 10` 轮/分钟（`src/qqbot/bot.ts`，进程内内存桶）。
  **只对被唤起的消息**计数与回话——没被唤起的消息不产生回执，无需限流。超限回一句缓和文案。
- **回执裁剪**：`QQ_REPLY_MAX_CHARS = 450`（`src/qqbot/reply.ts`，**按 QQ 实际限制微调**——
  真机跑通后若正常回复常被截就调大这一个常量）。**正文优先**：留头不留尾 + 一句「已截断，详情请在面板查看」；
  预算里先扣掉附言，保证附言不被截掉。
- **上下文阈值**：`ChatStore.usage(scope).needsResetHint`（40 条消息 / 8k 字符）为真时，
  回执末尾附「本群对话上下文已较长，发送 `/reset` 可清空」（私聊称「本会话」）。
  **不自动裁剪**——与面板同口径，只是主动提示。
- LLM 不可用（未启用 / 无 provider = 400，调用彻底失败 = 502）：回一句「模型暂时用不了，
  请主人检查面板 LLM 配置」，不装作听懂了。

## 渠道隔离怎么落地的

| 落实点 | 落法 |
|---|---|
| 会话解析 | `qq_channel_map` 查不到 → 拒绝服务（且只对**被唤起**的消息回话，避免在未开通的群里刷屏） |
| 上下文 | 会话键 = 来源渠道，scope = `channelScope(channelId)`（与撤销栈同一套字符串）；A 群与 B 群、面板之间完全独立 |
| 写 / 撤销 | `channelId` 经 `runAgentTurn({ channelId })` 注入调用域，**永不进工具参数**；撤销走 `undo_last_change` = 本渠道栈 |
| 审计 | actor = `qqbot-<会话键>`（如 `qqbot-group:111`），entry = `'agent'`（QQ 与 WebUI Agent 同为 DD-claw 自己的 loop，来源靠 scope + actor 区分） |
| 工具面 | `role: 'gateway'`：admin 工具在这一轮请求里**根本不存在**（不可见即不存在） |
| 系统提示 | QQ 变体（`buildQqbotSystemPrompt`）：只处理本渠道、uid/规则 id 先查再引用、写前先复述等确认、回答简短、不查别的渠道 |
| 限流 | 按来源渠道分桶 |

## 与计划的两处不符（已按实际处理）

1. **映射编辑没有 UI**：plan 把「渠道映射编辑」放在待定/后续，v1 只能写 settings（见上「一条命令」）。
2. **变量名**：plan 写的是「MaiBot 插件用 `[[groups]]` 里的 channel_id」，而 NapCat 直连这条路的
   映射是 DD-claw 自己的 settings（`qq_channel_map`）——同一条权威关系（会话 → channelId）在
   两条接入途径里各有一份配置，DD-claw 侧永远是最终权威。

## 测试

`src/qqbot/qqbot.test.ts`（17 例）与 `src/qqbot/napcat-post.test.ts`（5 例），全离线：
事件解析（数组 / CQ 字符串 / 非消息 / 自发）、触发判定（@、前缀、斜杠、不触发）、限流分桶、
未映射拒服务、渠道隔离（上下文 + 撤销栈）、gateway 工具面、`/reset`、回执裁剪与附言、
`POST /onebot` 路由（挂载门 / 响应形状 / 坏 body）、面板 `/api/chat` 回归、NapCat 条目自管
（创建 / 幂等 / 修正 / 失败回退 / 旧文件名回落）。

```bash
node --import tsx --test src/qqbot/qqbot.test.ts src/qqbot/napcat-post.test.ts src/agent/loop.test.ts
```

> 写路径清单测试（`src/panel/write-path-inventory.test.ts`）会要求给 `POST /onebot` 补一行分类
> ——它是消息入口、写面只有 chat_messages 与会话记录，按 `coverage: 'excluded'` 归类。