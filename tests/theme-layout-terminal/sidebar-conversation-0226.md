### 0.2.22 侧边栏与会话拆分回归

#### Feature/Change Name
Sidebar thread/projection/menu decomposition and conversation scroll/command/file-change projection.

#### Prerequisites/Setup
1. Build the current candidate and serve it from isolated `59001`; never use production `5900`.
2. Use threads that cover pinned rows, project rows, chronological rows, chats, unread/in-progress/interrupted status, automation/goal/quota chips, worktree chips, long titles, and a project with/without a git repo.
3. Use an existing long conversation with command output, file changes, markdown/image content, and an older-history page; record current UI language and theme.

#### Steps
1. In project view, check fixed, project, and Chats thread rows in both orders. Confirm selection, status dot, delete-confirm flow, hover menu, context menu, automation/goal/quota/worktree chips, relative time, and long-title truncation.
2. Search by title and message, switch unread/active/interrupted filters, refresh while a filtered thread is selected, and confirm retained selection, loading/empty states, and server match order.
3. Open each project menu action that is safe in the test workspace: browse, export, automation editor, rename dialog, new worktree only where intended, and new thread. Cancel/destructive-confirm paths must stop at the confirmation dialog.
4. Repeat sidebar checks at 1440×1000, 768×1024, and 375×812 in light/dark themes and Chinese/English labels.
5. In a long conversation, scroll upward and load earlier messages; confirm the viewport anchor stays stable and repeated loading does not reset position. While scrolled up, stream or append output and confirm no bottom follow; press jump-to-latest and confirm it resumes following.
6. Stay at the bottom, append incremental output and load an image; confirm bottom following remains stable without repeated full-list flashing.
7. Inspect consecutive command rows and grouped commands. Expand/collapse one row and the whole group, leave one running, confirm auto-expand plus manual collapse, output text, status/exit labels, and compact runtime styling.
8. Inspect metadata file changes anchored to the same assistant turn and standalone changes. Confirm hidden source rows, aggregate counts/diffs, duplicate-path merge, file links, diff viewer, undo/redo controls where safe, and copy/fork actions.
9. Exercise tool output, markdown/file links, pending approval, keyboard focus, and IME composition in the affected conversation surfaces.

#### Expected Results
- A cold home route does not request the `ThreadConversation` feature chunk; a cold thread route does.
- Sidebar row DOM, menu trigger targets, ref positioning, drag/drop behavior, project ordering, and action timing remain equivalent to the pre-split UI.
- Projection changes do not add thread-list/status/model/git requests or duplicate listeners.
- Conversation scroll, render-window behavior, command grouping, and file-change summaries are unchanged for the same message sequence.
- Light/dark themes, Chinese/English text, and all three viewports remain readable and interactive.

#### Rollback/Cleanup
- Remove test-only automations/worktrees/projects created for menu validation.
- Restore the original UI language/theme and leave standard `59001` home/workspace volumes intact.
