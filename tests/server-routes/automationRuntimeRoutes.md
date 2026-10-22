2026-10-09 004 03E Automation runtime route contract

Feature/change name:
- 03E automation runtime HTTP route migration

Prerequisites/setup:
- Use an isolated test workspace and CODEX_HOME.
- Let the automation scheduler become ready and confirm it has no active or queued runs.

Actions:
1. Open the automation runtime panel and read scheduler state/history.
2. Trigger one paused and one active automation manually.
3. Toggle scheduler draining off and on.
4. Retry one completed run and inspect the request payloads/responses in DevTools.

Expected results:
- `GET /codex-api/runtime/activity` and `GET /codex-api/automation-runtime` return 200.
- `GET /codex-api/automation-runs` preserves automation ID, cursor and limit handling.
- Manual thread/project/retry endpoints preserve target compatibility and only tick the scheduler after accepted requests.
- `POST /automation/execute` retains invalid JSON, request validation and execute outcome status/body behavior.
- `POST /codex-api/automation-runtime/drain` defaults to draining enabled and persists the expected state.

Rollback/cleanup:
- Revert the automation runtime route migration commit and restart the isolated test app.
- Set draining back to false and wait for all triggered runs to finish; no data migration is required.
