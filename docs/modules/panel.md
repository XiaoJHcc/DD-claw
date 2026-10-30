# 控制面板与 WebUI 专题

本文件写机制、跨模块时序与配置配方：一次写从点击到热生效的完整路径、撤销与变更历史的语义、写路径清单测试、构建期内嵌与 demo 契约、前端非显而易见的算法。后端长期约束与文件地图见 [src/panel/AGENTS.md](../../src/panel/AGENTS.md)，前端见 [webui/AGENTS.md](../../webui/AGENTS.md)，MCP 运维面见 [../mcp.md](../mcp.md)，分类与推送过程回看见 [../content-audit.md](../content-audit.md)，时间表数据层见 [core.md](core.md)。

## 一次写的完整路径

```
webui (api) → /api/* 路由（挂载门 + 形状映射）
  → runPanelTool → runToolTracked('panel')        // zod 再校验 + 审计
    → UndoStore.track(capture 前像)               // 变更记录的唯一记录点
      → 注册表 handler                             // http-util 校验 + Db 写
    → 差分后像落 undo_changes
  → 响应按路由约定回（201 vs 200、{id} vs {ok:true}）
  → 装配根按受影响表 / settings 键触发热生效
```

- **校验只有一份**：面板路由与 MCP 工具共用 `http-util.ts` 的 `parse*` / `check*`，改一处两个入口同时变。路由层不再重复业务校验，只做挂载门与形状映射。
- **快照与写不同事务**：better-sqlite3 事务不能跨 `await`，而 handler 的异步校验（如微博昵称解析）发生在写之前，故记录点是 `UndoStore.track`（取舍见 `core/undo.ts` 头注）。
- **热生效回调都在装配根**（`index.ts`）：运行参数 → `reconcileRuntime`、监听开关 → `reconcileListen`、provider / key → 重建 router、渠道 → 重建通知通道、登录态 → 热重启对应源。`panel` 层只转发（撤销经 `deps.undoLast`），回调不进 Db / UndoStore。
- **三个入口共用一份记录**：面板手写、MCP、进程内 Agent 的写都进同一个 admin 栈，只有 `entry`（panel / mcp / agent）能分辨来源；gateway 令牌按绑定渠道独立成栈。

## 变更历史与撤销

- **栈式逆序**：只有该栈最新一条未撤销的记录可撤，不做跳序撤销；撤销自身不进快照（否则撤销会变成下一条可撤销记录）。
- **冲突是预期内 UX**：撤销前逐行比对前像 / 后像与当前值，任一行被其他入口改过就整体 409、一行不动。前端把该条标「已被后续变更覆盖」并保留按钮——先撤掉那条更新的记录后，本次比对可能重新成立。服务端契约里没有这个标记，冲突集合是前端本会话状态。
- **展示翻译只有一处信源**：`src/panel/undo-view.ts` 给中文操作名、值感知的一句话、行级带值明细（布尔=开/关并带标记、数组=顿号、数值 settings 键带单位、密钥类无 from/to）、`refill`（撤销需要重填密钥）。webui 不再自维护「工具名 → 中文名」映射。
- **撤销后的热生效**：`undoEffects` 按受影响表与 settings 键做纯分类（runtime / listen / llm / notifiers），装配根据它重放同一套回调——撤销与手改等价。

## 写路径清单（inventory 测试）

机制：测试从 `server.ts` 源码**提取**所有写方法与路径绑定（字面量 `path === '...'` 与 `:param` 的正则绑定两种），按就近原则与路径关联后，与 INVENTORY **全量比对**——任何未分类的写路由都让测试失败。路径绑定解析不出来时测试直接失败（宁可响亮地坏，也不静默漏路由）。

**带副作用的 GET 单列一张表**：扫码 poll 在 confirmed 时会落盘凭据并热重启源，方法上不是写，但按方法过滤会漏掉它，所以与写路由分开登记、同一套理由格式。登记纪律（谁能回滚、谁暴露给 agent）见 [src/panel/AGENTS.md](../../src/panel/AGENTS.md)。

## 构建期内嵌

`scripts/build-webui.mjs` 纯 node fs、零依赖：

1. 读 `webui/**` → 生成 `src/panel/webui-assets.gen.ts`（`WEBUI_ASSETS`：URL 路径 → `{type, body}`，正文走 `JSON.stringify` 转义，绝不进模板字面量）。
2. 把 `webui/demo/defaults.json` 生成 `src/core/onboarding-defaults.gen.ts`（首启默认值的后端消费形）。

要点：内容没变就不写盘（`tsx watch` 盯 `src/`，mtime 变化会白重启 dev 服；dev 脚本另把两个 `.gen.ts` 列进 `--ignore`，内容真变了也不触发重启）；`prebuild` / `predev` / `pretest` / `pretypecheck` 钩子保证每次先于编译现生成；两个生成物都 gitignore，发布工件（dist 只有编译产物）天然与同 commit 后端同版本。

运行时 server 只服这份内存快照：纯 map 查键、无路径拼接，天然无路径穿越，且命中判断排在 `/api/*` 之前。

## demo 模式（`?demo=1`）的三层数据信源

| 层 | 文件 | 说明 |
|---|---|---|
| 真实数据夹具 | `demo/fixtures.json` | `npm run demo:fixtures` 一次性从真实库导出后人工节选维护，已存在须 `--force`；`meta.exportedAt` 是时间冻结点，何时打开 demo 都按导出瞬间渲染；头像 / 关键帧本地化随仓库发布（时间表取色要 canvas 读头像，本地图天然同源） |
| 手工展示案例 | `demo/defaults.json` | LLM / 决策模型 provider、分类、推送规则的**唯一手工信源**；LLM 与规则同时供 onboarding 种入，决策模型只作 demo 展示（不种入） |
| 手写最简态 | `demo/mock-data.js` | 渠道 / NapCat / 高级设置等设置卡片的占位假号、SVG 占位图、时间冻结 |

契约：`demo/mock-api.js`（fetch 拦截器，内存实现整张 `/api/*`，含 PUT/POST/DELETE 与拖拽排序）与 `server.ts` 的 `/api/*` **完全同构**——改路由必须同步改 mock，否则 demo 展示的是旧契约。

## 前端深度机制

**时间表泳道行高解算**：每天按「泳道数 × 级权重」（center = 2、single = 1）参与水装填，把剩余高度分给各天并落成像素 `flex-basis`，下限是每天「道数 × single 16px / center 32px」——低于下限的天钳住下限、余量重分给未钳的天，迭代到收敛；mini 日固定窄条（道 5px + 间距 1px），行间距 20px。连下限都放不下时按步降级：① 去掉首末两天只显示三天 → ② 相邻两天降 mini → ③ 当天也降单行；空间恢复自动升回，全程 px→px 连续过渡（不跳变）。视图隐藏时 `clientHeight = 0`，保持上次降级级别，切回时重排。窗口是居中日 ± 2 天的滑动窗口，切换同时后台预取 ±1 步，命中缓存立即渲染再后台纠偏（内容有变化才重渲）。

**时间表离线灰底与未知下播**：`/api/schedule` 随 `days` 返回 `service.online`（`service_runs` 在线区间）与 `service.trackedFrom`（记录起点）。前端在每行窗口 `[winStart, winEnd)` 内减去在线区间，把服务未运行时段铺成 `.sched-lanes` 的背景灰带（只画到 now；`trackedFrom` 之前不画）。灰带是背景层，场次条与日标签都画在其上：停机期间开播的场次仍从平台给的真实 `live_time` 起画；停机/断轮询导致没观测到下播的场次（`endTs=null` 且 `live=false`）从 `lastLiveTs` 起画 30 分钟散尾，浮窗时间写「开播 – lastLiveTs 之后」，不把停机时刻写成下播时间。

**头像取色**：时间表条色取头像平均色的 h/s，亮度随主题。B站图床无 CORS 会污染 canvas，故经 `/api/avatar` 同源反代（demo 直接用本地化头像）；头像取不到才回落 uid 哈希色，未算出颜色前一律占位灰。

**统一规则组件的跨页协作**：`webui/js/rules.js` 一次拉全（规则 / 分类 / 渠道 / 主播 / 三平台账号）并做在途去重——两个页面的刷新钩子在同一 tick 并发调用也只发一轮请求。规则写 / 删 / 启停成功后广播，宿主（直播规则卡、图文页与账号浮窗）各自重画自己的卡，组件不认识页面。生效范围编辑 = 3D 圆柱摘要（头像按柱面投影排布、只渲染正面可见弧）→ 二级搜索多选弹窗；挑选实时同步一级表单的圆柱卡，点「完成」关窗、保存规则时才落库。

**图文分页单墙混排**：三张名单的自增 id 会撞，所以卡片必须带平台角标；添加浮窗顶部小 segnav 切平台，草稿随切换保留；微博的昵称与 UID 失焦即互查（解析失败静默，保存时后端兜底报错）；「引用（仅 X）」「附译文（仅 X）」是帖子平台事实，规则弹窗恒定显示，运行时只对 X 帖生效。

**规则可达性**：`ruleDeadReason`（`core.js`）是两页规则行与主体详情共用的判定（已停用 / 分类已删除 / 分类已停用 / 分类与内容形态不符 / 未选渠道 / 渠道不可用）；不可达 = 整行置灰划线 + 副行只留原因，勾选状态不动，恢复引用对象自动复原。

**统一模型在页面上的投影**：分类与推送规则的统一模型（`applies_to` / `subject_kind` / `scope` / `llm_translate`）及其页面投影规则见 [webui/AGENTS.md](../../webui/AGENTS.md)。旧图文规则表与账号侧「选用规则」列已并入该模型，对应旧端点不再存在——接口是否存在以 `server.ts` 与写路径清单测试为准。

**分类草稿测试区**：直播与图文分类浮窗共用当前草稿请求体，保存与试判不会读出口径不同的表单。边框式测试区默认折叠，展开后常驻主体 / 起止时间筛选和 1–20 数量拉条。抽样只读带图归档并填充表格，刷新重新随机；测试把当前 `subjectId` 列表回传，按原顺序精确复测同一批样本，不重新随机。表格首列展示缩略图与内容，三档以图标和直接展开的理由对照；筛选变化作废旧工作区，弹窗关闭或新请求发起后通过代际序号阻止晚到响应回写。demo 也从 fixtures 抽样并实现同一请求 / 响应契约。

**时间表 hover 的两条时间轴**：弹层的缩略图与分类区都按鼠标在条内的横向位置取时间点。图走 60 秒分桶（桶变才换，鼠标静止不换）；分类取该场 `classificationRuns` 里最后一个 `ts ≤ 该时间` 的轮次——第一轮判定之前显示未分类，跨过一轮的边界即时重画分类区（不必重新 mouseover），只有该场完全没有历史（旧场次）才回退最新的 `verdicts` / `primary`。

**分类时机 sheet**：直播分类卡的操作行带「分类时机」入口（图文分类卡没有），五个时机各一行三列勾选圆圈 + 冷却 / 延迟 / 定时三条分钟口径（同排三等分；延迟与定时的行名随输入实时改写）。保存直接走 `/api/advanced`（运行时参数，撤销与热生效自动生效）。前端只做渲染与提交，默认值与取值范围在 `core/runtime-config.ts` 的规格表里。

## 配置配方

**改或加一条 `/api/*`**

1. `server.ts`：先定挂载门（哪个 dep 在 = 挂）；写走 `runPanelTool` / `callTool`（形状与状态码映射在这层），只读 GET 直接 `sendJson` 或经只读工具（如 `get_content_audit`）。
2. 校验放 `http-util.ts` 或注册表 handler —— MCP 侧同时受益，不要写在路由里。
3. webui 消费（`api()`）；同步 `webui/demo/mock-api.js`。
4. 写路由与带副作用 GET 的覆盖登记按 [src/panel/AGENTS.md](../../src/panel/AGENTS.md) 的清单纪律执行。
5. 文档只更新不变量，不抄路由表。

**加一个运行时参数**

`core/runtime-config.ts`：`RuntimeConfig` 加字段 + `NUM_SPECS` / `BOOL_SPECS` 加一行（中文标签与取值范围在这，`/api/advanced` 校验复用同一张表）；消费方一律经 `withRuntimeConfig` 取生效值。面板入口要手工加：对应卡片的设置 sheet 出一行字段并放进 PUT payload（前端无自动生成）。撤销热生效自动覆盖（`isRuntimeConfigKey`）。

**扫码登录（B站 / 微博）**

两个平台同构：POST 生成二维码 → 前端轮询 GET；B站的 `key` 由客户端带回，微博把 qrid 存在服务端单槽（单人面板无需多会话）。`confirmed` 后落盘凭据 → `onCookiesSaved` 热重启对应源（B站再查一次 nav 补 mid，失败只记日志，下轮心跳会补）；cookie 值不进响应与日志。

**NapCat 卡片的能力门**

`configReady`（`<dir>/config` 存在 = NapCat 自己至少跑通过一次）是硬门：false 时前端禁用「失活自动拉起」并把原因写进副行，不承诺做不到的事。保存是 settings 唯一信源（空串 = 清空该字段，无 config 回落）；`autorestart` 开 = 建拉起任务（失败 400 不落开关）、关 = 移除任务、开着时改 dir / uin 按新配置重建任务。
