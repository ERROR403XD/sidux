2026-10-09 007 03E Git read route contract

Feature/change name:
- 03E Git branches/repository-status route migration

Prerequisites/setup:
- Create a disposable Git repository with one commit.
- Create separate empty non-Git directory, missing path, and file path fixtures.

Actions:
1. Call `GET /codex-api/git/branches` with the Git repo cwd.
2. Call `GET /codex-api/git/repository-status` with Git repo, non-Git directory, missing path, file path, and empty cwd.
3. Compare branch ordering, current branch, repository root, and status codes with the previous UI behavior.

Expected results:
- Git repo branch list includes the current branch first and preserves remote/local classification.
- Repository status returns true and the Git root for a repo, and false/empty root for a non-Git directory.
- Missing cwd returns 404; file path returns 400; empty cwd returns 400.
- Unrelated methods/paths remain unhandled by this route family.

Rollback/cleanup:
- Remove disposable repositories/directories.
- Revert the Git read route migration commit.

## 0.2.22 Git/worktree 完整业务服务边界

前置条件：只使用临时 Git 仓库、独立 CODEX_HOME 和验证服务；仓库有两个本地分支、一个远端引用、至少两个提交。不要对真实项目执行 checkout/reset 故障注入。

操作：
1. 调用原有 branches/repository-status，以及 worktree branches/create/create-permanent，确认路径、分支排序与响应字段不变；永久目录已存在时返回 409，源路径为文件时返回 400。
2. 分别创建 detached 和永久 worktree，刷新项目列表；确认各只登记一次，未知全局状态键保留。用一次性测试服务让 persistWorkspaceRoot 拒绝，检查 Git worktree 登记、创建目录及新永久分支撤销。
3. checkout 到包含同名文件的目标分支，确认未跟踪原件备份到 `.codex/untracked-backups/`；用 `.git/index.lock` 注入失败，确认原件恢复。覆盖带空格/Tab 的文件名与文件/目录冲突。
4. 分别以 tracked dirty、仅未跟踪文件测试 checkout/reset；前者拒绝，后者保留原件并允许操作。
5. 从 detached HEAD 重置本地分支到旧提交，确认仍在本地分支，旧 tip 有内部历史引用；includeResetHistory=false 隐藏历史引用，最多读取 50 提交，反复重置引用数最多 25。
6. 读取包含 rename、binary 与特殊文件名的提交，确认 previousPath、状态、增删行数与原路径一致。
7. 让另一临时 worktree 占用目标本地分支并保留未提交编辑，从源仓库 checkout 该分支。确认源仓库切换成功、另一 worktree 变为 detached 且编辑原样保留；Git 2.43 的 already used by worktree 与旧 already checked out 提示均受支持。不相关 Git 错误仍拒绝并恢复已移动原件。

预期：route 只解析参数和映射 HTTP，服务独占上述完整操作；工作区登记继续沿用既有按文件事务。迁移验证使用真实 HTTP/Git/文件，无额外请求、timer 或缓存。

清理/回滚：删除测试 index.lock；在临时仓库中移除测试 worktree/分支，再删除临时 home/仓库。每批可单独 revert；不清空标准 59001 卷。
