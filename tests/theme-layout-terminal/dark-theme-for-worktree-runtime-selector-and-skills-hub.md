### Feature: Dark theme for worktree runtime selector and Skills Hub

#### Prerequisites
- App is running from this repository.
- Appearance is set to `Dark` in Settings.
- Skills Hub route is accessible.

#### Steps
1. Open the home/new-thread screen and inspect the `Local project / New worktree` runtime radio buttons.
2. Select `New worktree`, verify its radio selected state, and inspect the Base branch field and its searchable menu in dark mode.
3. Trigger a worktree action that shows worktree status and verify running/error status blocks remain readable in dark mode.
4. Open `Skills Hub` and verify header/subtitle, search bar, search/sort buttons, sync panel, badges, and status text.
5. Verify at least one skill card surface (title, owner, description, date, browse icon) in dark mode.
6. Open a skill detail modal and verify panel, title/owner, close button, README/body text, and footer actions in dark mode.

#### Expected Results
- Runtime radio buttons, Base branch field, and its menu use dark backgrounds, borders, and readable text/icons.
- Worktree status blocks use dark-friendly contrast for both running and error states.
- Skills Hub controls and sync panel are fully dark-themed with consistent hover/active states.
- Skill cards and the skill detail modal render with dark theme colors and accessible contrast.

#### Rollback/Cleanup
- Reset appearance to the previous user preference.

### dev.8 审核结果

第二十八批三尺寸浅深实际UI确认：runtime按钮与错误状态表面有深色样式，但Base branch启用按钮仍白底、灰字（2.623:1），见R63。选中alpha时搜索菜单仅80.59px宽，长分支选项132px高；选中长标签后同菜单300.05px、选项32px高，见R64。对照未修改CSS。证据和18张视觉截图在`docs/baseline/022/dev8-review-20261020/results/worktree-visual-ui.json`；当前保留失败，未修复产品。
