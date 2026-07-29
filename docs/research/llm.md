# 调研：LLM 接入

基准日 2026-07-29。**所有免费额度政策变动频繁，实现前必须重新核实。**

## 结论

- 主路径是**文本融合**，不是视觉、不是音频 —— 免费额度压力小一个量级
- 视觉首选 **Gemini 免费层**，备选 **智谱 GLM-4V-Flash**
- **不采用 agent CLI 当后端**（封号风险）
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

### 选型

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

## 不采用 agent CLI 当后端

| CLI | 非交互 | 图片 | 强制 JSON | 风险 |
|---|---|---|---|---|
| `gemini-cli` | ✅ `-p` / 管道 | 靠 prompt 里 `@file.png`（issue #15532 被 close as not planned） | ❌ `--output-format json` 只包一层元数据，正文仍是自然语言 | **高** |
| `claude` CLI | ✅ `-p` | 未找到明确证据支持传图做纯分类 [待验证] | ❌ 无原生 schema | 中 |
| `codex` CLI | ✅ `codex exec` | ✅ `-i/--image`（本地文件） | ✅ **`--output-schema`** 走 Responses API strict 模式，三家里唯一原生支持。但 issue #15451：MCP/工具激活时可能静默降级为类 YAML 文本 | 中 |
| `opencode` | 未核实 | 未核实 | 未核实 | **高**（正是被点名的第三方 harness） |

**结论：不值得做。**

1. **ToS/账号风险是硬伤**。2026-02 起 Google 已大规模封禁通过第三方 harness（如 OpenClaw）piggyback Gemini CLI OAuth 认证的账号，官方明确「利用第三方工具 harvest 或 piggyback Gemini CLI 的 OAuth 认证访问后端服务，直接违反条款」（[gemini-cli discussion #20632](https://github.com/google-gemini/gemini-cli/discussions/20632)）。Anthropic 明确 OAuth 登录仅限「ordinary, individual usage」，构建产品/服务应用 API Key（[legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance)）。**周期性无人值守跑分类任务的行为特征恰好符合「异常自动化流量」，而被封的账号往往就是日常写代码那个 —— 为省几美元赌这个不划算。**
2. **工程上也不划算**。CLI 为人类交互式编程设计，冷启动开销大，stdout 混杂非结构化信息。
3. **正路是官方免费 API key** —— 那本来就是官方划给开发者调用的额度，无灰色地带。

若确实想用已有订阅，相对安全的替代是 Claude Agent SDK / Codex SDK 的 **API Key 模式**（非 OAuth 订阅登录），但那样费用模型就和普通 API 一样，失去了意义。

## Provider 抽象层

```ts
interface LLMProvider {
  name: string;
  classify(req: ClassifyRequest): Promise<SceneVerdict>;
  healthCheck(): Promise<boolean>;
  isCircuitOpen(): boolean;
}

// 优先级链：Gemini → GLM → Qwen-VL
for (const p of providers) {
  if (p.isCircuitOpen()) continue;          // 连续 429/额度耗尽 → 冷却 10-30 分钟
  try { return await p.classify(req); }
  catch (e) { p.recordFailure(e); continue; }
}
throw new AllProvidersExhaustedError();
```

要点：

- **统一输出 schema** —— 适配器层把各家结果 normalize 成同一结构，业务代码不感知底层模型
- **熔断 + 冷却** —— 别每次都去撞一个已知耗尽的 key
- **多 key 池** —— 同一 provider 下配多个 key（3 个 Gemini 项目 / 3 个百炼账号）轮询，延长免费额度寿命
- **配置热更新** —— 优先级链、key 列表放配置，换模型不改代码

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

