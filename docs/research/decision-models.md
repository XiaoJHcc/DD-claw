# 调研：决策模型（System One）

基准日 **2026-10-21**。品类诞生于 2026-09-15（TypeSafe 发布 Jev 早期访问），一个月内长到 200+ 个模型、21 个托管模型上架 OpenRouter、托管价打到 $0.01–0.04 / 百万输入 token。**排名、价格与版本一周一变**：本文只写能追到一手来源的内容，厂商自报与第三方实测分开标注；动代码前按文末清单重查。

## 结论

- **接口收敛，模型没有收敛**。`POST /v1/systemone`（`state` + `questions`）是事实标准：TypeSafe、Cloudflare Clef、Liquid、vLLM-SR、llama.cpp、Ollama ≥0.35、Ollaya 都说这套线格式；OpenAI 与 Perplexity 另有 `/v1/decisions`。内部抽象只应对齐 `state + questions + answers`，厂商 SDK 与专有字段不进业务代码。
- **对 DD-claw，决策模型只可能替换「分类判定」这一跳**。翻译与预告解析是生成任务，继续走 LLM；目标形状 `结构条件 → 决策 → LLM → 确定性回退` 与业界建议的级联方向一致。
- **「省钱」不是理由**。一次分类请求约 1–2k 输入 token，$0.042/M 与 $1/M 的差距在每天几十次判定上可以忽略。真正的收益是输出形状锁死（没有 JSON 解析失败）、概率可阈值、灰区可升级。
- **直接上线，不做影子双跑**。决策档接入即 active：阈值先在自有中文样本上一次性标定，灰区交 LLM，不做线上长期双跑比对。Jev 官方明说英文最准、CJK「能用但不同等好」；图片仍是 opt-in 实验特性（官方原话 "Dreamer-ready"，不为生产背书）。这两条用离线验收覆盖，不需要线上影子期。
- **版本必须写死**。截至 10-21，`jev-latest` 仍指向 **1.13.0**，`jev-1.14.0` 只在 `jev-preview` 后面：别名跟着「最新稳定版」走，不会因为有预览就前进。带阈值标定的生产配置必须写 `jev-1.14.0` 这类版本号。
- **榜单不能用于选型**。Decision Index 在 10-20 从 0.3.2 升到 0.4，公开集权重直接归零（0.60 同技能私有 + 0.40 新领域私有）；同一模型跨版本分数不可比，前八名按「差 ≤0.9 分并列」规则实际是「1 个 + 7 个并列」。选型只能靠自有标注集上的准确率、校准与灰区比例。

## 一、品类现状

| 日期 | 事件 | 对本文的意义 |
|---|---|---|
| 09-15 | TypeSafe 发布 Jev 早期访问 | 品类起点；早期是等待名单制 |
| 09-29 | Liquid AI d1 托管上线，首个声称在 Decision Index 上赢过 Jev 的厂商 | 「每家都在自己的榜上第一」的开端 |
| 09-30 ~ 10-06 | OpenAI 在 DevDay 预告、10-06 公测 Decisions API（仅 `gpt-6-luna`） | 生成式厂商用现成 LLM 套决策接口，贵 2.4 倍 |
| 10-01 | Cloudflare Clef / Clef-flash、Perplexity pplx-decider、AWS Strands Decider 2B 同日 | 开源权重 + Jev 兼容接口成为默认打法 |
| 10-02 | llama.cpp 合并 PR #29818，本地 `POST /v1/systemone` | 自托管不再需要专用服务 |
| 10-05 | Superagent Security-One（安全判定专用 27B） | 垂直专用决策模型出现 |
| 10-08 | Snowflake Decision 私有预览（`AI_COMPLETE` SQL 调用） | 决策模型进入数据平台函数 |
| 10-09 | Microsoft-Decision-1（Qwen3.5-9B 后训练，$0.042）；同日 TypeSafe 宣布 $870M A 轮、$7.5B 估值 | 价格被按「分」对齐；底座大量来自 Qwen |
| 10-14 | Jev 1.14 预览：图片输入、`box` 原语、262k 长上下文，全部 opt-in | 多模态仍是实验特性 |
| 10-20 | Decision Index v0.4（209 个模型） | 公开集退出计分，榜单口径改写 |

规模侧的数字只作参照：OpenRouter 10-16 列出 21 个决策模型、13 家厂商；Jev 1.13 到 10-11 累计约 10.5 亿次请求；Vercel 称 Jev 两周触达 35% 付费团队。这些都是采纳速度，不是质量证据。

## 二、请求契约

### 2.1 形状

```jsonc
// POST /v1/systemone     Authorization: Bearer <KEY>
{
  "model": "jev-1.14.0",
  "state": { "title": "…", "area": "虚拟主播", "author": "…", "body": "…" },
  "questions": {
    "top":  { "type": "choice", "instructions": "这条内容最像哪个分类？",
              "criteria": { "歌回": "…", "杂谈": "…", "none": "都不像" } },
    "cat_12": { "type": "noul", "instructions": "`title` 与 `body` 是否属于「歌回」？" },
    "cat_13": { "type": "noul", "instructions": "`title` 与 `body` 是否属于「杂谈」？" }
  }
}
```

四种原语：`choice`（≤255 项，返回选中项 + 每项概率 + confidence）、`score`（2–10 档有序量表，返回可落在档间的分数）、`noul`（是/否的概率，**没有单独的 confidence 字段**）、`box`（1.14 实验，返回 0–1 相对坐标，**没有「未找到」返回值**，必须配一个 `noul` 先问目标是否存在）。

语义要点：

- `questions` 是 map，**id 不发给模型**——含义必须写进 `instructions` / `criteria`，起名没有用。
- 一次请求内所有问题并行求值、彼此读不到对方的答案；`state` 只发一次，因此「多问打包」是主要的省钱手段。
- `confidence` 是**概率分布的集中度**，不是「答对的概率」。全部押一个选项时 confidence = 1.0，与正确与否无关。
- 多标签分类不要用 `choice`（单选会互相截胡）：**每分类一个 `noul`**，再补一道 `choice` 拿横向分布。

### 2.2 上下文与别名

- 默认每请求 64k、`state` + 单个问题 32k；带 `TypeSafe-Danger-Zone-Long-Context: true` 头两项都提到 262k，单价不变但官方明说更慢更不准。
- 别名会漂：`jev-latest` 现在 = `jev-1.13.0`（稳定版），`jev-preview` = `jev-1.14.0`。响应里的 `model` 字段回显实际版本号，审计必须记它。
- 错误码只有四类需要处置：400（缺 danger-zone 头、图片不合规、超上下文）、413（体积超限）、429/529（限流/过载，指数退避）。

### 2.3 `/v1/decisions` 与网关

OpenAI（`gpt-6-luna`，1.05M 上下文，$0.10/M，公测）与 Perplexity（`/v1/decisions`，256K 上下文，$0.02/M）各自定义请求体：OpenAI 用 `input` + `predicate`/`choice`/`score`，与 Jev 不兼容。OpenRouter 的 `/api/alpha/decisions`、TrueFoundry、LiteLLM 则把各家包成同一张 `state` + `questions` 门面。**网关的字段归一不等于行为归一**：图片在 TypeSafe 原生是顶层 `assets` 引用流，在 OpenRouter 侧被改写成 `state` 数组里的 `image_url` part，自建适配器必须自己决定用哪一套。

## 三、多模态

Jev 1.14 与 1.13 都收图，但要带 `TypeSafe-Danger-Zone-Images: true`；`box` 只有 1.14 有。官方文档把图片与 `box` 标为 "Dreamer-ready"，请求格式、答案与限制都可能随版本变化。

| 限制 | 值 |
|---|---|
| 格式 | PNG / JPEG 静态图；动图 PNG、WebP、GIF、HEIC 一律 400 |
| 单边 | **280 – 1568 px** |
| 总像素 | 78,400 – 2,458,624（280² – 1568²），即 280×280 刚好合规 |
| 单图体积 | ≤16 MiB（base64 按解码后计） |
| 请求体 / 全部图 / 展开后请求 | 各 ≤32 MiB |
| 越界处置 | **服务端绝不缩放**；任一张被拒则整单失败，无部分答案 |

三个工程细节容易踩：

1. **引用即复制**。图片在顶层 `assets` 里登记一次，key 写进 `state` / `instructions` / `criteria` 的任意字符串位点；每出现一次就多读一份图、多计一次输入 token，并累加进 32 MiB 展开上限。多题共用一张图时，图只放 `state`，题里用反引号引用字段名。
2. **服务端剥 EXIF 但不做方向旋转**，也不缩放。调用方要自己 `exif_transpose` → 缩到长边 ≤1568 → 必要时补到 ≥280。
3. **`criteria` 可以放示例图**：选项/档位能用 1–2 张参考图定义，这是「人填分类口径」在多模态上的自然延伸，但会按引用次数重复计费。

其他家的图像面明显更宽松：

| 服务 | 图像能力 | 备注 |
|---|---|---|
| Perplexity pplx-decider v1.2 | 每题最多 8 张，单图 ≤1.6 MP（2,048 个 32×32 tile），请求体 32 MiB | 27B 级多模态里少见的公开权重（Apache-2.0），$0.02/M |
| Cloudflare Clef / Clef-flash | ≤4 张/请求 | flash 托管上下文 10-09 从 64K 砍到 24K 换降价 |
| Cloudflare Clef-omni | 图像 + 音频（4×300s）+ 视频（2×60s） | 30B-A3B，$0.15/M |
| OpenAI `gpt-6-luna` Decisions | 内联 base64 或公网 URL | 早期报道称 URL 被拒，以当前一手指南为准 |
| vLLM-SR d3 | 图片 + 视频（帧） | base64 data URL，原生 `/v1/systemone` |
| Ollama ≥0.35.1 | `images` 收 base64 PNG/JPEG/WebP，不收 URL | 仅 Clef 系可判图 |

**DD-claw 的现实约束**：B站封面与微博配图大量是 WebP，尺寸不定，也没有 EXIF 保证。仓库当前**没有任何图像编解码依赖**（运行时只有 `better-sqlite3`、`powertoast`、`zod`、MCP SDK），`src/core/pipeline.ts:530` 的 `toDataUrls` 只读缓存文件、按扩展名猜 MIME，不转码不缩放；直播侧直接传 keyframe/cover 的远程 URL。要接 Jev 原生图像面，等于先引入一个转码器或外部工具，并且要把「坏图本地拦下」做成硬门禁——否则线上就是稳定的 400。

## 四、候选矩阵

### 4.1 托管

| 模型 | 底座 / 规模 | 模态 | 价格（输入/M） | 契约 | 一手依据与注意事项 |
|---|---|---|---|---|---|
| **Jev 1.14 / 1.13** | 闭源，未公布规模 | 文本；图片/`box` 为 opt-in 实验 | $0.042 | `/v1/systemone` 原生 | Respan 的 11 模型跑分里准确率最高（1.13 为 0.932），但该跑分由卖同类模型的 Respan 发布；官方承认 CJK 弱于英文 |
| **pplx-decider v1.2 / flash v1.2** | 27B / 4B，Qwen3.8 系，Apache-2.0 权重 | 文本 + 图 | $0.02 / $0.01 | `/v1/decisions`（网关另有兼容层） | 256K 上下文；1–128 问题、255 选项、每题 8 图；v1.1 请求已自动路由到 v1.2 |
| **Clef / Clef-flash / Clef-omni** | 27B / 9B / 30B-A3B，Apache-2.0 | 文本 + 图；omni 加音视频 | $0.24 / $0.038 / $0.15 | Jev 兼容 `/v1/systemone` | flash 降价同时把托管上下文降到 24K；官方自测 BANKING77 领先 Jev，但 GPQA 明显落后 |
| **Microsoft-Decision-1** | Qwen3.5-9B 后训练，闭源 | 文本 | $0.042 | Foundry；OpenRouter 走 Decisions API | 官方口径 85 ms p50；Foundry 原生请求格式未公开，接入前要先实测 |
| **OpenAI Decisions API** | `gpt-6-luna`，闭源 | 文本 + 图 | $0.10 | `/v1/decisions` 自定义 | 1.05M 上下文，公测；卖点是采购与合规（ZDR/HIPAA），不是性能 |
| **Liquid d1 / d1-ultra** | 托管闭源；开放 d1-3B、d1-omni-600M | 文本 + 图；omni 加音频 | $0.02 / $0.042 | 经 TypeSafe SDK 换 base URL | 开放权重是 LFM Open License（非 OSI，年营收 <$10M 免费商用） |
| **Solar Decide / Mercury Decide** | Upstage / Inception | 文本 / 文本+图 | 见 OpenRouter 目录 | Decisions API | 只在 OpenRouter 目录层面核实，未读厂商文档 |

垂直用途还有 Snowflake Decision（`AI_COMPLETE` 内调用，私有预览）与 Security-One（只判安全相关问题，BIPIA 599/600，但厂商自己说只能做筛查不能做执行）。

### 4.2 自托管

| 模型 | 规模 | 许可 | 备注 |
|---|---|---|---|
| **vLLM-SR d3 系列** | d3 与 d3-turbo 26.09B、flash 8.39B、mini 4.54B、nano 2.21B、lite 0.85B、edge 0.595B | Apache-2.0 | 原生 `/v1/systemone`，图 + 视频；默认把每题一行放进同一次前向，跨请求可合批，d3-turbo 才做到 state 读一次再分支；官方记录 MI325X 上 2k token、8 问为百毫秒量级，小尺寸模型到数十毫秒 |
| **Clef / pplx-decider 权重** | 27B / 9B / 4B | Apache-2.0 | 走 llama.cpp / Ollaya / vLLM；llama.cpp 侧只有 Clef 会把全部问题放进一个 prompt，其余每题一次前向 |
| **Strands Decider 2B** | 1.9B | Apache-2.0 | 训练数据与脚本全公开，单张 3090 约 11 小时可复现；JevBench 公开集 v21 参考分 0.762 |
| **Kev / Mapika / Intern-Decision** | 0.8B–35B-A3B | 多为 Apache-2.0 | Kev 是 LoRA + pointer head；Mapika 有 decider-2b-vision；Intern-Decision 的权重许可未核实 |
| **编码器系（Laya / Von / Julia 1 / GLiNER2.5）** | 144M–421M | Apache-2.0 为主 | CPU 可跑、毫秒级，但只在窄任务上可用；Laya 在 Respan 行为集只有 0.542 准确率，不能当通用主力 |

运行时：llama.cpp 自 PR #29818（10-02 合并）起提供 `/v1/systemone`，后续 #30378/#30383 补上 Decision 2.0 与 vllm-d3；Ollaya 是本地守护进程，约 30 个模型 tag，按引用拉权重；Ollama ≥0.35 也提供同一接口。**d3 没有官方 GGUF**（官方量化是 FP8 / AWQ / GPTQ / NVFP4），llama.cpp 侧有转换脚本但没有可信的预转仓。

## 五、榜单怎么读

- **Decision Index v0.4（10-20，209 个模型）**：Full = 0.60 × 同技能私有测试 + 0.40 × 新领域私有任务，公开基准只展示、不计分；私有分由榜单方在 RTX PRO 6000 上用作者 serving 实跑，与提交行一致率 99.74%。当前首位 mammoth-1（27B）71.24，其后 pplx-decider v1.2 69.42、StartLux-Decision v1.1 69.29、vLLM-SR d3 69.06、AJev lm6q 69.05、d3-turbo 69.04——按 ≤0.9 分并列的规则，第 2–8 名实际是同一档。
- **JevBench 是公开题集，引用口径混乱**：Strands 2B（1.9B）的仓库以 v21 为参考报 0.762，但同一模型的 hard 档只有 0.505；Standard One 8B 在 public hard 是 54.95%，Jev 是 72.07%。易/难/全量三个口径混着报，同一个百分数不能横比。
- **Respan 行为集（10-16，11 个模型）** 是少数跨模型第三方跑分，但发布方卖同类模型：Jev 1.13 准确率 0.932 / ECE 0.045，Tev1-4B 0.901 / ECE 0.031 / 注入攻击成功率 0.042（两项都优于 Jev），Kev-4B 0.833。
- **版本漂移是常态**：10-19 有报道称 Sthānika Sieve 31B 以 Full 63.8 并列第二，而 10-20 的 v0.4 榜上它是 65.17、第 16 位。分数变高、名次变低，因为榜单版本和参评模型数都变了——跨版本、跨榜单对比没有意义。

## 六、风险

1. **别名与版本漂移**：`latest` 指向会变，模型会在同一阈值下悄悄换人。锁版本号、审计记录响应里的 `model`。
2. **CJK 是弱项**：Jev 官方文档明写英文是主要训练语言、其余语言（含 CJK）「能处理但不同等好」，要求用户在自有内容上测试。DD-claw 的输入全是中文，这一条决定成败。
3. **校准 ≠ 正确**：confidence 只是分布集中度；同族模型在不同任务上的 ECE 差异很大，阈值必须按动作在自有数据上标定，不能用厂商默认值。
4. **对抗脆弱且不留痕**：删除/改写标签语义（yes/no 对调）能让准确率崩塌；注入一段自然语言就能翻转判定，而输出仍是合法 typed answer，从结果上看不出被攻击。抓来的标题、正文必须当不可信数据隔离在 `state` 子字段里，不能拼进 `instructions`。
5. **已知短板**：算术、计数、日期比较、多跳推理、长 state 下的准确率衰减。这些留在代码里算完再喂给模型。
6. **图片门禁严格且整单失败**：一张 WebP 或一张 200×200 的小图就能让整次判定 400，且没有部分答案。
7. **价格与规格一周一变**：Clef-flash 降价同时砍上下文、pplx 一周内价格减半、Jev 版本从 1.13 到 1.14 只隔三周。不要签长约，不要把价格写进架构假设。
8. **许可不一**：Apache-2.0 是主流，但 LFM Open License、CC BY-NC（部分 OpenJev 权重）与未标明的学术权重不能按「开源」一概处理。

## 七、落到 DD-claw

### 7.1 现状（代码事实，非规划）

- 判定链已有可插拔形状：`JudgeStage.name` 的三值是 `deterministic | decision | llm`（`src/analysis/classifier.ts:30`），但只注册了 `deterministicJudge` 与 `llmJudge`；有提示词的分类实际链序是 `[llmJudge, deterministicJudge]`（`src/analysis/classifier.ts:146`），**decision 档不在链上**。也没有结构短路层：`postTypes` / `requireQuote` / `requireMedia` 只在 LLM 不可用时由确定性档兜底，不构成判定前的预筛。
- `Classification.source` 与 `verdicts.source` 的 CHECK 约束已经允许 `'decision'`（`src/analysis/types.ts:11`、`src/core/db.ts:55`），但没有任何生产者。
- 没有决策模型的配置面：settings 无相关字段，`/api/*` 无决策路由，WebUI 无对应卡片；`content_audit` 只有 provider 级 `attempts`（`src/core/content-audit.ts:25`），没有决策模式的概率分布、分带结果或被跳过的图片原因。
- 视觉输入：图文侧由 pipeline 落盘后转 data URL（上限 9 张，`src/core/pipeline.ts:527`），直播侧直接用 keyframe/cover 的远程 URL；全链路无缩放、无转码。
- 分析入口只有 `live_start` 与 `feed_post`，都过并发 2 的 `AnalysisQueue`；轮询与推送链路不直接调模型。

### 7.2 任务映射

| 任务 | 决策模型 | 说明 |
|---|---|---|
| 直播多标签分类 | 适合 | `state` = 标题 + 分区 + 主播；每分类一个 `noul`，外加一道 `choice` 拿主分类分布 |
| 图文多标签分类 | 适合 | `state` = 正文 + 平台 + 类型 + 作者；图片暂不接（Jev 图像面是实验特性且需本地转码），先把文本判定跑通 |
| 图文翻译 | 不适合 | 生成任务，留在 `post-analyzer` |
| 预告解析（`schedule-extract`） | 不适合 | 要生成结构化时间表，走 LLM |
| 预告表截图定位（未来） | 可试 | 先 `noul` 问「图中有无日程表」，真再用 `box` 裁区域交 LLM；`box` 是实验特性 |

### 7.3 接入前必须解决的硬约束

1. **图像门禁（若接图）**。判定前做：字节头探测真实格式 → WebP/GIF 转基线 JPEG → 按 EXIF 摆正 → 长边 ≤1568、总像素 ≥78,400 → 单图 ≤16 MiB。「坏图本地拦下并记原因」是硬要求，不是优化项。没有图像依赖时，这条要么加依赖，要么明确「不合规就跳过视觉」。
2. **阈值先离线标定**。用 200–500 条真实中文内容（含标题党、反串、纯图无文、多图长图）标注「是否属于」，一次性量出准确率、ECE 与过阈值比例，再定 pass / reject / gray 双阈值。标定离线做，不占线上流量。
3. **判定语义**。决策档定案即权威（判否不回看确定性），与现有「模型档权威」语义一致；灰区与失败才落到 LLM，LLM 不可用再落确定性。
4. **通道隔离**。独立 key、独立熔断、独立限流与计费，不与 LLM 通道共用额度。

具体接入方式（主端点、模型选择、请求打包、审计字段与配置面）另行制定，本文不规定。

### 7.4 验收口径

- 标注集上的准确率，以及和现 LLM 判定不一致的样本里谁对（按直播/图文分开统计）。
- 中文内容上的 ECE 与「过阈值样本的准确率」——阈值是给动作用的，不是给总分用的。
- **灰区比例**：超过 40% 就意味着大部分流量还是要回 LLM，收益不成立。
- p95 延迟与单条内容成本（含图片 token）。
- 图片拒收率与整单失败率；上线后 400 必须接近 0，否则是门禁没做完。

## 八、来源

| 来源 | 日期 | 用途 |
|---|---|---|
| [TypeSafe Models](https://docs.typesafe.ai/models) · [Images](https://docs.typesafe.ai/images) · [API 首页](https://docs.typesafe.ai/) | 10-20 前后 | 版本、别名、64k/32k 与 262k 长上下文、图片限制与 `assets` 语义、错误码 |
| [OpenRouter《What is Jev?》](https://openrouter.ai/blog/insights/what-is-jev/) | 10-16 | 真实调用示例（含 `box`）、score 语义、SDK 换 base URL、21 个决策模型目录 |
| [MarkTechPost《20 Jev Alternatives》](https://www.marktechpost.com/2026/10/17/20-jev-alternatives-the-decision-models-taking-on-typesafe-in-2026/) | 10-17 | 20 个替代品对照表、Respan 跨模型跑分 |
| [explainx《Ten decision models ranked》](https://explainx.ai/blog/top-10-decision-models-jev-perplexity-openai-open-source-ranked-2026) | 10-20 | 选型视角与「无法确认项」清单 |
| [kai-waehner《How Decision Models Became a New AI Category》](https://www.kai-waehner.de/blog/2026/10/20/how-decision-models-became-a-new-ai-category-after-jev/) | 10-20 | 市场结构、$870M 融资、标签翻转与对抗脆弱性、架构建议 |
| [Perplexity Decisions 文档](https://docs.perplexity.ai/docs/decisions/quickstart) | 10 月 | v1.2 / flash 价格、256K、128 问题 / 255 选项 / 8 图 |
| [OpenAI Decisions 指南](https://platform.openai.com/docs/guides/decisions) · [Changelog](https://platform.openai.com/docs/changelog) | 10-06 | 公测端点、`gpt-6-luna`、1.05M 上下文、$0.10、图片来源 |
| [Cloudflare Workers AI 模型页](https://developers.cloudflare.com/workers-ai/models/clef/) | 10-09 变更 | Clef 系价格与上下文，flash 降价同时砍到 24K |
| [Liquid AI 决策模型文档](https://docs.liquid.ai/lfm/models/decision-models) · [定价](https://www.liquid.ai/pricing) | 10 月 | d1 / d1-ultra 价格、d1-3B 与 d1-omni-600M 许可 |
| [vLLM-SR 运行时文档](https://github.com/vllm-project/semantic-router) · [Decision 3.0 报道](https://www.marktechpost.com/2026/10/11/what-is-decision-3-0-vllm-semantic-routers-new-open-decision-models/) | 10-11 ~ 10-20 | d3 各尺寸、每问一行前向、实测延迟、无 GGUF |
| [llama.cpp PR #29818](https://github.com/ggml-org/llama.cpp/pull/29818) · [Ollaya](https://github.com/ollaya-dev/ollaya) | 10-02 合并 | 本地 systemone 端点与支持的模型、图片 state、打包方式 |
| [Ollama decision 能力文档](https://github.com/ollama/ollama) | 0.35.0+ | `images` 收 base64、不收 URL |
| [Jev Decision Index v0.4](https://huggingface.co/spaces/multimodalart/jev-decision-index) | 10-20 | 全榜、私有集加权口径、前八名与并列规则 |
| [Sthānika Sieve 31B 报道](https://finance.yahoo.com/technology/ai/articles/indian-lab-sth-nika-ai-115800480.html) | 10-19 | 厂商自报「并列第二」与榜单实位的冲突样本 |

### 复核清单

- [ ] `jev-latest` 是否已指向 1.14、是否发布 1.15；图片与 `box` 是否摘掉 `TypeSafe-Danger-Zone-Images` 头
- [ ] Jev 官方是否给出图片 token 估算与 CJK 跑分（当前两者都缺）
- [ ] Decision Index 当前版本与 Full 口径（0.4 把公开集权重置零，下一次可能再改）
- [ ] pplx-decider / Clef / Jev 三家的每百万价格与上下文（近一月都至少变过一次）
- [ ] 目标模型是否有官方 GGUF（d3 目前没有）；llama.cpp 与 Ollaya 对图片 state 的支持范围
- [ ] OpenAI Decisions API 是否 GA、是否公布请求格式与视觉跑分
- [ ] 各候选许可（LFM Open License、CC BY-NC、学术权重未标许可）
