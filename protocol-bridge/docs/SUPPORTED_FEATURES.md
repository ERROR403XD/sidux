# SUPPORTED_FEATURES — 支持矩阵

方向缩写：**R→C** = Responses 请求进来、Chat 上游（主方向，Codex 场景）；**C→R** = Chat 请求进来、Responses 上游（反方向）。

## 完整支持（Codex/agent 常用能力）

| 能力 | R→C | C→R | 备注 |
| --- | :-: | :-: | --- |
| text input（string / content parts） | ✅ | ✅ | input_text/output_text/refusal |
| text output（流式 + 非流式） | ✅ | ✅ | 增量转发，done 事件带完整文本 |
| system / developer instructions | ✅ | ✅ | developer→system；反方向合并进 instructions |
| streaming（SSE 增量） | ✅ | ✅ | 状态机翻译，首 token 即时转发 |
| tool calls（function） | ✅ | ✅ | 单个/并行/参数跨几十 chunk/名称分片 |
| tool outputs（function_call_output / tool message） | ✅ | ✅ | 多轮 agent loop 闭环 |
| reasoning（reasoning_content / reasoning / summary 回放） | ✅ | ✅ | 经 compat 字段候选归一 |
| reasoning 流式 | ✅ | ✅ | summary 事件族 / reasoning_content |
| usage（含 cached/reasoning 细分） | ✅ | ✅ | 含流式尾随 usage chunk 吸收 |
| cancellation（客户端断开 → 宿主 abort 上游） | ✅ | ✅ | 组件终态幂等，由宿主驱动 |
| 常见采样参数（temperature/top_p/service_tier/parallel_tool_calls） | ✅ | ✅ | |
| max_output_tokens ↔ max_tokens | ✅ | ✅ | compat 可选 max_completion_tokens |
| tool_choice（auto/none/required/named function） | ✅ | ✅ | |
| 图片输入（data URL / http URL） | ✅ | ⚠️ 告警丢弃 | 反方向 image_url 不转发 |
| 非流式响应转换（Codex 请求 stream:false 时） | ✅ | ✅ | |
| 上游返回非流式而客户端要流式 | ✅ | ✅ | 合成完整 Responses SSE 完成序列 |
| 多模态模型列表/usage 缺失容错 | ✅ | ✅ | usage 缺失时 completed 不带 usage |

## 可优雅降级（记录 warnings，不失败）

- `reasoning.summary` 提示、`include`、`prompt_cache_key`、`metadata`、`user`、`safety_identifier`、未知顶层字段 —— 丢弃并写入 `warnings`。
- 非 function 工具 + `unsupportedTools:'omit'`。
- 多 choice 响应（取 choices[0]）。
- 无 file_id 的 inline 图片（转 image_url）；file_id 图片告警丢弃。
- `[DONE]` 缺失 / finish_reason 缺失的静默断流（`silentClose:'complete'` 且无未闭合工具）。

## 明确不支持

见 [UNSUPPORTED_FEATURES.md](UNSUPPORTED_FEATURES.md)。
