### Thread-list first-page request state across account switches

#### Feature/Change Name
Thread-list first-page in-flight requests are deduplicated and invalidated on account switches.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. At least two accounts configured
3. Browser dev tools Network panel open

#### Steps
1. Open the app and delay the first `thread/list` response
2. Switch from account A to account B while the first request is pending
3. Let the account-A response or failure finish
4. Wait for account B's first-page response

#### Expected Results
- Concurrent first-page callers reuse one request
- Account switching immediately clears the old initial-list loading state
- A late account-A list result or failure does not populate account B or set a visible error
- Account B issues its own first-page request and finishes with loading cleared

#### 停止与重新刷新
1. 延迟首页列表响应，在等待期间停止轮询。
2. 先完成旧响应，分别验证成功与失败。
3. 再测试停止后立即触发强制刷新，让旧响应在新响应之前结束。
4. 验证workspace hydration结束后的提交也仍属于当前请求context。

预期：旧列表和错误不提交，旧整轮刷新不继续发起history或model读取；新刷新立即发请求，旧finally不清新loading。旧请求加入者遇到停止与账号切换时不自动跨停止重试。回归使用独立fixture，不改变用户会话或认证。

#### Rollback/Cleanup
- None

---
