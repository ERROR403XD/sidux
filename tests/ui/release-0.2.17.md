# 0.2.17 UI regression checks

Prerequisites: isolated runtime, synthetic conversations and automations, light/dark themes and Chinese/English UI.

1. Toggle an automation. Expect its enabled state to change while its row stays in place; refresh to apply enabled-first ordering. Long titles must truncate on one line. The detail header has Remove before Edit; no prompt preview or redundant task-type subtitle appears.
2. Complete a conversation while viewing it in a visible tab. Expect no completion dot. Repeat in a background conversation; expect a dot that clears when opened.
3. Send a unique text message with an image. Expect one rendered message and one image after the server echo and after refresh. Send identical content again deliberately; expect both distinct messages to remain.
4. Trigger an asynchronous question. Expect the unanswered card above the composer, with no duplicate historical card. Answer successfully; expect the dock to clear and the answer to remain in history.
5. Select system theme, then light and dark modes. Expect a monitor icon for system mode and readable controls in both explicit themes.
6. Save notification quiet hours and appearance preferences; reload and verify persistence. Use only synthetic branding and credentials.

Cleanup: remove synthetic tasks and conversations, restore preferences, and stop only the isolated test instance.
