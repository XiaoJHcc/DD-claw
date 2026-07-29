# M1 落地计划：开播检测 → QQ 推送

目标：**阿梓开播，QQ 收到一条带预览图的通知。** 全程匿名，不碰账号。

设计背景见 [design.md](design.md)，能力边界见 [boundaries.md](boundaries.md)。

## 1. 范围

### 做

- 轮询B站开播状态（批量，匿名）
- 每房间状态机，识别 开播 / 下播 / 标题变更
- 每场直播推一次，重启不重推
- QQ 推送（NapCat / OneBot 11 HTTP），带 keyframe 预览图 + 直播间链接
- 配置文件管理订阅列表
- 监听自身失效时能主动告警

### 预留接口但不实现

| 接口 | M1 占位实现 |
|---|---|
| `Analyzer.analyze()` | `NoopAnalyzer` — 直接返回 `null`，不做任何判定 |
| `DecisionRule.decide()` | `OncePerSession` — 一场直播推一次 |

**注意「无条件推送」不等于「不做去重」。** 轮询每 30-60 秒一次，若真的无条件推，一场直播会推几十上百条。M1 的占位规则是「每场直播推一次」，这是正确性要求，跟 LLM 判定无关。

### 不做

- LLM 内容判定、偏好过滤（M2）
- 弹幕 WS、动态、微博、ffmpeg、OCR（M2/M3）
- Web UI（M4）
- 任何写操作、任何需要凭据的接口

## 2. 前置条件

需要你先准备的：

1. **NapCat 实例跑起来**，开启 HTTP 服务端，记下：
   - 监听地址端口（默认 `http://127.0.0.1:3000`）
   - access token（如果设了）
   - **建议用小号**，见 [notify.md](research/notify.md#qq非官方-onebot-实现)
2. **推送目标**：你自己的 QQ 号（私聊）或群号
3. **订阅列表**：要监听的主播 uid。阿梓是 `7706705`
4. 验证 NapCat 通不通：

```bash
curl -X POST http://127.0.0.1:3000/send_private_msg \
  -H "Content-Type: application/json" \
  -d '{"user_id": <你的QQ号>, "message": "DD-claw 连通测试"}'
```

收到消息再开始写代码，否则后面分不清是自己的 bug 还是 NapCat 没配好。

## 3. 数据流

```
croner / 自调度循环（30-60s）
        ↓
BiliClient.getStatusByUids([uid...])        一次请求覆盖全部订阅
        ↓
RoomStateMachine.diff(prev, curr)           每房间对比前后状态
        ↓
Signal { kind: 'live_start' | 'live_end' | 'title_change', ... }
        ↓
core/bus 事件总线
        ↓
Analyzer.analyze(signal)  →  null            M1 占位，不做判定
        ↓
DecisionRule.decide(event, verdict)          M1: OncePerSession
        ↓                                     查 DB 是否已推过这场
NotifyDispatcher.broadcast(event)            并行 fan-out
        ↓
OneBotNotifier  +  ToastNotifier
```

## 4. 关键设计决策

### 4.1 用 `live_time` 作为「一场直播」的身份

这是 M1 最重要的一个决定，它一次性解决三个问题。

`get_status_info_by_uids` 返回的 `live_time` 是**本场开播的秒级时间戳**。把 `(room_id, live_time)` 作为一场直播的唯一标识存进 DB，推送前先查：

| 问题 | 靠 `live_time` 如何解决 |
|---|---|
| **重启重推** | 进程重启后 DB 里还有记录，同一场不会再推 |
| **闪断误报** | 网络抖动导致一次轮询读到「未开播」，下次又「直播中」—— 但 `live_time` 没变，识别为同一场，不推 |
| **真正的二次开播** | 主播下播后重新开播，`live_time` 变了，正常推送 |

比「按时间去重」或「按 debounce 窗口」都可靠，因为它用的是服务端的事实而不是我们的推测。

### 4.2 冷启动不推历史

首次运行（DB 为空）时，若某主播**已经在直播**，不推送——只把当前状态写入基线。

否则第一次启动会把所有正在直播的主播刷一遍。之后的新开播正常推。

这个行为要可配置（`notifyOnFirstRun`），因为有人可能就想启动时看一眼谁在播。

### 4.3 轮询失败绝不能当成下播

```
拉取失败（超时 / 非 200 / code != 0）
  → 记日志，保留上一次的状态，什么都不做
  → 绝不写入「已下播」
```

否则一次网络抖动 = 一条假下播 + 恢复后一条假开播。M1 只推开播，但状态机被污染后 `live_time` 比对逻辑也会跟着错。

连续失败 N 次（默认 5）→ 触发健康告警，见 4.5。

### 4.4 `live_status = 2` 是轮播不是直播

`live_status`：`0` 未开播、`1` 直播中、`2` 轮播中。

**轮播要当成未开播处理**，否则会把B站自动放的录像推成开播。

### 4.5 监听自己挂了要能知道

最坏的失败模式不是推错，而是**静默不工作**——你以为在监听，其实进程早死了或一直在被限流，而你永远收不到通知，且无法区分「没开播」和「监听坏了」。

M1 必须有：

- 连续拉取失败 N 次 → 告警一次（避免刷屏）
- **Toast 通道作为独立兜底**：NapCat 掉线/被踢时，QQ 通道本身就是坏的，只能靠本机 Toast 告诉你。这是把 Toast 纳入 M1 的真正理由，不是顺手加功能
- 启动时打一条日志写明订阅了几个 uid、轮询间隔多少、DB 路径

### 4.6 LLM 接缝放在哪

M1 不实现分析，但接缝位置决定了 M2 要不要返工。

```ts
// analysis/types.ts
export interface Analyzer {
  analyze(ctx: AnalysisContext): Promise<SceneVerdict | null>;
}

// M1 实现：analysis/noop.ts
export class NoopAnalyzer implements Analyzer {
  async analyze() { return null; }        // 就这一行
}

// rules/types.ts
export interface DecisionRule {
  decide(event: LiveEvent, verdict: SceneVerdict | null): Promise<NotifyDecision>;
}

// M1 实现：rules/once-per-session.ts
// verdict 为 null 时忽略它，只按 (roomId, liveTime) 查重
```

要点：

- **`verdict` 可为 `null`**，规则层必须能在没有判定结果时工作。这样 M2 接上真 Analyzer 后，规则层签名不变。
- **去重逻辑属于规则层，不要塞在 Analyzer 之前**。M1 规则是「每场一次」，M2 会变成「每场每次场景切换一次 + 冷却窗口」——同一个位置演进，不是新加一层。
- Analyzer 拿的是 `AnalysisContext`（聚合后的多源信号）而不是单个 Signal，M2 加弹幕/动态时只扩充 context 的字段。

M1 阶段这两个文件加起来不到 20 行，但位置对了。

## 5. 模块与职责

| 文件 | 职责 | 约 |
|---|---|---|
| `src/config/index.ts` | 读 `.env` + `config.json`，zod 校验，启动即失败 | 60 |
| `src/config/schema.ts` | 配置的 zod schema | 40 |
| `src/sources/bili/client.ts` | HTTP 层：强制注入 UA、超时、重试、返回码检查 | 80 |
| `src/sources/bili/live-status.ts` | 调批量接口，映射成 `RoomStatus[]` | 70 |
| `src/sources/bili/types.ts` | 接口返回类型 | 40 |
| `src/core/state.ts` | 状态机：diff 前后状态产出 Signal | 90 |
| `src/core/bus.ts` | 极简事件总线（`EventEmitter` 够用） | 40 |
| `src/core/db.ts` | better-sqlite3 初始化 + 建表 + 查询封装 | 90 |
| `src/analysis/types.ts` | `Analyzer` / `AnalysisContext` / `SceneVerdict` | 40 |
| `src/analysis/noop.ts` | M1 占位 | 10 |
| `src/rules/types.ts` | `DecisionRule` / `NotifyDecision` | 30 |
| `src/rules/once-per-session.ts` | M1 规则 | 50 |
| `src/notify/types.ts` | `Notifier` 接口 + `LiveEvent` | 50 |
| `src/notify/dispatcher.ts` | 并行 fan-out + 结果收集 + 失败重试 | 70 |
| `src/notify/onebot.ts` | NapCat HTTP，消息段数组拼装 | 90 |
| `src/notify/toast.ts` | powertoast | 60 |
| `src/core/scheduler.ts` | 自调度轮询循环 + 抖动 + 健康计数 | 80 |
| `src/logger.ts` | 极简结构化日志（带时间戳、级别、模块名） | 40 |
| `src/index.ts` | 装配：读配置 → 建实例 → 接总线 → 启动 | 80 |

约 1100 行。没有一个文件超过 100 行。

## 6. 数据库

```sql
-- 一场直播推没推过。M1 去重的唯一依据
CREATE TABLE IF NOT EXISTS live_sessions (
  room_id     TEXT NOT NULL,
  live_time   INTEGER NOT NULL,           -- 服务端的开播时间戳，即会话身份
  uid         TEXT NOT NULL,
  uname       TEXT,
  title       TEXT,
  area_name   TEXT,
  first_seen  INTEGER NOT NULL,           -- 我们首次观测到的时间
  notified_at INTEGER,                    -- NULL = 尚未推送
  PRIMARY KEY (room_id, live_time)
);

-- 每次推送的结果，用于排障和重试
CREATE TABLE IF NOT EXISTS notify_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id    TEXT NOT NULL,
  live_time  INTEGER NOT NULL,
  channel    TEXT NOT NULL,               -- 'onebot' | 'toast'
  ok         INTEGER NOT NULL,
  error      TEXT,
  ts         INTEGER NOT NULL
);

-- 每房间最后已知状态，进程重启后恢复基线用
CREATE TABLE IF NOT EXISTS room_state (
  room_id     TEXT PRIMARY KEY,
  uid         TEXT NOT NULL,
  live_status INTEGER NOT NULL,
  live_time   INTEGER,
  title       TEXT,
  updated_at  INTEGER NOT NULL
);
```

`live_sessions` 与 `notify_log` 分开：前者答「这场推过没」，后者答「推的时候发生了什么」。混在一起后面查问题会很难受。

## 7. 配置

秘密进 `.env`，其余进 `config.json` —— cookie/token 这类不该和订阅列表混在一个文件里。

```bash
# .env    (gitignore)
NAPCAT_BASE_URL=http://127.0.0.1:3000
NAPCAT_TOKEN=                      # 没设就留空
```

```jsonc
// config.json    (gitignore，另存 config.example.json 进版本库)
{
  "pollIntervalSec": 45,           // 30-60 建议区间
  "pollJitterSec": 8,              // 避免固定节奏，见 8.3
  "notifyOnFirstRun": false,       // 冷启动是否推已在播的
  "healthAlertAfterFailures": 5,
  "subscriptions": [
    { "uid": "7706705", "alias": "阿梓", "enabled": true }
  ],
  "notify": {
    "onebot": { "enabled": true, "target": { "type": "private", "id": "你的QQ号" } },
    "toast":  { "enabled": true }
  }
}
```

zod 在启动时校验，配置错了立刻退出并说清哪一项错了——不要等到第一次推送才炸。

## 8. 实现要点

### 8.1 BiliClient

```ts
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
```

- **UA 强制在 client 层注入**，不给调用方覆盖的机会。[danmaku.md](research/danmaku.md#隐藏的必要条件user-agent) 实测过：缺 UA 直接 `-352`，而 `tiny-bilibili-ws` 就是栽在 headers 被覆盖上。M2 接弹幕签名时这一层直接复用。
- Node 22 原生 `fetch` + `AbortSignal.timeout(10_000)`，不需要 axios
- **两层错误要分开**：HTTP 层失败（超时/非 200）与业务层失败（`code != 0`）是不同的东西，日志要能区分
- 重试：最多 2 次，指数退避（1s、3s），仍失败就交给 scheduler 计入健康计数

### 8.2 批量接口用 POST

订阅列表长了 `uids[]=a&uids[]=b&...` 的 URL 会很长。用 POST：

```ts
await fetch('https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids',
  { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uids: uids.map(Number) }) });
```

**注意返回的 `data` 是以 uid 为 key 的对象，不是数组**，且**未开播的主播可能整个 key 都不存在**——不能假设请求 N 个就回 N 条。缺失的 key 要当作「未开播」处理，而不是当作「拉取失败」。

### 8.3 调度用自调度循环而非 setInterval

```ts
async function loop() {
  while (running) {
    try { await pollOnce(); } catch (e) { logger.error(e); }
    await sleep(intervalSec * 1000 + Math.random() * jitterSec * 1000);
  }
}
```

- `setInterval` 在一次轮询比间隔还慢时会叠加执行；`await` 完再排下一次天然不重叠
- **加随机抖动**：固定 45 秒整的节奏比带抖动的更像脚本。成本为零的规避
- M1 用不上 croner 的 cron 表达式，一个 while 循环更直白。M3 的动态轮询（3-10 分钟，多任务不同周期）再引入 croner

### 8.4 OneBot 消息

用消息段数组，不用 CQ 码 —— 免去转义问题（标题里出现 `[` `]` 是很常见的）。

```ts
const message = [
  { type: 'text',  data: { text: `${uname} 开播了\n${title}\n${areaName}\n` } },
  { type: 'image', data: { file: keyframe } },        // 直接用 URL，不落盘不 base64
  { type: 'text',  data: { text: `\nhttps://live.bilibili.com/${roomId}` } },
];
```

- `keyframe` 是B站 CDN 的公网 URL，NapCat 自己去拉，我们不碰文件。[media-capture.md](research/media-capture.md#keyframe服务端已经帮你截好了-实测) 确认它连 UA 都不要
- **图片失败要降级为纯文本重发一次**，而不是整条推送失败。预览图是锦上添花，通知本身不能丢
- token 走 `Authorization: Bearer <token>` header
- 检查返回的 `retcode`，`status: "ok"` 但 `retcode != 0` 也是失败

### 8.5 Dispatcher

- 并行 fan-out，`Promise.allSettled` —— 一个通道失败不能拖累另一个
- 每通道结果写 `notify_log`
- **只要有任一通道成功就标记 `notified_at`**。否则 Toast 成功、QQ 失败会导致下一轮重推，QQ 修好后你会收到一堆积压
- `retryable` 的失败（网络类）下一轮重试；不可重试的（配置错、目标不存在）直接记录不重试

## 9. 任务分解

按依赖顺序，每步都可独立验证。

| # | 任务 | 验证方式 | 依赖 |
|---|---|---|---|
| 1 | 脚手架：`package.json`、`tsconfig.json`、`.gitignore`、目录结构 | `npm run build` 通过 | — |
| 2 | `logger.ts` + `config/` + zod 校验 | 故意写错配置，看是否启动即报错并指明字段 | 1 |
| 3 | `core/db.ts` 建表 | 跑一次生成 `.db` 文件，`sqlite3` 能看到三张表 | 1 |
| 4 | `sources/bili/client.ts` + `live-status.ts` | **拿阿梓 uid 真实跑一次**，打印 `live_status`/`title`/`keyframe` | 2 |
| 5 | `notify/types.ts` + `onebot.ts` | **CLI 手动触发一条测试推送到 QQ** | 2 |
| 6 | `notify/toast.ts` | 弹出 Toast，带图，点击能进浏览器 | 2 |
| 7 | `core/state.ts` 状态机 | 单元测试：喂构造的前后状态序列，断言产出的 Signal | 3 |
| 8 | `analysis/{types,noop}.ts` + `rules/{types,once-per-session}.ts` | 单元测试：同一 `live_time` 第二次调用返回不推 | 3,7 |
| 9 | `notify/dispatcher.ts` | 单元测试：一个通道抛错，另一个仍执行 | 5,6 |
| 10 | `core/scheduler.ts` + `index.ts` 装配 | **端到端**：改短间隔跑起来，观察日志 | 全部 |
| 11 | dry-run 模式 + 健康告警 | 断网模拟连续失败，看是否告警 | 10 |

### 任务 7 的测试尤其重要

状态机是 M1 唯一有真实逻辑分支的地方，也是最容易出 bug 的地方。必须覆盖：

| 场景 | 期望 |
|---|---|
| `0 → 1` | 产出 `live_start` |
| `1 → 1`，`live_time` 不变 | 无 Signal |
| `1 → 1`，`live_time` 变了 | 产出 `live_end` + `live_start`（下播又开播） |
| `1 → 1`，标题变了 | 产出 `title_change` |
| `1 → 0` | 产出 `live_end` |
| `1 → 2` | 产出 `live_end`（轮播视为未开播） |
| `1 → 拉取失败` | **无 Signal，状态保持不变** |
| 冷启动 `∅ → 1` | 依 `notifyOnFirstRun` 决定 |

这些用构造数据测，不需要网络。

## 10. 手动验证手段

真实开播是不可控事件，不能干等。三个手段：

1. **`--dry-run`**：正常轮询和判定，但推送只打日志不真发。可以长时间挂着观察
2. **`--test-notify`**：用一条假 `LiveEvent` 立刻走完整推送链路。验证 NapCat 配置和消息格式
3. **`--force-uid <uid>`**：临时监听一个**当前正在直播**的房间（从B站首页热门随便找一个），配合清空 DB，可以立刻触发一次真实的 `live_start` 全链路

第 3 个是关键——不用等阿梓开播就能验证端到端。

## 11. 失败模式清单

实现时逐条确认已处理：

| 失败 | 处理 |
|---|---|
| 网络超时 / DNS 失败 | 重试 2 次 → 计入健康计数 → **不改状态** |
| `code != 0`（风控） | 同上，日志区分于 HTTP 错误 |
| 返回里缺某个 uid 的 key | 当作未开播，**不当作失败** |
| `keyframe` 字段为空 | 推纯文本 |
| 图片 URL 已过期 / NapCat 拉图失败 | 降级纯文本重发一次 |
| NapCat 未启动 / 端口不通 | 记 `notify_log`，**Toast 仍要成功**，触发健康告警 |
| NapCat 返回 `retcode != 0` | 视为失败，检查是否 token 错或目标不存在 |
| QQ 账号被踢下线 | NapCat 会报错 → 走上面的路径 → Toast 告警 |
| DB 文件被占用 / 损坏 | 启动即失败并明确报错，不要静默降级到内存 |
| 配置里 uid 写错（不存在） | 返回里没这个 key，永远不推。**启动时校验一次并警告** |
| 进程被杀 | 下次启动从 `room_state` + `live_sessions` 恢复，不重推 |
| 系统休眠唤醒后 | 时间跳变，下一次轮询正常执行即可（`live_time` 逻辑天然免疫） |

## 12. 技术栈

```jsonc
{
  "type": "module",
  "dependencies": {
    "better-sqlite3": "^13.0.2",
    "zod": "^4.4.3",
    "powertoast": "^3.0.0"
  },
  "devDependencies": {
    "typescript": "^5",
    "tsx": "^4",
    "@types/node": "^22",
    "@types/better-sqlite3": "^7"
  }
}
```

- **不装 axios**：Node 22 原生 `fetch` 够用
- **不装 croner**：M1 一个循环够，M3 多周期任务再引入
- **不装日志库**：`logger.ts` 40 行手写。真需要结构化查询再换 pino
- ESM + `tsx` 开发、`tsc` 构建后用 `node dist/index.js` 常驻（避免常驻进程反复走转译）

## 13. 常驻运行

M1 先用手动启动（`npm start` 挂在终端里）。真要常驻，Windows 上用**任务计划程序**建一个「登录时触发」的任务，比写 service 简单。

进程崩溃自动重启也放在这一层解决（任务计划的重启策略），不在代码里自己实现守护逻辑。

## 14. 验收

1. 从B站热门找一个正在直播的房间，用 `--force-uid` + 空 DB 启动 → **1 分钟内 QQ 收到带预览图的通知，点击进直播间**
2. 保持运行 10 分钟 → **不再收到该房间的重复通知**
3. 重启进程 → **仍不重推**
4. 停掉 NapCat 再触发一次 → **Toast 仍弹出，且收到健康告警**，`notify_log` 里有失败记录
5. 断网 3 分钟 → **不产生假的下播/开播**，恢复后正常
6. 配置里故意写错一项 → **启动即报错并指明字段**
7. 阿梓真实开播 → 收到通知（最终验收，需等实际事件）

前 6 条不依赖真实开播，可以当天全部跑完。

## 14.5 实施记录：与本计划的偏离

实现过程中发现了几处计划没预见的问题，都已修正。记在这里以免后面重复踩。

### 计划里遗漏的「多主播」假设

计划通篇隐含「只有一个主播」，实现后逐层复查发现 4 处会真的出错：

| 问题 | 修法 |
|---|---|
| **推送延迟线性累积**：`for uid` 串行 await `broadcast`，10 个主播同时开播时第 10 条要等前 9 条 HTTP 往返完成（NapCat 超时 15s，最坏 150s） | 新增 `core/concurrency.ts` 的 `mapLimit`，并发上限 4 |
| **新增订阅时正在播的那场永久丢失**：新 uid 在 DB 里没记录 → 被当成「首次运行」→ `notifyOnFirstRun: false` 下静默跳过，得等主播下播再开播才有通知 | 用 `known` 集合区分「首次运行」与「新增订阅」，新增 `notifyOnNewSubscription` 配置项，默认 `true` |
| **`uids` 无分片**：全部 uid 塞一个 POST，订阅多了可能被截断 | `CHUNK_SIZE = 50` 分片 |
| **`synthesizeOffline` 造出空 uid**：返回里缺某 uid 时 signal 的 uid 是 `''`，signal 无法自证属于谁 | `diffRoom` 改为显式接收 `uid` 参数 |

另外 3 处退化也一并处理：DB 每轮 N 次独立写 → 包进一个事务；OneBot 对同一目标并发轰 → 每目标一条串行链 + 1.2s 最小间隔（群聊上限 20 条/分钟）；健康告警文案补上「全部 N 个订阅都收不到通知」。

### 4.2 的行为被拆成两个配置项

原计划只有 `notifyOnFirstRun`。实际需要区分两种「无 prev」的情况——它们语义完全不同，见上表第 2 行。`diffRoom` 只接受 `notifyOnColdStart` 布尔值，「是首次运行还是新增订阅」的政策判断留在 scheduler，保持状态机是纯函数。

### 8.4 的图片降级要加条件

原计划「图片失败降级纯文本重发」。实测 NapCat 没启动时，降级重试必然同样失败，白费一次请求。改成只在 `reached === true`（请求真的拿到了 HTTP 响应）时才降级。

### 依赖与工具

- **powertoast v3 是类 API**（`new Toast(opts).show()`），不是计划假设的默认导出函数。字段名也不同：`aumid` 不是 `appID`、`activation` 不是 `onClick`。预览图用 `heroImg`（大图横幅）而非 `icon`（小缩略图）
- **配置文件加了 JSONC 注释支持**。剥离注释必须跳过字符串内部，否则 `"https://..."` 里的 `//` 会被误删
- **加了 BOM 剥离**。Windows 记事本另存、PowerShell `Out-File -Encoding utf8` 都会写 BOM，而 `JSON.parse` 不接受
- **`fetchLiveStatus` 改为可注入**。原计划无法单测「拉取失败不产生假下播」这条最关键的正确性属性

### 真实数据验证到的

- 阿梓 `live_status=1`、泠鸢 `live_status=2`（**轮播中真实存在**，不处理会把B站自动放的录像推成开播）、不存在的 uid 在返回里直接缺 key
- keyframe URL 不带任何 header 即可访问（200，82.6 KB），印证 [media-capture.md](research/media-capture.md)

### 未做（超出 M1 范围，留给后续决策）

- **多主播同时开播是逐条推还是合并成一条**
- **能否按主播配不同推送目标**（现在全局共用一套 `targets`）
- NapCat 未部署，QQ 通道尚未在真实 NapCat 上验证

## 15. M1 完成后的状态

- 一个能用的开播通知器
- `Analyzer` / `DecisionRule` / `Notifier` 三个接口就位，M2 接真 LLM 不动现有代码
- `BiliClient` 的 UA 注入与错误处理，M2 加 WBI 签名直接复用
- 一套可查询的历史数据（谁什么时候开播了、推没推成功），M2 调判定准确率时用得上

