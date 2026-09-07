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
# 0.2.10 自动化入口钟表图标

准备：打开当前候选，使用 1440×900 浅色和深色主题。

操作：检查左上侧栏“自动化”的图标，点击进入自动化页面，再检查页面标题旁图标。

预期：两处均为圆形表盘和时针/分针，保持原有颜色、尺寸和点击导航；技能入口仍保留原图标。图标无外部图片请求、无计时器或动画。

清理/回滚：无需清理数据；回退代码即可恢复旧图标，不修改自动化任务。
