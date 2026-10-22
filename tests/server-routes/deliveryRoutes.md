2026-10-09 003 03E Delivery queue route contract

Feature/change name:
- 03E delivery queue HTTP route migration

Prerequisites/setup:
- Start the packaged app against an isolated test workspace and CODEX_HOME.
- Confirm one thread is idle and the queue service is ready.

Actions:
1. Open the thread and send one normal message.
2. Add one queued message while the thread is busy.
3. Move or remove the queued message, then reload the page.
4. Inspect the delivery context/status requests and queue mutations in browser DevTools.

Expected results:
- `GET /codex-api/delivery-context` returns 200 with a context ID.
- `GET /codex-api/delivery-status` returns 200 for valid thread/message IDs.
- `POST /codex-api/delivery` returns 200 for a valid protocol-2 payload and 409 with a readable error for stale/invalid payloads.
- `POST /codex-api/thread-queue-state` preserves queue add/move/remove/edit behavior and errors with 409.
- `PUT /codex-api/thread-queue-state` remains the documented 409 compatibility response.
- Queue state remains correct after reload and the message can still be delivered when the thread becomes idle.

Rollback/cleanup:
- Revert the delivery route migration commit and restart the isolated test app.
- No queue or persisted data cleanup is required by this route-only change.
### 0.2.22 R4：全新 home 的队列初始化

前提：独立临时 CODEX_HOME，未预置 `.codex-global-state.json`，使用合成运行时。

操作：启动服务，读取队列；停止后重启再读。在另外两个临时 home 中分别放坏 JSON、把全局状态路径建成目录，再启动并读取队列。

预期：完全空 home 返回空队列并能继续操作；坏 JSON 和真实 I/O 错误明确失败，原状态不被覆盖。不得以预置 `{}` 作为空 home 验证。

清理：停止本轮独立服务并移除其临时 home；不清空 59001 标准卷。
### 0.2.22 R7：实时状态读取失败不派发

前提：隔离测试运行时，一条已排队消息及旧 idle 快照。

操作：使 `thread/read` 返回传输或认证错误，触发队列处理；恢复实时读取后再次处理。另检查新会话 empty rollout 的兼容回退。

预期：普通读取失败不执行 `turn/start`，消息保持 queued；恢复后只派发一次。只有明确 empty rollout 错误允许使用兼容快照。

清理：恢复故障注入，取消剩余测试消息并停止测试运行时。
