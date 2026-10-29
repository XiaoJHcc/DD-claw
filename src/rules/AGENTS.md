# rules — 机械去重 / 防抖

这一层是**机械政策**，不是用户偏好：开播初判每场一次、通知场景切换去重与通知冷却由代码定义，用户不可配置。用户可见的静音名单 / 静默时段 / 定时推 /「不推」偏好**已放弃**（见 [docs/design.md](../../docs/design.md) §11）——推送规则已经足够表达偏好，未来只做增加式可选推送时机。直播**分类时机**（何时重新判定、哪些判定档参与、LLM 冷却）是配置面，归 `core/runtime-config` 与 `analysis/triggers`，不属于本层。

## 长期不变量

- **直播通知政策归属固定**：每场一次、场景切换与冷却属于 rules / pipeline，不塞进分类器或来源。来源的归档唯一键去重、增量游标和图文补推挑选不属于这类通知政策，不受此限制。
- **「每场一次」只约束开播初判**：`OncePerSessionRule` 是开播那一次的水位；直播的其余分类时机（开播延迟后 / 直播中定时 / 标题分区变更 / 变更延迟后）由 pipeline 另行判断——**只有「生效且属于」的分类集合相对上一轮真正改变时**才重新匹配并发送，不查也不改这个水位。分类失败/无变化不构成「变化」；重推同样是一次内容变更的即时通知，不做时间窗去重。
- **身份 = `(roomId, liveTime)`**：`liveTime` 是服务端给的开播时间戳，所以进程重启不重推、网络闪断不误报、真下播再开播会正常推。重推沿用同一身份键做同场发送竞态保护，只是不写水位。
- **`liveTime` 缺失就不推**：没有身份键无法判重，宁可漏推也不重复轰炸。
- **`decide()` 的第三参可为空数组**：规则不得假设分类结果存在；未判定 / 无分类时照样要给出 `shouldNotify + reason`，便于排查「为什么没收到通知」。

## 文件地图

- `types.ts` — `DecisionRule`（`decide(event, signal, classifications?)` → `NotifyDecision`）/ `NotifyDecision`（推与不推都必须带 `reason`）。
- `once-per-session.ts` — `OncePerSessionRule`：仅 `live_start` 通过，按 `(roomId, liveTime)` 查 `notify_log` 判重（`SessionStore` 只依赖 `hasNotified`，方便单测）。

图文帖路径**不经过本层**：帖子没有场次概念，去重由 `posts` 的 `UNIQUE(platform, item_id)` 兜住。
