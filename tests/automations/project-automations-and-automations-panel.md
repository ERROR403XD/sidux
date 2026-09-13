### Feature: Project automations and `/automations` panel

#### Prerequisites
- App is running from this repository.
- At least two sidebar projects have absolute workspace paths.
- Local Codex home is writable (`$CODEX_HOME` or `~/.codex`).
- Light and dark themes are both available from Settings.

#### Steps
1. In light theme, open a project overflow menu for a project without an attached automation.
2. Confirm the menu shows `Add automation…`, then create a project automation with a name, prompt, RRULE schedule, and status.
3. Confirm the project row shows an automation chip and the same menu changes to `Manage automations…`.
4. Open `/automations` from the sidebar and confirm the new project automation appears with the visible project display name.
5. Edit the automation from `/automations`, change its name and status, save, and confirm the project row chip count and tooltip update without a full page refresh.
6. Seed or keep a cron automation record whose `cwds` contains two project paths, then edit it from one project and confirm both project rows show the updated name/status.
7. Seed a cron automation record with a TOML-style single-quoted `cwds` array such as `cwds = ['/tmp/project-one', '/tmp/project,two']`, refresh `/automations`, and confirm it is still listed.
8. Inspect `/codex-api/project-automations` for the seeded record and confirm the response includes public automation fields but not `extraTomlLines`.
9. Remove one project that has an attached automation while `/automations` is open and confirm the panel removes the deleted project row after the cleanup completes.
10. Switch to dark theme and repeat opening the project menu and `/automations`; confirm rows, chips, buttons, inputs, and empty states remain readable.

#### Expected Results
- Project-scoped cron automations are listed under every associated `cwd`.
- Editing a multi-`cwd` project automation refreshes all affected sidebar chips/tooltips, not only the currently edited project.
- Existing TOML cron records with valid non-JSON string arrays remain visible and manageable.
- Automation API responses do not include internal preserved TOML metadata such as `extraTomlLines`.
- Removing a project deletes or detaches that project's automation association and refreshes the `/automations` panel.
- Preserved TOML metadata and table sections remain intact after saving or deleting a project automation.
- Light and dark theme project automation surfaces remain readable.

#### Rollback/Cleanup
- Remove any test project automations from the project automation dialog or delete their folders under `$CODEX_HOME/automations/<automation-id>/`.
- Remove temporary test projects or workspace roots created for verification.
## 0.2.10 自动化入口钟表图标

准备：打开当前候选，使用 1440×900 浅色和深色主题。

操作：检查左上侧栏“自动化”的图标，点击进入自动化页面，再检查页面标题旁图标。

预期：两处均为圆形表盘和时针/分针，保持原有颜色、尺寸和点击导航；技能入口仍保留原图标。图标无外部图片请求、无计时器或动画。

清理/回滚：无需清理数据；回退代码即可恢复旧图标，不修改自动化任务。

## 0.2.15 新建任务手动执行与消息交付（P1）

准备：使用独立 59001 候选、可用账号和临时工作目录。任务提示词只要求回复唯一标记，或读取该目录的虚构内容并写入结果文件。

操作：

1. 从自动化页新建项目任务，选择当前账号支持的模型，设为暂停并保存。刷新页面确认提示词、账号和模型保留。
2. 在编辑窗口点击“立即运行”，在历史中等待完成，打开执行会话，检查唯一标记和模型回复；不能只以入队成功作为通过。
3. 在详情页再次手动执行，确认新会话收到一次完整提示词。以相同 requestId 重放请求，确认返回同一个 runId，消息不重复。
4. 对失败记录点击重试，确认新 runId 记录 retryOf 和递增的 attempt，且只发一次消息。
5. 对已有空会话与已有历史会话分别创建心跳任务并运行；分别测试固定账号、跟随全局账号。使用分钟级临时任务检查定时执行后立即暂停。
6. 查看不存在会话、不可用账号和无效目录的失败提示；提交前失败不得显示为已发送。连接结果未知时不得自动重发。

预期：新建空会话不调用多余的 thread/resume；发送路径只恢复尚未加载的会话。手动、重试、定时执行均保留提示词和运行标记，历史有 turnId、最终状态和实际回复。其他活动会话与全局账号不受影响。

清理：删除临时任务及其工作目录，归档测试会话，确认候选自动化活动/队列归零。不得在 5900 重跑真实日记任务或向外部发送测试消息。


## 0.2.15 编辑窗口仅编辑当前任务

准备：隔离候选 59001 或 4173 请求拦截；同一项目/聊天各准备至少两个虚构任务。分别使用浅深主题与桌面、375×812 手机视口。

操作与预期：

1. 在自动化列表选择第二个任务并点击编辑。窗口只显示该任务的表单，不再显示任务切换列表或“再添加一个自动化”按钮，也不能通过窗口切换到其他任务。
2. 修改名称/提示词并保存，检查提交的 ID 为所选任务；另一个任务不变。关闭后重新进入该任务确认已保存。
3. 删除当前任务：成功后关闭窗口并更新外部列表，不自动切到另一个任务或新建草稿。删除失败时保留表单和错误供重试。
4. 回到自动化页面点击新建，原有目标选择和创建表单仍可使用；新建窗口同样没有任务切换列表。关闭窗口不保存草稿。
5. 浅深主题均无残留空白列表区，保存、删除、取消可见，手机窗口可滚动。检查打开/保存不因删除控件增加请求，界面不触发自动运行。

清理：关闭测试页面；请求拦截场景不持久化数据，不删除真实任务、不手动执行真实通知任务。

## 2026-09-11 列表开关与详情精简

准备：4173 使用请求拦截的项目/会话虚构任务，包含长名称、暂停和已启用任务；1440×900、768×1024、375×812，浅深主题。

操作：列表用 switch 启停任务（含 Space 键），刷新确认；模拟 PUT 失败后重试。选中任务，点击详情中编辑左侧的“移除”，模拟 DELETE 失败后重试，并移除最后一项。

预期：列表无编辑按钮、状态文字和提示词预览；仅启用且有下次时间时显示计划时间。名称下仅保留目标，详情无任务类型副标题；长名称单行省略。开关提交保留账号、模型、保护和计划字段，等待期间禁用，失败保留旧状态并显示错误。移除失败保留任务，成功更新列表与侧栏，最后一项显示空态。键盘操作不触发行选择。详情保留编辑入口和运行历史。

验证：`node output/playwright/automation-ui-controls.cjs` 六组视口/主题通过；每组 4 次 PUT（含一次失败）和 3 次 DELETE（含一次失败），无重复提交、无 JS 错误。`pnpm run build:frontend` 通过。

性能：无新增轮询/监听器；每次成功写入后并行读取现有三份自动化数据，再将同份映射传给侧栏，侧栏不重复请求。列表仍为既有排序，移除提示词 DOM 减少渲染量。未测量真实调度延迟。

清理/回滚：请求拦截不写入真实任务；关闭验证页，回退本次代码提交恢复旧 UI。

## 2026-09-11 启停后保持当前位置

准备：两个任务，A 启用且较早创建，B 暂停且较晚创建，首次加载 A 在前；沿用上述六组视口/主题。

操作：关闭/开启 A，开启 B，再刷新页面；随后暂停 B。

预期：每次启停成功仅更新状态、统计和下次时间，不即时移动行。刷新后重新按启用优先及原有时间规则排序，B 移到 A 上方；再暂停 B 时保持该位置。点击工具栏刷新也重新排序。详情选中项和开关目标仍匹配原 ID。

性能：加载时保存一份 rowKey→位置 Map，切换后刷新数据沿用该顺序；额外空间 O(n)，排序仍 O(n log n)，无新增请求、计时器或监听器。

清理/回滚：关闭虚构任务验证页；回退排序提交即可恢复立即排序，不修改服务端任务。

## 移除二次确认与细分通知（0.2.19 补充）

- 准备：隔离实例内分别有会话自动化、普通项目和仅名称项目自动化；浅深主题。
- 操作：在自动化详情及编辑弹窗点击移除；确认框显示任务名，默认焦点在取消。取消、Esc 或关闭均不发送 DELETE。
- 操作：再次移除并确认，暂缓 DELETE 返回；按钮忙碌禁用，重复点击不重复提交。失败保留任务和确认框，可取消或明确重试；成功才关闭并显示“自动化任务已移除”。
- 操作：移除成功后令列表刷新失败。预期：保留真实移除成功结果，刷新错误单独显示，不能把已移除任务报成移除失败。项目编辑保存/删除以写入回执直接更新本地映射，不依赖后续列表查询判断写入成功。
- 操作：启用/暂停任务，分别显示“自动化任务已启用”“自动化任务已暂停”；新建/保存、手动运行仍使用各自通知。
- 检查：明暗主题与窄屏确认框可见、焦点限制和取消恢复正常。
- 清理：释放受控请求，移除测试任务；生产调度、账号、出口及运行任务不作为故障注入目标。

### 普通项目移除联动确认

- 准备：普通项目带有自动化任务；另有仅名称项目带有任务。
- 操作：普通项目菜单选择移除，确认框明确包含项目及自动化；取消/Esc 后项目、任务均保留，无 DELETE。确认后沿用原来的移除流程，只提交一次删除请求。
- 预期：删除回执成功但列表刷新失败时，成功通知保留，刷新问题单独显示；仅名称项目移除继续保留任务和会话，不触发普通项目的联动删除。
- 清理：仅使用隔离请求桩或测试项目；不移除实际工作项目。
