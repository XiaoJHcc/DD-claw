# DD-claw

B站开播监听 → 内容判定 → 推送。

**当前进度：M1（开播检测 + QQ 推送）已实现。** LLM 判定是 M2，目前只留了接口，实际行为是「开播就推，一场一次」。

设计与调研文档在 [docs/](docs/)。

## 快速开始

```bash
npm install
cp config.example.json config.json    # 填订阅列表和推送目标
cp .env.example .env                  # 填 NapCat 地址和 token
npm run probe                         # 先确认能拿到B站数据
npm test                              # 39 个单测
npm run build && npm start
```

`config.json` 和 `.env` 都在 gitignore 里，不会提交。

## CLI

| 命令 | 作用 |
|---|---|
| `npm run probe` | 查一次开播状态就退出。不碰 DB、不推送 |
| `npm run test-notify` | 用假事件走完整推送链路，验证 NapCat 配置和消息格式 |
| `npx tsx src/index.ts --dry-run` | 正常轮询判定，推送只打日志不真发 |
| `npx tsx src/index.ts --force-uid <uid>[,<uid>]` | 临时监听指定 uid，覆盖配置里的订阅 |

`--probe` 和 `--force-uid` 可组合。想立刻验证端到端而不等主播开播，从B站热门找一个正在直播的房间：

```bash
rm -rf data/                                       # 清空基线
npx tsx src/index.ts --force-uid <正在直播的uid>    # 配合 notifyOnFirstRun: true
```

## 配置要点

| 字段 | 说明 |
|---|---|
| `pollIntervalSec` | 轮询间隔，建议 30-60。低于 20 会被 schema 拒绝 |
| `pollJitterSec` | 随机抖动，避免固定节奏 |
| `notifyOnFirstRun` | 首次运行时已在播的是否推。默认 `false`，避免启动刷屏 |
| `notifyOnNewSubscription` | **新增订阅时正在播的是否推。默认 `true`** —— 关掉意味着新加的主播当时那场永远收不到通知 |
| `healthAlertAfterFailures` | 连续拉取失败多少次后告警 |
| `notify.onebot.targets` | 数组，可同时发多个私聊/群。加目标只改配置不改代码 |

`config.json` 支持 `//` 和 `/* */` 注释。

## 结构

```
src/
  config/      读 .env + config.json，zod 校验，启动即失败
  sources/bili/ HTTP 客户端（强制注入 UA）+ 批量开播状态（分片）
  core/        状态机、调度、SQLite、有界并发
  analysis/    Analyzer 接口 + M1 的 NoopAnalyzer
  rules/       DecisionRule 接口 + OncePerSessionRule
  notify/      Notifier 接口、dispatcher、OneBot、Toast
```

## 两个关键设计

**一场直播的身份是 `(room_id, live_time)`。** `live_time` 是服务端给的开播时间戳，用它去重一次解决三件事：进程重启不重推、网络闪断不误报（`live_time` 没变就是同一场）、主播真的下播又开播会正常推。

**Toast 不是「多一个通道」，是独立兜底。** NapCat 掉线或 QQ 被踢时，QQ 通道本身就是坏的，没法告诉你「监听坏了」。这时只有本机 Toast 能通知你。

## M2 接 LLM 时改哪里

`Analyzer.analyze()` 返回 `SceneVerdict | null`，M1 的实现就是 `return null`。规则层签名已经能接收 `verdict`，所以：

- 新写一个 `analysis/llm.ts` 实现 `Analyzer`
- 在 `index.ts` 里把 `new NoopAnalyzer()` 换掉
- 规则层从 `OncePerSessionRule` 演进成「每次场景切换推一次 + 冷却窗口」

现有代码不用动。

