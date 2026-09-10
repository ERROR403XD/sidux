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

性能：打开创建弹窗及生成显示名不再调用 project-root-suggestion；一次创建 POST 后读取既有 workspace state，不增加递归扫描。子文件夹入口和既有默认名称刷新保留原建议接口；浏览器实际重复请求仍待手工/获授权后的性能实测。

自动回归：先 `pnpm run build`，再 `node scripts/test-project-root-api.cjs`。脚本创建独立临时 CODEX_HOME、启动构建产物，通过真实 HTTP 检查指定目录、原文件保留、同路径去重、label 落盘、文件路径失败以及独立子文件夹创建；结束后删除自身临时目录。Linux 容器内加 `CODEXAPP_TEST_UNPRIVILEGED=1`，并指定 `CODEXAPP_TEST_CLI` 为已安装的 CLI，以 nobody 验证 EACCES；不要让 nobody 读取宿主机 `/root` 下的依赖。

提交中保护补充：在自动化保存/运行、目录创建/打开进行时按 Esc 或点击背景，弹窗应保持打开；完成后正常关闭。自动化取消按钮与遮罩/键盘使用相同禁止关闭条件。

Clone 自动回归：在隔离测试容器中加 `CODEXAPP_TEST_GITHUB_CLONE=1` 并允许网络，脚本克隆公开的 `octocat/Hello-World` 到已存在的测试父目录，验证实际路径是 `父目录/Hello-World`，并验证非 GitHub URL 被拒绝；测试结束清理自身克隆。

### 0.1.89 补充：精简项目文案

前提：中英文界面、浅色和深色主题。

操作：打开创建项目及 Git 更改面板；检查字段和标题。

预期：创建字段仅显示“项目名称”“目标文件夹”，不带“（显示名）”“（项目目录）”，不重复展示同一目录说明；Clone 保留必要的父目录语义；Git 更改入口不重复标注“已打开”。路径和 label 保存行为不变。

清理：取消弹窗，无需创建真实项目。

### 0.2.16：统一项目编辑与附加工作目录

前提：隔离 59001，准备主目录及两个已有附加目录（包括中文/空格路径），主目录 AGENTS.md 写入一段对照规则。浅深主题分别检查 1440×900、768×1024、375×812。

操作：
1. 首页“创建项目”填写名称、目标目录及每行一个附加目录，保存；从侧栏项目菜单“编辑项目”重新打开。
2. 修改名称，增加/删除附加目录，保存并刷新页面；从线程页面再次打开同一编辑窗口。
3. 输入不存在的附加目录并保存；核对错误和草稿，修正后重试。打开指向已有项目的创建目标，确认先读取其已有目录，读取失败时禁止保存。
4. 检查主目录 AGENTS.md，原规则与受管区块之外的后续文字必须完整保留，附加目录不重复；给 AGENTS.md 设置符号链接时应提示使用项目独立文件，不能改写链接目标。
5. 检查首页不再出现“已选文件夹”或本地项目/新 Worktree 的说明段落；Clone 页仍显示父目录字段且可提交。

预期：项目名和工作目录共用 AppDialog；编辑已有项目时主目录只读，名称修改不移动文件夹。附加目录记录在主目录 AGENTS.md 的 codexapp:work-directories 受管区块，模型可据此定位相关目录。无效目录不更新 AGENTS.md 和项目名称；刷新保留成功保存内容。浅深主题字段与弹窗一致，手机可滚动并看到保存按钮。附加目录需要已存在；当前功能提供目录指引，不把多个 Git 仓库合并为一个仓库。

清理：移除测试项目列表项，恢复测试 AGENTS.md，删除自己创建的临时目录。保留候选账号状态；不操作生产 5900。

文案补充：字段标签为“附加工作目录”，空输入框以两行占位提示 `/home/Code/project1` 和 `/home/Code/project2` 表示每行一条绝对路径；示例不能成为默认值或被提交。项目菜单入口统一显示“编辑项目”。
