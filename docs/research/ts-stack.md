# 调研：TypeScript 生态可行性

基准日 2026-07-29。验证环境：Windows 11、Node v22.18.0、Python 3.13.6、ffmpeg 7.1.1。

## 结论

**全项可行，唯一短板是中文 OCR** —— 隔离成独立服务解决。

## 本机工具链 [实测]

| 工具 | 版本 |
|---|---|
| Node | **v22.18.0**（不是 24 —— 影响 `node:sqlite` 仍需 `--experimental-sqlite`） |
| Python | 3.13.6 |
| uv | 0.11.23 |
| ffmpeg | 7.1.1-full_build（Gyan.dev，含 flv/hls demuxer） |
| git | 有 |
| Docker | **无** |

## 包版本 [实测，npm registry 查询]

| 包 | 版本 |
|---|---|
| `ai`（Vercel AI SDK） | 7.0.41（2026-07-28） |
| `@ai-sdk/google` | 4.0.27 |
| `@google/genai` | 2.13.0（2026-07-21） |
| `openai` | 7.1.0（2026-07-28，几乎逐日维护） |
| `zod` | 4.4.3 |
| `better-sqlite3` | 13.0.2 |
| `croner` | 10.0.1（2026-06-05） |
| `node-cron` | 4.6.0（2026-07-05） |
| `tesseract.js` | 7.0.0（2025-12-15） |
| `onnxruntime-node` | 1.27.0（2026-07-24） |
| `blive-message-listener` | 0.5.5（2026-05-10） |
| `tiny-bilibili-ws` | 1.0.3（2026-06-23） |
| `bilibili-live-ws` | 6.3.1（**2023-07-04，已两年多未更新**） |
| `powertoast` | 3.0.0 |
| `node-notifier` | 10.0.1（2026-06-29） |
| `fluent-ffmpeg` | 2.1.3（**2025-05-22，维护缓慢**） |

## 中文 OCR：最大疑点

### tesseract.js [实测]

自制 720x200 测试图（内容：`点歌台列表 / 1.晴天-周杰伦 / 2.稻香-周杰伦 / 主播今晚打游戏 分数:12345`）：

| 指标 | 结果 |
|---|---|
| 冷启动（首次下载 chi_sim 2.47MB） | 44443ms |
| 热启动初始化 | 141ms |
| 识别 | 125ms |
| 平均置信度 | 78 |
| 输出 | `点 歌 台 列表 / 1. 晴天 - 周杰伦 / 2. 稻 香 - 周杰伦 / 主 椰 今 晚 打 游 戏 分 数 : 12345` |

**「主播」识成「主椰」，汉字间乱插空格。而这是清晰打印体 + 纯白背景的最优情况** —— 直播截图的描边字体、复杂背景、半透明 UI 只会更差。

**必须知道的坑**：v7 默认走 `tesseract-core-relaxedsimd.wasm`，[实测] 反复报 `WebAssembly.instantiate(): section (code 10, "Code") extends past end of the module`（疑为 SIMD wasm 变体与本机 CPU/V8 的兼容问题，npm cache 完整）。解法是显式指定非 simd core：

```js
const worker = await createWorker('chi_sim', 1, {
  corePath: './node_modules/tesseract.js-core/tesseract-core-lstm.js',
  legacy: false,
});
```

### ONNX 路线 [文档，未实测精度]

`onnxruntime-node` 1.27.0 声明支持 win32/darwin/linux，**有 Windows x64 预编译二进制，不需自己编译**。

| 包 | 版本 | 说明 |
|---|---|---|
| `paddleocr`（x3zvawq/paddleocr.js） | 1.2.0，**2026-07-03 很新** | 基于 PaddleOCR v5 + ONNX Runtime，跨平台 |
| `@gutenye/ocr-node` | 1.4.8，2024-12（较久未维护） | `onnxruntime-node + sharp + @gutenye/ocr-models`，最像「Node 版 PaddleOCR」 |
| `@paddleocr/paddleocr-js` | 0.4.2，2026-06 | PaddleOCR 官方，但是**浏览器端**（ONNX Runtime Web + OpenCV.js），不是给 Node 后端用的 |
| `rapidocrjson` | — | 实质调用独立 C++ 可执行文件（RapidOCR-json.exe），Node 只是 stdin/stdout 包装 |

这些**只核实了包元信息（存在、有更新、依赖链合理），未验证真实识别效果** [待验证]。

### 建议

1. **首选：OCR 作为独立进程/服务** —— Umi-OCR 的 HTTP 服务或 Python PaddleOCR 微服务，Node 通过 HTTP/stdio 调用。PaddleOCR 是当前中文 OCR 天花板，直播截图（复杂背景、描边字、点歌列表小字）恰恰是 tesseract 最弱的场景。反正 ffmpeg 也是 subprocess，这不算妥协。
2. 若坚持纯 Node：`paddleocr`（x3zvawq）或 `@gutenye/ocr-node`，底层都是 PaddleOCR ONNX 导出模型，理论精度接近，但需自己先跑一遍验证。
3. `tesseract.js` 仅作「完全不想装额外依赖」的兜底。

**另一条思路**：keyframe 直接喂视觉 LLM，让它一次性同时做「读出画面文字」+「描述画面在干什么」，**本地 OCR 整个不需要**。代价是每次消耗视觉模型额度。留到真接分析层时再定。

## LLM 结构化输出

- **Gemini**：官方现推荐 `@google/genai`（2.13.0，很活跃）。旧包 `@google/generative-ai` **已官方标注 deprecated**，最后更新 2025-04-30。
  - **不直接吃 zod 对象**，需 `zodToJsonSchema()` 或 zod v4 自带的 `z.toJSONSchema()` 转换
  - **已知坑**：zod 自动加的 `$schema`、`additionalProperties: false` 会被 Gemini schema 校验拒绝（[js-genai#1318](https://github.com/googleapis/js-genai/issues/1318)），需手动清理
- **OpenAI SDK**：`zodResponseFormat` / `zodTextFormat` helper，改 `baseURL` 即可指向智谱/硅基流动/OpenRouter 等兼容端点
- **Vercel AI SDK**：`@ai-sdk/openai-compatible` 是官方维护的通用适配层。国内模型**没有官方一线 provider 包**，普遍走 openai-compatible + 自定义 baseURL

**选择**：`ai` + `@ai-sdk/google`（Gemini）+ `@ai-sdk/openai-compatible`（国内模型）+ zod + `generateObject`。

理由：业务只写一次 zod schema，换模型不改调用代码。本项目大概率要跑多个模型对比效果/成本，抽象层的价值就在这。若最终只锁 1-2 个 provider，直接用 `openai` 包 + `zodResponseFormat` 也够，不必引入额外抽象。

## 其余能力

| 能力 | 选择 | 依据 |
|---|---|---|
| SQLite | **`better-sqlite3`** | [实测] `npm install` 自动拉 win32-x64 预编译（约 2MB），**不触发本机编译**；`new Database(':memory:')` 插入读取中文正常。安装时会依次下载各平台 prebuild，耗时 1-2 分钟 |
| | 不用 `node:sqlite` | Node 22 上需 `--experimental-sqlite`，[实测] 可 import 但有 ExperimentalWarning，API 更底层（`DatabaseSync`） |
| | `drizzle-orm` 可选 | 架在 better-sqlite3 之上，要不要类型化查询看需求，非必需 |
| 调度 | **`croner`** | 零依赖、TS 原生、支持重叠防护。本场景 `setInterval` 也够，选它图 API 友好 |
| ffmpeg | **`child_process.spawn`** | `fluent-ffmpeg` 一年多未大动；本机已有 ffmpeg，命令固定，不值得引封装 |
| Toast | **`powertoast`** | 见 [notify.md](notify.md#本机-windows-toast)。点击回调未实测 [待验证] |

验证代码：

```js
import Database from 'better-sqlite3';
const db = new Database(':memory:');
db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
db.prepare('INSERT INTO t (name) VALUES (?)').run('测试中文');
console.log(db.prepare('SELECT * FROM t').get());   // { id: 1, name: '测试中文' }
```

## 为什么从 Python 改到 TS

Python 的优势原本集中在音频（inaSpeechSegmenter + TF）和 OCR（PaddleOCR）。音频降级为末位辅助后，那块优势不再值钱。

TS 的实际收益：

- RSSHub 本身是 TypeScript —— 它那套 WBI 签名 / 反爬处理逻辑可以直接读甚至复用
- Playwright 的一等公民是 Node（若 M3 走浏览器方案）
- zod schema 做 LLM 结构化输出比 Pydantic 更顺
- 后期做 UI 直接 Next.js 一体
- ffmpeg 两边都是 subprocess，语言中立

唯一代价是 OCR，用独立服务隔离掉。

