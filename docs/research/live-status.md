# 调研：B站开播状态获取

基准日 2026-07-29。测试对象：阿梓从小就很可爱，uid `7706705`，房间 `80397`。

## 结论

**轮询 `get_status_info_by_uids` 为主，不上全员 WS。** 匿名可用，一次请求覆盖所有关注对象。

## 可用接口

### 主接口：按 uid 批量查 [实测]

```
GET  https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids?uids[]=7706705
POST 同址，body: {"uids":[7706705, ...]}
```

无需登录、无需 WBI。真实返回节选：

```json
{"code":0,"data":{"7706705":{
  "title":"孩子们下午好","room_id":80397,
  "live_time":1785310737,          // 秒级时间戳
  "live_status":1,                  // 0未开播 1直播中 2轮播
  "area_v2_name":"无畏契约","area_v2_parent_name":"网游",
  "uname":"阿梓从小就很可爱",
  "cover_from_user":"...","keyframe":"..."   // keyframe 可直接当预览图
}}}
```

### 备选（均 [实测] 匿名可用）

| 接口 | 特点 |
|---|---|
| `room/v1/Room/get_info?room_id=` | 单房间，`live_time` 是 `yyyy-MM-dd HH:mm:ss` 字符串 |
| `room/v1/Room/room_init?id=` | 字段精简，`live_time` 为秒级时间戳 |
| `xlive/web-room/v1/index/getRoomBaseInfo?req_biz=web_room_componet&room_ids=` | 字段最全，支持批量传多个 `room_ids` |

## 不可用接口 [实测]

| 接口 | 返回 | 原因 |
|---|---|---|
| `xlive/web-room/v1/index/getInfoByRoom` | `-352` | 2025-05-26 起强制 WBI 签名 |
| `xlive/web-room/v1/index/getDanmuInfo` | `-352` | 同上，且需非空 buvid3。签名后可用，见 [danmaku.md](danmaku.md) |
| `xlive/web-ucenter/user/following` | `-101 账号未登录` | 必须 SESSDATA |

带不带 UA / Referer / 伪造 Cookie 都一样，与登录状态无关。

## 风控现状

- 上述四个「老接口」[实测] 裸 curl 无任何 header 也能成功。短时间连续 5 次（间隔 0.1~1.6s）全部 200，未触发限流。
- **但这只说明秒级连续请求不会立刻被拦，不代表长期高频安全**。[待验证]
- `-352` 是风控码，`-412` 主要出现在动态/评论接口上，本模块未触发过。
- 建议：轮询间隔 **30-60s**，固定使用真实浏览器 UA，优先用批量接口而非逐个 `get_info`。多数开源项目（DDTV、录播姬）默认在这个量级。

## 弹幕 WS 作为事件源的评估

| | 轮询 | 逐房间 WS |
|---|---|---|
| 延迟 | 30-60s | 秒级 |
| 覆盖 N 个主播 | 1 次请求 | N 条长连接 |
| 工程复杂度 | 低 | 连接池 + 心跳 + token 刷新 + 重连 |
| 入口鉴权 | 无 | 需 WBI（+ buvid3） |

没有官方的「关注列表统一开播推送长连接」，也没有 Twitch EventSub 式的批量订阅。[文档]

**结论**：开播通知对分钟级延迟不敏感，轮询够用。WS 的价值在于**弹幕文本**（内容判定的核心信号），而非开播感知本身 —— 所以定位为「开播后按需拉起」，见 [danmaku.md](danmaku.md)。

相关 cmd：`LIVE`（开播瞬间，带 `live_time`）、`PREPARING`（下播，带 `round` 表示是否转轮播）、`ROOM_CHANGE`（标题/分区变更）。[文档]

## 开源实现

**重要信号**：两个最权威的参考项目已因法律原因关停。[文档]

| 项目 | 状态 |
|---|---|
| `SocialSisterYi/bilibili-API-collect`（20k star） | **已归档**，2026-01 收到律所法律函后永久停维，内容已删除 |
| `Nemo2011/bilibili-api`（Python 库，4.1k star） | **已归档**，同因侵权告知函关停 |
| `BililiveRecorder`（录播姬，C#） | 活跃（2026-07-15），GPL-3.0，完整应用非库 |
| `CHKZL/DDTV`（C#） | 活跃（2026-07-25），GPL-2.0，完整应用非库 |
| `xfgryujk/blivedm`（Python） | 维护中（2026-05-08），MIT，专注弹幕 |
| `lovelyyoshino/Bilibili-Live-API` | 活跃（2026-07-28），MIT，可作文档替代来源 |

**对本项目的影响**：

1. **不要依赖 `bilibili-api-python` 之类的封装库** —— 停维后接口变了没人修。本项目只用到 1-2 个接口，自己封装几十行更可控。
2. 不在项目内大量摘录非公开接口清单并公开发布。
3. 控制调用频率在合理范围。

## 参考

- [pskdje/bilibili-API-collect 的 live/info.md 镜像](https://raw.githubusercontent.com/pskdje/bilibili-API-collect/main/docs/live/info.md)
- [message_stream.md 镜像（弹幕协议、LIVE/PREPARING cmd）](https://raw.githubusercontent.com/pskdje/bilibili-API-collect/main/docs/live/message_stream.md)
- [lovelyyoshino/Bilibili-Live-API](https://github.com/lovelyyoshino/Bilibili-Live-API)

