### Provider models accept Codex catalog payloads

#### Feature/Change Name
Provider-backed model discovery accepts both OpenAI-compatible and Codex catalog `/models` payloads.

#### Prerequisites/Setup
1. Build the project with `pnpm run build`.
2. Start the app and open it in the browser.
3. In Settings, choose `Custom endpoint`, set API format to `Responses`, and point the endpoint URL at a test provider base URL such as `http://127.0.0.1:8666/v1`.
4. Have that provider return `{"models":[{"slug":"gpt-5.4"}]}` from `GET /v1/models`.

#### Steps
1. Open the model selector for the provider-backed thread or new-chat composer.
2. Confirm the selector includes model ids from the provider `models[].slug` payload.
3. Select one of the discovered models and start a new thread.

#### Expected Results
- `/codex-api/provider-models` returns model ids from either `data[].id` or `models[].slug`.
- The model selector is not reduced to only the configured fallback model when the provider returns a Codex catalog payload.
- Starting a thread passes the selected model id through to Codex.

#### Rollback/Cleanup
- Switch the provider back to the preferred default.

---

### 0.2.0 API 出口目录与组件能力一致

前置：隔离 59001，CLIProxyAPI 7.2.152，已启用出口并创建临时 key；WebUI 原生 Codex 目录保持独立。

操作：分别请求 `/v1/models` 和 `/v1/models?client_version=0.153.4`，将后一目录用于独立 Codex CLI。检查 Astra/Luna 的可选强度；手动提交 Astra `reasoning.effort=ultra`，再以目录支持的 max 请求测试。使用协议形状正确的 fixture 验证 priority、图片、JSON schema、函数/自定义工具、phase 与加密 reasoning 字段透传。

预期：两种目录保留原结构；出口不会公布固定组件不支持的 ultra，手动提交返回明确 400，不静默降级。max 及高级字段契约通过。WebUI 原生模型目录的 ultra 不受影响。该 fixture 不证明真实图片理解或所有模型的权限。

清理：撤销临时 key，等待活动归零，恢复出口原设置。
