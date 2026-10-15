# 调研：类 Jev 决策模型（System One / 类型化决策）

基准日 **2026-10-15**（2026-10-10 初版，2026-10-15 随 Jev 1.14 多模态官宣及第三方视觉榜更新）。整个品类诞生于 **2026-09-15**（TypeSafe 发布 Jev），至今刚满一个月，**所有跑分、价格、License、模型清单都可能在下个月作废**。本文每条结论都标注了来源与日期，实现前必须重新核实对应条目。

## 结论（2026-10-15 版）

- **内部抽象对齐 TypeSafe System One 契约**（`POST /v1/systemone`）作为唯一主端点。[schema 战已基本收敛](https://thenewstack.io/decision-models-system-one/)：AWS / Upstage / Ollama / llama.cpp / SGLang / vLLM Semantic Router（`d3`）等都是 wire-compatible 实现，官方 SDK 换 base URL 即可切换。其他端点（OpenRouter Decisions、Perplexity `/v1/decisions`、OpenAI `/v1/decisions`、各家自有 `/v1/decide`）一律**只做薄适配器，属备选**
- **Jev 官方已于 2026-10-14 开放图像输入与 `box` 框选原语，但目前属「Danger Zone」实验特性，多模态能力仍需横向评估，不能直接盲选为视觉主力**：
  1. **官方定性为非生产就绪**：需显式传 `TypeSafe-Danger-Zone-Images: true` 请求头；官方明言多模态表现弱于纯文本、「毛刺（jaggedness）仍太多，不为生产背书」，且**未公布任何多模态跑分**，三大独立榜单（Decision Index Vision、Artificial Analysis、S1MB）截至 10-15 均尚无 Jev 视觉成绩
  2. **图片预处理约束严苛**：仅收 PNG/JPEG 静态图（**拒收 WebP/GIF**，而 B站/微博/X 图床大量下发 WebP），尺寸必须卡在 **256–1568 px 且总像素 ≥78,400**（256×256 会直接 400 拒收），服务端**不自动缩放、不按 EXIF 旋转**，越界整单 400/413 失败
  3. **横向看，开源/竞品多模态决策模型已有硬核实测**：在独立榜 [Jev Decision Index 0.3.2 Vision（2026-10-12，11 基准，公开+私有各半）](https://www.decision.host/rankings/?suite=di_vision) 上，**vLLM-SR `d3`（27B，71.3）**、**`pplx-decider v1.1`（27B，70.6，$0.02/M）**、**`JEV-27B-VL`（69.6）**、**`d3-flash`（9B，66.9）**、**`d3-mini`（4B，63.2）** 已形成经过私有集检验的梯队；同时微软 [LLM2Jev 论文（arXiv 2610.02076）](https://arxiv.org/abs/2610.02076) 证实冻结 Qwen3.5-4B 零样本即可涌现多模态决策（MMBench 82.4%）
- **识图能力是默认要求，不是可选项**。直播/图文场景的核心输入是封面与配图；纯文本决策模型仅作回退兼容路径
- **只覆盖「决策形状」的任务**：输出是可枚举标签 / 是非 / 有序评分（及 `jev-1.14.0` 实验性单目标 `box`）的判断。需要生成文本的任务（翻译、schedule-extract、给人读的理由）**不适用**，继续走 LLM
- **级联方向与现有 LLM 管线相反**：代码规则 → 决策模型（置信度过阈值）→ LLM 兜底 → 人工。现有「LLM 优先 + 确定性回退」在决策类任务上应反转
- **confidence 不是「答对的概率」**，是概率分布集中度；[Artificial Analysis 实测 11 个托管决策模型在推理与知识题上普遍高估自身准确率](https://systemonemodels.org/guides/jev-benchmarks/)，阈值必须按动作在自有数据上标定

## 一、这是什么

Jev 是 [TypeSafe AI 2026-09-15 发布的「System One 模型」](https://torchtree.com/post/jev-decision-model/)——一个**完全不生成文本**的模型。输入一段 `state`（字符串/JSON，2026-10-14 起实验性支持在任意字符串位点引用 `assets` 图像）加一组类型化问题，一次前向为每个答案返回**校准概率**，程序直接分支。

三种核心原语 + 一种 1.14 实验原语（[TypeSafe API 参考](https://datawhalechina.github.io/jev-cookbook/api/)、[Box 文档](https://docs.typesafe.ai/go/box)）：

| 原语 | 问什么 | 返回 | 约束 |
|---|---|---|---|
| `choice` | 从给定选项里挑一个 | `choice` + 每项 `probabilities` + `confidence` | 最多 **255** 项，概率和为 1 |
| `score` | 放到有序量表上 | `score`（可落在档位间）+ 分布 + `confidence` | **2–10** 档 |
| `noul` | 是/否 | 「是」的概率 | 0.5 = 判断不了 |
| `box`（🧪 1.14 实验） | 图中某个目标在哪 | `box: {top, bottom, left, right}`（0–1 相对坐标）+ `confidence` | 仅 `jev-1.14.0` + Images 头；无 `criteria`；**无「不存在」返回值**（须配 `noul` 同问） |

机制上的根本差异：输出空间被架构锁死，不需要逐 token 自回归解码，所以快（70–500ms，独立实测中位 127–422ms）、便宜（输出 token 免费）、**不可能返回 schema 外的值**。代价是**没有生成能力**——[「别把它当 LLM 用」](https://tianqi.csdn.net/6ab2872d05257b08571259c1.html)。

## 二、API 契约：以 `/v1/systemone` 为准

### 2.1 基础请求 / 响应

```jsonc
// POST /v1/systemone   Authorization: Bearer <KEY>
{ "model": "jev-latest",
  "state": "…文本或 JSON…",
  "questions": {
    "is_urgent":   { "type": "noul",   "instructions": "…",
                     "criteria": { "true": "…", "false": "…" } },
    "department":  { "type": "choice", "instructions": "…",
                     "criteria": { "billing": "…", "bug": "…", "other": "…" } },
    "frustration": { "type": "score",  "instructions": "…",
                     "criteria": ["Calm", "Annoyed", "Angry"] }
  } }

// 响应：answers 的 key 与 questions 一一对应
{ "model": "jev-1.14.0",
  "answers": {
    "is_urgent":   { "type": "noul",  "noul": 0.95 },
    "department":  { "type": "choice", "choice": "billing",
                     "probabilities": { "billing": 0.88, "bug": 0.12, "other": 0.0 },
                     "confidence": 0.81 },
    "frustration": { "type": "score",  "score": 1.05,
                     "legend": { "0": "Calm", "1": "Annoyed", "2": "Angry" },
                     "probabilities": { "0": 0.0, "1": 0.95, "2": 0.05 },
                     "confidence": 0.92 }
  },
  "usage": { "input_tokens": 318, "output_tokens": 34 } }
```

要点：

- `questions` 是 **map（id → 问题）**，id 由调用方定义且**不发给模型**——语义必须写进 `instructions` / `criteria`，起名没用
- **一次请求可混多种题型、并行求值**（TypeSafe 称 speculative fan-out）。[13 个问题合一次调用比拆开便宜 12.2 倍、快 10 倍](https://datawhalechina.github.io/jev-cookbook/materials/polydao/)，因为 state 只发一次
- 同一请求内的问题**读不到彼此的答案**
- 上限：默认 state + 最长单个问题 32K token，state + 全部问题 64K；传 `TypeSafe-Danger-Zone-Long-Context: true` 请求头可把两项上限同时提到 **262K token**（`jev-1.13.0` 与 `jev-1.14.0` 均生效，按同单价计费，但官方警告更慢且准确率下降，[来源](https://docs.typesafe.ai/models#context-length)）
- 模型别名与弃用策略：`jev-preview` 现指向 `jev-1.14.0`，`jev-latest` 约 2026-10-21 切到 `1.14.0`；官方承诺 `1.13.0` 正式弃用前给 60 天预警、`1.14.0` 给 30 天预警。**生产环境若标定过置信度阈值，应锁定具体版本号（如 `jev-1.14.0`）而非传 `jev-latest`**
- 错误码：400（未开 danger-zone 头、图片不合规、超上下文）/ 401 / 413（图片或请求体超大小上限）/ 422 / 429 / 529（过载），429 与 529 都走指数退避

### 2.2 Jev 1.14 多模态与 `box` 扩展（Danger Zone 契约）

2026-10-14 TypeSafe 发布 [《Jev: For the builders AND dreamers》](https://typesafe.ai/blog/jev-1-14)，披露 **`jev-1.13.0` 底层本来就是多模态模型**（此前因多模态可靠性不及纯文本而被官方封印），并通过 opt-in 请求头开放给 `jev-1.13.0` 与 `jev-1.14.0`（[Images 文档](https://docs.typesafe.ai/go/images)、[Box 文档](https://docs.typesafe.ai/go/box)）：

```jsonc
// POST /v1/systemone
// Header: Authorization: Bearer <KEY>
// Header: TypeSafe-Danger-Zone-Images: true
{
  "model": "jev-1.14.0",
  "state": {
    "cover": "a3f1c2e8-cover",
    "title": "【歌回】今晚唱老歌"
  },
  "assets": {
    "a3f1c2e8-cover": { "type": "image", "format": "jpg", "data_base64": "/9j/4AAQ..." },
    "77b0d4a1-ref":   { "type": "image", "format": "png", "data_base64": "iVBORw0K..." }
  },
  "questions": {
    "is_singing": {
      "type": "noul",
      "instructions": "Does `cover` and `title` indicate a singing stream?",
      "criteria": {
        "true": { "description": "Singing / karaoke layout", "examples": ["77b0d4a1-ref"] },
        "false": "Gaming or chatting layout"
      }
    },
    "has_schedule": { "type": "noul", "instructions": "Is there a schedule table in `cover`?" },
    "schedule_region": { "type": "box", "instructions": "the schedule table in `cover`" }
  }
}
```

**与各家视觉扩展的契约差异（工程接线必知）**：

1. **可组合引用替换（`assets` map）**：图片不直接塞进 `state` 数组，而是先在顶层 `assets` 登记（key 为自定义引用串，推荐 UUID 防误匹配），随后在 `state`、`instructions`、甚至 **`criteria`（支持用示例图定义选项/档位）** 的任意字符串里写该 key，服务端按纯文本匹配替换为图像。传图推荐 HTTP `multipart/form-data`（JSON 放 `request` part，图片放文件 part 并以 `"part": "<name>"` 引用），避免 Base64 膨胀约 33%
2. **每次引用重复计费与占窗**：同一 asset key 在请求字串里出现 N 次，模型就读 N 份图、计 N 次输入 token，并累加进 32 MiB 展开上限。多题共用一张图时，**必须放进 `state` 再在题里用反引号字段名（如 `` `cover` ``）引用**，切勿把 asset key 直接塞进每道题的 `instructions`
3. **严苛的图片尺寸与格式门禁（服务端绝不自动缩放）**：
   - 仅限 **PNG / 基线 JPEG 静态图**（动图 PNG、WebP、GIF、HEIC 一律 400 拒收）
   - 单边 **256 ~ 1568 px**，且总像素 **78,400（即 280×280）~ 2,458,624（即 1568×1568）**——注意 **256×256（65,536 像素）会因总像素不足被 400 拒收**
   - 服务端会剥离 EXIF 但**不执行 EXIF 方向旋转**（调用方须先 `exif_transpose` 再缩放到长边 ≤1568、短边满足面积下限）
   - 单图 ≤16 MiB，请求体与展开后总大小均 ≤32 MiB；任一图片被拒则整单失败（无部分返回）
4. **`box` 原语的使用纪律**：仅 `jev-1.14.0` 支持；返回 `{top, bottom, left, right}`（左上角为原点的 0–1 比例值）与 `confidence`；**没有「未找到」状态**（目标不存在也会硬返回四个坐标），必须在同一次请求里配一个 `noul` 问目标是否存在，先看 `noul` 再信 `box`

### 2.3 端点全景（截至 2026-10-15）

| 契约 | 端点 | 实现方 | 多模态传图方式 | 状态 |
|---|---|---|---|---|
| **TypeSafe System One** | `POST /v1/systemone` | TypeSafe Jev 1.13/1.14（原生）、Upstage Solar Decide、AWS Strands Decider、Kev、Open-Jev、Laya、Ollama 0.35、SGLang、Bud Decision Studio、Winnow、360 智脑、Zenlayer 网关 | Jev 原生：顶层 `assets` map + `TypeSafe-Danger-Zone-Images: true` 头 | **事实标准，主端点** |
| System One + `images` 数组扩展 | `POST /v1/systemone`（或 Workers AI 路径） | Cloudflare Clef / Clef-flash / Clef-omni、**vLLM-SR Decision 3.0（`d3` 全系）** | 请求体顶层附加 `"images": [...]`（及 `"videos"` / `"audio"`）Data URL | ✅ 主端点超集，最省事 |
| OpenRouter Decisions | `POST /api/alpha/decisions`（及 `/api/v1/systemone`） | OpenRouter 路由（挂接 Jev 1.13/1.14、pplx-decider、Clef、Microsoft-Decision-1、GPT-6 Luna Decisions 等 21 款） | 随下游模型支持度 | ✅ 多厂商聚合网关 |
| Perplexity Decisions | `POST /v1/decisions` | `pplx-decider-v1.1-27b` | `state` 数组内传 Base64 PNG/JPEG/WebP Data URL（≤2048 个 32×32 tile） | 需写薄适配器 |
| OpenAI Decisions API | `POST /v1/decisions` | `gpt-6-luna`（2026-10-06 公测） | `input` 消息内联 Base64 图像 | 公测（$0.10/M）；用 `input` / `questions[]` / `predicate`，与 Jev 不兼容 |
| 各家自托管专用 | `/v1/decide`、`/v1/decisions` | JEV-27B-VL、Intern-Decision | `state` 列表图文混排 | 需写适配器 |

来源：[The New Stack 2026-10-09](https://thenewstack.io/decision-models-system-one/)、[systemonemodels.org 对比矩阵 2026-10-15](https://systemonemodels.org/compare/best-ai-decision-models/)、[TypeSafe Images 文档](https://docs.typesafe.ai/go/images)、[Decision 3.0 文档](https://decision.vllm-sr.ai/)。

> **「换 URL 就能换模型」只就代码可移植性成立，不就行为成立**。尤其在多模态上，各家即使都叫 `/v1/systemone`，传图字段也分成了 **TypeSafe `assets` 引用流** 与 **Clef / `d3` 顶层 `images[]` 数组流** 两派。内部 `DecisionProvider` 必须把图片封装为统一中间结构，由各 adapter 负责序列化与尺寸合规预处理。

## 三、与 OpenAI Chat Completions 的异同

| 维度 | OpenAI Chat Completions | System One `/v1/systemone` |
|---|---|---|
| 请求 | `messages[]` | `model` + `state` + `questions{}`（+ 可选 `assets{}` / `images[]`） |
| 输出 | 生成的文本 / JSON | 类型化答案（`choice`/`score`/`noul`/`box`）+ 每选项概率 + confidence |
| 生成方式 | 自回归逐 token | 一次前向并行打分（注：`vllm-sr/d3` 为每题一次前向） |
| 计费 | 输入 + 输出 token | **只收输入**（图片折算输入 token 同价），输出免费 |
| 延迟 | 数百 ms ~ 数秒 | 70–500ms，独立实测单题中位 127–309ms |
| 格式保证 | prompt + 解析 + 兜底重试 | **架构层锁死** |
| 幻觉 | 会 | 不会编造选项，但**可能返回「错误的合法值」** |
| 生成能力 | 有 | **无** |
| 置信度 | 自称的，不可信 | 经校准训练（RLCD / Brier loss），但跨领域仍有偏移 |
| 多问合一 | 多次调用 | 一次请求并行 |
| 选项上限 | 无 | `choice` ≤ 255 |
| SDK | `openai` | `typesafe-sdk` / `@typesafe-ai/sdk` |

**两者不是替代关系，是分工**：决策模型替换的是「问 LLM 一个窄问题再解析出标签」这一段，不替换任何需要写字的环节。

## 四、多模态横向评估与候选矩阵（识图为默认要求）

### 4.1 为什么 Jev 官宣多模态后仍需横向评估？

截至 **2026-10-15**，把 Jev 原生多模态放到整个生态里横向对比，有四条硬事实决定我们**不能只因为 Jev 官宣就单押它做视觉主力**：

1. **Jev 视觉能力尚无任何独立或官方量化跑分**：
   - TypeSafe 在 10-14 发布博客中首次晒出内部评测（"antibench"），`jev-1.14.0` 综合智能得 60.0（`1.13.0` 为 58.9）、校准误差 1.6（领先开源模型一个量级），但**该评测为纯文本且带官方「请勿轻信、偏向自家模型」水印**
   - 行业三大独立评测榜——**Jev Decision Index**（Hugging Face `multimodalart`，含专门的 Vision 子榜）、**Artificial Analysis Decision Index 1.0**（2026-10-13 发布，测 11 家托管 API）、**S1MB**（137 基准纯文本）——截至 10-15 **均未跑出 Jev 的视觉成绩**
   - TypeSafe 官方对自身视觉能力给出了明确预期管理：「所有模型（Jev 也不例外）在多模态上表现都比纯文本差，必须把问题拆解到最原子的形式」，且将整个图像特性置于 `TypeSafe-Danger-Zone-Images` 实验头后，明言「不为生产环境背书」
2. **独立视觉榜（Decision Index Vision 0.3.2，2026-10-12）已完成洗牌，开源多模态模型在「公开+私有盲测」上表现强劲**：
   - Decision Index 从 0.3 版起引入**私有留出集**（Vision Full Score = 50% 公开基准 + 50% 私有测试，0.3.1 起统一限制图片 1.6 MP），戳破了部分早期刷榜模型的水分（例如 Cloudflare Clef 在文本榜从公开分 61.7 跌至 Full Score 48.3；Clef-omni 文本 Full Score 49.3、AA 榜 44.3 垫底）
   - 在含私有集的 **Vision 0.3.2 榜（20 个子项 / 11 类视觉基准）** 上，头部梯队已非常清晰：

| Vision 排名 | 模型 | 参数 / 底座 | Vision Full | Vision Public | Text Full（排名） | 校准 ECE | 开源协议 |
|---|---|---|---|---|---|---|---|
| **#1** | **vLLM-SR `d3`** | 26.1B（Qwen3.8-27B + 0.46B 视觉塔） | **71.3** | 74.1 | **66.3（#1）** | 0.043 | Apache 2.0 |
| **#2** | **`pplx-decider v1.1`** | 27B（Qwen3.8-27B） | **70.6** | 73.2 | **62.8（#3）** | 0.071 | Apache 2.0 |
| **#3** | **`JEV-27B-VL` / `RSI-Jev v6.1`** | 27B（Qwen3.8-27B） | **69.6** | 72.8 | 58.7（#15） | 0.077（视觉 0.018） | Apache 2.0 |
| **#4** | **vLLM-SR `d3-flash`** | 8.4B（Qwen3.5-9B + 0.46B 视觉塔） | **66.9** | 69.9 | 55.8（#26） | 0.056 | Apache 2.0 |
| **#5** | **`Solomon v1.1`** | 27B | **66.8** | 69.9 | 40.9（#72） | 0.081 | 开源权重 |
| **#8** | **vLLM-SR `d3-mini`** | 4.5B（Qwen3.5-4B + 0.33B 视觉塔） | **63.2** | 67.7 | **52.6（#34）** | 0.056 | Apache 2.0 |
| **#9** | **`Intern-Decision-4B`** | 4.7B（Qwen3.5-4B 冻结视觉塔） | **56.5** | — | 38.2（#82） | **0.028** | Apache 2.0 |
| **#11** | **Cloudflare `Clef` / `Clef-omni`** | 27B / 30B-A3B | **59.5** | 63.7 | 48.3（#45） | 0.040 | Apache 2.0 |
| **未入榜** | **TypeSafe `Jev 1.14 / 1.13`** | 闭源未公布 | *待独立复测* | *待测* | **60.1（#8）**（AA 榜 **#1** 57.5） | 0.074（AA 0.117） | 闭源托管 |

数据来源：[decision.host 聚合榜单（2026-10-13 快照，同步自 HF `multimodalart/jev-decision-index` 0.3.2）](https://www.decision.host/)、[modelsystem.one 核查报告](https://modelsystem.one/news/autotrust-jev-27b-vl-vision-board/)、[systemonemodels.org 评测综述](https://systemonemodels.org/guides/jev-benchmarks/)。

3. **各家在具体视觉子任务上的能力分化明显**（基于 Decision Index Vision 20 项细分数据）：
   - **图表/海报/文字密集型图像（InfographicVQA、KIE 票据抽取、CharXiv、Mind2Web 网页截图）**：正是 DD-claw **直播封面花字、预告表截图、B站/X 带字配图**的同构场景。在这组任务上，`d3 (27B)` 与 `pplx-decider v1.1 (27B)` 统治力极强（InfographicVQA 达 97.8–100.0、KIE 85.0–92.6、Mind2Web 83.1–83.3）；9B 的 `d3-flash` 紧随其后（InfographicVQA 96.2–100.0、Mind2Web 80.8），甚至 4B 的 `d3-mini`（InfographicVQA 94.0–94.5、KIE 85.0–92.2）在这类 OCR/版面型视觉判断上也跑赢了 27B 的 `Clef`（InfographicVQA 85.3–87.4、CharXiv 30.2–61.1）
   - **复杂视觉推理与隐喻审核（MMMU-Pro vision、Hateful Memes 图文反讽、R-Bench-M）**：**全场所有决策模型普遍不及格**（全场均值仅 20.5–27.8，榜首 `d3` 在 MMMU-Pro vision 仅 46.4、Hateful Memes 44.6、R-Bench-M 33.4）。[独立医学影像论文（arXiv 2610.13675，2,818 张乳腺超声图测 Clef / Clef-flash）](https://arxiv.org/abs/2610.13675v1) 也得出一致结论：多模态决策模型对 prompt 措辞高度敏感，在专业细粒度视觉判断上甚至低于多数类基线。**含义：涉及复杂图文玩梗或深层视觉推理的帖子，决策模型置信度必然吃紧，必须靠级联回退到 VLM（System 2）兜底**
4. **两条技术路线的实验对决已有阶段性结论**：
   - **路线 A（纯文本训决策头 + 零样本迁移视觉）**：微软 [LLM2Jev（arXiv 2610.02076）](https://arxiv.org/abs/2610.02076) 与 AutoTrust `JEV-27B-VL` 证明，只要 VLM 基座（Qwen3.5 / Qwen3.8）够强，完全不训图像也能直接做视觉决策（Qwen3.5-4B 零样本 MMBench 82.4%，`JEV-27B-VL` 拿 Vision Full 69.6）
   - **路线 B（带视觉编码器联合多模态后训练）**：vLLM Semantic Router 的 **`Decision 3.0 (d3)`** 与 Perplexity **`pplx-decider v1.1`** 在此基础上做多模态后训练，结果在 4B / 9B / 27B 全尺寸段把 Vision 分数又往上推高了 2–7 分（尤其 4B 档 `d3-mini` 63.2 远超冻结视觉塔的 `Intern-Decision-4B` 56.5）

### 4.2 云端 / 托管多模态候选对比

| 模型 / 服务 | 底座 | 多模态能力与限制 | 协议与兼容性 | 价格（输入/M，输出全免） | 核心优劣势（横向评估） |
|---|---|---|---|---|---|
| **TypeSafe `jev-1.14.0` / `1.13.0`** | 闭源未公布 | 🧪 PNG/JPEG 静态图（280²~1568² 等效像素，≤16MB）；**拒收 WebP**；1.14 独占 `box` 框选 | `POST /v1/systemone` 原生 + `assets` 引用替换 + `TypeSafe-Danger-Zone-Images: true` 头 | **$0.042** | **优势**：文本综合与校准天花板（AA 榜 #1，自报校准误差最低），`assets` 可塞进 `criteria` 做少样本示例图匹配，1.14 改善多语言并带 `box` 定位。<br>**劣势**：视觉属实验特性、**零公开视觉跑分**；不收 WebP 且不自动缩放/旋转图片，DD-claw 接入必须先过本地图片转码洗图管线 |
| **`pplx-decider v1.1`**（Perplexity） | Qwen3.8-27B（Apache 2.0） | ✅ PNG/JPEG/WebP Base64（≤2048 个 32×32 tile，约 1440×1440） | 自有 `POST /v1/decisions`（OpenRouter 可调） | **$0.02**（最便宜大厂托管） | **优势**：[systemonemodels.org 综合榜 #1（91.8/100）](https://systemonemodels.org/compare/best-ai-decision-models/)、Decision Index 0.3.1 文本榜 #1（62.75）、Vision 0.3.2 榜 **#2（70.6）**、S1MB **#2（68.8）**；262K 上下文，价格仅 Jev 一半，原生收 WebP。<br>**劣势**：非 `/v1/systemone` 原生格式（需薄适配器），组织级限流 10 req/s 偏紧，AA 榜无知拒答率偏低（13.3%） |
| **vLLM-SR `d3` 托管 / 自建** | Qwen3.8-27B + 0.46B 视觉塔（Apache 2.0） | ✅ PNG/JPEG/WebP（≤1.6MP，多图）+ **视频**（≤32 帧 @ 2fps） | **原生 `/v1/systemone`** + `images[]` / `videos[]` 数组 | 官方体验站 `decision.vllm-sr.ai` **免费** / 自托管 | **优势**：Decision Index 0.3.2 **文本（66.3）与视觉（71.3）双料第一**，OCR/版面类视觉极强，兼容 `/v1/systemone`。<br>**劣势**：底层实现是**每道题单独跑一次前向**（多问 fan-out 时延迟随题数线性增长，单图 1 题 MI325X 上 273–342ms），加载需 `trust_remote_code=True` |
| **Cloudflare `Clef` / `Clef-flash` / `Clef-omni`** | Qwen3.8-27B / 3.5-9B / 3-Omni-30B-A3B（Apache 2.0） | ✅ PNG/JPEG/WebP（≤4 张）+ 视频（`Clef-omni` 另加音频） | **Jev 兼容** + `images[]` 扩展，Workers AI / OpenRouter | Clef **$0.24**（OR 曾标 $0.042）<br>Clef-flash **$0.038**<br>Clef-omni **$0.15** | **优势**：`Clef-flash` 极快（中位 38.8ms）且便宜（$0.038/M），校准误差极低（ECE 0.025–0.040），提供官方 RL 微调平台。<br>**劣势**：独立榜私有集泛化掉分明显（Clef 文本 Full 48.3 #45、Vision Full 59.5 #11；AA 榜 #8/#10/#11），27B 托管价贵 Jev 近 6 倍 |
| **OpenAI Decisions API** | `gpt-6-luna`（闭源） | ✅ 文本 + 内联 Base64 图像 | 自有 `POST /v1/decisions`（`input` + `questions[]` + `predicate`） | **$0.10**（地区/长窗另加倍） | **优势**：OpenAI 官方 SDK（Python 3.26+ / JS 7.30+）直出，支持 ZDR/HIPAA。<br>**劣势**：2026-10-06 刚公测，贵 Jev 2.4 倍，AA 榜仅排 #9（48.5，ECE 0.155），无公开视觉跑分与选项上限文档 |
| **`JEV-27B-VL`**（AutoTrust，自托管） | Qwen3.8-27B（Apache 2.0） | ✅ 单请求 ≤8 张图（URL/Base64） | `/v1/decide` + **同进程标准 OpenAI `/v1/chat/completions`** | 自托管（建议 80GB 显存，VRAM ~55.6GB） | **优势**：Vision 0.3.2 榜 **#3（69.6，视觉 ECE 0.018）**；**System 1 + System 2 双通道同驻一机**（低置信度回退 VLM 或做 X 帖翻译无需跨服务、零额外显存），视频封面推荐与 RewardBench 实测强。<br>**劣势**：仅支持最多 16 个 `choice` 选项（字母 verbalizer 限制），需自备大显存 GPU |

**云端选型建议（2026-10-15 修订）**：
- **现阶段带图主力**：优先测 **`pplx-decider v1.1`**（$0.02/M、Vision #2、原生收 WebP、大厂托管）与 **`TypeSafe Jev 1.14`（开启 `TypeSafe-Danger-Zone-Images`）** 的双路影子对比；若追求零成本体验或自建 `/v1/systemone` 视觉服务，纳入 **vLLM-SR `d3` / `d3-flash`**
- **接入 Jev 视觉的前置条件**：DD-claw 的 `image-cache.ts` 已负责把 B站/微博/X 图片落盘，喂给 Jev 前**必须加一层轻量图像规范化**（WebP/GIF → 基线 JPEG、按 EXIF 摆正像素、长边缩至 ≤1568 且保证总像素 ≥78,400），否则线上会高频撞 400/413

### 4.3 本地候选（≤9B，优先 4B）

**运行时**：llama.cpp `llama-server`（[2026-10-02 合并 PR #29818，首发支持 Julia-1 / Laya / Kev-4B / lev / OpenJev，支持图片 state，RTX PRO 6000 上 3–43ms](https://juejin.cn/post/7692612898275426330)）、Ollama 0.35（同形端点）、或 `vllm-sr serve`（8899 端口原生暴露 `/v1/systemone`）。**SGLang / 免训练 LLM2Jev 是第三条路**：[SGLang 原生 `/v1/systemone`](https://www.theblockbeats.info/flash/369767) 或 [微软 LLM2Jev 免训练前缀树读出（`Best answer: [` + `k]`）](https://datawhalechina.github.io/jev-cookbook/materials/35-llm2jev-paper/)——**无需专用 checkpoint**，直接把现成 Qwen3.5-4B / 9B 当多模态决策模型用（4B 零样本 JevBench 公开题 81.4%、MMBench 82.4%、ECE 0.057）。

| 模型 | 底座 | 图 | 协议 | License | 备注（含 2026-10-12 独立榜实测） |
|---|---|---|---|---|---|
| **vLLM-SR `d3-mini`（4.5B） / `d3-flash`（8.4B）** | Qwen3.5-4B / 9B + 独立视觉塔 | ✅ 图（≤1.6MP）+ 视频 | **`/v1/systemone`**（`vllm-sr serve`） | Apache 2.0 | **当前本地多模态首选**。Decision Index 0.3.2 上：`d3-mini`（4B）拿 **Vision Full 63.2（#8）/ Text Full 52.6（#34）**，单图延迟 ~96ms；`d3-flash`（9B）拿 **Vision Full 66.9（#4）/ Text Full 55.8（#26）**，超越上代 27B。另有 `d3-nano`（2B，Vision 42.2）与 `d3-lite`（0.8B） |
| **`Intern-Decision-4B`**（上海 AI 实验室） | Qwen3.5-4B（冻结视觉塔） | ✅ | `/v1/decisions`（需适配） | Apache 2.0 | 自报 7 套件 90.02%，RTX 4090 上 33–44ms；在独立 Decision Index 0.3.2 上 **Vision Full 56.5（#9）/ Text Full 38.2（#82）**，但 **ECE 0.028 校准极佳**，且完整开源训练代码 |
| **冻结 `Qwen3.5-4B` + LLM2Jev 免训练读出** | Qwen3.5-4B 原生 VLM | ✅ | 任意支持 logprobs / teacher forcing 的推理端 | Apache 2.0 | [arXiv 2610.02076](https://arxiv.org/abs/2610.02076)：不改权重，用 `[1]..[K]` 编号后缀树并行打分，JevBench 公开集 **81.4%**（LoRA+KL 锚定后 **84.0%**）、**MMBench 视觉零样本 82.4%**、支持任意候选数 K（破除 26 字母上限） |
| **`RSI-Jev v6.1-VL-4B`**（高尚华） | Qwen3.5-4B | ✅ | **`/v1/systemone`** | 代码 MIT / 权重 Apache 2.0 | [16/20/32 层多层出口头 + `effort=auto` 动态早退（中位 23–28ms）](https://github.com/Shanghua-Gao/RSI-Jev)，Decision Index 0.3 公开集 50.98；496 次实验（含失败）全公开 |
| **`Kev-4B / 9B`**（Jared Palmer） | Qwen3.5 / 3.8 | — | **System One 原生** | Apache 2.0 | 纯文本标杆之一，OpenRouter 已托管 Kev-4B（$0.042/M）；Decision Index 0.3.2 上 Kev-9B 43.3 / Kev-4B 39.5，校准极稳（ECE 0.032–0.045） |
| **`H2O-Lightning-4B`** | Qwen3.5-4B | — | System One | Apache 2.0 | JevBench 1.7.46 能力分 75.0（System One Score 90.6），单 H100 中位延迟 29.8ms |
| **`Vev 4B/9B`** | Qwen3.5 | ✅ | **System One** | ⚠️ 权重非商用 | 图文直进 state，但因 CC BY-NC 且已有 Apache 2.0 的 `d3-mini`/`d3-flash`，优先级下调 |
| **`Laya 322M/421M`** | ModernBERT 编码器 | — | **System One** | Apache 2.0 | 延迟 ~6–35ms 最快，但独立榜 **Decision Index Full 仅 4.4 / S1MB 极低**。**严禁当通用主力** |

**本地推荐（2026-10-15 修订）**：带图首选 **vLLM-SR `d3-mini`（4B）或 `d3-flash`（9B）**（Apache 2.0、`/v1/systemone` 兼容、独立视觉榜验证过）；若已有现成 Qwen3.5-VL 推理服务，直接用 **LLM2Jev 免训练配方 / SGLang** 零成本读概率；需要极致单问速度与校准可选 **`Intern-Decision-4B`** 或 **`RSI-Jev v6.1-VL-4B`**。

## 五、落到 DD-claw

```
DecisionProvider.evaluate(state, questions, media?) → answers   // 内部统一契约 = System One 超集
        │
        ├─ image-prep  本地图像规范化（WebP/GIF→JPEG、EXIF 摆正、280²~1568² 缩放）
        │
        ├─ primary     TypeSafe /v1/systemone (jev-1.14.0)
        │              文本直连；带图自动挂 TypeSafe-Danger-Zone-Images 头 + 组装 assets 引用
        ├─ vision-alt  pplx-decider v1.1 ($0.02/M) / vLLM-SR d3 (/v1/systemone + images[])
        │              与 Jev 1.14 跑影子对比，防 Jev 实验视觉毛刺
        ├─ cloud-gw    OpenRouter (/api/alpha/decisions 或 /api/v1/systemone)
        │              一个 key 切换 Jev / pplx-decider / Microsoft-Decision-1 / Clef-flash
        ├─ local       vLLM-SR d3-mini (4B) / Intern-Decision-4B / Kev-4B
        └─ fallback    LLM2Jev 免训练读出 / SGLang 读现有 VLM logits（或回退现有 RulesClassifier）
```

映射到现有任务（`src/analysis/types.ts` 的 `LlmTask` 保持不动，新增平行的 `DecisionTask`）：

| 任务 | 走决策模型 | 说明 |
|---|---|---|
| 直播分类（本场属哪些分类） | ✅ | state = 标题 + 分区 + 动态文本 + **直播封面/关键帧** |
| 图文帖判定（属哪些分类 / pass 与否） | ✅ | 带图 state（配图 + 正文）；翻译仍走现有 `post-analysis` |
| 预告表截图定位（未来 M3 预留） | 🧪 可试 `box` | 先用 `noul` 问「图中有无日程表」，为真则用 `jev-1.14.0` 的 `box` 裁出日程表区域再交 VLM 抽取 |
| 图文翻译（`llm_translate`） | ❌ | 需生成文本，继续走 LLM（若自托管 `JEV-27B-VL` 可同机走其 System 2 通道） |
| schedule-extract（生成时间表 JSON） | ❌ | 需生成自由结构化字段，继续走 LLM |

实现要点：

- **多标签分类不用 `choice`**（单选），改成**每分类一个 `noul`**，一次请求打包全问——同时吃到 fan-out 红利（注意：若后端切到 `vllm-sr/d3`，因其每题一次前向，需关注多分类打包时的延迟线性增长）
- **图片只传进 `state` 一次**：无论走 Jev `assets` 还是 `d3`/Clef 的 `images[]`，图片统一挂在 `state` 字段，各分类 `noul` 的 `instructions` 用反引号引用字段名，避免 Jev 按引用次数重复计费和撑爆 32 MiB 展开上限
- **分类口径仍由人填**（`categories` 的提示词/条件直接映射成 `instructions` + `criteria`），符合「人类需求是唯一锚点信源」的既定决策；未来甚至可利用 Jev 的 `criteria` 支持图片这一特性，允许用户上传 1–2 张典型封面做 visual few-shot 标准
- **provider 可热切换 + 锁版本号**：复用 `src/analysis/providers.ts` 的熔断/多 key/降级骨架，决策通道与 LLM 通道分开计费与限流；配置模型 ID 时写死 `jev-1.14.0` 而非 `jev-latest`，防别名自动漂移导致置信度阈值失效
- **影子模式横向评估（必做）**：上线前用 DD-claw 真实抓取的带图动态/直播封面（含中文花字、表情包、长图、多图），同时跑 **Jev 1.14（Danger Zone Images）**、**`pplx-decider v1.1`**（或 `d3`）与 **现有 LLM 分类**，横向对比三项指标：① 中文图文准确率、② 置信度校准分布（ECE）、③ 图片尺寸/格式拒收率与端到端延迟

## 六、风险与已知坑

1. **品类太新，跑分口径极易混淆**。诞生于 2026-09-15，本文基准日 2026-10-15。三大独立榜（Decision Index 0.3.2、Artificial Analysis 1.0、S1MB）与 JevBench 1.7 **彼此分数不可换算**，且排名经常打架（例如 AA 榜 Jev 57.5 第一、`pplx-decider` 53.1 第四；而 Decision Index 0.3.1 上 `pplx-decider` 62.75 第一、Jev 60.11 第三）。只含公开集的自报分（如 Clef 初版、Decision 3.0 初版模型卡）往往比加入私有盲测后的 Full Score 高出 5–13 分。
2. **Jev 视觉能力处于「野区（Danger Zone）」早期**。10-14 刚通过 header 解锁，官方明确不为生产稳定性背书；且 Jev 在复杂视觉推理上与全行业一样弱于纯文本。另外，**Jev 拒收 WebP、不自动缩放、不自动处理 EXIF 旋转、256×256 小图直接报 400**，不加前置图片清洗管线绝不可直接上生产。
3. **Agent 端到端实测警示：单步决策快 ≠ 整体工作流省钱/高成功率**。[2026-10-09 独立论文《When Faster Decisions Do Not Make Better Agents》（arXiv 2610.13092，4,500 次 ALFWorld 与 AndroidWorld 实测）](https://arxiv.org/abs/2610.13092v1) 发现：接入 Jev 虽大幅降低了单次决策延迟与开销，但在移动端 Agent 中任务成功率明显下降，失败重试与额外交互反而吞噬了决策省下的开销。对 DD-claw 的启示：我们是**单跳分类判定管线**（无多步状态恢复风险），正好处在决策模型的甜点区，但低置信度时必须干净利落地回退 LLM，不要用决策模型硬凑多跳逻辑。
4. **免训练 VLM 读出已经很强，微调未必普涨**。[微软 LLM2Jev 论文（arXiv 2610.02076）](https://arxiv.org/abs/2610.02076) 与 [《Typed Decision Models: An Early Evidence Audit》](https://github.com/AnotiaWang/awesome-jev/blob/main/README_zh.md) 一致证实：现代 4B+ VLM 开箱即具备良好校准的决策能力（Qwen3.5-4B 免训练 JevBench 81.4%、MMBench 82.4%）；不加区分的全参微调反而诱发「yes 偏置」和分布外倒退（81.4%→76.2%）。**先测云端 API 与免训练 VLM 基线，不要一上来就自己微调权重**。
5. **校准不等于对，高难度与跨模态下普遍过度自信**。[独立实测公平骰子 Jev 报 82.9% 概率实际命中 19%](https://github.com/AnotiaWang/awesome-jev/blob/main/README_zh.md)；[Artificial Analysis 1.0 校准曲线](https://systemonemodels.org/guides/jev-benchmarks/) 显示全部 11 款托管决策模型在推理题（HLE）上严重过度自信（Jev 在 HLE 上 ECE 飙升至 0.40，而在工具调用/安全分类上仅 0.05）。置信度阈值必须**按任务和动作**在自有数据上单独标定（可用社区工具 `jevcal` 拟合）。
6. **state 是不可信输入（对抗脆弱性）**。[JevAdvBench：往 state 追加一句未经核实的观点翻转 12.1% 决策](https://github.com/AnotiaWang/awesome-jev/blob/main/README_zh.md)；[USC 研究：加中位 31 词自然语境翻转 61.4% Jev 决策，开源 Qwen 系 72.6%](https://thenewstack.io/decision-models-system-one/)；[Will Kelly 实测在工单里塞一句「decision already taken」翻转了 147/200 条工单](https://systemonemodels.org/guides/jev-benchmarks/)。相比之下，[Microsoft-Decision-1 专门把 8 类无害扰动翻转率压到了 1.3%](https://datawhalechina.github.io/jev-cookbook/materials/39-microsoft-decision-1/)。抓来的动态/微博/X 文本必须当不可信数据隔离在 `state` 子字段内。
7. **schema 尚未完全统一，License 要逐个核对**。OpenAI（`/v1/decisions`，用 `input`+`predicate`）与 Perplexity（`/v1/decisions`）各立门户；多模态传图又分 TypeSafe `assets` 与 Clef/`d3` `images[]` 两派。License 上，StartLux / Torchcast Decision 27B / Vev / Drex 9B 为非商用或受限许可；Clef 系、`pplx-decider`、`vLLM-SR d3` 系、`JEV-27B-VL`、`Intern-Decision`、`Kev`、`Strands` 为 Apache 2.0。
8. **官方已知弱点**（[Jev 1.13 jaggedness 页面](https://docs.typesafe.ai/model-jaggedness/jev-1.13)，截至 10-15 官方尚未发 1.14 独立短板页）：按字面理解问题、不会数数、日期当文本、上下文腐烂（无关 state 拉低准确率）、多跳推理退化、以及 **正反 `noul` 概率之和不保证等于 1（实测可达 1.19）**。对策都是「计算与不变量校验留在代码里，把结果传进 state」。

## 七、来源与时间戳

| 来源 | 日期 | 用途 |
|---|---|---|
| [TypeSafe 官方博客《Jev: For the builders AND dreamers》](https://typesafe.ai/blog/jev-1-14) / [Datawhale 42 号整理](https://datawhalechina.github.io/jev-cookbook/materials/42-jev-1-14/) | 2026-10-14 | **`jev-1.14.0` 发布与野区三件套（可组合图像、`box` 原语、262K 长上下文）及内部 antibench 图表** |
| [TypeSafe 官方文档：Images](https://docs.typesafe.ai/go/images) · [Box](https://docs.typesafe.ai/go/box) · [Models](https://docs.typesafe.ai/models) | 2026-10-14 | `assets` 引用替换机制、multipart/Base64 格式、图片尺寸/像素硬限制、`box` 请求响应与 `noul` 配对规范 |
| [explainx.ai《Jev 1.14: What TypeSafe Actually Shipped, and What the Headlines Overstate》](https://explainx.ai/blog/jev-1-14-danger-zone-multimodal-box-long-context-claimed-vs-verified-2026) | 2026-10-15 | 独立核查 Jev 1.14 宣称项与实际限制、文档未同步点、组织级数据共享开关提示 |
| [systemonemodels.org：Jev 1.14 指南](https://systemonemodels.org/guides/jev-1-14/) · [Best AI Decision Models（13 款排名）](https://systemonemodels.org/compare/best-ai-decision-models/) · [Jev Benchmarks 综述](https://systemonemodels.org/guides/jev-benchmarks/) | 2026-10-14 ~ 10-15 | **最全独立评测聚合**：Artificial Analysis 1.0（10-13）、Decision Index 0.3.1（10-10）、JevBench 1.7.46（10-12）三榜合一及 20+ 独立实验汇总 |
| [decision.host 决策模型实时资料库与排行榜](https://www.decision.host/)（[文本榜](https://www.decision.host/rankings/?suite=di) / [Vision 榜](https://www.decision.host/rankings/?suite=di_vision)） | 2026-10-13 | **Decision Index 0.3.2 文本与 Vision 多模态子榜（20 项细分基准）完整原始得分**、S1MB 榜单、1208 篇相关论文索引 |
| [vLLM Semantic Router `Decision 3.0 (d3)` 发布报道（MarkTechPost / ccleaks）](https://www.marktechpost.com/2026/10/11/what-is-decision-3-0-vllm-semantic-routers-new-open-decision-models/) · [官方站](https://decision.vllm-sr.ai/) | 2026-10-11 ~ 10-12 | 0.6B–27B 六尺寸开源多模态决策模型、Vision 0.3.2 登顶（71.3）、每题单次前向机制、MI325X 图文/视频延迟 |
| [modelsystem.one《AutoTrust's JEV-27B-VL ranks second on the current vision board》](https://modelsystem.one/news/autotrust-jev-27b-vl-vision-board/) | 2026-10-11 | 核查 JEV-27B-VL 在 1.6MP 限制后的 Vision 0.3.1 真实排名（69.6，次于 pplx-decider v1.1 的 70.58） |
| [Microsoft-Decision-1 官方发布（Command Line / Datawhale 39 号）](https://datawhalechina.github.io/jev-cookbook/materials/39-microsoft-decision-1/) | 2026-10-09 | 微软 Foundry / OpenRouter 决策模型（Qwen3.5-9B 后训练，$0.042/M）、36 基准盲测、8 类扰动 1.3% 翻转率 |
| [LLM2Jev 论文（arXiv 2610.02076 / Datawhale 35 号全译）](https://datawhalechina.github.io/jev-cookbook/materials/35-llm2jev-paper/) | 2026-10 | 微软研究：免训练前缀无关数字读出（`Best answer: [`）、Qwen3.5-4B 零样本多模态决策（MMBench 82.4%）、LoRA+KL 锚定微调准则 |
| [arXiv 2610.13092《When Faster Decisions Do Not Make Better Agents》](https://arxiv.org/abs/2610.13092v1) · [arXiv 2610.13675（Clef 乳腺超声多模态评测）](https://arxiv.org/abs/2610.13675v1) | 2026-10-09 | 独立学术实测：Agent 环路中决策模型早退/恢复失败代价，以及 Clef 在专业医学图像上的 prompt 敏感性 |
| [Cloudflare Clef-Omni 评测（explainx.ai）](https://explainx.ai/blog/cloudflare-clef-omni-open-multimodal-decision-model-2026) · [Clef 初版博客](https://datawhalechina.github.io/jev-cookbook/materials/clef/) | 2026-10-01 ~ 10-09 | Clef（27B）/ Clef-flash（9B）/ Clef-omni（30B-A3B 含音视频）架构与定价 |
| [The New Stack《AWS, Upstage and Ollama agree on a decision-model API. OpenAI hasn't signed on》](https://thenewstack.io/decision-models-system-one/) | 2026-10-09 | 端点收敛格局的权威分析 |
| [Jev 工程与置信度路由（@polydao 长文中译）](https://datawhalechina.github.io/jev-cookbook/materials/polydao/) | 2026-09-29 | 三原语、fan-out、问题设计规则、失灵面、级联范式 |
| [JEV-27B-VL 发布文（AutoTrust / ModelScope）](https://datawhalechina.github.io/jev-cookbook/materials/38-wechat-jev27b-vl/) · [RSI-Jev（Datawhale 37 号）](https://datawhalechina.github.io/jev-cookbook/materials/37-rsi-jev/) | 2026-10-09 | 27B 多模态决策结构、System 1+2 双通道、多层早退出口头与 496 实验总结 |
| [Intern-Decision（InternLM 官方仓库）](https://github.com/InternLM/Intern-Decision) | 2026-10 | 4B/2B/0.8B 完整数据、延迟、校准表與训练代码 |
| [SGLang 决策模式（BlockBeats）](https://www.theblockbeats.info/flash/369767) · [llama.cpp / Ollama 本地端点（掘金）](https://juejin.cn/post/7692612898275426330) | 2026-09-25 ~ 10-04 | 本地运行时支持矩阵与无专用权重 logits 读出 |

### 复核清单（下次动这块代码前逐条重查）

- [ ] **Jev 1.14 视觉能力是否已出现在独立榜（Decision Index Vision / Artificial Analysis）**，以及 `TypeSafe-Danger-Zone-Images` 是否摘掉实验标签、是否放宽 WebP 与尺寸自动缩放
- [ ] `jev-latest` 别名是否已按计划（约 2026-10-21）切到 `jev-1.14.0`，以及 TypeSafe 是否发布了 1.14 的 jaggedness 已知短板页
- [ ] vLLM-SR `d3` 系列（尤其 `d3-mini` 4B / `d3-flash` 9B）是否已支持单次前向多问联合打分及 GGUF/llama.cpp 量化部署
- [ ] OpenAI Decisions API（`gpt-6-luna`）是否正式 GA 并公布视觉跑分与选项上限
- [ ] Jev Decision Index 当前版本号与 Vision 榜首（切勿跨版本或拿纯公开集分与含私有集的 Full Score 混比）
- [ ] 本文所有价格（Jev $0.042/M、pplx-decider $0.02/M、Clef $0.24/M、Clef-flash $0.038/M、OpenAI $0.10/M 等）
