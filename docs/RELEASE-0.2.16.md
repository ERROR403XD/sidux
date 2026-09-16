# Sidux 0.2.16

中文 / English

本版发布经过隐私筛选的 0.2.16 源码快照，保留公开上游历史，不包含本地开发提交链。排除内部规划、会话记录、验收截图、浏览器 trace、本机环境文件、证书与运行数据；公开 GitHub 仓库名称及作者公开署名属于必要项目归属信息。

This release publishes a privacy-filtered 0.2.16 source snapshot on the existing public upstream history, without importing local development commits. Internal plans, conversation records, screenshots, browser traces, local environment files, certificates, and runtime data are excluded. Public repository identity and author attribution are retained.

## 功能 / Features

- 多账号、额度与恢复、API key 路由及 API 代理。 / Accounts, quotas, recovery, API-key routing and proxy integration.
- 自动化与历史、Goal、发送队列及故障恢复。 / Automations/history, Goals, message queues and recovery.
- 本版新增持久化完成列表、项目附加工作目录、中英文补全和界面细节改进。 / This version adds persistent completion tracking, additional project directories, broader bilingual coverage and UI refinements.
- 中文 README 与英文 README.en.md；来源与上游事件有明确引用。 / Chinese primary README and English README.en.md, with explicit ancestry and incident references.
- CLIProxyAPI 7.2.152 的版权、MIT 原文和固定来源清单随发行包提供；二进制另行安装。 / CLIProxyAPI attribution, full MIT license and pinned manifest are shipped; its binary is installed separately.

## 发布验证 / Release verification

- `pnpm install --lockfile-only --frozen-lockfile --ignore-scripts`: passed; the committed lockfile matches the package manifest.
- `pnpm run build`: passed Vue type checking and frontend/CLI builds on Node.js 24.
- `pnpm run test:unit`: **88 files, 614 tests passed**. The existing language test now supplies a document fixture and expects the current Worktree translation; no application logic was changed for that repair.
- `node -e "process.argv=['node','codexapp','--help'];require('./dist-cli/index.js')"`: passed, exit 0. The installed package's same CLI entry also passed. This CLI has no promised library exports.
- `pnpm pack --pack-destination <temporary-directory>` and `npm install --prefix <temporary-directory> <release-tarball>`: passed. The package contains 37 files, including both READMEs, project license, third-party notices, CLIProxyAPI license and manifest. Native terminal verification printed `RELEASE_PTY_OK`, exit 0, despite npm's install-script approval warning.
- Source and archive scans: no matches for known private host identifiers, local conversation identifiers, private network addresses or common credential formats. Internal documents and raw evidence were excluded by an explicit export allowlist. This is a scoped privacy review, not a general security certification.
- Package notices: CLIProxyAPI license byte-identical to the separately verified upstream component. Archive excludes the proxy binary, runtime state, environment files, certificates, conversation files and screenshots.
- Synthetic browser check: project edit dialog and the generic additional-directory placeholder passed at 1440×900 dark and 375×812 light, with an empty input and no error message. Evidence stays local and is not distributed.
- Performance: public export changes documentation, packaging metadata, developer defaults, synthetic fixtures and a static example path; no new application requests, polling, fanout, blocking work or cache invalidation. Entry JS 794.79 kB / gzip 251.57 kB; CLI 871.37 kB. This publication did not repeat full live workload profiling. This release does not claim a new full end-to-end run of every provider, notification channel, mobile platform or actual quota-reset operation.

## 安装 / Install

Download the package and SHA256SUMS from this repository's v0.2.16 release, verify with `sha256sum -c SHA256SUMS`, then use `npm install -g ./codexapp-0.2.16.tgz`. See the READMEs for source builds and the optional proxy. The same-named npm registry package is not the distribution channel for this fork.

## 声明 / Notices

See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md), [project MIT license](../LICENSE), and [CLIProxyAPI MIT license](../resources/api-proxy/LICENSE). No upstream endorsement is implied.
