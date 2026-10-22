### Feature: CLI no longer requires codex login on startup

#### Prerequisites
- Use an empty disposable `CODEX_HOME`; do not remove or reuse the user's real `~/.codex/auth.json`.

#### Steps
1. Run `npx codexui` or `pnpm run dev`.
2. Verify the CLI does not inspect authentication, print a login command, block, or prompt for login.
3. Verify the server starts and the web UI loads successfully.
4. Use the Provider dropdown in settings to select OpenRouter and start chatting without a Codex account.

#### Expected Results
- CLI does not run `codex login` on startup.
- The UI account panel shows the empty state and provides the explicit **Add account** action.
- The app is fully usable without a Codex account when using OpenRouter or custom providers.

#### Rollback/Cleanup
- Stop the disposable instance and remove only its temporary `CODEX_HOME` if cleanup is required.

---
