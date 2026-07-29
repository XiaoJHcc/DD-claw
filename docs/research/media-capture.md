# 调研：直播画面截图与音频抽取

基准日 2026-07-29。实测房间：`1814372768`（团播，在线 37 万+）。

## 结论

- **MVP 阶段完全不需要 ffmpeg** —— 轮询返回的 `keyframe` 字段就是可直接用的预览图。
- 需要音频时走 **FLV + 一条合并命令**同时取图和音频，别用 HLS。

## keyframe：服务端已经帮你截好了 [实测]

B站服务端定期为每个直播间生成关键帧缩略图：

```
https://i0.hdslb.com/bfs/live-key-frame/keyframe072918300018143727685jhbin.jpg
```

- 静态 jpg，直接 GET 即可，**不需要 UA / Referer / Cookie**（实测特意不带 UA 也返回同样的 23695 字节）
- 文件名内嵌时间戳（`0729 1830 00` = 月日时分）
- **刷新频率约 5 分钟**（抽样观测：两次请求间，某房间从 `1830` 变为 `1835`）。非官方 SLA 承诺。[待验证]
- 分辨率 405x720（竖版源），缩略图画质，**但内容识别完全够用**
- 获取途径：`get_status_info_by_uids` 的 `keyframe` 字段（本项目主轮询接口自带），或分区列表接口 `room/v3/area/getRoomList` 的 `system_cover` 字段

| | keyframe | ffmpeg 主动截图 |
|---|---|---|
| 成本 | 一次静态 GET，几十 KB | 建流连接 + 解码 |
| 时效 | 约 5 分钟一刷，不可控 | 任意时刻的「现在」 |
| 画质 | 405x720 缩略图 | 可选 150/250/400 档 |
| 音频 | **无** | 可同时取 |

**取舍**：采样间隔 ≥5 分钟且只要画面 → 直接用 keyframe。一旦需要音频就得拉流，而拉流时顺手截一帧几乎零成本，那时就不必再维护 keyframe 这条独立路径。

## 拉流地址 [实测]

```
GET https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo
  ?room_id=<房间号>&no_playurl=0&mask=1&qn=0
  &platform=web&protocol=0,1&format=0,1,2&codec=0,1,2
```

`protocol`: 0=http_stream(FLV) / 1=http_hls；`format`: 0=flv / 1=ts / 2=fmp4；`codec`: 0=avc / 1=hevc / 2=av1

必带 header：`User-Agent` + `Referer: https://live.bilibili.com/`，否则 `-352`。

返回结构：

```
data.playurl_info.playurl.stream[].protocol_name
  └ .format[].format_name
      └ .codec[].codec_name / .current_qn / .accept_qn[]
          ├ .base_url                 # 路径部分
          └ .url_info[].host / .extra # 完整 URL = host + base_url + extra
```

### 画质与登录 [实测]

不登录传 `qn=10000`（原画）会**静默降级**：返回 `current_qn=250`，而 `accept_qn` 里仍列着 `[10000, 250]`。

**代码不能假设拿到的就是请求的档位** —— 必须读 `current_qn`，用 `accept_qn` 做兜底选择，不要硬编码 qn 值（不同房间/分区可能不同）。

给 LLM 看画面 `qn=150/250` 足够。原画码率是超清的 3~5 倍，纯粹浪费流量和视觉 token（多数多模态模型会压缩/切块，超过阈值后不增加信息量）。

### FLV vs HLS [实测]

| | 截 1 帧耗时 |
|---|---|
| FLV（http_stream） | **0.9~1.2s** |
| HLS fmp4 | ~11s（要解析 m3u8 索引 + 处理 `Found duplicated MOOV Atom`） |

「打一枪就走」的采样一律用 FLV。HLS 的断线重连语义更适合长时间录制，与本项目无关。

### CDN 链接有效期

`extra` 里带 `expires=<Unix时间戳>`，观测值约 **2 小时**。[待验证] 官方未公开具体秒数。

**建议每次采样前重新请求 `getRoomPlayInfo`**，不缓存复用。

## ffmpeg 命令

### 同时输出截图 + 音频（推荐）[实测]

```bash
ffmpeg -y -loglevel error \
  -user_agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ..." \
  -headers "Referer: https://live.bilibili.com/\r\n" \
  -i "<FLV_URL>" \
  -frames:v 1 -update 1 -q:v 2 shot.jpg \
  -t 5 -vn -ac 1 -ar 16000 audio.wav
```

实测约 8s（瓶颈是音频时长本身），只建一次 CDN 连接，比分两次调用更省。

### 参数顺序的坑 [实测]

**输入选项（`-user_agent` / `-headers`）必须在 `-i` 之前，输出选项（`-frames:v` / `-t` / `-q:v`）必须在 `-i` 之后。** 顺序错了 ffmpeg **不报错**，但选项静默失效。

其余要点：

- **别加 `-ss`** —— 直播流没有可寻址时间轴，读流第一帧就是「现在」。加了反而可能触发 seek 变慢。
- `-frames:v 1` 要配 `-update 1`，否则报「图片序列缺 `%03d`」警告。
- `-t 5` 放在 `-i` 之后，ffmpeg 才会真的只拉 5 秒就断开。
- 未开播时 `playurl_info` 为 `null`，调 ffmpeg 前先查 `live_status`。

### 音频格式

给 ASR 用 `-ac 1 -ar 16000 -acodec pcm_s16le`（wav，5 秒约 160KB）。省空间可换 `libmp3lame -b:a 64k` 或 `libopus -b:a 32k`。

## 成本 [实测]

| 场景 | 耗时 | 流量 |
|---|---|---|
| FLV 截 1 帧 | 0.9~1.2s | 几十~200KB（1 个 GOP 内） |
| HLS 截 1 帧 | ~11s | 相近但握手更慢 |
| 5 秒音频（含混流下载） | 6.8s | 约 1MB，纯音频部分 160KB |
| 合并命令（图+5s音频） | ~8s | 1~1.5MB |

## 采样策略建议

- 周期 **3~5 分钟**（与 keyframe 刷新频率相近，更密无意义）
- 每次：查 `live_status` → 请 `getRoomPlayInfo`（`qn=150/250`）→ 合并命令取图+音频 → 丢弃 URL
- 并发多房间时限流到 10~20 路，加退避重试

## 调用方式

本机已有 ffmpeg 7.1.1（`winget install Gyan.FFmpeg`）。Node 侧直接 `child_process.spawn` —— `fluent-ffmpeg`（2.1.3）最后更新 2025-05，维护缓慢，本项目命令固定，不值得引入封装。

## 参考

- [streamlink 的 bilibili plugin（最权威的第三方实现）](https://github.com/streamlink/streamlink/blob/master/src/streamlink/plugins/bilibili.py)
- [lovelyyoshino/Bilibili-Live-API getRoomPlayInfo](https://github.com/lovelyyoshino/Bilibili-Live-API/blob/master/API.getRoomPlayInfo.md)
- 可参考的录制项目：`acgnhiki/blrec`（已转向 OneLiveRec）、`hr3lxphr6j/bililive-go`、录播姬、DDTV。均面向完整录制，对「短采样」过重。

