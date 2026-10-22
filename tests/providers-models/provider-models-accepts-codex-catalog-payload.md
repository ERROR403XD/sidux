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

### 0.2.22 模型目录服务边界

前提：独立 CODEX_HOME 与本地合成 `/models` HTTP 服务，不使用真实凭据。自动回归：`pnpm exec vitest run src/server/routes/providerModelRoutes.test.ts src/server/codexAppServerBridge.providerModels.test.ts src/server/customConnectionStore.test.ts src/server/freeMode.test.ts src/api/gatewayDependencies.test.ts`。

操作：读取 provider-models 的默认/指定 provider；选择一个已保存的 custom connection，再指定另一 provider，确认 custom 仍优先；取消 active 后按 storageId 读 accounts/models。测试配置中的 base_url/query_params/http_headers/bearer precedence、无 auth 的 Zen 免费过滤/离线回退、legacy custom 当前模型置首、dummy key 不发 Authorization、无效 payload/上游失败/原生 config 失败。

预期：saved custom 读取零 RPC/零上游；未命中的 accounts/models 继续账号路由。configured 正常读取一次 config/read + 一次 models HTTP，IDs 去重，env-backed secret 不展开。原生错误保留502；配置/上游目录失败保留原空列表与 source/exclusive。服务抽取不新增缓存/轮询/请求去重；默认模型探测复用同一解析器。Zen/OpenRouter 使用合成模型响应，不据此声称真实供应商可用。

清理/回滚：删除合成 home 和两个临时端口，保留标准候选卷；迁移可独立 revert，无 config/schema 改动。打包认证矩阵绑定独立提交记录。
