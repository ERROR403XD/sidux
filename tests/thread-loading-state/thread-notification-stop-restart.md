# 会话通知停止与重新启动

## 功能与准备

验证事件同步在停止后隔离旧timer、通知回调和在途列表读取。使用开发验证环境与合成会话，打开Network面板；不要使用生产入口或真实认证做故障注入。

## 操作

1. 让turn/completed触发列表读取，并延迟响应。
2. 在等待期间停止轮询，释放旧列表响应。
3. 验证不再跟进history/resume请求，旧错误/消息不出现。
4. 重新启动后触发新事件，分别释放旧timer与旧通知回调，再释放新响应。
5. 对账号切换重复在途同步操作，验证旧finally不能清新同步的busy标记。

## 预期

- 停止后不注册新timer，被保留的旧callback不再执行业务或取消新timer。
- 退订后的旧通知不能写live消息；新订阅仍正常接收。
- 旧列表完成不继续请求history，旧同步finally不重排工作或清新busy状态。
- start/stop只是隔离UI接收，不撤回服务端已接受的发送intent。

## 实时通知控制器合同

准备两条合成会话A/B，在A观察实时回复、命令、文件变更和计划。运行 `pnpm exec vitest run src/composables/threadRealtimeController.test.ts src/composables/useDesktopState.test.ts` 检查真实history、turn-order、active-turn与实时owner组合；API使用合成边界。

1. 在A发送请求并观察推理→回复；回复开始后推理不残留，逐字增量只显示一条回复。
2. 切到B后让A继续运行；A的运行状态和计划继续更新，A的回复增量不写进B。
3. 返回A加载历史；完成的命令和文件变更只保留持久记录，无重复live行，回合顺序不跳变。
4. 注入旧回合完成及已结束回合的started重放；当前新回合仍运行，旧事件不清新active-turn或复写摘要。
5. 注入willRetry错误再恢复、最终failed错误；重试错误在恢复事件后清除，最终错误保留并可在刷新后看到。
6. 停止后注入旧回复增量再重启；旧增量不出现，新回合仍可开始。对后台计划重复剪枝检查，活动会话的实时消息继续保留。

预期保持上述通知顺序、早返回、历史合并和错误展示合同；构建期间没有新增网络请求/订阅。十次controller stop/start单测不等于十次真实组件挂载验收。清理时撤销合成事件注入、恢复正常网络，保留标准测试数据；回滚结构迁移需同时恢复父层装配与live getters的类型签名。

## 订阅与重连 owner 合同

准备隔离开发环境与合成账号/会话，运行 `pnpm exec vitest run src/composables/threadSubscriptionController.test.ts src/composables/threadSubscriptionComposition.test.ts`。浏览器监听 WebSocket 与 Network；不从生产导入状态。

1. 连续调用两次 start，首次 ready 在 pending 恢复尚未返回时到达；只创建一个通知流，pending 读取合并为一次，completion/queue 对齐各一次。首次 ready 不额外重置模型/额度目录。
2. 等读取结束后再次 ready；重新对齐完成标记、队列和 bridge，并在模型/额度读取前失效缓存。初始连接不计重连，重连通知仍保留。
3. 切换合成账号；CODEX_HOME 全局流保持原订阅，当前通知仍更新状态，账号相关读取按各 owner 的 revision 隔离。
4. 在停止清理及重启后注入旧 ready、completion、queue 和普通回合通知；旧回调不读取、不写状态、不释放新资源。新订阅的第一个 ready 仍按初始连接处理。
5. 十轮 start/stop 中每轮只订阅一次、退订一次；普通事件先提交 realtime，再进入合并同步，completion/queue 专用事件不进入普通分流。

预期物理 transport、WS/SSE reconnect timer 和退避仍归原 `codexRpcClient`；新 owner 只拥有唯一订阅与业务分流。十轮 owner 合同不替代真实组件反复挂载或长期内存验证。

## 清理与回滚

关闭故障注入，恢复开发环境的正常网络及轮询。保留用户会话与标准测试卷，不读取或导入生产状态。回滚本修复会恢复已记录的迟到完成缺口。
