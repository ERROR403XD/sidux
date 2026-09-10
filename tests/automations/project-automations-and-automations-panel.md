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
