### Backend-drained queue UI refresh

#### Feature/Change Name
The queue panel refreshes when the backend starts and drains persisted queued messages.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Open a `TestChat` thread
3. Queue at least three short messages while a turn is running
4. Light theme and dark theme both available from the appearance switcher

#### Steps
1. In light theme, confirm queued rows are visible above the composer
2. Let the backend drain each queued message
3. Confirm the queue panel removes each row as its queued turn starts
4. Confirm the queue panel disappears when the final queued message is submitted
5. Refresh the thread after all queued turns complete
6. Switch to dark theme and repeat the visibility check after queue drain

#### Expected Results
- Queued messages execute in order after the active turn completes
- The queue panel reflects backend queue state after `turn/started` and `turn/completed`
- No already-executed queued rows remain visible after the queue is empty
- Queue row text, actions, and composer spacing remain readable in both light theme and dark theme

#### Rollback/Cleanup
- Delete any remaining queued test messages or let the queue drain

---
### 0.2.22 Q04：停止后的队列写入完成隔离

前提：隔离候选，延迟一条队列编辑/删除响应，记录服务端消息 ID。

操作：提交操作后停止轮询或切换账号；让旧操作成功或失败。恢复轮询并读取当前队列，重复操作。检查已接受操作的服务端结果。

预期：旧完成不提交 UI、不移除当前消息、不显示成功/失败通知；恢复后重新读取持久队列。停止仅撤销 UI 接收，已接受的服务端 intent 保留；后续操作按原顺序执行。

清理：恢复网络延迟，取消自己留下的测试消息，关闭测试页面。
