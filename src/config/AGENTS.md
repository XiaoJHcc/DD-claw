# config — 自举配置与代码默认值

只负责「启动时把配置读进来、校验、给出代码默认底形」。**运行参数的事实来源是 `settings` 表**（见 [../core/AGENTS.md](../core/AGENTS.md)），本目录不持有任何运行期状态的读写。机制细节与排障见 [docs/modules/core.md](../../docs/modules/core.md)。

## 长期不变量

- **`config.json` 只有 `panel` 段是活配置**（面板自举：面板改不了自己的端口），其余顶层字段一律无视；文件可以整个不存在 = 全部默认值启动。
- **`AppConfig` 只是代码常量底形**，供 `withRuntimeConfig` 叠加 settings 后给装配根 / source / router 消费。新增运行参数落在 `core/runtime-config.ts` 的规格表，不落在本目录。
- **配置错误启动即失败并指明字段**（zod issues 逐条列出），不允许带病启动；拉取类失败才有「保留旧状态」的容错，配置没有。
- **JSONC 与 BOM 是既有事实输入**：剥注释必须跳过字符串内部，读文件先剥 BOM（Windows 记事本 / PowerShell 写出的文件常带）。二者都是「被用户文件格式逼出来的」，不是可选优化。
- **秘密不进 `config.json`**：`DB_PATH` / `LOG_LEVEL` 在 `.env`，平台凭据在 `cookies.json` / `weibo-cookies.json`，LLM key 与决策模型 key 在 `settings`（面板填写）。本目录只输出 `dbPath` 这一项 secret。

## 文件地图

- `index.ts` — `loadConfig()`：读 `.env`（不引 dotenv）→ 剥 BOM / JSONC 注释 → zod 校验 → 返回 `{ app, secrets }`；`projectRoot` 解析；`ConfigError`；测试用注释剥离导出。
- `schema.ts` — `configSchema`（只校验 `panel`：enabled / port，默认 8787 只绑回环）、`llmProviderSchema`（面板 provider CRUD 校验）、`AppConfig` 字段接口与 `defaultAppConfig()`（所有运行参数的代码默认值）。
