# DD-claw 项目设计

## 1. 目标

监听B站关注列表**全部主播**（直播间 + B站动态 + 微博），对抓取到的信息做**持续状态追踪**，用 LLM 分析（直播内容分类、预告时间表），按用户的**自然语言偏好**生成并路由推送。

「阿梓唱歌才推送」只是偏好规则的一个实例，不是系统目标本身。系统目标是把「抓取 → 追踪 → 分析 → 偏好 → 推送」每一环都做成可替换的模块，以承载不断变复杂的需求。

### 规模假设（决定设计）

| 项 | 量级 | 架构推论 |
|---|---|---|
| 关注主播 | 上百位 | 订阅列表不能手写，必须**关注列表同步**（需 SESSDATA，凭据从 M3 提前到 M2） |
| 高峰同时在播 | 30+ | 开播检测必须**批量一次拉取**；LLM 分析必须**排队限流**，不能内联在轮询循环里 |
| 信号性质 | 持续状态，非一次性事件 | 原始数据**全部入库归档**，供后续分析反复使用（动态 → 预告时间表，截图 → 主题判断） |
| 偏好描述 | 自然语言（「阿梓唱歌速来」「打瓦就发 阿梓开瓦了快跑」） | 偏好解释交给 LLM（文案/优先级/方向），确定性护栏留在规则层 |

### 目标分层

| 层级 | 内容 | 鉴权 |
|---|---|---|
| **基础** | 批量开播检测 → 标题/分区/开播时间 → 推 QQ + 本机 Toast | 匿名 |
| **规模化** | 关注列表同步、全员持续追踪、原始数据归档 | SESSDATA |
| **智能** | 弹幕+多源 LLM 内容判定、预告时间表、自然语言偏好生成推送 | cookie 全套 |
| **远期** | 直播中抽查触发、时间表自动维护、产品化 UI | — |

## 2. 核心判断：这是一个自然语言融合问题

内容判定的主路径**不是**图像识别或音频分析，而是**用 LLM 融合多个互相矛盾的文本信号**。

信号可靠性排序：

| 信号 | 成本 | 说明 |
|---|---|---|
| 直播间标题 | 零 | 「歌回」直接命中，但主播常年不改标题 |
| 分区 | 零 | 是先验不是真相，挂网游区唱歌很常见 |
| **弹幕流** | 低 | 观众反应最诚实：刷「好听」vs 刷「这波打得好」 |
| **B站动态 / 微博** | 高（需凭据） | 「等会儿唱歌」这类预告，信息量最大 |
| 画面内文字 | 低 | 游戏 HUD、歌名字幕、点歌台 |
| 画面语义 | 中 | 前述信号都不足时才动用视觉模型 |
| 音频 music/speech | 中 | **纯辅助**，末位接入 |

### 为什么规则引擎不够

```
主播: 阿梓从小就很可爱
标题: 孩子们下午好                          ← 无信息
分区: 网游 / 无畏契约                        ← 指向游戏
动态(2h前): 今天先打两把瓦，等会儿唱歌         ← 指向即将切换
弹幕(近60条): 好听 / 这歌名是啥 / 梓宝唱得好   ← 指向已经在唱
```

规则必然判错（分区还挂着网游）。LLM 能得出「已切换到唱歌，依据是动态预告 + 弹幕反应，分区未更新」。

这是纯文本任务，不需要视觉，不需要音频。也因此免费额度压力小一个量级。

## 3. 技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| 语言 | TypeScript / Node.js | 音频降级为末位后 Python 优势消失；RSSHub 同语言、Playwright 一等公民、zod schema 顺、后期 UI 直接 Next.js |
| 运行 | 本机 Windows 常驻 | 无 Docker；架构预留容器化 |
| 数据库 | `better-sqlite3` | 实测下预编译二进制，不触发本机编译 |
| 调度 | `croner` | 零依赖、TS 原生、支持重叠防护 |
| LLM | Vercel AI SDK (`ai` + `@ai-sdk/google` + `@ai-sdk/openai-compatible`) | 业务只写一次 zod schema，换模型不改调用代码 |
| ffmpeg | `child_process.spawn` 直调 | `fluent-ffmpeg` 一年多未大动；本机已有 7.1.1 |
| QQ | NapCatQQ（OneBot 11 HTTP） | 唯一活跃选择，详见 [notify](research/notify.md) |
| Toast | `powertoast` | 比 `node-notifier` 更贴近原生 API |
| 中文 OCR | **隔离成独立服务** | TS 侧短板，详见 [ts-stack](research/ts-stack.md) |

被否掉的方案，理由记录在案：

- **借用 opencode / agent CLI 当 LLM 后端** — 封号风险，见 [llm.md](research/llm.md#不采用-agent-cli-当后端)
- **依赖 `bilibili-api-python` 等封装库** — 已归档停维，见 [live-status.md](research/live-status.md#开源实现)
- **自动读取浏览器 cookie** — Chrome ABE 已封死，见 [auth-cookie.md](research/auth-cookie.md)
- **纯 Python 单体** — 音频不再是主路径后失去理由
- **全员弹幕 WS 常驻** — 改为按需拉起，见下

## 4. 架构

三段解耦：**抓取**、**分析**、**推送**。解耦点有三个：

1. **Signal 总线**（抓取 → 分析）：source 不知道有 LLM，只产信号和原始数据
2. **任务化 LLM 接口**（分析内部）：schema 进，JSON 出，中间用什么模型/服务商随时替换
3. **PushDirective**（分析 → 推送）：推送层不解释语义，只执行路由和通道规则

```
┌─ 1. 抓取 sources/   持续生产：原始数据入库归档 + 状态变更信号上总线
│   ├─ bili/follows      关注列表同步         [SESSDATA] → 自动维护订阅表
│   ├─ bili/live-status  批量轮询（分片 POST） [匿名]    → 开播/下播/标题变更
│   ├─ bili/danmaku      WS 按需拉起          [匿名]    → 弹幕文本流
│   ├─ bili/dynamic      空间动态             [cookie]  → 预告/延播文本
│   ├─ weibo/feed        微博时间线           [cookie]  → 预告/延播文本
│   └─ media/keyframe    画面采样             [匿名]    → 截图引用
│                            ↓
│   core/db  原始归档：signals / posts / snapshots / follows …（持续状态，供反复分析）
│   core/bus 变更信号：live_start / live_end / title_change / feed_post / …
│                            ↓
│   core/pipeline  信号编排（唯一装配点）：bus → triggers → 分析队列 → 护栏 → 推送
│                            ↓
├─ 2. 分析 analysis/  LLM 即任务：zod schema 进，JSON 出
│   ├─ triggers    触发策略：开播时 / 新动态时 /（预留）直播中抽查、定时全量
│   ├─ queue       分析队列：并发受限 + 优先级 + 结果缓存  ← 高峰 30+ 在播的关键
│   ├─ tasks/      scene-classify    内容分类（游戏/唱歌/杂谈/演出…）
│   │              schedule-extract  从动态/微博解析预告时间表
│   │              push-compose      按自然语言偏好生成推送文案/优先级/方向
│   ├─ context     按房间聚合时间窗内多源数据 → 一份 context
│   └─ providers   熔断 + 多 key 池 + 降级链
│                            ↓
│   判定结果入库：verdicts / schedules 表
│                            ↓
├─ 护栏 rules/     确定性过滤，不经过 LLM：静音名单、静默时段、每场一次、冷却窗口
│                            ↓
│              PushDirective { priority, targets[], message, image? }
│                            ↓
└─ 3. 推送 notify/   只负责执行
    ├─ dispatcher  按 directive.targets 路由；通道级规则（某群忽略某主播、丢弃低优先级）
    └─ channels/   onebot(NapCat) / toast / ntfy —— 实现 Notifier 接口即可增删
```

替换规则：

- 加数据源（抖音、YouTube）→ 只写一个 source
- 换模型 / 换服务商 → 只动 providers，task 的 schema 和 prompt 不变
- 加 LLM 任务（新分析维度）→ 只在 tasks/ 加一个文件
- 加推送通道 → 只实现 Notifier 接口
- 改偏好措辞 → 只改配置里的自然语言规则，不动代码

### Pipeline：唯一的装配点

信号进入系统后的编排只发生在 `core/pipeline`：从 bus 订阅信号 → triggers 决定要不要分析 → 分析队列 → rules 护栏 → PushMessage → dispatcher。

推论：**source 内不允许出现任何通知逻辑**。冷启动抑制、每场一次去重、健康告警的阈值判断，全部在 pipeline 及之后的层；source 只负责如实产信号（打上 `coldStart` 等标记）和归档原始数据。状态机保持纯函数，不做政策判断。

### 全员开播检测：一个批量接口，不是逐个轮询

`get_status_info_by_uids` 本身就是批量接口（POST，50/批分片）：150 个关注 = 每分钟 3 个请求，量级可忽略。**不存在「一个个轮询」的问题**。

备选是「关注中正在直播」接口（一次请求只回在播的，需 SESSDATA）。两者实现同一个 `LiveStatusProvider` 接口，可互换——接口层集中封装就是为此准备的。

### 高峰并发的关键：分析不入轮询循环

轮询循环只做两件便宜的事：拉批量状态、diff 产信号。所有 LLM 调用进 `analysis/queue`：并发上限、按优先级排队、时间窗内信号无显著变化则复用上次结果（缓存）。30+ 同时开播时，推送通知（便宜）照常即时发出，内容分析（贵）排队跟进。

### 弹幕 WS 的定位

不是全员常驻。逐房间建连的成本（连接池、心跳、token 刷新）在几十上百个关注对象时不划算。

```
轮询层（批量，30-60s）── 发现开播 ──┐
                                  ↓
              该房间开了内容分析？ ── 是 ── 拉起弹幕 WS ── 采样 ── 进分析队列
                                  ↓
                      下播事件 ── 关闭连接
```

实际并发只有「正在直播 且 已开启分析」的几路。高峰 30+ 在播时也可用配置限制只对重点主播开分析。

### 偏好放哪一层（已决策）

自然语言偏好规则（「阿梓唱歌就在群里通知：阿梓唱歌速来」「打瓦就发：阿梓开瓦了快跑」）由 `analysis/tasks/push-compose` 用 LLM 解释：输入 = verdict + 用户规则文本，输出 = PushDirective（推送词、优先级、目标群/私聊）。

三层职责：

| 层 | 管什么 | 例子 |
|---|---|---|
| analysis（LLM） | **语义**：要不要推、推什么文案、什么优先级、推给谁 | 「这是唱歌 → 命中规则 → 发群，文案『阿梓唱歌速来』，高优先级」 |
| rules（确定性） | **护栏**：无论如何都要执行的过滤 | 静音名单、静默时段、每场一次去重、冷却窗口 |
| notify（执行） | **路由**：通道级覆盖与发送 | 某群屏蔽某主播、低优先级不推、图片降级、失败重试 |

LLM 出错时护栏仍然兜底；通道规则不依赖 LLM 可用性。

## 5. 目录结构

```
DD-claw/
├─ docs/                          本文档
├─ src/
│  ├─ core/
│  │   ├─ bus.ts                  类型化事件总线（Signal 发布订阅）
│  │   ├─ types.ts                Signal / PushMessage / LiveEvent 等领域类型
│  │   ├─ state.ts                纯函数状态机 diffRoom
│  │   ├─ db.ts                   SQLite + 仓储
│  │   ├─ scheduler.ts            PeriodicTask：通用周期任务（间隔+抖动+不重叠）
│  │   ├─ pipeline.ts             信号编排唯一装配点
│  │   └─ concurrency.ts          mapLimit / 信号量
│  ├─ sources/
│  │   ├─ types.ts                Source 接口（start/stop，只产 Signal + 归档）
│  │   └─ bili/
│  │       ├─ client.ts           HTTP 层，强制注入 UA
│  │       ├─ types.ts            接口返回类型
│  │       ├─ live-status.ts      批量接口 get_status_info_by_uids
│  │       ├─ live-status-source.ts  轮询 + diff + 冷启动标记 + 健康计数
│  │       ├─ follows.ts          关注列表同步（SESSDATA）
│  │       ├─ danmaku.ts          WS 按需拉起/关闭
│  │       └─ dynamic.ts          空间动态
│  │   （weibo/feed.ts、media/keyframe.ts 与 bili/ 同级）
│  ├─ analysis/
│  │   ├─ types.ts                Analyzer / AnalysisContext / SceneVerdict / LlmTask
│  │   ├─ queue.ts                分析队列：并发受限（预留合并、缓存）
│  │   ├─ triggers.ts             触发策略（开播/新动态/抽查）
│  │   ├─ providers.ts            熔断 + 多 key 池 + 降级链
│  │   └─ tasks/                  scene-classify / schedule-extract / push-compose
│  ├─ rules/{types,once-per-session,preference}.ts
│  ├─ notify/
│  │   ├─ types.ts                Notifier / PushMessage
│  │   ├─ message.ts              LiveEvent → PushMessage 映射
│  │   ├─ dispatcher.ts           路由 + fan-out + 通道级规则
│  │   └─ onebot.ts / toast.ts / ntfy.ts
│  ├─ config/
│  └─ index.ts                    装配根：只 new 和接线，不含业务逻辑
├─ cookies.json                   gitignore
└─ .env                           gitignore
```

## 6. 关键数据结构

```ts
/** 平台无关的直播间状态。core 只认识它；bili 的 RoomStatus 是它的扩展（多 rawLiveStatus） */
type LiveStatus = {
  uid: string; roomId: string; uname: string; title: string;
  isLive: boolean;                        // 平台特异语义已折叠（如 bili 轮播视为未开播）
  liveTime: number;                       // 本场开播时间戳，一场直播的身份
  areaName: string; parentAreaName: string; cover: string; keyframe: string;
};

type SignalKind =
  | 'live_start' | 'live_end' | 'title_change'      // live-status source
  | 'feed_post' | 'danmaku_batch' | 'snapshot'      // 预留：动态/弹幕/画面
  | 'health_alert';                                 // 监听自身健康

type Signal = {
  source: string;                           // 'bili/live-status' 等
  kind: SignalKind;
  uid: string; roomId: string; ts: number;
  status?: LiveStatus;                      // live 系信号携带（平台无关；bili 的 RoomStatus 是其扩展）
  previousTitle?: string;
  coldStart?: 'first_run' | 'new_subscription';   // source 只标记，抑制策略在 pipeline
  payload?: unknown;                        // 各 source 自定义
};

type SceneVerdict = {
  scene: 'chatting' | 'singing' | 'gaming' | 'show' | 'other';
  confidence: number;                     // 0-1
  evidence: string[];                     // 2-4 条判断依据
  secondaryScene?: SceneVerdict['scene'] | null;   // 边打游戏边聊天
};

/** pipeline 内部载荷：一场直播的完整快照 + 判定结果 */
type LiveEvent = {
  platform: 'bilibili'; roomId: string; uid: string; uname: string;
  title: string; areaName: string; parentAreaName: string;
  cover: string; keyframe?: string; roomUrl: string; startedAt: number;
  verdict?: SceneVerdict;                 // 分析层未启用时为空
};
```

规模化后新增：

```ts
/** LLM 任务统一形态：zod schema 进，JSON 出，provider 可替换 */
interface LlmTask<I, O> {
  readonly name: string;
  buildPrompt(input: I): unknown;         // 文本或多模态消息
  parse(raw: unknown): O;                 // zod 校验
}

/** 预告时间表条目（schedule-extract 产出；低置信度进人工确认，不自动改表） */
type ScheduleEntry = {
  uid: string; sourcePostId: string;
  plannedAt: number | null;               // null = 只解析出模糊时间
  rawText: string; confidence: number;
  status: 'pending' | 'confirmed' | 'done' | 'cancelled';
};

/** 推送指令（push-compose 产出，rules 护栏过滤后交 notify 执行） */
type PushDirective = {
  priority: 'high' | 'normal' | 'low';
  targets: Array<{ type: 'group' | 'private'; id: string }>;
  message: string;                        // LLM 按偏好规则写好的推送词
  image?: string;
  event: LiveEvent;                       // 溯源用
};

/** 推送层的通用载荷。notify 不认识 LiveEvent / PushDirective，只认识 PushMessage */
type PushMessage = {
  title: string; body: string;
  image?: string; url?: string;           // 点击跳转
  priority: 'high' | 'normal' | 'low';
  targets?: Array<{ type: 'group' | 'private'; id: string }>;  // 缺省 = 各通道默认目标
};

interface Notifier {
  readonly name: string;
  readonly capabilities: { image: boolean; clickThrough: boolean };
  send(msg: PushMessage): Promise<{ ok: boolean; error?: string; retryable?: boolean }>;
}
```

注意冷启动抑制的归属：`diffRoom` 永远如实产出 `live_start`（打上 `coldStart` 标记），「首次运行不刷屏 / 新增订阅要通知」的政策判断在 pipeline 按配置执行。状态机不做政策判断。

### 数据库表（在 M1 三表之上扩展）

| 表 | 答什么问题 | 状态 |
|---|---|---|
| `live_sessions` / `notify_log` / `room_state` | 这场推过没 / 推的时候发生了什么 / 重启恢复基线 | 已有 |
| `follows` | 关注列表快照，订阅表的数据源 | 待建 |
| `signals` | 原始信号流归档（所有 source 的原始 payload） | 待建 |
| `posts` | 动态/微博原文，供预告解析反复使用 | 待建 |
| `snapshots` | 画面采样引用，供内容判定 | 待建 |
| `verdicts` | LLM 判定结果（含 evidence，可追溯误判） | 待建 |
| `schedules` | 预告时间表 | 待建 |

## 7. 降本分层

LLM 不是每次采样都调。分层拦截，越靠前越便宜：

| 层 | 手段 | 成本 |
|---|---|---|
| L0 | 标题/分区关键词命中（「歌回」「唱歌」） | 零 |
| L0 | 动态结构化信号（`MAJOR_TYPE_LIVE_RCMD`、预约卡片） | 零 |
| L1 | 弹幕词频统计（「好听」类 vs 游戏术语类占比） | 零 |
| L1 | keyframe 帧间差异 / 画面变化率 | 极低 |
| L2 | **LLM 融合判定**（仅前面层不确定时） | 免费额度 |
| L3 | 视觉 LLM 看画面（文本信号全部矛盾时） | 免费额度，更贵 |
| L3 | 音频 music/speech 检测（边界情况二次确认） | 本地算力 |

外加两级省钱手段：

- **结果缓存**：时间窗内信号无显著变化则复用上次判定。最直接，尤其「聊天」「挂机」这类长时间不变的场景
- **分析队列去重**：同一房间短时间内多个触发源（开播 + 新动态 + 弹幕突变）合并成一次 LLM 调用

## 8. 里程碑

凭据（cookie/SESSDATA）从原 M3 **提前到 M2**：关注列表同步和动态/微博都依赖它，而它们是规模化的前提。

### M1 — MVP：开播通知（已完成，QQ 通道待验证）

批量轮询 + 状态机 + OncePerSession + OneBot/Toast。实施中确认的经验已折叠进 [boundaries.md](boundaries.md) 第 5 节。**遗留：NapCat 部署后跑 `--test-notify` + `--force-uid` 验证 QQ 链路。**

### M2 第 0 步 — 架构纠偏（先于一切新功能）

**此前的任务规划没有包含这一步**——旧计划假设在 M1 代码上增量演进，但 M1 的「调度器一个类包揽 拉取→判定→规则→推送」结构承载不了第 4 节的架构。纠偏内容：

- 事件总线落地（`core/bus`），source 与 pipeline 彻底分离
- `Source` 接口统一（start/stop，只产 Signal + 归档）
- 通用周期任务器（`PeriodicTask`），轮询循环从「编排者」降级为 source 的内部细节
- `core/pipeline` 成为唯一装配点，接管冷启动抑制、健康告警、分析调度
- 分析队列落地（当前接 NoopAnalyzer，接口就位）
- `PushMessage` 通用载荷，`Notifier` 不再认识 `LiveEvent`

不新增任何功能，行为与 M1 对齐（全部既有测试保持有效，验收清单重跑）。

### M2 — 规模化 + 内容判定

凭据管理（cookie 导入、`isLogin` 心跳失效告警）→ follows 同步订阅表 → 原始数据归档（signals/posts/snapshots 表）→ 弹幕 WS 按需拉起 → scene-classify → verdicts 入库。

验收：上百位订阅批量轮询稳定运行；高峰在播时分析排队不阻塞通知；阿梓唱歌推、打游戏静默，判定依据可从 verdicts 表追溯。

### M3 — 预告时间表

dynamic / weibo sources → schedule-extract → schedules 表 + **低置信度人工确认队列**（不自动改表）→ 新推送时机：预告发布时、预告时间临近时。

### M4 — 偏好与路由

push-compose（自然语言偏好 → PushDirective）→ rules 护栏完善（冷却窗口、状态跳变抑制）→ dispatcher 通道级规则（群 × 主播屏蔽、优先级阈值）→ 直播中抽查触发器。

### M5 — 产品化

Web UI（Next.js）、时间表可视化、偏好规则配置界面、多平台数据源。

## 9. 风险登记

| 风险 | 影响 | 应对 |
|---|---|---|
| B站风控收紧 | 接口失效 | 轮询 ≥30s、带 UA、只用匿名接口；接口层集中封装便于替换 |
| cookie 泄露 | **账号被完整冒充** | gitignore、不落日志、建议小号、兜底改密码 |
| cookie 过期 | 关注同步/预告功能静默失效 | `isLogin` 心跳 + 停止轮询 + 主动告警 |
| 免费额度耗尽/政策变动 | 分析层瘫痪 | provider 熔断降级链 + 多 key 池；L0/L1 规则层仍可独立工作 |
| NapCat 账号被封 | QQ 通道失效 | 用小号；Toast/ntfy 作为独立通道不受影响 |
| LLM 判定误报 | 该推的没推 / 不该推的推了 | evidence 可追溯；置信度阈值可调；偏好支持「宁滥勿缺」模式 |
| LLM 生成推送词不当 | 群里发出奇怪文案 | push-compose 输出走 schema 校验；护栏层可设「只用模板文案」降级模式 |
| 高峰分析积压 | 判定延迟 | 队列优先级（开播触发 > 抽查）；通知不等分析结果 |
| B站接口文档仓库已被法务关停 | 无权威参考 | 关键接口自行实测记录在 docs/research/；不在项目内大量摘录接口清单 |

## 10. 待定项（显式留缝，实现前再定）

| 问题 | 当前倾向 | 影响面 |
|---|---|---|
| 直播中抽查的触发策略 | 定时 + 弹幕突变双触发 | analysis/triggers |
| 自然语言偏好规则的存储格式 | 配置文件中每主播一段自由文本 + 目标渠道声明 | config schema、push-compose prompt |
| 主播 → 微博账号的映射 | config 手动配 `weiboUid`，自动发现不可靠 | follows 同步、weibo source |
| 微博关注列表是否也要同步 | 暂不同步，以B站关注为准 | follows |
| 多主播同时开播合并推送 | 逐条推（M1 遗留，量大了再议） | dispatcher |
