# Feature: Ancillary goal and status read degradation

#### Prerequisites
- Use the isolated 59001 service or an isolated 4173 instance with fixture conversations; do not use production accounts or threads.
- Prepare one visible sidebar conversation with a known goal and one known interrupted conversation. Add browser route interception for `/codex-api/thread-goals` and `/codex-api/sidebar-thread-status`.
- Check light and dark themes at 1440×1000 and 375×812.

#### Steps
1. Make one individual native goal read fail while another succeeds, then refresh the sidebar and selected conversation.
2. Make the whole `/codex-api/thread-goals` request return HTTP 503 twice, then restore it.
3. Make one `/codex-api/sidebar-thread-status` result return `null` while another returns a known boolean, then refresh the interrupted filter.
4. Make the whole status request return HTTP 503 twice, then restore it.

#### Expected Results
- An individual failed goal read does not fail the rest of the batch; cached or already displayed goals remain unchanged.
- A whole goal-request outage preserves the last known goal and shows one warning toast for that outage, not a persistent red error. The next successful read clears the toast state.
- An unknown individual conversation status preserves its previous interrupted/not-interrupted value instead of dropping the row.
- A whole status-request outage preserves known rows and shows one warning toast for that outage; repeated failures in the same outage do not stack notifications.
- No new polling or RPC is introduced; recovery still uses the existing focus, ready, notification, and filter refresh paths.

#### Rollback/Cleanup
- Remove route interception and fixture conversations/threads only. Do not clear standard 59001 volumes, accounts, sessions, or real workspaces.
