# Sidux 0.2.19

0.2 系列封版维护基线，包含自公开 0.2.17 以来的 0.2.18 与 0.2.19 改进。0.3 的项目工作台仍是独立设计方向，本版本保持现有执行与账号契约。 / Sealed maintenance baseline for the 0.2 series, including changes from 0.2.18 and 0.2.19 since public 0.2.17. The project-workspace UI planned for 0.3 remains separate; this release preserves existing execution and account contracts.

## 功能与交互 / Features and interaction

- 新建项目可只填名称，用于组织无项目会话；抽象展开/收起图标，已有目录、文件、工作方式不变。移除组织保留会话和自动化。 / Name-only projects organize otherwise ungrouped conversations with abstract open/closed icons, without changing existing workspaces or files. Removing an organization retains conversations and automations.
- 引导内容立即显示，支持切换、刷新、受理回执与原生历史去重；持久显示缓存写满时可降级到标签页缓存。 / Steering messages appear immediately, survive navigation/reload, and reconcile with acknowledgements and native history. Full persistent display storage can fall back to tab storage.
- 活跃筛选在本次开启期间暂留完成/中断的会话，查看并切走后清理；旧未读不会在重新开启时混入。 / Active filtering temporarily retains conversations that finish or stop during the current filter session, until viewed and left; reopening the filter does not include older unread conversations.
- 额度错误显示黄点，其他非手动最终错误显示红点；阅读不清除，支持显式忽略与中断筛选。挂起摘要请求不会长期锁住后续忽略。 / Quota failures use yellow dots and other non-manual final failures use red dots. Reading does not dismiss them; explicit ignore and Interrupted filtering are supported, with bounded requests and independent snapshot recovery.
- 每日自动化和每日激活均支持多个时刻，统一带时钟的时间控件，支持全角数字及中英文冒号。 / Daily automations and account activation support multiple times with a shared clock control and normalization of full-width digits and colons.
- 空草稿中新输入 `/` 才激活命令搜索；扩大输入区菜单定位与窗口 resize 修复。精简保存/账号/调度提示、补充功能错误关闭按钮和轻量反馈报告，保留必要错误。 / Command search opens only on a freshly typed slash in an empty draft. Expanded-composer positioning and resize behavior are fixed. Status text is simplified, dismissible functional errors and lightweight feedback reports are added, and necessary errors remain visible.
- 自动化页窄屏保持边距；支持 `launch_handler` 的浏览器可在再次启动 PWA 时聚焦已有窗口。 / Automation layouts retain margins on narrow screens. Browsers supporting `launch_handler` can focus an existing PWA window on relaunch.

## 可靠性 / Reliability

- 自动化慢 inspect 移出短控制队列；准备有期限，但真实进程、共享操作、账号 lease 和 slot 在实际结束前仍受保护。 / Slow automation inspection runs outside the short control queue. Preparation has deadlines while real processes, shared operations, account leases and slots retain ownership until their effects end.
- 后台保存仅裁剪已归档对象，避免覆盖保存等待期间新受理的手动/定时运行。 / Background saves remove only archived records and preserve manual/scheduled runs admitted during storage waits.
- 分段历史、永久防重事实、可恢复写前记录和兼容导出，避免长期运行丢失已执行身份。 / Segmented history, permanent idempotency facts, recoverable pending records and compatibility export preserve execution identity over long-lived use.
- 额度续跑有界轮转，激活活动纳入交接门禁；固定已验证的直接运行依赖，部署保留实际解析锁。 / Quota-resume scans rotate within bounds, activation activity participates in release gates, and tested direct runtime dependencies are pinned with deployment lock retention.
- 保持既有账号选择、用量、API key/出口、保护和互相阻塞/放行规则；显示失败不驱动重复发送。 / Existing account selection, usage, API keys/routing, protection and admission/blocking rules are preserved. Display failures never drive duplicate submission.

## 安装、升级与回退 / Install, upgrade and rollback

下载 `codexapp-0.2.19.tgz` 与 `SHA256SUMS`，运行 `sha256sum -c SHA256SUMS` 后按中英文 README 安装。这是 GitHub 发行包，不是 npm 同名注册包发布。 / Download the archive and checksums, verify with `sha256sum -c SHA256SUMS`, and follow the bilingual READMEs. This is a GitHub distribution, not a publication to the same-named npm registry package.

升级前结束任务并备份对应 CODEX_HOME 和项目文件。**回退到更早历史格式前，停止对应实例，使用 0.2.19 程序导出兼容历史：** / Finish tasks and back up the relevant CODEX_HOME and project files before upgrading. **Before downgrading to an older history format, stop the instance and export compatibility history using the 0.2.19 executable:**

```bash
node dist-cli/index.js automation-history --home /path/to/codex-home --export-legacy
```

仅在导出成功后启动旧程序；保留完整备份，不删除调度锁或永久事实来绕过错误。发布不会自动切换任何现有服务。 / Start the older program only after export succeeds. Keep a full backup; never remove scheduler locks or permanent facts to bypass failures. Publishing does not switch existing services.

## 验证与范围 / Verification and scope

- Development and the actual public source snapshot each passed all **826 tests in 121 files**, with no skipped tests, on Linux x64 / Node.js 24.19.0. This includes native IPC account/automation integration and a 49-pair provider-resume matrix; the matrix is part of the total, not 49 extra tests.
- Added disk-full regression cases before dispatch, before submission and after acceptance: durable queued work resumes once after restart; ambiguous submissions are never replayed automatically. Empty-project collapse now verifies hidden content and persisted state, as well as icons.
- A fixture cleanup race was found during public verification: a queued account metadata write could outlive a child process and collide with temporary-directory removal. The test now waits for that write before cleanup; production code and functional assertions were unchanged.
- Vue type checking and frontend/CLI builds passed. The public lockfile passed frozen/offline validation. The installed package, CLI, real PTY, HTTP cache migration, API authentication rejection and release-download SHA-256 are verified during release preparation.
- Isolated HTTP/IPC checks cover organization removal followed by manual runs, explicit retry, naturally due scheduled execution with the original fixed account, pause/re-enable, and unchanged task identity. Project ZIP/file and interrupted-history recovery checks use disposable state.
- Browser checks use synthetic conversations and fault injection for storage-full reload, delayed acknowledgements, failed history/queue reads, persistent issue dots and consecutive ignores with stalled snapshots. Light/dark themes and desktop/tablet/mobile views are included. Composer slash/resize and PWA declarations are checked separately.
- No private development history, account/session files, internal plans, raw screenshots, logs or traces are published. Source/package content and artifact hashes are reviewed before upload.

## 保留边界 / Retained boundaries

标签页降级缓存不承诺关闭标签页后恢复；两种浏览器存储都不可写时仍保留实际 ACK，不制造重发。共享原生不可取消操作仍可能等待，不能提前释放其真实资源。手动 HTML/SVG 主动预览风险和大模块保留，未为封版重写账号或 UI 架构。 / Tab-storage fallback does not promise recovery after closing the tab. If both stores are unavailable, the real acknowledgement remains authoritative and does not cause resubmission. Non-cancellable shared native operations may continue waiting while retaining their actual resources. Active-content risks in manual HTML/SVG preview and large modules remain; account and UI architecture were not rewritten for this release.

Live-provider successful billing, natural quota exhaustion/reset, multi-day scheduling, sudden power loss, all minimum Node versions, all operating systems, actual mobile keyboards and installed-PWA launcher behavior are not claimed as fully revalidated. Local native IPC and browser fixtures are not substitutes for those environments. The initial frontend chunk remains above Vite's 500 kB warning threshold; no unrelated bundle refactoring was added.

CLIProxyAPI remains the pinned 7.2.152 component with its original license and manifest, installed separately. Existing README usage and provider-policy requirements continue to apply.
