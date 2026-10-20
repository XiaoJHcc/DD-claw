# rules — 机械去重 / 防抖

这一层是**机械政策**，不是用户偏好：每场一次、场景切换去重、冷却，由代码定义，用户不可配置。用户可见的静音名单 / 静默时段 / 定时推 /「不推」偏好**已放弃**（见 [docs/design.md](../../docs/design.md) §11）——推送规则已经足够表达偏好，未来只做增加式可选推送时机。

## 长期不变量

- **直播通知政策归属固定**：每场一次、场景切换与冷却属于 rules / pipeline，不塞进分类器或来源。来源的归档唯一键去重、增量游标和图文补推挑选不属于这类通知政策，不受此限制。
- **身份 = `(roomId, liveTime)`**：`liveTime` 是服务端给的开播时间戳，所以进程重启不重推、网络闪断不误报、真下播再开播会正常推。
- **`liveTime` 缺失就不推**：没有身份键无法判重，宁可漏推也不重复轰炸。
- **`decide()` 的第三参可为空数组**：规则不得假设分类结果存在；未判定 / 无分类时照样要给出 `shouldNotify + reason`，便于排查「为什么没收到通知」。

## 文件地图

- `types.ts` — `DecisionRule`（`decide(event, signal, classifications?)` → `NotifyDecision`）/ `NotifyDecision`（推与不推都必须带 `reason`）。
- `once-per-session.ts` — `OncePerSessionRule`：仅 `live_start` 通过，按 `(roomId, liveTime)` 查 `notify_log` 判重（`SessionStore` 只依赖 `hasNotified`，方便单测）。

图文帖路径**不经过本层**：帖子没有场次概念，去重由 `posts` 的 `UNIQUE(platform, item_id)` 兜住。
