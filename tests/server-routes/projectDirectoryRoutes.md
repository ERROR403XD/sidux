# 会话目录与GitHub克隆

前提：隔离home、随机localhost HTTP，运行 `pnpm exec vitest run src/server/projectDirectoryService.test.ts src/server/routes/projectConversationRoutes.test.ts src/server/routes/githubCloneRoutes.test.ts src/server/codexAppServerBridge.archive.test.ts src/server/virtualProjects.test.ts`。

1. 同时请求两个同prompt的会话目录；实际目录各不相同，并且虚拟项目store只登记各自cwd。
2. 制造20个可读名称碰撞，检查唯一suffix回退、不覆盖已有文件；空prompt使用new-chat。
3. 无效projectId保持500；自动化引用已删除项目时保留可用独立目录。POSIX workspace root为symlink时拒绝，目标目录不能产生内容。
4. 使用git进程和仅对合成GitHub URL生效的本地url rewrite克隆空bare仓库；检查真实.git、返回目录、workspace登记一次；重复目标拒绝。
5. URL/basePath失败及git失败保持400，清理失败任务自己的目标；已有目标文件保持不动。

测试不访问GitHub网络，不修改用户全局git配置，只在测试进程环境中使用GIT_CONFIG_COUNT。清理关闭随机服务并删除fixturehome；回滚只revert目录业务迁移，无schema变化。

## dev.8 并发克隆的目录归属

前提：新的随机任务目录、本地bare源仓库和独立用户home；合成GitHub URL只重写到该本地源，Git进程设置`GIT_ALLOW_PROTOCOL=file`。通过内存gateway/route/命令起始屏障控制时序，不启动HTTP服务或访问GitHub。

1. 向同一base/repo同时发两次克隆，在两次目标存在性检查都结束后，让第一条Git命令执行到请求成功。
2. 在第一个已返回目录中新建唯一标记文件并记录原仓库文件字节，再释放第二条Git命令。
3. 预期第二条因目录已存在而失败，但第一个目录、标记文件和workspace登记保持有效；失败清理只能处理本请求拥有的产物。
4. 顺序再克隆同名目标作对照，预期在stat检查阶段拒绝，原字节保留。

本轮`node docs/baseline/022/dev8-review-20261020/project-directory-offline.cjs`用真实Git和临时文件确认R50：并发失败删除了另一请求成功的目录及标记；顺序对照通过，脚本因未修复缺陷exit1。清理精确任务随机根，不能把此缺陷的错误清理方式用于真实目录。
