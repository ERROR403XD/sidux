### Attachment-only new threads get a title and stay listed

#### Feature/Change Name
New threads created by sending only an image or a text file (no typed text) get an attachment-derived title and are no longer omitted from the sidebar thread list.

Root cause: the app-server stores `first_user_message` from the turn text and omits threads with an empty first user message from `thread/list`; attachment-only sends previously produced an empty text item. The client also skipped title generation/fallback for empty prompts, so nothing overrode the missing title.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Light theme and dark theme are both available
3. A local image and a small text file available for upload

#### Steps
1. Create a new conversation, attach an image only, and send it with no typed text
2. Confirm the sidebar shows the new thread titled `[Image]`
3. Create a second conversation, attach a text file only, and send it with no typed text
4. Confirm the sidebar shows the thread titled with the file name (for example `notes.txt`)
5. Reload the page and confirm both threads remain listed with the same titles
6. Open each thread and confirm the attachments render and the turn completes normally
7. Repeat steps 1–2 in dark theme

#### Expected Results
- Attachment-only threads appear in the sidebar immediately and after reloads
- The stored first user message is non-empty (`[Image]` / `[Attachment]` placeholder plus the existing files scaffold), so the app-server lists the thread
- The client title cache persists the attachment-derived label (`persistThreadTitle`), overriding the raw scaffold title everywhere
- Conversations with typed text are unchanged: title generation still summarizes the typed prompt

#### Rollback/Cleanup
- Delete the test threads; revert `src/api/codexGateway.ts` (turn placeholder), `src/composables/useDesktopState.ts` (title fallback), and `src/server/codexAppServerBridge.ts` (queued-turn placeholder)
