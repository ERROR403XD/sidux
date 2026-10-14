# Account quota stale timestamp

## 0.2.21-dev.3: suppress long-lived quota failure text

### Prerequisites

- Isolated 59001 instance with at least one imported account that already has a successful quota snapshot and timestamp.
- Make the account quota refresh fail continuously without changing the credential, for example with a local sample upstream or controlled network failure.

### Steps

1. Expand Settings → Accounts and find the account's `Updated at` line.
2. Trigger the first quota refresh failure.
3. Keep refresh failing for less than 10 minutes and inspect the account card.
4. Keep refresh failing for at least 10 minutes and inspect the account card again.
5. Restore quota access and refresh successfully.

### Expected Results

- The account card no longer renders a long-lived red quota failure message.
- Before 10 minutes, the timestamp keeps the last successful refresh time and remains normal-colored.
- After 10 continuous failure minutes, only the timestamp line becomes red; the existing quota snapshot remains readable.
- After a successful refresh, the timestamp advances and returns to normal color.

### Rollback / Cleanup

- Stop the controlled failure and refresh the account.
- Remove the sample account or restore the isolated test state; do not reset the persistent 59001 volumes.
