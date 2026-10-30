# webui — 控制面板前端（唯一信源）

真实 HTML/CSS/ESM，无前端框架；`scripts/build-webui.mjs` 在构建期把它内嵌进 `src/panel/webui-assets.gen.ts`。后端契约与路由纪律见 [../src/panel/AGENTS.md](../src/panel/AGENTS.md)，内嵌构建、demo 三层信源、时间表解算等机制见 [../docs/modules/panel.md](../docs/modules/panel.md)。

## 长期不变量

- **UI 只在这里改**；运行时页面 = 构建期内嵌的内存快照，**绝不读磁盘静态文件**。改完 `npm run build` 才接线后端，日常用 `npm run webui:dev`。
- **demo 与真实后端同构**：`?demo=1` 时 `boot.js` 先装 `demo/mock-api.js` 的 fetch 拦截器再进 app；它是整张 `/api/*` 的内存实现——**改 `/api/*` 必须同步改 mock-api.js**，否则 demo 与真实分叉。
- **手工展示数据只进货架指定的那一层**：`demo/defaults.json` = LLM / 决策模型 provider、分类、规则等展示案例（LLM 与规则同时是首启默认值的源，决策模型只作 demo 展示、不种入）；`demo/fixtures.json` = 真实库节选（带 `meta.exportedAt`，demo 把时间冻结在导出瞬间）；`demo/mock-data.js` = 设置卡片占位与 SVG 占位图。不要把手工数据散落到 mock 代码或 JS 模块里。
- **分类与推送是同一模型的两套规则，各页只投影自身内容类型**：主播页只有直播类型、图文页只有图文类型；新增类型由页面决定，编辑分类不可换类型（`appliesTo`）——能力层也拒绝跨类型引用与不适用条件。
- **生效范围只有一种交互**：圆柱摘要 → 二级搜索多选 → 保存（`rules.js`），不做逗号串输入。
- **主体详情只展示生效规则并可跳进规则编辑器**，不提供反向勾选；范围只在规则侧改，避免两处都是「真相」。
- **空范围一律读作「全部生效（含未来新增主体）」**：文案与摘要都用「全部主播 / 全部账号」，不要另造「默认」说法。
- **分页排序合并回全排列**：列表只持有本类型子集，拖拽结果用 `mergeVisibleOrder` 写回，另一类的槽位保持不动。
- **简称 alias 只在空间受限处优先**（规则行主体标签、时间表横条），其余一律原名 `uname`。
- **设置视图 = 公共设置四卡 + 变更历史卡**：NapCat / LLM 供应商 / 决策模型 / 推送渠道各带操作行；LLM 与推送卡带总开关，决策模型卡带总开关（决策档判定）与「高级」（灰区上下界 / 主分类门槛 / 请求超时 / 熔断）；运行时参数收进对应卡按钮的 sheet（「高级」「推送设置」，抓取的「抓取设置」在主播页监听卡，直播分类的「分类时机」在主播页分类规则卡），`settings` 是唯一信源、保存即热生效；视图底部固定一张变更历史卡（只可撤销最近一次）。
- **卫生**：不在 UI 上写解释性文字（按钮与字段自解释），不添加未指明的 UI 内容；间距 / 圆角 / 控件高度走 `style.css` 的既有档位，不写一次性魔数。
- **事件与转义**：动态值一律过 `esc()`（模板字符串拼接是常规写法）；事件走 `ACTIONS` / `CHANGES` / `INPUTS` 三张委托表，不内联 `on*`；卡片模块靠 import 副作用注册动作。
- **弹窗只显式关闭**：点击遮罩空白不关闭任何 sheet（含设置 / 分类 / 规则 / 推送表单），避免误触丢草稿；关闭只经右上角 × 或「取消 / 完成」等显式按钮。

## 文件地图

- `index.html` — 壳：左边栏（logo + 五视图导航 + 在播计数）+ 五个视图容器（时间表 / 主播 / 图文 / 设置 / Agent）。
- `style.css` — 设计系统：间距档位、圆角三级、控件恒 36 高、按钮四语义色；浅色单主题。
- `js/boot.js` — 入口：`?demo=1` 先装 mock 拦截器，再 `import` app。
- `js/app.js` — 视图切换（隐藏视图后台轮询照跑）、卡片模块装配、`#view` 直达与 `?open=` 设计走查钩子。
- `js/core.js` — 共享件：`esc` / `api` / `toast` / sheet 栈（主卡 + 可选同宽副卡）/ switch 与 checkbox / `makeSortable` / 三张事件委托表 / `mergeVisibleOrder` / `ruleDeadReason` / segnav / `dropdownHtml` / `avatarHtml` / 时间与时长格式化。
- `js/icons.js` + `js/lucide-icons.js` — 本地节选的 lucide 节点数据出图标（离线可用）。
- `js/qr-lib.js` — B站扫码弹窗用的 qrcode-generator。
- `js/rules.js` — 直播 / 图文共用的统一规则组件：行渲染、规则弹窗、生效范围圆柱卡 + 二级搜索多选、跨页刷新广播、摘要与可达性文案。
- `js/x.js` — 图文分页：三张来源卡 + 图文规则卡 + 单墙混排账号卡墙（平台角标、添加浮窗按平台切草稿、微博昵称↔UID 失焦互查）。
- `js/categories.js` — 两页的分类卡与分类弹窗（按 `appliesTo` 渲染；简单描述 / 精确原子条件双模式，两套数据保留、启用模式互斥；确定性条件组按内容形态切换）。直播分类卡的操作行另有「分类时机」sheet：五个时机 × 规则 / 决策 / LLM 三列勾选圆圈 + 冷却 / 延迟 / 定时三条分钟口径（同排三等分；延迟与定时的行名随输入实时更新），保存经 `/api/advanced`（运行时参数，热生效）。
- `js/category-test.js` — 包裹分类主卡的浅灰测试副卡（外卡承担整体投影）：常驻筛选 + 1–20 拉条 + 带图样本无边框表格；刷新抽样后对同一批 `subjectId` 复测，图标判定与单行关键证据，悬停 / 聚焦打开自定义证据浮窗，异步代际清理。
- `js/push.js` — 推送渠道卡 + 直播规则卡（规则部分委托 rules.js）+ 推送设置 sheet。
- `js/streamers.js` — 主播卡网格（三段式）与详情弹窗（字段编辑 + 生效规则纯展示）；导出 `loadStreamers` 供跨卡刷新。
- `js/follows.js` — 关注列表候选池（加入监听）。
- `js/schedule.js` — 时间表（5 天滑动窗口、行高解算、预取、服务离线灰底、hover 关键帧与按时间点取分类历史）。
- `js/listen.js` — B站登录行与抓取设置 sheet；导出扫码登录弹窗供图文页复用。
- `js/llm.js` / `js/napcat.js` — LLM provider 与 key 卡 / NapCat 通道与自动拉起卡。
- `js/decision.js` — 决策模型供应商卡（总开关 + System One 名单管理的管理面：启停、协议表单、`vision` 标记、探活与排序 + 「高级」sheet；与 LLM 完全隔离）。
- `js/undo.js` — 设置页底部的变更历史卡（栈顶撤销 + 冲突标注）。
- `js/content-audit.js` — 单份内容的判定与推送回看弹窗。
- `js/agent.js` + `js/markdown.js` — Agent 视图（会话、写模式与模型选择、工具行）与零依赖 markdown 渲染（先 `esc`，链接只认 http/https）。
- `demo/` — `mock-api.js` 拦截器 / `mock-data.js` 占位 / `defaults.json` / `fixtures.json` / `avatars` / `keyframes`。
