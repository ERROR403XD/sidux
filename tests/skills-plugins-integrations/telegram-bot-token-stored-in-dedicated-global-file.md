### Feature: Telegram bot token stored in dedicated global file

#### Prerequisites
- App server is running from this repository.
- A valid Telegram bot token is available.
- At least one Telegram user ID is available for allowlisting.
- Access to `~/.codex/` on the host machine.

#### Steps
1. In the app UI, open Telegram connection and submit a bot token plus one or more allowed Telegram user IDs.
2. Verify file `~/.codex/telegram-bridge.json` exists.
3. Open `~/.codex/telegram-bridge.json` and confirm it contains `botToken` and `allowedUserIds` fields.
4. Restart the app server and call Telegram status endpoint from UI to confirm it still reports configured.

#### Expected Results
- Telegram token is persisted in `~/.codex/telegram-bridge.json`.
- Telegram allowlisted user IDs are persisted in `~/.codex/telegram-bridge.json`.
- Telegram bridge remains configured after restart.

#### Rollback/Cleanup
- Remove `~/.codex/telegram-bridge.json` to clear saved Telegram token.


### 0.2.22-dev.8 审核边界

上述手工步骤只适用于专门创建的独立CODEX_HOME。文中的全局配置路径在测试时必须替换为该测试home内路径；清理只处理本次创建的文件，不删除真实`~/.codex/telegram-bridge.json`。本轮新增离线证据见`tests/server-routes/telegramRoutes.md`，没有使用真实机器人或发送外部消息。
