### Feature: Unified create project and GitHub clone modal

Prerequisites/setup:
- Run the app with access to `git` and network access to `github.com`.
- Have a small public GitHub repository URL available for testing.

Steps:
1. Open the app in light theme and navigate to the new chat screen.
2. Confirm the folder actions show `Select folder` and `Create Project`.
3. Click `Create Project` and confirm a modal opens with `New project` and `Clone from GitHub` modes.
4. In `New project`, keep or edit the destination folder, enter a single folder name, and submit.
5. Confirm the created project folder is selected in the new chat folder selector and appears as a project root.
6. Reopen the modal, switch to `Clone from GitHub`, paste a valid `https://github.com/<owner>/<repo>` URL, and submit.
7. Confirm the cloned repository folder is selected in the new chat folder selector and appears as a project root.
8. Switch the app to dark theme and repeat opening the modal.
9. Confirm the modal, tabs, inputs, error message, and buttons have readable contrast and stable spacing.

Expected results:
- New project creation and GitHub cloning share one modal and destination folder field.
- Created and cloned folders are registered as project roots and selected for the new chat.
- After cloning, the folder selector immediately includes the cloned project without a full page refresh.
- Invalid project names or non-GitHub URLs show an inline modal error without changing the selected folder.
- A stalled clone eventually fails with an error instead of keeping the request open indefinitely.
- Light and dark themes render the unified modal consistently with the existing new-chat controls.

Rollback/cleanup:
- Remove the created project folder from the filesystem if it was only used for testing.
- Remove the cloned repository folder from the filesystem if it was only used for testing.
- Remove the test projects from the app project list if they are no longer needed.

### 0.1.89：模态遮罩完整手势

前提：候选环境，创建/选择目录、线程重命名/删除、自动化、技能及目录详情弹窗。

步骤：逐个打开弹窗；填写内容并从面板内拖选至背景松开；反向拖动；从背景移开再移回；右键、多指触控、取消手势；最后正常点击背景。打开嵌套详情，按 Esc。提交过程中重复关闭操作。

预期：仅完整背景左键点击关闭；拖选保留内容；Esc 只关闭顶层；提交中沿用各弹窗禁止关闭规则；取消按钮仍可用。浅色、深色各检查一次。

清理：取消测试弹窗，不提交删除真实线程。

性能：所有模态共用一组事件监听，仅处理顶层，手势为常数状态；最后一个弹窗卸载时移除监听。
