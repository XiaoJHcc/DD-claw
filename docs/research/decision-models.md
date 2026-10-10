# 调研：类 Jev 决策模型（System One / 类型化决策）

基准日 **2026-10-10**。整个品类诞生于 **2026-09-15**（TypeSafe 发布 Jev），至今不足一个月，**所有跑分、价格、License、模型清单都可能在下个月作废**。本文每条结论都标注了来源与日期，实现前必须重新核实对应条目。

## 结论（2026-10-10 版）

- **内部抽象对齐 TypeSafe System One 契约**（`POST /v1/systemone`）作为唯一主端点。[schema 战已基本收敛](https://thenewstack.io/decision-models-system-one/)：AWS / Upstage / Ollama / llama.cpp / SGLang 等都是 wire-compatible 实现，官方 SDK 换 base URL 即可切换。其他端点（OpenRouter Decisions、Perplexity、各家自有 `/v1/decide`）一律**只做薄适配器，属备选**
- **识图能力是默认要求，不是可选项**。直播/图文场景的核心输入是封面与配图；纯文本决策模型仅作回退兼容路径
- **只覆盖「决策形状」的任务**：输出是可枚举标签 / 是非 / 有序评分的判断。需要生成文本的任务（翻译、schedule-extract、给人读的理由）**不适用**，继续走 LLM
- **级联方向与现有 LLM 管线相反**：代码规则 → 决策模型（置信度过阈值）→ LLM 兜底 → 人工。现有「LLM 优先 + 确定性回退」在决策类任务上应反转
- **confidence 不是「答对的概率」**，是概率分布集中度；阈值必须按动作在自有数据上标定

## 一、这是什么

Jev 是 [TypeSafe AI 2026-09-15 发布的「System One 模型」](https://torchtree.com/post/jev-decision-model/)——一个**完全不生成文本**的模型。输入一段 `state`（字符串/JSON）加一组类型化问题，一次前向为每个答案返回**校准概率**，程序直接分支。

三种原语（[TypeSafe API 参考](https://datawhalechina.github.io/jev-cookbook/api/)）：

| 原语 | 问什么 | 返回 | 约束 |
|---|---|---|---|
| `choice` | 从给定选项里挑一个 | `choice` + 每项 `probabilities` + `confidence` | 最多 **255** 项，概率和为 1 |
| `score` | 放到有序量表上 | `score`（可落在档位间）+ 分布 + `confidence` | **2–10** 档 |
| `noul` | 是/否 | 「是」的概率 | 0.5 = 判断不了 |

机制上的根本差异：输出空间被架构锁死，不需要逐 token 自回归解码，所以快（70–500ms）、便宜（输出 token 免费）、**不可能返回 schema 外的值**。代价是**没有生成能力**——[「别把它当 LLM 用」](https://tianqi.csdn.net/6ab2872d05257b08571259c1.html)。

## 二、API 契约：以 `/v1/systemone` 为准

### 请求 / 响应

```jsonc
// POST /v1/systemone   Authorization: Bearer <KEY>
{ "model": "jev-latest",
  "state": "…文本或 JSON；带图模型可传文本与图片交替的列表…",
  "questions": {
    "is_urgent":   { "type": "noul",   "instructions": "…",
                     "criteria": { "true": "…", "false": "…" } },
    "department":  { "type": "choice", "instructions": "…",
                     "criteria": { "billing": "…", "bug": "…", "other": "…" } },
    "frustration": { "type": "score",  "instructions": "…",
                     "criteria": ["Calm", "Annoyed", "Angry"] }
  } }

// 响应：answers 的 key 与 questions 一一对应
{ "model": "jev-1.13.0",
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
- 上限：state + 最长单个问题约 32K token；state + 全部问题约 64K（Jev 口径，[来源](https://datawhalechina.github.io/jev-cookbook/materials/polydao/)）
- 错误码：401 / 422 / 429 / 529（过载），429 与 529 都走指数退避

### 端点全景（截至 2026-10-07）

| 契约 | 端点 | 实现方 | 状态 |
|---|---|---|---|
| **TypeSafe System One** | `POST /v1/systemone` | TypeSafe Jev（原生）、Upstage Solar Decide、AWS Strands Decider、Kev、Open-Jev、Laya、Ollama 0.35、SGLang、Ollaya、Bud Decision Studio、Winnow、360 智脑、Zenlayer 网关 | **事实标准，主端点** |
| OpenRouter System One 路由 | `POST /api/v1/systemone` | OpenRouter 为兼容 TypeSafe SDK 提供 | ✅ 备选，改 base URL 即可 |
| OpenRouter Decisions | `POST /api/alpha/decisions` | OpenRouter 自家 | alpha，可能变更 |
| OpenAI Decisions API | 未公开 | GPT-6 Luna | 限量预览，**schema 与定价均未发布** |
| Perplexity Decisions | 自有路径 | pplx-decider v1.1 | 同三种题型，路径不同 |
| 各家自有 | `/v1/decide`、`/v1/decisions` | JEV-27B-VL、Intern-Decision、SGLang | 需写适配器 |

来源：[The New Stack《AWS, Upstage and Ollama agree on a decision-model API》2026-10-09](https://thenewstack.io/decision-models-system-one/)、[OpenRouter Jev 文档](https://openrouter.ai/docs/guides/community/jev)、[TypeSafe API 参考](https://datawhalechina.github.io/jev-cookbook/api/)。

> **「换 URL 就能换模型」只就代码可移植性成立，不就行为成立**。各实现在选项上限、confidence 计算方式、答案质量上仍有差异（例如 meraGPT Decider 的 Choice 最多 10 个标签、请求上限 4096 token）。切换必须过契约一致性测试。

## 三、与 OpenAI Chat Completions 的异同

| 维度 | OpenAI Chat Completions | System One `/v1/systemone` |
|---|---|---|
| 请求 | `messages[]` | `model` + `state` + `questions{}` |
| 输出 | 生成的文本 / JSON | 类型化答案 + 每选项概率 + confidence |
| 生成方式 | 自回归逐 token | 一次前向并行打分 |
| 计费 | 输入 + 输出 token | **只收输入**，输出免费 |
| 延迟 | 数百 ms ~ 数秒 | 70–500ms，典型 ~100ms |
| 格式保证 | prompt + 解析 + 兜底重试 | **架构层锁死** |
| 幻觉 | 会 | 不会编造选项，但**可能返回「错误的合法值」** |
| 生成能力 | 有 | **无** |
| 置信度 | 自称的，不可信 | 校准过的（RLCD 训练目标是诚实概率） |
| 多问合一 | 多次调用 | 一次请求并行 |
| 选项上限 | 无 | `choice` ≤ 255 |
| SDK | `openai` | `typesafe-sdk` / `@typesafe-ai/sdk` |

**两者不是替代关系，是分工**：决策模型替换的是「问 LLM 一个窄问题再解析出标签」这一段，不替换任何需要写字的环节。

## 四、多模态候选（识图为默认要求）

### 云端

| 模型 / 服务 | 底座 | 图 | 协议 | License | 备注 |
|---|---|---|---|---|---|
| **JEV-27B-VL**（AutoTrust） | Qwen3.8-27B | ✅ 单请求 ≤8 张（URL/Base64） | `/v1/decide` + **同进程标准 OpenAI `/v1/chat/completions`** | Apache 2.0 | [Jev Decision Index 0.3 视觉榜第一（77.8% / 13,695 条），全量榜 69.8 总榜第一](https://datawhalechina.github.io/jev-cookbook/materials/38-wechat-jev27b-vl/)。**双通道是独有优势**：决策与生成同一台机器。32K ctx，建议 80GB 显存 |
| **Clef / Clef-flash**（Cloudflare） | Qwen3.8-27B | ✅ 图 + **视频** | **Jev 兼容**，Workers AI 托管 | Apache 2.0 | 对所有问题的所有选项联合打分。托管侧带图首选 |
| **pplx-decider v1.1**（Perplexity） | Qwen3.8-27B | ✅ | 自有 Decisions API | Apache 2.0 | [Decision Index 61.56，$0.02/M 输入](https://thenewstack.io/decision-models-system-one/)，最便宜托管 |
| **OpenAI Decisions API** | GPT-6 Luna | ✅ 文本/JSON/图 | 自有，**schema 未发布** | 托管 | 限量预览，暂不接入 |
| **StartLux-Decision** | 0.8B–27B + 35B-A3B | ✅ ≤256K token | `/v1/systemone` | ⚠️ 权重 CC BY-NC | [Decision Index 0.2.1 得分 63.88 对 Jev 57.91](https://www.shobserver.com/news/detail?id=1189856) |
| **d1**（Liquid AI） | 未公开 | ✅ | `/v1/systemone` | 托管 | OpenRouter 上目前仅文本 |

**云端推荐**：需要图走 **Clef（托管）或 JEV-27B-VL（自托管）**；纯文本经 **OpenRouter `/api/v1/systemone`** 做多厂商入口（一个 key 挂着 Jev / Mercury Decide / d1 等，可随时换后端）。

### 本地（≤9B，优先 4B）

**运行时**：llama.cpp `llama-server`（[2026-10-02 合并 PR #29818，首发支持 Julia-1 / Laya / Kev-4B / lev / OpenJev，支持图片 state，RTX PRO 6000 上 3–43ms](https://juejin.cn/post/7692612898275426330)）或 Ollama 0.35（同形端点，易用）。**SGLang 是第三条路**：[原生 `/v1/systemone`，从普通对话模型的下一 token 分数读选项概率，**无需专门 checkpoint**](https://www.theblockbeats.info/flash/369767)——可把任意 Qwen3.5-VL 直接当决策模型用，作兜底。

| 模型 | 底座 | 图 | 协议 | License | 备注 |
|---|---|---|---|---|---|
| **Intern-Decision-4B**（上海 AI 实验室） | Qwen3.5-4B（冻结视觉塔） | ✅ | `/v1/decisions`（需适配） | HF 权重 | [7 套件平均 90.02%（Jev 88.74%），RTX 4090 上 44ms，Brier 0.550 / ECE 0.089 双优于 Jev](https://github.com/InternLM/Intern-Decision)。**4B 档综合最强**。附训练代码、两套推理后端、温度校准 |
| **Kev-4B / 9B**（Jared Palmer） | Qwen3.5 / 3.8 | — | **System One 原生** | Apache 2.0 | llama.cpp 首发支持；[移植到 Qwen3.5 约 $95 H100](https://thenewstack.io/decision-models-system-one/) |
| **JevK5 2B/4B/9B** | Qwen3.5 | — | **System One** + GGUF | Apache 2.0 | CPU/GPU 都能跑 |
| **Vev 4B/9B** | Qwen3.5 | ✅ | **System One** | ⚠️ 权重非商用 | 图文直进 state，协议最省事的带图选项 |
| **Strands Decider 2B**（AWS） | Qwen3.5-2B | — | **System One** | Apache 2.0 | 权重/训练数据/脚本全公开；[3090 上单问中位 115ms](https://thenewstack.io/decision-models-system-one/) |
| **Valen 0.8B/2B/4B** | — | ✅ 图 + 视频 | — | Apache 2.0 | 训练代码 + 训练数据全公开 |
| **Nimble 9B / Jeeves 9B** | Qwen3.5-9B | 底座原生多模态 | Ollama / 自托管 | Apache 2.0 | [Jeeves 在 JevBench 231 公开题上 0.935 对 Jev 0.866，训练代码数据全公开](https://github.com/AnotiaWang/awesome-jev/blob/main/README_zh.md) |
| **Laya 322M/421M** | ModernBERT 编码器 | — | **System One** | Apache 2.0 | 最快，但 [Jevbench-Hard 仅 28.83%](https://github.com/InternLM/Intern-Decision)。**只能当快速筛，不能当主力** |

**本地推荐**：带图走 **Intern-Decision-4B**（性能/校准/延迟三好，代价是要写 `/v1/decisions` 适配器）或 **Vev 4B**（原生 System One 但权重非商用）；纯文本走 **Kev-4B / JevK5 4B**；无权重兜底走 SGLang。

> 识图门槛参考：Qwen3.5-9B 是原生多模态（统一视觉-语言、262k ctx）。27B 底座（JEV-27B-VL / Clef / pplx-decider）明显强于它；Qwen3.5-9B 系（Vev 9B / Nimble / Jeeves）正好达标；**Intern-Decision-4B 的冻结视觉塔达不到**，若识图精度不足需升级到 9B 档。

## 五、落到 DD-claw

```
DecisionProvider.evaluate(state, questions) → answers   // 契约 = System One
        │
        ├─ primary   /v1/systemone        契约本体
        ├─ cloud     OpenRouter /api/v1/systemone       多厂商入口（改 base URL 可切 TypeSafe 直连）
        ├─ vision    Clef（托管）/ JEV-27B-VL（自托管）  图文链路默认走这里
        ├─ local     Intern-Decision-4B / Kev-4B        llama.cpp · Ollama
        └─ fallback  SGLang 读任意 Qwen3.5-VL 的 logits  无专用权重兜底
```

映射到现有任务（`src/analysis/types.ts` 的 `LlmTask` 保持不动，新增平行的 `DecisionTask`）：

| 任务 | 走决策模型 | 说明 |
|---|---|---|
| 直播分类（本场属哪些分类） | ✅ | state = 标题 + 分区 + 动态文本 |
| 图文帖判定（该不该推 / 哪类） | ✅ | 带图 state；翻译仍走现有 `post-analysis` |
| 图文翻译 | ❌ | 需生成文本 |
| schedule-extract | ❌ | 需生成结构化抽取 |

实现要点：

- **多标签分类不用 `choice`**（单选），改成**每分类一个 `noul`**，一次请求打包全问——同时吃到 fan-out 红利
- **分类口径仍由人填**（`categories` 的关键词/条件直接映射成 `criteria`），符合「人类需求是唯一锚点信源」的既定决策
- **provider 可热切换**，复用 `src/analysis/providers.ts` 的熔断/多 key/降级骨架，但**决策通道与 LLM 通道分开计费与限流**
- 上线前先跑**影子模式**：决策模型只打标，现有路径继续拍板，按置信度分带比对

## 六、风险与已知坑

1. **品类太新**。诞生 2026-09-15，本文基准日 2026-10-10。跑分多为厂商自报，不同版本的 Decision Index（0.2.1 / 0.3）**分数不可互比**；JEV-27B-VL 发布仅一天即宣称两个「第一」，[均出自作者方](https://datawhalechina.github.io/jev-cookbook/materials/38-wechat-jev27b-vl/)。
2. **准确率优势存疑，成本/延迟优势确凿**。[《Typed Decision Models: An Early Evidence Audit》综述发布后头几天的 28 篇论文：类型化读出相比「同类标签概率读出」没有显示出独立的准确率优势，最明确的收益是延迟和成本](https://github.com/AnotiaWang/awesome-jev/blob/main/README_zh.md)。含义：**先用 SGLang 读现有 VLM 的 logits 验证收益，再决定是否上专用决策模型**。
3. **校准不等于对**。[独立实测：隐藏公平骰子，Jev 每次都选 1，报 82.9% 概率，实际命中 19%](https://github.com/AnotiaWang/awesome-jev/blob/main/README_zh.md)。置信度阈值按**动作**设，不按模型设。
4. **state 是不可信输入**。[JevAdvBench：往 state 追加一句未经核实的观点就能翻转 12.1% 的决策](https://github.com/AnotiaWang/awesome-jev/blob/main/README_zh.md)；[USC 研究：加一段中位 31 词的自然语境可翻转 61.4% 的 Jev 决策，开源 Qwen 系 72.6%](https://thenewstack.io/decision-models-system-one/)。抓来的动态/微博文本必须当不可信输入处理，与「LLM 生成的参数永不可信」是同一条防线。
5. **schema 尚未正式开放**。[TypeSafe 未把 System One 发布为开放规范；OpenAI 一旦公布自有 schema，品类可能裂成两套契约](https://thenewstack.io/decision-models-system-one/)。内部抽象保持薄，不要绑死 TypeSafe 专有扩展。
6. **License 要逐个看**。StartLux-Decision / Vev 权重 CC BY-NC（非商用）；Clef / pplx-decider / JEV-27B-VL / Intern-Decision / Kev / JevK5 / Strands 是 Apache 2.0。
7. **官方已知弱点**（[Jev 1.13 jaggedness 页面](https://datawhalechina.github.io/jev-cookbook/materials/polydao/)）：按字面理解问题、不会数数、日期当文本、上下文腐烂（无关 state 拉低准确率）、多跳推理退化。对策都是「计算留在代码里，把结果传进 state」。

## 七、来源与时间戳

| 来源 | 日期 | 用途 |
|---|---|---|
| [The New Stack《AWS, Upstage and Ollama agree on a decision-model API. OpenAI hasn't signed on》](https://thenewstack.io/decision-models-system-one/) | 2026-10-09 | **端点收敛格局的权威分析**，市场表截至 2026-10-07 |
| [TypeSafe API 参考（中文）](https://datawhalechina.github.io/jev-cookbook/api/) | 2026-09-25 | `/v1/systemone` 请求/响应 schema 原文 |
| [Jev 工程与置信度路由（@polydao 长文中译）](https://datawhalechina.github.io/jev-cookbook/materials/polydao/) | 2026-09-29 | 三原语、fan-out、问题设计规则、失灵面、级联范式、价格 |
| [JEV-27B-VL 发布文（AutoTrust / ModelScope）](https://datawhalechina.github.io/jev-cookbook/materials/38-wechat-jev27b-vl/) | 2026-10-09 | 多模态决策模型结构、跑分、部署参数 |
| [Intern-Decision（InternLM 官方仓库）](https://github.com/InternLM/Intern-Decision) | 2026-10 | 4B/2B/0.8B 完整数据、延迟、校准表 |
| [Intern-Decision 投稿（量子位 / 智源社区）](https://hub.baai.ac.cn/view/58343) | 2026-09-29 | 速度、校准、大小模型协同 |
| [awesome-decision-models（社区清单）](https://github.com/AnotiaWang/awesome-jev/blob/main/README_zh.md) | 2026-10-05 | 全景索引：托管 API / 开源模型 / 运行时 / SDK / 评测 / 论文 |
| [OpenRouter Jev 文档](https://openrouter.ai/docs/guides/community/jev) | 2026-10-05 | 两个 API 面、SDK 切换方式 |
| [Jev 上手与置信度路由（七牛 / SegmentFault）](https://segmentfault.com/a/1190000048312646) | 2026-09-22 | 三档 confidence 路由实践 |
| [SGLang 决策模式（BlockBeats）](https://www.theblockbeats.info/flash/369767) / [LMSYS 博客](https://www.lmsys.org/blog/2026-09-25-sglang-decision-models) | 2026-09-25 / 09-30 | 无专用权重的决策模式 |
| [llama.cpp / Ollama 本地端点（AI 日报）](https://juejin.cn/post/7692612898275426330) | 2026-10-04 | 本地运行时支持矩阵与延迟 |
| [OpenAI Decisions API 对比（博客园）](https://www.cnblogs.com/sing1ee/p/23166636/decisions-api) | 2026-09-30 | OpenAI 侧差异 |
| [Jev 是什么 / 工程 101（CSDN、网易、人人都是产品经理、torchtree）](https://tianqi.csdn.net/6ab2872d05257b08571259c1.html) | 2026-09-16 ~ 09-24 | 概念、原语边界、上手建议 |

### 复核清单（下次动这块代码前逐条重查）

- [ ] TypeSafe 是否已把 System One 发布为开放规范
- [ ] OpenAI Decisions API 的 schema 与定价是否公开
- [ ] Jev Decision Index 当前版本号与榜首（不要跨版本比分数）
- [ ] Intern-Decision / Vev / Kev 的新版本与 License 变化
- [ ] llama.cpp `llama-server` 与 Ollama 的 `/v1/systemone` 支持矩阵
- [ ] 本文所有价格（Jev $0.042/M、pplx $0.02/M 等）
