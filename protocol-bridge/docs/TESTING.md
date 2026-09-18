# TESTING — 只运行组件自己的测试

测试位于 `protocol-bridge/test/`，不 import 主项目任何模块、不连网、不启动 Codex、不碰数据库。全部通过 `src/index.ts` 公共 API 驱动。

## 运行

```bash
# 方式一：仓库根目录脚本
pnpm run test:bridge

# 方式二：直接指定组件配置
npx vitest run --config protocol-bridge/vitest.config.ts

# 方式三：组件目录内
cd protocol-bridge && npx vitest run

# 类型检查（比主项目更严格：含 noUncheckedIndexedAccess）
npx tsc --noEmit -p protocol-bridge/tsconfig.json
```

主项目的 `pnpm run test:unit` 也会执行本组件测试（根 vitest 配置包含 `protocol-bridge/**`）。

## 测试构成（10 文件 / 70 用例）

| 文件 | 覆盖 |
| --- | --- |
| `unit/sseParser.test.ts` | 帧/CRLF/多行 data/注释/UTF-8 任意字节分片/超限复位 |
| `unit/requestConversion.test.ts` | Codex 形请求、工具回路回放、图片、json_schema、compat、显式报错 |
| `unit/nonStreamConversion.test.ts` | 非流式响应、usage 细分、length→incomplete、空 choices |
| `unit/streamText.test.ts` | 金样本事件序列、**每个字节边界分片等价**、usage 尾随 chunk、空流、非法帧 |
| `unit/streamToolCalls.test.ts` | 参数跨 40 chunk、并行交错、名称分片、id 合成、静默断流失败 |
| `unit/streamReasoning.test.ts` | reasoning+text 顺序、alias 字段、无 reasoning |
| `unit/streamLifecycle.test.ts` | [DONE] 无 finish、静默收尾（宽松/严格）、fail、终态幂等、content parts 数组 |
| `unit/reverseDirection.test.ts` | C→R 请求/响应/流、byte 分片等价、failure 回调 |
| `unit/concurrency.test.ts` | **200 路交错分片流隔离**、20k delta soak、3 工具混合 soak |
| `unit/fixtures.test.ts` | `fixtures/` 金样本（真实 DeepSeek 形态流 + Codex 形态请求） |

## 流式测试方法

测试直接向 translator 喂任意分块的 `Uint8Array`：

```ts
const bytes = Buffer.from(transcript, 'utf8')
for (let offset = 0; offset < bytes.length; offset += chunkSize) {
  translator.translateChunk(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)))
}
translator.finish()
```

对比不同分片方式产生的流时，先用 `normalizeEvents()`（helpers.ts）替换随机生成的 item id。

## 修 bug 的姿势

线上抓到转换错误时：把原始 SSE 样本（脱敏后）存入 `test/fixtures/streams/`，在 `fixtures.test.ts` 加断言复现 → 修复 → 金样本永久防回归。fixture 命名建议 `<provider>-<scenario>.jsonl`（每行一个 chat chunk JSON）或完整 SSE 文本。

## 未包含、在哪里

- 真实 HTTP 回路（宿主 transport glue、取消传播、超时）：主项目 `src/server/protocolBridgeTransport.test.ts`。
- 端到端 Codex 行为：主项目手工测试文档（tests/providers-models/）。
