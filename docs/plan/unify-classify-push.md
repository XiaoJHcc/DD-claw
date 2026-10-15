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

收敛为同一个三段式心智：**判定口径（分类）→ 推送规则（分类 × 范围 → 渠道 + 推送词 + 附加动作）→ 范围在主体卡上反向可见**。直播与图文在各自分页管理，同表与组件复用不意味着入口合并。

1. **分类卡（统一）**：分类 = 名称 + LLM 提示词 + 确定性条件组。条件组泛化为**条件算子**：文本子串 / 分区 / 帖子类型（原创·转发·引用）/ 必须带图……同一 UI 组件按内容类型渲染可用算子集。图文的 filters 整体上移进分类，规则不再内嵌筛选。
2. **推送规则卡（统一）**：规则 = 分类引用（空 = 任意内容）× 生效范围 × 渠道 × 推送词 × 附加动作（翻译，仅 X 内容显示）。直播与图文规则字段完全一致。
3. **作用域双向视图、单一数据**：规则弹窗选主体；主体卡（主播卡 / 账号墙）反向展示生效规则，点击进入同一规则编辑器。范围只能在规则编辑器修改，两侧都不提供独立的账号选用勾选。
4. **判定可回看补齐**：图文判定同入 verdicts（身份键通用化），规则行/账号卡可查最近判定。
5. **「错过期间怎么办」统一呈现**：冷启动抑制与 backlog 补推在概念上并为一组恢复策略设置（按内容类型各给默认值），实现仍分属 pipeline / source。

### 产品决策（已拍板 2026-10-10）

- **D1 作用域默认语义 = 空即全部生效**（沿用直播现行，与 gateway 群自助规则模型兼容）。图文规则未指定账号范围 = 对全部账号生效（含未来新增）；UI 需明确「全不选 = 全部」提示。主体详情展示范围覆盖结果，不另设账号选用规则的配置。
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
- **P3 产品层对齐**（初版 c70cc86；2026-10-14 验收纠偏见附录 B）：初版错误地把两类规则混在主播页且缺少图文分类入口，不满足产品验收。纠偏后各页分别提供分类规则与推送规则，共用组件、范围选择与生效规则入口；demo 同步边界校验。不得将图文分类卡视作额外需求。
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
- 三张账号表的 `rule_ids` 列删除（表重建）；账号卡反向显示规则 scope 对本账号的覆盖，点击进入规则编辑器修改。
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
- webui 最小可用适配（能配、能看、不崩；体验精修在 P3）：分类弹窗按 applies_to 渲染算子区；规则弹窗带 subject_kind；账号卡展示生效规则；demo mock 同步。

## 附录 B：产品验收纠偏（2026-10-14）

### 审查结论与修复

| 问题 | 影响 | 修复 |
|---|---|---|
| P3 主播页混排两类分类和推送规则，图文页缺分类卡 | 图文用户必须离开当前页配置判定，直播原有路径也被扰乱 | 两页各有「分类规则」「推送规则」，分别按 appliesTo/subjectKind 投影同表；名称、颜色、行样式、按钮和弹窗共用 |
| 分类弹窗允许随意切换内容类型 | 已引用分类的规则会变成无法命中的配置 | 页面决定新分类的类型，编辑不提供类型切换；能力层拒绝改分类类型、跨类型引用及不适用的条件 |
| 图文账号侧取消勾选可把最后一个账号移出后写出空 scope | 空 scope 实际变成全部生效；勾选全部现有账号还会被改成对未来账号自动生效 | 账号详情与主播详情同为「生效规则」展示入口，范围修改统一进规则编辑器；保留显式所选集合，不折叠为全部 |
| 图文范围内嵌多平台网格，直播范围另开弹窗 | 同一种操作有两套布局、保存习惯 | 图文沿用直播圆柱摘要 → 搜索、头像卡多选弹窗 → 完成 → 保存规则；账号卡附平台角标 |
| 分页过滤后，排序仍要求同表全排列 | 直接提交可见 id 会被真实后端拒绝，宽松 demo 却放行 | 共享 mergeVisibleOrder，仅替换本页的槽位；demo 拒绝不完整、重复或不存在的排序 id |
| 规则编辑器声明二级弹窗却未把 level 传给 openSheet | 详情入口可能覆盖一级弹窗，保存/关闭目标错位 | 补齐 level 传递；主体详情的规则入口统一关闭详情再开一级规则编辑器 |

P0–P2 的核心复用仍成立：ContentItem 投影、条件算子、分类判决链、统一 matchRules、渠道聚合与模板渲染、规则 scope 单一信源，以及能力层的审计/撤销，无需拆回两套规则表。修正的是入口归属和能力边界。

### 无法逐项对应的差异与统一交互

| 差异 | 统一方案 |
|---|---|
| 直播分区 vs 图文帖子类型、引用、带图 | 同一分类编辑器保留名称、LLM 提示词、确定性条件、且/或与保存顺序，仅替换内容对应的条件组；引用明确标注仅 X |
| 直播单平台主播 vs 图文三平台账号 | 同一范围摘要与搜索多选弹窗；图文卡增加平台角标，身份键保留平台前缀。空范围始终表示全部（含未来新增） |
| 图文翻译无直播对应物 | 同一推送编辑器增加「附加动作」可选区，仅图文显示附译文，明确仅 X 帖生效 |
| 直播状态恢复 vs 图文历史帖子补推 | 公共「推送设置」按内容类型分行；图文展开时间窗和条数上限。主动关闭后重开静默的底层语义保持，不能把直播场次套成帖子 backlog |
| 直播场次时间轴 vs 图文最近帖子 | 主体卡与详情都展示自身内容和生效规则；分类判定从内容记录回看。当前直播只归档正判，图文还记录 LLM 负判；负判回看尚不完全对称，后续统一到「分类 + 结论 + 依据」展示，不在此次 UI 修复中改历史归档语义 |
| LLM 标准从旧图文规则上移分类 | 统一口径：有提示词且 LLM 可用时以 LLM 为准，确定性条件只兜底；无提示词始终确定性。旧图文「先 filters 再 judge」与此不同，属于 P2 A.4 既定行为变化，验收时需核对旧分类标准是否完整描述带图/原创等要求 |

验收覆盖：两页归属、新增/编辑/删除、分类联动、范围选择、分页内排序不扰另一页、主体详情规则入口、撤销后重拉、demo 与真实 API 的类型边界、1440/960/640 宽度。

### 2026-10-14 合并审查后补齐

- 旧 MCP `upsert_push_rule.uids` 明确拒绝，要求改用 `scope`，避免未知字段剥离后新规则对全部主播生效。
- 信号编排和 LLM 等待不占通知发送并发槽位；发送并发仍为 4、分析为 2，图片下载全局限流。30 场任意开播与慢分析混合时，归档、推送、下播和健康告警继续处理；同场在飞信号有去重保护。
- 模型结果必须完整覆盖分类且每项唯一，置信度范围限定 0–1；违规结果按既有 provider 降级和确定性回退处理，批量输出额度随分类数扩展。
- WebUI 两形态共用分类与推送记录，独立展示分类结论与实际发送，归档当时的标准和规则快照、provider 失败/回退及通道结果。帖子标签改为属于/不属于。范围、升级与历史数据边界见 [content-audit.md](../content-audit.md)。
