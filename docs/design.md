# DD-claw 项目设计

## 1. 目标

监听B站关注主播开播，判断直播内容类型，按用户偏好决定是否推送。

核心诉求举例：**仅在阿梓唱歌时推送，打游戏时不推送。**

### 目标分层

| 层级 | 内容 | 鉴权 |
|---|---|---|
| **基础** | 开播检测 → 标题/分区/开播时间 → 推 QQ + 本机 Toast | 匿名 |
| **升级** | 多源信号采集 → LLM 判定直播内容 → 偏好过滤 | 匿名 |
| **远期** | 预告抓取 → 时间表入库 → LLM 自动维护 → 产品化 UI | 需 cookie |

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

```
┌─ sources/  各自独立，只产 Signal，互不感知
│   ├─ bili/live-status   轮询 30-60s      [匿名]  → 开播/下播/标题变更
│   ├─ bili/danmaku       WS 按需拉起      [匿名]  → 弹幕文本流
│   ├─ bili/dynamic       空间动态         [cookie] → 预告/延播文本
│   ├─ weibo/feed         微博时间线       [cookie] → 预告/延播文本
│   └─ media/*            keyframe/ffmpeg  [匿名]  → 画面文字、音频标签
│                            ↓
│              Signal { source, roomId, ts, kind, payload }
│                            ↓
├─ core/bus            asyncio 风格事件总线，发布订阅
│  core/state          每房间一个状态机（离线 / 直播中 / 场景X）
│  core/db             SQLite：信号流、判定结果、时间表
│                            ↓
├─ analysis/context    按房间聚合时间窗内多源信号 → 一份文本 context
│  analysis/classify   generateObject + zod → SceneVerdict
│  analysis/providers   熔断 + 多 key 池 + 优先级链
│                            ↓
│              SceneVerdict { scene, confidence, evidence[] }
│                            ↓
├─ rules/preference    偏好匹配、去重、静默时段、状态跳变抑制
│                            ↓
│              NotifyDecision { shouldNotify, reason }
│                            ↓
└─ notify/*            onebot(NapCat) / toast(本机) / ntfy(兜底)
```

**解耦点是 `Signal` 总线**：source 不知道有 LLM，analysis 不知道有 QQ，notify 不知道信号来自哪。

- 加数据源（抖音、YouTube）→ 只写一个 source
- 换模型 → 只动 providers
- 加推送通道 → 只实现 Notifier 接口

### 弹幕 WS 的定位

不是全员常驻。逐房间建连的成本（连接池、心跳、token 刷新）在几十上百个关注对象时不划算。

```
轮询层（无需签名，30-60s）── 发现开播 ──┐
                                      ↓
              该房间开了内容分析？ ── 是 ── 拉起弹幕 WS ── 采样 ── 进分析队列
                                      ↓
                          下播事件 ── 关闭连接
```

实际并发只有「正在直播 且 已开启分析」的几路。

## 5. 目录结构

```
DD-claw/
├─ docs/                          本文档
├─ src/
│  ├─ sources/
│  │   ├─ bili/
│  │   │   ├─ wbi.ts              WBI 签名（~20 行，自实现）
│  │   │   ├─ client.ts           HTTP 层，强制注入 UA
│  │   │   ├─ live-status.ts      轮询 get_status_info_by_uids
│  │   │   ├─ danmaku.ts          WS 按需拉起/关闭
│  │   │   └─ dynamic.ts          空间动态
│  │   ├─ weibo/feed.ts
│  │   └─ media/
│  │       ├─ keyframe.ts         白嫖服务端缩略图
│  │       └─ capture.ts          ffmpeg 取图+音频
│  ├─ core/{bus,state,db}.ts
│  ├─ analysis/{context,classify,providers}.ts
│  ├─ rules/preference.ts
│  ├─ notify/{onebot,toast,ntfy,types}.ts
│  └─ config/
├─ cookies.json                   gitignore
└─ .env                           gitignore
```

## 6. 关键数据结构

```ts
type Signal = {
  source: 'live-status' | 'danmaku' | 'dynamic' | 'weibo' | 'media';
  roomId: string; uid: string; ts: number;
  kind: 'live_start' | 'live_end' | 'title_change' | 'danmaku_batch'
      | 'feed_post' | 'frame_text' | 'audio_label';
  payload: unknown;                       // 各 source 自定义
};

type SceneVerdict = {
  scene: 'chatting' | 'singing' | 'gaming' | 'other';
  confidence: number;                     // 0-1
  evidence: string[];                     // 2-4 条判断依据
  secondaryScene?: SceneVerdict['scene'] | null;   // 边打游戏边聊天
};

type LiveEvent = {
  platform: 'bilibili'; roomId: string; uid: string; uname: string;
  title: string; areaName: string; parentAreaName: string;
  cover: string; keyframe?: string; roomUrl: string; startedAt: number;
  verdict?: SceneVerdict;                 // 分析层未启用时为空
};

interface Notifier {
  readonly name: string;
  readonly capabilities: { image: boolean; clickThrough: boolean };
  send(e: LiveEvent): Promise<{ ok: boolean; error?: string; retryable?: boolean }>;
}
```

`capabilities` 让调度层知道该通道能否带图，从而为纯文本通道裁剪 payload；`retryable` 给失败降级链留口子。

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

外加**结果缓存**：时间窗内信号无显著变化则复用上次判定。这是最直接的省钱手段，尤其「聊天」「挂机」这类长时间不变的场景。

## 8. 里程碑

### M1 — MVP（只做开播通知，完全匿名）

`sources/bili/live-status` + `core/bus` + `core/state` + `rules` + `notify/onebot` + `notify/toast`

- 轮询 `get_status_info_by_uids`，配置文件写死 uid 列表
- 状态机去重（避免重复推送、避免闪断误报）
- 推送带 `keyframe` 预览图（零成本，不碰 ffmpeg）
- `analysis/` 与其余 source 留空目录

验收：阿梓开播后 1 分钟内，QQ 和本机各收到一条带预览图的通知，点击进直播间。

### M2 — 弹幕 + LLM 内容判定（仍然匿名）

`sources/bili/danmaku` + `analysis/*`

- WBI 签名模块（同时为 M3 的动态接口铺路）
- 开播后按需拉起 WS，采样弹幕
- context 聚合 → LLM 判定 → 偏好过滤
- 偏好配置：`{ uid, scenes: ['singing'], mute: ['gaming'] }`

验收：阿梓唱歌时推送、打游戏时静默，判定依据可在日志中追溯。

### M3 — 预告与时间表（引入凭据）

`sources/bili/dynamic` + `sources/weibo/feed` + 时间表

- cookie 导入与 `isLogin` 心跳失效检测
- 结构化预告直接入库；自由文本走 LLM 抽取时间
- **低置信度进人工确认队列，不自动改时间表**
- 「等会儿再来」类延播通知更新已有条目

### M4 — 产品化

Web UI（Next.js）、时间表可视化、偏好配置界面、多平台数据源。

## 9. 风险登记

| 风险 | 影响 | 应对 |
|---|---|---|
| B站风控收紧 | 接口失效 | 轮询 ≥30s、带 UA、只用匿名接口；接口层集中封装便于替换 |
| cookie 泄露 | **账号被完整冒充** | gitignore、不落日志、建议小号、兜底改密码 |
| cookie 过期 | 预告功能静默失效 | `isLogin` 心跳 + 停止轮询 + 主动告警 |
| 免费额度耗尽/政策变动 | 分析层瘫痪 | provider 熔断降级链 + 多 key 池；L0/L1 规则层仍可独立工作 |
| NapCat 账号被封 | QQ 通道失效 | 用小号；Toast/ntfy 作为独立通道不受影响 |
| LLM 判定误报 | 该推的没推 / 不该推的推了 | evidence 可追溯；置信度阈值可调；偏好支持「宁滥勿缺」模式 |
| B站接口文档仓库已被法务关停 | 无权威参考 | 关键接口自行实测记录在 docs/research/；不在项目内大量摘录接口清单 |

