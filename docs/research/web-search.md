# 网页检索与平台账号搜索

基准日 **2026-10-29**（本机实测）。回答一个问题：agent 要「把名字换成真账号」，有哪些接口可以用、
各自能拿到什么、哪里会断。平台接口的实现坑汇总在 [boundaries.md](../boundaries.md) §5，本文只留证据与取舍。

## 结论

| 需求 | 路线 | 结论 |
|---|---|---|
| 网页事实检索 | DeepSeek Search API `POST /v1/tools/search` | [实测] 可用，与 chat 共用一把 DeepSeek key |
| B站账号名搜索 | `x/web-interface/wbi/search/type?search_type=bili_user` | [实测] 匿名可用（UA + 搜索页 Referer） |
| 微博账号名搜索 | `weibo.com/ajax/side/search?q=` | [实测] 匿名可用，但只有**昵称前缀**的少量建议 |
| 微博精确昵称 → uid | 访客 cookie + `m.weibo.cn/n/<昵称>` 302 | [实测] 仍可用（反方向 uid→昵称已废） |
| 微博全站模糊搜索 | `getIndex` / `s.weibo.com/user` / `weibo.com/ajax/search/*` | [实测] 全部要登录态，匿名不可用 |
| X 账号名搜索 | 无官方/免登录接口 | [实测] 不存在；改用「网页检索挖 handle + x.com 校验」 |

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

## 微博

**匿名可用（实测，无需登录）**：

- `GET https://weibo.com/ajax/side/search?q=<词>`（桌面 UA + `Referer: https://weibo.com/`）→
  `data.users[]` 完整用户对象（`idstr` / `screen_name` / `description` / `followers_count` /
  `verified` / `location`），`data.user[]` 是同一批的 `{uid, nick}` 简表。
  行为像**昵称前缀补全**：`微博` / `李现` / `央视新闻` 有结果，`mygo` / `立石凛` / `羊宫` 为 0——
  覆盖人气账号，不覆盖长尾。最多几条，没有翻页。
- `m.weibo.cn/n/<昵称>` + 访客 cookie → 302 到 `/u/<uid>`（`resolve.ts` 的生产路径，本次实测
  `羊宫妃那` → `/u/1889464875`）。**注意**：浏览器里残留一份过期的登录 cookie 时，该请求会被踢到
  `login.sina.com.cn`，与「昵称不存在」表现不同；`resolveUid` 只把 `visitor.passport` 跳转判为
  访客 cookie 失效，遇到登录跳转会报「跳转目标无法识别」。

**匿名不可用（实测全部 302 到登录页）**：

- `m.weibo.cn/api/container/getIndex?containerid=100103type%3D3%26q%3D...`（用户搜索）
- `s.weibo.com/user?q=...`
- `weibo.com/ajax/search/{users,all,hot,profile}`（`sso/login.php` 重定向）
- `m.weibo.cn/api/config` 显示 `login:false`（本机 weibo-cookies 已过期，本次实测前提）

因此微博侧的产品口径是：**搜索建议 + 精确昵称解析**，模糊搜索要等登录态恢复再补（当前不实现）。

## X：没有免登录账号搜索

逐条排除（2026-10-29 实测，经本机 HTTP 代理 `127.0.0.1:7890`）：

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

## 实现落点与成本

- `src/search/web.ts` — DeepSeek Search 客户端（单次检索 + 408/429/5xx 重试一次）。
- `src/search/config.ts` — key 解析：settings `search_key` 优先，缺省回退到 baseURL 指向
  `api.deepseek.com` 的启用 LLM 供应商的 key（同一把 key，零配置可用）。
- `src/sources/{bili,weibo,twitter}/search.ts` — 三条平台搜索/发现客户端。
- 能力面：`web_search` / `search_bili_accounts` / `search_weibo_accounts` / `search_x_accounts`
  （admin、只读）；设置页「网页搜索」卡只写 `search_key`（进撤销栈，审计日志值打码）。

成本量级：每次检索 1 次成功请求 = $0.00075；「加一个组合 5 人」约 6 次检索 ≈ $0.005。可忽略。

## 复核锚点

- DeepSeek 端点的价格 / QPS / 计费起点以官方指南为准（2026-11-01 起计费）。
- B站搜索的 wbi 签名要求可能收紧；出现稳定 `-352` 时补签名而不是降级成网页抓取。
- 微博搜索建议的匿名窗口随时可能关闭（观察 302/403 即可识别）。
