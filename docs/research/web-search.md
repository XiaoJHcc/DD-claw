# 网页检索与平台账号搜索

基准日 **2026-10-29**（本机实测）；**2026-11-03** 复核账号发现链路（官方文档 + 代码事实，未真机验收的部分单独标注）。
回答一个问题：agent 要「把名字换成真账号」，有哪些接口可以用、各自能拿到什么、哪里会断。
平台接口的实现坑汇总在 [boundaries.md](../boundaries.md) §5，本文只留证据与取舍。

## 结论

| 需求 | 路线 | 结论 |
|---|---|---|
| 网页事实检索 | DeepSeek Search API `POST /v1/tools/search` | [实测] 可用，与 chat 共用一把 DeepSeek key |
| B站账号名搜索 | `x/web-interface/wbi/search/type?search_type=bili_user` | [实测] 匿名可用（UA + 搜索页 Referer）；没有 discover / suggest 之分 |
| 微博输入建议 | `weibo.com/ajax/side/search?q=` | [实测] 匿名可用，但只有**昵称前缀**的少量建议 |
| 微博账号搜索 | 登录 cookie 全站 `getIndex` → 匿名侧栏建议 → 精确昵称解析 | [实测] 本机登录 cookie 下 200 + cards，可命中未认证长尾账号；suggest 与 discover 有 cookie 都先走全站搜索，suggest 不补精确解析；无 cookie 时只走匿名建议 |
| 微博精确昵称 → uid | 访客 cookie + `m.weibo.cn/n/<昵称>` 302 | [实测] 仍可用（反方向 uid→昵称已废） |
| X 账号发现（有 Apify token） | Apify People 搜索（Actor `arjun_code~x-twitter-people-search-scraper`） | [实现] **未真机验收**；按资料计费 |
| X 账号发现（无 token，或 Apify 失败 / 空结果） | 网页检索挖 `x.com/<handle>` + x.com 校验 | [实测] 只能证明「handle 存在」 |
| X 官方账号搜索 | 官方 v2 `GET /2/users/search` | [文档] 存在，但需 OAuth 2.0 **用户上下文**、按用户资料计费，**本期不接入** |
| X 免登录站内账号搜索 | v1.1 `users/search` / `typeahead`、Nitter 搜索 | [实测] 均不可用 |

## DeepSeek Search / Fetch API

官方指南：<https://api-docs.deepseek.com/guides/search>。2026-10-17 上线，两个独立端点：
`POST https://api.deepseek.com/v1/tools/search` 与 `/v1/tools/fetch`。

- **鉴权**：`Authorization: Bearer <DeepSeek API Key>`，与 chat 同一平台 key、同一 base URL。
- **计费**：每 1000 次**成功**请求 $0.75（失败 / 空结果 / 超时不计费）；北京时区 2026-11-01 起计费。
- **限流**：Search 100 QPS、Fetch 25 QPS（账号级，与模型并发分开）。
- **请求**：`query`（1~128 字，支持 `site:` / `-` / `"..."` / `lang:` / `after:` 等运算符）、
  `count`（1~50）、`ori_question`、`need_content`（true 时回正文，计费不变）。
- **响应**：`results[]`，每项含 `title` / `url` / `snippet`（100~200 字）/ `summary`（600~800 字）/
  `date` / `site_name` / `authority` / `rerank_score`。
- **错误**：OpenAI 兼容错误体；401 key、402 余额、429 限流，408/429/5xx 可重试。

本机实测（2026-10-29，用项目里已配置的 DeepSeek key）：`羊宮妃那 Twitter`、`MyGO!!!!! メンバー キャスト
Twitter`、`Ave Mujica キャスト X アカウント` 均 200 且命中相关页；从 PTT / 官网 / 新闻正文里能抠出
`x.com/<handle>/status/...` 与 `@handle`（Ave Mujica 一次查询命中 5 个正确 handle：
`sasakirico` / `Kanon_Takao` / `AkaneY_banu` / `Watase_Yuzuki` / `okada_mei0519`）。

**两个必须记住的局限**：

1. `site:x.com` / `site:twitter.com` 返回 **0 条**（X 页面不进索引），不能当「X 站内搜索」用；
   能挖到 handle 的场合都是**第三方页面正文里引用了推文链接**。
2. 同一批结果里会出现错号/旧号（实测 `羊宮妃那` 同时命中 `Hina_Youmiya` 与 `youmiya_hina`），
   所以候选必须再经 x.com 校验或人工确认。

## B站用户搜索

- **可用路径**：`GET https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=bili_user&keyword=<词>&page=1`。
  本机实测连打 3 次均 200、响应 36KB 稳定。
- **必须带**：`User-Agent` + `Referer: https://search.bilibili.com/`。**必须用 `wbi` 前缀的路径**：
  非 wbi 的 `/x/web-interface/search/type` 直接 **412**（HTML 风控页）。
- **不需要**：cookie / wbi 签名（`w_rid`）。2026-10-29 实测未签名同样 200；B站按端点灰度，
  若日后开始稳定 `-352`，按 WBI 算法补 `img_key`/`sub_key` 与 mixin 表。
- **字段**：`mid` / `uname` / `usign`（签名）/ `fans` / `level` / `official_verify{type,desc}` /
  `is_live` / `room_id` / `upic`（头像，注意不是 `face`）。搜索词支持部分名字，
  `mygo` 的首条即官方号 `MyGO_AveMujica`（mid 1459104794）。
- **模式**：B站只有这一条远程搜索，`mode` 参数对结果没有影响；输入框候选与 Agent 发现拿到的是同一份结果。

## 微博

### 匿名可用（2026-10-29 实测，无需登录）

- `GET https://weibo.com/ajax/side/search?q=<词>`（桌面 UA + `Referer: https://weibo.com/`）→
  `data.users[]` 完整用户对象（`idstr` / `screen_name` / `description` / `followers_count` /
  `verified` / `location`），`data.user[]` 是同一批的 `{uid, nick}` 简表。
  行为像**昵称前缀补全**：`微博` / `李现` / `央视新闻` 有结果，`mygo` / `立石凛` / `羊宫` 为 0——
  覆盖人气账号，不覆盖长尾。最多几条，没有翻页。
- `m.weibo.cn/n/<昵称>` + 访客 cookie → 302 到 `/u/<uid>`（`resolve.ts` 的生产路径，本次实测
  `羊宫妃那` → `/u/1889464875`）。**注意**：浏览器里残留一份过期的登录 cookie 时，该请求会被踢到
  `login.sina.com.cn`，与「昵称不存在」表现不同；`resolveUid` 只把 `visitor.passport` 跳转判为
  访客 cookie 失效，遇到登录跳转会报「跳转目标无法识别」。

### 匿名不可用（实测全部 302 到登录页）

- `m.weibo.cn/api/container/getIndex?containerid=100103type%3D3%26q%3D...`（用户搜索）
- `s.weibo.com/user?q=...`
- `weibo.com/ajax/search/{users,all,hot,profile}`（`sso/login.php` 重定向）
- `m.weibo.cn/api/config` 显示 `login:false`（本机 weibo-cookies 已过期，本次实测前提）

### 登录态全站搜索（有登录态时 suggest 与 discover 都首选）[实测]

`src/sources/weibo/search.ts` 的 discover 在有登录 cookie 时先打：

```
GET https://m.weibo.cn/api/container/getIndex?containerid=100103type%3D3%26q%3D<词>&page_type=searchall
User-Agent: 移动端 UA
Referer: https://m.weibo.cn/
Cookie: <登录 cookie>
```

- 成功判据是响应带 `data` 与 `cards`；若返回 `ok` 且不等于 1，按登录失效/失败处理。用户对象可能嵌在 `card_group` / `cards` 里，需递归收集，
  按 `idstr` 去重，最多取 `limit` 条（上限 20）。命中的结果标 `via='full-search'`。
- 登录搜索返回空 → 回落匿名侧栏建议（`via='search'`）→ 仍空再由精确昵称解析补位
  （`via='nickname'`；搜索层没拿到解析器时由工具层补）。登录搜索**出错**
  （302 / 403 / `ok!==1` / 非 JSON）同样降级到匿名建议，
  但匿名建议也失败或降级后仍无结果时**抛错**，不把网络错误伪装成「没搜到」。
- 卡片里的 `user` 形态不统一：`id` 是数字且常无 `idstr`；`followers_count` 是**字符串**（如 `"2025"`），
  部分卡片干脆不带该字段，映射时归一到数字、缺失记 0。
- `suggest` 模式有 cookie 时同样先走登录全站搜索，空结果或失败回落匿名建议，但不跑精确解析；
  输入框不逐键触发精确昵称解析。
- **验收状态**：已用本机真实登录 cookie 打出 200 与真实 `cards`（长尾未认证账号可命中，如「弥月Mizuki」）；
  登录失效时仍按上面降级/报错处理。

### 产品口径

- **输入建议**：有登录 cookie 时先走全站搜索（覆盖未认证长尾账号），失败或空结果回落匿名侧栏建议，
  不跑精确解析；无 cookie 只有匿名建议。长尾昵称可能 0 条，不能据此断言账号不存在。
- **Agent 发现**：有登录 cookie 时按「登录全站 → 匿名建议 → 精确昵称」三级走完；无 cookie 时只有匿名建议，
  最后仍可由工具层补精确昵称解析。空数组只表示三级都没找到。

## X：账号发现

### 官方 v2 有账号搜索，但本期不用

`GET https://api.x.com/2/users/search`（[文档]，2026-11 复核）：

- 需要 **OAuth 2.0 用户上下文**（用户授权后的 token），app-only Bearer 不够；
- 按 **User read 计费**（$0.010 / 资料，与推文 Post read $0.005 分开计价），单次最多 1,000 条；
- 结果按 X 的 People 相关度排序，不是稳定的「精确昵称 → 唯一账号」。

**本项目不接入**：现有配置体系只有平台级 API key，没有 X 用户 OAuth 授权流程；为「把名字换成候选」
再维护一套用户 token 与逐资料计费不划算。免登录 v1.1 `users/search` / `search/typeahead` 已 404
（2026-10-29 实测），与 v2 的存在并不矛盾——**「没有免登录账号搜索」成立，「没有官方账号搜索」不成立**。

### 有 Apify token：People 搜索（首选）

`src/sources/twitter/apify-search.ts` 调 Actor
[`arjun_code~x-twitter-people-search-scraper`](https://apify.com/arjun_code/x-twitter-people-search-scraper)：

- 不需要 X 账号 / cookie / 代理；Actor 内部用 X 原生 People 搜索，返回扁平化的真实 profile
  （`screen_name` / `name` / `description` / `followers_count` / `verified` / `is_blue_verified` /
  `profile_image_url` / `location` / `website_url` / `tweets_count` / `user_id`）。
- 调用形态是**异步 run + 数据集**：`POST /v2/acts/<actor>/runs?token=…&waitForFinish=0`（一次只放一个
  `searchQueries`，`maxUsersPerQuery=limit`）→ 轮询 `actor-runs/<id>` → 读 `defaultDatasetId` 的 items。
  项目设定：`limit` 夹在 1–10、单请求超时 30s、整轮上限 120s、轮询间隔 2s。
- 计费是 **pay per event**：`search-user-result` $0.0005 / 成功保存的资料，另加极小的 Actor start；
  `no_results` / `invalid_input` / `partial` / `request_failed` 状态记录不计资料费。
  10 条候选 ≈ $0.005。
- 结果语义：`status='no_results'` → `[]`（确实没匹配）；`partial` / `request_failed` / run 失败 /
  超时 → 抛中文错误，由调用方回退网页路线；token 只出现在请求 URL，错误文本统一脱敏。
- **验收状态**：只有替身单测（请求构造、轮询、状态映射、脱敏），**没有真正跑过 Actor**。本机对
  `api.apify.com` 的可达性、真实 run 的字段/延迟/计费与失败形态都**未验收**。

### 无 token，或 Apify 失败 / 空结果：网页发现（兜底）

逐条排除的免登录尝试（2026-10-29 实测，经本机 HTTP 代理 `127.0.0.1:7890`）：

| 尝试 | 结果 |
|---|---|
| `api.x.com/1.1/search/typeahead.json?q=...&result_type=users` | 404（接口下线） |
| `api.x.com/1.1/users/search.json?q=...`（guest token） | 404（v1.1 已下线） |
| `POST api.x.com/1.1/guest/activate.json` | 200，仍能拿 guest token，但已无搜索端点可用 |
| Nitter `/<host>/search?f=users&q=` | 用户配置的 `nitter.jaydenha.uk` 返回「Search has been disabled due to abuse」；其余实例 451/403/429/连接失败；`nitter.net` 已下线；nitter 仓库 2026-10-09 归档 |
| `x.com/search?q=...` 免登录 HTML | 登录墙 |
| `site:x.com` 搜索 | 0 条（见上） |

**采用的替代路线**：DeepSeek 网页检索 `<名字> twitter`（必要时补 `<名字> x.com`）→ 从
url / 标题 / snippet / summary 里抠 `x.com/<handle>` 与 `@handle`（剔除 `i` / `intent` / `share` /
`pic` 等保留路径与 `pic.twitter.com` 图片 CDN）→ 候选按命中次数排序 → 用现有 `verifyAccount`
（免登录 HTML + 代理）逐个校验存在性，`not-found` 的候选直接丢弃。
该 HTML 自 2026-10-29 起不再内嵌推文 id，但仍带 `og:title`（`名字 (@handle)`），校验就是靠它
（200 + 抠到显示名 = 存在，顺带拿到显示名；404 = 不存在）。

这条路线**只能证明「handle 存在」，证明不了「这是要找的人」**：候选要带出处片段，让模型/用户判断；
写前询问模式下由主人最后确认。

### 两种模式的分工

| 模式 | 有 Apify token | 无 Apify token |
|---|---|---|
| `discover`（Agent 默认） | Apify 优先；出错或空结果回退网页发现；两条都失败时报组合错误 | 只走网页发现 |
| `suggest`（输入框 / REST 候选） | 只走 Apify，等待上限 120s | **直接报错**提示配置 Apify token，不用网页发现逐键兜底 |

## 实现落点与成本

- `src/search/web.ts` — DeepSeek Search 客户端（单次检索 + 408/429/5xx 重试一次）。
- `src/search/config.ts` — 凭据解析：settings `search_key` 优先，缺省回退到 baseURL 指向
  `api.deepseek.com` 的启用 LLM 供应商的 key（同一把 key，零配置可用）；`apify_key` 独立读取。
- `src/sources/{bili,weibo,twitter}/search.ts` — B站 / 微博 / X 网页发现客户端。
- `src/sources/twitter/apify-search.ts` — Apify People 搜索（有 token 时 X 的首选）。
- 能力面：`web_search` / `search_bili_accounts` / `search_weibo_accounts` / `search_x_accounts`
  （admin、只读），三个账号搜索都带 `mode`（discover / suggest）。
- 面板候选：`GET /api/search/accounts?platform=twitter|weibo|bili&q=` 固定 `limit=5, mode=suggest`，
  直接回候选数组；图文页添加浮窗的名称 / ID 输入框据此出联想，选中后回填 handle / UID。
  X 的输入框候选依赖 `apify_key`；微博有登录态时同样覆盖全站搜索，无登录态时只有匿名建议。
- 批量写入：`upsert_x_accounts` 接受 1–50 个账号，逐项走与 `upsert_x_account` 相同的解析、重复与
  存在性校验，单项失败不阻断其他项；整批只落一条变更记录，可一次撤销。
- 凭据写面：设置页「网页搜索」卡写 `search_key` 与 `apify_key`，各走注册表工具
  `set_search_key` / `set_apify_key`。两者都**可撤销、审计日志值打码、撤销快照不落明文**，
  撤销语义是「清空、要求重填」；早期记录里的明文由启动迁移清理。

成本量级：每次检索 1 次成功请求 = $0.00075；「加一个组合 5 人」约 6 次检索 ≈ $0.005。
Apify 每次 10 条候选 ≈ $0.005；网页发现的 x.com 校验不额外计费。两者都可忽略。

## 复核锚点

- DeepSeek 端点的价格 / QPS / 计费起点以官方指南为准（2026-11-01 起计费）。
- B站搜索的 wbi 签名要求可能收紧；出现稳定 `-352` 时补签名而不是降级成网页抓取。
- 微博搜索建议的匿名窗口随时可能关闭（观察 302/403 即可识别）；登录态全站搜索已实测真实 `cards`，
  失效时的降级仍需继续观察，微博随时可能再收紧（2026-09-20 已收紧 uid→昵称方向）。
- Apify Actor 的输入 / 输出 / 计费与 `api.apify.com` 本机可达性均未实测；Actor 由第三方维护，X 改版即可能失效。
- 官方 `GET /2/users/search` 的 OAuth 要求与单价以 X 官方文档为准；若日后接入，需先建立用户授权与预算控制。
