### Integrated terminal manager edge cases

#### Feature/Change Name
Automated unit coverage for terminal manager edge cases that do not require a browser or real shell.

#### Prerequisites/Setup
1. Dependencies installed with `pnpm install`

#### Steps
1. Run `pnpm run test:unit`
2. Optionally run the focused tests with `pnpm exec vitest run src/server/terminalManager.test.ts src/server/routes/terminalRoutes.test.ts`

#### Expected Results
- Missing thread ids are rejected before spawning a PTY
- Invalid cwd falls back to home and then process cwd
- Initial and resize dimensions are clamped
- PTY env normalizes `TERM`, locale, and strips `TERMINFO` variables
- Output snapshots truncate to the last 16 KiB and set `truncated`
- Existing session reattach emits init/attached events and safely syncs changed cwd
- `New` adds a new tab without killing the previous session, and close/exit removes snapshots for the active session
- Terminal HTTP routes preserve status, quick-command, attach, input, resize, close and snapshot status codes without starting a browser
- Unavailable PTY mutations return 503, and missing `cwd`, `threadId`, or `sessionId` return 400

#### Rollback/Cleanup
- None

---
