# Sidux 0.2.20

## 更新 / Changes

- 自定义连接会自动探测可用的推理强度；连接拒绝参数时按实际能力回退，不阻塞普通请求。 / Custom connections now probe supported reasoning-effort levels and fall back according to the connection capability when a parameter is rejected.
- API key 行、模型与推理强度控件在窄屏和较长账号名称下保持可读布局。 / API-key rows plus model and reasoning controls remain readable with narrow layouts and longer account names.
- 附件-only 新会话使用稳定标题；离开页面期间已自动发送的队列行在重连后可恢复并避免重复投递。 / Attachment-only new conversations receive stable titles; queued rows sent while the page was away recover after reconnect without duplicate delivery.
- 延续协议桥、API 代理、多账号运行隔离、严格端口和两阶段发布切换能力。 / The release retains the protocol bridge, API proxy, isolated multi-account runtime, strict-port startup, and two-phase release switching.

## 安装与升级 / Install and upgrade

下载 `codexapp-0.2.20.tgz` 与 `SHA256SUMS`，先运行 `sha256sum -c SHA256SUMS`，再按中英文 README 安装。 / Download `codexapp-0.2.20.tgz` and `SHA256SUMS`, run `sha256sum -c SHA256SUMS`, then follow the bilingual README.

本次为 GitHub 发行包，不是 npm registry 发布；GitHub Release 不会自动切换已有运行服务。升级前结束运行任务并备份数据，保留此前版本和数据备份以便回退。 / This is a GitHub distribution, not an npm registry publication; a GitHub Release does not switch an existing service automatically. Finish running tasks and back up data before upgrading, and retain the previous version and data backups for rollback.

## 验证 / Verification

- Linux x64、Node.js 24、pnpm 11：Vue 类型检查、前端/CLI 生产构建和单元测试通过。
- CLI `--help`、打包安装、`node-pty` 运行时和发布包内容检查通过。
- 0.2.20 的自定义连接推理强度探测、布局、附件-only 标题和队列恢复回归覆盖见 `tests/providers-models/custom-connections-0217.md`、`tests/accounts-feedback-observability/api-proxy.md` 和 `tests/chat-composer-rendering/persisted-idle-queue-recovery.md`。
- 本发布说明不宣称新的真实供应方、跨平台、移动设备或生产切换验收；生产切换仍需独立空闲检查和明确授权。

## 范围 / Scope

公开源码与发行包不包含个人认证、运行配置、会话、日志、数据库、内部开发计划或本机验证产物。API 代理组件保持固定版本并按其清单校验，使用前仍需确认供应方授权边界。
