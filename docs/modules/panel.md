# 控制面板与 WebUI

本机控制面板（localhost WebUI）：`src/panel/` 提供同进程 HTTP 服务与 REST API，`webui/` 是前端唯一信源，构建期内嵌进产物、运行时绝不读磁盘。Agent 接口 `/mcp` 挂在同一端口，见 [../mcp.md](../mcp.md)；时间表数据层（live_sessions / listTimeline）见 [core.md](core.md)。

## src/panel/server.ts

`createPanelServer({ db, status, weiboResolver?, auth?, weiboAuth?, listen?, napcat? })`：同进程 node:http，零框架零依赖，**只绑 127.0.0.1**（默认端口 8787，config panel 段仅作自举）。多数 API 组按 dep 存在与否条件挂载（无 dep = 不挂该组路由）。

**静态资产**：`GET` 且 `WEBUI_ASSETS[path]` 命中 → 200 + 对应 content-type + `cache-control: no-store`。构建期内嵌快照，运行时绝不读磁盘；纯 map 查键、无路径拼接，天然无路径穿越。判断在 /api/* 之前，未命中自然落 API/404。

### 路由表

| 方法 + 路径 | 职责 / 校验要点 |
|---|---|
| GET /api/status | 运行状态（platforms / liveCount） |
| GET /api/streamers | 名单 enrich：face + live 实况 + 生效规则名数组 + 最近 5 条动态摘要（raw 不下发；一次请求每表各查一次） |
| PUT /api/streamers/:uid | 可写键 alias/watch/weiboNick/profileNote（analyze/notify 为遗留列，面板不提交）；weiboNick 与现值不同才走 resolver 解析（找不到/网络错误 400，传空两字段一起清；resolver 未注入 400） |
| GET /api/listen · PUT /api/listen/:feature | 监听功能开关；GET 回 auto 有效态 + platforms，PUT 改手动设置并 onChanged 热启停源 |
| GET/PUT /api/advanced | RuntimeConfig 全量读写，按 NUM_SPECS/BOOL_SPECS 规格表逐字段校验（非法 400 中文报错、空 patch 400），落 settings 后 onChanged 热生效 |
| GET /api/snapshot?room&ts | 缓存关键帧；参数须正整数否则 400；nearestSnapshot 取最近帧，无行/读不到 404；**路径安全**：库内 path 归一化反斜杠后 resolve 到注入 dir 下、必须在 dir 内否则 404；按扩展名 image/png\|jpeg + no-store |
| /api/channels · /api/channels/:id | 推送渠道 CRUD（notifier 枚举、onebot 必填纯数字 targetId、name 非空；PUT 对合并后形状做联动校验） |
| PUT /api/channels/order | 拖拽排序，ids 必须与现有渠道一一对应否则 400 |
| PUT /api/push/enabled | 推送总开关（settings.push_enabled，缺省开；关 = pipeline 全局不推、追踪照常） |
| GET /api/schedule?from&to | 时间表；from/to 为北京日界日串（UTC+8 凌晨 6 点界，仅用于归属），缺省今天-7 ~ 今天+1，跨度 ≤62 天，空日期返回空数组 |
| /api/categories · /api/categories/:id | 分类 CRUD：name 省略补「分类 N」、显式空串 400；llmPrompt/keywords/areas 至少一项非空（PUT 对合并后形状校验）；condMode 枚举；DELETE 级联停用引用它的推送规则（返回 disabledRules） |
| PUT /api/categories/order | 拖拽排序，ids 全排列 |
| /api/rules · /api/rules/:id | 推送规则 CRUD：`?uid=` = 对该主播生效的规则；name 省略补「规则 N」、显式空串 400；categoryId 可空 = 任意开播、非空必须存在于 categories；uids 元素纯数字且在监听名单内；channels 必须存在——存在性校验在路由层对合并后形状做 |
| PUT /api/rules/order | 全局拖拽排序，ids 必须是全部规则的全排列 |
| /api/auth/bili/qrcode · /poll | B站扫码登录；confirmed → saveCookies 落盘 → onCookiesSaved 热重启 follows + dynamic |
| /api/auth/weibo/qrcode · /poll | 微博扫码登录；qrid 会话存服务端；confirmed → exchangeCookies 换票 → 落盘热重启 feed；expired 清会话 |
| GET /api/llm · PUT /api/llm/keys | provider 展示与 key 管理；key 存 settings `llm_key:<providerName>`（GET 回 source/count/value，**明文回显**）；空 value = 清除；保存后 router.refreshKeys() 热更新 |
| /api/llm/providers · /:name | provider 名单 CRUD（llmProviderSchema 校验、重名 400、name 是路径标识不可改；body 可携带 key 一并保存）；落 settings 后 onProvidersChanged 重建 router 热生效 |
| PUT /api/llm/providers/order | 整体重排，names 必须是现有名单的排列（长度一致/无重复/无增删） |
| POST /api/llm/providers/:name/test | 可用性 ping：404 不存在 / 400 缺 key / 200 {ok,ms} / 502 端点错误；错误信息不含 key |
| PUT /api/llm/enabled | LLM 总开关（settings.llm_enabled，缺省关） |
| GET/PUT /api/napcat · POST /api/napcat/launch | NapCat 通道；GET 回生效配置（含 autorestart）+ 端点 + 实时三态探测 + taskRegistered；PUT 校验（布尔/纯数字，**空串 = 清空字段，settings 唯一信源无回落**）后 await save——autorestart 开 = 建拉起任务（失败 400 透传、不落开关）、关 = 移除任务；launch 失败 400 透传原因 |
| /mcp | MCP 端点（Bearer token 鉴权 + 按角色注册工具面），实现委托 src/mcp/ |
| GET/PUT /api/x · POST /api/x/test | X 连接配置与探测（GET **只读快照、绝不打网络**；POST 测试允许未保存的输入值「先测后存」，只有测已保存配置才更新快照；配置变了相关旧结论作废） |
| /api/x/accounts · /:id | X 独立名单 CRUD；新建时走免登录存在性校验（账号不存在 400 / 链路不通照收并回报 `verify`）；`biliUid` 必须在监听名单 |
| /api/weibo · /api/weibo/accounts · /:id | 微博运行状态快照（GET 只读；**面板当前不消费**，保留给后续可视化）+ 微博独立名单 CRUD；POST 时 `uid` 与 `nickname` 二选一（只填昵称走匿名解析链补 uid），重名 409、非数字 uid 400；`displayName` 为自定义显示名（卡片优先展示，留空 = 用昵称） |
| GET /api/weibo/resolve?nick · ?uid | 昵称 ↔ uid 即时互查（添加浮窗「填一个解析另一个」用；与新建补 uid 同一条匿名解析链；找不到 404、解析失败 400） |
| /api/x-avatar · /api/weibo-avatar?file= | 按文件名读本地头像缓存（md5+扩展名白名单，天然防穿越；长缓存） |
| /api/post-rules · /:id · /order | 图文帖规则 CRUD：**`platform` 决定 `accountIds` 查哪份名单**；微博规则拒 `filters.quote` 与 `llmTranslate`；换平台未带新名单则清空 `accountIds`；「原创/转发都不勾」400；开了 LLM 判定必须填判定标准 |

**安全约定**：cookie 值不进任何响应/日志；唯一例外是 LLM key 在本机面板明文回显/编辑（明示决策，不做掩码）。各 order 路由（channels/categories/rules/llm providers）均在 `:id`/`:name` 通配之前匹配。

## src/panel/http-util.ts

请求体解析（64KB 上限）、参数校验（400 + 中文错误）、JSON 响应。**面板路由与 MCP 工具共用的跨表逻辑也在这里**：`checkRuleRefs`（开播规则引用存在性）、`checkPostRuleRefs`（图文帖规则引用：渠道 + **对应平台**的账号名单）、`checkPostFiltersUsable` / `checkPostTranslateUsable` / `checkPostJudgeUsable`（图文帖的死配置一律保存时拒）、`syncStreamerWeiboLink`（主播详情填/清微博昵称 → 建/关联网名单行）、`watchStreamer`（候选池一键加入监听）、`parseRuntimePatch`（高级设置规格表校验）。

## src/panel/schedule.ts

时间表查询（北京 06:00 日界 + listTimeline 归并 + 空日期占位）：`/api/schedule` 与 MCP `get_schedule` 共用同一实现。

## webui/ — 前端唯一信源

真实 HTML/CSS/JS，ES modules **显式 import/export**，无前端框架：

| 文件 | 职责 |
|---|---|
| index.html | 壳：左边栏（浮动卡片：logo + 三视图导航 + 在播计数胶囊）+ 右内容区三视图（时间表 / 主播列表 / 设置） |
| style.css | v2 设计系统（间距 4/8/12/20/40〔40 = 分段与边栏↔主容器的壳层大间距〕、圆角三级、控件恒 36 高、按钮四语义色；浅色单主题，深色已删） |
| js/boot.js | 入口：`?demo=1` 时先装 demo/mock-api.js fetch 拦截器再进 app，真实部署零影响 |
| js/app.js | 装配各卡模块 + 边栏视图切换 |
| js/core.js | 共享件（全部显式 export）：esc/api/toast/sheet/switchHtml/checkboxHtml/iconBtn/**makeSortable 拖拽排序**/**事件委托 ACTIONS·CHANGES·INPUTS 三张表**（禁用内联 on\* 与字符串拼接转义，防属性注入 XSS）/fitRow 行宽适配/avatarHtml 头像+首字占位/relTime/dropdownHtml/**segnav 胶囊分段导航（lg/sm 两档，滑块横滑动效）**/data-icon |
| js/icons.js | `icon(name)`：消费本地节选的 lucide 官方节点数据（js/lucide-icons.js），按官网同款 SVG 属性输出，离线可用 |
| js/qr-lib.js | qrcode-generator 真实 JS，扫码登录弹窗用 |
| js/{listen,llm,categories,push,napcat,streamers,follows,schedule}.js | 九卡模块；streamers 导出 loadStreamers、push 导出 loadPush 供跨卡 import，无循环依赖 |
| js/x.js | **图文分页**（X / 推特 + 微博）：两张来源卡（X 卡 = 连接可达性行；微博卡 = 登录态行，**保持原样不加行**）+「源设置/抓取设置」弹窗 + **单墙混排的账号卡片墙**（顶部大 segnav 筛选 + 右端圆形添加钮，与 segnav 同高；平台角标；卡面 = 身份段 + 图文规则摘要 + 帖子段，整卡可点开账号浮窗——添加态顶部小 segnav 切平台，规则编辑开二级浮窗） |

### v2 设计要点（只记非显而易见的机制）

- **壳**：边栏为浮动卡片（不贴边、高度仅包内容）；body 整屏不滚动、各视图自滚，隐藏视图后台轮询照跑。
- **主播列表**：竖版三段式 .st-card（关键帧横幅头 / 主播信息段 / 动态段），在播优先再按 lastLiveAt 排序；**主播三开关已删**（名单内即监听中，watch 仍是名单机制，关注列表「取消监听」= PUT watch:false）。
- **设置视图**：六设置卡（acc 主题色区分）+ 关注列表候选池；运行时参数收纳进对应卡底部按钮的 sheet（监听「抓取设置」/ LLM「高级」/ 推送渠道「推送设置」），settings 唯一信源、保存即热生效。
- **时间表**：5 天滑动窗口（点击居中 + 滚轮按天步进）；**泳道行高 JS 解算**——0-1-2 级权重制，按「当天道数 × 级权重 1/2」水装填分配余高、解成 flex-basis 像素值，每道下限 single 16px / center 32px，放不下按三步降级（去首末两天 → 相邻天降 mini → 当天降单行），全程 px→px 连续过渡；相邻 ±1 步窗口后台预取，命中立即渲染再后台纠偏；hover 图优先 /api/snapshot 最近缓存帧，404 回退远程 keyframe ?? cover，再挂移除 img。
- **图文分页（#view-x）**：单墙混排 + 大 segnav 筛选（全部 / X / 微博，带计数）+ 右端圆形「添加账号」钮（与大 segnav 同高呼应）——两张名单的自增 id 会撞、规则又按 `platform` 分流，所以卡片必须带平台角标、规则浮窗必须有「来源」行。添加浮窗顶部小 segnav 切 X/微博（草稿随切换保留）；两平台名称字段同构：**ID/uid = 唯一标识、昵称 = 平台名（X 的 display name / 微博昵称，抓到回写也可手填）、显示名 = 自定义（卡片优先展示）**——X 表单 = ID（@handle，框内 placeholder 只放一个 @ 作格式提示）+ 昵称（并排两 field、label 各在输入框上方）/ 显示名 / 关联主播，微博 = 昵称 + uid（并排，uid 窄列在右；昵称框 placeholder 只放一个 @——@昵称 是微博 ID 的常规词头，后端 normalizeWeiboNick 剥开头 @）/ 显示名 / 关联主播；微博的昵称与 uid 失焦即查 `/api/weibo/resolve` 回填另一个（解析失败静默，保存时后端兜底报错）；微博账号浮窗的 uid 编辑态只读（uid 是账号身份，改它等于换账号，历史微博会串到别人名下）；规则浮窗对微博不出「引用」「附译文」两枚胶囊（该平台没有这两种形态，后端也会拒）。
- 简称（alias）仅在空间受限处优先（推送规则行生效主播标签、时间表横条），其余一律用原名 uname。

### demo 模式（`?demo=1`）三层数据信源

| 层 | 文件 | 说明 |
|---|---|---|
| 真实数据夹具 | demo/fixtures.json | `npm run demo:fixtures` 一次性从真实库导出（12 主播 enrich + 18 关注 + 近 14 天时间表）后**人工节选维护**，已存在须 `--force`；`meta.exportedAt` = 时间冻结点，何时打开 demo 都按导出瞬间渲染；头像/关键帧本地化随仓库发布（时间表取色要 canvas 读头像，本地图天然同源） |
| 手工展示案例 | demo/defaults.json | LLM provider / 分类 / 推送规则的**唯一手工信源**，demo mock 与发布后首启默认值（onboarding）共用 |
| 手写最简态 | demo/mock-data.js | 渠道/NapCat/高级设置等设置卡片（占位假号）、SVG 占位图、freezeTime 时间冻结 |

**契约**：demo/mock-api.js（fetch 拦截器，内存实现整张 /api/* 路由表，含 PUT/POST/DELETE 与拖拽排序）与 server.ts 的 /api/* **完全同构——改 server 路由必须同步改 mock-api**。

## scripts/build-webui.mjs — 构建期内嵌

读 `webui/**` → 生成 `src/panel/webui-assets.gen.ts`（`WEBUI_ASSETS` map：URL 路径 → {type, body}，正文 JSON.stringify 转义、绝不进模板字面量）；另把 `webui/demo/defaults.json` 生成 `src/core/onboarding-defaults.gen.ts`（首启默认值的后端消费形）。纯 node fs 零依赖；prebuild/predev/pretest/pretypecheck 钩子保证每次 build/dev/test 先于编译现生成。**两个生成物内容没变就不写盘**（tsx watch 盯 src/，mtime 变化会白重启 dev 服；dev 脚本另把两个 .gen.ts 列进 `--ignore`，内容真变了也不触发重启）。

## src/panel/webui-assets.gen.ts

生成物（**gitignore 防漂移，勿手改**）：运行时 server 只服这份内存快照，dist 里只有编译产物——发布工件天然与同 commit 后端同版本。onboarding-defaults.gen.ts 同口径。

## UI 开发约定

- **UI 只在 `webui/` 里改**：日常用 `npm run webui:dev`（静态服 webui/ + 浏览器开 `?demo=1` 看 mock 数据，刷新即生效、零重启）；改完一次性 `npm run build && npm start`（或 `npm run dev`）接线后端。
- 运行时页面来源 = 构建期内嵌的内存快照，**运行时绝不读磁盘静态文件**。
- 改 `/api/*` 路由必须同步改 `webui/demo/mock-api.js`。

## 未实现 / 预留

- verdicts 总览（分类判定结果的面板视图）
- 预告半透明条与「预定时间到」推送（依赖 schedules 表与 schedule-extract，见 [analysis.md](analysis.md)）
