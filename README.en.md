# CodexApp

[中文](README.md) | **English**

[![Release](https://img.shields.io/github/v/release/ERROR403XD/codexapp)](https://github.com/ERROR403XD/codexapp/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

CodexApp is a self-hosted web interface for Codex app-server. Manage projects, conversations, accounts, and automations from desktop, tablet, or phone browsers. The release baseline is **0.2.16**. This is an independently maintained community project, unaffiliated with OpenAI.

## Origin and upstream security incident

This project is forked from [friuns2/codex-mobile](https://github.com/friuns2/codex-mobile), historically also named codexUI/codexui, with earlier origins in [pavel-voronin/codex-web-local](https://github.com/pavel-voronin/codex-web-local). Original attribution and the MIT license are retained.

**The upstream npm distribution was publicly reported to contain code that stole users' Codex authentication data.** [Issue #198](https://github.com/friuns2/codex-mobile/issues/198) reports that the published CLI read `~/.codex/auth.json` at startup and sent its authentication contents to a third-party endpoint, while that code was absent from the GitHub source.

This fork therefore continues development from the GitHub source, rather than the reportedly poisoned npm distribution. “Unpoisoned GitHub version” refers to the source baseline without the distribution-only injection described in that report; it is not a blanket security guarantee for all historical code or dependencies. Git history remains traceable, and release packages are built from this repository. The linked report is the source for the incident description, not an independently verified conclusion about every upstream release.

**Install from this repository or its [GitHub Releases](https://github.com/ERROR403XD/codexapp/releases).** The package and command names remain `codexapp` for compatibility, but this GitHub release does not establish control over the same-named npm package. Do not use `npx codexapp` or `npm install -g codexapp` to obtain this fork.

## Features

- Browser chat and streaming responses, Markdown, code, file browsing, Git operations, and an integrated terminal.
- Projects, conversation search and archiving, project ZIP import/export including associated conversation history.
- Model, reasoning effort, permission, and execution controls, subject to the actual CLI, account, and provider capabilities.
- Desktop/mobile layouts; light, dark, and automatic themes; Chinese and English UI.
- Skills and plugins, optional Telegram bridging and voice input, subject to service configuration and browser permissions.

### Added or enhanced in this fork

| Feature | Details |
| --- | --- |
| Multiple accounts | Separate credentials, local aliases, account status, switching, and coordinated execution ownership with busy-state safeguards. |
| Quota management | Quota windows and reset times, reserves, recovery notifications, reset-credit reminders, and conversation continuation after replenishment. Actual resets depend on account eligibility. |
| API proxy | API-key-protected OpenAI-compatible `/v1/models`, `/v1/responses`, and `/v1/chat/completions`, account routing, key management, and usage records. Requires an additional proxy component. |
| Automations | Persistent scheduling, time zones, model/effort and account settings, run history, and status. The service must remain running. |
| Goals and commands | Goal cards, budgets and progress, and searchable slash commands, where supported by the runtime. |
| Queue and recovery | Queued sends while busy, explicit steering, persistent queues, continuation deduplication, and clearer failures. |
| Additional working directories | Shared create/edit project dialog writes directory guidance into project `AGENTS.md`, preserving other content. This is not a multi-root file tree and does not add container mounts. |
| Completion list | Server-persisted blue dots for newly completed turns, synchronized across clients and cleared on opening; not inferred from historical update times. |
| Bilingual interface | Chinese/English settings, accounts, API proxy, automations, and project dialogs with persistent language preferences; user content is not translated. |
| Deployment | Removed built-in tunneling and mandatory startup login; strict ports, two-phase release switching, and cache recovery. |

Version 0.2.16 focuses on completion tracking, project directories, bilingual coverage, terminology, quota labels, and the automatic-theme icon. Other features accumulated across this fork's earlier versions.

## Screenshots

These screenshots are from isolated 0.2.16 acceptance with sample data.

![Desktop project editor, dark theme](docs/plans/assets/0.2.16-i18n/0216-i18n-project-1440-dark.png)

<details>
<summary>Mobile, light theme</summary>

![Mobile project editor](docs/plans/assets/0.2.16-i18n/0216-i18n-project-375-light.png)

</details>

## Requirements

- This release is built and CLI-tested with Node.js 24 and pnpm 11. The manifest declares Node.js ≥18; not every minimum-version combination was tested.
- Codex CLI available on the service's PATH, with an account or a configured provider.
- Git for source installs and a modern browser.
- Optional `node-pty` for the terminal; Python 3, make, and a C/C++ toolchain may be needed.
- Primary validation is on Linux x64. Windows, macOS, Termux, and APK builds were not revalidated for this release. The proxy installer currently supports Linux x64 only.

## Installation

### Build this repository

```bash
git clone --branch v0.2.16 https://github.com/ERROR403XD/codexapp.git
cd codexapp
pnpm install --frozen-lockfile
pnpm run build
node dist-cli/index.js --port 5900 --strict-port --no-open
```

Open `http://localhost:5900`, follow the terminal's web authentication instructions, and add an account or configure a provider in the UI. Starting the web server does not automatically initiate Codex login. See the [official Codex repository](https://github.com/openai/codex) for CLI installation and authentication.

### Install the GitHub Release package

Download `codexapp-0.2.16.tgz` and `SHA256SUMS` from [v0.2.16](https://github.com/ERROR403XD/codexapp/releases/tag/v0.2.16), then run in the download directory:

```bash
sha256sum -c SHA256SUMS
npm install -g ./codexapp-0.2.16.tgz
codexapp --port 5900 --strict-port --no-open
```

The package contains built web/CLI assets; installation still downloads npm dependencies. Install Codex CLI and the optional proxy separately. GitHub's automatic Source code archives contain source and require a build.

### Configuration

| Option | Purpose |
| --- | --- |
| `--port 5900` | Listening port; default 5900. |
| `--strict-port` | Fail if occupied, instead of silently changing ports. |
| `--no-open` | Do not open a host browser. |
| `--password <password>` | Set the web password; command-line arguments may enter shell history. |
| `--no-password` | Disable the web password, suitable only for trusted environments with other access controls. |
| `CODEX_HOME` | Separate credentials, conversations, and application state; otherwise uses the Codex default directory. |

Run `node dist-cli/index.js --help` or installed `codexapp --help` for all options. Choose permission and approval policies appropriate to your tasks.

The service listens on `0.0.0.0` and is reachable through the host's LAN address. Configure firewall rules, a password, or your own private network/reverse proxy as appropriate. Browser microphone features may require HTTPS. Project files and tools run on the server host.

### Optional API proxy (Linux x64, source installation)

```bash
node scripts/install-api-proxy.cjs ./output/api-proxy-component
CODEXAPP_API_PROXY_BINARY="$PWD/output/api-proxy-component/cli-proxy-api" \
  node dist-cli/index.js --port 5900 --strict-port --no-open
```

The installer downloads a pinned CLIProxyAPI release and verifies hashes from the [component manifest](resources/api-proxy/manifest.json). Configure accounts and create keys in the API proxy page, then use its endpoints and examples. The proxy is a separate MIT-licensed component, retaining its own license, and is not included in the web/CLI tarball.

### Optional Telegram bridge

Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS` (comma-separated user IDs), and optionally `TELEGRAM_DEFAULT_CWD`. Without an allowlist, incoming messages are rejected. Commands: `/start`, `/threads`, `/newthread`, `/thread <threadId>`, `/current`, `/history`, `/status`, `/whoami`, and `/help`. Configure credentials locally, never in the repository or issue reports.

## Data and upgrades

Credentials, conversations, and application state live in the selected `CODEX_HOME`; project files live in their project directories. Additional-directory settings modify project `AGENTS.md`. Back up both locations as appropriate; backups may contain credentials and private conversations.

Finish running tasks and back up data before upgrading. Verify and build/install the new release before starting it. Keep the previous tag/package and data backups for rollback. `scripts/codexapp-release-switch.sh` implements two-phase deployment for this project's host setup; read its configuration before using it. Publishing a GitHub Release does not automatically switch your running service.

## Development and verification

```bash
pnpm install --frozen-lockfile
pnpm run dev --host 127.0.0.1 --port 4173
pnpm run build
pnpm run test:unit
```

Vue 3 / TypeScript / Vite power the frontend. Node.js / Express connect to Codex app-server over WebSocket/RPC; the terminal uses xterm.js / node-pty. Source is in `src/` and `scripts/`; see [tests.md](tests.md) and [design/acceptance records](docs/plans).

Existing 0.2.16 acceptance covers isolated packages, actual directory reads, cross-client completion tracking, bilingual UI, and light/dark themes: [feature acceptance, Chinese](docs/plans/20260910-0011-codexapp-0.2.16完成列表与项目多目录开发验收.md) and [language acceptance, Chinese](docs/plans/20260910-0012-codexapp-0.2.16中英文界面补全与验收.md). Synthetic failure tests do not establish live acceptance of every provider, real quota resets, or every notification channel.

## Troubleshooting

- **Port occupied:** use another port or inspect the owning process. Strict mode never increments automatically.
- **Codex/model unavailable:** check the service PATH, installed CLI, active account/provider, and live model catalog.
- **Terminal unavailable:** check `node-pty` installation and native build prerequisites.
- **Missing proxy:** install the component explicitly and verify `CODEXAPP_API_PROXY_BINARY` points to its executable.
- **Another device cannot connect:** check host address, port, firewall, web authentication, and container mappings.
- **Additional directories ignored:** paths must exist in the server environment; ask an existing conversation to reread project instructions, or start a new one.

## Third-party attribution

The API proxy uses [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) **7.2.152**, pinned to commit `c76dfd4e0edabab9000628b1560ab8ab379eadb8`, under the MIT license. It is an independent upstream component, not code originally authored by this project. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the [unaltered upstream license](resources/api-proxy/LICENSE). Redistribution of the component must retain its copyright and permission notice. Integration does not imply upstream endorsement or a change to provider terms, quotas, or permissions.

## Contributing and license

[Issues](https://github.com/ERROR403XD/codexapp/issues) and pull requests are welcome. Include version, platform, reproduction steps, and sanitized logs; never attach `auth.json`, tokens, API keys, or private conversations. Follow [AGENTS.md](AGENTS.md) and update relevant tests and acceptance notes. Chinese is the primary README; keep this English version aligned for user-facing changes.

Licensed under [MIT](LICENSE). Thanks to the original authors and contributors, Codex, Vue, Vite, xterm.js, CLIProxyAPI, and their communities.
