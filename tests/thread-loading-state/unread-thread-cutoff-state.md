### Unread thread cutoff state

#### Feature/Change Name
Unread thread state uses a local cutoff timestamp so existing threads are not all marked unread after first load.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`).
2. Browser localStorage is available for the app origin.
3. At least two existing threads are present.
4. Light theme and dark theme are available from the appearance switcher.

#### Steps
1. Clear only `codex-web-local.thread-unread-cutoff.v1` from localStorage for the app origin.
2. Load the app in light theme.
3. Confirm existing threads are not all marked unread on first load.
4. Create or receive an update in a different thread after the app has loaded.
5. Confirm that updated thread can show unread when it is not selected or in progress.
6. Create or receive an update in a second unselected thread.
7. Open the first updated thread and confirm only that thread's unread indicator clears.
8. Confirm the second updated thread remains unread until it is opened.
9. Switch to dark theme and repeat steps 4 through 8.

#### Expected Results
- Missing cutoff state initializes to the current time instead of treating every thread as unread.
- Threads updated after the cutoff can still become unread.
- Opening a thread updates only that thread's read state and clears only that thread's unread indicator.
- Unread indicators remain readable in both light theme and dark theme.

#### Rollback/Cleanup
- Remove any disposable test threads created for this validation.

---
### 0.2.22 R6：已读确认失败重试

前提：隔离候选，可让已读 POST 一次返回 503 或网络错误。

操作：打开有完成标记的会话，首次确认失败后再次打开/确认；恢复网络并重复。确认等待期间切换账号或停止、恢复轮询。

预期：失败不加入成功去重集合，下次用户操作可重试；成功后不重复发送。旧代次迟到响应不能清理当前未读标记或阻止新确认。

清理：恢复网络，关闭故障注入和测试页面。
