# 调研：LLM 接入

基准日 2026-07-29。**2026-08-06 修订**：选型结论推翻重来（见下「结论」），免费额度对比表保留作参考。**所有免费额度政策变动频繁，实现前必须重新核实。**

## 结论（2026-08-06 修订版）

- **多模态是硬要求**：信息量中含可用图片的任务一律走多模态模型（vision 路由）；纯文本任务走便宜文本模型（text 路由，DeepSeek 等打头）。文本融合仍是主路径，但视觉不再是「万不得已才用」
- **OpenAI 兼容 API 直连，聚合层写在代码里**（`src/analysis/providers.ts`：text/vision 路由 + 熔断 + 多 key 池 + 降级链；chat/completions 与 responses 双协议，Anthropic 协议不接）。不引 LiteLLM/one-api 等外部网关——本项目已是常驻进程，两层路由/熔断是重复建设
- **便宜付费 API 是主力**，不追求绝对免费：MiniMax-M3（多模态，OpenAI 兼容，约 ¥1.5/M tokens）、MiMo（mimo.mi.com，OpenAI/Anthropic 双兼容）已核实可用；DeepSeek 纯文本打 text 路由
- **本地 LM Studio**（Qwen3-VL-8B / Gemma 多模态）作为 vision 路由降级位：OpenAI 兼容端点零成本接入，但 JSON schema 输出可靠性是门槛，`structuredOutput: "none"` + 围栏剥离兜底
- **OpenCode Go 订阅**：**走官方 API 接入，CLI / 反代方式整体舍弃**（`https://opencode.ai/zen/go/v1`；chat/completions 族直接可接，`api: 'responses'` 已支持 gpt-5.6-luna 族；Anthropic /messages 族不接——决策 2026-08-06：他家模型太贵，MiniMax/Qwen 走各自官方 API）。定位降级链上的正规便宜 provider，仍不当唯一主力：与 coding 共享配额（$12/5h、$30/周、$60/月，分析流量会吃掉编码预算）、无 SLA、视觉能力未核实、ToS 对无人值守自动化是灰色而非明令禁止（详见下文「OpenCode Go API 核实」）
- **coding 订阅反代成 API：不做**。这才是当初封号警告的本体（订阅流量伪装成 API 流量），核心基础设施不建在可随时被无预警收回的依赖上

## 结论（2026-07-29 原版，已被上面取代）

- 主路径是**文本融合**，不是视觉、不是音频 —— 免费额度压力小一个量级
- 视觉首选 **Gemini 免费层**，备选 **智谱 GLM-4V-Flash**
- ~~**不采用 agent CLI 当后端**（封号风险）~~ → 2026-08-06 终版：CLI / 反代方式整体舍弃，OpenCode 走官方 API；订阅反代不做
- 「唱歌 vs 说话」用**本地模型**，不用 LLM

## 免费视觉模型对比

| 提供商 | 免费额度 | 国内实名 | OpenAI 兼容 | 结构化输出 |
|---|---|---|---|---|
| **Google Gemini**（flash 系） | 文字/图片输入输出免费，但**已不再公布固定 RPM/TPM/RPD**，改为「以 AI Studio 控制台你项目的 Rate Limit 面板为准」。免费层**数据会用于训练**，不支持 Batch API。第三方引用的 15RPM/1500RPD 等数字**不可信** | 不需要 | 否（官方 SDK/REST） | ✅ `responseSchema` + `responseMimeType`，含 enum、`propertyOrdering` |
| **智谱 GLM-4V-Flash / 4.6V-Flash** | 官方定位**完全免费、不限量**，限制在速率而非配额。并发数第三方称 10 [待验证] | 需要（大陆手机号实名） | 接近（字段名不同） | ✅ function calling / JSON |
| **阿里百炼 Qwen-VL** | 新用户**每模型独立 100 万 tokens / 90 天**，仅华北2(北京) region。VL 专属数字未在文档单列 [待验证] | 需要 | 部分（DashScope 原生 + OpenAI 兼容） | ✅ |
| **SiliconFlow** | 官方免费清单已过期为 2024 年纯文本模型，**当前视觉模型基本都按量计费**。第三方「14 个免费模型/月 200 万 tokens」说法与官方接口不符，**不可信**。建议直接调 `GET /v1/models` 核实 | 需要（仅手机号） | ✅ 完全兼容 | ✅ JSON mode |
| **OpenRouter `:free`** | 清单动态变化极快，第三方聚合数据互相矛盾（17/15/27+ 家不等）。约 20 req/min、200 req/day/模型 [待验证] | 不需要 | ✅ | 取决于底层模型 |
| **Groq** | 免费层**无原生视觉模型** [待验证] | 不需要 | ✅ | — |
| **Cerebras** | 几乎全是文本模型；仅 `gemma-4-31b`(Preview) 支持图片，限 2 张/请求、10MB、**仅 base64 不支持外链** | 不需要 | ✅ | ✅ |
| 豆包 / Moonshot / MiniMax | **均未找到官方明确的视觉免费额度页面**，第三方数据互相矛盾 [待验证] | 需要 | ✅ | ✅ |

### 选型（2026-08-06 修订：转向便宜付费多模态）

免费层对比表保留作兜底参考，但主力已改为付费 API：

1. **text 路由**：DeepSeek 打头（纯文本、便宜），可叠加 MiMo 等
2. **vision 路由**：MiniMax-M3 打头（已核实原生多模态 + OpenAI 兼容，约 ¥1.5/M tokens）→ 本地 LM Studio（Qwen3-VL-8B / Gemma）降级 → Gemini/GLM 免费层应急兜底
3. 原 Gemini 首选 / GLM-4V-Flash 备选的免费层组合降级为「应急兜底」，不再当主力

原免费层选型记录：

1. **首选 Gemini flash 系** —— 不需国内实名、原生结构化输出、音频能复用同一 key。风险：免费层数据用于训练（直播画面有隐私顾虑需注意）；RPM/RPD 不再有保证，代码必须自适应重试降级
2. **备选 GLM-4V-Flash** —— 免费不限量、国内网络直连，作为 Gemini 限流/不通时的 fallback。代价是要大陆手机号实名
3. **第三梯队 Qwen-VL** —— 可申请多个模型的独立额度叠加

**不要长期依赖 SiliconFlow / OpenRouter `:free`** 做主力，清单变化太快，仅作应急兜底。

## 音频：判断唱歌不需要 LLM

**`inaSpeechSegmenter`**（INA 法国国家视听研究院，MIT，CNN + TensorFlow）直接输出 speech / music / noise 分段。

**关键行为：唱歌被标成 `music` 而不是 `speech`** —— 正好就是本项目需要的分类维度，几乎不需额外训练。

- MIREX 2018 Music/Speech Detection 挑战赛冠军；2024 InaGVAD 基准第一，超过 Pyannote、Silero、SpeechBrain 等 6 个开源 VAD 系统 [文档]
- CPU 即可运行，几秒音频处理是毫秒级
- 局限：说话人性别识别针对法语优化，但 speech/music/noise 分段本身对语言不敏感。**中文直播实测精度需自行验证** [待验证]
- 本机可行性 [实测]：`tensorflow-2.21.0-cp313-cp313-win_amd64.whl` 存在，Python 3.13.6 装得上。TF 约 300MB+，但只在音频阶段才需要

其他方案：

- `Silero VAD` 设计目标是通用语音活动检测（有声/无声），**不区分唱歌与说话**，不适合作主判断
- `YAMNet` 对 "singing vs speech" 细分类未找到可靠 mAP 数据 [待验证]
- `librosa` 特征 + 规则：实现成本低但精度依赖手工调参，不如直接用预训练模型

### 原生音频输入的 LLM（仅边界情况用）

| 方案 | 说明 |
|---|---|
| Gemini 音频输入 | 支持 wav/mp3/aac/flac/ogg，可结合文字 prompt。具体时长限制未核实 [待验证] |
| **Qwen3-Omni-Captioner**（百炼） | 专做「语音/环境音/音乐/音效」自动描述，**原生区分 speech vs music**，不需写 prompt。免费 100 万 tokens（90 天）。音频 token = 秒数 × 12.5，1M ≈ **22 小时音频**。最贴合需求的免费音频模型 |
| Qwen-Omni 系列 | 通用多模态，分类 prompt 更灵活，免费额度覆盖范围待确认 |

### ASR

| 方案 | 说明 |
|---|---|
| Groq Whisper (large-v3-turbo) | 免费层 20 RPM、2000 请求/天、**28800 秒音频/天（约 8 小时）**。OpenAI 兼容接口 |
| 本地 faster-whisper | large-v3 全精度约 10GB 显存，int8 量化 4-5GB；GPU 下可实时 |
| 本地 FunASR (Paraformer) | 中文效果优秀，CPU 可推理（ONNX 优化版），中文场景优于 Whisper |

**注意**：纯 ASR 转出的是歌词文字，本身不判断「在唱歌」。而弹幕的 `UNIVERSAL_ASR_TEXT` cmd（见 [danmaku.md](danmaku.md)）看名字是 B站自己的 ASR 推送 —— 若可用，可能直接省掉这整块。

## agent CLI 当后端：风险评估（2026-08-06 修正）

> **2026-08-06 终版：agent CLI / 订阅反代路线整体舍弃（含 opencode CLI 实验接入）。OpenCode 一律走官方 API（见下文「OpenCode Go API 核实」）。本节仅存档：harness 盗用与订阅反代的封号警告仍然有效。**

| CLI | 非交互 | 图片 | 强制 JSON | 风险 |
|---|---|---|---|---|
| `gemini-cli` | ✅ `-p` / 管道 | 靠 prompt 里 `@file.png`（issue #15532 被 close as not planned） | ❌ `--output-format json` 只包一层元数据，正文仍是自然语言 | **高** |
| `claude` CLI | ✅ `-p` | 未找到明确证据支持传图做纯分类 [待验证] | ❌ 无原生 schema | 中 |
| `codex` CLI | ✅ `codex exec` | ✅ `-i/--image`（本地文件） | ✅ **`--output-schema`** 走 Responses API strict 模式，三家里唯一原生支持。但 issue #15451：MCP/工具激活时可能静默降级为类 YAML 文本 | 中 |
| `opencode` | ✅ `run` / `serve` | 未核实 | ❌ 无原生 schema | **低于原评估**（见下） |

**原结论「不值得做」对 harness 盗用场景依然成立，且同样适用于订阅反代：**

1. **ToS/账号风险**。2026-02 起 Google 已大规模封禁通过第三方 harness（如 OpenClaw）piggyback Gemini CLI OAuth 认证的账号，官方明确「利用第三方工具 harvest 或 piggyback Gemini CLI 的 OAuth 认证访问后端服务，直接违反条款」（[gemini-cli discussion #20632](https://github.com/google-gemini/gemini-cli/discussions/20632)）。Anthropic 明确 OAuth 登录仅限「ordinary, individual usage」，构建产品/服务应用 API Key（[legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance)）。**「把 coding 订阅反代成 API」正是这个模式的本体——明确不做。**
2. **工程上不划算**：CLI 为人类交互式编程设计，冷启动开销大，stdout 混杂非结构化信息，无原生 schema 保证。
3. 正路是官方 API key —— 那本来就是官方划给开发者调用的额度，无灰色地带。

~~**OpenCode Go 的修正评估（2026-08-06）**：官方 opencode CLI + 自有订阅可作实验性 provider~~ → **同日终版：CLI 路线舍弃**，OpenCode Go 一律走官方 API（见下节），进程编排/会话管理的维护面不复存在。

**OpenCode Go API 核实（2026-08-06 二次修订，推翻「只能走 CLI」假设）**：官方文档明确给出 API 端点（[opencode.ai/docs/go](https://opencode.ai/docs/go/)），`GET https://opencode.ai/zen/go/v1/models` 无需 key 即可列模型（已实测 200）。要点：

- **协议分裂已接线消化**：`kimi-k2.6` / `mimo-v2.5(-pro)` / `deepseek-v4-pro/flash` / `glm-5.*` / `grok-4.5` / `hy3` 走 `/chat/completions`（默认协议，直接可接，baseURL = `https://opencode.ai/zen/go/v1`，Bearer key）；`gpt-5.6-luna` 走 `/responses`——providers.ts 已支持（provider 配 `api: 'responses'`，2026-08-06 实现）；`minimax-m3` / `minimax-m2.*` / `qwen3.*` 走 `/messages`（Anthropic 协议）——**明确不接**（决策 2026-08-06：他家模型太贵；MiniMax M3 走 MiniMax 官方 API，本身 OpenAI 兼容）
- **多模态未核实**：`/v1/models` 元数据不含模态信息，Go 自我定位是「coding models」，图片输入是否放行必须拿真 key 实测；实测前**不要把 Go 模型排进 vision 路由**。列表里有 `mimo-v2-omni`，名字暗示多模态，同为待验证
- **配额**：限额按美元计（$12/5h、$30/周、$60/月），与编码会话共享同一池。便宜模型量很大（官方估算 MiMo V2.5 约 15 万次/月、DeepSeek V4 Flash 约 15.8 万次/月），分析流量本身塞得下，但高峰时会和编码互相挤
- **合规（ToS 2026-03-06 生效）**：无「仅限编码用途」明文，官方自己文档化 API 端点、Docker Agent 等第三方也把它当通用 provider 用；但样板条款第 04 条（禁止「automatically or programmatically extracts data or Output」）与第 09 条（禁止「未登录时运行的进程」）严格字面可覆盖无人值守自动化，Go 的定位也是 coding 订阅——**灰色而非明令禁止**，账号处置权在对方（「sole right to decide」）。风险定级：低-中。用法收敛：自有订阅 + 官方 API + 正常流量节奏，不搞多账号/绕限流
- **隐私**：kimi / mimo / minimax / qwen / deepseek / glm / hy3 均 0 天保留、不用于训练；`gpt-5.6-luna` 30 天保留 + 滥用监控日志，`grok-4.5` 30 天保留——直播截图/弹幕不送这两家
- **结构化输出能力未核实**：chat/completions 的 `response_format` 与 responses 的 `text.format` 是否支持 json_schema 都需实测；不支持则用现有 `structuredOutput: "none"` 档 + 围栏剥离兜底

## Provider 抽象层（2026-08-06 已实现：`src/analysis/providers.ts`）

原始设计草图（`LLMProvider.classify` 单任务接口 + 固定优先级链）已演化为：

- **`LlmRouter.completeJson(req, parse?)`**：按「输入是否含图」自动选 text / vision 路由（也可显式 `vision` 覆盖），沿路由有序尝试，全部失败抛 `AllProvidersExhaustedError`
- **路由 = 配置里的 provider name 有序列表**（`llm.routes.text` / `llm.routes.vision`），前者优先、失败/熔断降级
- **统一输出 schema**：任务层带 zod `parse` 进 router；parse 失败与端点失败同等计入熔断并降级——模型没按 schema 输出 = 本次不可靠
- **结构化输出按 provider 能力分三档**（`structuredOutput: schema | object | none`）：json_schema 约束最强；none 用于不支持的小模型/本地端点，解析时剥 ```json 围栏兜底
- **双协议**（`api: chat-completions | responses`，默认前者）：responses = OpenAI Responses API（system 消息并入 `instructions`、部件换算 input_text/input_image、结构化输出走 `text.format`、`max_output_tokens`）；Anthropic /messages 协议不做
- **熔断 + 冷却**：连续失败到阈值（默认 3 次）打开，冷却期（默认 10 分钟）内直接跳过，不撞已知挂掉的端点
- **多 key 池**：`keyEnvs` 列多个环境变量，轮询使用；key 只出现在 Authorization 头，绝不进日志
- **配置热更新**：provider 名单与 key 全在面板 LLM 卡片管理（settings 表是事实来源，config.json 仅首次种子），改名单/排序/key 重建 router 热生效，换模型不改代码

OpenCode Go 接入零代码改动：面板加一条 provider（baseURL `https://opencode.ai/zen/go/v1`；chat/completions 族默认协议直接填，gpt-5.6-luna 协议选 responses），进降级链后熔断自然兜住它的不稳定。

## 分类 schema 与 prompt

```jsonc
{
  "scene":            "chatting | singing | gaming | other",
  "confidence":       0.0,                    // 0-1
  "evidence":         ["...", "..."],         // 2-4 条具体依据
  "secondary_scene":  "同枚举 | null"          // 边打游戏边聊天
}
```

prompt 要点：只依据客观线索，不过度推测；画面与音频冲突时以更明确的一方为准并在 evidence 说明。

若本地音频检测已给出 `music`，把这个先验作为额外 context 喂进去（「音频初步判断为 music」），让 LLM 结合文本做最终确认，准确率通常更高。

## 参考

- [Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) / [structured output](https://ai.google.dev/gemini-api/docs/generate-content/structured-output)
- [智谱 GLM-4V-Flash](https://docs.bigmodel.cn/cn/guide/models/free/glm-4v-flash)
- [百炼新用户免费额度](https://help.aliyun.com/zh/model-studio/new-free-quota) / [Qwen3-Omni-Captioner](https://help.aliyun.com/zh/model-studio/qwen3-omni-captioner)
- [Groq rate limits](https://console.groq.com/docs/rate-limits)
- [inaSpeechSegmenter](https://github.com/ina-foss/inaSpeechSegmenter)
- 2026-08-06 新增：[MiniMax API 模型文档](https://platform.minimax.io/docs/release-notes/models)（M3 原生多模态、OpenAI 兼容）/ [MiMo 开放平台](https://mimo.mi.com/docs/en-US/quick-start/summary/first-api-call)（OpenAI/Anthropic 双兼容）

