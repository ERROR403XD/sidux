# 供应方代理入口合同

前提：隔离 `CODEX_HOME`，随机 localhost 端口与合成连接/凭据；运行 `pnpm exec vitest run src/server/routes/providerProxyRoutes.test.ts src/server/unifiedResponsesProxy.test.ts src/server/unifiedResponsesProxy.lifecycle.test.ts src/server/protocolBridgeTransport.test.ts src/server/customConnectionPayload.test.ts`。不读取生产认证。

1. 用合法连接 id/revision/runtime token 请求 Responses 代理；检查只调用一次 `/responses`，使用保存的上游 key，并按同一个 sanitizer 处理模型与不支持参数。
2. 分别使用远端地址、缺失连接、旧 revision、错误 token 和非法 JSON；预期先返回 409，零上游调用。Chat 连接未启用转换时同样返回 409。
3. 启用 Chat 协议转换，发送包含 namespace tool 的请求；检查仅一次 `/chat/completions`，返回 Responses 结果；429 原状态和内容保留。
4. 流式返回期间断开客户端；检查上游连接关闭，下一次请求正常完成。
5. 验证 Zen 的原 loopback 限制、OpenRouter/custom 的原地址合同、旧配置 key/wire/baseUrl、无认证和损坏配置回退；方法或路径不匹配时交还下一 handler。
6. 旧 Chat 兼容代理的响应身份：用自有回环上游分别返回带 id 的普通文本流、无 id 文本流，以及带工具声明时的普通 JSON 回复；请求端均使用 `stream:true`。每次预期只有一次上游调用、一次创建和一次完成，正文完整且创建/完成的 `response.id` 相同。dev.8 审核脚本 `node docs/baseline/022/dev8-review-20261020/unified-stream-identity-local.cjs` 的首项身份检查失败（R72/P3），两个对照通过；脚本自动关闭两个自有监听，无状态回滚。此处没有原生客户端或云端失败证据。
7. 普通 Responses 消息：启用 Chat 协议转换，分别发送 `input:[{role:'user',content:'hello'}]` 与增加 `type:'message'` 的同一请求。两者预期都完成一次上游调用，正文保留且输入对象不变；dev.8 前者返回400、零上游调用（R73/P2），后者正常。
8. 反向 JSON 回退：同一 Responses 上游正常返回 JSON，Chat 客户端分别请求 `stream:true/false`。前者预期是 Chat SSE 的正文、终态和 `[DONE]`，后者预期普通 JSON；上游各调用一次、usage只回传一次。dev.8 前者仍是 JSON（R74/P2），后者正常。条目7/8的最小内存验证命令为 `node docs/baseline/022/dev8-review-20261020/bridge-ordinary-contracts-offline.cjs`；自动清理内存监听和定时器，无网络/真实凭据/状态回滚，完整安装包行为未由此证明。

自动验证使用真实 HTTP、CustomConnectionStore 和本地传输；Zen/OpenRouter 外部调用为可控函数。真实云端成功须另用用户测试账号轻量验收，打包认证矩阵不能替代它。

清理：单测自动关闭自身服务并删除合成目录。回滚只 revert 代理入口迁移提交，无持久化 schema 变化。
