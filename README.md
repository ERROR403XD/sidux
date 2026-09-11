# CodexApp

**中文** | [English](README.en.md)

[![Release](https://img.shields.io/github/v/release/ERROR403XD/codexapp)](https://github.com/ERROR403XD/codexapp/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

CodexApp 是基于 Codex app-server 的自托管 Web 界面，让你在桌面、平板和手机浏览器中管理项目、会话、账号与自动化任务。当前发布基线为 **0.2.17**。这是社区维护的独立项目，与 OpenAI 官方产品没有隶属关系。

## 使用边界与政策遵循

> **禁止利用多账号切换，以自动流转、自动轮换、手动切换、故障转移、请求分摊、代理转发或任何其他形式绕过 OpenAI 的额度、速率、使用或访问限制。** 多账号功能仅用于符合适用条款的账号管理与工作上下文切换，不构成额外使用权或无限额度承诺。

使用本项目接入 OpenAI 服务，必须遵循适用于你的地区、产品和账号的 [OpenAI 使用条款](https://openai.com/policies/terms-of-use/)、[使用政策](https://openai.com/policies/usage-policies/)及适用的 [服务协议](https://openai.com/policies/services-agreement/)。其他供应方同样以其条款和授权为准。以下是本项目的使用要求，不替代官方政策，也不表示 OpenAI 已审核、批准或背书本项目或其集成方式。

- **账号与凭据**：仅接入你有权使用且接入方式获供应方允许的账号；不得共享个人账号、租售账号访问权，或违规买卖、转让凭据/API key。管理员授权、持有凭据或本地白名单不自动赋予账号共享或转售权。
- **额度与恢复**：额度耗尽或被限流时，应暂停受限请求，等待官方恢复，或使用官方允许的升级、增购等方式；不得换账号、换 key、换端点、跨实例并发或反复重试来规避限制。额度显示、预留、通知、重置提示及续接不能创造、合并或重置官方额度；恢复使用须以供应方实际恢复或授权为前提。
- **API 代理与第三方集成**：接口兼容、技术可连接或 MIT 许可证不等于供应方授权。启用前须确认该账号、订阅和接入方式允许此用途；不得将个人订阅包装为未经授权的共享/转售 API、额度池或限流绕过服务。无法确认授权时不要启用该集成。
- **自动化、Goal、队列与工具权限**：定时执行、自动续接、插件、终端和审批设置均须遵守服务限制及安全措施；不得规避拒绝、安全防护、封禁或访问限制，也不得通过无人值守运行放大滥用。本地工具权限不改变 OpenAI 的授权边界。
- **内容、隐私与输出**：仅提交有权处理的代码、文件、语音和个人数据；不得用于恶意网络活动、诈骗、垃圾信息、侵犯隐私、危害未成年人或其他政策禁止的用途。使用或分享输出前按场景核验，并遵守披露、人工审核及专业人士参与等适用要求。
- **部署与桥接**：Web 访问、Telegram 白名单、代理 key 和私有网络只控制本项目入口，不代表获得向其他人提供上游账号访问的许可。通过桥接、插件或供应方发送内容前，确认数据授权及接收方的数据处理规则。

这些声明不保证所有运行路径已在代码层强制执行上述要求，也不能使违规行为合规。若某项功能、配置或使用方式与适用政策冲突，应停止该用法并关闭相关功能；以最新官方条款及实际授权为准。

## 项目来源与上游安全事件

本项目 fork 自 [friuns2/codex-mobile](https://github.com/friuns2/codex-mobile)（历史名称包含 codexUI/codexui），更早的项目来源为 [pavel-voronin/codex-web-local](https://github.com/pavel-voronin/codex-web-local)。保留原作者署名与 MIT 许可证。

**上游曾被公开报告在 npm 发布包中加入窃取用户 Codex auth 的代码。** [Issue #198](https://github.com/friuns2/codex-mobile/issues/198) 报告称，发布包在 CLI 启动时读取 `~/.codex/auth.json` 并将认证内容发送至第三方端点，而相应代码不存在于其 GitHub 源码中。

因此，本项目从 GitHub 源码版本接续开发，不以被报告投毒的 npm 发布包为开发基线；此处“未投毒的 GitHub 版本”指未包含该报告所述发布包注入代码的源码基线，不代表对所有历史代码和依赖作出绝对安全保证。本分支保留上游来源，并以审核后的源码快照发布，发行包从本仓库源码构建。事件细节以所链接的公开报告为准，不将其扩展为未经独立核实的结论。

**请使用本仓库的源码或 [GitHub Releases](https://github.com/ERROR403XD/codexapp/releases)。** 包名和命令仍保留 `codexapp` 以兼容现有部署，但本次 GitHub 发布不代表 npm 同名包由本仓库控制；不要用 `npx codexapp` 或 `npm install -g codexapp` 获取本分支。

## 功能概览

- 浏览器内聊天与流式回复，支持 Markdown、代码、文件浏览、Git 操作和内置终端。
- 项目与会话管理、搜索、归档、项目 ZIP 导入导出；导出可包含对应会话历史。
- 模型、推理强度、权限与执行状态控制；具体能力取决于当前 Codex CLI、账号及供应方。
- 桌面和移动布局、浅色/深色/自动主题，中文与英文界面。
- 技能与插件管理、可选 Telegram 桥接和语音输入；第三方服务及浏览器权限需自行配置。

### 本分支在原版基础上新增或增强

| 功能 | 说明 |
| --- | --- |
| 多账号管理 | 独立保存账号认证，提供账号别名、状态、切换与执行归属协调；忙碌状态下保护切换。不得以自动流转、手动切换或其他形式绕过额度限制。 |
| 额度管理 | 显示额度窗口与重置时间，支持额度预留、恢复通知、重置机会提示及额度恢复后的会话续接；仅可在官方额度恢复或获准重置后续接，须遵循账号资格和使用限制。 |
| API 代理 | 提供受 API key 控制的 OpenAI 兼容接口，包括 `/v1/models`、`/v1/responses`、`/v1/chat/completions`；支持账号路由、key 管理与使用记录。需要额外安装代理组件；须先确认供应方允许该接入用途，禁止未经授权的共享、转售或额度池。 |
| 自动化 | 持久化调度、时区、模型/推理强度与账号设置、执行历史和任务状态。服务必须保持运行；调度与重试须遵守限流和使用政策。 |
| Goal 与命令 | 目标卡片、预算与进度展示、可搜索斜杠命令；依赖运行时支持的原生能力。 |
| 发送队列与恢复 | 忙碌时排队、明确的插话操作、队列持久化及续接投递去重，改进故障反馈；不得借续接或重试绕过限制或安全拒绝。 |
| 项目附加工作目录 | 统一创建/编辑项目，将附加目录指引写入项目 `AGENTS.md`，保留其他内容；不是多根文件树，也不会自动增加容器挂载。 |
| 完成列表 | 新回合在用户未查看时完成后显示蓝点，服务端持久化并跨客户端同步，点击后清除；不根据历史更新时间推算未读。 |
| 双语与界面 | 设置、账号、API 代理、自动化和项目窗口等中文/英文切换，语言偏好持久化；不翻译用户内容。 |
| 部署维护 | 移除内置隧道与启动时强制登录，增加严格端口绑定、两阶段发布切换和缓存恢复。 |

插件页刷新按钮位于工具栏最右侧，与下方列表区域对齐。

0.2.17 新增自定义连接管理与可选账号定时激活，改进插件目录加载、通知设置和 WebUI 外观设置；自动化任务支持列表开关，切换后保持当前排序至刷新。正在查看的会话完成时不再产生蓝点，修复图片消息重复显示，未回答的提问固定在输入框上方，自动主题使用显示器图标。定时激活默认关闭，遵守前台优先、忙碌跳过与请求数量限制。

## 环境要求

- 本次构建与 CLI 验证使用 Node.js 24、pnpm 11；`package.json` 声明 Node.js ≥18，但本次未覆盖所有最低版本组合。
- 已安装并可从 PATH 访问的 Codex CLI，以及可用账号或自行配置的供应方。
- Git（源码安装）；可访问服务的现代浏览器。
- 内置终端依赖可选模块 `node-pty`，必要时需 Python 3、make 和 C/C++ 编译工具。
- 本分支主要在 Linux x64 验证。Windows、macOS、Termux 和 APK 未在本次发布中重新验收；API 代理安装脚本当前仅支持 Linux x64。

## 安装与启动

### 从本仓库源码构建

```bash
git clone --branch v0.2.17 https://github.com/ERROR403XD/codexapp.git
cd codexapp
pnpm install --frozen-lockfile
pnpm run build
node dist-cli/index.js --port 5900 --strict-port --no-open
```

浏览器打开 `http://localhost:5900`，按终端提示完成 Web 访问认证，再到账号面板添加账号或配置供应方。启动服务不会自动开启 Codex 登录流程。Codex CLI 的安装及登录方式请参见其[官方仓库](https://github.com/openai/codex)。

### 使用本仓库 Release 安装包

从 [v0.2.17](https://github.com/ERROR403XD/codexapp/releases/tag/v0.2.17) 下载 `codexapp-0.2.17.tgz` 和 `SHA256SUMS`，在下载目录执行：

```bash
sha256sum -c SHA256SUMS
npm install -g ./codexapp-0.2.17.tgz
codexapp --port 5900 --strict-port --no-open
```

该包包含构建好的 Web/CLI，安装时仍需下载 npm 依赖；Codex CLI 和可选 API 代理组件需另外准备。GitHub 自动生成的 Source code 压缩包是源码，需按源码步骤构建。

### 常用配置

| 配置 | 用途 |
| --- | --- |
| `--port 5900` | 指定端口；默认 5900。 |
| `--strict-port` | 端口被占用时直接失败，避免悄悄更换端口。 |
| `--no-open` | 不自动打开本机浏览器。 |
| `--password <密码>` | 指定 Web 访问密码；注意命令行参数可能进入 shell 历史。 |
| `--no-password` | 关闭 Web 密码，仅适合有其他访问控制的可信环境。 |
| `CODEX_HOME` | 指定独立认证、会话与应用状态目录；未设置时使用 Codex 默认目录。 |

完整参数运行 `node dist-cli/index.js --help` 或安装后的 `codexapp --help`。权限和审批策略应按实际任务设置；这些设置仅控制本地执行，不解除供应方的安全措施或使用限制。

服务监听 `0.0.0.0`，可通过主机局域网地址访问。请按网络环境配置防火墙、访问密码或自行管理的私有网络/反向代理。麦克风、语音等浏览器能力可能需要 HTTPS 安全上下文。项目文件和工具实际在服务所在主机执行。

### 可选 API 代理（Linux x64，源码安装）

```bash
node scripts/install-api-proxy.cjs ./output/api-proxy-component
CODEXAPP_API_PROXY_BINARY="$PWD/output/api-proxy-component/cli-proxy-api" \
  node dist-cli/index.js --port 5900 --strict-port --no-open
```

脚本按 [组件清单](resources/api-proxy/manifest.json) 下载固定版本 CLIProxyAPI 并校验摘要。确认符合上文使用边界且供应方允许该用途后，进入 API 代理页面配置账号、创建 key，再使用页面提供的端点和示例。本地代理 key 不是 OpenAI 官方 API key，也不赋予额外额度或转售权。代理组件为单独的 MIT 项目，保留其许可证；它不包含在 Web/CLI 的 npm tarball 中。

### 可选 Telegram 桥接

通过环境变量配置 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_ALLOWED_USER_IDS`（逗号分隔的允许用户 ID）和可选 `TELEGRAM_DEFAULT_CWD`。未设置用户白名单时拒绝入站消息。支持 `/start`、`/threads`、`/newthread`、`/thread <threadId>`、`/current`、`/history`、`/status`、`/whoami`、`/help`。请在本机配置凭据，不写入仓库或问题报告。白名单用户仍须具备适用条款要求的使用权，不得借桥接共享个人账号或规避访问限制。

## 数据与升级

认证、会话与应用状态位于所选 `CODEX_HOME`，项目文件位于各项目目录；附加目录设置会写入项目 `AGENTS.md`。备份时分别考虑这两部分，备份中可能包含凭据及私有会话。

升级前结束运行中的任务并备份数据，下载新版本并校验、重新构建或安装后再启动。回退可使用先前源码标签或发行包，同时保留数据备份。源码中的 `scripts/codexapp-release-switch.sh` 是本项目宿主环境的两阶段部署脚本，使用前阅读脚本配置；GitHub Release 发布不等同于自动切换你的运行服务。

## 开发与验证

```bash
pnpm install --frozen-lockfile
pnpm run dev --host 127.0.0.1 --port 4173
pnpm run build
pnpm run test:unit
```

前端使用 Vue 3 / TypeScript / Vite；Node.js / Express 通过 WebSocket 与 RPC 对接 Codex app-server，终端使用 xterm.js / node-pty。开发入口为 `src/`、`scripts/`，测试索引为 [tests.md](tests.md)，公开验收说明见 [docs/RELEASE-0.2.17.md](docs/RELEASE-0.2.17.md)。

发布验证范围与限制见 [0.2.17 发布说明](docs/RELEASE-0.2.17.md)。私人环境的会话、路径、截图及验收原始记录不随仓库分发。

## 常见问题

- **端口占用**：使用其他端口，或确认占用进程后处理；严格模式不会自动递增端口。
- **找不到 Codex / 模型不可用**：检查服务进程的 PATH、Codex CLI、当前账号/供应方和实际模型目录。
- **终端不可用**：检查 `node-pty` 是否安装成功及本机编译工具链；不要将可选依赖安装失败当作完整终端支持。
- **API 代理缺少组件**：执行上面的显式组件安装步骤，确认 `CODEXAPP_API_PROXY_BINARY` 指向可执行文件。
- **其他设备无法访问**：检查主机地址、端口、防火墙与 Web 认证；容器还需端口和项目目录映射。
- **附加目录没有生效**：目录必须在服务环境内存在；要求旧会话重新读取项目说明，或创建新会话。

## 第三方组件声明

API 代理使用 [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) **7.2.152**，固定提交 `c76dfd4e0edabab9000628b1560ab8ab379eadb8`，许可证为 MIT。这是独立上游组件，不是本项目原创。完整来源、版权与分发说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，[原文许可证](resources/api-proxy/LICENSE) 保持不变。再次分发组件时须保留其版权与许可声明；集成不代表上游背书，也不改变模型供应方的服务条款、额度或授权。

## 贡献、反馈与许可证

欢迎提交 [Issue](https://github.com/ERROR403XD/codexapp/issues) 或 Pull Request。请附版本、系统、复现步骤和脱敏日志；不要上传 `auth.json`、token、API key 或私有会话。修改功能时补充相关测试和验收记录，遵循 [AGENTS.md](AGENTS.md)。中文 README 为主文档，涉及用户使用方式的变更请同步英文版。

本项目使用 [MIT License](LICENSE)。感谢上游及更早项目的贡献者，以及 Codex、Vue、Vite、xterm.js 和 CLIProxyAPI 等项目。
