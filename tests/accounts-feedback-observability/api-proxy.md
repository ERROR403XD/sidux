# Codex API 出口（0.2.0）

## 前置条件

- 使用隔离 59001 候选及其账号池，不复制生产认证。至少一名已登录的 Codex 账号；双账号用例需要两名测试账号。
- 构建阶段执行 `node scripts/install-api-proxy.cjs output/api-proxy-component`，使用固定校验的 CLIProxyAPI 7.2.152；支持本机 Linux x64。
- 客户端使用独立 CODEX_HOME、临时测试工程和 Codex CLI 0.153.4。测试 key 不写入版本库或报告。

## 操作与预期结果

1. 打开侧栏“自动化”下方“API 出口”，分别检查 1440×900、375×812、768×1024 浅深主题。账号选择使用自定义菜单；卡片、输入框、弹窗无浅色残留或横向溢出。
2. 启用出口并保存；默认跟随 WebUI，也可固定选择另一账号。页面分别显示 WebUI 账号、API 选择及实际使用账号。刷新页面后设置保持。API 固定账号切换不修改 WebUI active；WebUI 切换其他账号不打断固定 API 账号的连接。
3. 创建、重命名、停用/启用 key，检查仅创建时显示完整值。轮换创建新 key，旧 key 24 小时后失效；撤销不可重新启用。已过期/撤销 key 的 HTTP、WS 握手以及原 WS 内新请求均被拒绝。
4. 按页面配置设置 base URL 与 CODEXAPP_API_KEY；独立客户端没有 OpenAI 认证也能工作。HTTP 与 WS 配置分别执行读文件、改代码、`node --test`、根据工具结果继续；测试工程只出现在客户端。
5. 普通 `/v1/models` 与 `?client_version=0.153.4` 目录分别验收；固定组件不支持的 ultra 不得公布，手动请求需明确报错而不降级。`/v1/responses` 非流式与 SSE、基础 `/v1/chat/completions` 可用。无 key 返回 JSON 401；未知 `/v1/*` 返回 JSON 404，不返回网页。
6. `/v1/responses/compact` 使用 Codex 原生 Responses V2 `compaction_trigger`，返回真实 opaque compaction；压缩后引用先前虚构事实。旧上游 compact URL 的 404 不能伪装成成功。HTTP previous_response_id 明确拒绝；WS 续接必须属于本 key 与当前路由，未知上下文报错。
7. 建立长 SSE、执行中的 WS 与空闲 WS，再保存账号或停用服务。正常操作停止新请求，等待已接收响应；超时保留原路由和活动请求。空闲 WS 正常关闭。单独确认强制操作后才中断活动连接。
8. 两把 key 并发，撤销其中一把不影响另一把。达到并发上限返回 429，不排无限队列。客户端断开后上游关闭，活动计数回到 0；无重复计数释放。
9. 同账号 API/WebUI 同时刷新时验证单一受协调的刷新、revision 检查、active 物化更新；固定非 active 账号刷新不能改 active。组件投影不含 refresh token；原版二进制/目录固定，没有浮动 latest 更新。
10. 执行只读 `CODEXAPP_IDLE_CHECK_URL=http://127.0.0.1:59001 node scripts/check-codexapp-idle.cjs`。活动 HTTP/SSE/WS 阻止替换；活动接口故障不能视为空闲。只有核实旧产物不含 API 出口时才允许 legacy 例外。

## 工程验证

- `pnpm run test:unit`、`pnpm run build`；构建后 `node -e "process.argv=['node','codexapp','--help'];require('./dist-cli/index.js')"`。
- `CPA_BINARY=$PWD/output/api-proxy-component/cli-proxy-api node scripts/probe-api-proxy.cjs` 为假账号/假上游探针，不需要真实凭据。
- Provider/Auth Docker 四场景：无认证 Zen、失效认证错误刷新持久化、畸形认证回退、Zen→OpenRouter；保存浅深主题错误界面及重复 live overlay 数量。
- 性能比较直连固定组件与经接入层的并发 1/4/8：延迟、请求次数、内存与取消；首页不为 API 出口增加轮询，页面隐藏/离开后停止刷新。

## 回滚与清理

撤销验收 key，等待活动归零，恢复验收前出口设置。先核对共同空闲，再回退候选镜像；不回滚已合法轮换的账号凭据、用户会话或 key 撤销状态。清理本次临时客户端目录与专用测试容器，保留候选账号卷。5900 不在本次部署范围内。
