### Unified provider proxy: OpenRouter + OpenCode Zen tool-capable completions

#### Feature/Change Name
Both OpenRouter and OpenCode Zen routes use a unified Responses proxy layer that preserves tool-capable behavior when using Completions mode.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Valid OpenRouter and/or OpenCode Zen API keys configured
3. Existing thread open

#### Steps
1. Select `OpenRouter`, set API format to `Completions`, and send: `what codex cli version is? it should run bash commands`
2. Confirm shell execution appears and includes `codex --version`
3. Select `OpenCode Zen`, set API format to `Completions`, and send the same prompt
4. Confirm shell execution appears and includes `codex --version`
5. Repeat each provider once with simple `hi` to verify non-tool path still returns assistant text normally

#### Expected Results
- Both providers work through a common proxy path without provider-specific regressions
- In Completions mode, tool-capable prompt triggers command execution for both providers
- `codex --version` output is returned in the assistant response flow
- Simple text prompt (`hi`) continues to work in Completions mode

#### Rollback/Cleanup
- Switch provider/API format back to preferred defaults


## 0.2.21-dev.2：UTF-8 网络分块与响应截断

前提：使用 `src/server/unifiedResponsesProxy.lifecycle.test.ts` 的 localhost 合成上游，无真实 API key。
1. 将包含中文、emoji、代码字符串的 SSE 帧分别按 1/2/3/4 字节写入；允许 CRLF 和 JSON 跨块。
2. 检查 response.output_text.delta 拼接内容与 response.completed 最终内容均严格等于原文，完成事件只出现一次。
3. 对 Responses 和 Chat 非流式上游，发送 Content-Length 后只写部分 JSON，再断开；下游必须及时返回 502 和明确错误，不能等客户端超时。
4. 连续执行两次截断请求，均完成；正常响应的既有单测继续通过。

验证：`node_modules/.bin/vitest run src/server/unifiedResponsesProxy.test.ts src/server/unifiedResponsesProxy.lifecycle.test.ts src/server/protocolBridgeTransport.test.ts`。
清理：测试关闭自身随机 localhost 端口，不操作其他服务。
