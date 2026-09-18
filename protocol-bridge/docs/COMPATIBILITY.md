# COMPATIBILITY — 供应商差异与兼容选项

协议核心只认归一化模型；供应商差异集中在 `ProviderCompatOptions`（`src/types.ts`）与 `src/compatibility/reasoning.ts`。所有选项可按连接配置，默认值面向 Codex + 主流 OpenAI-compatible 供应商。

## 选项一览

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `reasoningFields` | `['reasoning_content', 'reasoning']` | 依次探测的上游推理字段名。`reasoning_content` 覆盖 DeepSeek/千问系；`reasoning` 覆盖 OpenRouter 透传形状。 |
| `maxTokensField` | `'max_tokens'` | 输出上限字段。个别较新供应商要求 `max_completion_tokens`。 |
| `includeUsageInStream` | `true` | 请求流式时附 `stream_options:{include_usage:true}`。极个别供应商会拒绝未知字段，可关闭（代价：流式 usage 缺失）。 |
| `unsupportedTools` | `'error'` | 非函数工具定义（web_search 等）：`'error'` 显式失败；`'omit'` 丢弃并告警（继承旧 OpenRouter 包装行为）。 |
| `silentClose` | `'complete'` | 上游静默断流（无 finish/[DONE]）时按完成收尾（`'complete'`，宽松）还是按失败收尾（`'fail'`，严格）。存在未闭合工具调用时无论选项都按失败。 |

## 已适配的供应商形状（无需配置即可工作）

| 供应商形状 | 表现 | 处理 |
| --- | --- | --- |
| DeepSeek / 千问系 `reasoning_content` | 流式 reasoning + 回放 | 默认 `reasoningFields` 直接命中 |
| OpenRouter 透传 `reasoning` 字段 | 流式 reasoning | 默认候选第二项 |
| Gemini 反代把 delta.content 发成 content parts 数组 | 文本流 | `extractDeltaText` 解析 part 数组 |
| 函数名分片流式（name 拆多个 delta） | 工具调用 | `toolCallNameDelta` 累计，item.done 携带完整名 |
| 首个 delta 缺 `tool_calls[].id` | 工具调用 | 合成 `call_*` id |
| usage 常驻最后一个 chunk / 完全缺失 | 计量 | 尾随 usage 被 `response.completed` 吸收；缺失时 usage 不出现在 completed（宿主计量记 unknown） |
| `data:` 无空格 / CRLF / 心跳注释 / 空 frame | 传输 | SseParser 统一消化 |
| 静默断流 | 终止 | 见 `silentClose` |

## 新增供应商的接入方式

1. 仅字段名差异 → 调整 `reasoningFields` / `maxTokensField` 等选项（宿主按连接配置传入）。
2. delta 结构差异（如新的 content part 形状）→ 扩展 `chat/streamDecoder.ts` 的容错解析，保持 IR 不变。
3. 完全不同的 wire 协议（如 Anthropic Messages）→ 新增一对 decoder/encoder + translator 门面，复用 IR 与 SseParser；不要在现有 encoder 里加 if。

修复线上 bug 时，把原始样本放进 `test/fixtures/` 并补金样本断言（见 TESTING.md）。
