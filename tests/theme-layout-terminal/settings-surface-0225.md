### 0.2.22 设置页装配拆分回归

#### Feature/Change Name
Settings route decomposition for Telegram, runtime capabilities, input, appearance, and general preferences.

#### Prerequisites/Setup
1. Build the current candidate and serve it from the isolated `59001` test instance; do not use production `5900`.
2. Use a synthetic Telegram bot token and allowlist; never copy production credentials into the test instance.
3. Record the original UI language, theme, chat width, display timezone, input preferences, and model defaults before testing.

#### Steps
1. Open `#/settings`. Switch UI language between English and Chinese, refresh, and reopen Settings; confirm labels, help text, and the selected language persist.
2. Change display timezone to `UTC` and back to the original value. Confirm dates update immediately, refresh persists, and activation/Telegram timezone saves do not leave the timezone control stuck in loading.
3. Toggle the theme among system, light, and dark. Confirm the sidebar cycle button and Settings selection agree, the root theme and theme-color meta update, and the choice persists after refresh.
4. Switch chat width among Standard, Wide, and Extra wide; confirm the conversation column changes and the preference persists after refresh.
5. Toggle `Require ⌘ + enter to send`, click-to-toggle dictation, auto-send dictation, and select auto-detect plus one language. Confirm both the home composer and an existing-thread composer honor the shared preferences after refresh.
6. Save a synthetic Telegram configuration and quiet hours; confirm the save/test state clears correctly and the normalized allowlist remains after reload. Remove or disable the synthetic bot afterward.
7. Open runtime capabilities, click re-detect, and confirm CLI/app versions, history paging, schema hash, generated time, and errors use the same shared snapshot as the account popover.
8. Save model defaults with “remember per conversation” both enabled and disabled; confirm errors, effective fallback text, and persistence behave as before.
9. Repeat the visual pass in light and dark themes at 1440×900, 768×1024, and 375×812. Exercise route changes among home, thread, settings, API Proxy, and Automations.
10. From a fresh production build and cleared browser cache, load `#/` first and inspect network resources: the Settings route chunk must not be requested on the home route. Enter `#/settings`, confirm exactly one Settings route chunk request, then immediately return to `#/`; the Settings surface must unmount and the home hero/composer must render without a blank route or stale Settings form.

#### Expected Results
- Every Settings section renders from its new component without duplicate forms or stale labels.
- Preferences remain shared with composers, the sidebar, and the account popover after component unmount and refresh.
- Telegram and timezone operations make only the existing configured requests and do not trigger thread-list or message reloads.
- No control becomes stuck disabled, no toast duplicates persist, and route changes preserve Settings scroll and drafts where behavior existed before.
- Light and dark themes, Chinese and English labels, and all three required viewport widths remain readable.
- The home initial resource set excludes the Settings route chunk; Settings first entry owns its one lazy request, and the route round-trip does not issue duplicate Settings requests.

#### Rollback/Cleanup
- Restore the original language, theme, chat width, timezone, input preferences, and model defaults.
- Disable or remove the synthetic Telegram configuration and quiet hours.
- Keep the standard `59001` home/workspace volumes; do not clear test accounts or sessions.
### 0.2.22 R2/Q08：听写偏好启动与刷新

前提：隔离浏览器配置；记录原听写语言。浅色、深色主题各检查一次。

操作：设置“输入与发送”的听写语言为 Chinese (zh)，刷新首页和设置页；改为 English (en) 后重复，再恢复 auto。仅在临时浏览器上下文中注入损坏值，重新打开页面。自动复核运行 `node scripts/verify-022-preference-startup.cjs`：在独立上下文分别冷启动 auto/zh/en、损坏值、constructor 和仅该偏好存储读取抛错的场景，进入实际设置页后离开并重新进入。

预期：各语言均可挂载应用，刷新后选择仍保留；未知语言回到 auto。同一页面重复使用偏好模块不重读或重置共享状态；输入偏好模块的存储不可用时返回默认值。冷启动和设置重挂载合计读取该持久 key 一次，无页面异常；自动结果保存在 `output/playwright/022-interactions/preferences/report.json`。

清理：恢复原听写语言，关闭临时浏览器上下文。
