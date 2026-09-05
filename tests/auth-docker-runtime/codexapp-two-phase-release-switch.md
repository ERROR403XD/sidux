# CodexApp two-phase release switch

## Feature / change

Validate `scripts/codexapp-release-switch.sh`: prepare an immutable release while production stays online, then switch or roll back the systemd `ExecStart` from an external host shell without importing the isolated test account pool or changing production authentication state.

## Prerequisites / setup

- Production is `codexapp.service` on `127.0.0.1:5900` with `CODEX_HOME=/root/.codex`.
- The candidate source is committed and has already passed its unit, build, packaged Docker, UI, and account acceptance checks on `59001`.
- After adding or re-authenticating the test account, the operator explicitly clicked **Switch**, confirmed that account became active, and then passed the real-account P6 request. A ready card alone is not evidence that its credentials are active.
- The operator has a host shell that does not depend on the CodexApp browser session being replaced.
- No CodexApp turn, queued message, approval, account operation, or direct host Codex CLI task is running.
- All CodexApp browser tabs are closed before `activate` or `rollback`, preventing automatic reconnect traffic during the authentication invariant check.

## Automated regression

1. Run `bash -n scripts/codexapp-release-switch.sh`.
2. Run `pnpm exec vitest run src/cli/codexappReleaseSwitch.test.ts`.
3. Confirm the test uses temporary production/release/state/drop-in paths and fake service commands.
4. Confirm activation writes the candidate drop-in, rollback restores the base unit, and `auth.json` remains byte-for-byte unchanged in both directions.
5. Confirm the injected post-start auth mutation makes activation fail and automatically restores the base unit, active service, and original `auth.json`.

## Prepare actions

1. Run `scripts/codexapp-release-switch.sh status` and record the active service/release and test-container state.
2. Run `scripts/codexapp-release-switch.sh prepare` while production remains online.
3. Confirm the command reports a release below `/home/docker/codexapp-releases/` and explicitly reports that production was unchanged.
4. Confirm `/home/docker/codexapp-switch-state/latest-prepared` points to that release.
5. End the current Codex turn. Do not ask the same turn to synchronously stop its own CodexApp.

## Activation actions

1. Close every browser tab connected to ports `5900` and `59001`.
2. From a separate host shell, confirm there is no direct `codex` task, then run:

   ```bash
   /home/Code/codexapp/scripts/codexapp-release-switch.sh check latest
   /home/Code/codexapp/scripts/codexapp-release-switch.sh activate latest --confirm-idle
   ```

3. Confirm the isolated `codexapp-multi-account-dev` container is stopped.
4. Run `scripts/codexapp-release-switch.sh status` and confirm `active_release` points to the prepared release.
5. Open `http://192.168.50.46:5900/` and verify the active account remains signed in, existing projects and threads load, and no startup login is triggered.
6. Run one explicitly labeled harmless test turn and confirm it completes without duplicate live overlays.

## Expected results

- `prepare` does not stop production, edit systemd, access the test credential volume, or modify `/root/.codex`.
- `activate` refuses to proceed without `--confirm-idle` and an empty server-side turn/queue/approval check.
- The base unit and `/home/docker/codexapp` stay intact; only `90-release-switch.conf` selects the prepared release.
- The test container stops before production cutover and its independent `CODEX_HOME` is never copied into production.
- The code-only activation health check touches `/` only; `auth.json`, `accounts.json`, and `accounts/` match the post-stop snapshot byte-for-byte.
- Failure before activation completes automatically restores the previous drop-in, authentication snapshot, production service, and previously running test container.
- A later explicit rollback preserves the then-current production authentication state instead of overwriting legitimate refresh-token rotation with an old snapshot.

## Rollback / cleanup

1. End active work and close CodexApp browser tabs.
2. From the independent host shell run:

   ```bash
   /home/Code/codexapp/scripts/codexapp-release-switch.sh rollback --confirm-idle
   ```

3. Confirm `5900` is healthy, the previous release is active, and the production account remains signed in.
4. Keep `/home/docker/codexapp-switch-state/transactions/` and the previous release until the observation period ends. Do not delete authentication snapshots or old releases as part of the switch test.

### 0.1.88 多账号基线后续版本的账号保留

前提：生产使用 `/root/.codex`，当前分支包含多账号 0.1.88 基线；所有账号在生产池中已导入。候选继续使用独立 volume。

操作：确认账号实现与 0.1.88 的差异，执行 `pnpm exec vitest run src/server/accountAuthStore.test.ts src/server/releaseAuthPreservation.test.ts`。该回归只使用临时虚拟账号，不读取真实认证、不执行 systemctl。真正切生产仍由用户结束当前 turn 后，在独立终端执行已准备 release 的 `activate ... --confirm-idle`。

预期：同 CODEX_HOME 重启读取保留全部账号、active 身份、凭据版本、状态和配额快照。切换脚本覆盖 `auth.json`、`accounts.json` 及整个 `accounts/`，非 active 或 pending 凭据变化也会被发现。人工回滚保留当时最新凭据。生产账号不被测试池覆盖；测试池保留但不自动导入生产。

清理：自动回归清理自身临时目录；不要删除真实生产/候选账号目录或恢复历史 Token。上线后核对所有账号卡及 active 状态，再做真实请求验收。
