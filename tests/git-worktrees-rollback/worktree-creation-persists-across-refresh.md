### Worktree creation persists across refresh

#### Feature/Change Name
Newly created temporary and permanent worktrees are persisted in workspace roots so their threads remain visible after a full browser refresh.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. A Git-backed workspace root is registered and selected in the Start new thread screen
3. Light theme and dark theme both available from the appearance switcher

#### Steps
1. In light theme, open Start new thread for the Git-backed workspace root.
2. Select `New worktree`, send a unique first prompt, and wait for the thread page to open.
3. Note the created worktree path from the selected folder or thread metadata.
4. Refresh the browser tab.
5. Confirm the new worktree-backed project/thread remains visible in the sidebar and can be opened.
6. Open the project action menu for the original Git-backed project and create a permanent named worktree.
7. Confirm the permanent worktree appears in the folder/project list, then refresh the browser tab.
8. Confirm the permanent worktree remains visible after refresh.
9. Switch to dark theme and repeat steps 1 through 5 with a second unique temporary worktree prompt.

#### Expected Results
- Temporary worktree creation writes the new worktree cwd to persisted workspace roots.
- Permanent worktree creation writes the new worktree cwd to persisted workspace roots.
- Full page refresh does not hide the newly created worktree project or its thread.
- The same behavior works in light theme and dark theme.
- If workspace-root persistence fails after `git worktree add`, the request fails cleanly and best-effort rollback removes the created worktree instead of leaving retry-prone orphaned worktrees.

#### Rollback/Cleanup
- Remove temporary test worktrees with `git worktree remove --force <worktree-path>`.
- Delete any empty temporary parent directory left under `$CODEX_HOME/worktrees/<id>`.
- Remove permanent test worktrees with `git worktree remove --force <worktree-path>` and delete their test branch if needed.

---

### dev.8 审核补充：创建失败后的目录与迟到分支

#### 前提

使用新的临时Git仓库A/B和独立CODEX_HOME；A仅有alpha分支，B仅有beta分支。分别使用任务目录内的`.codex`与`custom-home`布局；不得使用真实全局home。延迟/失败由领域API fixture提供，浏览器验收需要明亮和深色各一轮。

#### 操作与预期

1. 在A选择New worktree，真实创建成功后令首个thread/start失败。记录已创建cwd、runtime、root保存和原仓库文件字节；直接重试同一草稿，预期仍向该worktree创建会话，不自动改为原项目目录。对两种home布局都执行。
2. 预先识别A/B为Git，切到New worktree并延迟A分支响应，再切B，先等B显示beta，最后释放A。预期当前目录、选项和选中分支仍属B，创建应从beta成功；顺序切换为对照。
3. 统计一次Local→New worktree的分支请求，预期同目标读取可合并，不因两个watcher重复启动Git命令。
4. 对detached/permanent两种worktree分别模拟root保存失败，核对git worktree list、目录及新分支均回到创建前；单独检查git worktree add失败后是否留空父目录。
5. 正常创建后刷新，检查实际workspace roots及会话cwd仍是新worktree；此步骤必须使用真实运行时和浏览器，离线callback文件不能作为刷新证据。

#### 本轮状态与清理

`new-thread-worktree-offline.cjs`组合App原函数/watch、真实Vue、gateway/route和临时Git：确认R48默认home失败重试回原项目、R49迟到A覆盖B；自定义home重试、顺序分支及两种root失败回滚对照通过。root保存端口写任务夹具JSON，未验证真实全局状态或浏览器刷新。

清理只处理本次新建目录、worktree和合成回调状态；脚本finally删除自己的随机根目录，不触碰标准测试卷或真实工作树。未授权执行产品修复或回滚。

### 2026-10-21 实际UI补证与剩余范围

运行`node docs/baseline/022/dev8-review-20261020/worktree-ui.cjs`，三个尺寸各浅深：正常、默认home失败重试、自定义home失败重试、A迟到分支四场景。每组新建Git仓库，选择/搜索/发送/重试/刷新均操作实际UI。预期正确合同仍要求重试保留已创建cwd、旧分支响应不得覆盖当前项目；dev.8分别复现R48/R49，报告保留exit1。

`results/worktree-ui.json`合并24个完整场景（768-light-race因辅助账号刷新夹具拦截而完整重跑），210检查192通过/18失败。102张功能截图及原始请求、真实Git HEAD和文件字节齐全。实际刷新从本轮夹具JSON恢复历史和roots，证明前端刷新行为；仍未完成上文第5项的原生持久化service与原生会话组合验收，也未覆盖永久worktree实际UI。

另以`WORKTREE_UI_MODES=visual WORKTREE_UI_OUTPUT=visual-final`运行相同脚本。A增加两个正常长分支名，在选中短名alpha与长名后分别打开菜单，预期搜索菜单保留可阅读宽度，深色按钮使用深色表面且正常字号文字对比度至少4.5:1。六组确认R63/R64，48检查36通过/12失败。清理只删除脚本新建随机根；保留审核4173，原201条会话不改。

### 2026-10-21 原生组合验收状态

第29批计划以已安装dev.8、真实Codex/Git与独立home补证永久worktree及刷新/重启持久性，但桌面预跑因夹具WebSocket连接失败终止，完整操作链未完成。`results/worktree-native-incomplete.json`只保留未完成证据，不能满足本条验收。产品预期与清理步骤保持以上定义；当前缺口留在主审核报告，不以第28批合成历史刷新替代原生验收。

### dev.8 G1/G3原生补证已完成

- 前置：专用internal网络容器、已校验安装包和原生Codex、固定本地provider、透明origin代理；一个1440×1000浅色页面即可，已有主题证据复用。
- 操作：在自有Git根分别通过实际UI创建临时detached工作树和永久命名分支工作树，发送唯一标记并核对原生completed历史；真实刷新两页面，再完整重启自有CLI/native、重开同home与原URL。核对两thread/turn ID、cwd、roots、Git HEAD/分支和文件字节，生成次数各1。选择原项目须用完整data-project-name，避免同basename工作树。
- 结果：`native-browser-boundaries.cjs`的delivery两场景15/15、worktree两路径7/7；结果/七图/SHA见审核`results/native-browser-boundaries-review.json`。此处更新此前原生组合缺口，不替代外部云或磁盘故障验收。
- 清理：关闭自有浏览器与代理，按容器ID/label清理本次容器与网络，原4173保留，不触碰5900/59001/5173。
