### Thread history in-flight state across account switches

#### Feature/Change Name
Thread history request in-flight tracking is centralized and account-aware.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. At least two accounts configured
3. Browser dev tools Network panel open

#### Steps
1. Open a conversation and delay its history response
2. Trigger concurrent history refreshes for that conversation
3. Switch from account A to account B
4. Let the account-A response or failure finish
5. Wait for account B's history response
6. 再次切回账号A，分别释放第一次A与B的旧成功/失败响应。

#### Expected Results
- Concurrent history refreshes for one thread reuse one request
- Different threads still issue separate requests
- A late account-A history result or failure does not write to account B
- Account B reloads the selected history and clears loading state
- Joined reads that retry after an identity change capture account B's identity and history revision before the new request; they do not reuse account A's closure snapshot.
- A late account-A completion does not clear account B's loading indicator.
- A→B→A uses monotonically changing identity revisions; the original A response cannot become current again merely because the account name matches.

#### 停止与重新读取回归
1. 延迟会话首页响应，并触发同会话的第二次读取。
2. 停止会话轮询（例如账号切换流程中的停止），随后重新读取同一会话。
3. 先释放旧响应，分别验证成功与失败；再释放新响应。
4. 对“加载更早消息”重复此操作，并分别测试停止和账号切换。

预期：新生命周期立即使用新请求；旧首页响应、错误和加入旧请求的 caller 均不能重新写消息、清除新 loading 或触发重读。旧分页返回也不能清除新分页的 loading；账号切换后可立即发起新分页。停止仅隔离 UI 接收，不取消服务端已接受的发送。

#### Rollback/Cleanup
- None

---
