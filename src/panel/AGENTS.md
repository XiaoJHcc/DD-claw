# panel — 控制面板后端（HTTP 适配层）

同进程 `node:http` 服务：内嵌静态资产 + `/api/*` REST + `/mcp` 委托。前端唯一信源见 [../../webui/AGENTS.md](../../webui/AGENTS.md)，能力面与权限见 [../mcp/AGENTS.md](../mcp/AGENTS.md)，对话回路见 [../agent/AGENTS.md](../agent/AGENTS.md)。跨模块时序、构建内嵌与 demo 契约见 [docs/modules/panel.md](../../docs/modules/panel.md)。

## 长期不变量

- **写路由一律经注册表**：`/api/*` 的写走 `runPanelTool` → `runToolTracked(..., 'panel')`，zod 校验、审计、撤销快照全在能力层；路由只做挂载门、响应形状与状态码映射（201 vs 200、`{id}` vs `{ok:true}`、webui 认的键名差异）。
- **唯一例外是撤销执行器 `POST /api/undo`**：它的写由 UndoStore 完成、自身不入快照，路由直接调 `deps.undoLast`，热生效回调在装配根。
- **`order` 路由必须先于 `:id` / `:name` 通配匹配**（channels / categories / rules / LLM providers / 决策模型 providers 都是），否则 `order` 会被当成 id 或名字。
- **写路径清单是测试不是文档**：新增或删改写路由要同步 `write-path-inventory.test.ts` 的 INVENTORY——「能否回滚」与「是否暴露给 agent」是两个独立问题，各自登记。接口是否存在以本目录源码与注册表为准，文档不抄全量 API 表。
- **鉴权口径**：只绑 `127.0.0.1`，`/api/*` 即主人（admin）；`/mcp` 永远要令牌（零令牌 503、缺失/无效 401，不设回环免 token）；`POST /onebot` 刻意不在 `/api` 下——它是消息入口，不是主人能力面。
- **敏感值**：cookie 值不进任何响应与日志；唯一显式例外是模型 key（LLM / 决策模型）在本机面板明文回显/编辑（明示决策，不做掩码），审计日志里 key 一律打码。
- **挂载门**：路由组按 `PanelDeps` 的 dep 存在与否条件挂载（无 dep = 该组 404）。新增路由先决定它归属哪个 dep。
- **缓存文件读取要守目录边界**：数据库中的快照路径也不可信；规范化分隔符并 `resolve` 后必须仍位于注入的缓存目录内，否则 404。内嵌资产的安全性不能代替磁盘媒体端点的路径校验。
- **静态资产只来自构建期内嵌快照**：命中即 200 + content-type + `cache-control: no-store`；纯 map 查键、运行时绝不读磁盘、天然无路径穿越，且判断排在 `/api/*` 之前。

## 文件地图

- `server.ts` — 装配与分发：`createPanelServer(deps)`、`PanelDeps`（dep 即挂载门）、静态资产、`/api/*`、`/mcp`、`/onebot`；收敛出口 `runPanelTool` / `callTool`（写路由的形状与状态码映射）；agent 对话端点与历史回放（工具行按 call id 配对成 `calls`）。
- `http-util.ts` — 请求体解析（64KB 上限）、`HttpError`、`parseUid`，以及面板与 MCP **共用**的校验/解析：`parse*`（主播补丁 / 渠道 / 分类含判定模式与精确条件 / 规则 / 三种账号 / 运行时参数 / X 配置）与 `check*`（渠道形状、分类条件与判定口径、规则引用），外加 `watchStreamer` / `syncStreamerWeiboLink` 两个跨表动作。精确条件的形状校验（严格字段、非空文本、分类内唯一 id、缺 id 补 `randomUUID`）也只在这里写一遍。
- `schedule.ts` — 时间表查询（北京 06:00 日界 + 归并 + 空日占位）；`/api/schedule` 与 MCP `get_schedule` 共用同一实现。每场除最新 `verdicts` / `primary` 外还带 `classificationRuns`（历次分类时机判定，按 ts 升序；空数组 = 旧场次没有历史，前端回退最新结果）。
- `category-test.ts` — 分类草稿两阶段试判：带图归档随机抽样只回摘要，按 `subjectId` 精确复测同一批样本；直播 / 图文统一投影与图片规范化，规则 / LLM / 决策独立跑且共用分析队列，不落判定或审计、不推送。草稿走新建分类同一套校验与口径判定（`hasJudgeBasis`）：精确模式没有启用正向条件时两个模型档都 `skipped` 并回原因，决策档逐条件概率走 `conditionResults`（可选字段，simple 分类不出现）。X 缩略图反代只放行 `pbs.twimg.com`。
- `undo-view.ts` — 变更历史的展示层翻译：中文操作名、值感知一句话、行级带值明细、`refill` 判定；settings 键与「表→中文名」的唯一信源（webui 与 `agent/tool-view.ts` 都复用，前端不再自维护映射）。
- `webui-assets.gen.ts` — 构建期生成物（勿手改）：`WEBUI_ASSETS` 内存快照。
- `server.test.ts` — 路由契约回归（挂载门、响应形状、错误文案、撤销与 chat 端点）。
- `write-path-inventory.test.ts` — 写路径覆盖清单：从 `server.ts` 源码提取写路由，未分类即失败；与 `agent/tool-schema.ts` 的排除名单互锁。
