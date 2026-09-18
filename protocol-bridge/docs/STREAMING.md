# STREAMING — 事件转换与状态机

## 为什么必须有状态机

Chat Completions 与 Responses 的流式模型不同构：

- Chat 是**纯增量**：`delta.content` / `delta.tool_calls[].function.arguments` 只有片段，没有累计文本；工具调用多路复用靠 `tool_calls[].index`；usage 常在 finish 之后的独立 chunk。
- Responses 是**带完整状态的**：`output_item.done` / `output_text.done` / `response.completed` 都要携带完整 item 文本与最终 output 数组；每个 item 有独立 `output_index` 与 `item_id`。

因此“看到 chunk 就字符串替换”不可行，必须维护：response 元数据、output index 分配、item id、每个工具调用的 id/name/arguments 累计、finish reason、usage、sequence number。

## 主方向：Chat SSE → Responses SSE

### 文本流的完整事件序列（金样本）

```
data: {"type":"response.created","response":{...status:"in_progress","output":[]}}
data: {"type":"response.in_progress","response":{...}}
data: {"type":"response.output_item.added","output_index":0,
       "item":{"type":"message","id":"msg_*","status":"in_progress","role":"assistant","content":[]}}
data: {"type":"response.content_part.added","item_id":"msg_*","output_index":0,"content_index":0,
       "part":{"type":"output_text","text":"","annotations":[]}}
data: {"type":"response.output_text.delta","item_id":"msg_*","output_index":0,"content_index":0,"delta":"..."}   ← 每个 delta 一条
data: {"type":"response.output_text.done","item_id":"msg_*","output_index":0,"content_index":0,"text":"完整文本"}
data: {"type":"response.content_part.done",...,"part":{"type":"output_text","text":"完整文本",...}}
data: {"type":"response.output_item.done","output_index":0,"item":{...完整 item, status:"completed"}}
data: {"type":"response.completed","response":{...,"status":"completed","output":[...完整数组...],"usage":{...}}}
```

### 推理流（DeepSeek `reasoning_content` 等）

```
response.output_item.added            item: {type:"reasoning", id:"rs_*", summary:[{type:"summary_text","text":""}]}
response.reasoning_summary_part.added summary_index: 0
response.reasoning_summary_text.delta ← 每个推理 delta 一条
response.reasoning_summary_text.done  text: 完整推理文本
response.reasoning_summary_part.done
response.output_item.done             item: {type:"reasoning", id:"rs_*", summary:[...]}
```

选择 summary 而非 raw `reasoning_text.delta`：Codex CLI 与本应用 UI 对 `summary_text` 事件有稳定的实时渲染路径（实时推理浮层）；summary 是 OpenAI 对第三方模型推理内容的官方承载形状。

### 工具调用流

Chat 侧：

```
delta.tool_calls[{index:0, id:"call_1", function:{name:"shell", arguments:""}}]   ← 首个 delta 携带 id/name
delta.tool_calls[{index:0, function:{arguments:"{\"cmd\":"}}]                     ← 参数增量（可能几十个 chunk）
delta.tool_calls[{index:0, function:{arguments:"ls\"}"}}]
finish_reason: "tool_calls"                                                       ← 通常最后才有
```

Responses 侧（每个工具调用一个 item，`output_index` 按到达顺序分配）：

```
response.output_item.added            item: {type:"function_call", id:"fc_*", status:"in_progress",
                                             call_id:"call_1", name:"shell", arguments:""}
response.function_call_arguments.delta  delta:"{\"cmd\":"      ← 每个参数增量一条
response.function_call_arguments.done   arguments:"{\"cmd\":\"ls\"}"
response.output_item.done             item: {..., status:"completed", arguments:完整 JSON}
```

参数增量**即时转发**（首 token 延迟与内存都 O(1) per delta）；完整参数在 done 事件中给出。

并行工具调用：Chat 用 `index` 复用同一条消息，桥为每个 index 分配独立 item；交错到达的增量按各自 item 输出，互不串流。

文本 + 工具调用混合：按到达顺序交错输出（message item 先开则文本先流），`finish` 到达时按 output 顺序依次关闭全部 item。

### 终止时序（关键设计）

`stream_options.include_usage` 的标准时序是：`finish_reason` chunk → 尾随 `choices:[] + usage` chunk → `[DONE]`。因此：

1. `finish_reason` 触发 item 关闭（客户端立即可执行工具）；
2. `response.completed` 推迟到上游流真正结束，以吸收尾随 usage；
3. 只有 `[DONE]` 没有 `finish_reason` → 视为 `stop`；
4. 无任何终止信号（上游静默断流）→ 默认按 `stop` 收尾（老代理行为，兼容宽松供应商）；但有**未闭合的工具调用**或 `silentClose:'fail'` 时 → `response.failed`，避免给客户端一个参数被截断的 function_call。

### 错误与取消

- 宿主调用 `translator.fail(error)` → 输出 `response.failed`（`error.code` = `stream_interrupted`/`upstream_error`）。若尚未发过任何事件，会先补 `response.created`，保证流良构。
- 客户端断开由宿主处理：abort 上游请求 + 丢弃 translator；组件终态幂等，后续输入被忽略。

## SSE 传输边界（SseParser 保证）

- 一个 TCP chunk 包含 0/1/N 个事件；一个事件拆任意字节边界 —— 均正确（含 UTF-8 多字节跨 chunk：按字节缓冲，完整行才解码，`\n` 不会出现在多字节序列内部）。
- `data:` 带或不带空格；多行 `data:` 按 SSE 规范以 `\n` 连接；`event:`/`id:` 字段解析；`:` 注释行忽略。
- `CRLF` 与 `LF`；行尾缺 `\n` 的尾帧由 `flush()` 收口。
- 单帧字节超限（默认 8 MiB）→ `ProtocolParseError`，缓冲复位，不无限增长。
- 非法 JSON 帧：跳过不致命（供应商会发 keep-alive）；流级错误靠超时与终止信号兜底。

## 反方向：Responses SSE → Chat chunk

`response.created` → 首个 chat chunk（`delta:{role:"assistant",content:""}`）；`output_text.delta` → `delta:{content}`；`reasoning_summary_text.delta` / `reasoning_text.delta` → `delta:{reasoning_content}`；`function_call item.added` → `delta.tool_calls[{index,id,type,function:{name,arguments:""}}]`；`function_call_arguments.delta` → `delta.tool_calls[{index,function:{arguments}}]`；`response.completed` → `finish_reason` chunk（tool_calls 存在时为 `tool_calls`）+ 尾随 `choices:[] + usage` chunk；调用方最后写 `data: [DONE]`。`response.failed`/`error` 事件 → `onFailure` 回调 + `{"error":{...}}` chunk。
