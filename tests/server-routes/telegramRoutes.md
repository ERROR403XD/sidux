2026-10-09 006 03E Telegram route contract

Feature/change name:
- 03E Telegram bridge HTTP route migration

Prerequisites/setup:
- Use an isolated test CODEX_HOME and Telegram config.
- Stub or use a disposable bot token; do not copy production credentials.

Actions:
1. Read config/status before and after legacy config migration.
2. Save bot credentials with and without `notificationsEnabled`.
3. Save quiet-hour preferences with valid and invalid values.
4. Send a disabled and enabled test notification.
5. Trigger a Telegram chat event and verify saved chat IDs are preserved by credential updates.

Expected results:
- Credential updates preserve existing explicit notification state and chat IDs when older clients omit them.
- Quiet-hour validation returns 400 without replacing valid persisted settings.
- Disabled tests return the language-specific 400 message and do not call the bridge.
- Enabled tests send only to deduplicated allowed/chat IDs, max 50.
- Config/status responses match the previous payload shapes and runtime startup/configure calls.

Rollback/cleanup:
- Revert the Telegram route/config-store commits and restart the isolated test app.
- Remove the disposable telegram config file.


## 0.2.22-dev.8 离线审核补充

前置：仅使用任务新建随机目录；`telegram-offline.cjs`的fetch和原生RPC均为内存函数，不配置真实机器人。

操作：运行`node docs/baseline/022/dev8-review-20261020/telegram-offline.cjs`，依次核对停止后的迟到更新、同对象stop/start、并发/顺序完成事件、两个已完成回合的迟到完成关联、回执丢失及明确格式拒绝、轮询HTTP/API错误、名单和静默队列重开。正确合同是停止后不再副作用、只保留一个轮询/订阅、每回合一次、正文与turnId匹配、不重发未知送达，明确失败可见并退避。dev.8当前8条断言失败，记录R42–R46；保持exit1。

再运行`node docs/baseline/022/dev8-review-20261020/notification-routes-offline.cjs`，预期14条配置/gateway/route及SSE合同通过。该结果不证明真实外部送达、HTTP、浏览器或OS进程重启。

清理：脚本关闭自有内存轮询/队列、销毁自有事件发射器并删除随机目录。不得读取或删除真实全局Telegram配置；手工端到端验收另使用独立CODEX_HOME。
