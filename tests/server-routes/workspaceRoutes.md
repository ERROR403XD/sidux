# 工作区状态与项目根操作

前提：隔离 `CODEX_HOME` 和随机 localhost HTTP，运行 `pnpm exec vitest run src/server/workspaceStateService.test.ts src/server/routes/workspaceRoutes.test.ts src/server/routes/projectRootRoutes.test.ts src/server/workspaceGlobalState.test.ts src/server/codexAppServerBridge.archive.test.ts src/server/globalStateStore.test.ts`。

1. 注册新真实目录并保存附加工作目录；检查实际目录、AGENTS.md、label、active/order/projectOrder和原有无关字段。
2. 并发注册两目录和保存标题/置顶；检查共享global-state事务不丢字段，每项一次HTTP请求。
3. 创建/改名/删除虚拟项目；检查project store、workspace读取、顺序去重和虚拟label归属；删除只移除注册，不删除文件目录。
4. PUT只更新客户端可编辑字段，保留remoteProjects和省略的projectOrder；重新创建service并GET，检查持久状态一致。
5. POSIX符号链接与canonical root同时出现时去重并保留canonical label；不存在路径按原合同保留。Windows跳过本合成symlink用例。
6. file/missing/无效id/非对象body保持原400/404；附加目录校验失败时已创建根目录保留，但workspace不登记该根。

清理：关闭随机服务，删除本次合成home。回滚只revert工作区/项目根迁移提交；不修改真实global-state、项目store或认证。

## dev.8 读取/写入失败的跨文件恢复

前提：新的任务home及真实临时状态文件，所有HTTP均由内存route适配；故障端口只允许对该home中的指定文件抛一次EIO。

1. 创建虚拟项目时，让project store保存成功，仅令随后global-state的rename失败。记录调用结果和已创建ID；重试同一创建意图，预期恢复原创建或明确保留其ID，不能误生成第二个项目。检查临时文件已清理。
2. 预先注册两个目录和标签，仅让下一次readWorkspaceRootsState读取失败，随后恢复读取并注册第三个目录。预期保留原root/标签/顺序，或返回可重试错误；不得成功覆盖旧状态为空快照。
3. 无故障注册、12目录并发注册、无关字段/remote保留、虚拟项目store损坏拒绝写入作对照；读取gateway并发合并且返回副本彼此独立。

离线脚本`project-directory-offline.cjs`确认R51虚拟创建失败重试重复、R52单次读取失败丢旧root与标签；正常对照通过。它只证明文件/模块恢复合同，不是实际NFS故障或UI刷新验收。撤销故障端口、等待自有操作settle并删除任务随机目录；保留真实用户状态。
