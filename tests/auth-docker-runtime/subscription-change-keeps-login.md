# Subscription change keeps the ChatGPT account signed in

验证 ChatGPT 账号的订阅/套餐变化（例如 Pro 变为 Plus）不会因为一次 token 刷新被拒绝而永久要求重新登录，同时真正的凭证吊销仍然会明确要求重新登录。

## Feature

- 名称：套餐变化不再导致掉登录（auth 刷新失败分类与有限重试窗口）
- 相关实现：`src/server/accountTokenRefresh.ts`（`ChatgptTokenRefreshError`、`classifyAccountAuthError`、`isTerminalAccountAuthError`）、`src/server/accountAuthCoordinator.ts`（有限重试窗口 + `reauth_recovery` 重试）

## Prerequisites/Setup

1. 使用开发服务器或安装包运行 0.2.20-dev.2：`pnpm run dev --host 127.0.0.1 --port 4173`（隔离 `CODEX_HOME`），或在隔离端口的 Docker 容器中运行。
2. 隔离环境需已有至少一个 ChatGPT 账号，且账号的 `auth.json` 中的 access token 与 refresh token 可控（用于模拟上游拒绝）。
3. 需要能够观察账号状态：设置界面「账号/额度」面板、`authStatus`（`ready` / `reauth_required`）以及浏览器网络面板中的 token 刷新请求次数。
4. 单元覆盖（无需真实上游）：

```bash
npx vitest run src/server/accountTokenRefresh.test.ts src/server/accountAuthCoordinator.test.ts
```

## Steps

### 场景 A：同一账号的套餐变化保持登录（核心回归）

1. 让账号处于已登录的 `ready` 状态，并记录其 `storageId`（账号标识）。
2. 模拟订阅变化：让上游刷新接口在第一次调用时返回拒绝（例如裸 401 或 `invalid_grant` 之外的模糊错误），随后调用 `/codex-api`（或等待额度探针）触发刷新。
3. 等待超过重试窗口（模糊 401 为 60 秒；`invalid_grant` 等终态错误为 10 分钟），再次触发刷新。
4. 观察账号标识、激活账号和账号数量是否变化。

预期（场景 A）：

- 刷新成功后 `authStatus` 回到 `ready`，`storageId`、`activeStorageId`、账号数量与步骤 1 完全一致；`planType` 可更新为新套餐。
- 不出现需要用户重新登录的提示；刷新使用同一账号，不新建账号、不丢失激活账号。
- 说明：真实上游的套餐变化无法在本地无条件复现，此场景的自动化证据来自单元测试（`keeps the same account and identity when a subscription change refreshes the plan`）；真实套餐变化需在真实账号上观察，标注为仅模拟通过。

### 场景 B：临时 401 可自动恢复

1. 让上游刷新接口第一次返回裸 HTTP 401，观察账号标记为 `reauth_required`。
2. 在 60 秒短窗口内立即再次触发刷新（例如打开额度面板或发送消息）。
3. 等待窗口过期后再次触发刷新，并让上游返回 200。

预期（场景 B）：

- 短窗口内不会重复请示上游（同一凭证 revision 的失败结果被缓存）。
- 窗口过期后自动重试并恢复为 `ready`，无需重新登录。

### 场景 C：真正的凭证吊销仍要求重新登录

1. 让上游刷新接口返回结构化 `invalid_grant`（或 `token_revoked` / `access_denied`）。
2. 观察账号状态与重试窗口。
3. 在该账号仍不可用时尝试发送消息。

预期（场景 C）：

- 账号被明确标记为 `reauth_required`（`unavailableReason=reauth_required`），界面提示需要处理认证。
- 重试窗口明显更长（10 分钟），避免无意义地反复请求上游；但不会永久锁定，仍可在窗口后重试。

### 场景 D：并发刷新只发一次

1. 在同一时刻并发触发多次账号刷新（例如同时打开多个依赖账号的界面）。
2. 统计上游 token 刷新请求次数。

预期（场景 D）：

- 同一凭证 revision 的并发刷新被合并，上游只收到一次刷新请求（`tokenRefreshFlights` 去重）。

## Expected Results

- 套餐/订阅变化本身不再导致掉登录：`storageId` 由 accountId + userId 生成，不含套餐信息，刷新后仍是同一账号。
- 只有结构化终态错误（`invalid_grant` / `token_revoked` / `access_denied`）才判定为需要重新登录；裸 401 与普通 "refresh token" 文本被视为可重试。
- 失败缓存窗口全部有限（transient 30 秒、模糊 reauth 60 秒、终态 reauth 10 分钟），取代旧的 `Infinity` 永久缓存。

## Rollback/Cleanup

- 删除本轮使用的隔离 `CODEX_HOME` 与临时容器；不要修改生产认证文件。
- 清理临时验证服务：仅停止本任务启动的进程（例如本 worktree 的 4173），不要停止 5173/5900/59001。

## Evidence (2026-09-14, 0.2.20-dev.2)

- 单元测试：`npx vitest run src/server/accountTokenRefresh.test.ts src/server/accountAuthCoordinator.test.ts` → 2 files / 44 tests passed；全量 `npx vitest run` → 123 files / 850 tests passed。
- 打包 Docker 矩阵（镜像 `codexapp-final-test:0.2.20-dev.2`，脚本 `scripts/test-packaged-provider-matrix.cjs`，端口 4195/4196/4197）：无认证 → `opencode_zen` 并切到 `openrouter_free`；损坏认证 → `opencode_zen` 回退；合成无效 ChatGPT 认证 → 保持 `openai` 路径并产生认证刷新失败，刷新后仍持久可见，重复 live overlay = 0，合成 auth 未改动。报告：`output/0220-dev2-docker/packaged-provider-matrix.json`。
