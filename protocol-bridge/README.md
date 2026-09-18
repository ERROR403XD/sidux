# protocol-bridge

独立的 OpenAI **Responses API ↔ Chat Completions API** 协议转换组件。

它只解决一个问题：调用方（典型是 Codex CLI）说 Responses 协议，而某些自定义连接（Custom Connection）的上游只支持 Chat Completions 协议。组件在两者之间做**双向、流式、有状态**的协议翻译：

```
Responses request ──▶ Chat request ──▶ 上游模型
Responses SSE    ◀── Chat SSE     ◀── 上游模型
```

## 它是什么、不是什么

| 是 | 不是 |
| --- | --- |
| 纯协议转换库（`src/` 全部为纯函数/请求局部对象，零 I/O） | HTTP 客户端 / 服务器（transport 由宿主应用提供） |
| 增量流式转换器（SSE 解析 → 归一化 IR → 目标协议事件） | 路由决策者（是否启用转换由宿主的 connection capability 决定） |
| 可独立复制部署、独立测试的组件 | 主项目核心链路的一部分（原生 Responses 连接完全不经过它） |

## 快速使用

```ts
import {
  responsesRequestToChatRequest,      // Responses 请求 → Chat 请求
  chatResponseToResponses,            // Chat 非流式响应 → Responses 响应对象
  ChatToResponsesStreamTranslator,    // Chat SSE 字节流 → Responses SSE 事件
  encodeSseFrame,
} from './src/index.js'

// 1. 请求方向
const { request: chatRequest, warnings } = responsesRequestToChatRequest(responsesPayload)
// warnings 列出被丢弃/降级的字段，永不静默丢失

// 2. 流式方向：每个请求一个实例
const translator = new ChatToResponsesStreamTranslator({
  model: chatRequest.model,
  onEvent: event => writeToClient(encodeSseFrame(event)),
})
upstreamStream.on('data', chunk => translator.translateChunk(chunk))   // 任意字节边界
upstreamStream.on('end', () => { translator.finish(); writeToClient('data: [DONE]-free end') })
upstreamStream.on('error', error => translator.fail(error))            // → response.failed
```

想直接动手试？仓库根目录运行 `pnpm run bridge:demo`，打开 <http://127.0.0.1:4399>，填 Base URL / API key / Model 即可对话（见 [demo/README.md](demo/README.md)）。

反方向（Chat 调用方 → Responses 上游）同样完整提供：`chatRequestToResponsesRequest`、`responsesResponseToChatResponse`、`ResponsesToChatStreamTranslator`。

## 目录

```
protocol-bridge/
├── src/
│   ├── index.ts            公共 API（唯一出口，宿主只 import 这个文件）
│   ├── types.ts            归一化 IR 与兼容性选项
│   ├── errors.ts           错误层级（unsupported/parse/conversion/interrupted）
│   ├── id.ts               item/response id 生成
│   ├── sse/parser.ts       字节级增量 SSE 解析器
│   ├── sse/writer.ts       SSE 帧序列化
│   ├── chat/               Chat 侧：请求解码、流解码、流编码
│   ├── responses/          Responses 侧：流编码、流解码、请求编码、响应解码
│   └── compatibility/      供应商字段差异（reasoning 字段名等）
├── test/                   组件自己的测试（不需要主项目即可运行）
│   ├── unit/               70+ 用例：请求/流式/分片/工具/并发/fixture 金样本
│   └── fixtures/           真实协议形态样本
├── docs/                   架构、协议映射、流式状态机、兼容性、集成说明
└── vitest.config.ts        独立测试入口
```

## 文档

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 模块、IR、状态机、依赖边界
- [docs/PROTOCOL_MAPPING.md](docs/PROTOCOL_MAPPING.md) — 字段级映射表
- [docs/STREAMING.md](docs/STREAMING.md) — 流式事件转换与状态机、SSE 边界情况
- [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) — 供应商差异与 compat 选项
- [docs/SUPPORTED_FEATURES.md](docs/SUPPORTED_FEATURES.md) — 支持矩阵
- [docs/UNSUPPORTED_FEATURES.md](docs/UNSUPPORTED_FEATURES.md) — 明确不支持的能力与原因
- [docs/TESTING.md](docs/TESTING.md) — 如何只运行组件测试
- [docs/INTEGRATION.md](docs/INTEGRATION.md) — 主项目在哪里调用它、如何移除

## 设计承诺

1. **零依赖**：只依赖 Node 内置模块；不 import 主项目任何代码。
2. **请求局部状态**：所有流式状态在每请求的 translator 实例内，无全局量、无共享 buffer。
3. **显式降级**：无法无损映射的能力要么报 `UnsupportedFeatureError`，要么记入 `warnings` 返回给调用方。
4. **协议正确性优先**：事件序列、索引、usage、finish reason 按目标协议的规范形状输出，可被 Codex CLI 等标准客户端直接消费。
