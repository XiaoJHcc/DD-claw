# X/推特图文来源实施计划

> 状态：**计划（2026-09-16 定），未开工**。前置调研见 [research/twitter.md](../research/twitter.md)（含全部 [实测] 证据与待验证清单）。
> 目标：把关注的 X 账号推文作为**独立于 B站/微博**的图文推送渠道——机械筛选（原创 / 转发 / 引用 / 带图）符合即推，可选经 LLM 判定是否推，并依赖 LLM 翻译。
> **验收在 UI**：X 走**独立分页**（`#view-x`），全部设置在该页完成；设置页保持开播语义不动。

## 已定决策（2026-09-16，用户选定）

1. **数据源：免登录路线**——`Nitter RSS 为主`（唯一能机械区分原创/转发/带图，[实测] 20 条 = 10 转 + 10 原创、19 带图），`x.com HTML + tweet-result 为备`（零第三方依赖，但实测拿不到转发）。多实例轮询 + 失败即弃。
2. **代理：面板可配，默认 `http://127.0.0.1:7890`**——落 `settings`（运行时配置唯一信源）；代理不可用必须**告警而不是静默**。
3. **UI：开独立分页「X / 推特」**——X 是独立于 B站的一条路径，基于开播设计的设置页几乎全不适用（审计见下），不该硬塞。
4. **账号模型：独立名单 `x_accounts`，可选关联到主播**——不要求 X 账号对应 B站主播（`Watase_Yuzuki` 这类日系声优本就不是）；关联仅用于展示与推送文案。
5. **共享配置：引用设置页的推送渠道与 LLM 供应商**，不在 X 页重复配置（settings 唯一信源）。
6. **规则形态：X 页独立一张「图文帖规则」卡 + 独立表 `post_rules`**——现有开播推送规则**零改动、零迁移**。
7. **默认筛选：默认只推「原创」，不论有没有图**（转发 / 引用 / 「必须带图」默认不勾，UI 随时可改）。
8. **LLM：翻译 + 「要不要推」判定，规则级开关、默认关**；LLM 关/熔断/失败 → **回退机械筛选照推**。
9. **不做**：不发推 / 不点赞 / 不关注（只读）；不引入 Playwright 常驻浏览器；暂不接官方 X API 与付费第三方 API（绝不在轮询里"拉最近 20 条"）。

## 设置页对 X 的适用性审计（新分页的依据）

| 设置页现有卡片 | 对 X | 处置 |
|---|---|---|
| 监听卡（B站登录 / 监听动态 / 微博登录 / 监听微博 / 抓取设置 8 项数字） | **不适用**：X 无登录态，非直播、非动态、非微博；数字表里 X 只占 1 项 | 不进该卡；间隔改放 X 页 |
| 分类规则 | **不适用**：开播内容分类口径 | 不参与图文帖链路 |
| 推送规则 | **不适用**：开播规则（标签「任意开播」、推送词「{liver} 开播了」） | X 另立图文帖规则卡 |
| 时间表 / 主播列表 | **不适用**（直播时间轴） | 不动；主播详情仅加一行只读的关联 X 账号 |
| NapCat | **适用，必须共享** | 留在设置页，X 页引用 |
| LLM 供应商 | **适用，必须共享**（同一套 provider 与 key 池） | 留在设置页，X 页引用 |
| 推送渠道 | **适用，必须共享**（X 不该另建投递目标） | 留在设置页，X 页引用 |

结论：**共享的三张（NapCat / LLM / 渠道）留在设置页，X 专属自成一分页，设置页几乎零改动 → 开播路径零回归。**

顺带消掉上一版的两个技术风险：不再需要把 `push.js` 的生效主播圆柱卡抽到 `core.js`（X 页用简化选择器），也不用把"代理"硬塞进登录行的语义。

## UI 定稿：独立分页「X / 推特」

### A. 导航与新页面骨架

- `index.html` 导航加一项：`<button class="nav-item" data-action="nav-view" data-view="x"><i data-icon="send"></i><span>X / 推特</span></button>`（现有图标 `send`，`lucide-icons.js:119`；也可往 `LUCIDE` 加一条 at-sign 路径）。
- 新增 `<div class="view hidden" id="view-x">`，内部沿用 `set-grid` + `set-card` 结构。
- 路由与切换零改动：`switchView()` 按 `view-<v>` 显隐（`app.js:14-26`），hash 路由已支持。
- 新增前端模块 `webui/js/x.js`（页面骨架 + 连接 + 监听 + 账号 + 最近推文）与 `webui/js/post-rules.js`（图文帖规则卡），照现有卡片模块惯例在文件末尾自举 `loadXxx()` + 定时刷新，并在 `boot.js` / `app.js` 接线。

### B. 卡片 1「连接」

| 控件 | 形态 | 行为 |
|---|---|---|
| 代理地址 | `input.inp`（text） | 默认 `http://127.0.0.1:7890`；行内「测试」→ 就地显示 `代理可达 · x.com 200 · 1.8s` / `代理不可达：ECONNREFUSED` |
| Nitter 实例 | `input.inp`（text，逗号分隔） | 默认 `nitter.jaydenha.uk,x.n0g.xyz`；「测试实例」→ 逐实例列出 `可用 / 403 Cloudflare / 451 法律下架 / 超时` |
| 回退到免登录 HTML | `checkRowHtml` | 默认开：Nitter 全挂时降级到 `x.com` HTML + `tweet-result` |

两条"测试"都必须给**可读原因**，不能只回 ok/fail——这是区分"我填错了"与"链路断了"的唯一手段。

### C. 卡片 2「监听」

- 主开关：`监听推特`（复用 `listen_<feature>` 机制，见 §H）；
- `抓取间隔（秒，≥120）`（300 默认，与微博同量级）；
- 状态副行：`代理可用 · 2/3 实例可用 · 最近一轮 12:03`（数据来自 `/api/x`），失败态给原因；
- **「抓不到」与「没有新推文」必须在此行可区分**（调研 §8 的纪律在 UI 上的落地）。

### D. 卡片 3「关注账号」（新表 `x_accounts`）

- 列表行：`@screen_name` / 启停勾 / 副行 `最近推文 2026-09-16 00:54 · 关联 渡瀬結月`（无关联则只显示最近推文时间）/ 编辑 / 删除；
- `＋ 添加账号` → 一级 sheet：`X 账号`（input，可省 `@`）+ `关联主播`（可选，下拉/挑选，来自 `/api/streamers`）；
- **校验错误必须分类显示**：`账号不存在` / `代理不可用` / `被限流（稍后重试）`——直接复用 `tweet-result` / HTML 探测的结果；
- 账号列表规模小（数十），**不做圆柱卡**：列表 + 简单多选即可。

### E. 卡片 4「图文帖规则」

规则行（模子 = `push.js:58-75` 的 `ruleRowHtml`）：拖拽把手 / 启停勾 / 名称 / **筛选标签**（`原创`、`转发`、`引用`、`带图`，只显示已勾的）/ 生效账号标签（空 = 全部账号）/ 编辑 / 删除；拖拽排序 = 匹配优先级。

规则表单（一级 sheet）：

```
名称        [________________]
帖子筛选    (原创)(转发)(引用)(必须带图)   ← .chips 胶囊（复用渠道多选同款控件）
关键词      [____,____]                  ← 可选
生效账号    (胶囊多选 X 账号)             ← 空 = 全部账号；规模小，不用圆柱卡
渠道        (胶囊多选)                    ← 数据来自设置页的 /api/channels（引用，不复制）
推送词      [________________]            ← 占位符提示 {author} 发了新推文；可用 {author} {text} {url}
LLM 判定    [switch]  判定提示词 [______]  ← 默认关；开启才展开提示词
LLM 翻译    [switch]                      ← 默认关
```

- **默认筛选：`原创` 勾选，其余三项不勾**；
- 渠道为空时给引导：`还没有渠道 · 去设置页添加` → 跳转 `settings` 视图（已有 `goto-push-rule` 的跳转先例，`push.js:424-430`）；
- LLM 判定/翻译放规则级（人填口径），关闭或失败 → 回退纯机械筛选。

### F. 卡片 5「最近推文」（验收面板）

最近抓取到的 N 条（作者 / 时间 / 正文摘要 / 带图标记 / 原创或转发）+ 本轮抓取状态与耗时。
存在理由有两个：**验收时肉眼可见**（不用去翻 QQ 群或数据库），以及把"抓取失败"可视化，避免接口静默失效被读成"主播没发推"。

### G. 设置页的改动（压到最小）

**只加一行只读信息**：主播详情弹窗（`webui/js/streamers.js`）显示该主播**关联的 X 账号**（若有），点击跳转到 `x` 视图并定位该账号。
其余（监听卡、抓取设置、分类、推送规则）**一律不动**。

### H. 共享配置与开关机制的引用方式

- **推送渠道**：X 页规则表单直接 `GET /api/channels`（与设置页同一份数据、同一个 CRUD），不新增渠道概念、不复制；
- **LLM 供应商**：X 页不出现 provider 配置，翻译/判定复用 `analysis/providers` 的路由与熔断（设置页那份配置）；
- **监听开关**：仍复用 `core/listen.ts` 的 `listen_<feature>` 机制（settings 唯一信源、auto/手动语义），`ListenFeature` 加 `'twitter'`；但 **auto 的判据从"登录态"换成"代理可用"**——`shouldRunListen(db, feature, ready)` 的第三参从 `cookieExists` 泛化为"运行前提满足"（`core/listen.ts:33-41`），`putListen` 的三元式（`server.ts:842`）同步。X 页读 `GET /api/x`（含开关有效态），切换走 `PUT /api/listen/twitter`。

### I. UI 验收路径（从零到群里看到推文）

1. 导航 → **X / 推特** → 连接卡填代理 → 「测试」→ 见 `代理可达 · x.com 200`
2. 填实例 → 「测试实例」→ 见逐实例状态 → 保存
3. 监听卡打开 `监听推特`（auto 态 = 代理可用时自动开）
4. 关注账号卡 → 添加 → 填 `@Watase_Yuzuki`（可关联某主播）→ 保存 → 列表出现该账号与最近推文时间
5. 图文帖规则卡 → 添加规则 → `原创` 已默认勾选 → 选渠道（或按引导跳设置页建）→ 保存
6. 规则行显示 `原创` 标签（另勾带图则显示 `原创` `带图`）
7. 最近推文卡出现该账号的新推文 → QQ 群收到（带图推文带图）
8. （可选）规则里开「LLM 翻译」→ 文案出现译文；开「LLM 判定」+ 填提示词 → 不符合的帖子不再推

### J. mock 同构清单（AGENTS.md 硬要求）

`webui/demo/mock-api.js` 必须同步：`GET/PUT /api/x`（含两个测试端点）、`GET/POST/PUT/DELETE /api/x/accounts`、`GET /api/x/recent`、`GET/POST/PUT/DELETE /api/post-rules` + `/api/post-rules/order`、`PUT /api/listen/twitter`；`webui/demo/fixtures.json` 或 `mock-data.js` 补两个 X 账号 + 一条带图原创 + 一条纯文字原创 + 一条转发，供验收演示。

## 数据模型

```sql
-- 第 14 张表：X 独立关注名单（不复用 follows / streamers）
CREATE TABLE IF NOT EXISTS x_accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  screen_name   TEXT NOT NULL UNIQUE,   -- 去 @、小写归一（Nitter RSS 只给 @screen_name）
  display_name  TEXT,                   -- 可选，抓到就存（HTML/推文 user.name）
  bili_uid      TEXT,                   -- 可选关联主播（引用 streamers.uid；仅展示与文案用）
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_tweet_id TEXT,                   -- 增量基线（只往前推）
  last_tweet_at INTEGER,
  last_ok_at    INTEGER,                -- 该账号最近一次成功抓取（健康可视化）
  created_at    INTEGER NOT NULL
);

-- 第 15 张表：图文帖规则（与 push_rules 平行，互不影响）
CREATE TABLE IF NOT EXISTS post_rules (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  sort          INTEGER NOT NULL DEFAULT 0,   -- 全局顺序 = 匹配优先级
  account_ids   TEXT NOT NULL DEFAULT '[]',   -- 生效账号（空 = 全部）
  channels      TEXT NOT NULL DEFAULT '[]',   -- 引用 push_channels.id（共享设置页那份）
  filters       TEXT NOT NULL DEFAULT '{}',   -- {original,retweet,quote,media,keywords[]}
  llm_judge     INTEGER NOT NULL DEFAULT 0,
  judge_prompt  TEXT,
  llm_translate INTEGER NOT NULL DEFAULT 0,
  message_template TEXT,
  created_at    INTEGER NOT NULL
);
```

- **连接设置不建表**：代理地址 / 实例列表 / 间隔 / 回退开关都进 `settings`（`x_proxy_url` / `x_nitter_instances` / `x_interval_sec` / `x_fallback_html`）。
- **`posts.uid` 语义**：X 帖存 `screen_name`（`platform='twitter'`），与「微博存 B站 uid」不同——因为 X 账号是独立名单，没有 B站 uid；面板按 `platform` 分支分组即可。
- **筛选默认值两处一致**：建表默认与 UI 默认都是 `{original:true, retweet:false, quote:false, media:false}`；`filters` 为空的旧行按默认值处理（防御式）。
- 类型与 JSON 序列化照 `push.ts` 惯例，集中在新 `core/x-accounts.ts` / `core/post-rules.ts`。

## P1 已落地（2026-09-16）

| 交付 | 位置 | 验收 |
|---|---|---|
| Nitter RSS 解析（主路线） | `src/sources/twitter/nitter.ts` + `nitter.test.ts` | 8/8；转发/实体/图片还原/缺 id 跳过 |
| 免登录回退（HTML 发现 id + 单推补详情） | `src/sources/twitter/web.ts` | 真机：13 个 id → 单推 JSON |
| X 时间线源 | `src/sources/twitter/feed.ts` + `feed.test.ts` | 8/8；真机两轮：首轮静默归档 20 条 → 新推文发 `feed_post` → 去重零信号 |
| `x_accounts` 独立名单 | `src/core/x-accounts.ts` + `db.ts`（第 14 张表） | 面板与 MCP 同一套校验（`http-util` 的 `parseNewXAccount`/`parseXAccountPatch`） |
| 监听开关 | `core/listen.ts`（`ListenFeature` 加 `twitter` + `listenReadyFor`） | 前提 = 代理已配置；面板/MCP 共用一份映射 |
| 面板 X 分页 | `webui/js/x.js` + `index.html` + mock 同构 | 浏览器实测：开关 / 来源与最近一轮 / 账号增删改与就地报错 |
| 轴 B 能力面 | `mcp/tools.ts`：`list_x_accounts`、`get_x_config`、`update_x_config`、`upsert_x_account`、`delete_x_account`；`set_listen` 收 `twitter`；`search_posts` 收 `platform='twitter'` | mcp.test 13/13（含 gateway 看不到 admin 专属 X 工具） |

**实现中确认/修正的点**（以本节为准）：

1. **RSS 的 `<guid>` 就是推文 id**，比解析 `<link>` 可靠；转发时 `guid` 与 `dc:creator` **都是原作者**——"同一推文被多次转发折叠成一条"因此是结构性事实，不是 bug。
2. **图片是实例代理 URL**（`http://<实例>/pic/media%2FXXX.jpg`）→ 一律还原成 `https://pbs.twimg.com/media/XXX.jpg` 存档：实例会死，CDN 形态才长期可用。
3. **回退路线的分工**：HTML 只用来"发现 id"（React Flight 载荷里 id 与正文配对不可靠），详情一律走单推接口；这条路**看不到转发**（`retweeted_status_results` 恒 null），所以用回退时"转发"筛选永不命中——需要转发就得让 Nitter 活着。
4. **监听开关的 auto 判据 = 代理已配置**（不是"代理已验证可用"）：默认配置自带 `http://127.0.0.1:7890`，所以 auto 一开始就是开；冷启动不因为"还没测过"就把开关显示成关（源本身在名单为空/代理为空时不会起）。
5. **`enabled` 必须被采纳**（MCP 测试抓到的真 bug）：新建账号时 `parseNewXAccount` 漏了 `enabled`，`enabled:false` 被静默忽略、建出来仍是启用——面板与 MCP 都会中招，已在源头修掉。

## P0 已落地（2026-09-16）

代码已在仓库里，全部经真实网络与 UI 验收：

| 交付 | 位置 | 验收 |
|---|---|---|
| 隧道 fetch | `src/core/proxy.ts` + `proxy.test.ts` | 6/6；假代理端到端往返 + 代理不可达归类 |
| X 配置（settings 唯一信源） | `src/core/x-config.ts` + `x-config.test.ts` | 8/8；默认值/往返/异常回落/状态作废规则 |
| 连通性探测 | `src/sources/twitter/probe.ts` | `npm run probe-x` 实测：代理 OK、两实例各 20 条、免登录 13 个 id |
| 面板端点 | `panel/server.ts` `/api/x` `PUT /api/x` `POST /api/x/test` | server.test 74/74（含 4 条新用例） |
| X 分页 | `webui/index.html` + `webui/js/x.js` + mock 同构 | 浏览器实测：导航/视图/两张卡/一键测试/设置弹窗/先测后存/保存作废旧结论 |

**实现中发现并已修正的两处设计**（原计划写错，以本节为准）：

1. **抓取间隔不放设置页的「抓取设置」**（原 §C）：X 是独立分页，它的设置全在该页的「X 源设置」弹窗里，设置页一个字都不用改——这正是"开独立分页"的意义。
2. **实例探活打 `/<user>/rss` 而不是首页**：首页挂 Anubis 不代表实例不可用（实测 `x.n0g.xyz` 首页是挑战页、RSS 却给你 20 条）。判活口径必须与真实使用路径一致。

**状态快照语义**（P1 起沿用，别退化）：

- `GET /api/x` **只读快照，绝不打网络**（面板每分钟轮询这张卡）；
- 快照**只描述已保存的配置**：弹窗里测未保存的输入值只在弹窗内就地显示，不写快照——否则卡片会拿未保存值的失败结论配着已保存的地址显示；
- **配置真变了，相关旧结论作废**（灰点 +「配置已改，请重新测试」），但轮询间隔变化不影响任何连通性结论、不清状态；
- 未测试是 `checkedAt: null`（灰点），与"测了但失败"（红点）**必须可区分**。

## P0 — 代理与探针（原计划，已完成）

| 项 | 落点 | 要点 |
|---|---|---|
| 隧道 fetch | 新增 `src/core/proxy.ts` | `tunnelFetch(url, opts)`：CONNECT 隧道 + `tls.connect({servername})`；**必须带 `Connection: close`**（keep-alive 会表现成假 20s 超时）；超时/重试/错误分层沿用 `bili/client.ts` 惯例 |
| 配置项 | `core/runtime-config.ts` + settings | 代理 / 实例 / 间隔 / 回退；热生效走 `onChanged` |
| 面板 | §A–§C 的 UI + `panel/server.ts` `/api/x` | 两个"测试"都要给可读原因 |
| 探针 | 新增 `scripts/probe-x.mjs` + `npm run probe-x` | 照 `probe` / `probe-llm` 惯例：一次跑完两条路线，打印条数/转发数/带图数/最新时间/耗时。**它同时是 [research/twitter.md](../research/twitter.md) §7 待验证清单的执行器** |

P0 的价值：不碰整条管线就能验证"今天还能不能用"——实例存活与页面结构是本方案最大的时效性风险。

## P1 — 免登录源 + 账号名单

```
src/sources/twitter/
  nitter.ts   多实例 RSS 解析（主）：title 的 `RT by @xxx:` 判转发、dc:creator 原作者、
              pubDate、description 里 <img> 判带图
  web.ts      x.com HTML 抽 id（防御式）+ tweet-result 补全（token 任意非空；
              200 + `{}` 必须当失败）
  feed.ts     TwitterFeedSource implements Source —— 模子 = sources/weibo/feed.ts
```

- 轮询对象 = `x_accounts` 里 `enabled=1` 的行（不再读 `streamers`）；
- **源纪律照抄微博源**：首轮静默归档、`insertPosts` 靠 `(platform,item_id)` UNIQUE 去重、新帖 `emit feed_post`；**拉取失败绝不当成「没有新推文」**（保留旧数据 + 连续失败告警 + 恢复复位）；每轮写回 `last_ok_at`；
- **心跳**不再是登录态，而是**代理 + 实例可用性**；
- 能力面：账号 CRUD、连接设置、监听开关全部先进 `mcp/tools.ts` 注册表（轴 B 唯一能力信源）。

## P2 — 图文帖决策路径与推送

**前置**：`feed_post` 现在不进 pipeline（`pipeline.ts:90-158` 只认 live_start/live_end/title_change/health_alert）→ 新增一条与 `live_start` 平行的分支。

- **分支**：`feed_post` → 机械筛选（`filters`，纯确定性）→ `matchPostRules` 取得渠道 → 组装 `PushMessage` → dispatcher；
- **matcher**：新增 `matchPostRules(rules, post)`（`analysis/matcher.ts` 或 `rules/post-matcher.ts`），与 `matchPushRules` 平行、互不影响；
- **文案与图片**：`notify/message.ts` 增加 `postToMessage()`（作者、正文、图片、可点链接）；**图片必须经代理下载后本地化**再交 NapCat（`pbs.twimg.com` 直连超时 [实测]），复用 `image-cache` 思路；
- **去重语义（需确认）**：Nitter RSS 的 `<link>` 指向**原作者**推文 id，按 link 去重会把"同一条推文被多次转发"折叠为一条。默认取"折叠"语义（并记为 `原创`/`转发` 两个不同过滤维度下的同一实体），若要"每次转发都推"须另取 RT 自身 id（[待验证] 项 3）。

## P3 — LLM（规则级，默认关）

- `src/analysis/tasks/translate.ts`：`LlmTask`，schema 进 JSON 出（模子 = `tasks/classify.ts`）；输入推文正文，输出译文。**一律走 `analysis/queue`（并发 2），禁止在轮询循环里直调。**
- `llm_judge` 规则的 `judge_prompt` 即判定口径（人填，不做 NL→结构化编译）；`llm_translate` 控制是否附译文；
- **降级**：LLM 关/熔断/失败 → 回退机械筛选照推；
- `categories`（开播分类）**不参与**图文帖链路。

## 文档连带更新（实现时同批改，别留口径分叉）

| 文档 | 要改的点 |
|---|---|
| `AGENTS.md` | 文件地图：`core/db.ts`「十三表」→ 十五表；新增 `core/proxy.ts`、`core/x-accounts.ts`、`core/post-rules.ts`、`sources/twitter/*`、`analysis/tasks/translate.ts`；轴 A 流程图补 `feed_post` 决策分支与 X 源；轴 B 补 X 页端点 |
| `docs/design.md` | 偏好执行层从"push_rules v2 一张表"扩为"开播规则 + 图文帖规则两张平行表"；数据获取层补 X 源（独立名单，非主播附属） |
| `docs/status.md` | 未实现清单补 `x_accounts` / `post_rules` 两表、X 分页与两个前端模块 |
| `docs/modules/panel.md` | `/api/x*`、`/api/post-rules*`、`/api/listen/twitter` 路由契约；新前端模块与视图 |
| `docs/research/twitter.md` §5 | 「与 DD-claw 的落点」需按本计划改写：uid 语义、独立名单、独立分页 |

## 验收

1. `npm run probe-x` 能列出两条路线当天的推文，并正确统计转发/带图/最新时间；实例全挂时给出可读原因而非空结果。
2. **UI 走完 §I 的 8 步**：全部设置可在 X 分页完成，不需要手改配置文件或数据库，也不需要离开该页（渠道除外，按引导跳转）。
3. 关掉代理 → 只告警，**不产生「没有新推文」的静默假象**；恢复后自动继续。
4. **开播路径零回归**：设置页（监听卡 / 抓取设置 / 分类 / 推送规则）与时间表、主播列表行为不变（`?demo=1` 回归）；`npm test` + `npm run typecheck` 全绿。
5. `npm run webui:dev` + `?demo=1` 下 mock 与真实后端同构（§J）；新增解析函数带单测（注入式 fetcher，模子 = `weibo/feed.test.ts`）。

## 风险与纪律

- **时效性**：Nitter 实例随时死/限速、X 页面结构随时变（2026-08-24 X 已向 Nitter 发停止函）。解析必须防御式，**空结果要区分"没有新推文"与"抓取失败"**。
- **单点**：代理挂 = X 源全停；实例挂 = 降级到 `web.ts`；两者都挂 = 告警。
- **命名/组队的非对称**（需知情）：微博是**主播的附属数据源**（用于预告，绑 `streamers.weibo_uid`），X 是**独立的图文推送源**（独立名单）。用户既已提出"推特和微博作为独立于 B站来源的图文推送渠道"，未来若要把微博也独立出来，是另一次迁移，不在本计划内。
- **法律定位**：低风险**非授权**渠道（违反 X 条款，可能被停止函/封号波及），不是合规方案；项目一贯只读、不写操作。