# B站动态图文来源 + 图文规则「规则卡 + 每账号选用」

2026-09（紧随 weibo-source）。两件事一起做，因为它们共用同一处账号墙与规则模型。

## 需求

1. 图文页支持 B站动态监听：「小日向美香的传声筒」这类不开播的动态型 UP 主，不在监听主播名单里，之前 DynamicSource 只轮监听主播（`listWatchedUids()`），动态只归档展示在主播卡第三栏，feed_post 信号被 pipeline 白名单丢弃。
2. 图文规则从「规则内嵌 account_ids、按账号卡就近建规则」改为「**通用规则设置卡 + 每博主选用已有规则**」（类似直播推送规则的集中卡片，但图文不拆分类表——不分类入库，filters 保持结构化内联）。

## 已确认的取舍

- **纯按账号选用**：规则不保留「空账号 = 全部账号（含未来新增）」语义；迁移时把旧 account_ids 展开写到账号 rule_ids（空 → 该平台现有全部账号）；新增账号默认不推。
- **监听主播的动态维持只归档不推送**；想推就把该 uid 加进动态名单（主播卡不加规则选用 UI）。

## 方案与落地

| 层 | 改动 | 要点 |
|---|---|---|
| 数据 | 新表 `bili_accounts`（第 17 张）；`x_accounts`/`weibo_accounts` 补列 `rule_ids`；`post_rules.account_ids` 列保留停用 | bili_accounts 比照 weibo_accounts，差异：无 biliUid（自身即 B站 uid）、无 lastPostId 游标（去重靠 posts UNIQUE + 首轮静默）；一次性迁移 `migratePostRuleScopes`（settings 闸门） |
| core | `core/bili-accounts.ts`（新）；`post-rules.ts` 删 accountIds、PostPlatform 加 `bili_dynamic` | platformLabel 'B站'；quote/translate 仅 X |
| 抓取 | `dynamic.ts` 轮询对象 = 监听主播 ∪ bili_accounts(enabled)；名单账号回写 uname/last_ok_at + 顺手抠 face 头像落 `cache/bili-avatars`（新 `bili/avatar.ts`，直连 hdslb） | 名单变化每轮自并，无需热重启；监听主播的信号由 pipeline 丢弃（debug 不刷屏） |
| 分析/推送 | `matchPostRules` 命中 = 平台相同 && `post.ruleIds.includes(id)` && 机械筛选；pipeline 接 bili_dynamic（type 归一 FORWARD→retweet；图片直连本地化；{liver} 按 account.uid 查 streamers） | message/post-analysis 文案加「动态」分支 |
| 面板 | `/api/bili/accounts` 全套（恒挂载无 dep 门）+ `/api/bili-avatar`；x/weibo 账号端点加 ruleIds（跨平台 400）；删规则连带清扫三份名单 ruleIds | 校验集中在 http-util `checkAccountRuleIds` |
| MCP | 新增 `list/upsert/delete_bili_account`；`upsert_post_rule` 删 account_ids；x/weibo upsert 加 ruleIds | 角色与 weibo 三工具一致 |
| 前端 | 图文页：三张来源卡（加 B站动态，监听开关复用 listen_dynamic）+「图文规则」卡（拖拽/启停/平台 tag）+ 账号浮窗「选用规则」勾选列表 + B站账号卡与平台筛选胶囊 | 规则浮窗新建选平台、编辑只读；B站不出「引用」「附译文」 |

## 修订（2026-09，规则通用化）

用户随后要求**取消规则必须绑定平台的设计**：post_rules 连 `platform` 维度也去掉（列保留停用），规则成为平台无关的通用规则——任何账号可选用任何规则，`checkAccountRuleIds` 只校验存在；quote/翻译差异从「按规则平台保存时拒绝」改为「按帖子平台运行时生效」（quote 仅 X 帖可识别、`llmTranslate` 仅对 X 帖附加，门控在 post-analyzer）。前端规则卡删平台 tag 与浮窗平台行，chip 恒定显示附小字提示。上表中「platform 分流」「跨平台 400」「新建选平台」以此节为准作废。

## 验证

- `npx tsc --noEmit` 零错误；`npm test` 581/581；`npm run build` 通过。
- demo mock（`?demo=1`）与真实后端同构：post-rules 无 accountIds、bili/accounts 全套、ruleIds 跨平台 400、删规则清扫。
