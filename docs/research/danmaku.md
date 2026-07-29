# 调研：弹幕 WebSocket

基准日 2026-07-29。**这是本轮调研最重要的确定性收获。**

## 结论

**匿名可连。只需 WBI 签名 + User-Agent，不需要登录 cookie，也不需要 buvid3。**

完整链路已 [实测] 跑通：`nav` 取 key → mixin key 重排 → 算 `w_rid` → `getDanmuInfo` → 连 WS → 收到弹幕。

## 根因修正

先前「裸调 `getDanmuInfo` 返回 `-352`」的结论没错，但根因定位不准：

- ❌ 不是缺 buvid3 cookie
- ✅ 是**缺 WBI 签名**

[实测] 未登录状态（`nav` 返回 `code=-101, isLogin=false`）下，仅凭正确签名即可拿到 token：

```
=== getDanmuInfo：WBI 签名 + 无 buvid3 cookie ===
HTTP 200  {"code":0,"message":"OK",...,"token":"d0tK8bB1..."}
```

## 隐藏的必要条件：User-Agent

[实测] 同一个正确签名，不同 header 组合结果不同：

| header | 结果 |
|---|---|
| `User-Agent: Mozilla/5.0`（内容随意）+ 任意/无 Referer | ✅ 成功 |
| 完全不带任何 header | ❌ `-352` |
| 只带 Referer，不带 UA | ❌ `-352` |

**UA 必需，Referer 不必需。** 这个组合很反直觉，容易误判成签名算错。

## WBI 签名实现

算法自 2023-03 上线后核心逻辑未变。[文档] 但 RSSHub 选择动态下载 B站 JS 解析重排表而非硬编码，抗变动更好。

```ts
import crypto from 'node:crypto';

const mixinKeyEncTab = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,
  33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,
  4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];

const getMixinKey = (orig: string) =>
  mixinKeyEncTab.map(n => orig[n]).join('').slice(0, 32);

export function encWbi(params: Record<string, unknown>, imgKey: string, subKey: string) {
  const mixinKey = getMixinKey(imgKey + subKey);
  const query = { ...params, wts: Math.round(Date.now() / 1000) };
  const qs = Object.keys(query).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(query[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  return `${qs}&w_rid=${crypto.createHash('md5').update(qs + mixinKey).digest('hex')}`;
}
```

`img_key` / `sub_key` 从 `api.bilibili.com/x/web-interface/nav` 的 `wbi_img.img_url` / `sub_url` 取文件名（未登录时 `code=-101` 但这两个字段仍返回）。

调用：

```ts
fetch(`https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${
  encWbi({ id: roomId, type: 0 }, imgKey, subKey)}`,
  { headers: { 'User-Agent': 'Mozilla/5.0' } });   // UA 必须带
```

## WS 连接 [实测]

拿到 token + host_list 后连 `wss://{host}/sub`，5 秒内发认证包（含 `roomid` + `key`），30 秒一次心跳，60 秒无心跳被断开。

```
认证结果 op=8: {"code":0}
[弹幕] [喝彩][喝彩][喝彩][喝彩]
[其他cmd] UNIVERSAL_ASR_TEXT
心跳回复 op=3, 人气值= 1
```

实测抓到的 cmd：`DANMU_MSG`、`UNIVERSAL_ASR_TEXT`、`INTERACT_WORD_V2`、`ONLINE_RANK_V3`、`ONLINE_RANK_COUNT`。

`UNIVERSAL_ASR_TEXT` 值得注意 —— 看名字是 B站自己的语音识别文本推送。如果它真的包含主播说话/唱词的转写内容，那对内容判定极有价值，**可能直接省掉我们自己做 ASR**。本次未深入验证其字段与可用性，留作后续验证项。

## 字段路径

| cmd | 路径 | 内容 |
|---|---|---|
| `DANMU_MSG` | `msg.info[1]` | 弹幕文本 [实测] |
| `DANMU_MSG` | `msg.info[2][1]` | 发送者昵称 [文档] |
| `SUPER_CHAT_MESSAGE` | `msg.data.message` / `.price` | SC 文本 / 金额 [文档] |
| `ROOM_CHANGE` | `msg.data.title` / `.area_name` | 标题/分区变更 [文档] |
| `LIVE` / `PREPARING` | — | 开播 / 下播信号 [文档] |

## npm 库

| 库 | 版本 | 发布 | WBI | 评价 |
|---|---|---|---|---|
| `blive-message-listener` | 0.5.5 | 2026-05-10 | 内置（依赖下者） | 活跃，消息结构化封装 |
| `tiny-bilibili-ws` | 1.0.3 | 2026-06-23 | [实测] 内置 | 底层库，**有 bug 见下** |
| `bilibili-live-ws` | 6.3.1 | 2023-07-04 | 未验证 | 两年多未更新，大概率未适配 WBI |

### tiny-bilibili-ws 的 headers 覆盖 bug [实测]

```js
// 源码 K() 函数（变量名已还原）
function K(url, opts = {}) {
  return fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 ...", ...opts.headers },
    ...opts   // ← 再次展开 opts，opts.headers 整体覆盖上面合并好的 headers
  });
}
```

调用方一传 `{ headers: { Cookie: 'xxx' } }`，内置 UA 就被冲掉 → 缺 UA → `-352`。

零配置调用（`KeepLiveWS(room, { uid: 0 })`）[实测] 正常。一自定义 headers 就炸。

**选择**：WBI 签名只有 20 行且已验证可行，自己实现 + `ws` 库连接最可控。若要用库，`tiny-bilibili-ws` 保持默认配置，或用上层的 `blive-message-listener`。

## 对架构的影响

弹幕是内容判定的核心文本信号，而它**匿名可得**。这意味着 MVP 与 LLM 分析层都不需要用户账号，cookie 只是「预告时间表」的前置条件。

定位为按需拉起：开播 → 若该房间开启分析 → 建连采样 → 下播关闭。并发只有几路。

