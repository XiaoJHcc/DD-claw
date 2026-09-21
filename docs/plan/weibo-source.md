# 微博图文来源实施计划（与 X 同构）

> 状态：**已落地（2026-09-17）**。前置：X/推特 P0–P3 已落地（[twitter-source.md](twitter-source.md)）——本计划是把微博从「主播的附属数据源」升级为**与之平行的第二条独立图文来源**，并把这部分补进图文分页。
> 一句话：**微博与 X 现在走同一条图文链路**（独立名单 → 源 → `feed_post` → 图文帖规则 → 推送），差别只剩「微博要登录态、X 要代理」。

## 起点（为什么要做）

| | 迁前 | 迁后 |
|---|---|---|
| 名单 | `streamers.weibo_uid`（**附属**：只有 B站主播能绑微博） | `weibo_accounts`（**独立**：独立博主也能加；`bili_uid` 只是可选关联） |
| 帖子归属 | `posts.uid` = **B站 uid**（供主播卡第三栏混排） | `posts.uid` = **微博账号 uid**（与 X 存 screen name 同语义；第三栏改由关联反查） |
| 推送 | `feed_post` 被 `pipeline` **显式跳过**（只认 `platform==='twitter'`） | 与 X 同一分支：机械筛选 → 图文帖规则 → 推送（微博图直连下载后交 NapCat） |
| 规则 | `post_rules.accountIds` 只指 `x_accounts.id` | 新增 `platform` 列，规则按平台分流（两张名单的自增 id 会撞） |
| 面板 | 微博只有一行登录态 + 抓取间隔 | 与 X 同构的账号卡片墙，单墙混排 + 平台筛选胶囊 |

## 已定决策（2026-09-17，用户选定）

1. **独立表 `weibo_accounts`**（镜像 `x_accounts`）：uid / 昵称 / 可选关联主播 / 启停 / 增量游标 / 最近抓取 / 头像。
2. **帖子归属改按微博账号 uid**，**主播卡第三栏经「关联主播」反查继续混排**（对用户透明），老库一次性迁移。
3. **图文页单墙混排 + 平台筛选胶囊**（全部 / X / 微博）：卡片带平台角标——规则按平台分流，用户必须一眼看出规则落在哪。

## 数据模型

```sql
-- 第 16 张表：微博独立关注名单（独立于 streamers/follows，与 x_accounts 同构）
CREATE TABLE IF NOT EXISTS weibo_accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  uid           TEXT    NOT NULL UNIQUE,   -- 微博数字 uid（weibo.com/u/<uid>）
  nickname      TEXT,                      -- 昵称（抓到就回写；也可人填）
  bili_uid      TEXT,                      -- 可选关联主播（引用 streamers.uid；仅展示/文案/第三栏混排）
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_post_id  TEXT,                      -- 增量游标（只往前推，按数值比较）
  last_post_at  INTEGER,
  last_ok_at    INTEGER,                   -- 健康可视化：区分「抓过」与「从没成功」
  avatar        TEXT,                      -- 本地头像文件名（cache/weibo-avatars）
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- post_rules 增列（旧库 ensureColumn 在线补，默认 'twitter' 即正确）
ALTER TABLE post_rules ADD COLUMN platform TEXT NOT NULL DEFAULT 'twitter';
```

**一次性数据搬家**（`Db.migrateWeiboAccounts`，settings 闸门 `migrated_weibo_accounts_v1`）：

1. `streamers.weibo_uid` → `weibo_accounts`（昵称照抄、`bili_uid` 回指原主播、`enabled = watch`）；
2. `UPDATE posts SET uid = <微博 uid> WHERE platform='weibo' AND uid = <B站 uid>`（帖子归属改写；B站动态不受影响）。

为什么用闸门而不是条件判断：改写后 `posts.uid` 已是微博 uid、与 `bili_uid` 不再相等，重跑本就是空操作——闸门只是让「只跑一次」显式可读。

## 落地清单

| 交付 | 位置 | 说明 |
|---|---|---|
| 名单类型与映射 | `core/weibo-accounts.ts` | `normalizeWeiboUid`（收 `2203177060` / `u/…` / `weibo.com/u/…`）、`isValidWeiboUid`、源运行状态快照 `WeiboFeedSnapshot` |
| 表 + 仓储 + 迁移 | `core/db.ts` | CRUD / `touchWeiboAccount`（只更新传入字段，空昵称不擦好昵称）/ `unlinkWeiboAccountsFromBili` / `listRecentPostsMixed`（主播卡第三栏反查混排） |
| 规则平台化 | `core/post-rules.ts` + `analysis/matcher.ts` | `platform` 列 + `matchPostRules` 按平台过滤 + `postAuthorName` / `defaultPostTitle`（微博用昵称、X 用 @账号） |
| 源 | `sources/weibo/feed.ts`（重写）+ `sources/weibo/avatar.ts`（新） | 轮 `weibo_accounts(enabled)`；`posts.uid` = 微博 uid；游标/昵称/`last_ok_at` 回写；每轮 `onStatus` 上报；头像直连下载落 `cache/weibo-avatars` |
| 推送分支 | `core/pipeline.ts`（`handleFeedPost`） | 两个平台共用：账号在各自名单查、规则按平台匹配；**图**：X 走代理隧道 / 微博图床境内直连 `localizeImage` |
| 推送文案 | `notify/message.ts` | 副行 `微博 · 昵称` / `X · @账号`；默认推送词「… 发了新微博 / 新推文」 |
| LLM | `analysis/tasks/post-analysis.ts` | 提示词按平台措辞（平台/账号/「微博正文」）；**翻译只对 X**（微博本就中文） |
| 面板 | `panel/server.ts` + `panel/http-util.ts` | `GET /api/weibo`（状态快照，当前面板不消费）、`/api/weibo/accounts` CRUD、`/api/weibo-avatar`；规则校验按平台查名单；主播详情填微博昵称时联动建/关联网名单行（`syncStreamerWeiboLink`，面板与 MCP 共用） |
| 装配 | `index.ts` | 微博源的运行前提仍是登录态，但**名单为空不启动**；间隔/名单指纹变化就地重启；状态快照给面板 |
| 前端 | `webui/js/x.js` + `index.html` + `style.css` | 单墙混排 + 筛选胶囊 + 平台角标；微博账号浮窗（uid 只读 / 昵称解析）；规则浮窗加「来源」行，微博不出「引用」「附译文」两枚胶囊。**微博卡本身零改动**（仍只有登录态一行） |
| mock 同构 | `webui/demo/mock-api.js` + `mock-data.js` | `/api/weibo*`、规则的 platform 校验与报错文案、3 条演示规则（2 X + 1 微博）、2 个微博账号（含一个未关联主播的独立博主） |
| 轴 B | `mcp/tools.ts` | `list_weibo_accounts`（shared）、`upsert_weibo_account` / `delete_weibo_account`（admin）；`upsert_post_rule` 收 `platform`；`set_streamer` 联动微博名单 |
| 测试 | `weibo/feed.test.ts`（重写）/ `db` / `matcher` / `pipeline` / `server` / `mcp` | 迁移幂等、平台隔离、文案与账号范围、微博规则的两条拒绝路径、源的状态快照与游标回写 |

## 实现中确认/修正的点

1. **微博没有「引用」这种形态**：转发在抓取层就折进 `type='retweet'`（正文拼 `//转发自 @原作者`），没有像 X `quoted_tweet` 那样的独立实体。所以微博规则带 `filters.quote=true` 或 `llmTranslate=true` 一律**保存时 400**——放一个永不命中的勾/开关是骗人（与「原创/转发都不勾 = 死规则」同一条纪律）。面板索性不出这两枚胶囊，MCP 会明确报错。
2. **两张名单的自增 id 会撞**，所以 `platform` 不是装饰：`accountIds` 离开 platform 没有意义。换平台的 PUT（多数来自 MCP）在没带新名单时**清空 `accountIds`**，否则规则会指向另一个平台里同号的账号。
3. **微博头像用直连下载**（`sinaimg.cn` 境内可达），不走 X 那条代理隧道；字段优先 `avatar_large`。头像 URL 带签名与过期参数（同一头像每轮 URL 也可能不同），所以按 URL 的 md5 落盘、且只在还没有本地头像时下载一次——换头像不更新本地缓存（删号重加才会）。帖子图复用 `localizeImage` 时按域带 `Referer: weibo.com`（sinaimg 对外站 Referer 防盗链，见 `boundaries.md` #38）。
4. **状态快照是「抓不到 vs 没新帖」可区分的前提**：`WeiboFeedSnapshot`（`accounts/okAccounts/lastOkAt/lastError`）由源每轮回写，`GET /api/weibo` 只读快照、绝不打网络。**面板微博卡保持原样（只有登录态一行），不展示这份快照**——它是可观测证据与后续扩展点（用户 2026-09-17 决定：微博卡不加监听/抓取行）。
5. **名单为空不启动**（与 X 同一条判据）：不然面板会显示「运行中」却什么都不抓。
6. **`posts.uid` 语义变更的连带**：`listRecentPostsMixed` 是唯一读取点（`/api/streamers` 的 enrich），其余查询都按 `platform + uid` 精确取（账号卡的帖子段用 `searchPosts`）。
7. **不加「填 uid 就验证账号存在」**：X 有便宜的免登录存在性接口（`tweet-result`），微博没有等价的匿名接口——硬加等于把添加流程挂在一个未实测的端点上。填昵称时走匿名解析链（解析不到即 400），只填 uid 时不校验，抓取失败由告警兜住（见 `docs/boundaries.md`）。

## 边界 / 未做

- **不写微博**（不转发、不点赞、不关注）；只读。
- **微博关注列表不同步**（仍以 B站关注为候选池；`design.md` §10 的待定项不变）。
- 微博帖**不做「引用」筛选**（见上 §1）；**不做翻译**（正文本来就中文）。
- 面板端点的 REST 收敛到能力面注册表仍未做（`docs/plan/agent-access.md`）；本次只保证**同一能力同时进注册表**。

## 验收（已做）

1. `npm test` 544/544、`npm run typecheck` 全绿。
2. `?demo=1` 浏览器实测：单墙混排（3 X + 2 微博，含一个未关联主播的独立博主）、筛选胶囊计数、平台角标、微博账号浮窗（uid 只读 + 昵称 + 关联主播 + 规则区）、规则浮窗「来源 = 微博」且不出「引用/附译文」、增删改与就地报错（409 重名 / 400 昵称找不到 / 400 引用 / 400 翻译）；**微博卡与改动前逐字一致**（只有登录态一行）。
3. 迁移在 `db.test.ts` 里用「旧 schema 库」端到端验证：种子 + 归属改写 + 二次打开幂等。
4. **开播路径零回归**：设置页、时间表、主播列表行为不变（第三栏混排由 `listRecentPostsMixed` 保持）。
