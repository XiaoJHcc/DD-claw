# 调研：动态与微博（预告数据源）

基准日 2026-07-29。这是本项目**最难拿**的数据源。

## 结论

**匿名全灭，必须凭据。** B站动态 412、微博 432，且都不是靠补签名能解决的。

（2026-08-03 修订：**「自己带 cookie 直连」已在动态接口跑通**——全量 cookie + dm 三参即可，详见下节修订块，项目已选这条路实现 `src/sources/bili/dynamic.ts`；RSSHub 不再是动态源的必选项。微博 432 结论不变。）

选型：**自建 RSSHub** 或**自己带 cookie 直连**，二者都要凭据。开播状态**不走**这条路。

## B站空间动态 [实测]

> **2026-08-03 修订（已推翻下方 412 旧结论）**：`feed/space` 带**扫码登录全量 cookie**（cookies.json 5 个字段即够）+ **dm 三参**（`dm_img_list` 按 RSSHub `getDmImgList` 高斯算法现场生成；`dm_img_str`/`dm_cover_img_str` = `bm8gd2ViZ2w`，即 base64('no webgl') 去 padding）+ `Referer: https://space.bilibili.com/<uid>/` + 桌面 UA → **HTTP 200 / code 0**，**不需要 WBI 签名**。参数：`offset=&host_mid=<uid>&platform=web&features=itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote`。已实现为 `src/sources/bili/dynamic.ts`（解析 `parseDynamicItem`）+ `src/sources/bili/dm.ts`（dm 参数生成），实测 22 个 uid 全量归档零 412，返回含 `DYNAMIC_TYPE_LIVE_RCMD` / `AV` / `DRAW` / `WORD` / `FORWARD` / `ARTICLE`。
>
> 当年 412 的真正原因不是 WBI，而是缺全量 cookie 或 dm 参数用静态占位（占位值无效，必须现场生成）。间歇性 412 / `-352` 仍可能出现：按「跳过本轮、保留旧数据、连续失败计数告警」处理（见 `docs/boundaries.md` §5.19）。

```
GET https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=<uid>
→ HTTP 412（风控页面，非 JSON）  ← 匿名/缺 dm 参数时的表现；带齐上述组合可通（见上修订）
```

关键：agent 完整实现了一遍 WBI 签名（`nav` 取 `img_key`/`sub_key` → mixin key 重排 → 参数升序拼 `wts` → MD5 算 `w_rid`），**签名正确后仍然 412**。（2026-08-03：方向错了，该接口根本不看 WBI，看 cookie + dm 指纹。）

### 412 与 -352 是两条不同的失败路径

| 码 | 含义 | 例子 |
|---|---|---|
| `-352` | 签名缺失/错误 | `x/space/wbi/acc/info` 不签名 → `{"code":-352,"message":"风控校验失败","data":{"v_voucher":"..."}}` |
| `412` | 设备指纹 / IP 风控 | `web-dynamic/feed/space` 即使签名正确 |

动态接口踩的是后者，**更难绕**。还需要 `dm_img_list`、`dm_img_str`、`dm_cover_img_str`、`dm_img_inter` 这类设备指纹参数，而它们有生成算法（RSSHub 源码里叫 `addDmVerifyInfo` / `getDmImgList`），[实测] **填静态占位值无效**。

旧接口 `api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/space_history` [实测] 同样 412 —— 免签替代接口这条路已堵死。

### 动态类型与字段

| 类型 | 说明 | 评论 oid | 评论 type |
|---|---|---|---|
| `DYNAMIC_TYPE_WORD` | 纯文字 | 动态 id | 17 |
| `DYNAMIC_TYPE_DRAW` | 带图 | 相簿 id | 11 |
| `DYNAMIC_TYPE_AV` | 投稿视频 | avid | 1 |
| `DYNAMIC_TYPE_LIVE_RCMD` | **开播提醒** | 动态 id | 17（rid 是 live_id） |
| `DYNAMIC_TYPE_FORWARD` | 转发 | 动态 id | 17 |

字段路径 [文档]：

- 文字：`modules.module_dynamic.desc.text`；图文动态在 `major.opus.summary.text`
- 图片：`major.opus.pics[].url` / `major.draw.items[].src`
- 时间：`modules.module_author.pub_ts`（秒级）
- **预告识别**：`major.type === 'MAJOR_TYPE_LIVE_RCMD'`，其 `major.live_rcmd.content` 是一个**需要二次 `JSON.parse` 的 JSON 字符串**，内含 `live_play_info.{title, room_id, area_name}`

可直接抄的解析实现：[RSSHub dynamic.ts](https://raw.githubusercontent.com/DIYgod/RSSHub/master/lib/routes/bilibili/dynamic.ts) 的 `getTitle`/`getDes`/`getImgs`/`getUrl` 四个函数覆盖了所有 case。

## 微博 [实测]

```
GET https://m.weibo.cn/api/container/getIndex?type=uid&value=<uid>
→ HTTP 432（微博的验证码/风控码），无 body
```

游客 cookie 流程也已失效：

1. `POST passport.weibo.com/visitor/genvisitor` → 200，拿到 `tid`
2. `GET passport.weibo.com/visitor/visitor?a=incarnate&t=<tid>` → 200，`Set-Cookie` 返回 `SUB`/`SUBP`/`SRT`（**weibo.com 域**）
3. 带这些 cookie 请 `m.weibo.cn/api/container/getIndex` → 302 到 `passport.weibo.com/sso/signin`，落地**登录页 HTML**（页面内嵌 `wbBotDetector`、`passport.sinaimg.cn/js/fp/...` 人机验证 SDK）
4. 换 `visitor.passport.weibo.cn` 那条链路 → `{"ok":-100, "url":"https://passport.weibo.com/sso/signin?..."}`

`ok:-100` 正是 RSSHub 源码里用来判断「cookie 需要更新」的条件。

其他要点 [文档]：

- 长文：`mblog.isLongText=true` 时 `text` 被截断，完整正文请 `m.weibo.cn/statuses/show?id=<bid>` 取 `data.text`（RSSHub 里叫 `getShowData`，比 `/statuses/extend` 更稳）
- 转发：`mblog.retweeted_status` 是完整嵌套 mblog，递归同一套解析
- 频率建议：单账号 ≥1-2 分钟/用户 [待验证]

## RSSHub 评估

**维护状态最健康的选项**：[实测] `pushed_at: 2026-07-29`（当天有提交），45454 star，未归档。

源码里的路由声明，直接印证了我们的实测结论：

| 路由 | 声明 |
|---|---|
| `/bilibili/user/dynamic/:uid` | `requireConfig: [{ name: 'BILIBILI_COOKIE_*', optional: true, description: "如果没有此配置，那么必须开启 Playwright 支持" }]` |
| `/weibo/user/:uid` | `requirePuppeteer: true, antiCrawler: true` |

**一个 45k star、每天有提交的项目也只能靠真实浏览器或 cookie 解决**，这不是我们靠手写签名能绕过的。

它已经解决的问题（自己写要持续跟着风控改）：

- 动态下载 B站 JS 文件解析 mixin key 重排表（比硬编码抗变动）
- `-352` 时重试 + 清空缓存
- 微博 `ok:-100` 自动续 cookie、432 静默重试
- 长文展开、转发递归、图片/视频提取

**公共实例不可用** [实测]：`rsshub.app` 超时，`rsshub.rssforever.com` 503，`rsshub.pseudoyu.com` / `rss.shab.fun` 连接失败。**必须自建。**

代价：自建实例要跑 Playwright（服务器需装 Chromium）或维护会过期的 cookie。

### 本项目的取法

RSSHub 是**独立进程的数据源服务**，我们的 source 只消费 RSS/JSON over HTTP。这不是「语言混杂」而是干净的解耦。

但既然 cookie 方案下 RSSHub 也只是代我们带 cookie，M3 阶段可以先评估：直接自己带 cookie 请求 + 抄 RSSHub 的解析逻辑，是否比多维护一个 Node 服务更简单。两条路都保留。

## 评论区

- `x/v2/reply?type=1&oid=<avid>&sort=0`（旧接口）[实测] **200，游客可读**。文档标注需 Cookie，但实测不带也能拿到公开视频评论 —— 登录只影响个性化字段。
- `x/v2/reply/wbi/main` [实测] 不签名 → `{"code":-403,"message":"访问权限不足"}`
- 动态评论用 `type=17` + 动态 id，[实测] 试了一次返回 `-404 啥都木有`（可能是样本动态本身没评论，也可能 oid 取法不对）—— **未跑通，实现前需用一条确认有评论的动态验证**
- 识别「UP主自己的回复」：没有过滤参数，只能拉全量后按 `member.mid === 主播mid` 本地过滤。另有 `up_action.reply` 表示「该评论被 UP 主回复过」[文档]

## 备选：weibo-crawler

`dataabc/weibo-crawler` [实测] `pushed_at: 2026-07-22`，4588 star，未归档，活跃。支持免 Cookie 模式（功能打折）。可作为不想上 Playwright 时的低频兜底。

npm 侧没有维护活跃的原生微博爬虫库。

## 去重与预告判定

**去重**：用平台的全局唯一 id（B站 `id_str`、微博 `mblog.id`/`bid`）建 `(platform, uid, item_id)` 表。**不要用时间戳判新旧** —— 编辑/置顶会让时间戳不稳定，时间戳只用于排序展示。

**预告判定分层**，越靠前越可信：

1. **结构化信号**（零成本、高可信）：`MAJOR_TYPE_LIVE_RCMD` 或 `ADDITIONAL_TYPE_RESERVE`（预约卡片）→ 直接解析 `live_play_info`，不需要 NLP
2. **关键词 + 时间正则**：「直播/开播/预告/晚点/不播了/停播/取消/改到」+「今晚8点 / 19:30 / 下午三点」
3. **LLM 抽取**：自由文本兜底

**抽不出确定时间 → 标记低置信度入库，消费端按置信度阈值过滤，不自动改时间表。** 预告文本自由度太高，误判会写错时间表。（2026-07-30 修订：运行管线无人工环节，原「人工确认队列」方案废弃。）

评论区的「晚点开播」同理，但**只匹配 mid 等于主播本人的评论**，忽略路人。

## 轮询频率建议

| 数据源 | 间隔 |
|---|---|
| 开播状态 | 30-60s（不走本模块） |
| B站动态 / 微博 | 3-10 分钟（预告一天就 1-2 条，更频繁只增风险） |
| 评论区 | 平时不扫；仅对「已有预告待验证」的 uid 在预告时间前后 30 分钟内 2-3 分钟一次 |

