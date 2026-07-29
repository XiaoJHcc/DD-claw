# 调研：推送通道

基准日 2026-07-29。

## 结论

- QQ **只剩 NapCatQQ 一条活路**，仍有风险，建议小号
- 单向推送**不需要 WebSocket**，HTTP POST 最简单
- 本机 Toast 走 `powertoast`
- 兜底通道优先 ntfy 自建或企业微信/钉钉群机器人

## QQ：非官方 OneBot 实现

| 项目 | 状态 | 协议 | 部署 |
|---|---|---|---|
| **NapCatQQ** | **活跃，当前生态主流**。~10k star，2026 年 1-4 月仍有持续修复（#1796 登录态异常/被踢、#1702 worker 崩溃） | OneBot 11 全形态（HTTP / 正向 WS / 反向 WS / HTTP POST 上报）+ go-cqhttp 兼容扩展 | Docker 或 Windows 直接跑（基于无头 QQNT，无需可见窗口） |
| **LLOneBot** → 改名 **LuckyLilliaBot** | 活跃，v4.9.x | OneBot 11 + Satori + Milky | LiteLoaderQQNT 插件，**必须挂真实 QQNT 客户端** |
| **Lagrange.OneBot** | **已停维**。主分支升到 V2，官方明确 V2 不再支持 OneBot 11，V1 实现随之停止 | 转 Milky | .NET |
| **go-cqhttp** | **已死**。作者 2023-10 宣布停维（issue #2471），签名方案被封后基本无法登录 | OneBot 11 | — |

**封号风险**：这四类本质都是「用第三方代码驱动/魔改 QQNT 客户端登录」，灰色地带。腾讯持续更新加密与风控，这正是 go-cqhttp、Lagrange V1、Chronocat、Shamrock 相继失效的直接原因。**没有零风险方案**，NapCat 只是跟进最快、社区最活跃、被封概率相对低。小号 + 低频使用可进一步降低风险 [待验证]。

## QQ 官方开放平台（bot.q.qq.com）

[文档] 官方文档「消息收发概述」标注最后更新 2026-07-21：

- **个人开发者可注册并申请个人认证**，个人与企业认证在主动推送额度上**完全相同**
- 单聊主动推送：认证后 10 QPS（bot 维度）、20/分钟（单用户维度）、每用户每日 1000 条；未认证降为 5 QPS & 30/分钟
- 群聊主动推送：认证后 60/分钟（bot 维度）、20/分钟（单群维度）、每群每日 1000 条
- 被动回复：单聊 60 分钟内 4 次；群聊 5 分钟内 5 次
- **关键限制**：用户侧有「是否允许机器人主动发消息」开关，**关闭则主动推送必然失败**，默认状态文档未说明
- Webhook 需 HTTPS 回调（限 80/443/8080/8443），要做 Ed25519 签名校验

未验证 [待验证]：个人开发者注册是否需营业执照、审核周期、上架场景限制。

**对「给自己推送」不合适**：主动推送依赖对方开启那个开关，而自己一般不会/无法对自己的机器人做那个授权动作 [待验证]。加上要过认证 + 架 HTTPS 回调，成本远高于收益。

## 推荐顺序

1. **若只是「我自己看到通知」，QQ 根本不是必要通道** —— ntfy / Bark / 企业微信群机器人 5 分钟能跑起来且零封号风险
2. **要用 QQ 就用 NapCatQQ**，**强烈建议小号，不要主力号**
3. 官方平台是「长期稳定但功能阉割」的选项
4. 不推荐 go-cqhttp（已死）、Lagrange.OneBot（已停维）

## OneBot 11 最小接口

```bash
curl -X POST http://127.0.0.1:3000/send_private_msg \
  -H "Content-Type: application/json" \
  -d '{"user_id": 123456789, "message": "阿梓开播了"}'
# → {"status":"ok","retcode":0,"data":{"message_id":12345}}
```

群消息同理换 `/send_group_msg` + `group_id`。

### 发图片三种写法

```
[CQ:image,file=file:///C:/path/cover.png]     本地文件（要求 OneBot 进程本机可访问）
[CQ:image,file=https://example.com/x.jpg]     URL（NapCat 官方建议优先，比 base64 稳）
[CQ:image,file=base64://iVBORw0KGgo...]       Base64（大文件不建议）
```

或用消息段数组避免 CQ 码转义问题：

```json
{"message": [
  {"type":"text","data":{"text":"阿梓开播了"}},
  {"type":"image","data":{"file":"https://i0.hdslb.com/bfs/live-key-frame/..."}}
]}
```

**本项目直接用 keyframe 的 URL** —— 不落盘、不 base64，最省事。

**注意**：若 NapCat 与业务进程分离部署（如容器），`file://` 本地路径会失效，必须用 URL 或 Base64。

### 为什么不用 WebSocket

- 正向 WS：业务作为客户端连 OneBot 暴露的端口
- 反向 WS：OneBot 主动连业务暴露的服务端

对「开播 → 单向推送」这种场景，**HTTP 最简单**，不需维护长连接。WS 只在需要接收/响应 QQ 侧消息时才必要（例如后期做「发指令查询时间表」）。

## 本机 Windows Toast

| 方案 | 图片 | 点击跳转 | 备注 |
|---|---|---|---|
| **`powertoast`**（Node，推荐） | ✅ | ✅ protocol activation | xan105 维护，专注 Windows Toast + XML 构建，比 node-notifier 更贴近原生 API |
| PowerShell + BurntToast | ✅ `New-BTImage`（hero/appLogo） | ✅ `New-BTButton -ActivationType Protocol` | 功能完整、文档详细，但需用户装 PS 模块 |
| `node-notifier` | ✅ 图标 | ⚠️ 底层是 SnoreToast，issue #291/#324 反馈超时后在 Action Center 里点击不触发回调 | 跨平台但 Windows 端弱 |
| `win11toast`（Python） | ✅ `src` 可直接传 URL，无需落盘 | ✅ `on_click='https://...'` | 功能最全（进度条/输入框/多按钮），且借用 PowerShell 的 AppID 省掉注册麻烦。**但本项目是 TS** |

**坑**：这些方案都依赖一个 **AppID** 在系统注册（开始菜单快捷方式或注册表），否则通知可能显示为「Windows PowerShell」发的，或根本不弹。

选 `powertoast`，但点击回调未实测 [待验证]，实现时先跑一个最小验证。

## 兜底通道

| 通道 | 免费额度 | 图片 | 国内可达 |
|---|---|---|---|
| **ntfy** | 公共 `ntfy.sh` 免费（有按 IP 限流，具体数值未核实 [待验证]）；**自建 Docker 一条命令，无限制** | ✅ `attach` | 公共实例直连不稳，**建议自建** [待验证] |
| **Bark**（仅 iOS） | 官方 `api.day.app` 完全免费，可自建 | ✅ `icon` 小图标 + `image` 推送大图，都传 URL | 官方服务器在国外，自建可绕 |
| **企业微信群机器人** | 免费 | ✅ image 类型，但要 base64 + md5 校验 + 大小限制（通常认知 2MB [待验证]） | **最好**，纯内网 |
| **钉钉自定义机器人** | 免费 | ✅ markdown 内嵌图片链接或 image 类型 | 好，支持加签 |
| Telegram Bot | 免费 | ✅ `sendPhoto` | **国内直连基本不可用，需代理** |
| Discord Webhook | 免费 | ✅ embed | 同上 |
| Server 酱 | 免费版有额度限制，**具体数值未能确认最新值** [待验证] | ✅ Markdown 图片链接 | 好 |

**推荐组合**：国内直连稳 + 部署快 + 能带图 → **ntfy 自建** 或 **企业微信/钉钉群机器人**。

## Notifier 接口

见 [design.md 第 6 节](../design.md#6-关键数据结构)。要点：

- `capabilities.image` 让调度层知道该通道能否带图，为纯文本通道裁剪 payload
- `retryable` 给失败降级链留口子（QQ 失败 → fallback ntfy）
- 每个 Notifier 内部自己处理协议差异（CQ 码拼装、ntfy header、Bark query string），对外只暴露统一接口
- 并行 fan-out，收集各通道结果，不因一个通道失败阻塞其他

## 参考

- [NapCatQQ 接口文档](https://doc.napneko.icu/develop/api) / [文件处理指南](https://napneko.github.io/develop/file)
- [OneBot 11 消息段规范](https://github.com/botuniverse/onebot-11/blob/master/message/segment.md)
- [QQ 官方：消息收发概述](https://bot.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)
- [go-cqhttp 停维声明 issue #2471](https://github.com/Mrs4s/go-cqhttp/issues/2471)
- [BurntToast 文档](https://docs.toastit.dev/)

