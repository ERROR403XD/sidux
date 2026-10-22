# 运行时元数据与原生请求合同

前提：使用隔离测试实例/会话；不要提交真实密钥或对生产审批执行操作。自动回归：`pnpm exec vitest run src/server/routes/runtimeMetadataRoutes.test.ts src/authRecovery.test.ts src/server/routes/notificationRoutes.test.ts`。合成可执行 CLI fixture 在 POSIX 上验证真实 spawn/schema 文件；Windows 跳过此 fixture。

操作：同时读取两次 `/codex-api/meta/capabilities`，再读取 `/meta/methods`、`/meta/notifications`，核对 appVersion、cliVersion、schemaHash 和 feature 字段。CLI 执行文件更新后再次读取，应该重新生成；生成失败恢复后可重试。读取 `/server-requests/pending` 时核对 pending 和 authRecovery 随当前 runtime 变化；对一个测试 pending ID POST `/server-requests/respond`，再重复提交同一 ID。读取 `/worker-pools` 与 `/home-directory`，非 GET 不应命中读取端点。

预期：同一 catalog 合并并发生成，暖缓存不重新生成 schema；临时 schema 目录被清理，失败不永久缓存。原生 pending ID 只被解析一次，重复/非法响应保留错误；回复不会重新生成 catalog。worker-pools 继续只返回计数，不附账号、凭据或内容；home path 来自运行实例的系统 home。

清理/回滚：fixture 删除临时可执行文件和 schema；真实测试仅恢复该临时会话的审批状态，不改全局 CLI/账号。服务迁移可独立 revert，无 schema 变化。
