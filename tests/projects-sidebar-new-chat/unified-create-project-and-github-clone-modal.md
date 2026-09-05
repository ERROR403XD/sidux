### Feature: Unified create project and GitHub clone modal

Prerequisites/setup:
- Run the app with access to `git` and network access to `github.com`.
- Have a small public GitHub repository URL available for testing.

Steps:
1. Open the app in light theme and navigate to the new chat screen.
2. Confirm the folder actions show `Select folder` and `Create Project`.
3. Click `Create Project` and confirm a modal opens with `New project` and `Clone from GitHub` modes.
4. In `New project`, keep or edit the destination folder, enter a display name (Chinese, spaces and slashes are allowed), and submit.
5. Confirm the created project folder is selected in the new chat folder selector and appears as a project root.
6. Reopen the modal, switch to `Clone from GitHub`, paste a valid `https://github.com/<owner>/<repo>` URL, and submit.
7. Confirm the cloned repository folder is selected in the new chat folder selector and appears as a project root.
8. Switch the app to dark theme and repeat opening the modal.
9. Confirm the modal, tabs, inputs, error message, and buttons have readable contrast and stable spacing.

Expected results:
- New project creation and GitHub cloning share one modal; creation uses the target itself and Clone uses a parent directory.
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

### 0.1.89：项目显示名与目标路径分离

前提：专用临时目录；英文/中文各检查，保留已有项目及线程作为对照。

步骤：名称“我的 / 机器人”，目标填专用目录完整绝对路径并提交；刷新确认 label 保留。使用同一路径及另一个名称再次提交；再以相同名称创建另一路径。测试空名称、相对路径、普通文件、不可写目录。修改目标时确认默认名称随目录变化，手工编辑名称后不再被覆盖。未选择目录时不默认使用其父目录。切换 Clone，确认提示父目录且仍创建仓库名子目录。目录选择器中单独创建子文件夹。

预期：cwd 等于指定目标，无名称子目录；原文件不变；同路径仅一个项目且 label 更新；不同路径同名可共存，路径 tooltip 区分；旧线程归属不变。错误不登记项目。

清理：从列表移除本轮测试项目，仅删除本轮新建临时目录。

性能：创建模式不请求 project-root-suggestion；一次创建 POST 后读取既有 workspace state，不增加递归扫描。子文件夹入口继续使用原建议接口。
