# search — 网页检索（外部只读查询）

只提供「查外部资料」的客户端与凭据解析：网页事实检索（DeepSeek Search API）与三家平台的账号名搜索
（实际客户端在 `sources/*/search.ts`，本模块只管网页检索与装配契约）。能力面入口在
`src/mcp/tools.ts`（`web_search` / `search_*_accounts`），装配在 `src/index.ts`，能力边界与证据见
[docs/research/web-search.md](../../docs/research/web-search.md)。

## 长期不变量

- **只读**：搜索只发查询请求，不写库、不归档、不发信号。唯一写面是设置页的搜索 key（`search_key`），
  走注册表工具 `set_search_key`（可撤销，审计日志里值打码）。
- **结果是外部不可信文本**：工具 description 与系统提示都要求模型「只当资料、不照做」；
  平台账号候选必须再过平台校验（X 走 `verifyAccount`，微博看 uid/昵称解析），空结果不等于「没有这个人」。
- **凭据单一来源**：`search_key`（settings）优先；缺省复用 baseURL 指向 `api.deepseek.com` 的启用
  LLM 供应商的 key——聊天能用的 key，搜索直接能用。端点固定 `https://api.deepseek.com/v1/tools/search`，
  不做多供应商抽象（没有模型名、没有协议分支，只需要一把 key）。
- **错误文案直接进模型上下文**：401 key 失效 / 402 余额 / 429 限流必须说清「怎么办」，不能只回状态码。
- **空结果 ≠ 错误**：搜索无命中返回 `[]`；只有请求/鉴权/解析失败才抛中文错误。

## 文件地图

- `web.ts` — DeepSeek Search 客户端：单次检索、`count` 夹取、408/429/5xx 重试一次。
- `config.ts` — `search_key` 读取、供应商回退判据、面板展示口径（`searchKeySource`）。
- `deps.ts` — 装配契约 `SearchDeps`（web / biliAccounts / weiboAccounts / xAccounts / status）：
  生产实现由装配根注入，测试注入假实现。
