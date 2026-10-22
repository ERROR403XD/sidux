# ARCHITECTURE — protocol-bridge

## 分层

```
┌──────────────────────────────────────────────────────────────────┐
│ 宿主应用（主项目）                                                  │
│   transport glue：读请求体 / 发上游请求 / 写 SSE / 超时 / 取消 / 日志   │
└───────────────▲──────────────────────────────────────────────────┘
                │ 仅通过 src/index.ts 公共 API
┌───────────────┴──────────────────────────────────────────────────┐
│ protocol-bridge（纯协议层，零 I/O，零依赖）                          │
│                                                                  │
│  ┌─────────────┐   ┌──────────────────┐   ┌───────────────────┐  │
│  │ SseParser   │──▶│ ChatStreamDecoder│──▶│ ResponsesStream   │  │
│  │ (bytes→SSE) │   │ (chunk→IR 事件)  │   │ Encoder (IR→事件) │  │
│  └─────────────┘   └──────────────────┘   └───────────────────┘  │
│        ChatToResponsesStreamTranslator（生命周期门面）               │
│                                                                  │
│  ┌─────────────┐   ┌────────────────────┐   ┌────────────────┐  │
│  │ SseParser   │──▶│ ResponsesStream    │──▶│ ChatStream     │  │
│  │ (bytes→SSE) │   │ Decoder (事件→IR)  │   │ Encoder (IR→块) │  │
│  └─────────────┘   └────────────────────┘   └────────────────┘  │
│        ResponsesToChatStreamTranslator（生命周期门面）               │
│                                                                  │
│  请求/非流式转换：responsesRequestToChatRequest                      │
│                  chatResponseToResponses                          │
│                  chatRequestToResponsesRequest                     │
│                  responsesResponseToChatResponse                   │
│  兼容层：compatibility/reasoning.ts（供应商字段名归一）                │
└──────────────────────────────────────────────────────────────────┘
```

四个职责严格分离：**协议实现**（decoder/encoder）≠ **传输实现**（宿主的 HTTP/超时/取消）≠ **供应商怪癖**（compat 选项）≠ **路由决策**（宿主根据 connection capability 决定是否调用）。

## 归一化 IR

`NormalizedStreamEvent`（types.ts）是两个协议之间唯一的中间表示：

| IR 事件 | 语义 |
| --- | --- |
| `start` | 上游生成开始（携带 response id / model） |
| `textDelta` | 可见文本增量 |
| `reasoningDelta` | 推理文本增量（已由兼容层归一） |
| `toolCallStart` | 某个工具调用首次出现（toolIndex + callId + name） |
| `toolCallNameDelta` | 工具名增量（部分供应商分片发送函数名） |
| `toolCallArgumentsDelta` | 工具参数 JSON 增量 |
| `finish` | 终止原因（stop / length / tool_calls / content_filter） |
| `usage` | 归一化后的 token 用量 |

两个方向的 decoder/encoder 互为镜像：Chat→IR→Responses 与 Responses→IR→Chat。新增供应商只需要调整 compat 层，不需要触碰编码器。

## 流式状态机

### ChatStreamDecoder（chat 侧状态）

- `start` 懒发：首个 chunk 触发（用上游自己的 id/model）。
- 工具调用按 `delta.tool_calls[].index` 记账：`id`/`name` 通常只在首个 delta 出现；`id` 缺失时合成 `call_*`；`name` 允许分片（拆分为 `toolCallNameDelta`）。
- `finish_reason` 触发 `finish`；之后的尾随 usage chunk（`stream_options.include_usage` 的标准时序）仍然被吸收。
- `[DONE]` 只是哨兵标记，不产生 IR 事件。

### ResponsesStreamEncoder（Responses 侧状态）

状态：`created`（懒启动）→ 输出项打开/关闭 → `itemsClosed`（等终态）→ `terminal`。

- 每个输出项（reasoning/message/function_call）按到达顺序获得 `output_index` 和生成的 item id（`rs_*`/`msg_*`/`fc_*`）。
- item 打开时发 `output_item.added`（+ content_part.added / reasoning_summary_part.added）；收到 `finish` 时**立即**按序关闭全部 item —— 客户端可以马上开始执行工具。
- `response.completed` 延迟到 `completeStream()`（上游流结束）才发，以便捕获 finish 之后才到达的 usage chunk。
- `finish_reason=length/content_filter` → `status:"incomplete"` + `incomplete_details`。
- `fail()` 输出规范的 `response.failed`（若尚未启动会先补 `response.created`，保证客户端看到良构流）。
- 每个事件带递增 `sequence_number`。

### 生命周期（ChatToResponsesStreamTranslator）

```
translateChunk()* ─┬─ 上游 end ──▶ finish()   [finish_reason 优先 → [DONE] → silentClose]
                   └─ 上游错误 ─▶ fail(e)     [response.failed]
```

- `finish_reason` 已见 → 直接收尾；仅 `[DONE]` → 以 stop 收尾。
- 无任何终止信号（静默断流）：默认（`silentClose:'complete'`）且没有未闭合工具调用 → 按 stop 收尾；否则 `response.failed`。
- 终态之后的一切输入被忽略（幂等）。

## 内存与性能

- 逐 chunk 处理：成本与 chunk 大小成正比，与响应总长无关（除一处，见下）。
- **协议要求的例外**：Responses 协议在 `output_text.done`、`output_item.done`、`response.completed` 里都要携带**完整累计文本**，因此 encoder 必须保留每项全文。内存上界 = 单次响应大小，这是协议规范决定的下界，不是实现选择。
- 无全局锁、无共享可变状态、无队列（decoder/encoder 同步直调，背压由宿主传输层对上游 stream 做 pause/resume）。
- SSE 解析按字节缓冲，超限（默认 8 MiB/帧）抛 `ProtocolParseError` 并复位，防止单请求撑爆内存。

## 与宿主的依赖边界

组件**只依赖** Node 内置模块（`node:crypto`）。宿主只通过 `src/index.ts` 暴露的符号交互，输入输出全部是 JSON 可序列化对象或 `Uint8Array`/string。因此：

- 可整体复制到任何 Node/TS 项目（glue ~200 行）；
- 可替换实现（宿主依赖的是窄接口而非内部结构）；
- 可直接删除（见 INTEGRATION.md 的移除清单）。
