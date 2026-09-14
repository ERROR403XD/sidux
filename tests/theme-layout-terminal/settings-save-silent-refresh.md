### Settings save refreshes silently without shifting the page

#### Feature/Change Name
Saving configuration in Settings must not move the page under the pointer. Two concrete causes were removed: saving an existing custom connection moved that row to the bottom of the list, and every save re-ran the thread/conversation refresh (`loadThreads` + `messages`) even though the settings change did not affect threads.

#### Prerequisites/Setup
1. Start a disposable dev server: `pnpm run dev --host 127.0.0.1 --port 4173` (isolated `CODEX_HOME`, never production).
2. Configure at least two custom connections so the list has a visible order, and keep one OpenAI/Codex account for the account sections below the connection list.
3. Open `http://127.0.0.1:4173/#/settings` at 1440x900 and scroll so the custom connection list and the sections below it (定时激活/账号) are visible.
4. Open DevTools and run `new PerformanceObserver(l => console.log(l.getEntries().map(e => e.value))).observe({ type: 'layout-shift', buffered: true })`, then scroll the settings page again and note `scrollTop`.

#### Steps
1. With the page scrolled, open 账号设置 on the **first** custom connection, change only the 别名, run 测试连接, then click 确定.
2. Observe the connection list and the sections below it during and after the save.
3. Record `scrollTop` and the first visible row position immediately after the save, then again after 5 seconds.
4. Repeat with 添加账号 (a brand-new connection) and confirm the new card appears as new content below the existing rows.
5. In the DevTools Network panel, confirm the save does not trigger `POST /codex-api/rpc` for thread listing or `GET /codex-api/thread-titles`.
6. Switch the active connection with 切换至此账号 and confirm the conversation/model state still follows the new active connection.
7. Repeat steps 1-4 in dark theme, and at 375x812 to confirm the same behavior on a narrow viewport.

#### Expected Results
- Editing an existing connection keeps its list position; no other row jumps, and the sections below do not reflow (measured CLS for the edit-save path is ~0, previously ~0.05).
- `scrollTop` and the first visible row's position are unchanged before and after the save.
- Adding a brand-new connection is the only case that inserts a row; that growth is the intended new content.
- Saving does not re-request the thread list or selected thread messages; only model/provider state (`config/read`, provider models) and the existing ancillary refreshes run.
- Switching the active connection still invalidates the model catalog and refreshes the conversation, so the composer tracks the new connection.
- No flash of an empty list, skeleton, or scroll reset in light or dark theme, desktop or mobile width.

#### Rollback/Cleanup
- Remove the probe connections created during the test, then restore the original active connection.
- Stop the disposable `4173` dev server if it was started only for this test; never stop the tmux `5173` server or production `5900`.
