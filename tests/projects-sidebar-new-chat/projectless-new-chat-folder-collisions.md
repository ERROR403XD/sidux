### Projectless new chat folder collisions

#### Feature/Change Name
Projectless new chats continue to create folders after repeated identical first messages.

#### Prerequisites/Setup
1. Use an isolated user home and `CODEX_HOME`. `CODEX_HOME` alone does not change `os.homedir()` or the projectless output root. The offline audit overrides homedir only inside its module fixture.
2. For authorized UI validation, verify the owner/cwd of port 4173 before starting the task server with its isolated user environment. Keep the existing 4173 service running when it belongs to this audit.
3. In that isolated user home, create task-owned collision folders under `Documents/Codex/<today>/`, for example `hi`, `hi-2`, through `hi-100`; record exact paths and never reuse or remove real user folders.

#### Steps
1. In light theme, open `http://127.0.0.1:4173/#/`.
2. Start a projectless new chat with the message `hi`.
3. Confirm the app creates a new folder under `~/Documents/Codex/<today>/` and opens the new thread without showing `Unable to create a unique new chat folder`.
4. Confirm the created folder keeps the prompt slug and includes a unique timestamp/random suffix after the readable collision range is exhausted.
5. Repeat in dark theme and confirm the new thread opens with readable composer and conversation surfaces.

#### Expected Results
- New projectless chats do not fail after common prompts exhaust the readable sequential suffix range.
- The app preserves readable folder names for early collisions and switches to unique suffixes for later collisions.
- Light and dark theme new-chat and conversation surfaces remain readable.

#### Rollback/Cleanup
- Leave port 4173 running unless explicitly asked to stop it.
- Remove only the exact collision folders created in this task's isolated user home.

---
