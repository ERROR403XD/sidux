### Backend-persisted queued messages and drag reorder

#### Feature/Change Name
Queued messages are saved through the backend, survive page refresh, and can be reordered by dragging a queued row before another queued row.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Open a thread where a turn is actively running
3. Queue at least three messages while the turn is running
4. Light theme and dark theme both available from the appearance switcher

#### Steps
1. In light theme, confirm each queued row has a drag handle at the start of the row
2. Refresh the page and reopen the same thread
3. Confirm all queued rows are still visible in the same order
4. Drag the third queued message onto the first queued message
5. Confirm the third message moves to the first position and the remaining queued messages keep their relative order
6. Refresh again and confirm the reordered queue order is preserved
7. Let the active turn finish and confirm the next sent queued message is the first reordered item
8. Queue at least two more messages, switch to dark theme, and repeat the drag reorder check

#### Expected Results
- Queued rows survive a page refresh because they are restored from backend state
- Dragging a queued row onto another queued row immediately reorders the queue
- The reordered queue order survives page refresh
- The reordered queue order controls which message sends next after the active turn finishes
- Edit, Steer, and Delete actions still operate on the correct queued row after reordering
- Drag handle, hover/drop target, and row text remain readable in both light theme and dark theme

#### Rollback/Cleanup
- Delete any queued test messages that should not be sent

---

### 0.1.90 封测收尾：按消息操作与账号刷新

前提：使用 59001 的内部测试线程，准备一个忙碌 turn；在两个页面打开同一测试项目。网络失败用请求拦截模拟，不修改真实认证。

1. A 页面添加消息 A；B 页面在旧视图上添加消息 B。两条都保留，两个页面会同步队列。
2. 刷新账号列表，再刷新页面。队列消息 ID、内容与顺序不变。
3. 后端取走 A 后，在旧视图上尝试排序/编辑 A。提示消息已发送或移除，不能重新入队 A。
4. 模拟队列 POST 返回失败。输入框保留草稿并显示错误，不能显示已成功排队；恢复网络后可重试。
5. 编辑排队消息，保存后仍排队并维持插入位置；只有点击“引导”立即发送。取消/编辑必须等服务器确认移除成功。
6. 对旧 PUT 接口提交整份快照，应返回 409 并要求刷新，现有服务器队列不变。

清理：取消剩余测试消息、结束内部 turn；关闭额外页面与请求拦截。不要清空整个 CODEX_HOME 或队列状态文件。

保存、取消、编辑、排序或引导因网络/过期 ID 失败时，错误必须直接显示在该会话输入区上方；不要只在设置中显示。保存失败的原输入保留，继续编辑不被旧请求的完成回调清空；成功重试清除错误，切换会话不带入其他会话的错误。浅/深主题均验证提示可读。
