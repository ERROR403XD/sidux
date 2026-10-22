# Sidux 0.2.21

本版本将最后的 0.2.21-dev.3 源码基线提升为 0.2.21 正式版，保留该基线的运行代码与依赖版本，不包含 0.2.22 的开发变更。 / This release promotes the final 0.2.21-dev.3 source baseline to stable 0.2.21, retaining its runtime code and dependency versions. It does not include 0.2.22 development changes.

## 更新 / Changes

- 自动化任务增加外部执行入口，完善命令解析、写入一致性和失败反馈。 / Automations gain an external execution endpoint with improved command resolution, persistence consistency, and failure reporting.
- 配额续接在持久化状态不确定时停止；目标、中断状态及附属元数据读取失败时保留可用结果。 / Quota continuation stops when persistence is uncertain; goal, interruption, and ancillary metadata reads retain usable results on failure.
- 账号激活历史支持分页，并可从持久记录重建过期索引；改进账号资源释放和认证协调。 / Account activation history supports pagination and rebuilds stale indexes from durable records, with improved resource release and authentication coordination.
- 改进自定义连接能力标记、协议桥请求转换和代理连接生命周期处理。 / Custom connection capability labels, protocol-bridge request conversion, and proxy connection lifecycle handling are improved.

## 安装与升级 / Install and upgrade

下载 `codexapp-0.2.21.tgz` 和 `SHA256SUMS`，运行 `sha256sum -c SHA256SUMS`，再按中英文 README 安装。源码安装使用 `v0.2.21` 标签；仓库包含依赖锁文件。 / Download `codexapp-0.2.21.tgz` and `SHA256SUMS`, run `sha256sum -c SHA256SUMS`, then follow the bilingual README. Source installations should use tag `v0.2.21`; the repository includes a dependency lockfile.

本次为 GitHub 发行包。已有服务由使用者按 README 升级，并保留自身运行数据。 / This is a GitHub distribution. Operators should upgrade existing services using the README and preserve their runtime data.

## 验证 / Verification

- Vue 类型检查、前端和 CLI 构建通过。 / Vue type checking, frontend build, and CLI build passed.
- 143 个测试文件通过：1,050 项测试通过，1 项原有测试跳过。 / 143 test files passed: 1,050 tests passed and one existing test was skipped.
- 451 个运行源码、资源与协议桥文件与最后 dev.3 基线逐字节一致。 / 451 runtime source, resource, and protocol-bridge files are byte-identical to the final dev.3 baseline.
- 打包安装后 CLI 帮助、CJS 依赖入口和真实 PTY 执行通过；78 个运行依赖与锁文件一致。 / Packaged CLI help, CommonJS dependency entry points, and a real PTY execution passed; 78 runtime dependency packages matched the lockfile.
- 独立空白状态启动后首页及 capabilities 返回 HTTP 200，运行版本为 0.2.21；验证服务与临时状态已清理。 / An isolated empty-state server returned HTTP 200 for the homepage and capabilities endpoint with runtime version 0.2.21; verification services and temporary state were removed.

## 范围 / Scope

公开源码和发行包不包含个人认证、运行配置、会话、数据库、内部开发计划或本机验证产物。API 代理组件仍按其独立清单准备。 / Public source and packages exclude personal credentials, runtime configuration, conversations, databases, internal plans, and local verification artifacts. The API proxy component is prepared separately using its manifest.

本轮验证范围为 Linux x64、Node.js 24。跨平台和真实供应方验收沿用既有记录，本次不增加新的相关验收声明。 / Verification in this release covers Linux x64 and Node.js 24. Existing cross-platform and live-provider validation records remain the reference; this release makes no new claims for those areas.

发行附件另含 `package-lock.json`，用于在解包安装时以 `npm ci --omit=dev` 重放运行依赖版本。 / A separate `package-lock.json` asset supports replaying runtime dependency versions with `npm ci --omit=dev` after extracting the package.
