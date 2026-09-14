### Pending new conversation rebinds to the active connection

#### Feature/Change Name
After switching from an OpenAI/Codex account to a custom/openrouter connection, a brand-new conversation without a manual model change should send through the current connection instead of rejecting with "保存的模型属于其他来源，请重新选择模型。" / "The saved model belongs to another source."

#### Prerequisites/Setup
1. Start the dev server on a disposable port: `pnpm run dev --host 127.0.0.1 --port 4173`.
2. Have one OpenAI/Codex account connection available.
3. Have at least one custom endpoint or OpenRouter connection configured with its own models.

#### Steps
1. In the composer, confirm the provider is the OpenAI/Codex connection and the model menu lists Codex models. Pick any model.
2. Do not create a thread yet; leave the composer on the pending new conversation.
3. Open Settings and switch the connection/provider to the custom endpoint (or OpenRouter).
4. Close Settings and reopen the model menu on the pending new conversation.
5. Confirm the menu lists only the custom/provider models and the composer shows one of them as selected.
6. Send a message such as `hi` and confirm the request goes through the new provider and the assistant reply appears.
7. Switch back to the OpenAI/Codex connection, then send another message in a brand-new conversation and confirm it uses Codex models.
8. Open an existing thread created earlier under the previous provider and confirm its model and provider are unchanged.
9. Repeat the switch on a fresh page reload (switch provider first, then open the model menu) and confirm the pending conversation still tracks the active connection.
10. Repeat steps 1-6 in dark theme.

#### Expected Results
- A pending new conversation without an explicit model choice follows the active connection; no "模型属于其他来源" / "belongs to another source" error appears.
- The model menu and selected model match the active connection only; no stale models from the previous connection remain.
- Saved per-conversation model choices for existing threads are preserved and not rewritten when the connection changes.
- The saved default model preference stays intact, so switching back re-applies the user's earlier selection.
- Light and dark themes keep the model menu readable.

#### Rollback/Cleanup
- Stop the disposable `4173` dev server if it was started only for this test.
- Restore the preferred connection/provider in Settings if it was changed during testing.
