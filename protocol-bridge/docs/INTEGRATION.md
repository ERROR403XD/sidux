# INTEGRATION — 主项目如何接入、如何移除

主项目（codexapp）只在**一个文件**里持有本组件的业务集成：`src/server/protocolBridgeTransport.ts`（transport glue）。其余改动只是“门控开关”——决定一个请求要不要交给 glue。

## 数据流（主方向）

```
Codex CLI (wire_api="responses")
   │  POST http://127.0.0.1:<port>/codex-api/custom-connections/runtime/<id>/<rev>/v1/responses
   ▼
codexAppServerBridge 路由（校验 loopback + runtimeToken + revision）
   │  connection.wireApi === 'responses' → 旧 unifiedResponsesProxy（不变）
   │  connection.wireApi === 'chat'      → protocolBridgeTransport  ◀── 唯一新增链路
   ▼
protocolBridgeTransport（glue，~250 行）
   │  responsesRequestToChatRequest()      ← 组件 API
   │  POST <baseUrl>/chat/completions      ← fetch（复用 Node 全局连接池）
   │  ChatToResponsesStreamTranslator      ← 组件 API，逐 chunk 翻译
   │  backpressure / idle+total 超时 / 客户端断开 abort / usage 回调
   ▼
自定义连接上游（仅支持 Chat Completions）
```

反方向（`handleChatViaProtocolBridge` + `ResponsesToChatStreamTranslator`）已接入：Responses 原生连接开启桥后，API 出口的 `/v1/chat/completions` 由桥转换服务；黄牌 tag 在 API 代理面板与连接卡片同步显示。

## 主项目触碰点清单

| 文件 | 改动 | 性质 |
| --- | --- | --- |
| `src/server/protocolBridgeTransport.ts` | 新增 glue：HTTP 传输 + 组件调用 + 错误映射 + 日志（`[protocol-bridge]` 命名空间） | 唯一业务集成 |
| `src/server/customConnectionProxy.ts` | `forwardCustomConnection` 的 `/v1/responses` 分支：chat 连接改走 glue | 门控（2 行级） |
| `src/server/codexAppServerBridge.ts` | runtime 路由接受 chat 连接并分发到 glue；自动化准入不再拒绝 chat 连接 | 门控 |
| `src/server/customConnectionStore.ts` | `select()`/`customRuntimeConfig()`/restore/save 不再拒绝 chat 连接（Codex 对本地路由恒为 `wire_api="responses"`） | capability 门控 |
| `src/customConnections.ts` | `customConnectionEndpoints` 为 chat 连接补上 `/v1/responses`（由桥服务） | capability 表达 |
| `src/components/accounts/CustomConnections.vue` + `src/App.vue` | chat 连接可被选为执行账号 | UI 开关 |

## capability 表达

连接上的 `wireApi: 'responses' | 'chat'`、探测得到的 `supportedEndpoints` 与 **`protocolBridge` 开关**共同构成 capability 描述：

```text
wireApi === 'responses'（未开桥）  →  responses: true                → 原生链路（绝不经过桥）
wireApi === 'chat'     + 桥开     →  responses 经桥成立（黄色标记）   → Responses 请求走桥转 chat
wireApi === 'responses' + 桥开    →  chat 经桥成立（黄色标记）        → Chat 请求走桥转 Responses（反方向）
wireApi === 'chat'     + 桥关     →  仅 Chat 出口；不可选为 Codex 账号
```

开关在「自定义连接 → 账号卡片 → 账号设置」中开启（AppSwitch，仅对缺少 chat/responses 端点的连接显示）。`protocolBridge` 不参与测试 digest：单独切换可免重测保存；关闭活跃连接的桥会自动取消其激活状态。不通过供应商名称、URL 或模型名猜测是否转换。

## 可观测性

- glue 每请求输出 `[protocol-bridge]` 前缀日志：模型、上游状态码、字节数、事件数、时长；**不含** prompt / tool arguments / API key。
- usage 通过既有 `extractUsage` + `onUsage` 回调进入主项目 `ProxyUsageStore`，不新建 telemetry 体系。

## 生命周期与并发

- 状态全部 request-local（translator 实例）；共享资源只有 Node 全局 fetch 连接池（keep-alive，无每请求 TLS 握手）。
- 背压：`res.write()` 返回 false 时 pause 上游流，drain 后 resume。
- 超时：总时长默认 30 分钟（与旧代理一致）、空闲 chunk 默认 5 分钟；触发即 abort 上游并 `translator.fail()`。
- 客户端断开：`res close` → `AbortController.abort()` 上游，translator 丢弃。
- 异常边界：glue 顶层 try/catch；组件错误映射为 HTTP 400（未发头）或 `response.failed`（已发头）；组件 panic 不可能拖垮主进程（纯同步函数 + 终态幂等）。

## 移除/替换组件的步骤

1. 删除 `protocol-bridge/` 目录。
2. 删除 `src/server/protocolBridgeTransport.ts`。
3. `customConnectionProxy.ts` / `codexAppServerBridge.ts` 中对 chat 连接的 `/v1/responses` 分发改回 404/409（或直接删掉分支）。
4. `customConnectionStore.ts` 恢复对 chat 连接的 select/runtime 拒绝（或保留仅作为 API key 出口）。
5. UI 恢复 chat 连接的“切换”禁用。
6. 删除 `vitest.config.ts` 根配置中的 bridge include、`package.json` 的 `test:bridge` 脚本。

共 6 处、全部是门控/调用点，核心转发链路（native Responses、native chat passthrough、zen/openrouter 代理）零改动。

## 性能审计基线（对照 AGENTS.md 要求）

- 请求路径仅新增：1 次 JSON.parse（请求体，原本就有）、1 次请求转换（纯函数，O(input)）、每 delta 1 次 JSON.parse + 1 次 JSON.stringify + 若干小对象（与旧流式路径的每行 parse 持平）。
- 无重复上游请求、无阻塞调用、无无界 fanout；payload 大小与旧实现同量级（+`stream_options`）。
- 已测：组件级 20k delta soak <0.1s；200 并发交错流隔离正确。未实测（本环境无真实上游）：端到端首 token 延迟对比——预期与旧流式路径相当（同为逐 chunk 管道），超长响应内存由“协议必须回传完整文本”决定（见 ARCHITECTURE.md 内存注记）。
