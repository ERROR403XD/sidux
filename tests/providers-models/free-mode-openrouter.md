### Free Mode (OpenRouter)

#### Feature
Toggle "Free mode" in settings to use free OpenRouter models without an OpenAI API key. Uses XOR-encrypted community keys that rotate randomly per request. Default model is `openrouter/free` — OpenRouter's meta-model that auto-routes to the least-loaded free model, avoiding per-model rate limits. Model selector shows only free models when free mode is on. Config is isolated from `~/.codex/config.toml` — state stored in `~/.codex/webui-custom-providers.json` and passed to app-server via `-c` CLI args.

#### Prerequisites
- Project built: `pnpm run build`.
- Codex CLI installed and available in PATH.

#### Steps
1. Start the server: `node dist-cli/index.js --no-open`.
2. Open the UI in a browser (default `http://localhost:5999`).
3. Open the sidebar settings panel (gear icon).
4. Toggle **Free mode (OpenRouter)** ON.
5. Verify the toggle turns on and model dropdown changes to `openrouter/free`.
6. Click the model dropdown — verify it shows **only** free models (gemma, llama, qwen, etc.) and no GPT/OpenAI default models.
7. Verify `~/.codex/config.toml` was NOT modified (no `model_provider` or `model` entries added).
8. Verify `~/.codex/webui-custom-providers.json` exists and contains `{"enabled":true,"apiKey":"sk-or-v1-...","model":"openrouter/free"}`.
9. Open a new thread and send a message (e.g. "Say hello").
10. Verify a response comes back from a free OpenRouter model (may be rate-limited during high demand).
11. Toggle **Free mode (OpenRouter)** OFF.
12. Verify the model dropdown reverts to GPT-5.3-codex (or default OpenAI model).
13. Verify model dropdown shows normal OpenAI models (not free models).

#### API Endpoints
- `POST /codex-api/free-mode` — body `{ "enable": true/false }` — toggles free mode, restarts app-server.
- `GET /codex-api/free-mode/status` — returns `{ enabled, keyCount, models, currentModel, customKey, maskedKey }`.
- `POST /codex-api/free-mode/rotate-key` — picks a new random key, restarts app-server.
- `POST /codex-api/free-mode/custom-key` — body `{ "key": "sk-or-v1-..." }` — sets a custom OpenRouter API key. Send empty string to revert to community keys.
- `GET /codex-api/provider-models` — returns `{ data: [...], exclusive: true }` when free mode is on (only free models shown).

#### Custom API Key
- When free mode is ON, an "OpenRouter API key" input appears below the toggle in settings.
- Enter your own `sk-or-v1-...` key and click "Set" (or press Enter) to use your own OpenRouter key.
- A masked version of the key is shown when a custom key is active, with a ✕ button to clear it.
- Clearing the custom key reverts to community keys.

#### Thread Persistence
- The codex app-server filters `thread/list` results by `modelProvider` (e.g. `openai` vs `openrouter-free`).
- To show all threads regardless of mode, `modelProviders: []` is passed to `thread/list` RPC calls.
- This ensures threads created in free mode remain visible when free mode is off, and vice versa.
- Toggling free mode ON/OFF preserves all threads — no data is lost.
- Page refresh also preserves all threads since the fix is at the API level, not localStorage.

#### Known Limitations
- `wire_api="chat"` is not supported by the codex CLI — must use `wire_api="responses"`.
- Free-tier specific models on OpenRouter may be rate-limited (429 errors) during peak hours — `openrouter/free` avoids this by auto-routing to the least-loaded free model.

#### Expected Results
- Free mode ON: App-server is restarted with `-c` config args for openrouter-free provider. Model selector shows only free models.
- Free mode OFF: App-server is restarted without free mode args. Model selector shows default models.
- `~/.codex/config.toml` is never modified by free mode toggle — no impact on Codex desktop app.
- 68 encrypted keys available, decrypted at runtime with XOR key `er54s4`.
- Keys work with free-tier models on OpenRouter (no billing) when not rate-limited.
- Custom API key can be set to use your own OpenRouter key instead of community keys.

#### Rollback/Cleanup
- Remove `src/server/freeMode.ts`, revert changes in `codexAppServerBridge.ts`, `codexGateway.ts`, and `App.vue`.
- Delete `~/.codex/webui-custom-providers.json` to clear free mode state.

### 0.2.22 供应方变更服务与门禁释放

前置：独立 HOME、合成 RPC/凭据，运行 `pnpm exec vitest run src/server/providerChangeService.test.ts src/server/routes/freeModeRoutes.test.ts src/server/customConnectionAdmission.test.ts`，不要修改真实账号状态。

1. 队列中保留 queued 消息后切换供应方，确认返回 409，尚未读取请求 body、写配置或重启原生进程；移除测试 intent 后连续切换两次成功。
2. 注入原生读取失败、body 解析失败和配置写入失败，各自完成后再次切换；预期门禁已释放，可正常继续，已确认写入沿用既有错误处理。
3. 从自定义连接切换账号，分别返回失败状态与抛出错误；原连接恢复，后续成功切换不残留 gate。
4. 占用连接期间编辑/移除被拒绝；并发身份切换被拒绝；新连接的测试与保存仍允许，保留原账号和连接选择。
5. 执行打包 Provider/Auth 矩阵：空/损坏 auth 回退 Zen，连续两次 OpenRouter 切换成功，无效 auth 的真实失败行刷新后仍在，重复 live overlay 为 0。

预期：`runProviderChange` 唯一拥有 acquire/finally release，业务服务持有检查、写入/重启和失败恢复全过程；route 只解析与映射响应。清理仅独立 HOME/测试容器；标准 59001 卷与生产状态保留，无 schema 迁移。
