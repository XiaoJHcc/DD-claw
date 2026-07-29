# 调研：凭据获取方案

基准日 2026-07-29。前提：[feeds.md](feeds.md) 已确认动态/微博匿名不可得。

**安全边界**：本次调研只验证方法可行性，**未读取、解密或输出本机任何真实 cookie 值**。

## 结论

**手动导出一次 → `cookies.json`（gitignore）→ `isLogin` 心跳检测失效。**

自动读浏览器 cookie 这条路对 Chrome/Edge 已经死了。

## 为什么不能自动读 Chrome/Edge

### App-Bound Encryption（Chrome 127+，2024-07）

| | 旧方案（cookie 前缀 `v10`） | ABE（前缀 `v20`） |
|---|---|---|
| key 保护 | DPAPI，绑定「当前登录用户」 | DPAPI 之上再由一个 SYSTEM 权限服务（IElevator）包一层 |
| 后果 | 任何以该用户身份运行的进程都能 `CryptUnprotectData` 解出 key | 该服务只认「是不是 Chrome 本体在请求」（校验调用方签名/路径），**普通脚本拿不到最终 key** |

这正是过去 `browser_cookie3` / `chrome-cookies-secure` 能工作、现在不能的原因。

### ABE 能被绕过，但手段不可接受

2025-2026 年的公开研究（VoidStealer 恶意软件、CyberArk "C4 Bomb"、xaitax 的解密工具）证明 ABE 可绕，但手段清一色是：

- 进程注入 / 反射式 process hollowing（基于直接系统调用）
- COM 服务伪装
- LSASS 模拟

**这就是恶意软件手法**，不该塞进一个自用项目。本项目明确不采用。

### 各库现状

| 库 | 状态 |
|---|---|
| `browser_cookie3` | issue 区持续冒 "Unable to get key for cookie decryption"（#141/#180/#97），对 ABE 保护下的 Chrome/Edge **基本失效**。未见官方「已修复」声明 |
| `rookie`（Rust） | 作者另开 gist 讲「如何绕过 v20」和「用 Remote Debugging 无需管理员权限提取」—— **社区已从「解密文件」转向「让 Chrome 自己吐 cookie」** |
| `chrome-cookies-secure` / `pycookiecheat` | 未查到关于 ABE 支持状态的明确讨论 [待验证] |

### 其他浏览器

- **Edge**：有策略项 `ApplicationBoundEncryptionEnabled`，已引入同类机制。个人机默认是否强制开启 [待验证]
- **Firefox**：`cookies.sqlite` 至今**未加密**，也没有引入 ABE 的迹象 —— 2026 年在 Windows 上唯一还能直接读的浏览器。代价是要专门开一个 Firefox 只用来登录B站/微博

## Playwright 三种复用方式

| 方式 | 可行性 | 代价 |
|---|---|---|
| `storageState` 导出 JSON | ✅ 官方支持模式 | 静态快照，过期要重新登录导出 |
| `launchPersistentContext(userDataDir)` | ⚠️ 需 `channel: 'chrome'` 用真实 Chrome（这样 ABE 不是障碍，因为是 Chrome 自己解密）；但用户已开着 Chrome 会撞 `SingletonLock`。复制 profile 可行，但复制时原 Chrome 正在写入可能拷出不一致状态 | 要处理冲突 + 常驻一个后台 Chrome |
| `connectOverCDP` | ❌ **Chrome ≥136 不再支持对默认 `--user-data-dir` profile 用 remote debugging**（`browser-use` issue #1520 标题即此）。workaround 是复制 profile + 单独起带调试端口的实例 —— 等价于上一种方式 | 复杂度最高，收益相同；且本地调试端口是新增攻击面（同机进程、DNS rebinding） |

**排序**：`storageState` > `launchPersistentContext` > `connectOverCDP`。

## 推荐方案：手动导出

### B站需要的字段

以下是社区共识（RSSHub、各类脚本交叉印证），非官方逐字文档 [文档]：

| 字段 | 作用 | 必需性 |
|---|---|---|
| `SESSDATA` | 登录会话核心令牌 | **必需** |
| `bili_jct` | CSRF token，主要用于写操作 | 读接口非必需，建议带 |
| `DedeUserID` | 明文 UID | 建议带 |
| `DedeUserID__ckMd5` | 配套校验值 | 建议带 |
| `buvid3` / `buvid4` | 设备指纹，风控相关 | **强烈建议** |
| `b_nut` | 较新的风控字段 | 建议带 |
| `sid` | 会话追踪 | 一般非鉴权必需 |

**关键建议：导出完整一整套，别只挑「必需」的三五个。** 动态接口本身就是风控重点（`bilibili-api` 有专门 issue「获取用户动态有高概率触发412风控」），缺某个不起眼字段往往就是间歇性 412 的元凶。

### 微博需要的字段

`SUB`（核心，等价于 SESSDATA）、`SUBP`（配套）、`SSOLoginState`、`_T_WM`。

**域名注意**：`weibo.com` 和 `m.weibo.cn` 是不同顶级域，浏览器不会跨域共享 cookie。同一个 `SUB` 值往往两个域都能用（服务端账号体系是通的），但这是**经验性说法未验证** [待验证] —— 用哪个域就从那个域导。

### 有效期

网传 SESSDATA 半年到一年，**无官方声明** [待验证]。

**不要在代码里硬编码天数做预警**，改用心跳检测。B站存在 `correspond_path`/refresh_token 式的刷新流程（RSSHub issue #18019 有讨论），但实现成本可能超过「偶尔手动重导一次」，不建议优先做。

### 操作步骤

DevTools → Application/存储 → Cookies → 选站点域名 → 复制。

注意 `SESSDATA`、微博 `SUB` 通常是 **HttpOnly**，Console 里 `document.cookie` 读不到，必须走 Application 面板。

**不建议装 cookie 编辑扩展**。这类扩展的权限恰恰是「读你所有站点登录态」，而 2025-2026 的扩展生态出过多起信任事故：

- EditThisCookie 正版 2024-12 被 Chrome Web Store 误下架（与恶意仿冒版混淆），现在商店里搜到的多是来源不明的 fork
- **ModHeader（安装量 160 万）2026-07 被 Google 与微软联合下架，原因是发现藏有休眠的数据外泄代码**

一次性动作用 DevTools 手抄就够了。若确实要用，`Cookie-Editor`（cookie-editor.com）风评相对好，装前自己看权限范围。

## 工程实现

**存储**：单独的 `cookies.json`（不塞 `.env`）—— cookie 是结构化多字段数据，JSON 更契合；`.env` 适合单值配置。加入 `.gitignore`。

**失效检测**：

1. 定期打轻量鉴权探测接口（B站用 `api.bilibili.com/x/web-interface/nav` 看 `isLogin`）
2. 探测到失效（`code == -101`）→ **停止继续拉取**、记日志、发一次告警。不要对着失效 cookie 无限重试（这本身也是降低风控风险的手段）
3. 提供重新导入入口：监听 `cookies.json` 文件变化，检测到更新即热加载恢复轮询，无需重启

## 风险

### 封号风险

- B站对「获取用户动态」接口确实敏感（`bilibili-api` issue #1012 明确记录「高概率触发412」），登录态下概率降低但不会消失
- 常见失败模式是**临时拦截/412 而非永久封号**。[待验证] **未查到「个人自用低频轮询导致账号被封」的具体案例，但没找到反例不等于没有风险**
- 建议 [待验证]：5 分钟级轮询相对温和；只读操作风险低于写操作（符合一般反滥用系统设计逻辑，但无官方声明）；**用小号而非主号** —— 这是「万一出事损失可控」的风险管理常识，不是官方许可

### 泄露后果

`SESSDATA` + `bili_jct` 或 `SUB` + `SUBP` 泄露（例如误提交进 git 历史），攻击者可在 cookie 失效前**完全冒充你的登录会话** —— 读私信、执行写操作（发帖、改设置）。这不是「只能看公开动态」那么轻，要按账号被盗处理。

**兜底失效手段：改密码。** 基于会话令牌的体系（B站、微博都是）改密码会使所有已发出的令牌立即失效。两家的账号安全中心通常也有「登录设备管理/强制下线」，具体入口以实际页面为准。

## 参考

- [Google Security Blog: Improving the security of Chrome cookies on Windows](https://security.googleblog.com/2024/07/improving-security-of-chrome-cookies-on.html)
- [browser-use issue #1520: Chrome >= v136 no longer supports CDP with default user-data-dir](https://github.com/browser-use/browser-use/issues/1520)
- [Playwright Authentication docs](https://playwright.dev/docs/auth)
- [The Hacker News: Google and Microsoft pull ModHeader](https://thehackernews.com/2026/07/google-and-microsoft-pull-modheader.html)

