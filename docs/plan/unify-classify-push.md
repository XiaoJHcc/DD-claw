# 计划：直播/图文「分类 + 推送」统一

基准日 2026-10-10。承载分支：**dev**（main 留给验证过的正式版本；dev 已合并 mcp-interface 的轴 B 全量落地，统一任务在其上开展，合适时机再并回 main）。

## 〇、为什么统一

直播推送与图文推送是「同一判定心智的两套实现」：

| 维度 | 直播 | 图文 |
|---|---|---|
| 判定层 | 独立 categories 表（LLM 提示词 + 关键词/分区确定性条件），判定入 verdicts 可回看 | 无分类层，filters + judgePrompt 内嵌在每条 post_rules 里，判定不留痕 |
| LLM 调用 | 一次批量调用覆盖全部 prompt 分类 | 每条命中规则一次调用（同配置 memo 合并） |
| 作用域 | 规则侧 `push_rules.uids`（空 = 全部主播） | 账号侧 `*_accounts.rule_ids`（空 = 一律不推） |
| 删除语义 | 删分类 → 引用规则级联停用（可恢复） | 删规则 → 账号 ruleIds 直接清扫（不可恢复） |
| 机械去重 | OncePerSessionRule + markNotified 落库 | posts 表 UNIQUE(platform,item_id) 兜底 |
| 恢复策略 | 冷启动三类抑制（pipeline 侧） | resume/gap/normal 轮次 + backlog 封顶（source 侧） |

另有前瞻性动因：**决策模型通道**（调研见 `docs/research/decision-models.md`）只吃「人填的分类口径」且只覆盖枚举类判断——图文判定口径若继续内嵌在规则里，决策模型够不着图文。统一后决策模型只需接进一个分类器。

## 一、产品模型（目标态）

收敛为同一个三段式心智：**判定口径（分类）→ 推送规则（分类 × 范围 → 渠道 + 推送词 + 附加动作）→ 范围在主体卡上反向可见可改**。

1. **分类卡（统一）**：分类 = 名称 + LLM 提示词 + 确定性条件组。条件组泛化为**条件算子**：文本子串 / 分区 / 帖子类型（原创·转发·引用）/ 必须带图……同一 UI 组件按内容类型渲染可用算子集。图文的 filters 整体上移进分类，规则不再内嵌筛选。
2. **推送规则卡（统一）**：规则 = 分类引用（空 = 任意内容）× 生效范围 × 渠道 × 推送词 × 附加动作（翻译，仅 X 内容显示）。直播与图文规则字段完全一致。
3. **作用域双向视图、单一数据**：规则弹窗选主体；主体卡（主播卡 / 账号墙）反向展示并可勾选。两种操作习惯保留，写同一份数据。
4. **判定可回看补齐**：图文判定同入 verdicts（身份键通用化），规则行/账号卡可查最近判定。
5. **「错过期间怎么办」统一呈现**：冷启动抑制与 backlog 补推在概念上并为一组恢复策略设置（按内容类型各给默认值），实现仍分属 pipeline / source。

### 产品决策（已拍板 2026-10-10）

- **D1 作用域默认语义 = 空即全部生效**（沿用直播现行，与 gateway 群自助规则模型兼容）。图文侧行为变更：账号不勾规则 = 继承全部规则；UI 需明确「全不选 = 全部」提示。
- **D2 图文规则一次性搬家**：一条 post_rule → 自动生成一条分类（filters/judgePrompt 上移）+ 一条引用该分类的规则；参照 `migratePostRuleScopes` 先例，启动期内部迁移、不进撤销栈。
- **D3 翻译留在规则层**：作为规则的附加动作字段，仅 X 内容生效；翻译是输出物不是判定口径，决策模型不覆盖生成任务，不上移到分类。

## 二、底层抽象

**抽（当前的不恰当耦合）**：

1. **ContentItem 内容项抽象**：`{ subjectType: 'live'|'post', subjectId, uid/accountId, text, tags, pics, url, ts }`——直播场次与图文帖都投影成它；分类判定与 LLM/决策模型 prompt 构造只吃它。**输入必须带图**（直播封面/关键帧、图文配图 data URL），决策模型的识图默认要求在设计时钉入。
2. **条件算子注册表**：`matchCategory` 的关键词/分区与图文 filters 都是「条件组 + 且/或」，泛化为按内容类型注册的算子集，替代两个写死的 matcher。
3. **verdicts 身份键通用化**：`(room_id, live_time)` → `(subject_type, subject_id)`；图文判定归档解锁。`source` 枚举预留 `'decision'`。
4. **判决链接口**：分类器从「LLM 优先 + 确定性回退」两级改为可插拔链：**确定性 → 决策模型（过阈值）→ LLM 兜底**（级联方向按调研反转）。决策模型档位本期只留接口，不实现。
5. **聚合与模板收敛**：`buildMessage`（pipeline.ts）与 feed_post 分支后半段逐行平行（命中 → 渠道并集去重 → 首个非空模板 → 空并集不推），抽为一个函数；`renderTemplate` / `renderPostTemplate` 统一为按内容类型提供变量集的单一渲染器。
6. **「推送是否等待判定」规则级化**：现状 `pipeline.ts` 在 live_start 上 `await queue.submit`，开播推送实际排在 LLM 后面——与「通知不等分析结果」原则不符。空分类引用的规则应可立即推，引用分类的规则才等判定。

**不抽（本质差异，保持各自实现）**：

- 抓取/归档/去重/恢复策略：直播是状态型信号（diffRoom、场次身份、冷启动抑制），图文是事件型信号（UNIQUE 去重、backlog 窗口），不应强扭。
- 翻译：留 LLM 通道（`post-analysis` 任务），仅 X 平台门控。
- 平台文案与图片链路差异（X 图走代理隧道等），维持现状的薄处理。

## 三、与轴 B 的关系（撤销/注册表体系接点）

统一任务构建在 mcp-interface 已落地的地基上，有三个硬性接点必须随表结构变更同步维护，否则撤销与变更历史会静默失灵：

- **写路径生在撤销引擎里**：统一后的规则/分类写工具一律经 `runToolTracked` 进注册表（快照/审计/撤销自动获得），不先写裸 REST 再迁移。级联停用、ruleIds 清扫这类多步写天然落在同一快照事务里，撤销可整体回滚。
- **`undo.ts` 忽略列清单 + `undo-view.ts` 中文名映射随表迁移更新**：表合并/改名/搬列时，`DEFAULT_IGNORE_COLUMNS`（轮询回写列不参与差分）与 undo-view 的「settings 键 + 表 → 中文操作名」唯一信源必须同步登记新表新列；漏登记的表现是变更历史出现乱码条目或撤销误还原轮询游标。
- **write-path-inventory 互锁测试会强制登记**：新写工具若漏进注册表或漏配 `AGENT_EXCLUDED_TOOLS`，`write-path-inventory.test.ts` 直接红——这是防分裂的机械保障，不要绕过。
- **一次性数据搬家不进撤销栈**：P2 的迁移（D2）是启动期内部行为（参照 `migratePostRuleScopes`），不走 `track`，不产生变更历史条目。
- 注册表是唯一能力信源：统一后的规则模型在 `tools.ts` 定义一套工具，webui / MCP / Agent / QQ 四端同构；gateway 群自助规则已跑在「规则侧作用域」模型上，D1 选「空 = 全部」与之天然兼容。

## 四、分期

- **P0 零风险抽取**（已落地 c1e3213）：聚合函数 + 模板渲染统一；`source` 枚举加 `'decision'` 占位。不改任何行为。
- **P1 verdicts 通用化**（已落地 12e1227 + 5cfe7c2）：身份键迁移 + 图文判定归档 + 面板判定回看入口（账号卡帖子标记）。
- **P2 模型合并**（已落地 611671e + 857a296）：ContentItem + 算子注册表 + 判决链接口；categories/push_rules/post_rules 三表合并为目标模型 + 一次性数据搬家（D2）；pipeline 两分支后半段合流；「推送等不等判定」规则级化。
- **P3 产品层对齐**（已落地 c70cc86）：规则卡/分类弹窗统一组件；作用域双向视图（空 scope 语义两形态明示）；恢复策略合并呈现；判定回看改分类名口径；`webui/demo/mock-api.js` 同构；两宽度目检通过。遗留：分类卡仍只在主播页（图文页是否加卡属新增需求，未定）。
- **P4 决策模型通道（影子模式）**：DecisionProvider（System One 契约）只打标不拍板，按置信度分带与现有路径比对；标定后再接入判决链中间档。**计费/限流/熔断与 LLM 通道分离**（复用 `providers.ts` 骨架但独立档位，调研明确要求）；置信度阈值按动作标定（`verdicts.confidence` 已能承接）；criteria 从人填条件映射，分类增删改时问题集随判决链重建，无需额外同步面。实施前逐条过调研文档的复核清单（品类 2026-09 才诞生，价格/schema/License 都可能已变）。

每期验收：`npm run typecheck && npm test && npm run build` 全绿 + `--dry-run` / `--force-uid` 全链路手动验证；P3 另需 `?demo=1` mock 目检两页。

## 五、明确不做
- 不改抓取层三源结构与故障两级语义；不动 backlog 权威定义（`src/core/backlog.ts`）。
- 不做 NL→结构化编译；分类口径始终人填（决策模型的 criteria 也从人填条件映射）。
- 不引入静音名单 / 静默时段 / 定时推 /「不推」偏好（`docs/design.md` §11 既定）。
- 翻译、schedule-extract 等生成类任务不接决策模型。

## 附录 A：P2 目标模型详规（2026-10-10 拍板后定稿）

### A.1 categories 表扩展（吸收 post_rules.filters / judgePrompt）

新增列（`ensureColumn` 在线补列即可，无需重建）：

| 列 | 类型 | 语义 |
|---|---|---|
| `applies_to` | TEXT NOT NULL DEFAULT `'live'`，CHECK IN ('live','post') | 分类服务的内容类型（UI 按此渲染可用算子） |
| `post_types` | TEXT NOT NULL DEFAULT `'[]'` | JSON：`'original'/'retweet'` 子集，空 = 不限（对应旧 filters.original/retweet 的勾选集合） |
| `require_quote` | INTEGER NOT NULL DEFAULT 0 | 必须是引用帖（仅 X 免登录回退路线产出 isQuote，其余平台永不命中——沿用旧 quote 语义） |
| `require_media` | INTEGER NOT NULL DEFAULT 0 | 必须带图 |

- 条件组泛化：keywords（通用）/ areas（仅 live）/ post_types / require_quote / require_media 各为一组，组间关系仍由 `cond_mode`（且/或）统辖；两组皆空 = 不命中的口径扩展为「所有非 LLM 条件组皆空且 llm_prompt 为空 = 死分类」（`checkCategoryConditions` 同步扩展）。
- 算子注册表补 `postType` / `quote` / `media` 三个算子（appliesTo: ['post']）；keyword 算子对 post 判定 text。

### A.2 push_rules 表扩展（统一规则，post_rules 退役）

- 新增 `subject_kind` TEXT NOT NULL DEFAULT `'live'` CHECK IN ('live','post')；新增 `llm_translate` INTEGER NOT NULL DEFAULT 0（D3：规则层附加动作，仅 X 内容运行时生效）。
- `uids` 列更名泛化为 `scope`：live = 主播 uid 列表；post = 账号引用列表（`'twitter:screenName'/'weibo:uid'/'bili:uid'`）。**空 = 全部生效**（D1，两形态统一）。uids → scope 随表重建搬迁。
- 三张账号表的 `rule_ids` 列删除（表重建）；账号勾选视图（P3）改写规则 scope——同一份数据的双向入口。
- 删分类级联停用引用规则的语义两形态统一沿用；删规则不再有账号侧清扫（无 rule_ids）。

### A.3 post_rules 一次性搬家（migratePostRulesToCategories，不进撤销栈）

每条 post_rule（含停用）→ 一条分类 + 一条规则：

- 分类：applies_to='post'；name=规则名；llm_prompt =（llmJudge 且 judgePrompt 非空）? judgePrompt : null；keywords=filters.keywords；post_types 由 filters.original/retweet 勾选集合映射；require_quote=filters.quote；require_media=filters.media；enabled/sort 随规则。
- 规则：subject_kind='post'；category_id=新分类 id；scope=三账号表 rule_ids 反查出的选用账号引用列表；channels/message_template 原样；llm_translate=llmTranslate；sort 接现有全局序追加。
- **行为保持闸**：原语义「账号 rule_ids 空 = 该账号不推」，若一条 post_rule 没有任何账号选用 → 原语义下永不生效；搬家后 scope 空按新语义 = 全部生效会翻转行为——故**无账号选用的规则一律 enabled=0 落地**并在迁移日志注明。
- 幂等：post_rules 表不存在即跳过；搬完 DROP TABLE post_rules。
- 遗留列 `platform`/`account_ids` 随表删除一并消失。

### A.4 判定与匹配语义（P2 行为变化点）

- **图文判定分类制**：feed_post 与 live_start 同走判决链（ContentItem 投影已在 P2a 就位），对 applies_to 匹配内容类型的启用分类判定；verdicts 落真实 categoryId（ruleId 回 0 哨兵）。post 侧 LLM 判否也落 pass=0（「为什么没推」可回看；直播侧保持只记「属于」）。
- **匹配统一**：`matchRules(rules, item, matchedCategoryIds, subjectRef)`——命中 = (categoryId 空 ∨ ∈ 匹配集) ∧ (scope 空 ∨ 含 subjectRef)；live 的 subjectRef=uid，post 的 subjectRef=`platform:key`。matchPushRules/matchPostRules 退役或改薄封装。
- **翻译**：post-analyzer 的 llmJudge/judgePrompt 路径退役，只留翻译（命中规则聚合后，任一 llm_translate=1 且平台支持时调一次生成）。
- **推送等不等判定规则级化**：仅当「存在引用了分类的启用规则且其 scope 覆盖本内容」时才 await 分类；纯「任意内容」规则的推送不再排在 LLM 后面。按场/按帖单次判定，不产生双推。

### A.5 轴 B 接点（P2 内同步完成）

- 工具注册表：upsert_category 带 applies_to + post 条件；upsert_push_rule 带 subject_kind/scope/llm_translate；upsert_post_rule/list_post_rules/delete_post_rule 退役；账号工具的 ruleIds 入参退役。write-path-inventory 互锁随之更新。
- undo-view 中文名映射登记新列（scope/llm_translate/applies_to/…）与表变更；undo.ts 忽略列清单核对（rule_ids 消失）。
- webui 最小可用适配（能配、能看、不崩；体验精修在 P3）：分类弹窗按 applies_to 渲染算子区；规则弹窗带 subject_kind；账号卡「选用规则」勾选改写规则 scope；demo mock 同步。
