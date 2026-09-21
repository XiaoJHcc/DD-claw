# DD-claw 项目设计

## 1. 目标

监听B站关注列表**全部主播**（直播间 + B站动态 + 微博），对抓取到的信息做**持续状态追踪**，用 LLM 分析（直播内容分类、预告时间表），按用户填写的**推送规则**生成并路由推送。

「阿梓唱歌才推送」只是偏好规则的一个实例，不是系统目标本身。系统目标是把「抓取 → 追踪 → 分析 → 偏好 → 推送」每一环都做成可替换的模块，以承载不断变复杂的需求。

### 规模假设（决定设计）

| 项 | 量级 | 架构推论 |
|---|---|---|
| 关注主播 | 上百位 | 订阅列表不能手写，必须**关注列表同步**（需 SESSDATA，凭据从 M3 提前到 M2） |
| 高峰同时在播 | 30+ | 开播检测必须**批量一次拉取**；LLM 分析必须**排队限流**，不能内联在轮询循环里 |
| 信号性质 | 持续状态，非一次性事件 | 原始数据**全部入库归档**，供后续分析反复使用（动态 → 预告时间表，截图 → 主题判断） |
| 偏好描述 | 每主播若干条「条件 → 动作」（唱歌就群发「阿梓唱歌速来」） | 面板直填分类规则 + 推送规则，确定性匹配执行，偏好链路不依赖 LLM |

### 目标分层

| 层级 | 内容 | 鉴权 |
|---|---|---|
| **基础** | 批量开播检测 → 标题/分区/开播时间 → 推 QQ + 本机 Toast | 匿名 |
| **规模化** | 关注列表同步、全员持续追踪、原始数据归档 | SESSDATA |
| **智能** | 弹幕+多源 LLM 内容判定、预告时间表、按推送规则路由推送 | cookie 全套 |
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
| 画面语义 | 中 | 前述信号都不足时才动用视觉模型（2026-08-06 起：**凡输入含图一律走多模态模型**，见 [llm.md](research/llm.md)） |
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

这是纯文本任务，不需要视觉，不需要音频。也因此免费额度压力小一个量级。（2026-08-06 修正：文本融合仍是**主路径**，但多模态已是硬要求——输入含图的任务一律走 vision 路由的多模态模型，纯文本任务才走便宜文本模型。）

## 3. 技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| 语言 | TypeScript / Node.js | 音频降级为末位后 Python 优势消失；RSSHub 同语言、Playwright 一等公民、zod schema 顺、后期 UI 直接 Next.js |
| 运行 | 本机 Windows 常驻 | 无 Docker；架构预留容器化 |
| 数据库 | `better-sqlite3` | 实测下预编译二进制，不触发本机编译 |
| 调度 | `croner` | 零依赖、TS 原生、支持重叠防护 |
| LLM | OpenAI 兼容 API 直连（原生 fetch，`analysis/providers.ts` 聚合：text/vision 路由 + 熔断 + key 池） | 2026-08-06 修订：不引 SDK/网关，provider 配置数组即聚合层；多模态模型走 vision 路由，便宜文本模型走 text 路由 |
| ffmpeg | `child_process.spawn` 直调 | `fluent-ffmpeg` 一年多未大动；本机已有 7.1.1 |
| QQ | NapCatQQ（OneBot 11 HTTP） | 唯一活跃选择，详见 [notify](research/notify.md) |
| Toast | `powertoast` | 比 `node-notifier` 更贴近原生 API |
| 中文 OCR | **隔离成独立服务** | TS 侧短板，详见 [ts-stack](research/ts-stack.md) |

被否掉的方案，理由记录在案：

- **coding 订阅反代成 API** — 正是被封号的 harness 模式本体，见 [llm.md](research/llm.md#agent-cli-当后端风险评估2026-08-06-修正)。（2026-08-06 终版：OpenCode 走官方 API 接入，CLI / 反代方式舍弃；订阅反代仍不做）
- **外部 LLM 网关（LiteLLM / one-api）** — provider 配置数组已是聚合层，本项目常驻进程不需要第二个常驻进程做重复的路由/熔断
- **依赖 `bilibili-api-python` 等封装库** — 已归档停维，见 [live-status.md](research/live-status.md#开源实现)
- **自动读取浏览器 cookie** — Chrome ABE 已封死，见 [auth-cookie.md](research/auth-cookie.md)
- **纯 Python 单体** — 音频不再是主路径后失去理由
- **全员弹幕 WS 常驻** — 改为按需拉起，见下

## 4. 架构

项目有**两条正交的轴**：**轴 A 运行时数据流**（事件从抓到推）、**轴 B 能力面与接入**（查数据/改设置的 N 种入口）。旧「抓取→分析→推送 三段」只描述了轴 A。两轴的交叉点是 SQLite（尤其 `settings`）——它既是轴 A 的归档，也是轴 B 的唯一配置信源。

### 轴 A — 运行时数据流

```
┌─ 抓取 sources/   持续生产：原始数据入库归档 + 变更信号上总线
│   ├─ bili/live-status  批量轮询（分片 POST） [匿名] → 开播/下播/标题变更
│   ├─ bili/follows      关注列表同步         [SESSDATA]
│   ├─ bili/dynamic      空间动态             [cookie]  → 正文/预告文本
│   ├─ weibo/feed        微博时间线           [cookie]  → 独立图文来源（weibo_accounts 名单）
│   ├─ twitter/feed      X 时间线             [代理]    → 独立图文来源（x_accounts 名单）
│   ├─ media/keyframe    画面采样             [匿名]
│   └─ bili/danmaku      弹幕 WS（待启动，按需拉起）
│                            ↓
│   core/db  领域归档：live_sessions / live_segments / posts / snapshots / follows / …
│   core/bus 变更信号：live_start / live_end / title_change / feed_post / health_alert / …
│                            ↓
│   core/pipeline  信号编排唯一装配点：bus → 冷启动抑制 → 分析触发 → 队列 → 规则匹配 → 机械去重 → 推送
│                            ↓
├─ 分析 analysis/  LLM 即任务：zod schema 进，JSON 出
│   ├─ triggers   分析触发（目标）：哪些信号送进 LLM——现仅 live_start，目标为任意时机按规则
│   ├─ queue      分析队列：并发受限（2）；优先级/结果缓存为预留扩展点
│   ├─ tasks/     classify（现状）· schedule-extract（目标）
│   ├─ classifier RulesClassifier：LLM 优先 + 失败回退确定性
│   ├─ matcher    确定性偏好执行：matchCategory / matchPushRules
│   ├─ context    多源聚合（目标）：按房间取时间窗内动态/弹幕喂给分类 prompt
│   └─ providers  text/vision 路由 + 熔断 + 多 key 池 + 降级链
│                            ↓ 判定入库 verdicts / schedules（目标）
├─ 推送时机与去重（目标态）默认开播；未来可选：延迟到有封面 / 换标题 / 内容实际变更
│                    机械去重与防抖始终生效（每场一次 + 场景切换去重 + 冷却，用户不可配）
│                            ↓
├─ 偏好执行 matcher → PushMessage（解耦边界就是 PushMessage，无中间态）
│   push_rules（开播）× post_rules（图文帖：平台无关通用规则，账号侧 rule_ids 选用）两张平行表
│                            ↓
└─ 通知 notify/   只负责执行
    ├─ dispatcher  按 PushMessage.channels 路由到启用渠道
    └─ onebot(NapCat) / toast —— 实现 Notifier 接口即可增删（ntfy 已放弃）
```

**解耦点与替换规则：**

| 解耦点 | 边界 | 加东西时只动哪 |
|---|---|---|
| Signal 总线 | 抓取→分析 | 加数据源 → 写一个 source |
| 任务化 LLM 接口 | 分析内部 | 换模型 → providers；加分析维度 → `tasks/` 加一个文件 |
| PushMessage | 决策→推送 | 加推送通道 → 实现 Notifier 接口 |
| 能力面注册表 | 轴 B | 加能力 → 进 `tools.ts` 注册表，再接前端 |

**偏好归属（已决策，2026-08-09 修订）**：人类需求是唯一锚点信源，直接以结构化形式落地，不做 NL→结构化编译。用户面板直填**推送规则**（`push_rules` v2，全局）：分类引用（可空 = 任意开播）× 生效主播集合（空 = 全部主播，含未来新增）→ 渠道、推送词模板。LLM 不解释偏好，只做**内容分类**这种客观判定（本场直播属于哪些分类，结果入 `verdicts` 表）；分类口径也由人填（`categories` 表：LLM 提示词 + 确定性关键词/分区条件〔且/或〕）——分类配了提示词且 LLM 可用以 LLM 判定为准，LLM 关闭/熔断/调用失败回退确定性条件，无提示词永远走确定性。推送规则的匹配、模板渲染、路由全确定性。运行管线无人工环节。

**图文帖（第二条偏好执行路径，2026-09）**：X 与微博是**独立于 B站的图文来源**，各有一份独立账号名单（`x_accounts` / `weibo_accounts`），共用一张 `post_rules`（`platform` 决定 `accountIds` 属于哪份名单）× 渠道，走与开播平行的 `feed_post` 分支。微博与 X **同构**：帖子归属 = 被抓账号自身的 id（`posts.uid`）；「这条微博属于哪个主播」由 `weibo_accounts.bili_uid` 这条可选关联反查（面板主播卡第三栏混排据此）。平台差异只剩三处：微博要登录态、X 要代理；微博图床境内直连（X 图必须经代理隧道）；微博没有「引用」实体、也不需要翻译。LLM 在图文链路里只做两件人填口径的事——规则级「要不要推」判定与（仅 X 的）翻译，**失败一律回退机械筛选照推**。

**图文补推语义（2026-09-21 拍板，与直播冷启动开关 `notify_on_first_run` 同族；唯一权威定义在 `core/backlog.ts`）**：账号「重进轮询」时，中断期的新帖推不推按**中断意图**三分——①**主动关闭**（账号停用→重新启用、图文开关手动关→重开）：恢复轮一律静默归档、**永不补推**（账号表 `silent_next` 恢复位置位，源消费后清位）；②**服务未运行期间**（进程重启/崩溃/登录态丢失）与③**添加账号之前**：同为一类，默认也不推，用户在推送设置开了 `backlog_push_enabled`（「补推未运行期间的图文」）才补推，且**双重封顶**——时间窗（默认 6h）内 + 每账号最多 N 条（默认 3、取最新）——停一周积压上百条旧帖在启动时一口气轰炸是不合理的，哪怕开关开着。三种轮次都先归档（面板可见），差别只在发不发 `feed_post`；正常轮的新帖照常全推，不受上限影响。

**推送时机的边界（2026-09 收敛）**：`push_rules` 已覆盖「推给谁、推什么」。未来只做**增加式可选推送时机**——延迟到有封面再推、换标题时推、内容实际变更时推（依赖 LLM 分析可信）；**不做**定时推、不做静音名单/静默时段/「不推」偏好。同一场内的「每场一次 + 场景切换去重 + 冷却防抖」是机械约束，始终生效、用户不可配。详见 §11「已放弃 / 不采用」。

分层职责：

| 层 | 管什么 | 例子 |
|---|---|---|
| analysis（LLM + matcher） | **判定与偏好执行**：这场在干什么 × 人填规则 → 推给谁/推什么 | 「歌回分类 → 群发 / {liver}唱歌速来」 |
| 推送时机（pipeline） | **何时推**：默认开播；未来可选增加时机 + 机械去重防抖 | 「换标题也推」「等到有关键帧再推」 |
| notify（执行） | **路由与发送**：按 channels 触达、图片降级、失败重试 | 「该规则只发这个群」 |

### 轴 B — 能力面与接入

```
                      ┌─ Web UI REST（/api/*）                  [已落地，待收敛到注册表]
一个能力面            ├─ MCP over HTTP（/mcp）                 [已落地 v1]
src/mcp/tools.ts ────┼─ WebUI Agent（进程内 agent loop）       [目标 P1]
（tool + schema +     ├─ MaiBot 插件（HTTP 调 /mcp）           [目标 P2]
 handler + role）     └─ NapCat 直连（OneBot 事件 → 进程内）   [目标 P3]
```

能力层与传输层解耦：注册表是纯数据结构，任何前端直接消费；`/mcp` 只是「进程外 Host」这一种接线的适配器。**角色在能力层标注（admin/gateway），身份在接入层确权**。信任模型：localhost = 主人；连接级 Bearer token → 角色；OneBot 事件身份（`user_id`/`group_id`）天然可信；**LLM 生成的参数永不可信**。目标重构：面板 REST 收敛到注册表，使「一个能力面是唯一能力信源」成立。详见 [plan/agent-access.md](plan/agent-access.md)。

### Pipeline：唯一的装配点

信号进入系统后的编排只发生在 `core/pipeline`：bus 订阅 → 冷启动抑制 → 分析触发 → 分析队列 → 机械去重 → 规则匹配 → `PushMessage` → dispatcher。

推论：**source 内不允许出现任何通知逻辑**。冷启动抑制、去重、健康告警的阈值判断，全部在 pipeline 及之后的层；source 只负责如实产信号（打上 `coldStart` 等标记）和归档原始数据。状态机保持纯函数，不做政策判断。

### 全员开播检测：一个批量接口，不是逐个轮询

`get_status_info_by_uids` 本身就是批量接口（POST，50/批分片）：150 个关注 = 每分钟 3 个请求，量级可忽略。**不存在「一个个轮询」的问题**。

备选是「关注中正在直播」接口（一次请求只回在播的，需 SESSDATA）。两者实现同一个 `LiveStatusProvider` 接口，可互换——接口层集中封装就是为此准备的。

### 高峰并发的关键：分析不入轮询循环

轮询循环只做两件便宜的事：拉批量状态、diff 产信号。所有 LLM 调用进 `analysis/queue`：并发上限（当前 2）。「按优先级排队」「时间窗内信号无显著变化复用结果」是预留扩展点（当前刻意不做）。30+ 同时开播时，推送通知（便宜）照常即时发出，内容分析（贵）排队跟进。

### 弹幕 WS 的定位（待启动）

不是全员常驻。逐房间建连的成本（连接池、心跳、token 刷新）在几十上百个关注对象时不划算。

```
轮询层（批量，30-60s）── 发现开播 ──
                                  ↓
              该房间需要内容分析？ ── 是 ── 拉起弹幕 WS ── 采样 ── 进分析队列
                                  ↓
                      下播事件 ── 关闭连接
```

实际并发只有「正在直播 且 需要分析」的几路。前置：`wbi.ts`（签名）→ `danmaku.ts`（WS 客户端）→ `triggers`（按需拉起）→ `context`/词频分析。合适时机启动。

## 5. 目录结构

目录与逐文件职责的**唯一信源**是 [AGENTS.md 文件地图](../AGENTS.md#文件地图)（一行一文件，含「改前必知」）+ [docs/modules/](modules/)（各模块实现笔记）；本节不再重复枚举，避免双信源漂移。

顶层：`src/`（core / sources / analysis / rules / notify / panel / mcp / config / tools + `index.ts` 装配根）、`webui/`（面板前端唯一信源，构建期内嵌进 `src/panel/webui-assets.gen.ts`）、`scripts/`（构建与一次性脚本）、`docs/`（本文档 + 调研 / 计划 / 模块笔记）、`data/`（SQLite 库与缓存，gitignore）。

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
  coldStart?: 'first_run' | 'new_subscription' | 'restart_recovery';   // source 只标记，抑制策略在 pipeline
  payload?: unknown;                        // 各 source 自定义
};

/** 一场直播被判属于某分类的结果（入 verdicts 表） */
type Classification = {
  categoryId: number; name: string;       // name 冗余存名，分类删除后历史仍可读
  source: 'llm' | 'rule';                 // LLM 判定 / 确定性条件（无提示词分类或 LLM 失败回退）
  confidence: number | null;              // LLM 路径置信度 0-1，rule 路径为 null
  evidence: string;                       // LLM 证据 / 命中的关键词·分区说明
};

/** pipeline 内部载荷：一场直播的完整快照 + 判定结果 */
type LiveEvent = {
  platform: 'bilibili'; roomId: string; uid: string; uname: string;
  title: string; areaName: string; parentAreaName: string;
  cover: string; keyframe?: string; roomUrl: string; startedAt: number;
  classifications: Classification[];      // live_start 由分析队列填充，其余信号恒空
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

/** 预告时间表条目（schedule-extract 产出；置信度入库，消费端按阈值过滤，无人工确认环节） */
type ScheduleEntry = {
  uid: string; sourcePostId: string;
  plannedAt: number | null;               // null = 只解析出模糊时间
  rawText: string; confidence: number;
  status: 'upcoming' | 'done' | 'cancelled';
};

/** 监听名单（控制面板管理，source 的事实来源；config.json 的 subscriptions 迁入此表） */
type Streamer = {
  uid: string;                          // B站 mid，一切外键锚点
  uname: string;                        // 昵称缓存，follows 同步/轮询自动刷新
  alias: string | null;                 // 用户别名，推送文案与面板展示用
  roomId: string | null;                // 批量接口响应自动回填，无需手填
  weiboUid: string | null;              // 【连通字段】微博 uid；面板填昵称经 resolve 解析，同步维护 weibo_accounts 的关联
  weiboNick: string | null;             // 微博昵称（面板直填）
  watch: boolean;                       // 是否在监听名单（名单内即监听中；false = 退回关注候选池）
  analyze: boolean;                     // 【待删遗留列】面板三开关已删、无人消费
  notify: boolean;                      // 【待删遗留列】面板三开关已删、无人消费
  profileNote: string | null;           // 主播画像自由文本（常见内容/语言风格/优先级经验），预留给分类 prompt 增强
  face: string | null;                  // 头像 URL（批量接口回填）
  source: 'follows' | 'manual';
};

/** 分类规则：内容分类的判定口径，面板直填。LLM 提示词 + 确定性条件双通道 */
type Category = {
  name: string;
  llmPrompt: string | null;               // 空 = 纯确定性分类（永远走条件路径）
  keywords: string[]; areas: string[];    // 标题子串 / 分区子串，组内任一、大小写不敏感
  condMode: 'and' | 'or';                 // 两组间关系；空组忽略，两组皆空 = 不命中
  enabled: boolean;
};

/** 推送规则：人类需求的唯一锚点，面板直填，全局排序（= 匹配优先级）。LLM 不参与解释 */
type PushRule = {
  name: string;
  categoryId: number | null;              // null = 任意开播
  uids: string[];                         // 生效主播集合；空 = 全部主播（含未来新增）
  channels: number[];                     // 引用 push_channels.id
  messageTemplate: string | null;         // null = 用内置默认模板（'{liver} 开播了'）；支持 {liver} {uname} {title} 变量
  enabled: boolean;
};

/** 图文帖规则：平台无关的通用规则——任何账号经 rule_ids 选用；LLM 只做规则级判定/翻译 */
type PostRule = {
  channels: number[];                     // 引用 push_channels.id（与开播规则共用）
  filters: { original: boolean; retweet: boolean; quote: boolean; media: boolean; keywords: string[] };
                                            // quote 只有 X 帖可识别（其余平台永不命中，是语义不是校验错误）
  messageTemplate: string | null;         // null = 内置默认（按帖子平台：'{author} 发了新推文 / 新微博 / 新动态'）
  llmJudge: boolean; judgePrompt: string | null; llmTranslate: boolean;   // 翻译运行时仅对 X 帖生效
  enabled: boolean;
};

/** 推送层的通用载荷。notify 不认识 LiveEvent，只认识 PushMessage（这就是决策→推送的解耦边界） */
type PushMessage = {
  title: string; body: string;
  image?: string;                          // 主图（toast heroImg / QQ 图）
  icon?: string;                           // 小图标（主播头像；toast appLogoOverride）
  attribution?: string;                    // 辅助小灰字（分区 · 开播时间）
  url?: string;                            // 点击跳转
  priority: 'high' | 'normal' | 'low';
  targets?: Array<{ type: 'group' | 'private'; id: string }>;  // 缺省 = 各通道默认目标
  channels?: string[];                     // 引用 push_channels.id；存在时 dispatcher 按此路由，缺省 = 全通道旧行为
  ref?: { roomId: string; liveTime: number };  // notify_log 溯源
};

interface Notifier {
  readonly name: string;
  readonly capabilities: { image: boolean; clickThrough: boolean };
  send(msg: PushMessage): Promise<{ ok: boolean; error?: string; retryable?: boolean }>;
}
```

注意冷启动抑制的归属：`diffRoom` 永远如实产出 `live_start`（打上 `coldStart` 标记），「首次运行不刷屏 / 新增订阅要通知 / 停机期间开播不刷屏」的政策判断在 pipeline 按配置执行。`restart_recovery` 与 `first_run` 同属「启动时已在播」，共用 `notifyOnFirstRun` 开关（默认关：启动只追轨迹，只有运行期实时开播才推）。状态机不做政策判断。

### 数据库表（在 M1 三表之上扩展）

| 表 | 答什么问题 | 状态 |
|---|---|---|
| `live_sessions` / `notify_log` / `room_state` | 这场推过没 / 推的时候发生了什么 / 重启恢复基线 | 已有 |
| `follows` | 关注列表快照，streamers 的候选池 | 已建 |
| `streamers` | 监听名单 + 主播画像（面板管理），source 的事实来源 | 已建 |
| `push_channels` / `push_rules` v2 | 推送渠道（面板统一管理，可停用）/ 推送规则（分类引用 × 主播集合 → 渠道/文案），面板直填 | 已建 |
| `categories` | 分类规则（LLM 提示词 + 确定性关键词/分区条件），面板直填 | 已建 |
| `posts` | 动态/微博/推文原文，供预告解析反复使用（`uid` = 该平台账号标识；`platform` 区分来源） | 已建 |
| `snapshots` | 画面采样引用，供内容判定 | 已建 |
| `verdicts` | 每场直播的分类判定结果（source llm/rule + evidence，可追溯误判） | 已建 |
| `x_accounts` / `weibo_accounts` / `bili_accounts` | 图文来源的独立账号名单（可选关联主播；与 `streamers` 解耦；`silent_next` = 主动关闭恢复位） | 已建 |
| `post_rules` | 图文帖规则（platform × 账号集合 × 筛选 → 渠道/文案），与 `push_rules` 平行 | 已建 |
| `schedules` | 预告时间表 | 待建 |

## 7. 成本分层（现状）

LLM 不是每次采样都调，按「越靠前越便宜」分层拦截。当前落地情况：

| 层 | 手段 | 现状 |
|---|---|---|
| L0 确定性 | `categories` 的关键词/分区条件（组内任一、组间且/或） | ✅ 已落地，同时是 LLM 失败的回退路径 |
| L0 结构化 | 动态 `LIVE_RCMD` / 预约卡片等结构化信号 |  解析已具备（`dynamic.ts`），未接入分类 |
| L1 本地信号 | 弹幕词频统计、keyframe 帧间差异 | ⬜ 待弹幕抓取启动 |
| L2 LLM 判定 | `tasks/classify` 单次批量分类（带图自动走 vision 路由） | ✅ 已落地（**未真机验收/调优**） |
| L3 二次确认 | 视觉 LLM 看画面 | ✅ 已随 classify（`keyframe`/`cover` 非空即带图） |
| L3 音频 | music/speech 检测 |  未规划（原设计留的方向，优先级低） |

两级省钱手段（`analysis/queue` 注释明确「现在刻意不做」，属**预留扩展点、非承诺**）：

- **结果缓存**：时间窗内信号无显著变化则复用上次判定
- **队列去重 / 优先级**：同房间多触发合并成一次分析；开播触发 > 直播中抽查

## 8. 里程碑

凭据（cookie/SESSDATA）从原 M3 **提前到 M2**：关注列表同步和动态/微博都依赖它，而它们是规模化的前提。**各里程碑当前实现状态见 [status.md](status.md)**（本节只记目标与验收，不记进度）。

| 里程碑 | 目标 | 验收要点 |
|---|---|---|
| M1 — MVP：开播通知 | 批量轮询 + 状态机 + OncePerSession + OneBot/Toast | 实时开播推送可达；QQ 链路经 `--test-notify` 验证 |
| M2 第 0 步 — 架构纠偏 | 事件总线 + `Source` 接口 + `PeriodicTask` + pipeline 唯一装配点 + 分析队列 + `PushMessage` | 不新增功能，行为与 M1 对齐，既有测试保持有效 |
| M2 — 规模化 + 内容判定 | 凭据管理 → follows 同步 → 名单迁库 → 原始数据归档 → 内容分类（LLM 优先 + 确定性回退）→ verdicts | 上百位订阅稳定轮询；高峰在播时分析排队不阻塞通知；判定依据可从 verdicts 追溯 |
| M3 — 预告时间表 | 过往时间轴（已落地）+ 预告解析（`schedule-extract` → `schedules`）→ 预告条/到点推送；前置 = 分析触发层能消费 `feed_post` | 时间轴可查；预告条目带置信度入库、按阈值过滤 |
| M4 — 偏好与路由 | `matcher` + `push_rules` v2 已落地；剩余 = 可选推送时机（延迟/换标题/内容变更）+ 优先级产品方案（机制未定）+ 直播中抽查（依赖弹幕） | 偏好规则准确生效、可回溯 |
| M5 — 产品化 | 控制面板（扫码登录/名单/画像/规则编辑/verdicts 总览/时间表日历）；多平台数据源 | 全流程面板可运维 |

> 架构纠偏背景：旧计划假设在 M1 代码上增量演进，但 M1 的「调度器一个类包揽 拉取→判定→规则→推送」结构承载不了第 4 节的架构，故单列第 0 步。它不新增功能——`Source` 接口 start/stop 只产 Signal + 归档、轮询循环从「编排者」降级为 source 内部细节、`PushMessage` 让 `Notifier` 不再认识 `LiveEvent`。

## 9. 风险登记

| 风险 | 影响 | 应对 |
|---|---|---|
| B站风控收紧 | 接口失效 | 轮询 ≥30s、带 UA、只用匿名接口；接口层集中封装便于替换 |
| cookie 泄露 | **账号被完整冒充** | gitignore、不落日志、建议小号、兜底改密码 |
| cookie 过期 | 关注同步/预告功能静默失效 | `isLogin` 心跳 + 停止轮询 + 主动告警 |
| 免费额度耗尽/政策变动 | 分析层瘫痪 | provider 熔断降级链 + 多 key 池；L0/L1 规则层仍可独立工作 |
| NapCat 账号被封 | QQ 通道失效 | 用小号；本机 Toast 作为独立通道不受影响 |
| LLM 判定误报 | 该推的没推 / 不该推的推了 | evidence 可追溯；置信度阈值可调；分类口径（categories）可随时收紧 |
| 高峰分析积压 | 判定延迟 | 队列优先级（开播触发 > 抽查）；通知不等分析结果 |
| B站接口文档仓库已被法务关停 | 无权威参考 | 关键接口自行实测记录在 docs/research/；不在项目内大量摘录接口清单 |

## 10. 待定项（显式留缝，实现前再定）

| 问题 | 当前倾向 | 影响面 |
|---|---|---|
| 直播中抽查的触发策略 | 定时 + 弹幕突变双触发（依赖弹幕抓取启动） | analysis/triggers |
| 微博关注列表是否也要同步 | 暂不同步，以B站关注为准 | follows |
| 多主播同时开播合并推送 | 逐条推（量大了再议） | dispatcher |
| 可选推送时机的产品形态 | 延迟到有封面 / 换标题 / 内容变更；**只增不减**，具体在面板怎么配未定 | push_rules / pipeline |
| 优先级（`priority` / 通道级阈值） | 等产品层方案想好再补，机制不预设 | dispatcher / PushMessage |

## 11. 已放弃 / 不采用（防止再被当待办）

以下方案在演进中被明确放弃或替代，**不要**再从旧文档里翻出来当待办：

| 项 | 原因 / 替代 |
|---|---|
| `PushDirective`（分析→推送指令对象） | 解耦边界就是 `PushMessage`，中间态无价值 |
| `rules` 用户可见护栏：静音名单、静默时段、定时推、「不推」偏好 | `push_rules` 已足够；未来只做**增加式**可选推送时机 |
| `ntfy` 通道 | 本机 Toast + NapCat 已覆盖，不需要异地提醒 |
| `signals` 表（原始信号全量归档） | 领域表（live_sessions / posts / snapshots / …）已归档有用数据，无功能依赖 |
| `analyze` / `notify` 列 | 面板三开关已删、无消费者，数据模型待删遗留 |
| `preference_clauses` 表 | 历史设计，已被 `push_rules` v2 取代并 DROP |
| LLM 文案润色 | 推送词以人工模板为准，不做润色增强 |
| Anthropic `/messages` 协议 | 不接；只用 chat-completions / responses |
| 订阅反代 / agent CLI 当 LLM 后端 | 封号风险，舍弃；OpenCode 走官方 API |
| 自动读取 Chrome/Edge 已登录 cookie | ABE 封死；绕过手段等同恶意软件，不采用 |
| CDP 直挂用户日常 Chrome | ≥136 不支持对默认 profile 远程调试 |
| 完整录播、人工确认队列、公开部署 | 定位为个人短采样 / 无人管线 / 本机自用 |
| OCR 服务、音频声学确认、原画截图 | 有能力但本项目不需要 |