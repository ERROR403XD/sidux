---
title: codexapp 协议桥组件与 Chat-only 自定义连接启用 Codex
created: 2026-09-18
tags: [开发, CodexApp, protocol-bridge, 自定义连接]
status: 已实施，待真机验收
---

# codexapp 协议桥组件与 Chat-only 自定义连接启用 Codex

## 背景与目标

自定义连接中存在只支持 Chat Completions 协议的供应商。此前这类连接仅能作为 API key 出口（apiProxy 的 chat 直通），`select()`/`customRuntimeConfig()`/运行时路由均显式拒绝其作为 Codex 出口（「Codex 需要 Responses API」）。本任务交付一个**独立、可长期运行、高并发的 Responses ↔ Chat Completions 协议转换组件**，打通该场景，同时保证：

- 原生 Responses 路径完全不经过转换层；
- 协议复杂性不扩散到主项目；
- 组件可独立开发、独立测试、独立维护、可整体移除。

## 交付内容

### 独立组件 `protocol-bridge/`（零依赖，仅 Node 内置模块）

- `src/index.ts` 公共 API；`types.ts` 归一化 IR（NormalizedStreamEvent 8 种事件）；`errors.ts` 错误层级。
- `sse/parser.ts` 字节级增量 SSE 解析器：跨 chunk 事件重组、CRLF、多行 data、UTF-8 多字节跨 chunk、8 MiB 帧上限。
- `chat/streamDecoder.ts` + `responses/streamEncoder.ts`：Chat SSE → Responses SSE 状态机（主方向）。关键设计：item 关闭即时、`response.completed` 延迟到流结束以吸收尾随 usage chunk；`finish_reason=length → status:incomplete`；静默断流默认宽松收尾、存在未闭合工具调用时按 `response.failed`。
- `responses/requestEncoder.ts` / `responseDecoder.ts` / `streamDecoder.ts` + `chat/streamEncoder.ts`：反方向（C→R）完整实现。
- 非流式转换与请求解码：显式报错（previous_response_id、background、computer_use 等）优于静默丢字段；可降级字段进入 `warnings`。
- `compatibility/`：`reasoningFields` 等供应商差异选项（默认覆盖 DeepSeek/OpenRouter 形态）。
- 测试 70 用例（`pnpm run test:bridge`）：含**每个字节边界分片等价**、200 路并发交错隔离、20k delta soak、真实形态 fixture 金样本。
- 文档 9 份：README、ARCHITECTURE、PROTOCOL_MAPPING、STREAMING、COMPATIBILITY、SUPPORTED_FEATURES、UNSUPPORTED_FEATURES、TESTING、INTEGRATION。

### 主项目集成（最小侵入）

- 新增 `src/server/protocolBridgeTransport.ts`（唯一业务集成 glue）：fetch 转发、SSE 回写、背压（write 返回 false → pause 上游）、总超时 30 分钟/空闲 5 分钟、客户端断开 abort 上游、usage 接入 `extractUsage`、`[protocol-bridge]` 日志命名空间（不含 prompt/参数）。
- 门控改动：`customConnectionStore.ts`（select/restore/save/customRuntimeConfig 不再拒绝 chat 连接）、`codexAppServerBridge.ts`（runtime 路由接受 chat 连接分发到 glue；自动化准入放开）、`customConnectionProxy.ts`（chat 连接 `/v1/responses` 走 glue）、`customConnections.ts`（chat 连接端点表补 `/v1/responses`）。
- UI：`CustomConnections.vue` 切换按钮放开；`App.vue` 执行账号列表包含 chat 连接。
- `ProxySpec.md` 追加 addendum；手工用例 `tests/providers-models/custom-connections-0217.md` 追加 0.2.20-dev 章节。

## 验证记录（本机环境）

- `npx tsc --noEmit -p protocol-bridge/tsconfig.json` 通过（含 noUncheckedIndexedAccess）。
- `npx vitest run --config protocol-bridge/vitest.config.ts`：10 文件 70 用例全绿。
- `pnpm run test:unit`（全量 927）：880 通过；47 失败全部为预先存在的环境性失败（无 codex CLI 的 spawn 型测试 27、无 bash 的脚本测试 4、POSIX 权限位断言 3、`index.html` 与测试正则不匹配 10、陈旧测试调用已改名导出 4 —— 含 apiProxy.test 与 customConnectionStore 的一条 0600 权限断言）。
- `npx vue-tsc --noEmit`：仅剩预先存在的 `src/api/apiProxy.test.ts` 陈旧导出错误。
- `npx tsup`：CLI 打包成功（桥被一并打包）。
- 回归证据：旧链路 `unifiedResponsesProxy.test.ts` 全绿；apiProxy 网关测试更新后全绿（`/v1/responses` 经桥成功、`/v1/responses/compact` 仍 unsupported）。
- 未验证（环境限制）：真实 Codex CLI 端到端、真实供应商、Docker 打包矩阵（本机无 docker/bash/codex CLI）——待真机按手工用例验收。

## 移除路径

见 `protocol-bridge/docs/INTEGRATION.md`：删组件目录 + glue 文件 + 6 处门控回退，核心链路零改动。
