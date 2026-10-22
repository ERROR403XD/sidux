### Feature: Rollback undoes apply_patch file changes

#### Prerequisites
- App is running from this repository (`pnpm run dev`).
- A thread exists with at least one completed turn that applied file changes via `apply_patch`.
- The thread's `cwd` points to a git-tracked directory.

#### Steps
1. Open a thread with file changes visible in the conversation (file change cards with diffs).
2. Note the current state of a file that was modified by the agent in a recent turn.
3. Click the rollback button on a turn that has file changes.
4. After rollback completes, check the file on disk — it should be restored to the state before the agent modified it.
5. Verify the thread conversation no longer shows the rolled-back turns.
6. For turns that added new files: verify the added files are deleted from disk.
7. For turns that deleted files: verify the deleted files are restored (if they were tracked in git).

#### Expected Results
- Clicking rollback on a turn reverts both the thread history AND the file system changes from that turn and all subsequent turns.
- Files modified by `apply_patch` in rolled-back turns are restored via `git checkout HEAD -- <path>`.
- Files created by `apply_patch` in rolled-back turns are removed from disk.
- Files deleted by `apply_patch` in rolled-back turns are restored from git HEAD.
- File moves in rolled-back turns are reversed (moved file is renamed back to original path).
- If file revert fails (e.g., not a git repo), the thread rollback still proceeds — file revert is best-effort.
- The rollback-files endpoint (`POST /codex-api/thread/rollback-files`) can be called independently for testing.

#### Rollback/Cleanup
- No cleanup required — rolled-back files are already restored.

### 0.2.22 文件操作服务边界

前提：使用独立临时 Git worktree 和测试会话，准备两个完成回合，分别把同一文件从 initial 改成 one、再改成 two；另准备移动文件与 tracked 删除。不要使用真实用户工作区。

操作：调用 `POST /codex-api/thread/rollback-files`，传 threadId、首个 turnId 和临时 cwd；先省略 action/scope，再传 `action=redo`。此迁移批使用 `@@ -1 +1 @@` 补丁。核对撤销后为 initial、重做后为 two，patch ID 撤销逆序、重做正序。再用 `scope=single_turn` 和一个 patchIds 撤销，确认后续回合及未选补丁保持；移动撤销恢复旧路径，重做恢复新路径；tracked 删除从 HEAD 恢复。

预期：combined history 在 active/paginated 时先拒绝，不能读取完整日志或修改文件；单回合不依赖此 gate。不匹配的 untracked 补丁返回部分错误且保留文件。缺参数 400，执行异常 500，空/不可读日志保留既有响应字段。HTTP、history、临时 Git 组合测试通过；原生 RPC 是合成响应。

迁移时复现的裸 `@@` 重做虚报成功已用独立行为批修复。额外操作：用裸 `@@`、`@@ context`、省略首个 hunk header、包含 `*** End of File` 的补丁重复重做，核对真实文件内容；给目标文件插入不匹配的本地编辑再重做，预期 changed=0/错误且原文件保留。移动与两个回合裸 hunk 重做也必须检查新路径内容。

清理/回滚：仅删除临时会话和 worktree；代码可独立 revert，无持久化 schema 变化。

### Feature: Chat file-change undo and redo

#### Prerequisites
- App is running from this repository (`pnpm run dev`).
- A thread exists with at least one completed assistant turn that applied file changes via `apply_patch`.
- The thread's `cwd` points to a writable worktree.

#### Steps
1. Open a thread with a visible file-change summary under an assistant response.
2. Expand the file-change summary, identify one changed file, and save its current contents with `cat <file> > /tmp/file-before-undo.txt`.
3. Confirm the file-change action row shows `Undo` and does not show a separate `Redo` button.
4. Click `Undo` in the file-change action row.
5. Confirm the button enters an `Undoing` pending state and then changes to `Redo`.
6. Verify the file contents on disk are restored to the pre-turn state with `diff -u /tmp/file-before-undo.txt <file>`.
7. Click `Redo` in the same file-change action row.
8. Confirm the button enters a `Redoing` pending state and then changes back to `Undo`.
9. Verify the file contents on disk match the assistant turn's changes again with `cat <file>` or a diff against the assistant-modified snapshot.
10. Repeat steps 1-9 in light theme and dark theme.

#### Expected Results
- Undo reverts the file changes applied by the selected turn without changing chat history.
- Redo reapplies the previously run `apply_patch` input without changing chat history.
- The file-change action row shows exactly one action button at a time: `Undo` before rollback, `Redo` after undo, and `Undo` again after redo.
- If Undo changes no files, the inline error stays visible and the action remains `Undo` for retry. Partial Undo switches to `Redo` only for the returned reverted patch IDs.
- Any backend error appears inline in the file-change panel.
- The action row uses themed controls that remain readable in light and dark theme.

#### Verification Evidence
- Light screenshot: `output/playwright/chat-file-changes-failed-undo-single-redo-light.jpg`.
- Dark screenshot: `output/playwright/chat-file-changes-failed-undo-single-redo-dark.jpg`.
- Browser runtime profile: `output/playwright/browser-runtime-profile-home-2026-05-20T03-11-53-121Z.json`.
- Profile result on `http://127.0.0.1:4173/`: `warnings: []`, `threadReadDuplicateKeys: 0`, `totalApiKB: 337.9`.
- Code-path audit: file-change action state is component-local and keyed by thread plus turn, so it does not add startup or thread-list requests. Undo/redo server work is request-scoped, bounded to collected patch inputs for the selected turn or explicit patch subset, and uses sequential filesystem operations without background fanout.

#### Rollback/Cleanup
- Click `Undo` again if the test should leave the worktree without the assistant's file changes.

### 0.2.22 Conversation 文件动作 owner、焦点与卸载

前提：构建当前分支；4173 必须运行当前源码和独立 `seed-022-baseline` home。只用临时工作区、合成会话和合成认证，不能指向用户工作区或 5900/59001 状态。完整可复跑脚本及现场证据见 [本轮记录](../../docs/baseline/022/conversation-file-actions-20261012/README.md)。

### 0.2.22 单个多文件补丁的失败恢复与重试

前提：当前源码的 4173 和独立合成 home。自动验证：`FILE_UI_HOME=<独立合成home> node scripts/verify-022-multi-file-patch.cjs`；只创建脚本自己的临时工作区、会话和一个同时修改两个文件的 patch。

操作：让 Undo 的第二个文件不匹配，观察两个文件及动作按钮；修正文件后重试 Undo。再让 Redo 的第二个文件不匹配，核对磁盘与按钮；修正后重试 Redo。使用同一个 patch ID，不能用两个独立 patch 代替。重复亮暗、中英文及三种视口。服务端组合单测还覆盖添加、删除、移动、符号链接、二进制/模式、Git index 和同工作区并发。

预期：失败补丁已改成员恢复原内容，changed=0、成功 patch ID 列表为空；动作保持原来的 Undo/Redo，内联错误可见且焦点返回原按钮。修正文件后重试整个 patch 成功；不同 patch 的部分成功合同仍保持。Git 回退不改用户暂存区。操作按真实 cwd 串行，失败也释放槽；没有后台循环或新首屏请求。恢复自身失败须返回明确错误，不能声称完全恢复；这不是断电或进程终止下的跨文件原子写保证。

清理：自动脚本关闭浏览器后只删除自己创建的会话和临时工作区，保留 `output/playwright/022-interactions/multi-file/` 证据。手工测试恢复自己的文件，不在用户工作区制造不匹配场景。

操作：

1. 打开同时包含助手回复下方摘要和独立文件摘要的测试会话，展开两处摘要；每处只有一个动作按钮。
2. 让首个 Undo 返回 HTTP 500/changed=0，确认原文件不变、错误显示且仍为 Undo；再次操作可以成功。
3. 延迟一个 Undo，在其未完成时点击同回合和其他回合按钮；全部文件动作被禁用，命令守卫不发第二次请求。将焦点移到另一个摘要的展开按钮，完成后不能抢回焦点。
4. 用两个独立 patch 分别修改 a.txt/b.txt；Undo 后使 b.txt 与补丁不匹配，再 Redo。确认 a.txt 已恢复、b.txt 的本地内容保留，下一次 Redo 仅带失败的 patch-b；修复测试 b.txt 后重试成功，再 Undo 仍撤销两个 patch。
5. 用键盘聚焦动作按钮，操作完成后焦点返回原按钮且不滚动页面；如果会话/目录/账号变更或按钮已卸载，不恢复旧按钮焦点。
6. 请求未完成时进入设置页，确认 Conversation 实际卸载，再让旧请求分别成功/失败；回到会话后不能出现旧结果、旧错误或旧 pending。请求可能已在服务端执行，切换视图不代表取消文件写入；只在测试工作区核对内容。
7. 在同一挂载实例上验证 thread/cwd 的 A→B→A 和 accountRevision 变化；旧完成不能恢复旧 patch ID。新身份在旧请求完成前也不能并发发起文件动作。
8. 在 1440x1000、768x1024、375x812，各浅色中文/暗色英文检查摘要、动作和差异查看器；手机关闭按钮必须盖在页头之上并能实际点击。
9. 向上翻页，记录仍可见消息的 DOM 元素和顶部位置；加载后元素复用、锚点位移不超过 3px，单次分页只发一个请求。使用真实协议 cursor fixture，不用重复当前页的响应冒充分页。
10. 从输入框发送唯一 TestChat 标记，附粗体文本、绝对文件 Markdown 链接及外部链接；检查真实用户行的 hrefOk/titleOk/textOk，刷新后再核对并截图。

预期：文件动作的状态、错误、patch 范围、互斥与同步身份 watch 只由 `conversationFileActionsController` 拥有，父层仅装配和处理按钮焦点。stop 幂等并拒绝迟到结果/后续命令；错误或无变化不能虚报状态转换，空 patch 数组不能扩大为全部补丁。当前动作状态仍为会话视图内状态，本批未新增持久化。服务端确认粒度为 patch；这里的部分重试用两个独立 patch 验证，不作为单个多文件 patch 的文件级事务证明。

清理/回滚：脚本只清理自己创建的随机会话 JSON 和临时工作区；原测试 home 保留。手动测试先记录临时文件初始内容，完成后仅删除该测试会话/目录。不要删除固定测试卷，不停止 5173，不部署 5900/59001。

### 0.2.22 文件摘要与差异展示边界

前提：4173 运行当前构建对应源码和独立合成 home；准备包含独立文件摘要、助手下方摘要的临时会话，覆盖 add/delete/update/move 和空 diff。差异包含多 hunk、行号、`<tag>`/`&` 字面文本；仅使用测试工作区。脚本和逐组证据见 [展示复验](../../docs/baseline/022/conversation-file-presentation-20261012/README.md)。

操作：

1. 在 1440×1000、768×1024、375×812，各浅色中文/暗色英文展开两处摘要，检查操作徽标、路径/移动目的路径、增删行计数与原层级。
2. 分别打开五种文件结果；检查新增/删除行列号、update hunk 的原/新行号、HTML 字面文本和空 diff 提示。桌面从列表选择另一个文件，手机打开 sheet 后选择另一个文件；手机 sheet 自动关闭，顶部关闭按钮可以真实点击。
3. 打开差异浮层后切到另一个会话；预期旧浮层立即关闭，旧 DOM 不再连接。对同挂载实例的 cwd/accountRevision 变化及 A→B→A 重复；旧展开和选中文件不能恢复。
4. 执行上一节的错误/重试、部分 Redo、后续完整 Undo、pending 互斥、焦点和卸载步骤，核对组件事件传递后仍是原动作按钮，完成后不抢焦点或改变滚动位置。
5. 向上翻页时保留一个摘要/消息的 DOM 引用，确认仍有效的展开状态保留、原消息元素复用，锚点位移不超过 3px、分页只发一个请求；只有从消息投影移除的摘要才被剪枝。
6. 从真实输入框发送唯一 TestChat marker、粗体/文件/外部链接；检查 hrefOk/titleOk/textOk，刷新后再次核对真实消息行。

预期：展开/选择/移动列表和同步身份清理由 `useConversationFilePresentation` 拥有，scope stop 幂等；子组件只有只读数据/标量和窄事件，无消息数组复制、API 或 timer。摘要/差异/复制文本复用原纯函数，原文件动作 owner 和焦点合同保持，亮暗样式及 DOM 层级等价；查看器打开/选择不新增文件请求。本项通过不替代审批/IME/增量回复等完整 05C 整合。

清理/回滚：只清理本次随机会话和测试工作区；原测试 home、固定测试卷与用户工作区保持。代码可独立 revert，无 schema 变更，不触碰 5173、5900/59001。

### dev.8审核R37：文件已撤回、历史失败后的重试

前提：全新临时Git仓库；HEAD/index为base，回合前工作区为before，目标补丁before→after。命令：`node docs/baseline/022/dev8-review-20261020/rollback-retry-offline.cjs`。脚本使用真实模块和本地Git，内存连接路由与RPC，不启动服务。

操作：先让文件撤回成功、历史撤回在提交前失败，记录文件和历史；重试同一回合撤回，再核对文件字节、历史、错误与busy。另做无故障、before等于HEAD、active/paginated预检、untracked不匹配对照。

预期：重试成功后文件仍为before，不能恢复成更早的HEAD而覆盖旧未提交内容；index与HEAD均保持。当前dev.8为17通过/1失败，重试将before覆盖为base，确认P1 R37；未作产品修复，无浏览器复现。前文best-effort旧说明不能替代当前预检/错误阻断行为。

清理：脚本仅删除自己通过mkdtemp创建的随机目录，结果记录目录已移除；不得指向真实项目、账号或会话目录。
