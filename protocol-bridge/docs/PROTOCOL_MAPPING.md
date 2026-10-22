# PROTOCOL_MAPPING — 字段级映射

方向命名：**主方向** = Responses(客户端) → Chat(上游)；**反方向** = Chat(客户端) → Responses(上游)。

## 1. 请求：Responses → Chat

| Responses | Chat Completions | 说明 |
| --- | --- | --- |
| `model` | `model` | 必填，缺失报 `ProtocolConversionError` |
| `instructions` | 首条 `system` 消息 | |
| `input: string` | 一条 `user` 消息 | |
| `input[].type=message, role=user/assistant` | 同角色消息 | 内容数组 → 文本拼接（单 text part 退化为字符串）；`input_text`/`output_text` 均映射 |
| `role: developer` / `role: system` | `role: system` | |
| `input[].type=reasoning` | 相邻 assistant 消息的 `reasoning_content` | 取 `content` 或 `summary` 文本；仅 `encrypted_content` 的跳过并告警 |
| `input[].type=function_call` | assistant 消息的 `tool_calls[]` | `call_id`→`tool_calls[].id`，`name`/`arguments` 直映；与相邻 assistant 文本合并 |
| `input[].type=function_call_output` | `role:tool` 消息 | `call_id`→`tool_call_id`；`output` 字符串直用，其它 JSON 序列化 |
| `input[].type=input_image`（data URL / http URL） | `image_url` content part | `file_id` 形式告警丢弃 |
| `max_output_tokens` | `max_tokens`（或 compat 指定 `max_completion_tokens`） | |
| `temperature` / `top_p` / `service_tier` / `parallel_tool_calls` | 同名直映 | |
| `reasoning.effort` | `reasoning_effort` | `reasoning.summary` 提示丢弃并告警 |
| `tools[].type=function` | `tools[].type=function.function{}` | `name/description/parameters/strict` 直映；其它工具类型见 UNSUPPORTED |
| `tool_choice: auto/none/required` | 同名 | |
| `tool_choice: {type:function, name}` | `{type:function, function:{name}}` | |
| `text.format.type=json_object` | `response_format:{type:json_object}` | |
| `text.format.type=json_schema` | `response_format:{type:json_schema,json_schema:{...}}` | |
| `stream: true` | `stream: true` + `stream_options:{include_usage:true}`（compat 可关） | |
| `store: false`、`metadata`、`user`、`safety_identifier` | 丢弃 | 无语义损失，不告警 |
| `include`、`prompt_cache_key`、`reasoning.summary` | 丢弃并写入 `warnings` | |
| `previous_response_id`（非空）/ `background: true` / `conversation` | **显式报错** | 依赖服务端状态，转换层无法承接 |
| 未知顶层字段 | 丢弃并写入 `warnings` | 不让 Codex 未来新增字段炸掉桥 |

## 2. 非流式响应：Chat → Responses

| Chat | Responses | 说明 |
| --- | --- | --- |
| `id` / `created` / `model` | `id` / `created_at` / `model` | id 原样透传（客户端视为不透明） |
| `choices[0]` | 全部输出 | 多 choice 告警丢弃（桥总是 n=1 语义） |
| `message.reasoning_content`（compat 字段） | 第一个 output item：`type:reasoning` + `summary:[{type:summary_text}]` | reasoning 先于 message，符合 OpenAI 输出顺序 |
| `message.content` | `type:message` item + `output_text` part | |
| `message.tool_calls[]` | `type:function_call` item | `id`→`call_id`；缺失时合成 |
| `finish_reason: stop/tool_calls` | `status: completed` | |
| `finish_reason: length` | `status: incomplete` + `incomplete_details:{reason:max_output_tokens}` | |
| `finish_reason: content_filter` | `status: incomplete` + `incomplete_details:{reason:content_filter}` | |
| `usage.prompt_tokens/completion_tokens/total_tokens` | `usage.input_tokens/output_tokens/total_tokens` | |
| `usage.prompt_tokens_details.cached_tokens` | `usage.input_tokens_details.cached_tokens` | |
| `usage.completion_tokens_details.reasoning_tokens` | `usage.output_tokens_details.reasoning_tokens` | |

## 3. 请求：Chat → Responses（反方向）

| Chat | Responses |
| --- | --- |
| `messages[] role=system/developer` | 合并进 `instructions` |
| `messages[] role=user/assistant` | `input[] message`（assistant 之前的 `reasoning_content` 还原成 `reasoning` item） |
| `messages[] role=tool` | `input[] function_call_output` |
| assistant `tool_calls[]` | `input[] function_call` |
| `max_tokens` / `max_completion_tokens` | `max_output_tokens` |
| `tools[].function{}` | `tools[]{type:function, name, ...}` |
| `tool_choice {type:function, function:{name}}` | `{type:function, name}` |
| `reasoning_effort` | `reasoning:{effort}` |
| `response_format` | `text.format` |
| `stream_options` | 丢弃并告警（Responses 流天然带 usage） |

## 4. 流式事件映射

见 [STREAMING.md](STREAMING.md)（含完整事件序列与状态机）。

## 5. 错误语义

| 场景 | 行为 |
| --- | --- |
| 上游 HTTP ≥ 400 | 由宿主原样透传（转换层不参与；未向客户端写过 SSE 时可安全返回 HTTP 错误） |
| 请求含不可转换能力 | `UnsupportedFeatureError`（HTTP 400 语义），消息含能力名 |
| 请求形状错误 | `ProtocolConversionError` |
| 上游 SSE 帧超限 | `ProtocolParseError` |
| 流已开始后上游崩溃/断开 | `response.failed`（error.code = `stream_interrupted` / `upstream_error`） |
| 静默断流（无 finish/[DONE]） | 默认按 stop 收尾；存在未闭合工具调用或 `silentClose:'fail'` 时 → `response.failed` |
