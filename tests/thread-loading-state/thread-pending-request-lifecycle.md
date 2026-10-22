# 审批与输入请求恢复、回复生命周期

## 功能与准备

在独立开发环境使用合成账号A/B与会话请求，不读取生产认证。打开Network面板，准备延迟pending-request快照或server-request reply响应；账号间可以故意复用数字request ID以验证隔离。

## 操作与预期

1. 页面启动时延迟pending快照，再发送ready通知；并发期间只发一次pending读取，live新增/已解决请求不被旧快照覆盖。
2. 快照等待期间直接切账号，再释放旧快照；旧请求和auth recovery不写入当前账号。账号变更立即清除旧显示，即使没有新的ready事件也主动恢复一份当前快照；同账号停止/重启仍保留请求草稿。
3. 回复A的请求后延迟成功响应，停止/重新启动或切到B，在新上下文收到同ID请求后释放旧成功；当前请求不消失，不发送旧回复的follow-up消息。
4. 对旧失败重复步骤3；错误不回写当前UI。取消UI接收不撤回服务端已接受的回复。
5. 当前上下文正常回复成功时请求消失，正常失败时请求保留并显示错误。
6. 停止旧快照后立即发起新快照，先释放旧响应再触发ready；ready仍加入当前读取，旧finally不清掉新in-flight。
7. 延迟旧回复后停止/重启或切账号，当前上下文收到相同数字ID请求仍能回复；释放旧成功/失败不能清当前busy。当前重复提交只发一次reply，成功后follow-up只发一次；若账号在回复确认与follow-up之间变化，不发送旧follow-up。

自动回归：`pnpm exec vitest run src/composables/useDesktopState.test.ts`，覆盖真实desktop装配。完整UI/账号验收需在最新候选单独执行，单测不等于浏览器验收。

控制器直接组合：`pnpm exec vitest run src/composables/threadPendingRequestController.test.ts`。检查live新增/已解决请求与auth恢复在快照等待期间叠加、六类别名、global请求剪枝保留、approval优先与异步输入非阻塞、同步API抛错后可重试，以及stop保留请求草稿而清auth状态。只读投影由类型检查保证，普通stop不能撤回服务端回复。

App回复装配：`pnpm exec vitest run src/composables/threadPendingReplyComposition.test.ts`，执行从真实App提取的handler与真实pending owner，覆盖同ID重用、旧finally及回复确认到follow-up间的上下文变化；不替代浏览器审批流程。

## 清理与回滚

取消延迟与合成通知，恢复正常连接；保留账号/会话/标准测试卷。回滚生命周期修复会恢复已复现的重复读取和迟到提交，不应作为规避故障的操作。
