# 调研：X / 推特监听（图文推送渠道）

基准日 **2026-09-16**。目标：判断能否把指定 X 账号的推文（原创 / 转发 / 带图）作为独立于 B站的图文渠道推送到 QQ 群，可选经 LLM 判定与翻译。

标记沿用 [文档索引](../README.md)：**[实测]** = 本机对真实端点发出过请求并附返回；**[文档]** = 读官方文档/源码，未亲跑；**[待验证]** = 第三方口径或未确认。

> 与子代理文档的关系：本页是唯一权威归档。此前两份分头调研（`x-twitter-2026.md`、`twitter-thirdparty-2026.md`）已合并进本页并删除——它们基于"本机无网络"的前提读文档，其中**「syndication 需要 cookie 才返回时间线」「免登录拉时间线不可行」两条已被本机实测推翻**。

## 结论

**可行，而且比预期容易：存在一条完全免凭据的路线，本机实测能当天拿到最新推文。** 硬前提只有一个——**必须走代理**（本机直连被墙）。四条路线按成本排序：

| 路线 | 凭据 | 转发 | 带图 | 最新推文 | 成本 | 可靠性 |
|---|---|---|---|---|---|---|
| **A. Nitter 实例 RSS** | 无 | ✅ 原生标注 | ✅ `<img>` | ✅ 到当天 | 0 | 实例随时死/限速，法律有争议 |
| **B. 免登录 HTML + tweet-result** | 无 | ❓ 疑似过滤 | ✅ | ✅ 实测当天 | 0 | 依赖页面结构，条数少会漏推 |
| **C. 自建 RSSHub + 可弃小号** | 小号 cookie | ✅ | ✅ | ✅ | 0（+封号风险） | 跟着 RSSHub 跟进 |
| **D. 第三方 API（twitterapi.io）** | API key | ✅ | ✅ | ✅ | 起步 ≈$3/月，50 账号增量 ≈$65–80/月 | 无 SLA，厂商可能被停止函打死 |
| E. 官方 X API | 开发者账号 | ✅ | ✅ | ✅ | 去重后 ≈$37/月；无去重 ≈$10,800/月 | 唯一授权渠道 |

架构上不用新发明：X 源 = 又一个 `Source`，落 `posts`（`platform='twitter'`）、发 `feed_post` 信号，与 `weibo/feed.ts` 同构。

## 1. 环境前提：必须走代理 [实测]

本机（DD-claw 所在 Windows 机）网络状况实测：

| 检查 | 结果 |
|---|---|
| DNS 解析 x.com / google / pbs.twimg.com | 正常 |
| 直连 TCP 443 | x.com/pbs.twimg.com **TCP 通**，但 TLS 握手被 RST 或超时 |
| 直连 `tls.connect({servername:'x.com'})` | **TIMEOUT**（墙特征；百度等境内站点 200 正常） |
| 系统代理设置 | `HKCU\...\Internet Settings`：`ProxyEnable=1`、`ProxyServer=127.0.0.1:7890` |
| 代理端口 | `[::]:7890 LISTENING`（PID 41036），大量 ESTABLISHED 连接 → 代理在跑 |
| `curl.exe -x http://127.0.0.1:7890 https://x.com` | **000（立即失败）**——curl.exe 在此环境下走不通代理 |
| `node fetch` + `HTTPS_PROXY` 环境变量 | **fetch failed**——Node **22.23.2 不认** `HTTPS_PROXY`（`NODE_USE_ENV_PROXY` 是 Node 24+ 才有），且项目未装 `undici` |
| 手写 CONNECT 隧道 + `tls.connect({socket, servername})` | **成功**：x.com `200` / 259KB、google `200`、pbs.twimg.com 可下载 |

**结论（实现前必知）**：DD-claw 接 X 源需要两样东西，都不能靠环境变量解决——
1. 一个**代理配置项**（`settings` 唯一信源，面板可填，如 `http://127.0.0.1:7890`）；
2. 一个**隧道版 fetch**。最小可用实现（约 30 行，已实测）：

```js
// 经 HTTP 代理做 CONNECT，再在隧道上跑 TLS —— Node 22 原生 fetch 不支持
function connectTunnel(proxy, host, port = 443) {
  return new Promise((resolve, reject) => {
    const s = net.connect(proxy.port, proxy.host);
    let head = '';
    s.setTimeout(20_000, () => reject(new Error('tunnel timeout')));
    s.on('error', reject);
    s.on('connect', () => s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
    s.on('data', function onData(d) {
      head += d.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      s.removeListener('data', onData);
      if (!/ 200/.test(head.split('\r\n')[0])) return reject(new Error('proxy: ' + head.split('\r\n')[0]));
      resolve(s);
    });
  });
}
// 请求时记得 Connection: close，否则 keep-alive 会让读取端永不 end（本次调研踩过）
```

另：**账号型 Cookie 路线（RSSHub / twscrape）与 Cookie 都会经过代理出口，出口 IP 是共享的 VPS 段**——这是被判风控的因素，[待验证]。

## 2. 路线 A：Nitter 实例 RSS（字段最适合机械筛选）[实测]

### 实例存活（本机逐个实测）

| 实例 | 页面 | RSS | 备注 |
|---|---|---|---|
| `nitter.jaydenha.uk` | 200 有推文 | **200 / 20 条有效 XML** | ✅ 最佳 |
| `x.n0g.xyz` | 200 无推文 | **200 / 20 条** | ✅ RSS 可用 |
| `nitter.kareem.one` | 403（Cloudflare） | 先 200/20 条，后 429 | ⚠️ 限速 |
| `nitter.click` | 200 有推文 | 403 | ⚠️ |
| `nitter.miningtcup.me` / `nitter.netbub.com` / `nitter.meowing.monster` / `nitter.xitter.cc` | 200 无推文 | 空/404 | ❌ |
| `nitter.tiekoetter.com` / `nitter.privacyredirect.com` | 200 但 **Anubis 工作量证明**（"Making sure you're not a bot"） | 同 | ❌ 脚本不可用 |
| `nitter.space` / `lightbrd.com` | 403 Cloudflare "Just a moment…" | 403 | ❌ |
| `nitter.net` / `nitter.poast.org` | TLS ECONNRESET | 同 | ❌ 已停 |
| `xcancel.com` | **451 Unavailable For Legal Reasons** | 451 | ❌ 法律下架 |

`twiiit.com` 实测 302 → `nitter.space`（只是重定向代理，Nitter 死它必死）。

### RSS 条目字段形态 [实测]（`nitter.jaydenha.uk/Watase_Yuzuki/rss`）

```xml
<item>
  <title>RT by @Watase_Yuzuki: ✨Steamストアページ公開✨／ …</title>   <!-- 转发标记 -->
  <dc:creator>@wstcg</dc:creator>                                      <!-- 原作者 -->
  <link>http://nitter.jaydenha.uk/wstcg/status/2099664497908523053#m</link>
  <pubDate>Tue, 15 Sep 2026 01:00:00 GMT</pubDate>                      <!-- Date.parse 直解 -->
  <description><![CDATA[<p>…<br><img src="…pbs.twimg.com/…"></p>]]></description>
</item>
```

**一次 20 条的机械筛选统计（同一次抓取）**：20 条 = **10 转发 + 10 原创**、**19 条带图**、`pubDate` 跨度 2026-09-11 ~ 2026-09-16（当天）。三项筛选（原创/转发/带图）在这条路线上**零成本可判**，时间也可直接排序。

### 代价与风险

- 实例是**别人维护的免费服务**，README 明写 "often disabled due to abuse"、"请勿拿公共实例爬取"；用多实例轮询 + 失败即弃是唯一现实做法，**不能进关键路径当唯一源**。
- 法律：X Corp 2026-08-24 向 Nitter 发停止函（[文档/媒体]）；实例侧需真实账号 session token（这正是指控点）。定位是**低风险非授权渠道**，不是合规方案。
- 自建 Nitter 对国内部署是硬约束：`nitter.conf` 的 `proxy` **只支持 http/https，不支持 SOCKS**，且需 Redis/Valkey。

## 3. 路线 B：免登录 syndication / HTML（零凭据）[实测]

### 3.1 `x.com/<screen>` 的登录页 HTML 里带最新推文

无 cookie、无鉴权，`GET https://x.com/Watase_Yuzuki` → `200` / 255KB，内嵌 Flight/RSC 数据（`__typename:"TBirdData"`）里能抠出 **7 条 `full_text` + 13 个 `rest_id`**（含置顶）。

**新鲜度实测（最关键的一条）**：从 HTML 取最大 `rest_id`，再用下方 3.3 接口换 `created_at`——

| 账号 | HTML 内最大 id | `created_at` | 距抓取时刻 |
|---|---|---|---|
| `@Watase_Yuzuki` | 2100025416010661982 | **2026-09-16T00:54:10Z** | 约 10 小时 |
| `@hololive_En` | 2100041984526405643 | **2026-09-16T02:00:00Z** | 约 1.3 小时 |

→ **免登录 HTML 拿到的是账号的最新推文**，不是过期样本。

局限：
- 只有 ~5–13 条（含置顶），**两次轮询之间发超过这个数的账号会漏推**；
- HTML 里**没有 `created_at`**（需 3.3 补），也没有 `retweeted_status_results` 非 null 的观测（4 个账号实测全是 `null`）→ **疑似只嵌入原创、转发被过滤** [待验证]（同期 Nitter RSS 显示该账号 20 条里 10 条是转发）；
- 依赖页面结构，X 改版即失效 → 解析必须防御式 + 空结果告警。

### 3.2 `cdn.syndication.twimg.com/srv/timeline-profile/screen-name/<name>`

无 cookie → `200` / 615KB，Next.js 页面，`__NEXT_DATA__.props.pageProps.timeline.entries[]` 一次给 **100 条**（`@hololive_En` 101、`@nhk_news` 94），每条字段很全：`id_str / created_at / full_text / lang / display_text_range / entities / extended_entities / favorite_count / conversation_id_str / is_quote_status / quoted_status / card / user.screen_name`。

**但它不是「最新 100 条」，是抽样/精选**：`@Watase_Yuzuki` 100 条里按时间最新的是 **2026-04-26**（而该账号当天有推文），`last7days = 0`；`latest_tweet_id` 字段与条目最大 id 时而一致时而不一致（`@nhk_news` 就不一致）。→ **只能当回填/归档源，不能当实时源** [实测]。

**限流 [实测]**：响应头 `x-rate-limit-limit: 30`（15 分钟窗口，`x-rate-limit-reset` 距 `Date` 约 13 分钟），打满后返回 `429` + 20 字节空体。→ ≈120 次/小时，**覆盖不了 50 账号 × 5 分钟**（那是 600 次/小时）。

### 3.3 `cdn.syndication.twimg.com/tweet-result?id=<id>&token=<任意值>`

单推详情，`200` 返回 JSON：`text / created_at / lang / user.screen_name / mediaDetails[] / photos[] / entities / favorite_count / conversation_count / isEdited / possibly_sensitive`。

**token 语义实测**（与网传"由 id 派生"不符）：

| 查询 | 结果 |
|---|---|
| `?id=<id>&lang=en`（无 token） | `200` → **`{}`**（空） |
| `?id=<id>&lang=en&token=abc` | `200` → 完整数据 2187B |
| `?id=<id>&token=abc` | `200` → 完整数据 |
| `?id=<id>&lang=en&token=<id>` | `200` → 完整数据 |

→ **`token` 只需存在且非空，值任意**；缺了才返回 `{}`。[待验证] 是否长期如此。该端点本次未见 `x-rate-limit-*` 头。

### 3.4 零凭据组合（起步方案）

`x.com/<screen>` 抽 id → 与本地 `posts` 表 diff → 新 id 用 `tweet-result` 补全文/时间/图片 → 机械筛选 → 推送。
**优点**：零凭据、零成本、当天可跑通。**缺点**：转发看不到、条数少会漏推、页面结构会变。适合「少量账号 + 低频发推」的起步验证；要长期稳定应上路线 A/C/D。

## 4. 需要凭据或付费的路线

### 4.1 自建 RSSHub + 可弃小号 [文档]

- `/twitter/user/:id` **仍在维护**（2026-08-06 fix gql-query-ids、2026-08-03、2026-09-07 有提交）；routeParams：`includeRts`（默认 true）、`includeReplies`（默认 false）、`count`、`onlyMedia`。
- 凭据：`TWITTER_AUTH_TOKEN`（逗号分隔的 auth_token cookie，推荐）或官方 API key；**账密/手机路径自 2025-10 客户端 attestation 后失效**。
- 公共实例不可用（`requireConfig` 必须自配）；自建也有 token 正确却空结果的 issue（#19420）。
- 与本项目既有形态最贴合（B站微博已用"自建服务 + 自己带 cookie"的思路），代价是一个可弃小号的封号风险 + 一个 Node 服务。

### 4.2 抓取库 [文档]

| 库 | 状态 | 凭据 | 备注 |
|---|---|---|---|
| `vladkens/twscrape`（Python） | **活跃** v0.20.1（2026-08-25） | **必须持号**（auth_token+ct0 或账密+IMAP） | 账号池 + 每账号代理 + 端点级轮换；上限 ~3200 条；**无访客模式** |
| `@the-convocation/twitter-scraper`（JS） | 半停更 v0.22.3（2026-04-01，约 5 个月无提交） | 同上 | 无账号池（指向 PR #116）；默认限速"等窗口结束"最长 ~13 分钟；`fetch` 可注入 → 理论上能接隧道版 fetch；README 自警"登录账号随时可能被封" |

**guest 路径**：`POST https://api.x.com/1.1/guest/activate.json`（带公开 web Bearer）本机实测仍返回 `200 {"guest_token":"…"}`；但以此 token 打 GraphQL UserTweets 需要实时有效的 `queryId`（要从 x.com 的 JS bundle 里扒，本次未扒到），**未跑通** [待验证]。所以"匿名 GraphQL 拉时间线"不能当既成事实——但**路线 A/B 已经不需要它**。

### 4.3 第三方 API [文档，部分实测]

| 厂商 | 单价 | 增量轮询 50 账号/5 分钟 | 国内 | 备注 |
|---|---|---|---|---|
| **twitterapi.io** | $0.00015/条（$0.15/1K），$10 起充，$1 试用 | **≈$65–80/月**（起步 ≈$3/月） | `api.twitterapi.io` **实测可达**（401 需 key），境内直连 | 字段含 `retweeted_tweet`/`quoted_tweet`/`isReply`；文档自警"只抓单用户最新推文会很贵" |
| socialdata.tools | $0.0002/条，≤3 请求/分钟免费 | ≈$60/月（起步 ≈$0） | 域名**实测 ECONNRESET**（可能未被代理规则覆盖） | 字段最全（原生 retweeted_status/quoted_status/media），但无状态页无 ToS、余额归零静默暂停 |
| Apify（apidojo / scrapesmith 等） | $0.15–0.40 /1K | ≈$1,296–3,456/月 | 未验证 | 社区维护，X 改版即可能失效 |
| Bright Data / ScraperAPI | $1.5/1K；起购 $250 | 远超预算 | 未验证 | 非实时 |
| **官方 X API** | **$0.005/Post read**（User read $0.010） | 无去重 ≈**$10,800/月**（逼近 300 万 reads/月上限）；**做 `since_id` + 本地去重后 ≈$37/月** | api.x.com 被封，需代理 | 唯一授权渠道；免费档已取消 |

**成本纪律（与项目"轮询循环只做便宜事"同一条）**：绝不在轮询里"拉最近 20 条"——那是唯一会失控的成本项。必须用 `since_id`/时间窗只取增量，并靠本地 `(platform,item_id)` UNIQUE 去重。

### 4.4 已排除的选项 [实测/文档]

`rsshub.app` 等公共实例 ECONNRESET；RSS-Bridge 的 Twitter bridge 已死（issue #4674）；`openrss.org` 2026-08-11 起全面失效；Feed43 DNS 解析失败；Playwright 常驻浏览器（支持 HTTP/SOCKS 代理）只作兜底，资源重且同样会被封。

## 5. 与 DD-claw 的落点

> **历史说明**：本节原是按「X 挂在 B站主播下、与微博同构」写的实施建议，已由实现取代，不再作为待办。
> 当时的落点设想（独立分页 `#view-x`、独立名单 `x_accounts`、独立图文规则表 `post_rules` + 账号选用）
> 前半已落地、后半已被统一分类/推送模型取代。现行落点与文件职责以 [plan/twitter-source.md](../plan/twitter-source.md)
> （决策与实现约定）、[mcp.md](../mcp.md)（能力面）、各级 `AGENTS.md`（代码地图）为准。
> 下表只保留**调研结论对实现构成的约束**——它们不随落点变化，是这一页仍然有效的那部分。

| 约束 | 依据 |
|---|---|
| 出网必须自带隧道 fetch，不能靠环境变量 | §1 [实测]：Node 22 原生 fetch 不认代理，`curl -x` 同样打不通 |
| 代理是可配置的运行时设置，且必须可测、可告警 | §1、§8：X 全部能力都压在代理上，代理挂 = 源全停 |
| 抓取对象是独立账号名单，不是主播附属 | 账号模型与主播无关；关联只用于展示与文案 |
| 图片必须经代理下载后本地化再发送 | §1 [实测]：`pbs.twimg.com` 直连超时 |
| 「抓不到」与「没有新推文」必须可区分 | §8：业务上同形，必须独立健康检查，否则静默失效会被读成「没发推」 |
| 按 link 去重会折叠同一推文的多条转发 | §2 [实测]：`<link>` 指向原作者；要「每次转发都推」须另取 RT 自身 id [待验证] |
| 路线能力不能混同 | Nitter 可识别原创 / 转发，引用未知；HTML 回退取不到转发，但单推详情可识别引用。早期调研的字段局限不构成 UI 禁令，现行解析见 `src/sources/twitter/` |

## 6. 推荐组合与频率

- **起步（0 元，1 天可跑通）**：路线 B（`x.com` HTML 抽 id + `tweet-result` 补全）跑通全链路；同时用路线 A 的 2–3 个可用实例做 RSS 交叉校验。
- **稳定期（0 元 + 一点维护）**：路线 A 多实例轮询为主（字段最好、能区分转发），B 为备；实例全挂时降级到 B。
- **要长期稳定/要转发不漏**：路线 C（自建 RSSHub + 可弃小号）或路线 D（twitterapi.io 增量，起步 $3/月）。
- **轮询频率**：个人账号（一天 1–10 条）**5–10 分钟**足够，更频繁只增风险；`syndication timeline` 那条另有 30 次/15 分钟的硬限流。

## 7. 待验证清单（实现前必做）

1. x.com 免登录 HTML 是否**包含转发**（拿一个确定刚转发过的账号，看 `retweeted_status_results` 是否非 null）。
2. HTML 内嵌条数上限与高频账号的实际漏推率（拿一个每分钟发推的账号连测 30 分钟）。
3. Nitter RSS 中 **RT 自身 id** 的取法（link 目前指向原作者）。
4. `tweet-result` 的 `token` 任意值是否长期有效。
5. 免登录路线在**长期运行**下是否被 challenge / 逐步收紧（本次全部实测都经由同一个代理出口 IP）。
6. 各第三方 API 的 media 字段逐字段确认、以及 RapidAPI 类服务在境内的可达性。

## 8. 风险定位

- 路线 A/B/D 都是**低风险非授权渠道**：违反 X 合同条款、实例可能被停止函打死、厂商可能静默失效、账号型路线（C）有小号被封风险。**但"使用已公开数据"本身不等于违法**——X Corp. v. Bright Data（N.D. Cal. 3:23-cv-03698）中法院整体驳回了 X 的指控。
- 本项目一贯纪律照旧：**不做写操作**（不发推、不点赞、不关注），只读 + 本地配置。
- 「抓不到」与「没有新推文」在业务上同形 → 必须加独立健康检查（例如定时用一条已知存在的推文 id 做对照），否则接口静默失效时会被误读成"主播没发推"。

## 9. 来源

- 本页所有 [实测] 结论：2026-09-16 由本机经 `127.0.0.1:7890` 代理对 x.com / cdn.syndication.twimg.com / api.x.com / Nitter 实例发出的真实请求（CONNECT 隧道 + TLS，记录返回码、字节数、字段）。
- 官方 API 文档源仓库：<https://github.com/xdevplatform/docs>（`x-api/getting-started/pricing.mdx`、`changelog.mdx`、`x-api/posts/timelines/integrate.mdx`）
- Nitter：<https://github.com/zedeus/nitter>（README、`src/routes/rss.nim`、`nitter.example.conf`）、实例 wiki <https://github.com/zedeus/nitter/wiki/Instances>、社区名单 <https://codeberg.org/mv12star/shitter/wiki/Instances>、健康页 <https://status.d420.de/>
- 停止函报道：<https://itsfoss.com/news/nitter-returns-after-legal-troubles/>、<https://techcrunch.com/2026/08/25/x-sends-cease-and-desist-to-open-source-project-nitter-over-alleged-scraping/>
- 抓取库：<https://github.com/vladkens/twscrape>、<https://github.com/the-convocation/twitter-scraper>
- RSSHub：<https://github.com/DIYgod/RSSHub>（`lib/routes/twitter/namespace.ts`、issue #19420）
- 第三方 API：<https://twitterapi.io/pricing>、<https://docs.socialdata.tools/getting-started/pricing/>、<https://apify.com/apidojo/tweet-scraper/pricing>、<https://brightdata.com/products/datasets/twitter>
- 判例：<https://cases.justia.com/federal/district-courts/california/candce/3:2023cv03698/415869/156/0.pdf>
- 营销站（仅作对照，不作依据）：<https://twitterapi.io/blog/x-api-cost-breakdown-2026>（其"2M reads 上限 / 免费档已停"与官方口径不一致）