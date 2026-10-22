### Feature: Telegram bridge rejects unauthorized senders

#### Prerequisites
- App server is running from this repository.
- Telegram bot is configured with a known `allowedUserIds` entry.
- One Telegram account is allowlisted and one separate Telegram account is not.

#### Steps
1. From the allowlisted Telegram account, send `/start` to the bot.
2. Confirm the bot responds normally.
3. From the non-allowlisted Telegram account, send `/start` to the same bot.
4. From the non-allowlisted account, send a normal text prompt.

#### Expected Results
- The allowlisted account can use the Telegram bridge normally.
- The non-allowlisted account receives an unauthorized response.
- No thread is created or updated for the non-allowlisted account.

#### Rollback/Cleanup
- Remove test chat mappings from `~/.codex/telegram-bridge.json` if needed.


### 0.2.22-dev.8 审核边界

上述手工步骤只适用于专门创建的独立CODEX_HOME。文中的全局配置路径在测试时必须替换为该测试home内路径；清理只处理本次创建的文件，不删除真实`~/.codex/telegram-bridge.json`。本轮新增离线证据见`tests/server-routes/telegramRoutes.md`，没有使用真实机器人或发送外部消息。
