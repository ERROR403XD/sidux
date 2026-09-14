### Existing conversation follows the live connection after the source changes elsewhere

#### Feature/Change Name
An existing conversation must stay usable when another browser changes the active connection. The single running app-server binds a resumed thread to the active connection, so a conversation saved under the previous source (OpenAI/Codex account, custom endpoint, or OpenRouter) has to run on the live source instead of failing with "保存的模型属于其他来源，请重新选择模型。".

#### Prerequisites/Setup
1. Start a disposable dev server: `pnpm run dev --host 127.0.0.1 --port 4173` (isolated `CODEX_HOME`, never production).
2. Two browser profiles (or two windows of the same profile) plus two different connections with their own model lists, for example an OpenAI/Codex account and a custom endpoint connection.

#### Steps
1. Browser 1: pick model A from connection 1 and finish one turn.
2. Browser 2: switch the active connection to connection 2, pick model B, and finish one turn.
3. Browser 1 (no reload): confirm the sidebar account area still shows the previous connection state; no error banner appears yet.
4. Browser 1: reload the page and open the same conversation.
5. Send another message without touching the model menu. Confirm the turn runs on the live connection (connection 2) and no "保存的模型属于其他来源" / "belongs to another source" error appears.
6. In the same conversation, open the model menu and pick model B, then send again. Confirm the turn is accepted.
7. Wait for a scheduled refresh (at least one refresh cycle) and send once more. Confirm the conversation still uses the live source.
8. Switch the active connection back to connection 1 in browser 2, reload browser 1, and confirm the conversation moves back to connection 1's models without the error.
9. Open Settings and confirm the connection list still shows the conversation's saved source untouched until the user picks a model explicitly.
10. Repeat steps 1-6 in dark theme.

#### Expected Results
- After the active connection changes elsewhere, a reloaded conversation continues on the live connection (model A is re-mapped to the live catalog, or model B when the user picks it); the dead-end cross-source error no longer appears.
- The saved per-conversation choice stays as this conversation's own intent instead of being silently overwritten by the rebind; an explicit model pick persists that pick.
- A later thread read that reports the source stored in the rollout cannot move the conversation back to a connection that is not running.
- The model menu only lists models of the live connection.
- Light and dark themes keep the composer and model menu readable.

#### Rollback/Cleanup
- Stop the disposable `4173` dev server if it was started only for this test.
- Restore the preferred active connection in Settings if it was changed during testing.
