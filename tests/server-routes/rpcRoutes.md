# RPC 主操作合同

前提：独立 CODEX_HOME、合成会话/原生 RPC；真实会话上的归档/回滚/审批应使用人工验收创建的临时线程。自动回归：`pnpm exec vitest run src/server/routes/rpcRoutes.test.ts src/server/codexAppServerBridge.archive.test.ts src/server/threadHistory.test.ts src/server/threadCompactionGate.test.ts src/server/directoryPluginCache.test.ts src/server/threadResponseService.test.ts`。

操作：POST `/codex-api/rpc` 的空/非法 body、generate-thread-title、旧 turn/start/steer、无 auth 的 account/rateLimits/read；再分别请求 thread/read/resume/fork、plugin/list、thread/compact/start、thread/rollback、thread/name/set/archive/list。准备含错误事件、行内图片和 skill 的合成会话，核对实际落盘图片和返回投影。

预期：非法 body 400；标题零原生调用，旧发送拒绝，不绕开发送队列。无 auth 额度读取返回 null，已认证的非认证失败不吞掉网络错误。history.initial 继续原生分页，全文投影最多十回合，错误→媒体→技能顺序与最终 snapshot 一致。插件同 scope 暖缓存零追加原生读取；重复压缩被 gate 拦截。combined rollback 先检查 history 支持；mutation 成功后才失效 history/search。config/plugin 变更仍在原生请求前使 MCP pending 失效。空日志可回退旧 snapshot，未物化只返回 inProgress；普通网络错误仍 502。API performance logging 继续记录该请求的 method 和 JSON body 字节。

清理/回滚：仅关闭临时端口，删除 fixture home/会话与本批产生的合成媒体；保留真实账号/会话。service 迁移可独立 revert，无协议或 schema 变化；Provider/Auth 的打包工程验证另记，不能据合成 RPC 推断真实供应方调用通过。
