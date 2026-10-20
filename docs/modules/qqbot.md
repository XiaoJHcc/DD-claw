# QQ 自助入口（NapCat 直连）

QQ 群 / 私聊成员用自然语言管理**本渠道**推送的对话式入口：NapCat 用 OneBot 11 的 HTTP 上报把消息 POST 给 DD-claw 的 `/onebot`，DD-claw 自己判定触发、限流、进 agent loop（gateway 工具面），回执经 OneBot HTTP API 发回来源渠道。本文件写时序、启用与配置配方、设计理由与排障；触发契约、隔离机制与目录地图见 [src/qqbot/AGENTS.md](../../src/qqbot/AGENTS.md)，设计依据见 [../plan/agent-access.md](../plan/agent-access.md)，工具权限见 [../mcp.md](../mcp.md)。

```
NapCat ──(network.httpClients: POST /onebot)──▶ src/panel/server.ts 路由
                                                 └─▶ src/qqbot/bot.ts
                                                       ├─ onebot-event.ts  事件解析（身份锚点：group_id / user_id）
                                                       ├─ trigger.ts       触发判定（斜杠命令 / @ / 前缀）
                                                       ├─ settings.ts      开关 + 触发前缀 + 会话→渠道映射
                                                       ├─ reply.ts         回执裁剪 + /reset 附言 + 固定文案
                                                       ├─ agent/loop.ts    一轮对话（role=gateway、scope=ch:<channelId>）
                                                       └─ 回执 → OneBotNotifier.sendText → send_group_msg / send_private_msg
```

与 MaiBot 插件是**两条并存的接入途径**（插件以 gateway 令牌调 `/mcp`，NapCat 直连把事件喂进进程内 loop），渠道权威来源见「渠道隔离的权威来源」一节。

## 启用步骤

1. **面板在跑**：事件接收与面板同一进程同一端口（面板不开 = 该入口不存在）。
2. **打开开关**：`settings.qqbot_enabled = '1'`（缺省关——QQ 入口是暴露面，必须主人主动开）。开关是装配期判据：`'1'` 才挂 `/onebot` 与入口本体；启动日志会打印是否装配。
3. **NapCat 上报地址**：自动注册失败时按下面的手工步骤补一条（只影响事件上报方向）。
4. **渠道映射**：把会话键映射到某个 `push_channels.id`（没有映射 = 拒绝服务）。
5. 运行中关开关立即静默丢弃事件，但**重新打开要重启进程**（路由挂载是一次性的）。

### settings 键

| 键 | 形状 | 缺省 | 说明 |
|---|---|---|---|
| `qqbot_enabled` | `'1'` / 其它 | 关 | 总开关。只有 `'1'` 才算开 |
| `qq_channel_map` | JSON `{"group:123456":2,"private:789":3}` | 空 | 会话键 → `push_channels.id`。**查不到 = 拒绝服务**，绝不回落默认渠道 |
| `qqbot_trigger_prefix` | 字符串 | `dd` | 群聊唤起前缀；显式空串 = 只靠 @机器人 |

**映射没有 UI**（v1 决定，主人直接写 settings）。一条命令即可（库路径缺省 `data/dd-claw.db`，自定义过 `DB_PATH` 就换成实际路径）：

```bash
node --import tsx --input-type=module -e "
const { Db } = await import('./src/core/db.js');
const { saveChannelMap } = await import('./src/qqbot/settings.js');
const db = new Db('data/dd-claw.db');
saveChannelMap(db, { 'group:123456': 2, 'private:789': 3 });
db.close();
"
```

渠道 id 用面板的推送渠道列表（或 MCP `list_channels`）查。键必须是 `group:<数字>` / `private:<数字>`，值必须是正整数，否则该条目被静默丢弃（与 `mcp_tokens` 同容错口径：settings 由人 / 工具写，宁可「这个群没开通」，也不要因一条脏数据整体报废）。后续若要做 UI：注册表加一个 admin 工具（可撤销）+ 设置页卡片，`saveChannelMap` 已经就绪。

## NapCat 侧的上报地址

`network.httpClients` 是「NapCat 把事件 POST 给谁」的方向，与 `httpServers`（我们调 `send_group_msg` 的方向，见 [notify.md](notify.md)）是两条。DD-claw **自管其中一条**，名字固定 `dd-claw-qqbot`，只动这一条、别的条目原样保留；写完经 NapCat webui 的 `SetConfig` 热重载，热重载失败则下次重启 NapCat 生效。

| 情况 | 行为 |
|---|---|
| NapCat 开关 + 目录 + 纯数字 QQ 号都齐 | 启动时自动建 / 修 `dd-claw-qqbot` 条目，url = `http://127.0.0.1:<面板端口>/onebot`，`messagePostFormat='array'`、`reportSelfMessage=false` |
| 条目已一致 | 不写盘不热重载（幂等） |
| 配置读不到 / 坏 JSON / 写失败 | 只记 warn，不影响启动——按下面手工配置 |

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

改完在 webui 里「保存并启用」（或重启 NapCat）。`messagePostFormat` 建议 `array`（字符串格式也能解析，但数组格式对 @ 段更稳）；`reportSelfMessage=false` 是不上报机器人自己的消息。

## 触发纪律的设计理由

触发契约（含空正文、斜杠、@、前缀、私聊各分支的判定结果）以 [src/qqbot/AGENTS.md](../../src/qqbot/AGENTS.md) 为准；本节只记为什么这么定。

- **确定性命令与 LLM 两条路共存，不是降级关系**：`/reset`、`/help` 是确定行为，交给模型只会多一次不确定性；其余斜杠命令一律不猜（静默），也不喂给模型。斜杠是「可预期的接口」，模型是「会说话的人」，混在一起两边都做不好。
- **默认静默**：群里刷屏比不响应更糟，所以「没被唤起」是绝大多数消息的归宿——不计限流、不产生回执。
- **前缀看「后面紧跟什么」而不是有没有空格**：中文群聊里「dd加主播」远比「dd 加主播」常见，真边界是紧跟 ASCII 字母 / 数字（拒绝 `dddd`），后接中文 / 空白 / 标点 / 结尾都算触发。
- **私聊直通是产品解释**：一对一对话本身就是对着机器人说的，要求打前缀体验很差；渠道是否开通已经由映射把关。若要收紧，改 `trigger.ts` 的 `private` 分支一处即可（改成与群聊同规则）。

## 限流与回执的阈值成因

- **10 轮 / 分钟**（`QQ_TURNS_PER_MINUTE`，按来源渠道分桶）：防群友 prompt injection 诱导刷 LLM / 写接口，是安全阀不是精确配额；只对被唤起的消息计数。
- **回执 450 字**（`QQ_REPLY_MAX_CHARS`）：QQ 单条上限远大于此，取小值是刻意的——群里的自助回执本来就该短，长内容让对方面板看。**正文优先**：留头不留尾 + 一句「已截断，详情请在面板查看」，预算先扣附言、附言永不被截。真机跑通后若正常回复常被截，调大这一个常量。
- **40 条消息 / 8k 字符**（会话存储的 `needsResetHint`）：为真时回执末尾附 `/reset` 提示（私聊称「本会话」）。**不自动裁剪**——与面板同口径，只是主动提示。
- **LLM 不可用如实说**：未启用 / 无 provider（400）与调用彻底失败（502）对用户是同一件事，回一句「模型暂时用不了，请主人检查面板 LLM 配置」，不装作听懂了。

## 渠道隔离的权威来源

隔离机制（映射查不到拒服务、会话键 = 渠道、`channelId` 只从事件注入、scope 与撤销栈同串、gateway 工具面、按渠道限流）见 [src/qqbot/AGENTS.md](../../src/qqbot/AGENTS.md) 与 [../mcp.md](../mcp.md)。这里只留一条配置事实：NapCat 直连用 DD-claw 自己的 `qq_channel_map`，MaiBot 插件用它自己的群配置挑一条**渠道绑定令牌**——同一条「会话 → channelId」关系在两条接入途径里各有一份配置，DD-claw 侧（令牌绑定 / 映射表）永远是最终权威。

## 排障

| 现象 | 原因 |
|---|---|
| 发消息完全没动静 | `qqbot_enabled` 不是 `'1'`（装配期判据，启动日志有说明）；或面板没在跑 |
| 群里 @了也不回 | 没被唤起（@ 段缺失 / 前缀后面紧跟 ASCII 字母数字）；或映射未配 → 拒绝服务（只在被唤起的消息上回一句「请让主人配置映射」） |
| 回一句「这个群还没开通」 | `qq_channel_map` 缺这条会话键，或值不是有效 `push_channels.id` |
| NapCat 里没收到事件 | `network.httpClients` 缺 `dd-claw-qqbot` 条目或 url 端口不对；改完要「保存并启用」 |
| 回复被截一半 | `QQ_REPLY_MAX_CHARS` 太小（或模型回复确实过长），调这一个常量 |
| 回复「模型暂时用不了」 | 面板 LLM 未启用 / 无可用 provider / 调用彻底失败 |

## 测试

全离线契约测试（不连真 NapCat / QQ）：事件解析（数组 / CQ 字符串 / 非消息 / 自发）、触发判定（@ / 前缀 / 斜杠 / 不触发）、限流分桶、未映射拒服务、渠道隔离（上下文 + 撤销栈）、gateway 工具面、`/reset`、回执裁剪与附言、`/onebot` 路由（挂载门 / 响应形状 / 坏 body）、面板 `/api/chat` 回归、NapCat 条目自管（创建 / 幂等 / 修正 / 失败回退 / 旧文件名回落）。

```bash
node --import tsx --test src/qqbot/qqbot.test.ts src/qqbot/napcat-post.test.ts src/agent/loop.test.ts
```
