# fixtures

协议金样本。修复线上转换 bug 时，把脱敏后的原始样本放进这里并配套断言（见 docs/TESTING.md）。

- `streams/deepseek-reasoner-tool-call.jsonl` — DeepSeek reasoner 形态的完整流：role chunk → reasoning_content 增量 ×2 → 文本增量 → 工具调用（id/name 首帧 + 参数分 3 帧）→ finish_reason=tool_calls → 尾随 usage（含 cached/reasoning 细分）。每行一个 chat chunk JSON；测试将其重新编码为 SSE 帧后喂入 translator。
- `requests/codex-shell-turn.json` — Codex CLI 形态的 Responses 请求：instructions + 多轮 input（message/reasoning/function_call/function_call_output）+ function 工具 + reasoning.effort + store/include/prompt_cache_key。
