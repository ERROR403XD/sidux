### Feature: Thread read gateway boundary

#### Feature/Change Name
0.2.22 `022-02C` moves thread list/detail/older-history reads, the resume cache, turn delivery, and turn interrupt behind their API gateways. `022-03B` moves the persisted thread title, pin, first-launch home-card preference, workspace roots state, thread completion, and queue-state read HTTP routes out of the bridge while preserving their API contracts.

#### Prerequisites/Setup
1. Unit test dependencies installed.
2. A mock RPC endpoint can distinguish `thread/list`, `thread/read`, and `thread/resume`.
3. A mock `/codex-api/thread-turn-page` endpoint can return cursor metadata.

#### Steps
0. Run `pnpm exec vitest run src/server/routes/preferencesRoutes.test.ts src/server/routes/workspaceRoutes.test.ts src/server/routes/sessionRoutes.test.ts src/server/routes/projectRoutes.test.ts src/server/httpUtils.test.ts src/server/bridgeLifecycle.test.ts`.
1. Run `pnpm exec vitest run src/api/gatewayDependencies.test.ts src/api/threadReadGateway.test.ts src/api/codexGateway.test.ts`.
2. Inspect the first and background `thread/list` requests.
3. Open an older history page with both a native cursor and `source=native`.
4. Open the same still-idle thread twice before invalidating its resume cache.
5. Send an immediate message, a steer-mode message, and an attachment-only message through existing UI workflows.
6. Try Stop with and without a current `turnId`; then run an existing UI workflow that imports these APIs through `codexGateway`.

#### Expected Results
- The preference route family keeps the existing method/status/body behavior for thread titles, pins, and first-launch card dismissal.
- Session-index titles merge over persisted titles, malformed lines are skipped, and a changed file signature refreshes the cached titles.
- A successful title update preserves unrelated global-state keys and only then invalidates thread search; a missing ID returns HTTP 400.
- Pin IDs and first-launch dismissal keep the existing normalization rules and preserve unrelated global-state keys.
- Workspace roots GET keeps the canonical read result; PUT keeps object validation, normalization, server-owned remote projects, and project-order fallback behavior.
- Completion reads, acknowledgements, and queue-state reads preserve their method/response contracts; missing acknowledgement identifiers are rejected before mutation.
- The first `thread/list` page remains limited to 50 and the background page can request 100.
- The older-history request preserves thread ID, turn ID, limit, cursor, and source without changing delivery behavior.
- Repeated resume requests use one coalesced promise until that thread is invalidated or evicted.
- Facade consumers keep the existing request path, error text, account-generation invalidation, and rollback/archive behavior.
- Attachment deduplication, placeholder prompts, local image conversion, model/effort/service-tier parameters, and protocol-2 delivery IDs remain unchanged.
- Stop still sends exactly one `turn/interrupt` with the current thread/turn IDs; missing IDs retain the existing guarded error behavior.
- `threadReadGateway` and `threadCommandGateway` have no import dependency on `codexGateway`; notification ownership remains unchanged.
- The desktop state imports thread command/read gateways directly and the dependency test blocks facade back-imports.
- Migrated quota, goal, sidebar-filter, terminal, command-dialog, and review consumers subscribe directly through `codexRpcClient`.
- Automation, thread preference, lifecycle, rollback, fork, and file-change consumers use their domain gateways rather than the facade.

#### Rollback/Cleanup
- Revert the gateway extraction commits; the facade remains the compatibility entry for existing consumers.

### 0.2.22 Q01 剩余领域 API 收口

- 前置：权威源码依赖可用；所有请求使用合成 HTTP/RPC fixture，不发送真实 Telegram 消息或供应商请求。
- 操作：运行 `pnpm exec vitest run src/api`；分别从领域入口和 `codexGateway` 调用供应方、Git/review、提示词及目录操作；模拟并发读取、读取失败、写成功和 409/500 错误。
- 预期：兼容导出引用同一操作，模块导入不发送网络请求。提示词只合并 pending read，失败可重试，写成功后旧 finally 不清理新读；Git 参数/响应归一化、review 错误优先级、供应方原 JSON 错误信封保持不变。搜索/队列继续沿用 AbortSignal 与可靠投递 outbox。
- 清理与回退：关闭 fixture；按依赖逆序 revert 消费者迁移和 API 迁移提交，保留标准候选卷，不迁移运行状态。

### 0.2.22 Q01 生产消费者与 AST 依赖门禁

- 前置：当前源码和 TypeScript 依赖可用，不需要任何用户凭据。
- 操作：运行 `pnpm exec vitest run src/api/gatewayDependencies.test.ts src/composables/useDesktopState.test.ts`；新增临时测试 fixture 的 Vue/TS 文件，经 `@/`、`.js`、re-export 或动态 import 回到 facade，或构成三文件间接循环；执行相同扫描。
- 预期：真实生产文件自动发现，无生产消费者导入 facade（含 type-only）。facade 仅显式 re-export，通知仍归原 RPC client。门禁发现新文件与间接循环；显式 type-only 循环不计作运行时循环。旧账号/分页/中断组合测试保持原断言。
- 清理与回退：临时 fixture 仅放测试 Map，不落入生产源码；若手工创建了 fixture，只删除自己创建的文件。该扫描覆盖本地字面量依赖，不替代 bundler 或运行时 callback 分析。
