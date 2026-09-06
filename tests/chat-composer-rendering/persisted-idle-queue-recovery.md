### Persisted idle queue recovery

#### Feature/Change Name
Queued messages in the queued state are drained for idle threads even if the original `turn/completed` notification was missed or the server starts with persisted queue state already present.

0.2.3 的不明结果、编辑和故障恢复以 [可靠发送与结果核对](reliable-message-delivery.md) 为准；unknown 不自动重试。

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. A thread exists with queued messages persisted in `/codex-api/thread-queue-state`
3. The thread's latest turn is completed/idle
4. Light theme and dark theme are both available

#### Steps
1. In light theme, open the thread with persisted queued rows
2. Confirm the queued rows are visible above the composer
3. Wait for backend queue recovery to start the first queued message
4. Confirm the first queued row is removed and a new turn starts
5. Wait for the queued turn to complete
6. Confirm the next queued row starts automatically
7. Repeat until `/codex-api/thread-queue-state` no longer includes the thread
8. Refresh the thread and confirm all queued messages completed in order
9. Switch to dark theme and confirm the completed conversation and empty queue state remain readable

#### Expected Results
- Idle persisted queues recover without requiring a new manual message
- Queued messages do not start while the thread has an in-progress turn
- Multiple queued messages drain one at a time and complete in order
- The queue panel disappears after the final message receives a confirmed turn ID; sending/unknown entries remain visible
- The recovered turns and empty queue state are visible in both light theme and dark theme

#### Rollback/Cleanup
- Delete any remaining queued test rows or let recovery drain them
- Remove temporary test projects/threads if they are no longer needed

---
