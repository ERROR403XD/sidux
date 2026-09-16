# Sidux two-phase release switch

## Feature / change

Validate `scripts/codexapp-release-switch.sh`: prepare an immutable release while production stays online, then switch or roll back the systemd `ExecStart` from an external host shell without importing the isolated test account pool or changing production authentication state.

## Prerequisites / setup

- Production is `codexapp.service` on `127.0.0.1:5900` with `CODEX_HOME=/root/.codex`.
- The candidate source is committed and has already passed its unit, build, packaged Docker, UI, and account acceptance checks on `59001`.
- After adding or re-authenticating the test account, the operator explicitly clicked **Switch**, confirmed that account became active, and then passed the real-account P6 request. A ready card alone is not evidence that its credentials are active.
- The operator has a host shell that does not depend on the Sidux browser session being replaced.
- No Sidux turn, queued message, approval, account operation, or direct host Codex CLI task is running.
- All Sidux browser tabs are closed before `activate` or `rollback`, preventing automatic reconnect traffic during the authentication invariant check.

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
5. End the current Codex turn. Do not ask the same turn to synchronously stop its own Sidux.

## Activation actions

1. Close every browser tab connected to ports `5900` and `59001`.
2. From a separate host shell, confirm there is no direct `codex` task, then run:

   ```bash
   /workspace/codexapp/scripts/codexapp-release-switch.sh check latest
   /workspace/codexapp/scripts/codexapp-release-switch.sh activate latest --confirm-idle
   ```

3. Confirm the isolated `codexapp-multi-account-dev` container is stopped.
4. Run `scripts/codexapp-release-switch.sh status` and confirm `active_release` points to the prepared release.
5. Open `http://localhost:5900/` and verify the active account remains signed in, existing projects and threads load, and no startup login is triggered.
6. Run one explicitly labeled harmless test turn and confirm it completes without duplicate live overlays.

## Expected results

- `prepare` does not stop production, edit systemd, access the test credential volume, or modify `/root/.codex`.
- `activate` refuses to proceed without `--confirm-idle` and an empty server-side turn/queue/approval check.
- The base unit and `/home/docker/codexapp` stay intact; only `90-release-switch.conf` selects the prepared release.
- The test container stops before production cutover and its independent `CODEX_HOME` is never copied into production.
- The code-only activation health check touches `/` only; root and profile/pending `auth.json` files match the post-stop snapshot byte-for-byte. Account metadata preserves identity, active selection, credential revision and configuration; verification status, quota snapshots and reset-credit observations may update. Account runtime databases, caches and temporary files may change.
- Failure before activation completes automatically restores the previous drop-in, authentication snapshot, production service, and previously running test container.
- A later explicit rollback preserves the then-current production authentication state instead of overwriting legitimate refresh-token rotation with an old snapshot.

## Rollback / cleanup

1. End active work and close Sidux browser tabs.
2. From the independent host shell run:

   ```bash
   /workspace/codexapp/scripts/codexapp-release-switch.sh rollback --confirm-idle
   ```

3. Confirm `5900` is healthy, the previous release is active, and the production account remains signed in.
4. Keep `/home/docker/codexapp-switch-state/transactions/` and the previous release until the observation period ends. Do not delete authentication snapshots or old releases as part of the switch test.

### 0.1.88 多账号基线后续版本的账号保留

前提：生产使用 `/root/.codex`，当前分支包含多账号 0.1.88 基线；所有账号在生产池中已导入。候选继续使用独立 volume。

操作：确认账号实现与 0.1.88 的差异，执行 `pnpm exec vitest run src/server/accountAuthStore.test.ts src/server/releaseAuthPreservation.test.ts`。该回归只使用临时虚拟账号，不读取真实认证、不执行 systemctl。真正切生产仍由用户结束当前 turn 后，在独立终端执行已准备 release 的 `activate ... --confirm-idle`。

预期：同 CODEX_HOME 重启读取保留全部账号、active 身份、凭据版本、状态和配额快照。切换脚本覆盖 `auth.json`、`accounts.json` 及整个 `accounts/`，非 active 或 pending 凭据变化也会被发现。人工回滚保留当时最新凭据。生产账号不被测试池覆盖；测试池保留但不自动导入生产。

清理：自动回归清理自身临时目录；不要删除真实生产/候选账号目录或恢复历史 Token。上线后核对所有账号卡及 active 状态，再做真实请求验收。

### 0.2.12 认证校验误报修复

前提：使用临时虚拟账号，保留完整账号目录快照；不连接真实 systemd 服务。

操作：运行 `bash -n scripts/codexapp-release-switch.sh` 和 `pnpm exec vitest run src/server/releaseAuthPreservation.test.ts src/cli/codexappReleaseSwitch.test.ts`。分别模拟账号目录 SQLite WAL、模型缓存和临时目录更新，以及配额/核验时间更新；再模拟新增/删除/修改凭据、pending 凭据变化、激活账号变化、身份/凭据版本/保护值变化和损坏元数据。

预期：运行时更新通过；认证或配置变化与损坏元数据失败。失败自动回滚和之后手动回滚仍通过原有测试；完整快照保留供回滚，校验不输出凭据内容。清理：测试自行删除临时目录，真实失败事务保留以供排查。

### 0.1.90 调度器与旧版预检查

前提：以隔离临时服务模拟 0.1.89 和 0.1.90；自动回归不会停止真实 systemd 服务。

1. 模拟 0.1.89 的未知 API 返回 HTML 200，运行 `check <release>`。预期通过实际 ExecStart 对应的 package.json 识别旧版，不解析不存在的调度接口，也不发送 drain 或修改服务。
2. 模拟 0.1.90 同样返回 HTML，即使环境中设置 `CODEXAPP_LEGACY_SCHEDULER=1`，预期检查失败，不能绕过调度器验证。
3. 新版本 `activate` / `rollback` 先 drain 调度器，再检查自动化、普通队列、执行中会话和待审批请求。忙时拒绝切换；退出未完成交接时恢复调度。
4. 当前 Codex turn 尚在运行时，`check latest` 应报告 activeTurns 并返回 3；这表示空闲保护生效。结束当前 turn 后才在独立终端重试。

验证命令：`pnpm exec vitest run src/cli/codexappReleaseSwitch.test.ts`。清理沿用上述临时目录自动清理和独立终端回滚步骤；测试不修改生产任务或账号。

### 0.1.90 候选更新保护

前提：使用独立候选容器和 CODEX_HOME；生产 5900 不参与本用例。自动测试可使用 `candidateDeploy.test.ts` 的工具桩。

- 模拟构建失败：旧容器应保持运行，未执行 stop/rm。
- 分别准备普通活动 turn、排队消息、待审批，或让状态接口返回错误/无效结构：禁止替换，恢复自动化领取状态。
- 模拟新容器启动失败：恢复之前的容器名称并 start，保留旧数据卷。
- 成功时顺序必须为构建镜像 → 停止领取 → 完整空闲检查 → 切换 → 健康检查 → 清理旧容器。

清理：删除桩测试临时目录；真实验证只取消测试任务，不删除认证和状态卷。发布 prepare 与 activate 仍为独立步骤。

候选健康检查同时验证首页和 scheduler ready；清理旧容器失败不会回滚已健康的新容器。若镜像仓库临时不可达，可通过 `CODEXAPP_MULTI_ACCOUNT_DOCKERFILE` 指向本地构建配方；复用已有依赖层前必须逐项核对当前包的 dependencies、optionalDependencies、engines，一致才允许复用。最终仍需新包安装、CLI 和 CJS 验证。

## 0.2.0 反代组件随发布目录固定

前置：已验证 59001 的 0.2.0，源码干净并提交。执行 prepare 后检查发布目录 `api-proxy-component/` 内二进制、manifest 与 LICENSE；二进制哈希必须等于固定 manifest。prepare 不修改生产 drop-in 或认证。

在隔离服务 fixture 中 activate，确认生成的 drop-in 将 `CODEXAPP_API_PROXY_BINARY` 指向该发布目录，而非候选容器内 `/opt`。损坏组件时 check 必须在访问/切换生产前失败；旧版不含 API 入口的 release 保持可回滚。回滚使用原 drop-in 快照，不能遗留新版本组件路径。

清理：移除 fixture 发布目录和假服务状态；真实 prepare 保留发布目录与 latest-prepared，生产切换另行执行。


### 0.2.17 prepare 收尾与缓存迁移

前提：候选已验收，任务启动的 4173 及后台终端身份明确；准备包版本和源码提交已记录。

1. 使用真实 prepared 包、独立 CODEX_HOME 和空闲本地端口：浏览器先访问上一版，再在同一地址切到 prepared 包并刷新，保留浏览器缓存，不使用路由拦截。确认版本更新、入口无验证器且 no-store、旧 JS 404、新资源可命中缓存；执行 CJS 帮助及真实 PTY 命令。
2. 按 cwd、命令、监听和已知会话的后台终端 processId/itemId 核对任务服务，经应用终端停止入口清理；确认监听消失、启动进程退出、后台记录不存在。保留生产、59001、5173 和未知归属进程。
3. 清理后运行精确路径 check；有活跃回合或 API 请求时应阻塞。全局 backgroundThreads=skipped-busy 必须标为未检查，不因为本会话后台列表为空就改为零。

清理：只移除本次临时验证服务；保留 prepared 目录及候选数据卷。记录可在独立终端执行的精确路径复查命令，prepare 不执行 activate。

## 0.2.19：自动激活的发布准入与迟到工作

- 前置：隔离 home 与模拟激活上游；正常 API 流、固定账号流和默认账号均用 fixture，不能扣真实额度。
- 操作：分别挂起激活的额度检查、准备、发送、清理；读取 `/codex-api/api-proxy/activation/activity`。发布脚本先 POST `/activation/drain` 冻结，再检查空闲；模拟交接失败并撤销冻结。让准备超时后迟到返回资源。
- 预期：未结束的底层工作与迟到清理均阻止发布；冻结不改变计划持久设置。解除后后续计划恢复。固定账号 API 流不断开，普通切换/额度保护及默认出口的原有拒绝规则不变；旧版本缺失统计标为 unsupported，不能声称检查了激活。
- 清理：对同一隔离服务 POST `{"draining":false}` 到激活、API、自动化各自的 drain 入口；释放 fixture，停止自有测试进程。只读 check 不改变准入状态。
- 性能：仅发布检查新增两次小型只读请求；不计入普通 API 请求/用量。激活执行增加有界 Promise 跟踪，超时后未结束的工作继续被看见；无新轮询、无账号刷新次数增加。

## 0.2.19：运行依赖与部署锁

- 前置：使用当前已验证的 Node 24 和隔离安装目录；不用生产 node_modules。
- 操作：build/pack 后安装 tarball，确认九个直接运行/可选依赖与本次开发基线一致；prepare 产物应包含 package-lock.json。在第二个临时目录用该锁执行 npm ci --omit=dev，比较依赖清单；执行 CLI --help、CJS require 和真实 PTY 输出。
- 预期：固定已安装版本，不升级版本；prepare 记录传递依赖，切换阶段不重新解析或安装依赖。Node 18 的完整支持仍未验证，不据清单声明宣传已经验收。
- 清理：只删除本次自有临时安装目录；保留候选 home 和精确 prepare 目录。此操作不改生产服务。
