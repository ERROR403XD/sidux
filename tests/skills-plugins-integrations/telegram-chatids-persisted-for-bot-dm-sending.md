### Feature: Telegram chatIds persisted for bot DM sending

#### Prerequisites
- App server is running from this repository.
- Telegram bot already configured in the app.
- Access to `~/.codex/telegram-bridge.json`.

#### Steps
1. Send `/start` to the Telegram bot from your DM.
2. Wait for the app to process the update, then open `~/.codex/telegram-bridge.json`.
3. Confirm `chatIds` contains your DM chat id as the first element.
4. In the app, reconnect Telegram bot with the same token.
5. Re-open `~/.codex/telegram-bridge.json` and confirm `chatIds` remains present.

#### Expected Results
- `chatIds` is written after Telegram DM activity.
- `chatIds` persists across bot reconfiguration.
- `botToken`, `chatIds`, and `allowedUserIds` are all present in `~/.codex/telegram-bridge.json`.

#### Rollback/Cleanup
- Remove `chatIds` or delete `~/.codex/telegram-bridge.json` to clear persisted chat targets.


### 0.2.22-dev.8 审核边界

上述手工步骤只适用于专门创建的独立CODEX_HOME。文中的全局配置路径在测试时必须替换为该测试home内路径；清理只处理本次创建的文件，不删除真实`~/.codex/telegram-bridge.json`。本轮新增离线证据见`tests/server-routes/telegramRoutes.md`，没有使用真实机器人或发送外部消息。
