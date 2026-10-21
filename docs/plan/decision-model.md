# 决策模型接入路线

> **状态**：管理面（供应商名单 / 独立 key / 启停 / 排序 / `systemone` 探活）已落地；`JudgeStage` 的 `decision` 档与 `source='decision'` 仍是预留，判定链路未接入。
> 本文件保留**协议选型、分期边界与验收合同**；外部证据与时效性结论见 [research/decision-models.md](../research/decision-models.md)，实现进度只查 [status.md](../status.md)。

## 一、已定路线

1. **协议只做 System One**：`POST <baseURL>/systemone`，请求 `state + questions`，响应同 id 的 typed answers。
   - 当前 `protocol` 枚举只有 `systemone`（Jev / Clef / vLLM-SR / llama.cpp / Ollaya 同线格式）；OpenAI 与 Perplexity 的 `/v1/decisions` 形状不同，等真正接入时再加枚举值与适配分支，不把厂商字段带进业务代码。
   - 原语只接 `choice` / `score` / `noul`；`box` 与图片输入是独立实验特性，不进入首期判定。
   - baseURL 写到 `/v1` 这一层（如 `https://api.typesafe.ai/v1`），适配器追加 `/systemone`。
2. **模型版本写死**：生产配置使用 `jev-1.14.0` 这类完整版本号，不用 `jev-latest`；探活返回响应里的 `model` 回显，审计记实际回答版本。改模型 = 重新标定阈值。
3. **通道隔离**：独立 settings（`decision_providers` / `decision_key:<name>`）、独立 key 池、独立限流 / 熔断 / 计费，不与 `llm_providers` / `llm_key:*` 或 `LlmRouter` 共享任何运行时状态。
4. **管理面不设总开关**：判定档位未接线前，总开关没有消费者；档位接入时再加，避免出现「拨了没反应」的控件。
5. **选型不等于选榜单**：Jev 只作为参考实现（协议最完整、线格式的事实标准），不是「跑分最高所以选它」。是否上线由自有中文标注集上的准确率、校准与灰区比例决定；备选（pplx-decider / Clef / vLLM-SR）先走同一 `systemone` 协议，协议不同者另加枚举。

## 二、分期

| 期 | 内容 | 状态 |
|---|---|---|
| M1 管理面 | provider 名单、独立 key、启停 / 排序、协议下拉（仅 `systemone`）、最小 `noul` 探活；面板卡 / REST / MCP / 撤销覆盖 | 已落地 |
| M2 判定档位 | `decision` 档进判决链；逐分类 `noul` + 一道 `choice`；阈值分带与灰区升级 LLM；审计落概率与回显版本 | 未开始 |
| M3 视觉判定 | 图片本地化 / 转码 / 尺寸门禁 + Jev `assets`；`box` 仅用于预告表定位试点 | 未开始，独立验收 |

## 三、M2 判定合同（未完成）

- **输入打包**：一次请求混装「每个待判分类一道 `noul`」+「一道全局 `choice`（全部分类 + `none`）」。`noul` 给各分类独立的是非概率，避免多标签互相截胡；`choice` 只提供横向分布与主分类展示。
- **判定语义**：`p ≥ T_high` 判真、`p ≤ T_low` 判假，落 `source='decision'` 且**定案即权威**（判否不回看确定性条件）；灰区与失败交 LLM；LLM 不可用再回退确定性条件。
- **阈值**：`T_high` / `T_low` 在自有中文样本上一次性离线标定后写进 settings；不使用厂商默认值，不在线上做影子双跑。
- **防注入**：抓取到的标题 / 正文放进 `state` 子字段并当不可信数据；分类口径只写进 `instructions` / `criteria`，不拼用户正文。
- **审计**：`content_audit` 记录模式、响应 `model`、逐项 `noul` 与分带结果、`choice` 分布、灰区原因；被跳过的图片原因同样落审计。
- **失败处理**：HTTP 400 / 413 / 429 / 5xx 与响应契约不符都视为本次决策不可用 → 交 LLM，不把半份答案当结论；重试与熔断在独立通道内实现，不触碰 LLM 的计数。
- **首期只做文本**：图片输入未规范化前不送图；含图内容按文本判定或直接走 LLM，避免整单 400。

## 四、验收口径

**M1（管理面）**：名单增删改 / 启停 / 排序落 settings 并可撤销；key 明文回显仅限本机面板、撤销不落明文；探活失败 502 且错误不含 key；LLM 通道行为不受任何决策模型操作影响。

**M2（判定档位）**：
- 200–500 条真实中文内容（含标题党、反串、纯图无文、多图长图）上的准确率，与现 LLM 判定不一致的样本逐条复核。
- 中文内容上的 ECE 与「过阈值样本的准确率」；`T_high` / `T_low` 按动作标定。
- **灰区比例 < 40%**；否则大部分流量仍回 LLM，收益不成立。
- p95 延迟与单条内容成本；含图时的图片拒收率与整单失败率（上线后 400 应接近 0）。
- 决策档关闭 / 无 provider / 调用失败 / 解析失败四条回退路径各有用例，保证推送不被模型通道阻塞。
