2026-10-09 005 03E Free mode route contract

Feature/change name:
- 03E free mode HTTP route migration

Prerequisites/setup:
- Use an isolated test workspace and CODEX_HOME.
- Back up `webui-custom-providers.json` before testing custom keys/providers.
- Confirm no active turn, queued delivery, pending server request, or background terminal is running.

Actions:
1. Read free mode status.
2. Enable and disable OpenRouter free mode.
3. Set a custom OpenRouter key, then rotate back to a community key.
4. Switch to OpenCode Zen and a custom endpoint, including the missing-baseUrl error.
5. Repeat one mutation while a background terminal is active.

Expected results:
- Status returns masked custom keys only, auth presence, key count, models, provider, base URL, and wire mode without leaking raw keys.
- Idle provider switches preserve prior provider keys and wire mode, restart the app runtime, and keep state file mode `0600`.
- Missing custom `baseUrl` returns 400; other route failures retain the original 500 messages.
- A non-idle provider switch returns 409 and distinguishes the background-terminal message.
- Proxy/model-discovery behavior remains unchanged because only HTTP route composition moved.

Rollback/cleanup:
- Restore the backed-up `webui-custom-providers.json`.
- Revert the free mode route migration commit and restart the isolated test app.

### 0.2.22 R3：供应方操作释放

前提：隔离候选，保存测试供应方配置；使用测试运行时避免真实云调用。

操作：空闲时连续切换两次，再发送新消息；有后台终端时重复切换两次；停止后台活动后重试。注入静默状态读取失败后再次切换。

预期：成功、409、输入错误和异常均释放切换锁；后续切换和投递可继续，不残留“正在切换”。成功路径刷新后保留配置。

清理：关闭测试终端，恢复测试供应方配置；仅回退本轮代码，不迁移账号状态。
