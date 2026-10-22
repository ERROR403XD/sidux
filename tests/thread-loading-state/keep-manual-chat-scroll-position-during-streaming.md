### Feature: Keep manual chat scroll position during streaming

#### Prerequisites
- App is running from this repository.
- A thread exists with enough history to allow scrolling away from bottom.

#### Steps
1. Open the thread and scroll upward so latest messages are not visible.
2. Send a new message that produces a streaming assistant response.
3. During streaming, do not scroll and observe viewport position.
4. After streaming completes, verify the viewport remains at the same manual position.

#### Expected Results
- Streaming updates do not force auto-scroll to the bottom when user has manually scrolled away.
- User can continue reading older history while the response streams.
- If the thread is already at the bottom when streaming starts, the latest streaming overlay remains visible.

#### Rollback/Cleanup
- Revert the scroll-preservation change in `src/components/content/ThreadConversation.vue` if manual scroll locking needs to be removed.

### dev.8 审核：流式增长、推理空白与原生快照边界

#### 前提与准备

1. 使用本轮独立4173、真实App与临时60回合合成会话，三尺寸1440×1000/768×1024/375×812，浅深主题各一轮。
2. 浏览器事件与在途thread/read状态为桩；原生0.162.1对照已经确认，未完成的助手正文不出现在thread/read中。不得让夹具提前返回累积正文冒充该原生合同。
3. 原生对照仅在既有审核镜像内执行，network=none、无端口映射；完整命令见本轮run-commands.json。

#### 操作

1. 运行`node docs/baseline/022/dev8-review-20261020/conversation-stream-ui.cjs`。
2. 分块推理分别发送尾随空格、纯空格、换行和summaryPartAdded；对照发送单块全文、前导空格分块、单块多行及普通agentMessage。
3. 底部跟随时发送18段助手文字；主动向上滚动后再发送18段。除了位置稳定，必须确认最后一段可见、列表高度实际增长，防止把停止渲染误判为滚动通过。
4. 延迟本地图片响应，在等待期间滚到历史，再放行图片；检查naturalWidth、原scrollTop和可见锚点。
5. A输出中切到B并投递A增量，检查B无串内容；回A继续增量，再发送完整item/completed，检查后台缺口补齐且只有一个消息行。
6. 刷新回真实已保存历史，确认事件桩中尚未写入文件的消息消失、overlay为0；不将其宣称为真实云生成持久性。

#### 预期与已知失败

- 正确合同要求推理分块方式不改变原文；当前R29在两种推理通道均失败，脚本整体exit1应保留。
- 常规滚动必须在实际文本增长下通过，手动阅读与迟到图片不抢位置；切会话不串流，完整结束事件补齐后台未缓存的片段。
- 当前实现只消费选中会话的助手增量，原生在途快照又不提供未完成正文，因此后台期间的文字在完整item结束前可能暂缺；这次记录为已测边界，未单独编号为缺陷。

#### 清理

- 脚本finally只删除自身随机会话文件、刷新fixture列表，核对未发生send/resume或外部请求。
- 原生容器结束后清理自己的CLI、临时home和工作区；4173保留，5900/59001/5173不受影响。
