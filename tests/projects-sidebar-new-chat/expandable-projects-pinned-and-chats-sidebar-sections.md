### Expandable Projects, Pinned, and Chats sidebar sections

#### Feature/Change Name
The sidebar labels the grouped thread area as `Projects`, makes `Projects`, `Pinned`, and `Chats` independently expandable, and places `Chats` after `Projects` in the same scrollable sidebar area.

#### Prerequisites/Setup
1. Dev server running at `http://127.0.0.1:5174` or the active Vite dev URL
2. At least one existing thread is available in the sidebar
3. At least one pinned thread exists to verify the `Pinned` section
4. Light theme and dark theme are available from the appearance switcher

#### Steps
1. In light theme, open the app with the sidebar expanded
2. Verify the grouped thread header reads `Projects` instead of `Threads`
3. Verify `Pinned`, `Projects`, and `Chats` each show a chevron when present
4. Collapse and expand `Pinned`, confirming pinned rows hide and return
5. Collapse and expand `Projects`, confirming project groups hide and return
6. Confirm `Chats` appears after `Projects` and scrolls with the same sidebar content, not as a fixed bottom shelf
7. Collapse and expand `Chats`, confirming recent chat rows hide and return
8. Click the `Chats` filter icon and verify the existing sidebar search field opens and the filter button shows active state
9. Click the `Chats` compose icon and verify the app navigates to the new-chat/home composer
10. Open the Projects organize menu, enable `Chats first`, and verify `Chats` moves above `Projects`
11. In the same menu, switch `Sort by` between `Created` and `Updated`, then verify the active checkmark moves and the chat rows reorder by the selected timestamp
12. Refresh the page and verify `Chats first` and the selected sort mode persist
13. Switch to dark theme and repeat the visibility checks for section headers, chevrons, active filter state, sort menu state, and row text

#### Expected Results
- The sidebar uses `Projects` for the grouped project/thread area
- `Pinned`, `Projects`, and `Chats` expansion state changes immediately and persists across reload
- `Chats` is appended after `Projects` in the same scroll space
- `Chats first` moves the `Chats` section before `Projects` and persists across reload
- `Created` and `Updated` sort options update only the `Chats` ordering and persist across reload
- The filter icon toggles the sidebar search without losing the `Chats` section
- The compose icon starts a new chat using the existing new-thread flow
- Light theme and dark theme both keep section headers, controls, and rows readable

#### Rollback/Cleanup
- Clear the sidebar search query if the filter step left it open

---

### 项目树全部展开 / 折叠（0.2.19 补充）

**准备：** 使用隔离实例，准备普通/仅名称项目、空项目、至少 12 条会话的项目，以及置顶和无项目会话。

**操作与预期：**
1. 项目标题的三个点右侧显示双箭头按钮；标题与项目行的三个点中心对齐。明暗主题、1440×1000、768×1024、375×812 下均可点击。
2. 项目部分展开时点击“折叠全部项目”：保留每个项目标题，所有会话、“没有会话”和“显示更多”收起；置顶/无项目区不变。刷新后项目仍收起。
3. 点击“展开全部项目”：普通/仅名称项目都打开，超过 10 条的已加载会话也显示；没有额外发送或调度请求。
4. 单独折叠一个项目后点击总按钮，应统一收起；项目大区关闭时点击总按钮，应打开大区及项目。Enter/空格只触发一次，不误触大区开关或菜单。
5. 悬停项目三个点、项目新建会话按钮及会话删除按钮，背景和前景在浅深主题均明显区别于所在行；键盘焦点可见，删除确认仍保持红色两步确认。
6. 搜索中按钮禁用以保留匹配结果；按时间顺序模式不显示树按钮；无项目时禁用。清除搜索/切回项目视图后恢复。

**清理/回退：** 删除测试项目与合成会话；需要还原显示时用原有项目/大区开关。按钮只变更浏览器折叠和显示更多状态，不改变服务端数据。
