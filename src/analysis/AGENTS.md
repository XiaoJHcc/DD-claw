# analysis — 内容判定、LLM 通道、规则匹配

轴 A 的第二段：把一次内容（直播场次 / 图文帖）判成「属于哪些分类」，再由 `analysis/matcher.ts` 用**人填的推送规则**做纯确定性匹配。判定结果入 `core` 的 `verdicts` 与 `content_audit`。机械去重（每场一次 / 防抖）不在这里，见 [../rules/AGENTS.md](../rules/AGENTS.md)。

架构与产品口径见 [docs/design.md](../../docs/design.md)；实现现状与验收结论只查 [docs/status.md](../../docs/status.md)。机制细节、输入面语义与排障见 [docs/modules/analysis.md](../../docs/modules/analysis.md)。决策模型协议选型、分期与判定合同见 [docs/plan/decision-model.md](../../docs/plan/decision-model.md)，外部证据见 [docs/research/decision-models.md](../../docs/research/decision-models.md)。

## 长期不变量

- **LLM 即任务**：zod schema 进、JSON 出，任务层只描述 prompt 与解析；换模型只动 `providers.ts`。
- **内容判定与生成任务一律过 `queue.ts`**（`submit` 与 `run` 共用同一条并发闸门）：轮询循环与推送链路不得直调 provider。例外只有两类显式路径：面板 / CLI 的诊断 `ping`，以及 agent 对话回路（那是交互，不是后台内容分析）。
- **分工固定**：LLM 只做**内容分类**（「这是什么内容」），不做偏好解释。「推给谁、推什么」永远由人填的 `push_rules` 决定；分类口径（提示词 + 确定性条件组）也是人填的。
- **判定语义**：无 `llmPrompt` 的分类永远只走确定性条件；有 `llmPrompt` 的分类走判决链（确定性先跑 → 模型档按序：决策模型 → LLM）。每档只收到仍未定案的分类，**每档跑出的结论全部落库**、生效结论由 `effective` 标出；模型档定案即权威，**判否不回看该分类的确定性条件**，模型档都不可用时由确定性定案。决策档的灰区、以及「带图内容只被纯文本供应商回答」的结论照常落库但不定案。
- **归档口径两形态统一**：判否也落 `pass=0`（「为什么没推」可回看），直播与图文同一口径；无任何有效条件组的分类不落确定性行（除非它成为生效结论）。`classify()` 对外只返回「生效且属于」。
- **主分类是第二判定**：与是非结论互不约束，只回答「最像主分类组里的哪一个」（`primary_verdicts`，`category_id=0` 表示「其他」）；模型档定案优先，否则按分类排序取组内第一个「生效且属于」。推送只看是非结论。
- **匹配是纯确定性零 LLM**：命中 = 内容形态一致 ∧（分类引用为空 ∨ 命中该分类）∧（scope 为空 ∨ 含主体）；**全部命中规则独立生效**——渠道取并集去重、推送词取首个非空，无命中 = 不推（「任意内容 × 全部主体」规则就是兜底）。
- **条件组语义统一**：空组忽略、`condMode` 只管组间关系、无有效组不命中；算子按内容类型适用（keyword / area 属 live，keyword / postType / quote / media 属 post），不适用的算子一律按未命中。
- **key 安全**：LLM key 与决策模型 key 只进 `Authorization` 头，绝不进日志或错误文本。
- **结构化输出失败 = provider 本次不可靠**：parse 失败与端点挂掉同等计熔断并降级；任务层不得「猜一半结果」——批量判定必须逐项完整、id 唯一，否则整体判失败触发回退。
- **点名 provider 不降级**：主人显式指定的模型不存在 / 未就绪 / 失败一律报错，绝不静默换人。
- **生成类任务绝不挡推送**：翻译是规则层附加动作，LLM 不可用或失败就不附译文，正文照发。
- **视觉输入先规范化**：图床 URL 不进任何模型；图片先由 pipeline 落本地，再经 `image-prep.ts` 按字节内容解码、动图取首帧、EXIF 摆正、统一转基线 JPEG 并把边长收进 280–1568；处理不了的图在本地拦下并逐张记原因，绝不让一张坏图把整单请求炸成 HTTP 400。LLM 与决策模型吃同一份产出。
- **决策模型接入后必须与 LLM 通道隔离**：独立 key 池、独立熔断、独立计费，互不占额度、互不触发。

## 文件地图

- `types.ts` — `Classifier` / `Classification`（含 `source` llm·rule·decision、`pass`、`effective`）/ `AnalysisContext`（live 与 post 两个入口）/ `PostAnalysisInput` / `LlmTask`。
- `content.ts` — `ContentItem` 统一投影：直播场次与图文帖的同构输入面（身份键、作者、正文、tags、视觉输入、链接、时间），判决链与 prompt 构造只吃它。
- `classifier.ts` — `RulesClassifier` + **判决链**：`JudgeStage` / `JudgeRequest` / `JudgeOutcome` 接口、档位顺序表 `JUDGE_STAGES`（`decisionJudge` → `llmJudge`）与确定性预跑；按内容类型取启用分类，逐档结论入 `verdicts` / `primary_verdicts` 与 `content_audit`（含 `stageNotes`：某档被跳过 / 失败的原因）。
- `image-prep.ts` — 送模型图片的规范化（`sharp`）：`prepareImage` / `prepareImageFiles` 产出合规 JPEG data URL 与被拦图片原因（`PreparedImages`），纯本地、不做网络。
- `queue.ts` — 分析队列：并发 2 的信号量与通用 `run()` 入口（图文翻译等非分类任务同走这条路）。
- `endpoint.ts` — provider 端点拼装（LLM 与决策模型共用）：Base URL 的末尾斜杠 / 版本段 / 误贴整条端点三种写法归一，版本段缺省按协议表补默认 `v1`。
- `providers.ts` — LLM provider 层与 `LlmRouter`：路由推导、双协议、结构化输出三档、可重试失败就地重试、熔断、多 key 池、point-named 严格路由、工具对话与 JSON 模拟降级；`createLlmRouter` 装配入口与 settings 读写 helper。
- `decision-providers.ts` — 决策模型 provider 层：System One（`state + questions + assets` → typed answers）线格式、协议分派、最小探活、settings 名单 / 独立 key 前缀 / 总开关。
- `decision-router.ts` — 决策路由：候选顺序（含图时 vision 优先）、未就绪跳过、失败换下一个、可重试失败就地重试、连续失败熔断、key 池轮换、`DecisionUnavailableError`；`createDecisionRouter` 装配入口。与 `LlmRouter` 不共享任何运行时状态。
- `tasks/classify.ts` — 单次批量分类任务：直播与图文各自的 system / user 文本、JSON schema（结论 + 主分类）、结果解析（完整性、id 唯一、主分类 id 必须在选项集内或 0「其他」）。
- `tasks/decide.ts` — 决策判定任务：`buildDecisionRequest`（state / `noul` 问句 / 主分类 `choice` / 图片 assets）与 `parseDecisionResponse`（概率 → 定案集合、灰区、主分类分布）。
- `tasks/post-analysis.ts` — 图文翻译任务（只产出译文）。
- `post-analyzer.ts` — 翻译编排与降级（LLM 不可用 / 失败 → 不附译文）。
- `matcher.ts` — 纯确定性匹配：条件算子注册表（keyword / area / postType / quote / media）、`matchCategoryItem` / `matchCategory`（结论带 `hasConditions`，编排据此决定确定性行是否落库）、两形态统一的 `matchRules`、`aggregateRuleHits`、模板渲染（`{liver}` / `{uname}` / `{title}` 与帖子变量）。

未落地能力（分析触发、多源上下文聚合、预告解析）的文件规划见 [docs/status.md](../../docs/status.md)。
