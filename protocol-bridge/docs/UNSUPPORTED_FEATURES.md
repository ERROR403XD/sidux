# UNSUPPORTED_FEATURES — 明确不支持的能力

原则：**显式报错优于静默丢字段**。无法无损映射、且丢弃会改变语义的能力，直接抛 `UnsupportedFeatureError`（消息含能力名），让调用方看到明确失败而不是行为异常。

| 能力 | 原因 |
| --- | --- |
| `previous_response_id`（非空） | Responses 服务端会话存储语义。桥是无状态转换，无法还原历史；Codex 本身全量回放 input，不依赖它。 |
| `background: true` | 后台轮询式响应需要服务端任务队列，与一次性协议转换不兼容。 |
| `conversation`（managed conversations） | 同上，服务端托管状态。 |
| `input[] item_reference` | 引用服务端存储的 item，桥没有存储。 |
| `computer_call(_output)` / computer use 工具 | Chat Completions 无对应工具协议，且执行语义（屏幕截图循环）无法承载。 |
| `local_shell_call(_output)` / `local_shell` 工具 | Codex 对 codex-mini 模型的原生 shell 协议；标准模型走 function 工具不受影响。 |
| `custom_tool_call(_output)` / custom tools（freeform/text） | Chat Completions 只有 function 工具。 |
| `web_search_call` / `web_search` 工具（默认） | 内置搜索是 Responses 服务端能力；默认显式报错，`unsupportedTools:'omit'` 可降级为丢弃。 |
| `image_generation_call` / code_interpreter / 内置 MCP 工具与 item | 服务端内置工具，无 Chat 等价物。 |
| `input_audio` content part | 音频输入/输出不映射。 |
| 多 choice（n>1）流式 | 只转发 choices[0] 并告警（桥的调用方都是 n=1 语义）。 |
| file_id 形式的图片输入 | 只有 data URL / http URL 能转成 chat image_url。 |
| Responses `include` 指令（如 reasoning.encrypted_content） | 依赖服务端加密推理状态；桥输出纯文本 reasoning，指令无意义。 |
| 工具调用参数校验/自动修复 | 桥忠实转发参数字节；JSON 是否完整由上游负责（静默断流截断工具调用时按失败处理）。 |

## 由宿主负责、不属于本组件的限制

- 上游 HTTP 错误透传、鉴权、重试、超时、并发上限（见 INTEGRATION.md）。
- `/v1/responses/compact` 等 Codex 专有扩展端点（不走桥）。
- 供应商专有的 `reasoning_details`、`thinking` 字段当前不在默认候选列表（可用 `reasoningFields` 扩展）。
