# demo — 手工测试台

给协议桥搭的最小前端测试工具：填 Base URL / API key / Model，直接和「桥转换后的 Responses 流」对话。**属于手工测试工具，不属于主应用，也不随包发布。**

## 启动

```bash
# 仓库根目录
pnpm run bridge:demo          # 打包 demo server 并启动，地址 http://127.0.0.1:4399
```

没有真实供应商时，先起一个内置 mock 上游（另开终端）：

```bash
node protocol-bridge/demo/mock-upstream.mjs    # http://127.0.0.1:4398/v1
```

## 使用

1. 打开 <http://127.0.0.1:4399>。
2. 填写：
   - **Base URL**：OpenAI 兼容地址（含 `/v1`），例如 `https://api.deepseek.com/v1`，或 mock 的 `http://127.0.0.1:4398/v1`
   - **API key**、**Model**
   - 三项会保存在浏览器 localStorage（仅本机便利性存储，服务器不落盘）。
3. 发送消息。页面按桥的实时输出渲染：灰色「推理」块（reasoning）、正文流式文本、🔧 工具调用块（演示页不执行工具，仅显示桥重建出的 name/arguments）、completed 事件里的 usage。
4. 展开「事件日志」可看到桥发出的原始 SSE 事件类型，以及上游实际收到的转换后 Chat 请求（`bridge.debug.chat_request`）。

## 数据流

```
浏览器 (Responses SSE 渲染)
   ↑ POST /api/chat，服务器把回复按桥的原样帧转发
demo/server.ts ── responsesRequestToChatRequest() ──▶ POST <baseUrl>/chat/completions
   └─ ChatToResponsesStreamTranslator（含 mock 之外的 JSON 上游 → 合成流）
```

文件：`server.ts`（服务器，tsup 打包后运行）、`index.html`（单文件页面）、`mock-upstream.mjs`（假上游）。页面键入的 key 只在请求期间经过本机服务器内存，不写日志。
