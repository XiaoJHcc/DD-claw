# 分析层（src/analysis/ + src/rules/）

轴 A 的第二段：消费 signal 总线上的变更信号，LLM 只做**内容分类**（判定结果入 verdicts 表），matcher 把人填的推送规则确定性执行成推送目标。`src/rules/` 只剩**机械去重 / 防抖**（每场一次、场景切换去重、冷却），不再有用户可见护栏。总体架构见 `../design.md`，实现现状见 `../status.md`。

## 职责边界（改代码不要破坏）

- **LLM 即任务**：zod schema 进，JSON 出，中间可替换；换模型只动 providers。
- **高峰并发原则**：所有 LLM 调用一律进 `analysis/queue`（信号量限流，并发 2），禁止在轮询循环里直接调。
- **去重 / 防抖归属**：机械去重属于 `src/rules/` 这一层（不是用户偏好过滤），不要塞到 Classifier 之前；用户可见的静音名单 / 静默时段 / 定时推 /「不推」偏好**已放弃**（见 `../design.md` §11）。
- **LLM 不参与偏好解释**：「推给谁、推什么」始终由人填的推送规则决定（matcher 确定性执行）；LLM 可用性不影响偏好链路，分类口径也是人填的（categories 表：LLM 提示词 + 确定性关键词/分区条件）。

## 接口契约

| 接口 | 位置 | 约定 |
|---|---|---|
| `Classifier.classify(ctx)` | `src/analysis/types.ts` | 返回 `Classification[]`（非 live_start 返回 `[]`）；判定结果由实现自行入 verdicts 表。`LiveEvent.classifications` 仅 live_start 由分析队列填充，其余信号恒空，下游必须能处理空数组 |
| `LlmTask<I,O>` | `src/analysis/types.ts` | zod schema 进，JSON 出（类型占位） |
| `DecisionRule.decide(event, signal, classifications)` | `src/rules/types.ts` | 返回 `NotifyDecision`；第三参 `classifications: Classification[]` 可空数组 |

## analysis — 文件清单

### `types.ts`
`Classifier` / `Classification` / `AnalysisContext` / `LlmTask` 类型定义（仅类型）。

### `classifier.ts` — RulesClassifier
每场 live_start 对全部启用分类逐个判定，结果 `insertVerdict` 入库。

- **LLM 优先**：有 `llm_prompt` 的分类，在 router 可用且 LLM 总开关开时合并成一次 LLM 调用，LLM 判定权威——**判否不回看该分类的确定性条件**。
- **回退路径**：LLM 关闭/熔断/调用失败/解析失败时，回退该分类的 `matchCategory` 确定性条件；**无提示词的分类永远走确定性**（verdicts `source='rule'`，confidence 记 NULL）。
- **仅 live_start 烧 LLM**：live_end / title_change 不调分类（pipeline 保证）。
- 对全部监听主播生效（旧 analyze 闸门已随主播三开关删除，streamers 表 analyze/notify 列为遗留、不再消费）。
- 构造注入 `(db, getRouter, llmEnabled)`——router 是 getter、每轮取最新，面板热重建 router 不失效。

### `queue.ts` — 分析队列
包装 `Classifier`，`submit(ctx): Promise<Classification[]>`，信号量限流（并发 2）。预留：同房间触发合并、结果缓存、优先级。

### `providers.ts` — LLM provider 层
OpenAI 兼容直连，无外部网关。

- **路由**：`LlmRouter.completeJson(req, parse?)` 按输入是否含图自动选 text/vision 路由（可显式覆盖），沿路由降级，全挂抛 `AllProvidersExhaustedError`。路由由 provider 名单自动推导（`deriveRoutes`）：名单顺序 = 优先级，text = 全部启用，vision = 启用且多模态。
- **双协议**（`api` 字段）：chat-completions / responses（responses：system→instructions、部件 input_text/input_image、结构化输出走 text.format）。**Anthropic /messages 明确不接**。
- **熔断**：连续失败阈值 + 冷却期跳过；任务层 zod parse 失败同等计入熔断。超时/熔断阈值/冷却由 RuntimeConfig（settings 表）提供，面板「LLM 卡 → 高级」管理，变化时重建 router 热生效。
- **多 key 池轮询**：`needsAuth` 启发式——loopback 端点 = 无鉴权；其余端点无 key = 标「缺 key」跳过，不算配置错误。
- **structuredOutput 三档**：schema / object / none（none 剥 ` ```json ` 围栏兜底）。
- **key 安全**：只进 Authorization 头，绝不进日志/错误信息。
- **settings 唯一信源**：provider 名单 = settings `llm_providers`（`listLlmProviders` / `saveLlmProviders`）；key = settings `llm_key:<providerName>`（逗号分隔多 key，`dbKeysOf`），无 .env 回退。保存后 `router.refreshKeys()` 热更新。
- `router.ping(name)`：面板「测试」按钮用，绕熔断直连，结果计入熔断。
- `createLlmRouter(cfg, keysOf?)`：装配入口，路由内部推导。

### `tasks/classify.ts` — 内容分类任务
一次 live_start 对所有「启用且有 llm_prompt」的分类**合并成一次 LLM 调用**（成本与降级语义最简单）。

- `buildClassifyRequest`：system 指令 + 主播/标题/分区 + 分类清单；`keyframe || cover` 非空时带图走 vision 路由；jsonSchema `{results:[{id,match,confidence,evidence}]}`。
- `parseClassifyResults`：zod 校验 + 过滤 `match && confidence ≥ 0.5`；模型编造的未知分类 id 丢弃；parse 失败由 providers 层计入熔断 → 调用方回退确定性。

### `matcher.ts` — 确定性匹配（零 LLM 依赖）

- `matchCategory(cat, event)` → `{matched, evidence}`：关键词组 vs 标题子串、分区组 vs areaName/parentAreaName 子串；大小写不敏感、**组内任一**、`condMode` and/or 控制**组间**关系、空组忽略、两组皆空不命中；evidence 记录命中词（入 verdicts）。
- `matchPushRules(rules, event, matchedCategoryIds)`：命中 =（categoryId 空 = 任意开播，或 ∈ 判定集合）且（uids 空 = 全部主播，或含 event.uid）。**返回全部命中规则**（保持 sort 顺序），所有命中规则独立生效——调用方对渠道取并集去重（同一渠道只推一次），推送词 = sort 序首个非空 messageTemplate。无命中规则 = 不推送（「任意开播 × 全部主播」规则即兜底）。
- `renderTemplate` 渲染 `{liver}`（原名）/ `{uname}` / `{title}`；推送词链 = 规则覆盖 > 内置默认。

### 目标态待做

| 文件 | 规划职责 |
|---|---|
| `triggers.ts` | **分析触发**：哪些信号送进 LLM——现仅 live_start，目标任意时机按规则（开播 / 新动态 / 直播中抽查 / 定时全量） |
| `context.ts` | 按房间聚合时间窗内多源数据 → 一份 context（喂给分类 prompt） |
| `tasks/schedule-extract.ts` | 从动态/微博解析预告时间 → schedules 表（依赖 triggers 能消费 feed_post） |

## rules — 机械去重（非用户偏好）

| 文件 | 职责 | 状态 |
|---|---|---|
| `types.ts` | `DecisionRule` / `NotifyDecision` 类型 | ✅ 仅类型 |
| `once-per-session.ts` | 每场直播推一次；目标演进：场景切换去重 + 冷却防抖 | ✅ 占位 |

`preference.ts`（静音名单 / 静默时段 / 冷却窗口 / 状态跳变抑制）**已放弃**——推送规则已足够，未来只做**增加式**可选推送时机（见 `../design.md` §11）。

## LLM 选型

调研结论（多模态硬要求、付费 API 主力 + 本地 LM Studio vision 降级位、gpt-5.6-luna 族配 `api: responses`、订阅反代不做）见 `../research/llm.md`。验证接线用 `npm run probe-llm`（列 provider 状态 + text 路由 ping）。
