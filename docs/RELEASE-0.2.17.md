# CodexApp 0.2.17

## 更新 / Changes

- 本版本已更新：插件页刷新按钮右对齐，安装包与源码标签同步替换。 / This release has been updated: align plugin Refresh with the right edge of the list; package and source tag are replaced together.

- 自定义连接管理与供应方能力适配。 / Custom connection management and provider capability handling.
- 可选账号定时激活：默认关闭、前台优先、忙碌跳过、限制请求数量，保存有限历史。使用仍须遵循 README 中的使用边界。 / Optional scheduled account activation: disabled by default, foreground priority, busy-account skips, bounded requests and history. README usage restrictions apply.
- 插件目录缓存、并发合并、搜索与分页；统一响应式设置和外观配置。 / Cached plugin catalogs, coalesced loads, search, pagination, responsive settings and appearance preferences.
- 通知开关与 Telegram 免打扰时段持久化。 / Persistent notification controls and Telegram quiet hours.
- 自动化列表使用开关，启用后保持当前行位置至刷新；详情新增移除按钮，删除提示词预览，长标题单行省略。 / Automation switches preserve row order until refresh; details add Remove, omit prompt previews, and truncate long titles.
- 正在查看的会话完成后不生成蓝点；修复带图消息的乐观回显重复，保留独立发送。 / Viewed conversations complete without unread dots; image-message optimistic echoes are deduplicated without merging distinct sends.
- 未回答的提问固定在输入框上方；自动主题改用显示器图标。 / Unanswered questions stay above the composer; system theme uses a monitor icon.

## 安装与升级 / Install and upgrade

下载 `codexapp-0.2.17.tgz` 与 `SHA256SUMS`，运行 `sha256sum -c SHA256SUMS` 后安装。源码和安装步骤见中英文 README。 / Download the package and checksum file, verify with `sha256sum -c SHA256SUMS`, then follow the bilingual READMEs.

本次为 GitHub 发行包，不是 npm registry 发布。发布不切换已有运行服务；请在运行任务结束并备份后自行升级。 / This is a GitHub distribution, not an npm registry publication. Existing services are not switched automatically; upgrade after finishing tasks and backing up data.

## 验证 / Verification

公开快照在 Linux x64、Node.js 24、pnpm 11 下重新构建和测试。 / The public snapshot was rebuilt and tested on Linux x64, Node.js 24, and pnpm 11.

- Vue type checking and production frontend/CLI builds passed.
- Full unit suite: 101 files passed, 685 tests passed, 1 native-session test skipped because its opt-in environment was not enabled.
- The lifecycle test fixture was updated to match the current shared-runtime version and notification shutdown interface.
- Isolated package installation passed. On Node.js 24, `node -e "process.argv=['node','codexapp','--help'];require('./dist-cli/index.js')"` returned CLI help with exit 0; this entry exposes a CLI, not library exports. The installed `node-pty` produced `RELEASE_PTY_OK`.
- Privacy checks covered 815 source files and all 37 package entries, with no findings for the checked private-path, credential, runtime-file and symlink patterns. Published asset downloads must also pass SHA-256 verification.
- Refresh alignment was verified at 1440×1000, 768×1024 and 375×812 in light/dark themes: zero-pixel right-edge difference and one plugin request per click. This CSS/template change adds no listeners or network calls.
- Earlier candidate validation covered the changed UI in light/dark themes and synthetic image/question flows. This packaging pass does not claim a new live-provider or cross-platform acceptance run.

## 性能与范围 / Performance and scope

生产构建主入口为 815.25 kB（gzip 258.55 kB），仍有 Vite 大分块提示。插件目录复用缓存与并发请求，通知队列最多保留 256 项，定时激活遵守准入限制；本次未重新测量真实账号网络延迟。 / The main frontend chunk is 815.25 kB (258.55 kB gzip); Vite still reports a large-chunk warning. Plugin catalogs reuse cached/coalesced requests, notification queues retain at most 256 entries, and scheduled activation respects admission limits. Live-account network latency was not remeasured.

Windows、macOS、Termux、APK 和最低 Node.js 版本未重新验收。CLIProxyAPI 保持固定版本并单独安装。 / Windows, macOS, Termux, APK and minimum Node.js versions were not revalidated. CLIProxyAPI remains pinned and separately installed.

## 公开内容边界 / Public contents

从公开主分支生成源码快照，不引入私有开发历史；排除个人认证、运行配置、会话、内部文档、截图、日志及数据库。通用构建配置、合成测试和第三方许可保留。删除先前误跟踪的依赖目录链接，并忽略本地依赖及产物。 / The snapshot starts from public main without importing private development history. Personal credentials, runtime configuration, conversations, internal documents, screenshots, logs and databases are excluded; generic build configuration, synthetic tests and licenses remain. The previously tracked dependency-directory link is removed and local dependencies/artifacts are ignored.
