# 完成标记快照与已读确认生命周期

前提：独立状态或完成空闲 gate 后的 59001 候选；准备两个会话。使用合成延迟拦截 `/codex-api/thread-completions`，不读取生产会话。

操作：

1. 完成后台会话回合，打开另一会话；后台行显示未读。打开该会话并保持页面、会话路由可见，已读确认只发送一次。同 token 并发点击不重复确认；失败后再次进入可重试。
2. 挂起完成快照 GET 响应或 JSON body，停止客户端通知生命周期，再释放旧快照。旧未读不恢复，显式标记已读不因旧响应发送 POST。
3. 挂起旧 GET，停止/重启后触发 ready。新 GET 立即启动；新快照等待期间收到 live token 或删除事件，随后释放旧成功/失败。旧完成不释放新请求槽、不清新 delta；当前 GET 后仍以最新 token 确认。
4. 当前 GET 等待期间重复 ready，只有一次读取；完成后另一次 ready 重新对齐，没有暖缓存跳过。刷新后服务端完成标记按原全局 CODEX_HOME 合同恢复；账号变化只重置确认去重，不伪造账号私有完成列表。

预期：快照、实时事件和确认按 token 合并；停止后迟到响应不能提交，新生命周期不等待旧读取。原页面/路由不可见时不自动确认，新完成不被旧 token 确认覆盖。HTTP/网络失败保留未读，后续可重试。

清理/回滚：删除合成延迟规则，恢复页面/路由可见设置。只清理本次临时容器/home，不清空候选标准卷；源码用对应独立提交回退，不修改完成标记持久化格式。

真实 desktop 组合回归：`src/composables/threadCompletionComposition.test.ts`；既有确认回归位于 `useDesktopState.test.ts`。行为修复证据：`docs/baseline/022/completion-lifecycle-20261012/`；完整 `threadCompletionController` 的 19 项直接合同与 AST 迁移证据见 `docs/baseline/022/completion-controller-20261012/`。owner 私有持有快照、delta、确认槽与最多 500 项去重；停止命令入口不发 IO，十次 owner 重启保持迟到隔离。真实浏览器时延与长期堆尚未测量。
