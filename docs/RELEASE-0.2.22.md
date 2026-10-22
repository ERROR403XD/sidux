# Sidux 0.2.22

本版本按维护者决定将最后的 `0.2.22-dev.8` 基线提升为 `0.2.22` 正式版，保留其功能实现与依赖版本。后续修复进入 `0.2.23`。/ This release promotes the final `0.2.22-dev.8` baseline to stable `0.2.22`, retaining its implementation and dependency versions. Further fixes continue in `0.2.23`.

## 更新 / Changes

- 拆分前端领域 API、会话状态及服务端路由职责，完善生命周期、分页、加载与恢复。/ Refined domain APIs, conversation state, server routing, lifecycle ownership, pagination, loading, and recovery.
- 增加会话状态查询、外部新建会话 API、完成与自动续跑通知，改善通知前缀和会话上下文。/ Added conversation status and creation APIs, completion and resume notifications, and clearer notification context.
- 定时续跑收到持久 accepted 回执后消费一次性计划并清除时钟标记，支持排队后启动和重启核对。/ Scheduled resume consumes its one-time plan and clears the clock marker after a durable accepted receipt, including queued starts and restart reconciliation.
- 改进自定义供应方、模型能力、偏好与草稿，以及浅深主题下的设置和集成布局。/ Improved custom providers, model capabilities, preferences, drafts, and settings and integration layouts.

## 已知问题 / Known issues

dev.8 审核确认的 **80 项问题（6 P1、66 P2、8 P3）仍未修复**。本次版本晋升不改变原审查的不放行结论，也不代表所有功能通过验收。正式单测通过与这些独立缺陷证据并存。/ **80 confirmed audit findings remain unresolved: 6 P1, 66 P2, and 8 P3.** Promotion does not override the audit's failed acceptance conclusion or imply that every feature passed. Passing unit tests and the independent defect evidence cover different contracts.

六项 P1 的触发与影响如下，均进入 0.2.23 修复范围：/ The six P1 findings carried into 0.2.23 are:

| 编号 / ID | 触发与影响 / Trigger and impact |
| --- | --- |
| R6 | 切换会话时迟到的终端 attach 响应可能把终端绑定到上一会话目录，导致命令在错误目录执行。/ A late terminal attachment during conversation switching can run commands in the previous conversation's directory. |
| R12 | 异常 SSE 尾帧在流结束时抛错，可使整个已安装 CLI 进程退出。/ A malformed SSE trailing frame can terminate the installed CLI process. |
| R31 | 文件路径被重复解码，保存返回成功却可能改写另一文件。/ Repeated file-path decoding can report a successful save while modifying a different file. |
| R37 | 撤回历史失败后重试可能覆盖回合前已有的未提交内容。/ Retrying a failed history rollback can overwrite pre-turn uncommitted changes. |
| R50 | 同一目标的并发克隆中，失败请求的清理可能删除另一请求已创建的目录。/ Cleanup after one concurrent clone fails can delete the directory created by another clone. |
| R62 | 旧终态事件可清掉新回合活动记录，使运行时和切换前检查误报空闲。/ A stale terminal event can clear a newer turn's activity and make runtime and pre-switch checks incorrectly report idle. |

其余已确认问题涉及通知与偏好竞态、协议转换、文件/Git 操作、自动化并发与日历、Telegram、技能详情、worktree 和输入/UI 生命周期。完整编号与复现证据由开发审查记录维护；跨平台、真实供应方与长期负载的未测范围继续保留。/ Other findings cover notification and preference races, protocol conversion, file and Git operations, automations, Telegram, skills, worktrees, and input/UI lifecycles. The development audit retains the complete issue inventory and reproduction evidence. Cross-platform, live-provider, and long-running load limitations remain.

## 安装与验证 / Installation and verification

源码使用 `v0.2.22` 标签。Release 附件提供 `codexapp-0.2.22.tgz`、`package-lock.json` 与 `SHA256SUMS`；下载全部附件后执行 `sha256sum -c SHA256SUMS`。源码构建与包安装见中英文 README。/ Use the `v0.2.22` source tag. Download all release assets and run `sha256sum -c SHA256SUMS`; installation instructions are in both READMEs.

Linux x64 / Node.js 24 验证：类型检查及前端/CLI 构建通过；公开 CJS `--help` 入口与真实 PTY 执行通过；解包后 `npm ci --omit=dev` 重放 78 个运行依赖，独立空白状态的首页和 capabilities 均返回 HTTP 200，版本为 `0.2.22`。公开发布树的 860 个源码、资源与脚本文件逐字节匹配最终 dev.8；正式单测 311 个文件全部通过，2,584 项通过、1 项原有跳过。/ Linux x64 / Node.js 24 verification passed type checking, frontend/CLI builds, the public CommonJS CLI help entry, and real PTY execution. The extracted package replayed 78 runtime dependencies; an isolated empty-state server returned HTTP 200 for its homepage and capabilities, reporting `0.2.22`. 860 source, resource, and script files match the final dev.8 baseline byte for byte; All 311 unit test files passed: 2,584 tests passed and one existing test was skipped.

性能范围：本次仅调整版本及公开说明，业务实现保持不变；主入口 JS 为 908,222 字节，CSS 为 456,845 字节，CLI 为约 1.20 MB。没有新增业务请求、循环、并发或载荷；本次未重新测量浏览器与长期负载。/ This promotion changes version metadata and public documentation while retaining the implementation. Main JS is 908,222 bytes, CSS is 456,845 bytes, and the CLI is about 1.20 MB. No application requests, loops, concurrency, or payloads were added; browser and long-running load were not remeasured.

公开树与发行附件只包含源码、合成测试、公开说明及构建产物；个人凭据、账号、会话、内部计划和本机审查产物不随包发布。API 代理组件仍按独立清单安装。/ Public source and assets contain source, synthetic tests, public documentation, and build output. Personal credentials, accounts, conversations, internal plans, and local audit artifacts are excluded. Install the API proxy separately using its manifest.
