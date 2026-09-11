# CodexApp

[中文](README.md) | **English**

[![Release](https://img.shields.io/github/v/release/ERROR403XD/codexapp)](https://github.com/ERROR403XD/codexapp/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

CodexApp is a self-hosted web interface for Codex app-server. Manage projects, conversations, accounts, and automations from desktop, tablet, or phone browsers. The release baseline is **0.2.17**. This is an independently maintained community project, unaffiliated with OpenAI.

## Acceptable use and policy compliance

> **Multiple-account switching must not be used to bypass OpenAI quotas, rate limits, usage limits, or access restrictions through automatic handoff, account rotation, manual switching, failover, request distribution, proxy forwarding, or any other means.** Account management is only for account and work-context changes permitted by applicable terms; it grants no additional entitlement or unlimited usage.

When accessing OpenAI services through this project, you must follow the [OpenAI Terms of Use](https://openai.com/policies/terms-of-use/), [Usage Policies](https://openai.com/policies/usage-policies/), and, where applicable, the [Services Agreement](https://openai.com/policies/services-agreement/) governing your region, product, and account. Other providers' terms and authorizations also apply. The following are this project's use requirements; they do not replace official policies or imply OpenAI review, approval, or endorsement of this project or its integrations.

- **Accounts and credentials:** connect only accounts you are entitled to use through provider-permitted access methods. Do not share personal accounts, resell or lease account access, or improperly trade or transfer credentials/API keys. Administrator permission, possession of credentials, or a local allowlist does not itself authorize account sharing or resale.
- **Quotas and recovery:** pause restricted requests when quota is exhausted or rate limits apply; wait for official recovery or use officially permitted upgrades or purchases. Do not evade limits by changing accounts, keys, or endpoints, running parallel instances, or repeatedly retrying. Quota displays, reserves, notifications, reset reminders, and continuation cannot create, pool, or reset provider quotas; resumption requires actual provider recovery or authorization.
- **API proxy and integrations:** interface compatibility, technical connectivity, and an MIT license do not establish provider authorization. Before enabling an integration, confirm that the account, subscription, and access method permit the intended use. Do not turn personal subscriptions into unauthorized shared/resold APIs, quota pools, or rate-limit bypass services. Leave the integration disabled if authorization is unclear.
- **Automations, Goals, queues, and tool permissions:** scheduling, automatic continuation, plugins, terminals, and approval settings remain subject to service limits and safeguards. Do not evade refusals, safety measures, suspensions, or access restrictions, or amplify abuse through unattended execution. Local tool permissions do not expand OpenAI entitlements.
- **Content, privacy, and output:** submit only code, files, audio, and personal data you have the right to process. Do not use the project for malicious cyber activity, fraud, spam, privacy violations, harm to minors, or other policy-prohibited purposes. Review output before use or sharing and meet applicable disclosure, human-review, and professional-involvement requirements.
- **Deployment and bridging:** web authentication, Telegram allowlists, proxy keys, and private networks control this application's entry points; they do not authorize giving others access to upstream accounts. Check data permissions and recipients' data-handling rules before sending content through bridges, plugins, or providers.

These statements do not guarantee that every runtime path enforces these requirements in code, and cannot make prohibited conduct compliant. Stop any conflicting use and disable the relevant feature if a feature, configuration, or use conflicts with applicable policies. Current official terms and actual authorization govern.

## Origin and upstream security incident

This project is forked from [friuns2/codex-mobile](https://github.com/friuns2/codex-mobile), historically also named codexUI/codexui, with earlier origins in [pavel-voronin/codex-web-local](https://github.com/pavel-voronin/codex-web-local). Original attribution and the MIT license are retained.

**The upstream npm distribution was publicly reported to contain code that stole users' Codex authentication data.** [Issue #198](https://github.com/friuns2/codex-mobile/issues/198) reports that the published CLI read `~/.codex/auth.json` at startup and sent its authentication contents to a third-party endpoint, while that code was absent from the GitHub source.

This fork therefore continues development from the GitHub source, rather than the reportedly poisoned npm distribution. “Unpoisoned GitHub version” refers to the source baseline without the distribution-only injection described in that report; it is not a blanket security guarantee for all historical code or dependencies. Upstream ancestry is retained, while local development is published as a reviewed source snapshot, and release packages are built from this repository. The linked report is the source for the incident description, not an independently verified conclusion about every upstream release.

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
| Multiple accounts | Separate credentials, local aliases, account status, switching, and coordinated execution ownership with busy-state safeguards. Automatic handoff, manual switching, or any other means must not bypass quotas. |
| Quota management | Quota windows and reset times, reserves, recovery notifications, reset-credit reminders, and conversation continuation after replenishment. Continuation requires official quota recovery or an authorized reset, subject to account eligibility and usage limits. |
| API proxy | API-key-protected OpenAI-compatible `/v1/models`, `/v1/responses`, and `/v1/chat/completions`, account routing, key management, and usage records. Requires an additional proxy component and provider permission for the intended access; unauthorized sharing, resale, and quota pools are prohibited. |
| Automations | Persistent scheduling, time zones, model/effort and account settings, run history, and status. The service must remain running; scheduling and retries must respect rate limits and usage policies. |
| Goals and commands | Goal cards, budgets and progress, and searchable slash commands, where supported by the runtime. |
| Queue and recovery | Queued sends while busy, explicit steering, persistent queues, continuation deduplication, and clearer failures. Continuation and retries must not bypass limits or safety refusals. |
| Additional working directories | Shared create/edit project dialog writes directory guidance into project `AGENTS.md`, preserving other content. This is not a multi-root file tree and does not add container mounts. |
| Completion list | Server-persisted blue dots for turns completed while not being viewed, synchronized across clients and cleared on opening; not inferred from historical update times. |
| Bilingual interface | Chinese/English settings, accounts, API proxy, automations, and project dialogs with persistent language preferences; user content is not translated. |
| Deployment | Removed built-in tunneling and mandatory startup login; strict ports, two-phase release switching, and cache recovery. |

The wider plugin refresh button aligns with the list right edge; the filter fits its content and the search field fills the remaining space with consistent control gaps.

Version 0.2.17 adds custom connections and optional scheduled account activation, improves plugin loading, notification settings, and WebUI appearance settings. Automation switches preserve row order until refresh. Viewed conversations no longer receive a completion dot; image-message echoes are deduplicated; unanswered questions stay above the composer; system theme uses a monitor icon. Scheduled activation is disabled by default, prioritizes foreground work, skips busy accounts, and bounds requests.

## Requirements

- This release is built and CLI-tested with Node.js 24 and pnpm 11. The manifest declares Node.js ≥18; not every minimum-version combination was tested.
- Codex CLI available on the service's PATH, with an account or a configured provider.
- Git for source installs and a modern browser.
- Optional `node-pty` for the terminal; Python 3, make, and a C/C++ toolchain may be needed.
- Primary validation is on Linux x64. Windows, macOS, Termux, and APK builds were not revalidated for this release. The proxy installer currently supports Linux x64 only.

## Installation

### Build this repository

```bash
git clone --branch v0.2.17 https://github.com/ERROR403XD/codexapp.git
cd codexapp
pnpm install --frozen-lockfile
pnpm run build
node dist-cli/index.js --port 5900 --strict-port --no-open
```

Open `http://localhost:5900`, follow the terminal's web authentication instructions, and add an account or configure a provider in the UI. Starting the web server does not automatically initiate Codex login. See the [official Codex repository](https://github.com/openai/codex) for CLI installation and authentication.

### Install the GitHub Release package

Download `codexapp-0.2.17.tgz` and `SHA256SUMS` from [v0.2.17](https://github.com/ERROR403XD/codexapp/releases/tag/v0.2.17), then run in the download directory:

```bash
sha256sum -c SHA256SUMS
npm install -g ./codexapp-0.2.17.tgz
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

Run `node dist-cli/index.js --help` or installed `codexapp --help` for all options. Choose permission and approval policies appropriate to your tasks; these control local execution and do not remove provider safeguards or usage restrictions.

The service listens on `0.0.0.0` and is reachable through the host's LAN address. Configure firewall rules, a password, or your own private network/reverse proxy as appropriate. Browser microphone features may require HTTPS. Project files and tools run on the server host.

### Optional API proxy (Linux x64, source installation)

```bash
node scripts/install-api-proxy.cjs ./output/api-proxy-component
CODEXAPP_API_PROXY_BINARY="$PWD/output/api-proxy-component/cli-proxy-api" \
  node dist-cli/index.js --port 5900 --strict-port --no-open
```

The installer downloads a pinned CLIProxyAPI release and verifies hashes from the [component manifest](resources/api-proxy/manifest.json). Only after confirming compliance with the requirements above and provider permission for the intended use, configure accounts and create keys in the API proxy page, then use its endpoints and examples. A local proxy key is not an official OpenAI API key and grants no extra quota or resale rights. The proxy is a separate MIT-licensed component, retaining its own license, and is not included in the web/CLI tarball.

### Optional Telegram bridge

Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS` (comma-separated user IDs), and optionally `TELEGRAM_DEFAULT_CWD`. Without an allowlist, incoming messages are rejected. Commands: `/start`, `/threads`, `/newthread`, `/thread <threadId>`, `/current`, `/history`, `/status`, `/whoami`, and `/help`. Configure credentials locally, never in the repository or issue reports. Allowlisted users still need the usage rights required by applicable terms; bridging must not share personal accounts or evade access restrictions.

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

Vue 3 / TypeScript / Vite power the frontend. Node.js / Express connect to Codex app-server over WebSocket/RPC; the terminal uses xterm.js / node-pty. Source is in `src/` and `scripts/`; see [tests.md](tests.md) and [public release verification](docs/RELEASE-0.2.17.md).

See [0.2.17 release verification](docs/RELEASE-0.2.17.md) for the tested scope and limitations. Private conversations, host paths, screenshots, and raw acceptance records are excluded.

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
