# Multi-account isolated login and transactional switching

## Feature / change

Validate the versioned account credential store, isolated Codex OAuth login, explicit quota refresh, global idle-boundary account switching, thread continuity checks, rollback behavior, and the packaged development instance on port `59001`.

## Prerequisites / setup

- Keep the production `codexapp.service` running on port `5900`; do not restart it for this test.
- Use the packaged `codexapp-multi-account-dev:latest` image with Codex CLI `0.147.0`.
- Run `scripts/run-multi-account-dev.sh`. The container must use the `codexapp-multi-account-dev-home` volume as `/codex-home` and must not mount `/root/.codex`.
- Confirm `http://127.0.0.1:59001/` is reachable and `GET /codex-api/accounts` returns an empty or test-only account pool.
- Have two disposable or explicitly approved real ChatGPT/Codex accounts available for the final P6 steps. Never record OAuth callback URLs or credential contents in this document, terminal history, screenshots, or issue comments.

## Automated checks

1. Run:

   ```bash
   pnpm exec vitest run src/cli/listenOnPort.test.ts src/server/accountAuthStore.test.ts src/server/accountAuthCoordinator.test.ts src/server/accountAppServerProbe.test.ts src/server/accountTokenRefresh.test.ts src/server/codexAppServerBridge.authRefresh.test.ts src/api/codexGateway.test.ts
   pnpm run build
   ```

2. Run `node scripts/verify-multi-account-ui.cjs` against `http://127.0.0.1:59001`.
3. Run the startup profiler:

   ```bash
   PROFILE_BASE_URL=http://127.0.0.1:59001 \
   PROFILE_WAIT_MS=7000 \
   PROFILE_BROWSER_EXECUTABLE=/snap/bin/chromium \
   pnpm run profile:browser
   ```

4. While the development instance is running, start a second packaged instance with host networking and `--port 59001 --strict-port`; it must exit non-zero with `EADDRINUSE` and must not select another port.

## Final P6 manual actions

1. Open `http://192.168.50.46:59001/`, open **Settings**, and expand **Accounts**.
2. Click **Add account** for account A, complete OAuth in the browser, paste only the localhost callback URL into the open login modal, and submit it.
3. Confirm A is added once and is not activated implicitly. Explicitly click **Switch** to activate A.
4. Click **Add account** for account B and complete the same flow. Confirm B is added once while A remains active.
5. Use **Add account** to sign in to B again. Confirm the outcome is re-authentication, B remains one card, its credential revision advances, and A remains active.
6. On B's card, click **Re-authenticate** but intentionally sign in as A. Confirm the modal reports an identity mismatch and neither account entry is overwritten or duplicated.
7. Click **Refresh quota** on A and B. Confirm the status and quota belong to the selected card; a revoked token shows **Re-authenticate**, a payment failure shows **Payment required**, and a transient network failure remains retryable.
8. In a test project under `/home/Code`, create a test thread while A is active. Record only its thread ID, cwd, route, visible message count, and last visible item ID.
9. With no active turn, queued message, approval, or second account operation, switch A → B → A. After each switch, confirm `account/read`/quota reflect the target account while the thread ID, cwd, route, rollout path, visible messages, and project list remain unchanged.
10. Start a harmless test turn or queue a test message and attempt another switch. Confirm the server returns a blocked/conflict result, the composer stays disabled during recovery, and no turn is replayed under another account.
11. Open a second browser tab using the same initial active account. Switch in the first tab, then attempt a stale switch in the second tab. Confirm `expectedActiveStorageId` produces a deterministic conflict instead of silently switching again.
12. Refresh the page and confirm the same active account remains highlighted. Repeat one switch after a normal token refresh to prove rotated credentials were persisted.
13. Stop and restart polling with the same account. Confirm the durable server queue remains visible without a duplicate save. During a real account switch, inspect the stop→start gap with a test fixture: persisted server queues are not treated as current account state; polling-scoped unread, history-load markers, pagination markers, titles, snapshots, queue errors, and progress flags do not carry from A into B.

## Expected results

- Server startup never starts `codex login`, opens a browser, or creates an active `auth.json` by itself.
- Each login process uses `accounts/.pending/<loginSessionId>` and cleans it after completion or cancellation.
- Adding or re-authenticating an account does not change the active quota source; only an explicit successful switch does.
- Account identity mismatches, stale browser state, busy runtime state, and concurrent account operations have structured, non-destructive failures.
- A successful switch is reported only after target probing, credential materialization, app-server restart, account verification, and optional thread continuity verification succeed.
- A failed switch restores the previous active credential and readable thread; incomplete recovery is reported as degraded rather than successful.
- No credentials, access tokens, refresh tokens, or callback URLs appear in logs or screenshots.

## Rollback / cleanup

- Stop only the development container with `docker stop codexapp-multi-account-dev` if the test must pause. Keep `codexapp-multi-account-dev-home` for diagnosis unless deletion is explicitly authorized.
- Re-run the development container with `CODEXAPP_REPLACE_DEV=1 scripts/run-multi-account-dev.sh` after rebuilding. This replaces only `codexapp-multi-account-dev` and preserves its independent volume.
- Do not edit `/home/docker/codexapp`, restart `codexapp.service`, remove the production `5900` listener, or copy production `/root/.codex` state into the test volume.

## Current execution status (2026-09-05)

- Automated unit, type, build, packed-image, strict-port, empty-startup, light/dark UI, refresh persistence, and startup performance checks are complete.
- The development container is available on `59001` with an independent `CODEX_HOME` and fixed Codex CLI `0.147.0`.
- The real two-account login and remote A → B → A acceptance steps above are intentionally pending for the user to execute manually.

## 2026-10-21 dev.8审核：重新登录的同时准入

### 前提与操作

使用任务新建的AccountAuthStore，只有合成账号元数据；原生登录以可观察的内存进程替身表示，不启动OAuth或读取真实认证。分别执行：(1) 两条并发Add；(2) 第一条targeted reauth启动后再发第二条；(3) 同一tick启动两条targeted reauth。记录创建数量，再取消所有已分配ID，检查pending目录和进程句柄。

### 预期与结果

每组均应只允许1个登录实例，另一条以`account_operation_in_progress`拒绝；取消后所有所属资源消失。`account-login-admission-offline.cjs`在dev.8下两个对照通过，第(3)组创建2个实例，第一条报已取消却留下1个未清理实例和目录，确认R65。3场景9检查7通过/2失败，保留exit1；不是实际双标签或原生OAuth验收。

### 清理

脚本先保存产品取消后的实际结果，再关闭自己的内存句柄并删除本次随机根目录。不得把此用例改成操作真实账号、59001标准卷或生产状态。

## 2026-10-21 dev.8审核：账号探针在超时后迟到启动

- 前提：`account-probe-cancellation-offline.cjs`加载实际协调器与探针；凭据读取、进程和25秒检查时钟均为内存替身，无真实认证或服务操作。
- 操作：分别在截止前完成准备、超时取消后拒绝准备、超时取消后完成准备；暂缓initialize响应以观察启动数量与管理集合，再放行响应检查清理。
- 预期：正常检查的进程归协调器管理；超时后两种准备结果都不能新建进程。最终句柄和定时器应归零。
- dev.8结果：3场景9检查8通过/1失败，R66复现迟到成功会启动已注销的探针。模拟响应随后正常完成并清理；不是原生永久残留证据。

## dev.8 审核补充：原生认证刷新回复的进程归属

前提：加载真实 `AppServerProcess`，原生子进程和刷新接口均为内存替身；只使用不可用的合成值，不调用 OAuth 或读取账号文件。命令：`node docs/baseline/022/dev8-review-20261020/appserver-refresh-ownership-offline.cjs`。

1. 当前进程刷新成功、刷新失败各一次。预期分别向原进程回复 result 或协议错误，处理器正常结束。
2. 延迟刷新结果，调用真实 dispose，等旧内存进程退出后再返回成功。预期不再写入任何进程，处理器正常结束。
3. 同样关闭旧进程，再赋予一个新的内存进程身份，最后返回旧刷新结果。预期新进程不收到旧请求的任何回复。

dev.8：四场景八检查，六通过、两失败，确认 R71。场景2处理器拒绝并报 app-server 未运行；场景3旧请求的错误发往新进程。审核直接观察处理器 Promise，避免自身产生未处理拒绝；这不证明真实 CLI 已退出，也不等于完整原生重启验收。

清理：注销监听器、结束全部内存进程并清除虚拟定时器，记录计数为零；没有原生子进程或应用状态文件需要清理。
- 清理：记录完成后关闭自有内存流与句柄，最终活动句柄和定时器均为0；无文件凭据、真实子进程或外部请求可清理。

## 2026-10-21 dev.8审核：取消登录的HTTP失败反馈

- 前提：`account-login-cancel-offline.cjs`使用真实gateway、从对话框原样提取的cancel函数与Vue状态；合成等待中会话和回调草稿，响应由内存提供。
- 操作：分别返回HTTP200、HTTP503和网络Promise拒绝，调用取消一次，核对请求sessionId、会话/草稿、close事件、错误提示与busy状态。
- 预期：成功才清空并关闭；两种失败均保留会话和草稿、提示错误、允许重试。
- dev.8结果：9检查8通过/1失败；HTTP503被忽略，确认R67。成功和网络异常对照通过。
- 清理与限制：只有内存状态，无账号、凭据、进程或持久服务可清理；不构成浏览器或实际OAuth验收。
